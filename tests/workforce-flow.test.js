'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./oidc-fixture.cjs');
const { WorkforceFlow } = require('../src/workforce-flow');
const { CALLBACK, LOGOUT_CALLBACK } = require('../src/workforce-policy');
const ORG = 'abce1234-1234-4123-8123-123412341234';
const ID = 'abce1234-1234-4123-8123-123412341235';
function setup(provider, options = {}) {
  const calls = [], states = [], urls = [];
  let completed = 0;
  const mail = {
    exchange: async (token, org) => calls.push(['exchange', token, org]),
    mailboxes: async () => [{ id: ID, address: 'assigned@institution.gov' }],
    select: async (id, org) => calls.push(['select', id, org]),
    cleanup: async () => calls.push(['cleanup']),
    logout: async () => calls.push(['logout']),
    dropLocal: async () => {},
    ...options.mail,
  };
  const flow = new WorkforceFlow({ issuer: provider.issuer, clientLoader: async () => provider.client, mail, openExternal: async url => urls.push(url), notify: state => states.push(state), complete: () => completed++, ...options.flow });
  return { flow, calls, states, urls, completed: () => completed };
}
test('real RSA OIDC, PKCE, explicit assigned selection, replay deny and no token retention', async t => {
  const provider = await fixture(); t.after(() => provider.close());
  const s = setup(provider);
  await s.flow.start(ORG, true);
  const authorize = new URL(s.urls[0]);
  assert.equal(authorize.searchParams.get('max_age'), '0');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), CALLBACK);
  const response = provider.response(s.urls[0]);
  const received = s.flow.receive(response);
  assert.equal(await s.flow.receive(response), false);
  assert.equal(await received, true);
  assert.equal(s.flow.pending.phase, 'selection');
  assert.equal(s.flow.pending.verifier, undefined);
  assert.equal(s.completed(), 0);
  await assert.rejects(() => s.flow.select(ORG));
  await s.flow.select(ID);
  assert.equal(s.completed(), 1);
  assert.equal(s.flow.pending, null);
  assert.equal(await s.flow.receive(response), false);
  assert.deepEqual(s.calls.map(c => c[0]), ['exchange', 'select']);
  assert.equal(JSON.stringify(s.states).includes('mail-api-access'), false);
});
for (const [name, change] of Object.entries({ signature: { badSignature: true }, issuer: { issuer: 'https://attacker.invalid' }, audience: { audience: 'foreign-client' }, nonce: { override: { nonce: 'wrong' } }, assurance: { override: { acr: 'password' } }, recency: { override: { auth_time: Math.floor(Date.now() / 1000) - 301 } } })) {
  test('real signed OIDC rejects invalid ' + name + ' before Mail exchange', async t => {
    const provider = await fixture(); t.after(() => provider.close());
    const s = setup(provider); await s.flow.start(ORG);
    await s.flow.receive(provider.response(s.urls[0], change));
    assert.equal(s.flow.pending, null);
    assert.deepEqual(s.calls, []);
    assert.equal(s.states.at(-1).phase, 'error');
  });
}
test('wrong state never consumes pending callback or calls token endpoint', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p); await s.flow.start(ORG);
  const raw = p.response(s.urls[0]);
  assert.equal(await s.flow.receive(raw.replace(/state=[^&]+/, 'state=wrong')), false);
  assert.equal(p.requests.some(path => path.endsWith('/token')), false);
  await s.flow.cancel(); assert.equal(s.flow.pending, null);
  assert.equal(await s.flow.receive(raw), false);
});
test('cancellation waits for inflight exchange and revokes temporary account without mailbox logout', async t => {
  const p = await fixture(); t.after(() => p.close());
  let unblock, reached;
  const atExchange = new Promise(resolve => { reached = resolve; });
  const wait = new Promise(resolve => { unblock = resolve; });
  const s = setup(p, { mail: { exchange: async () => { reached(); await wait; } } });
  await s.flow.start(ORG);
  const receiving = s.flow.receive(p.response(s.urls[0]));
  await atExchange;
  const cancelling = s.flow.cancel();
  unblock(); await receiving; await cancelling;
  assert.equal(s.flow.pending, null);
  assert.deepEqual(s.calls, [['cleanup']]);
  assert.equal(s.completed(), 0);
});
test('browser launch failure and expired flow erase pending proof state', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p, { flow: { openExternal: async () => { throw Error('no handler'); } } });
  await s.flow.start(ORG); assert.equal(s.flow.pending, null);
  const live = setup(p); await live.flow.start(ORG);
  live.flow.pending.deadline = 0;
  assert.equal(await live.flow.receive(p.response(live.urls[0])), false);
  await live.flow.cancel(); assert.equal(live.flow.pending, null);
});
test('local logout first, matching provider callback and honest provider outage', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p); await s.flow.logout();
  assert.deepEqual(s.calls, [['logout']]);
  const url = new URL(s.urls[0]);
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), LOGOUT_CALLBACK);
  assert.equal(url.searchParams.has('id_token_hint'), false);
  assert.equal(await s.flow.receive(LOGOUT_CALLBACK + '?state=wrong'), false);
  assert.equal(await s.flow.receive(LOGOUT_CALLBACK + '?state=' + url.searchParams.get('state')), true);
  assert.equal(s.flow.logoutPending, null);
  const bad = setup(p, { flow: { clientLoader: async () => { throw Error('provider offline'); } } });
  await bad.flow.logout();
  assert.deepEqual(bad.calls, [['logout']]);
  assert.match(bad.states.at(-1).message, /Mail is signed out.*unavailable/);
});
test('cancel after explicit mailbox transfer revokes uncertain mailbox and temporary officer sessions', async t => {
  const p = await fixture(); t.after(() => p.close());
  let reached, unblock;
  const atSelect = new Promise(resolve => { reached = resolve; });
  const wait = new Promise(resolve => { unblock = resolve; });
  const s = setup(p, { mail: { select: async () => { reached(); await wait; } } });
  await s.flow.start(ORG); await s.flow.receive(p.response(s.urls[0]));
  const selecting = s.flow.select(ID); await atSelect;
  const cancelled = s.flow.cancel(); unblock(); await selecting; await cancelled;
  assert.equal(s.flow.pending, null);
  assert.equal(s.completed(), 1); // Reload removes the old renderer's token memory.
  assert.deepEqual(s.calls.map(c => c[0]), ['exchange', 'logout', 'cleanup']);
});
test('concurrent start cannot replace a pending proof before prior cleanup', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p);
  const starting = s.flow.start(ORG);
  await assert.rejects(() => s.flow.start(ORG));
  await starting;
  assert.equal(s.urls.length, 1);
  await s.flow.cancel();
});
test('provider error callback is one-use, generic and never calls Mail', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p); await s.flow.start(ORG);
  const state = new URL(s.urls[0]).searchParams.get('state');
  await s.flow.receive(CALLBACK + '?error=access_denied&error_description=secret-detail&state=' + state);
  assert.equal(s.flow.pending, null);
  assert.deepEqual(s.calls, []);
  assert.equal(JSON.stringify(s.states).includes('secret-detail'), false);
});
test('cleanup outage reports uncertain session retirement and clears in-memory proof', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p, { mail: { mailboxes: async () => { throw Error('offline'); }, cleanup: async () => { throw Error('offline'); } } });
  await s.flow.start(ORG); await s.flow.receive(p.response(s.urls[0]));
  assert.equal(s.flow.pending, null);
  assert.match(s.states.at(-1).message, /cleanup could not be confirmed/);
});
test('logout fences concurrent sign-in until its provider transaction completes', async t => {
  const p = await fixture(); t.after(() => p.close());
  let unblock, reached;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const atLogout = new Promise(resolve => { reached = resolve; });
  const s = setup(p, { mail: { logout: async () => { reached(); await waiting; } } });
  const loggingOut = s.flow.logout();
  await atLogout;
  await assert.rejects(() => s.flow.start(ORG), /pending/);
  unblock(); await loggingOut;
  await assert.rejects(() => s.flow.start(ORG), /pending/);
  const state = new URL(s.urls[0]).searchParams.get('state');
  await s.flow.receive(LOGOUT_CALLBACK + '?state=' + state);
  await s.flow.start(ORG);
  await s.flow.cancel();
});
test('cleanup refusal cannot be reported as successful cancellation', async t => {
  const p = await fixture(); t.after(() => p.close());
  let localDrop = 0;
  const s = setup(p, { mail: { cleanup: async () => { throw Error('offline'); }, dropLocal: async ({ mailbox }) => { assert.equal(mailbox, false); localDrop++; } } });
  await s.flow.start(ORG); await s.flow.receive(p.response(s.urls[0]));
  assert.equal(await s.flow.cancel(), false);
  assert.equal(localDrop, 1);
  assert.equal(s.states.at(-1).phase, 'error');
  assert.match(s.states.at(-1).message, /cleanup could not be confirmed/);
});
test('logout failure clears local cookies, reloads renderer and reports unconfirmed server retirement', async t => {
  const p = await fixture(); t.after(() => p.close());
  let localDrop = 0;
  const s = setup(p, { mail: { logout: async () => { throw Error('offline'); }, dropLocal: async ({ mailbox }) => { assert.equal(mailbox, true); localDrop++; } }, flow: { clientLoader: async () => { throw Error('provider offline'); } } });
  await s.flow.logout();
  assert.equal(localDrop, 1);
  assert.equal(s.completed(), 1);
  assert.match(s.states.at(-1).message, /credentials were cleared.*server logout was not confirmed.*central logout is unavailable/);
});
test('actual token endpoint rejects a wrong PKCE verifier before Mail exchange', async t => {
  const p = await fixture(); t.after(() => p.close());
  const s = setup(p, { flow: { clientLoader: async () => ({ ...p.client, authorizationCodeGrant: (config, url, checks) => p.client.authorizationCodeGrant(config, url, { ...checks, pkceCodeVerifier: p.client.randomPKCECodeVerifier() }) }) } });
  await s.flow.start(ORG);
  await s.flow.receive(p.response(s.urls[0]));
  assert.equal(s.flow.pending, null);
  assert.deepEqual(s.calls, []);
  assert.equal(s.states.at(-1).phase, 'error');
});
