'use strict';
// Round 3 critic #1: with a reply minimised, Cmd+N, the tray's New Message and
// a file drop all failed. Each rewrote the route to ?compose=new, which the
// webmail ignores while the route already carries compose=reply. Now they
// press the page's own Compose control. These run the real page action and the
// real page shim against a small fake page whose Compose button opens a new
// composer and whose route ignores ?compose=new, like the webmail at r4.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageAction } = require('../src/page-actions');
const { pageShim, MARKS } = require('../src/page-shim');

function el(cls, extra = {}) {
  const e = {
    classList: new Set(cls.split(' ')),
    attrs: {},
    children: [],
    textContent: '',
    disabled: false,
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    focus() { page.focused = this; },
    ...extra,
  };
  return e;
}

let page;
function fakePage({ button = true, keyOpens = true } = {}) {
  page = { composers: [], hashWrites: [], keyEvents: 0, focused: null };
  const reply = el('compose minimized');
  page.composers.push(reply);
  const loc = { pathname: '/', _hash: '#INBOX/12?compose=reply' };
  Object.defineProperty(loc, 'hash', {
    get: () => loc._hash,
    // The webmail keeps the minimised reply and ignores a new ?compose=new.
    set: (h) => { page.hashWrites.push(h); loc._hash = h; },
  });
  const newComposer = () => {
    for (const c of page.composers) { c.classList.delete('minimized'); c.classList.add('minimized'); }
    const input = el('file', { accept: '', files: null, dispatchEvent() { page.attached = this.files; for (let i = 0; i < (this.files || []).length; i++) page.rows.push(el('att')); return true; } });
    const field = el('subject');
    const c = el('compose', { input, field });
    page.composers.push(c);
  };
  page.rows = [];
  const compose = el('tm-shell-primary', { textContent: 'Compose', click: newComposer });
  compose.attrs['aria-label'] = undefined;
  const matches = (c, s) => {
    if (s === '.compose:not(.minimized)') return c.classList.has('compose') && !c.classList.has('minimized');
    if (s === '.compose.minimized') return c.classList.has('minimized');
    if (s === '.compose') return c.classList.has('compose');
    return false;
  };
  const doc = {
    title: 'Inbox · Taifa Mail',
    activeElement: null,
    documentElement: {},
    body: {
      appendChild() {},
      dispatchEvent(ev) {
        if (ev.type === 'keydown' && ev.key === 'c') {
          page.keyEvents += 1;
          if (keyOpens) newComposer();
        }
        return true;
      },
    },
    querySelector(s) {
      if (s.startsWith('.compose')) {
        const c = page.composers.find((x) => matches(x, s));
        if (!c) return null;
        return Object.assign(c, {
          querySelector: () => c.field,
          querySelectorAll: (q) => (q.startsWith('input[type="file"]') && c.input ? [c.input] : []),
        });
      }
      return null;
    },
    querySelectorAll(s) {
      if (s === '.tm-shell-primary, .tm-compose-fab') return button ? [compose] : [];
      if (s === '.compose:not(.minimized) .att') return page.composers.some((c) => matches(c, '.compose:not(.minimized)')) ? page.rows : [];
      return [];
    },
    createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
  };
  global.window = {};
  global.document = doc;
  global.location = loc;
  global.KeyboardEvent = class { constructor(type, o) { Object.assign(this, o, { type }); } };
  return { loc, doc };
}

test('Cmd+N with a reply minimised presses the page’s Compose button, not the route', async () => {
  const { loc } = fakePage();
  const r = await pageAction('compose');
  assert.equal(r, 'button');
  assert.deepEqual(page.hashWrites, []);
  assert.equal(loc.hash, '#INBOX/12?compose=reply');
  assert.equal(page.composers.filter((c) => !c.classList.has('minimized')).length, 1, 'one new composer in front');
  assert.ok(page.composers[0].classList.has('minimized'), 'the reply stays a chip');
});

test('with no Compose button on screen the page’s own "c" shortcut opens one', async () => {
  fakePage({ button: false });
  const r = await pageAction('compose');
  assert.equal(r, 'key');
  assert.equal(page.keyEvents, 1);
  assert.deepEqual(page.hashWrites, []);
});

test('an expanded composer is brought forward instead of opening another', async () => {
  fakePage();
  await pageAction('compose');
  const n = page.composers.length;
  const r = await pageAction('compose');
  assert.equal(r, 'focused');
  assert.equal(page.composers.length, n);
});

test('the route is only the last resort', async () => {
  fakePage({ button: false, keyOpens: false });
  const r = await pageAction('compose');
  assert.equal(r, 'hash');
  assert.deepEqual(page.hashWrites, ['#INBOX/12?compose=new']);
});

test('a file dropped with a reply minimised opens a new message and attaches to it', async () => {
  fakePage();
  const listeners = {};
  const said = [];
  Object.assign(global.window, {
    focus() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    Notification: undefined,
    WebSocket: undefined,
  });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  global.innerHeight = 800;
  global.innerWidth = 1200;
  const debug = console.debug;
  console.debug = (m) => said.push(String(m));
  test.after(() => { console.debug = debug; });
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.DataTransfer = class { constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; } get files() { return this.list; } };
  global.Event = class { constructor(type) { this.type = type; } };
  pageShim(MARKS);
  const file = { name: 'budget.pdf' };
  const ev = { dataTransfer: { types: ['Files'], files: [file] }, defaultPrevented: false, preventDefault() {} };
  for (const fn of listeners.drop) fn(ev);
  const t0 = Date.now();
  let marker;
  while (Date.now() - t0 < 12000) {
    marker = said.find((m) => m.startsWith(MARKS.drop));
    if (marker) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(marker, 'the drop reported an outcome');
  const out = JSON.parse(marker.slice(MARKS.drop.length));
  assert.equal(out.outcome, 'attached');
  assert.deepEqual(page.attached, [file]);
  assert.deepEqual(page.hashWrites, [], 'no route rewrite');
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
  delete global.navigator;
  delete global.MutationObserver;
  delete global.DataTransfer;
});
