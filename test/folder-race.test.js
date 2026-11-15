'use strict';
// Cmd+4 then Cmd+1 within half a second used to land on the first folder in
// 3 of 5 runs: the older action's retry loop clicked its folder again after the
// newer one had landed. This runs the real page action against a small fake
// page whose folder clicks take effect after a delay, like the webmail's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageAction } = require('../src/page-actions');

function fakePage({ clickDelay = 250 } = {}) {
  const titles = { INBOX: 'Inbox', Archive: 'Archive', Sent: 'Sent', Trash: 'Trash' };
  const loc = { pathname: '/', _hash: '#INBOX' };
  const doc = { title: '(3) Inbox · Taifa Mail' };
  const apply = (h) => {
    loc._hash = h;
    const f = decodeURIComponent(h.slice(1).split('/')[0].split('?')[0]);
    // The page retitles itself a moment after the route changes.
    setTimeout(() => { doc.title = `(3) ${titles[f] || f} · Taifa Mail`; }, 60);
  };
  Object.defineProperty(loc, 'hash', { get: () => loc._hash, set: (h) => apply(h) });
  const rail = Object.keys(titles).map((f) => ({
    querySelector: () => ({ textContent: titles[f] }),
    // A click routes after a delay, like a real click through the router.
    click: () => setTimeout(() => apply(`#${f}`), clickDelay),
  }));
  doc.querySelector = () => null;
  doc.querySelectorAll = (s) => (s === '.rail-item' ? rail : []);
  doc.createElement = () => ({ style: {}, click() {}, remove() {} });
  doc.body = { appendChild() {} };
  global.window = {};
  global.document = doc;
  global.location = loc;
  return { loc, doc };
}

test('rapid folder shortcuts end on the last one pressed', async () => {
  for (const [first, second, want] of [['Archive', 'Inbox', '#INBOX'], ['Archive', 'Sent', '#Sent'], ['Trash', 'Inbox', '#INBOX']]) {
    const { loc } = fakePage();
    const a = pageAction('folder', { name: first });
    await new Promise((r) => setTimeout(r, 300));
    const b = pageAction('folder', { name: second });
    const [ra, rb] = await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(loc.hash.split('?')[0], want, `${first} then ${second}`);
    assert.equal(ra, 'superseded', `${first} stood down`);
    assert.equal(rb, want);
  }
});

test('a known folder route is opened directly, without waiting on a click', async () => {
  const { loc } = fakePage({ clickDelay: 5000 });
  const t0 = Date.now();
  const r = await pageAction('folder', { name: 'Archive', hash: '#Archive' });
  assert.equal(r, '#Archive');
  assert.equal(loc.hash, '#Archive');
  assert.ok(Date.now() - t0 < 2000);
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
});
