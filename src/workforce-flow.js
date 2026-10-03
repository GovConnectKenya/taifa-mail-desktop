'use strict';
async function externalWithinDeadline(openExternal, url) {
  let timer;
  try {
    await Promise.race([openExternal(url), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser launch timed out')), 5000); })]);
  } finally { clearTimeout(timer); }
}
const { CALLBACK, LOGOUT_CALLBACK, CLIENT_ID, UUID, equal, callback, httpsOrigin } = require('./workforce-policy');
class WorkforceFlow {
  constructor({ issuer, mail, openExternal, notify, complete, clientLoader = () => import('openid-client'), clock = () => Date.now() }) {
    this.issuer = httpsOrigin(issuer).href;
    this.mail = mail;
    this.openExternal = openExternal;
    this.notify = notify;
    this.complete = complete;
    this.clientLoader = clientLoader;
    this.clock = clock;
    this.pending = null;
    this.job = Promise.resolve();
    this.logoutPending = null;
  }
  async configuration() {
    const oidc = await this.clientLoader();
    const config = await oidc.discovery(new URL(this.issuer), CLIENT_ID, undefined, oidc.None(), { timeout: 5 });
    oidc.enableNonRepudiationChecks(config);
    // Discovery cannot silently introduce an insecure endpoint.
    const metadata = config.serverMetadata();
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint']) {
      if (metadata[key]) httpsOrigin(metadata[key]);
    }
    return { oidc, config };
  }
  active(tx) {
    if (this.pending !== tx || tx.controller.signal.aborted || this.clock() >= tx.deadline) throw Error('Authentication expired');
  }
  async start(orgId, reauth = false) {
    if (this.starting || this.loggingOut || this.logoutPending) throw Error('Another authentication operation is pending');
    this.starting = true;
    try { return await this.begin(orgId, reauth); } finally { this.starting = false; }
  }
  async begin(orgId, reauth) {
    if (!UUID.test(orgId || '')) throw Error('Invalid organization');
    await this.cancel();
    const tx = { orgId, controller: new AbortController(), deadline: this.clock() + 300000, phase: 'starting', temporary: false, maxAge: reauth ? 0 : 300 };
    this.pending = tx;
    tx.timer = setTimeout(() => { void this.cancel().then(cleaned => { if (cleaned) this.notify({ phase: 'error', message: 'Sign-in timed out. Start again.' }); }); }, 300000);
    tx.timer.unref?.();
    this.notify({ phase: 'browser', message: 'Finish sign-in in your system browser.' });
    this.job = (async () => {
      Object.assign(tx, await this.configuration());
      this.active(tx);
      tx.verifier = tx.oidc.randomPKCECodeVerifier();
      tx.state = tx.oidc.randomState();
      tx.nonce = tx.oidc.randomNonce();
      const challenge = await tx.oidc.calculatePKCECodeChallenge(tx.verifier);
      this.active(tx);
      const url = tx.oidc.buildAuthorizationUrl(tx.config, {
        redirect_uri: CALLBACK, response_type: 'code', scope: 'openid workforce-login',
        code_challenge: challenge, code_challenge_method: 'S256', state: tx.state, nonce: tx.nonce,
        acr_values: 'taifa-phishing-resistant taifa-mfa', max_age: reauth ? '0' : '300',
      });
      tx.phase = 'browser';
      await externalWithinDeadline(this.openExternal, url.href);
      this.active(tx);
    })();
    try { await this.job; } catch { await this.fail(tx); }
  }
  async receive(raw) {
    let parsed;
    try { parsed = callback(raw); } catch { return false; }
    if (parsed.logout) {
      const tx = this.logoutPending;
      if (!tx || tx.deadline <= this.clock() || !equal(tx.state, parsed.state)) return false;
      clearTimeout(tx.timer);
      this.logoutPending = null;
      this.notify({ phase: 'done', message: tx.localConfirmed ? 'Mail is signed out. The central provider returned from logout.' : 'Local Mail credentials were cleared. Mail server logout was not confirmed. The central provider returned from logout.' });
      return true;
    }
    const tx = this.pending;
    if (!tx || tx.controller.signal.aborted || tx.phase !== 'browser' || !equal(tx.state, parsed.state) || this.clock() >= tx.deadline) return false;
    tx.phase = 'redeeming'; // Claim the callback before any asynchronous work.
    this.notify({ phase: 'working', message: 'Checking your assigned mailboxes.' });
    this.job = (async () => {
      const tokens = await tx.oidc.authorizationCodeGrant(tx.config, parsed.url, {
        pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, maxAge: tx.maxAge,
      });
      try {
        this.active(tx);
        const claims = tokens.claims();
        if (!claims || typeof claims.sub !== 'string' || !claims.sub || !['taifa-mfa', 'taifa-phishing-resistant'].includes(claims.acr)
          || !Number.isSafeInteger(claims.auth_time) || claims.auth_time > Math.floor(this.clock() / 1000)
          || Math.floor(this.clock() / 1000) - claims.auth_time > 300 || typeof tokens.access_token !== 'string') throw Error('Identity assurance unavailable');
        // Mark before sending: a lost response can still have established cookies.
        tx.temporary = true;
        await this.mail.exchange(tokens.access_token, tx.orgId, tx.controller.signal);
      } finally { tokens.access_token = undefined; tokens.id_token = undefined; tokens.refresh_token = undefined; }
      this.active(tx);
      tx.verifier = tx.nonce = tx.state = undefined;
      tx.rows = await this.mail.mailboxes(tx.orgId, tx.controller.signal);
      this.active(tx);
      tx.phase = 'selection';
      this.notify({ phase: 'selection', message: 'Choose an assigned mailbox.', mailboxes: tx.rows });
    })();
    try { await this.job; } catch { await this.fail(tx); }
    return true;
  }
  async select(id) {
    const tx = this.pending;
    if (!tx || tx.phase !== 'selection' || !tx.rows.some(row => row.id === id)) throw Error('Mailbox is not assigned');
    this.active(tx);
    tx.phase = 'selecting';
    tx.selectionAttempted = true;
    this.job = (async () => {
      await this.mail.select(id, tx.orgId, tx.controller.signal);
      this.active(tx);
      tx.temporary = false;
      this.clear(tx);
      this.notify({ phase: 'done', message: 'Mailbox signed in.' });
      this.complete();
    })();
    try { await this.job; } catch { await this.fail(tx); }
  }
  clear(tx) {
    clearTimeout(tx.timer);
    tx.controller.abort();
    tx.verifier = tx.nonce = tx.state = tx.rows = tx.config = tx.oidc = undefined;
    if (this.pending === tx) this.pending = null;
  }
  async fail(tx) {
    if (tx.cleaning) return tx.cleaning;
    if (this.pending !== tx) return true;
    tx.cleaning = this.cleanupFailed(tx);
    return tx.cleaning;
  }
  async cleanupFailed(tx) {
    tx.controller.abort();
    let cleaned = true;
    // An explicit selection can transfer cookies before its response is lost.
    // End the current mailbox too, rather than retain an uncertain transfer.
    if (tx.selectionAttempted) {
      try { await this.mail.logout(); } catch { cleaned = false; }
    }
    if (tx.temporary) {
      try { await this.mail.cleanup(); } catch { cleaned = false; }
    }
    if (tx.temporary || tx.selectionAttempted) {
      try { await this.mail.dropLocal({ mailbox: !!tx.selectionAttempted }); } catch { cleaned = false; }
      if (tx.selectionAttempted) this.complete();
    }
    this.clear(tx);
    this.notify({ phase: 'error', message: cleaned ? 'Sign-in unavailable. Start again.' : 'Sign-in failed. Mail session cleanup could not be confirmed. Retry when online.' });
    return cleaned;
  }
  async cancel() {
    const tx = this.pending;
    if (!tx) return true;
    tx.controller.abort();
    await this.job.catch(() => {});
    return this.fail(tx);
  }
  async logout() {
    if (this.loggingOut) throw Error('Logout is already pending');
    this.loggingOut = true;
    try { return await this.performLogout(); } finally { this.loggingOut = false; }
  }
  async performLogout() {
    await this.cancel();
    clearTimeout(this.logoutPending?.timer);
    this.logoutPending = null;
    let localConfirmed = true;
    try { await this.mail.logout(); } catch { localConfirmed = false; }
    await this.mail.dropLocal({ mailbox: true });
    this.complete();
    this.notify({ phase: 'working', message: localConfirmed ? 'Mail is signed out. Opening central logout in your browser.' : 'Local Mail credentials were cleared. Mail server logout was not confirmed. Opening central logout.' });
    try {
      const { oidc, config } = await this.configuration();
      const tx = { state: oidc.randomState(), deadline: this.clock() + 300000, localConfirmed };
      this.logoutPending = tx;
      tx.timer = setTimeout(() => {
        if (this.logoutPending === tx) this.logoutPending = null;
        this.notify({ phase: 'error', message: localConfirmed ? 'Mail is signed out. Central logout was not confirmed.' : 'Local Mail credentials were cleared. Mail server and central logout were not confirmed.' });
      }, 300000);
      tx.timer.unref?.();
      await externalWithinDeadline(this.openExternal, oidc.buildEndSessionUrl(config, { client_id: CLIENT_ID, post_logout_redirect_uri: LOGOUT_CALLBACK, state: tx.state }).href);
    } catch {
      clearTimeout(this.logoutPending?.timer);
      this.logoutPending = null;
      this.notify({ phase: 'error', message: localConfirmed ? 'Mail is signed out. Central logout is unavailable.' : 'Local Mail credentials were cleared. Mail server logout was not confirmed and central logout is unavailable.' });
    }
  }
}
module.exports = { WorkforceFlow };
