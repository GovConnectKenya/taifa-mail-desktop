'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ns = require('../src/notify-state');

const ORIGIN = 'https://mail.govconnect.ke';
const base = { allowlist: new Set(['notifications', 'fullscreen']), isAllowedOrigin: (o) => String(o).startsWith(ORIGIN) };
const snap = (status, reason = '') => ({ status, reason });

test('state machine: unknown, blocked, ok, and notifies once per change', () => {
  const st = ns.createNotificationState();
  const seen = [];
  st.subscribe((x) => seen.push(x.status));
  assert.deepStrictEqual(st.snapshot(), { status: 'unknown', reason: '' });
  st.setBlocked('macos-authorization');
  st.setBlocked('macos-authorization');
  assert.deepStrictEqual(st.snapshot(), { status: 'blocked', reason: 'macos-authorization' });
  st.setOk();
  st.setOk();
  assert.strictEqual(st.snapshot().status, 'ok');
  st.setBlocked('notification-failed');
  assert.deepStrictEqual(seen, ['blocked', 'ok', 'blocked']);
});

test('a throwing listener does not break the state', () => {
  const st = ns.createNotificationState();
  st.subscribe(() => { throw new Error('boom'); });
  st.setBlocked('x');
  assert.strictEqual(st.snapshot().status, 'blocked');
});

test('parseMacAuthLog reads the last requestAuthorization verdict', () => {
  const denied = '2026-11-15 07:43:11.092 Df Electron[1:2] [com.apple.UserNotifications:Connections] [ke.x] Requested authorization [ didGrant: 0 hasError: 1 hasCompletionHandler: 1 ]';
  const granted = '... Requested authorization [ didGrant: 1 hasError: 0 hasCompletionHandler: 1 ]';
  assert.strictEqual(ns.parseMacAuthLog(denied), 'blocked');
  assert.strictEqual(ns.parseMacAuthLog(granted), 'ok');
  assert.strictEqual(ns.parseMacAuthLog(`${denied}\n${granted}`), 'ok');
  assert.strictEqual(ns.parseMacAuthLog(`${granted}\n${denied}`), 'blocked');
  assert.strictEqual(ns.parseMacAuthLog(''), 'unknown');
  assert.strictEqual(ns.parseMacAuthLog('Filtering the log data using ...'), 'unknown');
});

test('parseDbusNameHasOwner', () => {
  assert.strictEqual(ns.parseDbusNameHasOwner('method return time=1\n   boolean true'), 'ok');
  assert.strictEqual(ns.parseDbusNameHasOwner('method return time=1\n   boolean false'), 'blocked');
  assert.strictEqual(ns.parseDbusNameHasOwner('nonsense'), 'unknown');
});

test('detect uses the platform probe and degrades to unknown on any error', async () => {
  const ok = (out) => (_cmd, _args, _opt, cb) => cb(null, out);
  const bad = (_cmd, _args, _opt, cb) => cb(new Error('no such command'));
  assert.deepStrictEqual(
    await ns.detect({ platform: 'darwin', execFileFn: ok('Requested authorization [ didGrant: 0 hasError: 1') }),
    { status: 'blocked', reason: 'macos-authorization' });
  assert.strictEqual((await ns.detect({ platform: 'darwin', execFileFn: bad })).status, 'unknown');
  assert.deepStrictEqual(
    await ns.detect({ platform: 'linux', execFileFn: ok('boolean false') }),
    { status: 'blocked', reason: 'linux-no-notification-service' });
  assert.strictEqual((await ns.detect({ platform: 'linux', execFileFn: ok('boolean true') })).status, 'ok');
  assert.strictEqual((await ns.detect({ platform: 'linux', execFileFn: bad })).status, 'unknown');
  assert.strictEqual((await ns.detect({ platform: 'win32' })).status, 'unknown');
});

test('macOS probe asks the log for this process only', async () => {
  let args;
  await ns.checkMacAuthorization({ pid: 4242, exec: (_c, a, _o, cb) => { args = a; cb(null, ''); } });
  assert.ok(args.some((a) => a.includes('processID == 4242')));
});

test('permission check: notifications follow the OS state, other permissions are untouched', () => {
  const chk = (permission, snapshot, origin = ORIGIN + '/') => ns.permissionCheck({ ...base, permission, origin, snapshot });
  assert.strictEqual(chk('notifications', snap('unknown')), true);
  assert.strictEqual(chk('notifications', snap('ok')), true);
  assert.strictEqual(chk('notifications', snap('blocked', 'macos-authorization')), false);
  assert.strictEqual(chk('fullscreen', snap('blocked')), true);
  assert.strictEqual(chk('geolocation', snap('ok')), false);
  assert.strictEqual(chk('notifications', snap('ok'), 'https://evil.example/'), false);
});

test('permission request: blocked OS opens settings and denies, otherwise grants', () => {
  const req = (permission, snapshot, url = ORIGIN + '/#INBOX') => ns.permissionRequest({ ...base, permission, url, snapshot });
  assert.deepStrictEqual(req('notifications', snap('ok')), { grant: true, openSettings: false });
  assert.deepStrictEqual(req('notifications', snap('unknown')), { grant: true, openSettings: false });
  assert.deepStrictEqual(req('notifications', snap('blocked')), { grant: false, openSettings: true });
  assert.deepStrictEqual(req('fullscreen', snap('blocked')), { grant: true, openSettings: false });
  assert.deepStrictEqual(req('camera', snap('ok')), { grant: false, openSettings: false });
  assert.deepStrictEqual(req('notifications', snap('blocked'), 'https://evil.example/'), { grant: false, openSettings: false });
});

test('settings target per platform', () => {
  assert.match(ns.settingsTarget('darwin').url, /^x-apple\.systempreferences:com\.apple\.Notifications-Settings\.extension\?id=ke\.govconnect\.taifamail$/);
  assert.strictEqual(ns.settingsTarget('win32').url, 'ms-settings:notifications');
  assert.strictEqual(ns.settingsTarget('linux').url, ns.DOCS_URL);
  assert.match(ns.linuxGuidance('linux-no-notification-service'), /dunst/);
});

const vm = require('node:vm');
const { permissionOverrideScript, createSettingsGate } = require('../src/notify-state');

test('the permission override reads default while blocked and restores the real value after', () => {
  function Notification() {}
  Object.defineProperty(Notification, 'permission', { configurable: true, enumerable: true, get: () => 'denied' });
  const ctx = { Notification };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(permissionOverrideScript(true), ctx);
  assert.equal(ctx.Notification.permission, 'default');
  vm.runInContext(permissionOverrideScript(true), ctx);
  assert.equal(ctx.Notification.permission, 'default');
  vm.runInContext(permissionOverrideScript(false), ctx);
  assert.equal(ctx.Notification.permission, 'denied');
  vm.runInContext(permissionOverrideScript(false), ctx);
  assert.equal(ctx.Notification.permission, 'denied');
});

test('the settings gate opens once per gesture and never without one', () => {
  let t = 1000;
  const g = createSettingsGate({ now: () => t, gestureWindowMs: 3000, minIntervalMs: 15000 });
  assert.equal(g.shouldOpen(), false, 'no gesture yet');
  g.noteGesture();
  assert.equal(g.shouldOpen(), true);
  assert.equal(g.shouldOpen(), false, 'same gesture, already opened');
  t += 5000; g.noteGesture();
  assert.equal(g.shouldOpen(), false, 'too soon after the last open');
  t += 20000; g.noteGesture();
  assert.equal(g.shouldOpen(), true);
  t += 4000;
  assert.equal(g.shouldOpen(), false, 'the gesture is stale');
});
