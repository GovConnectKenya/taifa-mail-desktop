'use strict';
const { httpsOrigin, UUID } = require('./workforce-policy');
class MailBridge {
  constructor(session, origin) {
    this.session = session;
    this.origin = httpsOrigin(origin).origin;
  }
  async request(path, body, signal) {
    if (!['/auth/csrf', '/auth/logout', '/auth/mailbox/logout', '/api/workforce/native/exchange', '/api/workforce/native/mailboxes', '/api/workforce/native/mailbox'].includes(path)) throw Error('Unsupported Mail operation');
    const headers = { Accept: 'application/json', Origin: this.origin };
    if (body !== undefined) {
      let cookies = await this.session.cookies.get({ url: this.origin + '/', name: 'tfm_csrf' });
      if (!cookies.length) {
        await this.request('/auth/csrf', undefined, signal);
        cookies = await this.session.cookies.get({ url: this.origin + '/', name: 'tfm_csrf' });
      }
      if (cookies.length !== 1 || !cookies[0].value) throw Error('Mail CSRF unavailable');
      headers['X-CSRF-Token'] = cookies[0].value;
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.session.fetch(this.origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers, credentials: 'include', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error('Mail operation unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw Error('Invalid Mail response');
    const decoder = new TextDecoder();
    let raw = '', bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw Error('Invalid Mail response'); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    return JSON.parse(raw);
  }
  async exchange(accessToken, orgId, signal) {
    const result = await this.request('/api/workforce/native/exchange', { access_token: accessToken, mail_org_id: orgId }, signal);
    if (result.org_id !== orgId) throw Error('Mail organization mismatch');
  }
  async mailboxes(orgId, signal) {
    const result = await this.request('/api/workforce/native/mailboxes', undefined, signal);
    const rows = Array.isArray(result) ? result : result.mailboxes;
    if (!Array.isArray(rows) || rows.length > 500) throw Error('Invalid assigned mailboxes');
    const ids = new Set();
    return rows.map(row => {
      if (!UUID.test(row.id || '') || row.org_id !== orgId || typeof row.address !== 'string' || row.address.length > 320 || ids.has(row.id)) throw Error('Invalid assigned mailbox');
      ids.add(row.id);
      return { id: row.id, address: row.address };
    });
  }
  async select(id, orgId, signal) {
    const row = await this.request('/api/workforce/native/mailbox', { mailbox_id: id }, signal);
    if (row.id !== id || row.org_id !== orgId) throw Error('Mail selection mismatch');
  }
  async dropLocal({ mailbox = false } = {}) {
    const rows = await this.session.cookies.get({ url: this.origin + '/' });
    for (const row of rows) {
      if (['tfm_access_token', 'tfm_refresh_token'].includes(row.name) || (mailbox && (['tfm_mb_access', 'tfm_mb_refresh', 'tfm_mb_2fa'].includes(row.name) || row.name.startsWith('tfm_mb_acct_')))) {
        await this.session.cookies.remove(this.origin + (row.path || '/'), row.name);
      }
    }
    await this.session.cookies.flushStore();
  }
  cleanup() { return this.request('/auth/logout', {}); }
  logout() { return this.request('/auth/mailbox/logout', {}); }
}
module.exports = { MailBridge };
