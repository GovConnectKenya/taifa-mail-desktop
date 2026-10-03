# Taifa Mail Desktop — Native Client Rebuild (Phase N1)

Status: N1 in progress. Decided 2026-07-21.

## What changed and why

The app was a **thin shell**: a `BrowserWindow` that did `win.loadURL('https://mail.govconnect.ke')`.
We are moving to a **native client**: the SvelteKit webmail is built to a static SPA, bundled
into the app, and served locally under a custom `app://taifa` scheme. A main-process reverse
proxy forwards the app's API/WS traffic to the real backend so the renderer still behaves as if
it were same-origin.

This was validated by a five-agent design pass. All five converged on the same architecture.

### The architecture (locked)

| Layer | Decision |
|---|---|
| Renderer | Build webmail to a **static SPA** (`adapter-static`, `csr` only, SPA fallback). The webmail has zero `*.server.ts` and zero `load` functions, so this is clean — no route rewrites. |
| Origin | Serve the bundle under a custom **`app://taifa`** privileged scheme (`protocol.registerSchemeAsPrivileged` + `protocol.handle`). NOT `http://localhost` — a custom scheme has no TCP port, which closes the DNS-rebinding / local-process attack vector. |
| Transport | **Main-process reverse proxy**: intercept `/v1`, `/auth`, `/oauth`, `/ws` and forward to `https://mail.govconnect.ke`, rewriting upstream `Host` and `Origin` to the real webmail origin. Cookies live in the Electron session jar. |

**Consequences that make this safe:**
- **Zero backend changes.** The backend sees a first-party request (real Host/Origin), so its
  `SameSite=lax` cookies + double-submit CSRF + `cors_origins` allowlist all pass unchanged.
  Browser webmail users are completely unaffected.
- **Zero renderer API changes.** `API_URL=''`, `credentials:'include'`, the `tfm_csrf` echo, and
  the `window.location.host`-derived WS URL all keep working against the `app://taifa` origin,
  because the proxy re-anchors them to the real backend.

### Decisions
- **First native release = N1 only** (native shell + proxy, online-only mail). Offline is N2.
- **Login = password + "email me a sign-in code" only.** Passkeys are unreliable in Electron
  (no WebAuthn UI; electron/electron#24573) and the `app://` origin can't bind RP-id
  `govconnect.ke` anyway. Passkeys are omitted/best-effort in the app; both other paths work
  through the proxy.

## N1 workstreams

N1 is **two coherent workstreams**, not a wide fan-out (the main-process files are tightly
coupled; the wide parallel push belongs to N2's per-endpoint cache paths).

### WS-1 — Webmail static desktop build (in the taifa-mail repo, ISOLATED)
A concurrent session is actively editing the webmail tree. This workstream must touch
**net-new files only** — do NOT edit existing webmail source.
- Add `webmail/svelte.config.desktop.js` using `@sveltejs/adapter-static` with
  `{ fallback: 'index.html', pages: 'build-desktop', assets: 'build-desktop', precompress: false }`
  and `csr` on / `ssr` off via a `+layout.ts` **only if one does not already exist** — if it would
  collide, prefer a build-time flag. Keep `paths` relative (`paths: { relative: true }`) so assets
  resolve under `app://taifa`.
- Add an npm script (e.g. `build:desktop`) that runs `vite build` against the desktop config.
  Reuse the existing symlink handling (`webmail/src/lib -> ../../frontend/src/lib`,
  `preserveSymlinks: true`).
- The output is a fully static folder (`webmail/build-desktop/`) with an `index.html` SPA fallback.
- Verify it builds and that `index.html` + `_app/` assets are emitted with relative URLs.
- Fonts: do NOT vendor fonts in N1 (that would edit `app.html`). The desktop CSP will allow
  `fonts.googleapis.com`/`fonts.gstatic.com` instead. Vendoring is an N2 nicety.

### WS-2 — Desktop native layer (in the taifa-mail-desktop repo)
All of these are interdependent (they share `main.js`, `config.js`, `security.js`, `preload.js`),
so they are authored as one coherent change:
- **Scheme registration + static serving** (`src/protocol.js` new): register `app://taifa` as
  privileged (`standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
  stream: true`) BEFORE `app.whenReady()`; `protocol.handle('app', ...)` serves files from the
  bundled renderer dir with correct MIME + SPA fallback to `index.html` for unknown non-asset paths.
- **Reverse proxy** (`src/proxy.js` new): intercept requests to `/v1`, `/auth`, `/oauth`, `/ws`
  from the `app://taifa` renderer and forward to `https://mail.govconnect.ke`. Rewrite `Host` and
  `Origin` headers to `mail.govconnect.ke`. Persist/relay cookies via the partition session jar.
  Forward the WebSocket upgrade for `/ws/mailbox` (and `/ws/emails`). Do NOT log cookie values.
  Implement interception via `session.protocol`/`webRequest` on the `persist:taifamail` partition,
  or a `protocol.handle` for the app-origin fetch that streams from the upstream.
- **Security** (`src/security.js`, `src/config.js`): split the allowlist into
  **navigable origin** (`app://taifa` only) vs **connectable origin** (`https://mail.govconnect.ke`
  + `wss://mail.govconnect.ke`). Inject a CSP for the local origin via `onHeadersReceived`
  (`default-src 'self' app:`; `connect-src app: https://mail.govconnect.ke wss://mail.govconnect.ke`;
  `style-src`/`font-src` allow `fonts.googleapis.com`/`fonts.gstatic.com`; keep `frame-src`/sandbox
  for the mail-body iframe). Keep `will-navigate`/`setWindowOpenHandler` routing external links to
  the OS browser. `webPreferences`: `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  `webviewTag:false`, `partition:'persist:taifamail'`, `backgroundThrottling:false`.
- **Preload gate** (`src/preload.js`): the bridge was gated on `location.protocol === 'file:'`
  for the offline/popover pages. The main window is now `app://taifa`. Keep the offline/popover
  bridge as-is (still `file:`), and ensure the **remote-equivalent bundled renderer at
  `app://taifa` gets NO bridge** (same posture as the old remote origin — expose nothing).
- **Window load** (`src/main.js`): replace `win.loadURL(APP_URL)` with
  `win.loadURL('app://taifa/index.html')` (or the SPA root). Keep offline-page handling: real
  transport failures of the *proxy* (not the app shell) still show `offline.html`.
- **Packaging** (`package.json`): add the bundled renderer dir to `build.files`
  (e.g. `"renderer/**/*"`); the CI must build WS-1's static bundle and copy it to
  `taifa-mail-desktop/renderer/` before `electron-builder`. `renderer/` is gitignored.
  Keep the mac `zip` target (electron-updater needs it). No native modules in N1 → no
  `electron-rebuild`, signing/notarization unchanged.
- **CI** (`.github/workflows/release.yml`): add a step to check out the taifa-mail repo, run
  WS-1's `build:desktop`, and stage the output into `renderer/` before packaging. Everything else
  (matrix, signing env scoped to mac, `--publish never` + explicit upload) stays.

## Verification (N1)
Requires a GUI (native window) — needs the user at the machine or a computer-use session.
1. App launches, loads the bundled SPA instantly from `app://taifa` (no remote white-flash).
2. Login with password AND with "email me a sign-in code" — both succeed through the proxy.
3. Inbox loads, open a message, compose + send, mark read/flag/move/delete — all work
   (proves the proxy carries cookies + CSRF + the WS echoes).
4. New-mail realtime: the `/ws/mailbox` push still fires (proves WS upgrade forwarding).
5. External link in a received email opens in the OS browser, not in-app.
6. Kill the network: real proxy failure shows `offline.html`; recovers on restore.
7. Quit + relaunch: still logged in (proves the partition cookie jar persists).
8. `svelte-check` + `vite build` clean for the desktop config; `npx electron-builder --publish never`
   produces installers locally.

## N2 (next) — offline read
`better-sqlite3` store in main; proxy answers `/v1/inbox/*` reads from cache when offline,
write-through when online; WS mirror in main; windowed envelope sync + body prefetch for recent
INBOX. Read-only offline. This is where native-module CI/signing complexity lands and where the
wide agent fan-out (per-endpoint cache paths, per-WS-event handlers, schema, sync) pays off.
Optional cheap backend adds: `uidvalidity` + envelope `message_id` + bulk-body + delta/since.

## N3 — fast-follow
Offline mutations via a `pending_op` queue; outbox compose/send with idempotency key; local FTS.
