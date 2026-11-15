'use strict';

// What the link status bubble shows for a hovered URL (page-shim.js draws it).
// Pure, and the URL is attacker controlled (it comes from email HTML), so it is
// only ever split into text parts here, never markup.
//
// - Links into the app itself (its own routes) show nothing: that is the app
//   navigating, not a destination worth checking.
// - http(s): the scheme, then the host in bold (as the URL parser normalises
//   it: an internationalised look-alike shows as xn--...), then the rest.
// - mailto: the address.
// - anything else (javascript:, data:, blob:) shows nothing.

function linkStatusParts(url, appOrigin) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol === 'mailto:') {
    let addr = u.pathname;
    try {
      addr = decodeURIComponent(addr);
    } catch (_) { /* keep it encoded */ }
    return addr ? { pre: 'Email ', host: addr.slice(0, 200), rest: '' } : null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  try {
    if (appOrigin && u.origin === new URL(appOrigin).origin) return null;
  } catch (_) { /* no app origin */ }
  const pre = u.protocol === 'http:' ? 'http://' : 'https://';
  const auth = u.username ? `${u.username}${u.password ? ':•••' : ''}@` : '';
  let rest = `${u.port ? `:${u.port}` : ''}${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`;
  try {
    rest = decodeURI(rest);
  } catch (_) { /* keep it encoded */ }
  return { pre: pre + auth, host: u.hostname, rest: rest.slice(0, 400) };
}

module.exports = { linkStatusParts };
