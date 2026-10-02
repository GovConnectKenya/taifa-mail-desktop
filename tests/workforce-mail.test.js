'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MailBridge } = require('../src/workforce-mail');
const ORG = 'abce1234-1234-4123-8123-123412341234';
const ID = 'abce1234-1234-4123-8123-123412341235';
test('Mail native exchange uses only fixed origin, bound org, fresh CSRF and opaque jar', async () => {
  let csrf;
  const calls = [];
  const session = { cookies: { get: async q => { assert.equal(q.url, 'https://mail.govconnect.ke/'); return csrf ? [{ value: csrf }] : []; } }, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/csrf')) { csrf = 'csrf-first'; return Response.json({}); }
    assert.equal(options.headers['X-CSRF-Token'], csrf);
    assert.equal(options.headers.Origin, 'https://mail.govconnect.ke');
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    return Response.json({ org_id: ORG });
  } };
  const bridge = new MailBridge(session, 'https://mail.govconnect.ke');
  await bridge.exchange('only-main-token', ORG);
  assert.deepEqual(JSON.parse(calls[1].options.body), { access_token: 'only-main-token', mail_org_id: ORG });
  csrf = 'rotated';
  await bridge.cleanup();
  assert.equal(calls[2].options.headers['X-CSRF-Token'], 'rotated');
  await assert.rejects(() => bridge.request('//attacker', {}));
});
test('cross-workspace exchange and mailbox responses fail closed', async () => {
  const session = { cookies: { get: async () => [{ value: 'csrf' }] }, fetch: async () => Response.json({ org_id: ID }) };
  const bridge = new MailBridge(session, 'https://mail.govconnect.ke');
  await assert.rejects(() => bridge.exchange('secret', ORG));
  await assert.rejects(() => bridge.select(ID, ORG));
  session.fetch = async () => Response.json([{ id: ID, org_id: ID, address: 'person@institution.gov' }]);
  await assert.rejects(() => bridge.mailboxes(ORG));
  session.fetch = async () => Response.json([{ id: ID, org_id: ORG, address: 'person@institution.gov' }]);
  assert.deepEqual(await bridge.mailboxes(ORG), [{ id: ID, address: 'person@institution.gov' }]);
});
test('oversized responses cannot consume unbounded Mail buffers', async () => {
  const session = { cookies: { get: async () => [{ value: 'csrf' }] }, fetch: async () => new Response('x'.repeat(65537)) };
  const bridge = new MailBridge(session, 'https://mail.govconnect.ke');
  await assert.rejects(() => bridge.request('/api/workforce/native/mailboxes'), /Invalid Mail response/);
});
test('local cancellation removes only relevant authentication credentials, preserving preferences and independent mailbox before selection', async () => {
  let rows = ['tfm_access_token', 'tfm_refresh_token', 'tfm_mb_access', 'tfm_mb_refresh', 'tfm_mb_acct_one', 'preference', 'tfm_csrf'].map(name => ({ name, path: '/' }));
  const session = { cookies: { get: async () => rows.slice(), remove: async (url, name) => { assert.equal(url, 'https://mail.govconnect.ke/'); rows = rows.filter(row => row.name !== name); }, flushStore: async () => {} } };
  const bridge = new MailBridge(session, 'https://mail.govconnect.ke');
  await bridge.dropLocal();
  assert.deepEqual(rows.map(r => r.name), ['tfm_mb_access', 'tfm_mb_refresh', 'tfm_mb_acct_one', 'preference', 'tfm_csrf']);
  await bridge.dropLocal({ mailbox: true });
  assert.deepEqual(rows.map(r => r.name), ['preference', 'tfm_csrf']);
});
