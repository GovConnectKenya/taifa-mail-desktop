'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNotifier, messageContent, summaryContent, summaryRoute } = require('../src/notifier');
const { buildPrintHtml, escapeHtml } = require('../src/print');

// A fake clock and timer queue, and a fake Notification that records itself.
function harness(over = {}) {
  let t = 1000;
  const timers = [];
  const posted = [];
  const opened = [];
  const n = createNotifier({
    platform: 'darwin',
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    createNotification: (opts) => {
      const e = new EventEmitter();
      e.opts = opts;
      e.show = () => posted.push(e);
      e.close = () => { e.closed = true; e.emit('close'); };
      return e;
    },
    onOpen: (r) => opened.push(r),
    ...over,
  });
  const advance = (ms) => {
    t += ms;
    for (const h of [...timers].sort((a, b) => a.at - b.at)) if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); }
  };
  return { n, posted, opened, advance };
}

const msg = (uid, title = 'Amina Odhiambo', folder = 'INBOX') => ({ title, body: `Subject ${uid}`, tag: `mail-${folder}-${uid}`, snippet: `Snippet for ${uid}` });

test('one message: sender, subject and snippet, and a click opens that conversation', () => {
  const { n, posted, opened, advance } = harness();
  n.post(msg(139));
  assert.equal(posted.length, 0, 'held briefly so a burst can be grouped');
  advance(1500);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].opts, { title: 'Amina Odhiambo', subtitle: 'Subject 139', body: 'Snippet for 139', silent: true });
  posted[0].emit('click');
  assert.deepEqual(opened, ['/#INBOX/139']);
});

test('on Windows and Linux the subject leads the body', () => {
  assert.deepEqual(messageContent({ title: 'A', body: 'Budget', snippet: 'Figures attached' }, 'win32'), { title: 'A', body: 'Budget\nFigures attached' });
  assert.deepEqual(messageContent({ title: '', body: '', snippet: '' }, 'linux'), { title: 'New message', body: '(no subject)' });
});

test('a burst becomes one summary that opens the folder', () => {
  const { n, posted, opened, advance } = harness();
  ['Peter Kamau', 'Grace Wanjiru', 'Peter Kamau', 'Ali Hassan', 'Mary Njeri'].forEach((s, i) => n.post(msg(10 + i, s)));
  advance(1500);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].opts, { title: '5 new messages', body: 'From Peter Kamau, Grace Wanjiru, Ali Hassan and 1 more', silent: true });
  posted[0].emit('click');
  assert.deepEqual(opened, ['/#INBOX']);
});

test('a summary across folders opens the Inbox; within one folder, that folder', () => {
  assert.equal(summaryRoute([{ mail: { folder: 'Projects/Budget 2027' } }, { mail: { folder: 'Projects/Budget 2027' } }]), '/#Projects%2FBudget+2027');
  assert.equal(summaryRoute([{ mail: { folder: 'INBOX' } }, { mail: { folder: 'Archive' } }]), '/#INBOX');
  assert.equal(summaryContent([{ title: 'A' }, { title: 'A' }]).body, 'From A');
});

test('the same message from a second window is posted once', () => {
  const { n, posted, advance } = harness();
  assert.equal(n.post(msg(7)), true);
  assert.equal(n.post(msg(7)), false);
  advance(1500);
  assert.equal(n.post(msg(7)), false, 'still a duplicate later');
  advance(1500);
  assert.equal(posted.length, 1);
});

test('sound follows the webmail setting', () => {
  const { n, posted, advance } = harness({ soundOn: () => true });
  n.post(msg(1));
  advance(1500);
  assert.equal(posted[0].opts.silent, false);
});

test('a runaway page cannot flood the screen', () => {
  const { n, posted, advance } = harness({ maxPerMinute: 3 });
  for (let i = 0; i < 6; i += 1) { n.post(msg(100 + i)); advance(1600); }
  assert.equal(posted.length, 3);
  advance(60000);
  n.post(msg(200));
  advance(1600);
  assert.equal(posted.length, 4);
});

test('the fallback replaces itself and is superseded by real messages', () => {
  const { n, posted, opened, advance } = harness();
  const a = n.postFallback(3);
  assert.equal(a.opts.body, 'You have 3 unread messages in your Inbox.');
  const b = n.postFallback(4);
  assert.equal(a.closed, true, 'the older count is withdrawn, not stacked');
  b.emit('click');
  assert.deepEqual(opened, ['/#INBOX']);
  n.post(msg(5));
  advance(1500);
  assert.equal(b.closed, true);
  assert.equal(posted.length, 3);
  assert.equal(n.postedWithin(8000), true);
  advance(9000);
  assert.equal(n.postedWithin(8000), false);
});

test('notifications are kept alive until closed (a collected one loses its click)', () => {
  const { n, posted, advance } = harness();
  n.post(msg(1));
  advance(1500);
  assert.equal(n.liveCount, 1);
  posted[0].close();
  assert.equal(n.liveCount, 0);
});

test('the print document escapes headers and is locked down', () => {
  const html = buildPrintHtml({ subject: '<img src=x onerror=alert(1)>', messages: [{ from: 'A <a@b.ke>', to: 'Me', date: '15 Nov 2026', body: '<p>Hello</p>' }] });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('A &lt;a@b.ke&gt;'));
  assert.ok(html.includes('<p>Hello</p>'));
  assert.ok(/Content-Security-Policy" content="default-src 'none'/.test(html));
  assert.ok(!/script-src/.test(html));
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
  assert.ok(buildPrintHtml({}).includes('(no subject)'));
});
