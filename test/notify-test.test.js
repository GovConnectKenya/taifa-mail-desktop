'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testNotificationReport } = require('../src/notify-test');

const raw = /UNErrorDomain|error \d|\.log|permission|undefined|null/i;

test('a refused test says notifications are off, with one way to fix it', () => {
  const r = testNotificationReport({ platform: 'darwin', outcome: 'failed', osStatus: 'unknown', pagePref: null });
  assert.equal(r.message, 'Notifications are turned off for Taifa Mail');
  assert.match(r.detail, /System Settings > Notifications > Taifa Mail/);
  assert.deepEqual(r.buttons, ['Open System Settings', 'Not Now']);
  assert.equal(r.actions[0], 'os-settings');
  assert.ok(!raw.test(r.message + r.detail));
});

test('a known block wins over a reported show (macOS reports show regardless)', () => {
  assert.equal(testNotificationReport({ platform: 'darwin', outcome: 'shown', osStatus: 'blocked' }).message, 'Notifications are turned off for Taifa Mail');
});

test('the in-app switch is named when it is the reason', () => {
  const r = testNotificationReport({ platform: 'win32', outcome: 'shown', osStatus: 'ok', pagePref: 'off' });
  assert.equal(r.actions[0], 'app-settings');
  assert.match(r.message, /off in Taifa Mail/);
});

test('success reads as success, on every platform, with no diagnostics', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const r = testNotificationReport({ platform, outcome: 'shown', osStatus: 'ok', pagePref: null });
    assert.equal(r.message, 'Test notification sent');
    assert.equal(r.buttons.length, 2);
    assert.ok(!raw.test(r.message + r.detail), platform);
  }
  assert.match(testNotificationReport({ platform: 'win32', outcome: 'timeout' }).detail, /Settings > System > Notifications/);
});
