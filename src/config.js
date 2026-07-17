'use strict';

// Origin policy for the thin shell.
//
// This app is a BrowserWindow pointed at the live webmail, not a local bundle,
// so we attach a preload to code we do not control at runtime. The security
// model is NOT "mail.govconnect.ke is trusted". It is that a compromise of the
// web app, or of its npm tree, must not become native code execution. This
// module is where the boundary is declared; security.js enforces it.

// Overridable so the shell can be pointed at a dev server or staging without
// editing source. Production builds never set it. A trailing slash would make
// every origin comparison below fail (URL.origin never has one), so it is
// normalised away here at the edge rather than at each call site.
const APP_ORIGIN = (process.env.TAIFA_APP_ORIGIN || 'https://mail.govconnect.ke').replace(/\/+$/, '');
const APP_URL = APP_ORIGIN + '/';

// The mailbox host only, deliberately NOT the apex govconnect.ke.
//
// Two reasons, and the second is the load-bearing one. First, this shell is the
// mailbox client and nothing else: the dashboard is a different app that has no
// business inheriting our preload. Second, the mailbox session is host-only
// anyway. The backend's _set_mailbox_cookies (backend/app/api/auth.py) sets no
// `domain` on tfm_mb_access / tfm_mb_refresh, deliberately, so the session never
// leaks to or from the apex. Allowing govconnect.ke here would widen the shell
// to pages that cannot even use the cookies we are hosting, in exchange for
// handing them a native bridge.
const ALLOWED_NAV_ORIGINS = new Set([APP_ORIGIN]);

// Deny-by-default allowlist. Anything absent is denied, which means a permission
// Chromium adds in a future Electron bump is denied on arrival instead of being
// inherited silently. Keep this list to what the webmail actually uses.
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
]);

// Schemes we are willing to hand to shell.openExternal, i.e. to the OS.
//
// mailto: is here on purpose. CommandPalette.svelte:96 in the webmail does
// window.open('mailto:support@govconnect.ke', '_self'). That is not a
// navigation we can service in-window, so if mailto never reaches
// shell.openExternal the "Contact support" button is simply dead in the desktop
// app while it works fine in the browser.
//
// Note what is NOT here: file:, smb:, and arbitrary custom schemes. Handing
// those to shell.openExternal is an RCE vector, since the OS resolves them to a
// local handler (a file, a mounted share, some other app's URL handler) chosen
// by whoever wrote the link. On the mail path that is any stranger who can send
// our users an email, so this is an allowlist, never a denylist.
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

// URLs arrive from the network and from email bodies, so they are attacker
// controlled and frequently not URLs at all. Anything that fails to parse gets
// no benefit of the doubt.
function isAllowedNav(url) {
  try {
    return ALLOWED_NAV_ORIGINS.has(new URL(url).origin);
  } catch (_) {
    return false;
  }
}

function isExternallyOpenable(url) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

module.exports = {
  APP_ORIGIN,
  APP_URL,
  ALLOWED_NAV_ORIGINS,
  ALLOWED_PERMISSIONS,
  isAllowedNav,
  isExternallyOpenable,
};
