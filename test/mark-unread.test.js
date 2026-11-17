'use strict';
// Round 3 critic #12: Mark as Unread left the conversation open in the reader,
// so it was effectively being read again. The main window now goes back to
// the list once the page shows the message as unread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pageAction, actionScript } = require('../src/page-actions');

function fakeReader({ flips = true } = {}) {
  const st = { unread: false, back: 0 };
  const reader = {
    querySelector(s) {
      if (s === '.tm-reader-tool[aria-label="Mark as read"]') return st.unread ? {} : null;
      if (s === '.tm-reader-back') return { disabled: false, click: () => { st.back += 1; } };
      return null;
    },
  };
  if (flips) setTimeout(() => { st.unread = true; }, 150);
  global.window = {};
  global.location = { pathname: '/', hash: '#INBOX/12' };
  global.document = { querySelector: (s) => (s === '.tm-reader[data-open="1"]' ? reader : null), querySelectorAll: () => [] };
  return st;
}

test('after the page shows it unread, the reader goes back to the list', async () => {
  const st = fakeReader();
  assert.equal(await pageAction('back-after-unread'), true);
  assert.equal(st.back, 1);
});

test('if the page never shows it unread, nothing closes', async () => {
  const st = fakeReader({ flips: false });
  assert.equal(await pageAction('back-after-unread'), false);
  assert.equal(st.back, 0);
});

test('main sends it after Mark as Unread only, and never in a message window', () => {
  assert.doesNotThrow(() => new Function(actionScript('back-after-unread')));
  assert.throws(() => actionScript('back-after-unread', 'x'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /id === 'mark-unread' && done && !messageWindows\.has\(w\)\) await pageAction\(w, 'back-after-unread'\)/);
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
});
