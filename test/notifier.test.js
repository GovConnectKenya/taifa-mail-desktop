'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNotifier, messageContent, summaryContent, summaryRoute } = require('../src/notifier');
const { buildPrintHtml, escapeHtml, fmtSize } = require('../src/print');

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
  const html = buildPrintHtml({ subject: '<img src=x onerror=alert(1)>', messages: [{ fromName: 'A', fromAddr: 'a@b.ke', to: ['Me <me@b.ke>'], date: '15 Nov 2026', html: '<p>Hello</p>' }] });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('A &lt;a@b.ke&gt;'));
  assert.ok(html.includes('<p>Hello</p>'));
  assert.ok(/Content-Security-Policy" content="default-src 'none'; img-src data:;/.test(html), 'images: data: only, no network');
  assert.ok(!/script-src/.test(html));
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
  assert.ok(buildPrintHtml({}).includes('(no subject)'));
});

test('print: plain-text messages print, escaped, with every header and the attachments', () => {
  const html = buildPrintHtml({
    subject: 'Budget',
    total: 2,
    messages: [
      { fromName: 'Jane Doe', fromAddr: 'jane@ke.go', to: ['officer@ke.go', 'Bob <bob@ke.go>'], cc: ['cc@ke.go'], date: 'Sat, 15 Nov 2026, 14:05', text: 'Line one\n<b>not bold</b>', attachments: [{ name: 'q4.csv', size: 2048 }, { name: 'a<b>.pdf', size: 0 }] },
      { fromName: '', fromAddr: 'officer@ke.go', to: [], cc: [], date: '', html: '<p>Reply</p>', attachments: [] },
    ],
  });
  assert.ok(html.includes('<div class="body text">Line one\n&lt;b&gt;not bold&lt;/b&gt;</div>'), 'plain text is escaped, line breaks kept');
  assert.ok(html.includes('<th>To:</th><td>officer@ke.go, Bob &lt;bob@ke.go&gt;</td>'), 'real recipients, not "me"');
  assert.ok(html.includes('<th>Cc:</th><td>cc@ke.go</td>'));
  assert.ok(html.includes('2 attachments') && html.includes('q4.csv <span class="size">(2 KB)</span>') && html.includes('a&lt;b&gt;.pdf</li>'));
  assert.equal((html.match(/<section class="msg">/g) || []).length, 2, 'every message, not just expanded ones');
  assert.ok(html.includes('<th>From:</th><td>officer@ke.go</td>'), 'an address alone when there is no name');
  assert.ok(!/<th>Date:<\/th><td><\/td>/.test(html) && !/<th>To:<\/th><td><\/td>/.test(html), 'empty rows are left out');
  assert.ok(html.includes('<p class="count">2 messages</p>'));
});

test('print: black and white, Times New Roman, no header or footer furniture', () => {
  const html = buildPrintHtml({ subject: 'S', messages: [{ fromAddr: 'a@b.ke', html: '<p style="color:red">x</p>' }] });
  assert.ok(/font: 11pt\/1\.45 'Times New Roman'/.test(html));
  assert.ok(html.includes('.body.html, .body.html * { color: #000 !important; background-color: transparent !important'));
  assert.ok(html.includes('filter: grayscale(1)'));
  assert.ok(!/<header|<footer/.test(html));
});

test('print: a partial thread says how much of it printed', () => {
  assert.ok(buildPrintHtml({ subject: 'S', total: 140, messages: new Array(100).fill({ fromAddr: 'a@b.ke', text: 'x' }) }).includes('100 of 140 messages (the latest 100)'));
  const offline = buildPrintHtml({ subject: 'S', total: 3, note: 'only the open messages are printed (1 of 3).', messages: [{ fromAddr: 'a@b.ke', text: 'x' }] });
  assert.ok(offline.includes('<p class="note">only the open messages are printed (1 of 3).</p>'));
  assert.equal(fmtSize(1536 * 1024), '1.5 MB');
});
