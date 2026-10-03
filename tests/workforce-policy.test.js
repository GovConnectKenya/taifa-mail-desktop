'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CALLBACK, LOGOUT_CALLBACK, callback, startNavigation, trustedSender, httpsOrigin } = require('../src/workforce-policy');
const ORG = 'abce1234-1234-4123-8123-123412341234';
test('exact callback parser rejects ambiguous routes, credentials, fragments and repeated fields', () => {
  assert.equal(callback(CALLBACK + '?code=c&state=s').logout, false);
  assert.equal(callback(LOGOUT_CALLBACK + '?state=s').logout, true);
  for (const raw of [CALLBACK + '#x?code=c&state=s', CALLBACK + '?code=a&code=b&state=s', CALLBACK + '?code=c&state=s&evil=1', CALLBACK + '?code=c&error=e&state=s', CALLBACK + '?code=c', CALLBACK + '/?code=c&state=s', 'ke.govconnect.taifamail.auth://evil/oauth2redirect?code=c&state=s', CALLBACK.toUpperCase() + '?code=c&state=s', LOGOUT_CALLBACK + '?state=s&code=c']) assert.throws(() => callback(raw));
});
test('only exact Mail workforce start and bounded UUID body become native actions', () => {
  const origin = 'https://mail.govconnect.ke';
  assert.deepEqual(startNavigation(origin + '/auth/workforce/start?org_id=' + ORG + '&reauth=true', origin), { orgId: ORG, reauth: true });
  for (const raw of [origin + '/auth/workforce/start?org_id=no', origin + '.evil/auth/workforce/start?org_id=' + ORG, origin + '/auth/workforce/start?org_id=' + ORG + '&org_id=' + ORG, origin + '/auth/workforce/start?org_id=' + ORG + '&next=//evil', origin + '/auth/workforce/start?org_id=' + ORG + '&next=%2f%5cevil', origin + '/auth/workforce/start?org_id=' + ORG + '&reauth=1']) assert.equal(startNavigation(raw, origin), null);
});
test('selector requires actual selected WebContents, its main frame and exact bundled file', () => {
  const frame = { url: 'file:///app/workforce.html' };
  const wc = { mainFrame: frame, isDestroyed: () => false };
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, wc, frame.url), true);
  assert.equal(trustedSender({ sender: wc, senderFrame: { url: frame.url } }, wc, frame.url), false);
  assert.equal(trustedSender({ sender: {}, senderFrame: frame }, wc, frame.url), false);
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, wc, frame.url + '?remote=1'), false);
  frame.url = 'https://mail.govconnect.ke';
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, wc, 'file:///app/workforce.html'), false);
});
test('provider and Mail configuration require HTTPS without URL credentials', () => {
  for (const raw of ['http://127.0.0.1', 'https://user:pass@mail.govconnect.ke', 'https://mail.govconnect.ke/#x']) assert.throws(() => httpsOrigin(raw));
});
test('native interception requires trusted source main window, main frame and no child initiator', () => {
  const { trustedStart } = require('../src/workforce-policy');
  const origin = 'https://mail.govconnect.ke';
  const frame = {};
  const wc = { mainFrame: frame, getURL: () => origin + '/' };
  const event = { isMainFrame: true, initiator: frame };
  const raw = origin + '/auth/workforce/start?org_id=' + ORG;
  assert.equal(trustedStart(wc, event, raw, origin, wc).orgId, ORG);
  assert.equal(trustedStart(wc, { isMainFrame: false, initiator: frame }, raw, origin, wc), null);
  assert.equal(trustedStart(wc, { isMainFrame: true, initiator: {} }, raw, origin, wc), null);
  assert.equal(trustedStart(wc, event, raw, origin, {}), null);
  wc.getURL = () => 'file:///app/offline.html';
  assert.equal(trustedStart(wc, event, raw, origin, wc), null);
});
