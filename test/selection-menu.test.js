'use strict';
// The reader's own right-click menu has no Copy, Look Up or Search Mail. On
// selected message text the shim lets the native menu through instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageShim, MARKS } = require('../src/page-shim');

function run({ selected = 'Latency', inReader = true, inField = false, intersects = true }) {
  const listeners = {};
  global.window = {
    focus() {},
    addEventListener(type, fn, capture) { if (capture === true || (capture && capture.capture)) (listeners[type] ||= []).push(fn); },
    getSelection: () => ({ isCollapsed: !selected, toString: () => selected, getRangeAt: () => ({ intersectsNode: () => intersects }) }),
  };
  global.document = { querySelector: () => null, querySelectorAll: () => [], documentElement: {}, body: { appendChild() {} }, activeElement: null };
  global.location = { pathname: '/', hash: '#INBOX/1' };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  global.MutationObserver = class { observe() {} };
  class El { closest(s) { if (s === '.tm-reader[data-open="1"]') return inReader ? {} : null; return inField ? {} : null; } }
  global.Element = El;
  const debug = console.debug;
  console.debug = () => {};
  try { pageShim(MARKS); } finally { console.debug = debug; }
  let stopped = false;
  let prevented = false;
  const ev = { target: new El(), stopImmediatePropagation() { stopped = true; }, preventDefault() { prevented = true; } };
  for (const fn of listeners.contextmenu || []) fn(ev);
  return { stopped, prevented };
}

test('selected message text gets the native menu: the page menu is stopped, never cancelled', () => {
  assert.deepEqual(run({}), { stopped: true, prevented: false });
});

test('no selection, outside the reader, in a field, or a selection elsewhere: the page menu stays', () => {
  assert.equal(run({ selected: '' }).stopped, false);
  assert.equal(run({ inReader: false }).stopped, false);
  assert.equal(run({ inField: true }).stopped, false);
  assert.equal(run({ intersects: false }).stopped, false);
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
  delete global.MutationObserver;
  delete global.Element;
});
