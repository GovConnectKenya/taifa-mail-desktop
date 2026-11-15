'use strict';
// Round 3 critic #4: the tray and the window disagreed for seconds at a time.
// The window's "Can't reach the server. Showing saved mail…" notice is a
// sticky toast the shim never read, so the tray fell back to the app's own
// health probe. Now the shim reports it, the tray mirrors it (connection.js),
// and when the server answers again the app presses that notice's own
// Try again so the window recovers at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageAction } = require('../src/page-actions');
const { pageShim, MARKS, normaliseState } = require('../src/page-shim');
const { connectionView } = require('../src/connection');

const NOTICE = "Can't reach the server. Showing saved mail, which may be out of date.";

function fakeDoc({ toast = true, chip = true } = {}) {
  const clicks = [];
  const button = (text, id) => ({ textContent: text, disabled: false, click: () => clicks.push(id) });
  const slots = [];
  if (toast) slots.push({ textContent: NOTICE + 'Try again', querySelectorAll: () => [button('Try again', 'toast-try-again')] });
  slots.push({ textContent: 'Message archived. Undo', querySelectorAll: () => [button('Undo', 'undo')] });
  const doc = {
    title: 'Inbox · Taifa Mail',
    activeElement: null,
    documentElement: {},
    body: { appendChild() {} },
    querySelector(s) {
      if (s === '.tm-conn' && chip) return { click: () => clicks.push('chip') };
      if (s === '.tm-conn-label' && chip) return { textContent: 'Reconnecting…' };
      if (s === '.tm-shell-topbar' || s === '.rail-item') return {};
      return null;
    },
    querySelectorAll(s) {
      if (s === '.toast-viewport .toast-slot') return slots;
      return [];
    },
    createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
  };
  global.window = {};
  global.document = doc;
  global.location = { pathname: '/', hash: '#INBOX' };
  return { clicks };
}

test('reconnect presses the notice’s own Try again, and the live chip', async () => {
  const { clicks } = fakeDoc();
  assert.equal(await pageAction('reconnect'), 'list+live');
  assert.deepEqual(clicks, ['toast-try-again', 'chip']);
});

test('reconnect with nothing to press reports false', async () => {
  fakeDoc({ toast: false, chip: false });
  assert.equal(await pageAction('reconnect'), false);
});

test('the shim reports the notice, and the tray then says exactly what the window says', async () => {
  fakeDoc();
  const said = [];
  const debug = console.debug;
  console.debug = (m) => said.push(String(m));
  Object.assign(global.window, { focus() {}, addEventListener() {}, Notification: undefined, WebSocket: undefined });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  global.MutationObserver = class { observe() {} disconnect() {} };
  try {
    pageShim(MARKS);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.debug = debug;
  }
  const m = said.find((x) => x.startsWith(MARKS.state));
  assert.ok(m, 'a state marker');
  const st = normaliseState(JSON.parse(m.slice(MARKS.state.length)));
  assert.equal(st.connKind, 'server');
  assert.equal(st.degraded, true, 'the chip is up too');
  const v = connectionView({ showingOffline: false, appLoaded: true, page: st, serverDown: false });
  assert.deepEqual(v, { state: 'offline', label: "Can't reach the server" });
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
  delete global.MutationObserver;
});
