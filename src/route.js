'use strict';

// openRoute navigates inside the page. If that script ever fails, the old
// fallback was loadURL, which reloads the whole webmail and drops anything in
// flight (a message in its undo-send window, an open composer). Reload only
// when the window is not on the webmail at all (offline page, blank page);
// when it is, a failed in-page navigation is left alone rather than destroyed.
function shouldReloadAfterFailedNavigation(currentUrl, appOrigin) {
  try {
    return new URL(currentUrl).origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

// The webmail's hash grammar (webmail/src/mail/mail-url.ts): #<view>[/<uid>][?params],
// where a folder path is ONE form-urlencoded segment and "search", "label" and
// "folder" are reserved first segments (a folder with one of those names is
// written "folder/<name>"). Mirrored here so the app can address a folder or a
// conversation without asking the page.
const RESERVED_VIEWS = new Set(['search', 'label', 'folder']);

function encodeSeg(raw) {
  return encodeURIComponent(String(raw)).replace(/\+/g, '%2B').replace(/%20/g, '+');
}

function folderView(folder) {
  const enc = encodeSeg(folder);
  return RESERVED_VIEWS.has(enc) ? `folder/${enc}` : enc;
}

// '#INBOX/4211' for uid 4211 in INBOX. null for anything that is not a folder
// plus a positive integer uid.
function conversationHash(folder, uid) {
  if (typeof folder !== 'string' || !folder || folder.length > 500) return null;
  const n = Number(uid);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return `#${folderView(folder)}/${n}`;
}

// The webmail tags each new-mail notification 'mail-<folder>-<uid>'
// (desktop-notify.ts). The folder may itself contain '-', the uid never does.
function parseMailTag(tag) {
  const m = /^mail-(.+)-(\d+)$/.exec(typeof tag === 'string' ? tag : '');
  if (!m) return null;
  const hash = conversationHash(m[1], m[2]);
  return hash ? { folder: m[1], uid: Number(m[2]), hash } : null;
}

// A same-origin URL the webmail asked to open in a new window (its own "Open in
// new window" action). Only a conversation route qualifies: '/#<view>/<uid>',
// optionally with ?mid=. Anything else (compose prefill, settings, a search)
// is not opened in an app window. Returns the canonical in-app route or null.
function conversationRouteFromUrl(url, appOrigin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== new URL(appOrigin).origin || u.pathname !== '/') return null;
  const m = /^#((?:folder\/)?[^/?#]+)\/(\d+)(\?mid=[^&#]*)?$/.exec(u.hash);
  if (!m || m[2].length > 15) return null;
  return `/#${m[1]}/${m[2]}${m[3] || ''}`;
}

module.exports = { shouldReloadAfterFailedNavigation, encodeSeg, folderView, conversationHash, parseMailTag, conversationRouteFromUrl };
