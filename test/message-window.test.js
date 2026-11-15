'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isConversationRoute, messageWindowCss, shouldCloseOnNavigate, messageTitle, MESSAGE_SIZE } = require('../src/message-window');

test('only a conversation route opens a message window', () => {
  for (const r of ['/#INBOX/174', '/#Projects%2FBudget+2027/9?mid=%3Cx%3E', '/#folder/search/12']) assert.equal(isConversationRoute(r), true, r);
  for (const r of ['/#INBOX', '/', '/settings', '/#search/budget', null, '/#INBOX/abc']) assert.equal(isConversationRoute(r), false, String(r));
  assert.ok(MESSAGE_SIZE.width < 1000, 'a reading-sized window, not a second client');
});

test('the message window hides the rail, the list and the list navigation', () => {
  const css = messageWindowCss('darwin');
  for (const sel of ['.tm-shell-topbar', '.tm-shell-rail', '.list-col', '.tm-reader-back', '[aria-label="Newer conversation"]']) assert.ok(css.includes(sel), sel);
  assert.ok(css.includes('-webkit-app-region: drag'), 'macOS keeps a drag strip under the traffic lights');
  assert.ok(!messageWindowCss('win32').includes('-webkit-app-region'), 'Windows and Linux have a native frame');
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
