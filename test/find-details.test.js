'use strict';
// Round 3 critic #11: after Escape, Cmd+G restarted at "1 of 4" instead of
// continuing; Escape left the focus on the list row, not in the message; and
// selected text had no "Search Mail for …".
const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeTarget, FOCUS_MESSAGE } = require('../src/find');
const { buildContextMenuTemplate } = require('../src/context-menu');
const { actionScript } = require('../src/page-actions');

test('Cmd+G after closing the bar steps to the match after the one last shown', () => {
  assert.equal(resumeTarget(1, 4, true), 2);
  assert.equal(resumeTarget(3, 4, true), 4);
  assert.equal(resumeTarget(4, 4, true), 1, 'wraps');
  assert.equal(resumeTarget(1, 4, false), 4, 'Shift+Cmd+G wraps back');
  assert.equal(resumeTarget(3, 4, false), 2);
  assert.equal(resumeTarget(0, 4, true), 1, 'another conversation starts at the first');
  assert.equal(resumeTarget(6, 4, true), 3, 'fewer matches now: still a real ordinal');
  assert.equal(resumeTarget(2, 0, true), 0);
});

test('Escape focuses the open message’s scrolling part', () => {
  assert.doesNotThrow(() => new Function(FOCUS_MESSAGE));
  assert.ok(FOCUS_MESSAGE.includes('.tm-reader[data-open="1"]'));
  assert.ok(FOCUS_MESSAGE.includes("setAttribute('tabindex', '-1')"));
  assert.ok(FOCUS_MESSAGE.includes('preventScroll: true'));
});

const labels = (t) => t.filter((i) => i.label).map((i) => i.label);
const params = (o) => ({ selectionText: '', isEditable: false, editFlags: { canCopy: true }, ...o });

test('selected message text offers Search Mail for it', () => {
  const calls = [];
  const t = buildContextMenuTemplate(params({ selectionText: '  REF-2026-0471\n' }), { platform: 'darwin', canSearch: true, message: { canReplyAll: true } }, (id, arg) => calls.push([id, arg]));
  const item = t.find((i) => i.label && i.label.startsWith('Search Mail for'));
  assert.equal(item.label, 'Search Mail for “REF-2026-0471”');
  item.click();
  assert.deepEqual(calls, [['search-for', 'REF-2026-0471']]);
  assert.ok(labels(t)[0].startsWith('Look Up'), 'Look Up first, then Search Mail');
  // Windows and Linux get it too, without Look Up.
  const w = buildContextMenuTemplate(params({ selectionText: 'circular' }), { platform: 'win32', canSearch: true }, () => {});
  assert.deepEqual(labels(w).filter((l) => /Look Up|Search Mail/.test(l)), ['Search Mail for “circular”']);
});

test('not in a field, not without a search field, not for a long selection', () => {
  const ctx = { platform: 'darwin', canSearch: true };
  const none = (t) => !labels(t).some((l) => l.startsWith('Search Mail for'));
  assert.ok(none(buildContextMenuTemplate(params({ selectionText: 'x', isEditable: true }), ctx, () => {})));
  assert.ok(none(buildContextMenuTemplate(params({ selectionText: 'x' }), { platform: 'darwin', canSearch: false }, () => {})));
  assert.ok(none(buildContextMenuTemplate(params({ selectionText: 'y'.repeat(201) }), ctx, () => {})));
  assert.ok(none(buildContextMenuTemplate(params({ selectionText: '   ' }), ctx, () => {})));
});

test('the search action takes text only as plain, short JSON', () => {
  assert.doesNotThrow(() => new Function(actionScript('search', 'REF-2026-0471')));
  assert.doesNotThrow(() => actionScript('search'));
  for (const bad of ['', 'a\u0000b', 'x'.repeat(201), 3, { q: 1 }]) assert.throws(() => actionScript('search', bad));
  assert.ok(actionScript('search', '"); alert(1); ("').includes(JSON.stringify('"); alert(1); ("')));
});
