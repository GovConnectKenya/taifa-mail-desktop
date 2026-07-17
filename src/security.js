'use strict';
const { shell } = require('electron');
const { APP_ORIGIN, ALLOWED_PERMISSIONS, isAllowedNav, isExternallyOpenable } = require('./config');

// Hands a URL to the OS, but only if config vouches for the scheme. Every
// openExternal in this app goes through here: shell.openExternal on an
// unfiltered, attacker-supplied URL is the classic Electron RCE.
function openExternally(url) {
  if (!isExternallyOpenable(url)) return;
  shell.openExternal(url).catch(() => { /* the OS had no handler; nothing to do */ });
}

// ---------- per-WebContents hardening ----------
function harden(wc) {
  // A same-origin navigation keeps our preload, so anything leaving the webmail
  // origin must never load in this window: it would inherit the bridge. Send it
  // to the real browser instead, where it gets an address bar and no preload.
  const guardNav = (e, url) => {
    if (isAllowedNav(url)) return;
    e.preventDefault();
    openExternally(url);
  };
  wc.on('will-navigate', guardNav);
  // will-redirect matters as much as will-navigate, and is easy to forget: a 302
  // to an off-origin host does not fire will-navigate, so guarding only the
  // latter leaves the door open to any redirector.
  wc.on('will-redirect', guardNav);

  wc.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    // ALWAYS deny. Never 'allow', under any circumstance.
    //
    // This handler sits on a path an attacker controls by merely sending our
    // user an email: MailReader renders email HTML in an iframe with
    // sandbox="allow-same-origin allow-popups" and injects <base target="_blank">,
    // so every link in every received message arrives here with a URL the sender
    // chose. Returning 'allow' would open a chromeless Electron window carrying
    // our preload and webPreferences, at that URL, with no address bar for the
    // user to check. Those links reach the real browser or they go nowhere.
    return { action: 'deny' };
  });

  // Belt and braces: webviewTag is already false in webPreferences, so no
  // <webview> should ever get this far. If one ever does (a webPreferences
  // regression, a future Electron default flip), it must not attach: a <webview>
  // is a fresh renderer whose preferences the page's own markup gets to specify.
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

// ---------- per-Session handlers ----------
function installSessionHandlers(ses) {
  // BOTH permission handlers are required, and they are not redundant.
  // Notification.requestPermission() (the async prompt) routes through the
  // REQUEST handler, while Notification.permission (the sync getter) routes
  // through the CHECK handler. Implement only one and the other silently reports
  // 'denied', which would break notifications in Phase 2 in a way that reads as a
  // webmail bug rather than a shell bug.
  //
  // Both are deny-by-default via the ALLOWED_PERMISSIONS allowlist, so any
  // permission Chromium adds in a future Electron bump is denied automatically
  // rather than inherited.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    // The requesting frame is not always the top-level document (email bodies
    // render in an iframe), so prefer the URL Electron attributes the request to
    // and fall back to the WebContents URL only when it gives us nothing.
    const url = details?.requestingUrl || wc.getURL();
    if (!isAllowedNav(url)) return callback(false);
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    requestingOrigin === APP_ORIGIN && ALLOWED_PERMISSIONS.has(permission));

  // No HID, USB, or serial. A mail client has no business enumerating hardware,
  // and this one line keeps a compromised page from trying.
  //
  // It also blocks hardware security keys over HID. That is moot today because
  // Electron does not implement WebAuthn at all, so passkeys do not work in the
  // shell either way. Revisit if that changes.
  ses.setDevicePermissionHandler(() => false);
}

module.exports = { harden, installSessionHandlers };
