'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionView, createServerHealth, firstSentence } = require('../src/connection');
const { normaliseState } = require('../src/page-shim');

const page = (o) => normaliseState({ signedIn: true, online: true, ...o });
const view = (p, extra = {}) => connectionView({ showingOffline: false, appLoaded: true, page: p, serverDown: false, ...extra });

test('the tray says what the window says, in its words', () => {
  assert.deepEqual(view(page({ degraded: true, connKind: 'degraded', connText: 'Reconnecting…' })), { state: 'reconnecting', label: 'Reconnecting…' });
  assert.deepEqual(view(page({ offlineBanner: true, connKind: 'offline', connText: "You're offline. Showing saved mail, which may be out of date." })), { state: 'offline', label: "You're offline" });
  assert.deepEqual(view(page({ offlineBanner: true, connKind: 'offline', connText: "Can't reach the server. Showing saved mail." })), { state: 'offline', label: "Can't reach the server" });
  assert.equal(view(page({ offlineBanner: true, connKind: 'recovering', connText: 'Connection restored. Checking for new mail…' })).label, 'Checking for new mail…');
  assert.deepEqual(view(page({})), { state: 'online', label: 'Connected' });
});

test('a long reconnect stays "Reconnecting…", as the window shows it', () => {
  // No time input at all: nothing can turn reconnecting into offline behind the window.
  assert.equal(connectionView.length, 1);
  assert.equal(view(page({ degraded: true, connKind: 'degraded', connText: 'Reconnecting…' })).state, 'reconnecting');
});

test('a failing backend is not green when the window shows nothing', () => {
  assert.deepEqual(view(page({}), { serverDown: true }), { state: 'offline', label: 'Can’t reach the server' });
  assert.equal(view(null, { serverDown: true }).state, 'offline');
  assert.equal(view(null, { appLoaded: false }).state, 'connecting');
  assert.equal(view(null, { showingOffline: true }).label, 'Can’t reach the server');
});

test('server health: 5xx and no answer are down, any other answer is up, hangs count', () => {
  let t = 1000;
  const h = createServerHealth({ now: () => t, hungMs: 20000 });
  h.start('/v1/inbox/x')(200);
  assert.equal(h.down(), false);
  h.start('/v1/inbox/x')(502);
  assert.equal(h.down(), true);
  h.start('/v1/inbox/x')(404);
  assert.equal(h.down(), false, '4xx proves the server answered');
  t += 10;
  h.start('/v1/inbox/y')(0);
  assert.equal(h.down(), true, 'no answer');
  t += 10;
  h.start('/health')(200);
  const hang = h.start('/v1/inbox/slow');
  t += 25000;
  assert.equal(h.down(), true, 'a request waiting 25 s with nothing else finishing');
  hang(200);
  assert.equal(h.down(), false);
  h.start('/_app/x.js')(0);
  assert.equal(h.down(), false, 'bundled files do not count');
});

test('page conn fields are reduced to a known kind and short text', () => {
  const s = normaliseState({ connKind: '<x>', connText: 'a\u0000b'.repeat(200) });
  assert.equal(s.connKind, '');
  assert.ok(s.connText.length <= 160 && !s.connText.includes('\u0000'));
  assert.equal(firstSentence('Reconnecting…'), 'Reconnecting…');
});
