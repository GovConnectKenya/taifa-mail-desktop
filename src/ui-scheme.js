'use strict';

// taifa-ui://app/<page>: how the app's own local UI pages (the tray popover and
// the offline page) are loaded.
//
// Why not file://. The GrantFileProtocolExtraPrivileges fuse is off (see
// scripts/after-pack.js), which is the safe setting: a file:// page then gets
// no more privilege than a web page. The catch is that Electron's ability to
// read a page out of app.asar through file:// is part of those extra
// privileges, so with the fuse off, loadFile() on a packaged app fails with
// ERR_FILE_NOT_FOUND even though the file is in the archive. Loading through a
// small app scheme served by the main process (which reads app.asar fine)
// keeps the fuse off and gives the pages a clean, non-file origin.
//
// The scheme is deliberately narrow: it serves an exact allowlist of fixed files
// (the pages and the About window's logo, icons and fonts), nothing else, and carries only the 'standard' and 'secure' privileges
// (no fetch, no CORS, no CSP bypass, no service workers).

const fs = require('fs');
const path = require('path');

const SCHEME = 'taifa-ui';
const HOST = 'app';

// Request path (no leading slash) -> file under src/. Exact matches only, so a
// request can never name anything else, and there is no path to traverse.
const PAGES = Object.freeze({
  'tray/popover.html': 'tray/popover.html',
  'shell/offline.html': 'shell/offline.html',
  // The About window (src/about): one page plus its logo, icons and fonts.
  'about/about.html': 'about/about.html',
  'about/logo.svg': 'about/logo.svg',
  'about/logo-white.svg': 'about/logo-white.svg',
  'about/icons/refresh.svg': 'about/icons/refresh.svg',
  'about/icons/close.svg': 'about/icons/close.svg',
  'about/icons/tick.svg': 'about/icons/tick.svg',
  'about/icons/danger.svg': 'about/icons/danger.svg',
  'about/icons/chevron-left.svg': 'about/icons/chevron-left.svg',
  'about/fonts/GoogleSans-Regular.woff2': 'about/fonts/GoogleSans-Regular.woff2',
  'about/fonts/GoogleSans-Medium.woff2': 'about/fonts/GoogleSans-Medium.woff2',
  'about/fonts/GoogleSans-SemiBold.woff2': 'about/fonts/GoogleSans-SemiBold.woff2',
  'about/fonts/JetBrainsMono-Regular.woff2': 'about/fonts/JetBrainsMono-Regular.woff2',
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function contentType(file) {
  return TYPES[path.extname(file)] || 'application/octet-stream';
}

function uiUrl(page) {
  if (!Object.prototype.hasOwnProperty.call(PAGES, page)) throw new Error(`unknown ui page: ${page}`);
  return `${SCHEME}://${HOST}/${page}`;
}

// Maps a request URL to an absolute file path under `root`, or null when the
// URL is not exactly one of our pages. Pure: no electron, no disk access.
function resolveUiRequest(requestUrl, root) {
  let u;
  try {
    u = new URL(requestUrl);
  } catch (_) {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.hostname !== HOST || u.port || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  const key = u.pathname.replace(/^\//, '');
  if (!Object.prototype.hasOwnProperty.call(PAGES, key)) return null;
  return path.join(root, PAGES[key]);
}

// Must run before app 'ready'.
function registerUiScheme() {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

// Serves the pages on one session. Call once per session that hosts a UI page.
function installUiScheme(ses, root) {
  ses.protocol.handle(SCHEME, async (req) => {
    const file = resolveUiRequest(req.url, root);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': contentType(file), 'cache-control': 'no-store' },
      });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { contentType, SCHEME, HOST, PAGES, uiUrl, resolveUiRequest, registerUiScheme, installUiScheme };
