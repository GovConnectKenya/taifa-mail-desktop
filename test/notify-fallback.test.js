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
