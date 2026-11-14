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
const { net } = require('electron');
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

// Request headers the network stack owns or this module sets itself. Cookie in
// particular: the session's jar attaches the right cookies for the target, so
// a Cookie header from the renderer would only duplicate or contradict them.
const SKIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'cookie', 'origin', 'referer',
  'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer',
  'proxy-connection', 'proxy-authorization',
]);
// Set-Cookie is applied to the jar by the network stack as the response
// arrives; handing it to the renderer as well would apply it twice.
const SKIP_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// Called once with the response headers of a backend request; see installBundle.
let onBackendHeaders = null;

// Forwards one request to the real network, through this session's network
// stack, and answers in the shape the renderer would have seen from the network
// itself. net.request rather than ses.fetch for one reason: redirects. ses.fetch
// follows them inside the main process, so the renderer (and with it
// will-redirect and the navigation lock) would never see a redirect, and a
// redirect to another site would come back as that site's content under the
// webmail's origin. Here every 3xx goes back to the renderer as a 3xx, and
// Chromium follows it as it would for any page.
function passThrough(ses, req) {
  const started = NET_LOG ? Date.now() : 0;
  const url = new URL(req.url);
  return new Promise((resolve, reject) => {
    // The page's own credentials and cache modes cannot be honoured: the
    // Request a protocol handler receives always reports credentials
    // 'same-origin', cache 'default' and mode 'cors', whatever the page asked
    // for (measured on Electron 45). So, as the earlier ses.fetch path did,
    // every request goes with the session's cookies: each host only ever gets
    // its own cookies, under the jar's normal SameSite rules.
    const options = {
      method: req.method,
      url: req.url,
      session: ses,
      // useSessionCookies rather than credentials: 'include'. Both send the
      // jar's cookies; only this one also stores a Set-Cookie that arrives on
      // a redirect (measured).
      useSessionCookies: true,
      redirect: 'manual',
      // Into the real network, not back into this handler.
      bypassCustomProtocolHandlers: true,
    };
    const origin = req.headers.get('origin');
    if (origin) options.origin = origin;

    let rq;
    try {
      rq = net.request(options);
    } catch (e) {
      reject(e);
      return;
    }
    for (const [name, value] of req.headers) {
      if (SKIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      try {
        rq.setHeader(name, value);
      } catch (_) {
        // A header the network stack refuses to take from us is one it sets.
      }
    }

    rq.on('redirect', (status, _method, location, headers) => {
      // Cookies on the redirect itself are already in the jar.
      rq.abort();
      const out = new Headers();
      for (const [name, values] of Object.entries(headers || {})) {
        if (SKIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        for (const v of [].concat(values)) out.append(name, v);
      }
      out.set('location', location);
      if (NET_LOG) console.log(`[net] ${req.method} ${url.host}${url.pathname} -> ${status} redirect ${Date.now() - started}ms`);
      resolve(new Response(null, { status, headers: out }));
    });

    rq.on('response', (res) => {
      const out = new Headers();
      for (const [name, values] of Object.entries(res.headers)) {
        if (SKIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        for (const v of [].concat(values)) out.append(name, v);
      }
      if (onBackendHeaders && url.origin === APP_ORIGIN) onBackendHeaders(url.pathname, out);
      if (NET_LOG) console.log(`[net] ${req.method} ${url.host}${url.pathname} -> ${res.statusCode} ${Date.now() - started}ms`);
      if (NULL_BODY_STATUS.has(res.statusCode) || req.method === 'HEAD') {
        res.resume();
        resolve(new Response(null, { status: res.statusCode, statusText: res.statusMessage, headers: out }));
        return;
      }
      // Stream the body through with backpressure: large downloads are never
      // held in memory.
      const body = new ReadableStream({
        start(controller) {
          res.on('data', (chunk) => {
            controller.enqueue(new Uint8Array(chunk));
            if (controller.desiredSize <= 0) res.pause();
          });
          res.on('end', () => controller.close());
          res.on('error', (e) => controller.error(e));
          res.on('aborted', () => controller.error(new Error('aborted')));
        },
        pull() {
          res.resume();
        },
        cancel() {
          rq.abort();
        },
      }, { highWaterMark: 4 });
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage, headers: out }));
    });

    rq.on('error', (e) => {
      if (NET_LOG) console.log(`[net] ${req.method} ${url.host}${url.pathname} -> error ${e.message}`);
      reject(e);
    });

    // The request body, if any, is sent whole with its exact Content-Length.
    // Streaming it chunked would save memory on large attachments, but object
    // stores reject a chunked PUT to a presigned URL, so length wins.
    (async () => {
      if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
        for await (const chunk of req.body) rq.write(Buffer.from(chunk));
      }
      rq.end();
    })().catch((e) => {
      rq.abort();
      reject(e);
    });
  });
}

// Installs the handler on the app's session. Returns false (and installs
// nothing) when no bundle is packaged, so a plain `npm start` in a fresh clone
// still runs, as the thin shell it used to be, against the live site.
// opts.onTooOld: called (once) when the backend reports that this bundled
// webmail is older than it supports. The backend says so with the response
// header X-Taifa-Min-Desktop-Bundle on /health or /v1 responses: the ISO 8601
// commit date of the oldest webmail build it accepts. Not sent by the backend
// yet (docs/BUNDLED_WEBMAIL.md, follow-ups); this side is ready for it.
function installBundle(ses, opts = {}) {
  if (!hasBundle()) return false;

  const info = bundleInfo();
  const bundleDate = info && Date.parse(info.commitDate);
  let tooOldReported = false;
  onBackendHeaders = (pathname, headers) => {
    if (tooOldReported || typeof opts.onTooOld !== 'function') return;
    if (pathname !== '/health' && !pathname.startsWith('/v1/')) return;
    const min = Date.parse(headers.get('x-taifa-min-desktop-bundle') || '');
    if (!Number.isFinite(min) || !Number.isFinite(bundleDate) || bundleDate >= min) return;
    tooOldReported = true;
    // Not from inside the request: let this response finish first.
    setImmediate(opts.onTooOld);
  };

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

// Removes the handler (the backend-skew fallback): every request then goes to
// the network, the window loads the live site.
function uninstallBundle(ses) {
  onBackendHeaders = null;
  try {
    ses.protocol.unhandle('https');
  } catch (_) {
    // Not installed: nothing to undo.
  }
}

module.exports = { installBundle, uninstallBundle, hasBundle, bundleInfo, RENDERER_DIR };
