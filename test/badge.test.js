'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseUnread, createBadge, requestNativeNotificationAuthorization } = require('../src/badge');

test('parseUnread reads the webmail prefix only', () => {
  assert.strictEqual(parseUnread('(1035) Inbox · Taifa Mail'), 1035);
  assert.strictEqual(parseUnread('(7) Inbox'), 7);
  assert.strictEqual(parseUnread('Inbox · Taifa Mail'), 0);
  assert.strictEqual(parseUnread('Projects (2024)'), 0);
  assert.strictEqual(parseUnread('(99999) Inbox'), 9999);
  assert.strictEqual(parseUnread(''), 0);
  assert.strictEqual(parseUnread(undefined), 0);
});

test('darwin: dock label set, cleared and re-asserted', () => {
  const calls = [];
  const b = createBadge({ platform: 'darwin', app: { dock: { setBadge: (v) => calls.push(v) } } });
  b.set(1035); b.reassert(); b.set(0); b.reassert();
  assert.deepStrictEqual(calls, ['1035', '1035', '', '']);
});

test('win32: overlay icon on the window, cleared at zero', () => {
  const calls = [];
  const win = { isDestroyed: () => false, setOverlayIcon: (i, d) => calls.push([i, d]) };
  const b = createBadge({ platform: 'win32', app: {}, getWindow: () => win, getOverlay: () => 'dot' });
  b.set(3); b.set(0);
  assert.deepStrictEqual(calls, [['dot', '3 unread'], [null, '']]);
});

test('linux: setBadgeCount', () => {
  const calls = [];
  const b = createBadge({ platform: 'linux', app: { setBadgeCount: (n) => calls.push(n) } });
  b.set(5); b.reassert();
  assert.deepStrictEqual(calls, [5, 5]);
});

test('notification authorization: once per profile, macOS only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taifa-badge-'));
  let shown = 0;
  class N { static isSupported() { return true; } show() { shown++; } }
  assert.strictEqual(requestNativeNotificationAuthorization({ Notification: N, userDataDir: dir, platform: 'linux' }), false);
  assert.strictEqual(requestNativeNotificationAuthorization({ Notification: N, userDataDir: dir, platform: 'darwin' }), true);
  assert.strictEqual(requestNativeNotificationAuthorization({ Notification: N, userDataDir: dir, platform: 'darwin' }), false);
  assert.strictEqual(shown, 1);
  fs.rmSync(dir, { recursive: true });
});

test('notification preference seed only fills an unset value', () => {
  const { SEED_NOTIFY_PREF_JS } = require('../src/badge');
  const run = (initial) => {
    const store = new Map(initial === undefined ? [] : [['taifa_mb_notifications', initial]]);
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    const result = new Function('localStorage', `return ${SEED_NOTIFY_PREF_JS}`)(localStorage);
    return [result, store.get('taifa_mb_notifications')];
  };
  assert.deepStrictEqual(run(undefined), ['seeded', 'on']);
  assert.deepStrictEqual(run('off'), ['off', 'off']);
  assert.deepStrictEqual(run('on'), ['on', 'on']);
});
