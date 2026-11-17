'use strict';
// Round 3 critic #6: with a server that held connections open, 14 hung
// requests used up Chromium's per-host pool and the app sent nothing for over
// 80 s after the server came back. Backend reads now get a deadline for their
// response headers; writes never do, so a send is never aborted and resent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestDeadline, READ_DEADLINE_MS } = require('../src/bundle');

const O = 'https://mail.govconnect.ke';

test('backend reads get a deadline', () => {
  assert.equal(READ_DEADLINE_MS, 30000);
  for (const p of ['/v1/inbox/abc/conversations?folder=INBOX', '/health', '/auth/mailbox/me']) {
    assert.equal(requestDeadline('GET', O + p, O), READ_DEADLINE_MS, p);
  }
  assert.equal(requestDeadline('head', O + '/health', O), READ_DEADLINE_MS);
});

test('writes, other hosts and the app’s own files never time out', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requestDeadline(m, O + '/v1/inbox/abc/send', O), 0, m);
  assert.equal(requestDeadline('GET', 'https://objects.example.net/v1/blob', O), 0);
  assert.equal(requestDeadline('GET', O + '/_app/immutable/x.js', O), 0);
  assert.equal(requestDeadline('GET', 'not a url', O), 0);
});

// Round 3 hang test (this session): the app's own /health probe bypasses the
// protocol handler, so it needs its own limit, and must never overlap itself.
test('the health probe is single-flight and aborted after a few seconds', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function probeAndNudge'), src.indexOf('function watchConnection'));
  assert.match(fn, /if \(probing\) return;/);
  assert.match(fn, /signal: AbortSignal\.timeout\(PROBE_TIMEOUT_MS\)/);
  assert.match(fn, /finally \{\s*probing = false;/);
  assert.match(src, /const PROBE_TIMEOUT_MS = 4000;/);
});
