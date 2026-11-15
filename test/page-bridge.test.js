'use strict';
// The page side of the shell: the shim's markers, the page actions and the
// webmail route helpers. Everything here handles page-controlled input.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKS, PAGE_SHIM_JS, parseMarker, normaliseState, STATE_KEYS } = require('../src/page-shim');
const { actionScript, TOOLS, REPLIES, FOLDERS } = require('../src/page-actions');
const { encodeSeg, folderView, conversationHash, parseMailTag, conversationRouteFromUrl, shouldReloadAfterFailedNavigation } = require('../src/route');

const ORIGIN = 'https://mail.govconnect.ke';

test('the shim is valid script and carries every marker', () => {
  assert.doesNotThrow(() => new Function(PAGE_SHIM_JS));
  for (const m of Object.values(MARKS)) assert.ok(PAGE_SHIM_JS.includes(JSON.stringify(m).slice(1, -1)) || PAGE_SHIM_JS.includes(m));
});

test('markers parse, and anything else is ignored', () => {
  assert.deepEqual(parseMarker(MARKS.focus), { type: 'focus' });
  assert.deepEqual(parseMarker(`${MARKS.notify}attempted:granted`), { type: 'notify', kind: 'attempted', permission: 'granted' });
  assert.deepEqual(parseMarker(`${MARKS.post}{"title":"A","tag":"mail-INBOX-1"}`), { type: 'post', data: { title: 'A', tag: 'mail-INBOX-1' } });
  assert.deepEqual(parseMarker(`${MARKS.state}{"conversation":true}`).type, 'state');
  assert.deepEqual(parseMarker(`${MARKS.drop}{"outcome":"failed"}`), { type: 'drop', data: { outcome: 'failed' } });
  for (const bad of [null, 42, 'hello', `${MARKS.post}not json`, `${MARKS.post}[1,2]`, `${MARKS.state}null`, `\u0001taifa-unknown:{}`, MARKS.post + 'x'.repeat(20000)]) {
    assert.equal(parseMarker(bad), null, String(bad).slice(0, 40));
  }
});

test('page state is reduced to booleans and a short path', () => {
  const s = normaliseState({ conversation: 'yes', typing: 1, path: '/x'.repeat(300), evil: '<script>', online: true });
  assert.equal(s.conversation, true);
  assert.equal(s.typing, true);
  assert.equal(s.evil, undefined);
  assert.ok(s.path.length <= 200);
  for (const k of STATE_KEYS) assert.equal(typeof s[k], 'boolean', k);
  assert.equal(normaliseState({}).online, true, 'unknown online state is not reported as offline');
  assert.equal(normaliseState({ online: false }).online, false);
});

test('every page action compiles, and bad actions or arguments are refused', () => {
  for (const t of TOOLS) assert.doesNotThrow(() => new Function(actionScript('tool', t)));
  for (const r of REPLIES) assert.doesNotThrow(() => new Function(actionScript('reply', r)));
  for (const f of FOLDERS) assert.doesNotThrow(() => new Function(actionScript('folder', { name: f })));
  for (const a of ['refresh', 'search', 'sidebar', 'conversation', 'print', 'compose']) assert.doesNotThrow(() => new Function(actionScript(a)));
  assert.doesNotThrow(() => actionScript('navigate', '/#INBOX?compose=new&to=a%40b.ke'));
  assert.doesNotThrow(() => actionScript('navigate', '/settings'));
  assert.throws(() => actionScript('eval', 'x'));
  assert.throws(() => actionScript('tool', 'Delete forever'));
  assert.throws(() => actionScript('reply', 'Reply to attacker'));
  assert.throws(() => actionScript('folder', { name: 'Projects' }));
  assert.throws(() => actionScript('folder', { name: 'Sent', hash: '#Sent?x=1' }));
  assert.throws(() => actionScript('navigate', 'https://evil.example/'));
  assert.throws(() => actionScript('navigate', 'javascript:alert(1)'));
  assert.throws(() => actionScript('shortcuts', 'x'));
});

test('arguments reach the page as JSON, never as code', () => {
  const s = actionScript('navigate', '/#INBOX?subject=");alert(1);("');
  assert.ok(s.endsWith(`("navigate", ${JSON.stringify('/#INBOX?subject=");alert(1);("')})`));
  assert.doesNotThrow(() => new Function(s));
});

test('folder segments are encoded the way the webmail encodes them', () => {
  assert.equal(encodeSeg('INBOX'), 'INBOX');
  assert.equal(encodeSeg('Projects/Budget 2027'), 'Projects%2FBudget+2027');
  assert.equal(encodeSeg('C++ Migration'), 'C%2B%2B+Migration');
  assert.equal(folderView('search'), 'folder/search');
  assert.equal(conversationHash('Archive/2026', 12), '#Archive%2F2026/12');
  assert.equal(conversationHash('INBOX', 0), null);
  assert.equal(conversationHash('INBOX', '1e3'), '#INBOX/1000');
  assert.equal(conversationHash('', 3), null);
  assert.equal(conversationHash('INBOX', 'x'), null);
});

test('notification tags map to the exact conversation', () => {
  assert.deepEqual(parseMailTag('mail-INBOX-139'), { folder: 'INBOX', uid: 139, hash: '#INBOX/139' });
  assert.deepEqual(parseMailTag('mail-Projects/Budget-2027-5'), { folder: 'Projects/Budget-2027', uid: 5, hash: '#Projects%2FBudget-2027/5' });
  for (const t of ['', 'mail-INBOX', 'note-INBOX-1', 'mail--1', null, 'mail-INBOX-1x']) assert.equal(parseMailTag(t), null, String(t));
});

test('only the webmail origin conversation routes open in an app window', () => {
  assert.equal(conversationRouteFromUrl(`${ORIGIN}/#INBOX/139?mid=%3Ca%40b%3E`, ORIGIN), '/#INBOX/139?mid=%3Ca%40b%3E');
  assert.equal(conversationRouteFromUrl(`${ORIGIN}/#folder/search/4`, ORIGIN), '/#folder/search/4');
  for (const u of [
    'https://evil.example/#INBOX/1',
    `${ORIGIN}/#INBOX?compose=new&to=x%40y`,
    `${ORIGIN}/#INBOX/1?compose=new`,
    `${ORIGIN}/settings#INBOX/1`,
    `${ORIGIN}/#search/q/1?folder=INBOX`,
    `${ORIGIN}/#INBOX`,
    'not a url',
  ]) {
    assert.equal(conversationRouteFromUrl(u, ORIGIN), null, u);
  }
});

test('a failed in-page navigation reloads only when off the webmail', () => {
  assert.equal(shouldReloadAfterFailedNavigation(`${ORIGIN}/#INBOX`, ORIGIN), false);
  assert.equal(shouldReloadAfterFailedNavigation('taifa-ui://app/shell/offline.html', ORIGIN), true);
  assert.equal(shouldReloadAfterFailedNavigation('', ORIGIN), true);
});
