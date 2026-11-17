'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFallback, fallbackBody } = require('../src/notify-fallback');
const { formatLine, appendLine, MAX_BYTES } = require('../src/notify-log');

test('an unread increase after the initial sync is reported, a rise during sync is not', () => {
  let t = 0;
  const f = createFallback({ now: () => t, settleMs: 10000 });
  assert.equal(f.onUnread(0, 5), null, 'before the webmail loaded');
  f.markLoaded();
  t = 3000;
  assert.equal(f.onUnread(0, 5), null, 'initial mailbox sync');
  t = 20000;
  assert.deepEqual(f.onUnread(5, 6), { at: 20000, delta: 1 });
  assert.equal(f.onUnread(6, 6), null);
  assert.equal(f.onUnread(6, 2), null, 'reading mail lowers the count');
});

test('the fallback is due only when the page posted nothing around the increase', () => {
  let t = 20000;
  const f = createFallback({ now: () => t, settleMs: 0, lookbackMs: 3000 });
  f.markLoaded();
  const inc = f.onUnread(1, 2);
  assert.equal(f.due(inc), true, 'page was silent');
  t = 21000; f.pageAttempt();
  assert.equal(f.due(inc), false, 'page posted after the increase');
  const f2 = createFallback({ now: () => t, settleMs: 0, lookbackMs: 3000 });
  f2.markLoaded();
  t = 30000; f2.pageAttempt(); t = 30500;
  assert.equal(f2.due(f2.onUnread(1, 2)), false, 'page posted just before the title changed');
  t = 60000;
  assert.equal(f2.due(f2.onUnread(2, 3)), true, 'an old attempt does not count');
});

test('fallbackBody never carries message content', () => {
  assert.equal(fallbackBody(1), 'You have 1 unread message.');
  assert.equal(fallbackBody(4), 'You have 4 unread messages.');
});

test('log lines are single-line key=value records', () => {
  const line = formatLine({ event: 'attempted', permission: 'granted', front: false, reason: 'two words\nnewline' }, new Date('2026-11-15T10:00:00Z'));
  assert.equal(line, '2026-11-15T10:00:00.000Z event=attempted permission=granted front=false reason=two_words_newline');
});

test('appendLine writes, and rotates past the size cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taifa-log-'));
  const file = path.join(dir, 'nested', 'notifications.log');
  appendLine(file, 'one');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
  fs.writeFileSync(file, 'x'.repeat(MAX_BYTES + 1));
  appendLine(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
  assert.ok(fs.existsSync(`${file}.1`));
  fs.rmSync(dir, { recursive: true });
});

const { pickNew } = require('../src/notify-fallback');
const { createNotifier } = require('../src/notifier');

test('fallback: a fresh baseline announces nothing (no banner at sign-in)', () => {
  const items = [{ uid: 9, unread: true }, { uid: 7, unread: true }];
  assert.deepEqual(pickNew(items, null), { fresh: [], baseline: 9 });
  assert.deepEqual(pickNew(null, null), { fresh: [], baseline: null });
});

test('fallback: only unread mail newer than the baseline, oldest first', () => {
  const items = [{ uid: 12, unread: true }, { uid: 11, unread: false }, { uid: 10, unread: true }, { uid: 9, unread: true }];
  const r = pickNew(items, 9);
  assert.deepEqual(r.fresh.map((i) => i.uid), [10, 12]);
  assert.equal(r.baseline, 12);
  assert.deepEqual(pickNew(items, 12).fresh, [], 'nothing is announced twice');
  assert.deepEqual(pickNew([{ uid: 'x', unread: true }, { uid: -1, unread: true }], 0).fresh, []);
});

test('fallback: the settle window restarts at sign-in', () => {
  let t = 0;
  const f = createFallback({ now: () => t, settleMs: 10000 });
  f.markLoaded();
  t = 60000;
  assert.ok(f.onUnread(0, 3), 'an increase long after load counts');
  f.markLoaded(); // sign-in
  t += 2000;
  assert.equal(f.onUnread(0, 19), null, 'the jump at sign-in does not');
});

test('fallback envelopes become real notifications: sender, subject, snippet, a click opens it', () => {
  const posted = [];
  const opened = [];
  let pending = null;
  const n = createNotifier({
    platform: 'darwin',
    createNotification: (o) => { const h = {}; const x = { ...o, on: (e, cb) => { h[e] = cb; }, show() {}, close() {}, click: () => h.click() }; posted.push(x); return x; },
    setTimeout: (fn) => { pending = fn; return 1; },
    clearTimeout: () => {},
    onOpen: (r) => opened.push(r),
  });
  const { fresh } = pickNew([{ uid: 180, folder: 'INBOX', unread: true, fromName: 'Jane Doe', fromAddr: 'jane@ke.go', subject: 'Budget', snippet: 'Please review' }], 179);
  for (const m of fresh) n.post({ title: m.fromName || m.fromAddr, body: m.subject, snippet: m.snippet, tag: `mail-${m.folder}-${m.uid}` });
  pending();
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].title, posted[0].subtitle, posted[0].body], ['Jane Doe', 'Budget', 'Please review']);
  posted[0].click();
  assert.deepEqual(opened, ['/#INBOX/180']);
  // The page posting the same message later is a duplicate, not a second banner.
  assert.equal(n.post({ title: 'Jane Doe', body: 'Budget', tag: 'mail-INBOX-180' }), false);
});

// Round 3 critic #13: when the count rose but no new Inbox message existed
// (another device marked mail unread), "You have N unread messages" posted.
test('no banner when the list holds no new message; the count only when the list cannot be read', () => {
  const { fallbackPlan } = require('../src/notify-fallback');
  const head = [{ uid: 210, unread: true }, { uid: 205, unread: true }, { uid: 200, unread: false }];
  assert.deepEqual(fallbackPlan(head, 210), { kind: 'none', fresh: [], baseline: 210 });
  const p = fallbackPlan([{ uid: 211, unread: true }, ...head], 210);
  assert.equal(p.kind, 'envelopes');
  assert.deepEqual(p.fresh.map((m) => m.uid), [211]);
  assert.equal(p.baseline, 211);
  assert.deepEqual(fallbackPlan(null, 210), { kind: 'count', fresh: [], baseline: 210 });
  assert.equal(fallbackPlan(head, null).kind, 'none', 'no baseline yet: take one, announce nothing');
});
