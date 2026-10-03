import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import flowModule from '../src/workforce-flow.js';
import policyModule from '../src/workforce-policy.js';
const { WorkforceFlow } = flowModule;
const { CALLBACK, LOGOUT_CALLBACK, CLIENT_ID } = policyModule;
const identity = process.env.IDENTITY_PROJECT_ROOT;
const { chromium } = await import(pathToFileURL(identity + '/apps/portal/node_modules/@playwright/test/index.mjs'));
const issuer = process.env.ACCEPTANCE_ISSUER;
const username = process.env.ACCEPTANCE_USERNAME;
const password = process.env.ACCEPTANCE_PASSWORD;
const logoutPort = Number(process.env.ACCEPTANCE_BACKCHANNEL_PORT);
if (!issuer || !username || !password || !logoutPort) throw Error('Disposable configuration unavailable');
const callbacks = [];
const logoutEvents = [];
let browser, server;
const proofFile = process.env.DESKTOP_MAIL_PROOF_FILE;
function privateProof(path, payload) {
  if (!proofFile) return;
  writeFileSync(path, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}
async function waitMarker(suffix) {
  if (!proofFile) return;
  const deadline = Date.now() + 240000;
  while (!existsSync(proofFile + suffix) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert(existsSync(proofFile + suffix), 'Actual Mail interoperability marker unavailable');
}
const configuration = await oidc.discovery(new URL(issuer), CLIENT_ID, undefined, oidc.None(), { timeout: 5 });
oidc.enableNonRepudiationChecks(configuration);
const keys = createRemoteJWKSet(new URL(configuration.serverMetadata().jwks_uri));
function base32(raw) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0;
  const out = [];
  for (const ch of raw) { buffer = (buffer << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; out.push((buffer >>> bits) & 255); } }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = createHmac('sha1', base32(secret)).update(input).digest();
  const start = digest.at(-1) & 15;
  return String((digest.readUInt32BE(start) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function waitCallback() {
  const deadline = Date.now() + 30000;
  while (!callbacks.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(callbacks.length, 'No intercepted exact private callback');
  return callbacks.shift();
}
async function authorization(extra = {}) {
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(configuration, { redirect_uri: CALLBACK, response_type: 'code', scope: 'openid workforce-login', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, acr_values: 'taifa-mfa', max_age: '300', ...extra });
  return { url, verifier, state, nonce };
}
try {
  server = createServer({ key: readFileSync(process.env.ACCEPTANCE_TLS_KEY), cert: readFileSync(process.env.ACCEPTANCE_TLS_CERT) }, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/backchannel') { res.writeHead(404); res.end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 20000) throw Error('Large event'); }
      const token = new URLSearchParams(body).get('logout_token');
      const { payload } = await jwtVerify(token, keys, { issuer, audience: CLIENT_ID, algorithms: ['RS256'] });
      assert.equal(typeof payload.sid, 'string');
      assert.equal(typeof payload.jti, 'string');
      assert.equal(typeof payload.iat, 'number');
      assert.equal(payload.nonce, undefined);
      assert.equal(typeof payload.events?.['http://schemas.openid.net/event/backchannel-logout'], 'object');
      logoutEvents.push(payload);
      privateProof(proofFile + '.logout', { issuer, client_id: CLIENT_ID, logout_token: token, claims: payload });
      res.writeHead(200); res.end();
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise(resolve => server.listen(logoutPort, process.env.ACCEPTANCE_BACKCHANNEL_HOST || '127.0.0.1', resolve));
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // Prevent any OS handler invocation. A real provider still issues the exact
  // registered private URI; this harness captures its HTTPS redirect response.
  await context.route(issuer + '/**', async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers().location;
    if (location?.startsWith(CALLBACK + '?') || location?.startsWith(LOGOUT_CALLBACK + '?')) {
      callbacks.push(location);
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Disposable private callback captured. No tokens displayed.' });
    } else await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30000);
  const urls = [], updates = [];
  let accessClaims, idClaims, exchanges = 0, selected = 0, localLogout = 0;
  const ORG = 'abce1234-1234-4123-8123-123412341234';
  const ID = 'abce1234-1234-4123-8123-123412341235';
  // This sink verifies actual Mail-audience proof, but is explicitly not the
  // Mail backend. Separate actual Mail/PostgreSQL tests prove server admission.
  const mail = {
    async exchange(token, org) {
      assert.equal(org, ORG);
      const { payload } = await jwtVerify(token, keys, { issuer, audience: 'disposable-mail-api', algorithms: ['RS256'] });
      await assert.rejects(() => jwtVerify(token, keys, { issuer, audience: 'foreign-mail-api', algorithms: ['RS256'] }));
      assert.equal(payload.azp, CLIENT_ID);
      assert(payload.scope.split(' ').includes('workforce-login'));
      assert.equal(payload.acr, 'taifa-mfa');
      assert.equal(typeof payload.sid, 'string');
      assert.equal(typeof payload.sub, 'string');
      assert(Number.isSafeInteger(payload.auth_time));
      assert(Math.floor(Date.now() / 1000) - payload.auth_time <= 300);
      accessClaims = payload; exchanges++;
      if (exchanges === 1 && proofFile) {
        privateProof(proofFile, { issuer, client_id: CLIENT_ID, audience: 'disposable-mail-api', ca_file: process.env.ACCEPTANCE_TLS_CERT, access_token: token, claims: payload });
        console.log('Actual MFA proof delivered privately; waiting for real Mail admission');
        await waitMarker('.admitted');
      }
    },
    async mailboxes() { return [{ id: ID, address: 'assigned@example.test' }]; },
    async select(id) { assert.equal(id, ID); selected++; },
    async cleanup() {}, async dropLocal() {}, async logout() { localLogout++; },
  };
  const inspectedClient = { ...oidc, async authorizationCodeGrant(...args) {
    let tokens;
    try { tokens = await oidc.authorizationCodeGrant(...args); } catch (error) { console.log('Actual standard grant denied:', error.name, error.code || ''); throw error; }
    await assert.rejects(() => jwtVerify(tokens.id_token, keys, { issuer, audience: 'foreign-desktop', algorithms: ['RS256'] }));
    idClaims = tokens.claims();
    console.log('Actual signed ID claim policy:', JSON.stringify({ acr: idClaims.acr, auth_time_integer: Number.isSafeInteger(idClaims.auth_time), sid_present: typeof idClaims.sid === 'string', sub_present: typeof idClaims.sub === 'string', client_audience_exact: idClaims.aud === CLIENT_ID }));
    return tokens;
  } };
  const flow = new WorkforceFlow({ issuer, mail, openExternal: async url => urls.push(url), notify: update => updates.push(update), complete: () => {}, clientLoader: async () => inspectedClient });
  console.log('Provider browser ready; enrolling OTP and proving real password-token denial');
  if (proofFile) assert(!existsSync(proofFile) && !existsSync(proofFile + '.admitted') && !existsSync(proofFile + '.logout') && !existsSync(proofFile + '.retired'), 'Stale interoperability artifacts must be removed by their owner');
  await flow.start(ORG);
  const enrollmentUrl = new URL(urls[0]);
  assert.equal(enrollmentUrl.searchParams.get('acr_values'), 'taifa-phishing-resistant taifa-mfa');
  // Simulate lowering the authorization request before the real provider
  // authenticates. A valid signed password-only ID token must still be denied
  // by the unchanged desktop consumer. All PKCE/nonce/state pins stay intact.
  enrollmentUrl.searchParams.set('acr_values', 'taifa-password');
  await page.goto(enrollmentUrl.href);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.locator('#mode-manual').waitFor({ timeout: 20000 });
  await page.locator('#mode-manual').click();
  const secret = (await page.locator('#kc-totp-secret-key').textContent()).replaceAll(/[^A-Z2-7]/gi, '').toUpperCase();
  assert.match(secret, /^[A-Z2-7]{16,80}$/);
  const label = page.locator('input[name="userLabel"]');
  if (await label.count()) await label.fill('Disposable desktop proof');
  let lastCounter = Math.floor(Date.now() / 30000);
  await page.locator('input[name="totp"]').fill(totp(secret));
  await page.locator('#saveTOTPBtn').click();
  let callback = await waitCallback();
  console.log('Provider returned exact callback:', new URL(callback).searchParams.has('code') ? 'authorization code' : 'protocol error');
  const wrongStateCallback = new URL(callback);
  wrongStateCallback.searchParams.set('state', 'wrong');
  assert.equal(await flow.receive(wrongStateCallback.href), false);
  assert.equal(exchanges, 0);
  assert.equal(await flow.receive(callback), true);
  // The deliberately lowered request attained level1. Merely displaying
  // OTP enrollment must not override the actual signed password assurance.
  assert.equal(idClaims.acr, 'taifa-password');
  assert.equal(flow.pending, null);
  assert.equal(exchanges, 0, 'OTP enrollment must not be represented as MFA');
  console.log('Actual lowered password-only request was denied despite OTP enrollment; performing genuine MFA');
  await flow.start(ORG, true);
  await page.goto(urls.at(-1));
  console.log('Actual reauthentication surface:', JSON.stringify({ path: new URL(page.url()).pathname, password_present: await page.locator('#password').count(), otp_present: await page.locator('#otp').count(), intercepted_callbacks: callbacks.length }));
  await page.locator('#password, #otp').first().waitFor({ timeout: 20000 });
  if (await page.locator('#password').isVisible()) {
    if (await page.locator('#username').count() && await page.locator('#username').isEditable()) await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
  } else {
    // A genuine recently attained level1 may be reused by the provider's
    // conditional flow. Level2 still requires an actual OTP execution.
    assert(Math.floor(Date.now() / 1000) - idClaims.auth_time <= 300);
  }
  await page.locator('#otp').waitFor({ timeout: 20000 });
  assert.equal(callbacks.length, 0, 'Password alone cannot attain MFA');
  while (Math.floor(Date.now() / 30000) === lastCounter) await new Promise(resolve => setTimeout(resolve, 200));
  lastCounter = Math.floor(Date.now() / 30000);
  await page.locator('#otp').fill(totp(secret));
  await page.locator('#kc-login').click();
  callback = await waitCallback();
  assert.equal(await flow.receive(callback), true);
  assert.equal(flow.pending?.phase, 'selection');
  assert.equal(exchanges, 1);
  assert.equal(selected, 0);
  assert.equal(idClaims.acr, 'taifa-mfa');
  assert.equal(idClaims.sid, accessClaims.sid);
  assert.equal(idClaims.sub, accessClaims.sub);
  assert.equal(idClaims.iss, issuer);
  assert.equal(idClaims.aud, CLIENT_ID);
  assert(Number.isSafeInteger(idClaims.auth_time));
  await flow.select(ID);
  assert.equal(selected, 1);
  assert.equal(flow.pending, null);
  assert.equal(await flow.receive(callback), false);

  console.log('Actual initial MFA admission passed; testing nonce and PKCE denial');
  const wrongNonce = await authorization();
  await page.goto(wrongNonce.url.href);
  const invalidNonceCallback = new URL(await waitCallback());
  await assert.rejects(() => oidc.authorizationCodeGrant(configuration, invalidNonceCallback, { pkceCodeVerifier: wrongNonce.verifier, expectedState: wrongNonce.state, expectedNonce: 'wrong-nonce', maxAge: 300 }));
  const wrongPKCE = await authorization();
  await page.goto(wrongPKCE.url.href);
  const invalidVerifierCallback = new URL(await waitCallback());
  await assert.rejects(() => oidc.authorizationCodeGrant(configuration, invalidVerifierCallback, { pkceCodeVerifier: oidc.randomPKCECodeVerifier(), expectedState: wrongPKCE.state, expectedNonce: wrongPKCE.nonce, maxAge: 300 }), error => error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant');

  console.log('Actual MFA and protocol negatives passed; testing provider and signed backchannel logout');
  await flow.logout();
  assert.equal(localLogout, 1);
  await page.goto(urls.at(-1));
  const confirm = page.getByRole('button', { name: /sign\s*out|log\s*out/i });
  console.log('Actual provider logout confirmation controls:', await confirm.count());
  if (await confirm.count()) await confirm.first().click();
  const logoutCallback = await waitCallback();
  assert.equal(await flow.receive(logoutCallback), true);
  const deadline = Date.now() + 20000;
  while (!logoutEvents.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert(logoutEvents.length, 'Real signed desktop backchannel logout was not delivered');
  assert.equal(logoutEvents[0].sid, accessClaims.sid);
  await waitMarker('.retired');
  const afterLogout = await authorization({ prompt: 'none' });
  await page.goto(afterLogout.url.href);
  assert.equal(new URL(await waitCallback()).searchParams.get('error'), 'login_required');
  // OIDC auth_time has whole-second precision. A max_age=0 request in the
  // same second legitimately reuses a just-attained session. Advance beyond
  // that signed timestamp before testing forced recent authentication.
  while (Math.floor(Date.now() / 1000) <= idClaims.auth_time + 1) await new Promise(resolve => setTimeout(resolve, 100));
  console.log('Provider negatives passed; requiring recent actual MFA and an OTP execution');
  await flow.start(ORG, true);
  await page.goto(urls.at(-1));
  console.log('Actual reauthentication surface:', JSON.stringify({ path: new URL(page.url()).pathname, password_present: await page.locator('#password').count(), otp_present: await page.locator('#otp').count(), intercepted_callbacks: callbacks.length }));
  await page.locator('#password, #otp').first().waitFor({ timeout: 20000 });
  if (await page.locator('#password').isVisible()) {
    if (await page.locator('#username').count() && await page.locator('#username').isEditable()) await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
  } else {
    // A genuine recently attained level1 may be reused by the provider's
    // conditional flow. Level2 still requires an actual OTP execution.
    assert(Math.floor(Date.now() / 1000) - idClaims.auth_time <= 300);
  }
  await page.locator('#otp').waitFor({ timeout: 20000 });
  assert.equal(callbacks.length, 0, 'Password alone cannot finish requested MFA');
  const valid = new Set([-2, -1, 0, 1, 2].map(offset => totp(secret, offset)));
  let invalid = '000000'; while (valid.has(invalid)) invalid = String(Number(invalid) + 1).padStart(6, '0');
  await page.locator('#otp').fill(invalid);
  await page.locator('#kc-login').click();
  await page.locator('#input-error-otp, #input-error-otp-code, .kc-feedback-text').filter({ hasText: /Invalid authenticator code/ }).first().waitFor({ timeout: 20000 });
  assert.equal(callbacks.length, 0);
  while (Math.floor(Date.now() / 30000) === lastCounter) await new Promise(resolve => setTimeout(resolve, 200));
  lastCounter = Math.floor(Date.now() / 30000);
  await page.locator('#otp').fill(totp(secret));
  await page.locator('#kc-login').click();
  await flow.receive(await waitCallback());
  assert.equal(flow.pending?.phase, 'selection');
  assert.equal(exchanges, 2);
  assert.equal(idClaims.acr, 'taifa-mfa');
  await flow.select(ID);

  console.log('PASS real Keycloak26.8 reviewed native registration, actual password+TOTP/LoA MFA, desktop PKCE/state/nonce/issuer/client+Mail audiences, wrong nonce/state/verifier/audience denial, recent MFA, main proof lifecycle, provider logout and signed desktop backchannel. Private URI redirect captured; actual OS callback dispatch and signed device builds remain separate gates.');
  if (proofFile) console.log('PASS coordinated actual Mail/PostgreSQL admission and signed provider backchannel retirement markers. Electron/runtime and actual OS dispatch are separately evidenced.');
} catch (error) {
  console.error('FAIL real desktop provider acceptance:', error.name);
  console.error('Source call sites:', error.stack?.split('\n').filter(row => /^\s+at /.test(row)).slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
}
