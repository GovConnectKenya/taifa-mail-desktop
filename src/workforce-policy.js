'use strict';
const { timingSafeEqual } = require('node:crypto');
const CALLBACK = 'ke.govconnect.taifamail.auth:/oauth2redirect';
const LOGOUT_CALLBACK = 'ke.govconnect.taifamail.auth:/logout';
const CLIENT_ID = 'taifa-mail-desktop';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function callback(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('#')) throw Error('Invalid callback');
  const u = new URL(raw);
  const base = raw.split('?')[0];
  if (![CALLBACK, LOGOUT_CALLBACK].includes(base) || u.hash || u.host || u.username || u.password) throw Error('Invalid callback');
  const allowed = base === CALLBACK ? ['code', 'state', 'error', 'error_description', 'iss', 'session_state'] : ['state'];
  for (const k of u.searchParams.keys()) {
    if (!allowed.includes(k) || u.searchParams.getAll(k).length !== 1) throw Error('Invalid callback');
  }
  if (!u.searchParams.get('state') || (base === CALLBACK && (!!u.searchParams.get('code') === !!u.searchParams.get('error')))) throw Error('Invalid callback');
  return { url: u, logout: base === LOGOUT_CALLBACK, state: u.searchParams.get('state') };
}
function startNavigation(raw, origin) {
  try {
    const u = new URL(raw);
    if (u.origin !== origin || u.pathname !== '/auth/workforce/start') return null;
    if (u.hash || u.username || u.password || !UUID.test(u.searchParams.get('org_id') || '')) return null;
    for (const k of u.searchParams.keys()) {
      if (!['org_id', 'reauth', 'next'].includes(k) || u.searchParams.getAll(k).length !== 1) return null;
    }
    const next = u.searchParams.get('next');
    if (next && (!next.startsWith('/') || next.startsWith('//') || /[\\\r\n]/.test(next))) return null;
    const reauth = u.searchParams.get('reauth');
    if (reauth && !['true', 'false'].includes(reauth)) return null;
    return { orgId: u.searchParams.get('org_id'), reauth: reauth === 'true' };
  } catch { return null; }
}
function trustedStart(wc, event, raw, origin, mainContents) {
  if (wc !== mainContents || event.isMainFrame !== true || (event.initiator && event.initiator !== wc.mainFrame)) return null;
  try { if (new URL(wc.getURL()).origin !== origin) return null; } catch { return null; }
  return startNavigation(raw, origin);
}
function trustedSender(event, wc, fileUrl) {
  return !!wc && !wc.isDestroyed() && event.sender === wc && event.senderFrame === wc.mainFrame
    && event.senderFrame.url === fileUrl;
}
function httpsOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) throw Error('HTTPS configuration required');
  return u;
}
module.exports = { CALLBACK, LOGOUT_CALLBACK, CLIENT_ID, UUID, equal, callback, startNavigation, trustedStart, trustedSender, httpsOrigin };
