'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isConversationRoute, messageWindowCss, shouldCloseOnNavigate, messageTitle, MESSAGE_SIZE, placeMessageWindow, FOLLOW_JS, FOLLOW_CHECK_JS } = require('../src/message-window');

test('only a conversation route opens a message window', () => {
  for (const r of ['/#INBOX/174', '/#Projects%2FBudget+2027/9?mid=%3Cx%3E', '/#folder/search/12']) assert.equal(isConversationRoute(r), true, r);
  for (const r of ['/#INBOX', '/', '/settings', '/#search/budget', null, '/#INBOX/abc']) assert.equal(isConversationRoute(r), false, String(r));
  assert.ok(MESSAGE_SIZE.width < 1000, 'a reading-sized window, not a second client');
});

test('the message window hides the rail, the list and back to list, but keeps newer and older', () => {
  const css = messageWindowCss();
  for (const sel of ['.tm-shell-topbar', '.tm-shell-rail', '.list-col', '.tm-reader-back']) assert.ok(css.includes(sel), sel);
  assert.ok(!css.includes('Newer conversation') && !css.includes('Older conversation'), 'newer and older stay (round 3 #10)');
  assert.ok(!css.includes('-webkit-app-region'), 'a native title bar, no drag strip');
  assert.ok(!css.includes('.tm-reader-reply'), 'reply actions stay');
  assert.ok(!/:has\(/.test(css) && !css.includes('.tm-reader-toolbar'), 'the reader toolbar (Archive, Delete, ...) stays');
});

test('the window closes when its conversation goes away, not on ?params', () => {
  const home = 'https://mail.govconnect.ke/#INBOX/174';
  assert.equal(shouldCloseOnNavigate(home, `${home}?mid=%3Cx%3E`), false);
  assert.equal(shouldCloseOnNavigate(home, `${home}?compose=reply`), false);
  assert.equal(shouldCloseOnNavigate(home, 'https://mail.govconnect.ke/#INBOX/175'), true, 'archive advanced to the next one');
  assert.equal(shouldCloseOnNavigate(home, 'https://mail.govconnect.ke/#INBOX'), true, 'back to the list');
});

test('the title is the subject', () => {
  assert.equal(messageTitle('  Weekly   digest #44 '), 'Weekly digest #44');
  assert.equal(messageTitle(''), 'Taifa Mail');
  assert.ok(messageTitle('x'.repeat(300)).length <= 120);
});

// Round 3 critic #10: the message window opened 28 px off the main window,
// with no visible title, no newer or older, and no memory of its own place.
const D = [{ x: 0, y: 25, width: 1512, height: 920 }];
test('a first message window is centred on the window it came from, on screen', () => {
  const b = placeMessageWindow({ saved: null, displays: D, anchor: { x: 100, y: 60, width: 1200, height: 820 } });
  assert.equal(b.width, MESSAGE_SIZE.width);
  assert.ok(b.height <= 920);
  assert.equal(Math.round(b.x + b.width / 2), 700);
  assert.ok(b.y >= 25 && b.y + b.height <= 945);
});

test('it reopens where the user left it, unless that is off every screen', () => {
  const saved = { x: 640, y: 80, width: 700, height: 760 };
  assert.deepEqual(placeMessageWindow({ saved, displays: D, anchor: null }), saved);
  const gone = { x: 3000, y: 80, width: 700, height: 760 }; // an unplugged monitor
  const b = placeMessageWindow({ saved: gone, displays: D, anchor: null });
  assert.ok(b.x >= 0 && b.x + b.width <= 1512);
});

test('a second window at the same place steps down and right', () => {
  const saved = { x: 640, y: 80, width: 700, height: 760 };
  const b = placeMessageWindow({ saved, displays: D, open: [saved], anchor: null });
  assert.deepEqual([b.x, b.y], [664, 104]);
});

test('newer and older are told apart from the page advancing by itself', () => {
  assert.doesNotThrow(() => new Function(FOLLOW_JS));
  assert.ok(FOLLOW_JS.includes('Newer') && FOLLOW_JS.includes('Older'));
  assert.ok(FOLLOW_JS.includes('isContentEditable'), 'j and k typed in a field do not count');
  assert.doesNotThrow(() => new Function(`return ${FOLLOW_CHECK_JS}`));
});

test('main lists open message windows from an iterable set (messageWindows is a WeakSet)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(!/\[\.\.\.messageWindows\]/.test(src), 'a WeakSet cannot be spread');
  assert.match(src, /\[\.\.\.mailWindows\]\.filter\(\(m\) => messageWindows\.has\(m\)/);
});
