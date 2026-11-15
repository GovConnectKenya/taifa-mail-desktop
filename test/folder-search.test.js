'use strict';
// Round 3 critic #3: Cmd+1 did not leave a search started from the Inbox. The
// folder action took "the title already says Inbox" as arrived, and the hash
// route does not close the search results in the r4 webmail. Now it always
// runs the navigation through the page's own rail row and the search field's
// own clear button. This fake page behaves like r4: the title keeps the
// folder's name during a search, a hash change leaves the search up, and only
// the rail row (selectFolder) closes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageAction } = require('../src/page-actions');

function fakePage({ folder = 'INBOX', search = true, fieldText = search } = {}) {
  const titles = { INBOX: 'Inbox', Sent: 'Sent', Archive: 'Archive' };
  const st = { folder, search, fieldText, railClicks: 0, clearClicks: 0, blurred: false };
  const loc = { pathname: '/', _hash: `#${folder}` };
  const doc = { title: `(3) ${titles[folder]} · Taifa Mail` };
  const retitle = () => setTimeout(() => { doc.title = `(3) ${titles[st.folder]} · Taifa Mail`; }, 40);
  Object.defineProperty(loc, 'hash', {
    get: () => loc._hash,
    set: (h) => {
      loc._hash = h;
      st.folder = h.slice(1).split(/[/?]/)[0];
      retitle();
    },
  });
  const input = { matches: (s) => s === '[data-search-input]', blur() { st.blurred = true; } };
  const rail = Object.keys(titles).map((f) => ({
    querySelector: () => ({ textContent: titles[f] }),
    click: () => setTimeout(() => {
      st.railClicks += 1;
      st.search = false; // selectFolder closes the cross-folder results
      st.folder = f;
      loc._hash = `#${f}`;
      retitle();
    }, 120),
  }));
  const clear = { click: () => { st.clearClicks += 1; st.fieldText = false; doc.activeElement = input; } };
  doc.activeElement = null;
  doc.querySelector = (s) => {
    if (s === '.tm-cross-head') return st.search ? {} : null;
    if (s === '.tm-shell-search-clear') return st.fieldText ? clear : null;
    return null;
  };
  doc.querySelectorAll = (s) => (s === '.rail-item' ? rail : []);
  doc.createElement = () => ({ style: {}, click() {}, remove() {} });
  doc.body = { appendChild() {} };
  global.window = {};
  global.document = doc;
  global.location = loc;
  return { st, loc };
}

test('Cmd+1 leaves a search started from the Inbox, although the title says Inbox', async () => {
  const { st, loc } = fakePage({ folder: 'INBOX' });
  const r = await pageAction('folder', { name: 'Inbox', hash: '#INBOX' });
  assert.equal(r, '#INBOX');
  assert.equal(st.search, false, 'search results closed');
  assert.equal(st.fieldText, false, 'search field cleared');
  assert.equal(st.railClicks, 1, 'the page’s own rail row was pressed');
  assert.equal(st.blurred, true, 'focus left the search field');
  assert.equal(loc.hash, '#INBOX');
});

test('Cmd+2 from a search in the Inbox lands on Sent with the search gone', async () => {
  const { st, loc } = fakePage({ folder: 'INBOX' });
  const r = await pageAction('folder', { name: 'Sent', hash: '#Sent' });
  assert.equal(r, '#Sent');
  assert.equal(loc.hash, '#Sent');
  assert.equal(st.search, false);
  assert.equal(st.fieldText, false);
});

test('focus leaves the search field even when the rail row already cleared the query', async () => {
  const { st } = fakePage({ folder: 'INBOX' });
  global.document.activeElement = { matches: (s) => s === '[data-search-input]', blur() { st.blurred = true; } };
  const r = await pageAction('folder', { name: 'Inbox', hash: '#INBOX' });
  assert.equal(r, '#INBOX');
  assert.equal(st.blurred, true);
});

test('a query left in the field alone is cleared too', async () => {
  const { st } = fakePage({ folder: 'INBOX', search: false, fieldText: true });
  const r = await pageAction('folder', { name: 'Inbox', hash: '#INBOX' });
  assert.equal(r, '#INBOX');
  assert.equal(st.fieldText, false);
});

test('without a search, Inbox is still the plain fast route', async () => {
  const { st, loc } = fakePage({ folder: 'Sent', search: false });
  const r = await pageAction('folder', { name: 'Inbox', hash: '#INBOX' });
  assert.equal(r, '#INBOX');
  assert.equal(loc.hash, '#INBOX');
  assert.equal(st.railClicks, 0);
});

test.after(() => {
  delete global.window;
  delete global.document;
  delete global.location;
});
