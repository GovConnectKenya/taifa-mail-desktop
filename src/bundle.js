'use strict';

// Serves the bundled webmail for the real webmail origin.
//
// The window still loads https://mail.govconnect.ke, but in this app's session
// every https request is handled here first:
//
//   - page and asset paths on the webmail origin (/, /login, /_app/..., /fonts/...)
//     are answered from the webmail build packaged inside the app (renderer/).
//     No network round trip before first paint, and the UI is exactly the
//     webmail code: renderer/ is the output of the webmail's own desktop build
//     (taifa-mail: webmail/scripts/build-desktop.mjs).
//   - the backend paths (the same prefixes nginx sends to the API on
//     mail.govconnect.ke: /v1 /t /auth /oauth /unsubscribe /health) and every
//     other host are passed through Chromium's own network stack untouched.
//
// Why the real origin and not a custom app:// scheme (the earlier plan), in
// short; docs/BUNDLED_WEBMAIL.md has the long version and the probe results:
//   - Chromium does not store Set-Cookie from a custom-scheme response and
//     document.cookie stays empty there, so the double-submit CSRF cookie the
//     webmail reads (tfm_csrf) would never be visible to it.
//   - the webmail derives its websocket URL from location.host. Under app://taifa
//     that is ws://taifa/ws/mailbox, which no handler can serve.
// On the real origin both just work: cookies live in this partition's jar for
// .govconnect.ke exactly as in a browser, and the websocket (not https, so never
// intercepted) goes straight to the backend with the real Origin and cookies.
// The backend sees an ordinary first-party browser. Zero backend changes, and
// zero webmail changes.
//
// Nothing here reads, logs or rewrites cookies, tokens or bodies. TAIFA_NET_LOG=1
// logs method, path, status and timing only, for diagnosing the app.

const fs = require('fs');
const path = require('path');
const { APP_ORIGIN, isBackendPath } = require('./config');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const INDEX = path.join(RENDERER_DIR, 'index.html');
const NET_LOG = process.env.TAIFA_NET_LOG === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

// Paths the bundle deliberately does not serve, answered 404 instead.
//
// sw.js: the web build's service worker exists to cache the app shell for a
// flaky network and to prompt a reload after a deploy. In the app the shell is
// already local and only changes when the app itself updates, so a worker would
// add a second, stale copy of the shell and an update prompt that can never be
// acted on. Its registration fails quietly (.catch in +layout.svelte).
const NOT_SERVED = new Set(['/sw.js']);

// Every file is read once and kept: the whole bundle is a few MB and is read
// from the app's own asar, so the second launch of any route is memory-fast.
const fileCache = new Map();

function hasBundle() {
  if (process.env.TAIFA_BUNDLE === '0') return false;
  try {
    return fs.statSync(INDEX).isFile();
  } catch (_) {
    return false;
  }
}

function bundleInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RENDERER_DIR, 'desktop-bundle.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Map a URL path to a file inside renderer/, or null. Never escapes the folder:
// a ../ that survives normalisation is refused, not resolved.
function resolveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  const file = path.normalize(path.join(RENDERER_DIR, rel));
  if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch (_) {
    return null;
  }
}

function readCached(file) {
  let buf = fileCache.get(file);
  if (!buf) {
    buf = fs.readFileSync(file);
    fileCache.set(file, buf);
  }
  return buf;
}

function localResponse(file, pathname) {
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    // Hashed build output never changes under the same name; everything else
    // revalidates, mirroring how the web host serves them.
    'cache-control': pathname.startsWith('/_app/immutable/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  };
  if (ext === '.html') {
    // The page's full policy is the web build's own CSP, which the desktop build
    // emits as a <meta> tag with a hash for its one inline bootstrap script.
    // frame-ancestors cannot be set from a <meta> tag, so it is added here, as
    // the web host adds it as a header.
    headers['content-security-policy'] = "frame-ancestors 'none'";
    headers['referrer-policy'] = 'strict-origin-when-cross-origin';
  }
  return new Response(readCached(file), { status: 200, headers });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

async function passThrough(ses, req) {
  const started = NET_LOG ? Date.now() : 0;
  // bypassCustomProtocolHandlers sends it to the real network instead of back
  // into this handler. Chromium's network stack attaches and stores this
  // partition's cookies, keeps connections alive and streams the body.
  const res = await ses.fetch(req, { bypassCustomProtocolHandlers: true });
  if (NET_LOG) {
    const u = new URL(req.url);
    console.log(`[net] ${req.method} ${u.host}${u.pathname} -> ${res.status} ${Date.now() - started}ms`);
  }
  return res;
}

// Installs the handler on the app's session. Returns false (and installs
// nothing) when no bundle is packaged, so a plain `npm start` in a fresh clone
// still runs, as the thin shell it used to be, against the live site.
function installBundle(ses) {
  if (!hasBundle()) return false;

  if (NET_LOG) {
    // Websockets bypass the handler entirely; log their handshake outcome so a
    // dead realtime connection can be told apart from a refused one.
    const filter = { urls: ['wss://*/*'] };
    ses.webRequest.onSendHeaders(filter, (d) => {
      const h = Object.fromEntries(Object.entries(d.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]));
      const cookieNames = (h.cookie || '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
      console.log(`[net] websocket ${new URL(d.url).host}${new URL(d.url).pathname} sent, origin ${h.origin}, cookies [${cookieNames.join(' ')}]`);
    });
    ses.webRequest.onHeadersReceived(filter, (d, cb) => {
      console.log(`[net] websocket ${new URL(d.url).pathname} handshake -> ${d.statusCode}`);
      cb({});
    });
    ses.webRequest.onErrorOccurred(filter, (d) => {
      console.log(`[net] websocket ${new URL(d.url).pathname} error ${d.error}`);
    });
  }

  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.origin !== APP_ORIGIN || isBackendPath(u.pathname)) return passThrough(ses, req);
    if (req.method !== 'GET' && req.method !== 'HEAD') return passThrough(ses, req);
    if (NOT_SERVED.has(u.pathname)) return notFound();

    const file = resolveFile(u.pathname);
    if (file) return localResponse(file, u.pathname);
    // A path with a file extension that is not in the bundle (a server-only
    // asset such as /.well-known/*) still comes from the web host. Anything else
    // is an app route (/login, /settings, /calendar/tasks): the SPA shell.
    if (path.extname(u.pathname)) return passThrough(ses, req);
    if (u.pathname.startsWith('/.well-known/')) return passThrough(ses, req);
    return localResponse(INDEX, '/index.html');
  });
  return true;
}

module.exports = { installBundle, hasBundle, bundleInfo, RENDERER_DIR };
