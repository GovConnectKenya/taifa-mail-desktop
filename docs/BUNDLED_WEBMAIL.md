# The bundled webmail (0.2.0 and later)

Taifa Mail desktop used to be a thin shell: a window that loaded
https://mail.govconnect.ke over the network. From 0.2.0 the app's UI is the
Taifa Mail webmail itself, built from the taifa-mail repo and packaged inside
the app. A fix to the webmail reaches the desktop app by rebuilding the app.

This page records the design, why it was chosen over the plan on the
`native-rebuild` branch (NATIVE_REBUILD_PLAN.md), and its security properties.

## Pieces

| Where | What |
|---|---|
| taifa-mail `webmail/svelte.config.desktop.js`, `webmail/vite.config.desktop.ts`, `webmail/scripts/build-desktop.mjs` | A second, static build of the unchanged webmail: the same routes, components, CSP directives and fonts, written to `webmail/.desktop/build` as an SPA (`index.html` fallback, `_app/`, static files, the app-shell fonts). The browser build does not read these files. |
| this repo `scripts/stage-webmail.mjs` | Copies that build into `renderer/` (git-ignored), or builds it first with `--build`. `npm run dist` runs it, and fails if there is no bundle. |
| `src/bundle.js` | Serves `renderer/` for the webmail origin from inside the app. |
| `src/main.js`, `src/security.js`, `src/config.js` | Window, menus, tray, badge, mailto, theme, navigation lock. |

## How a request flows

The window loads `https://mail.govconnect.ke/`. In the app's own session
(`persist:taifamail`, never the default session) `src/bundle.js` registers a
handler for `https` with `session.protocol.handle`:

- **Page and asset paths on mail.govconnect.ke** (`/`, `/login`, `/settings`,
  `/_app/...`, `/fonts/...`) are answered from `renderer/`, from memory after
  the first read. Unknown app routes get `index.html`, the SPA shell. Nothing
  goes to the network before first paint.
- **Backend paths** (the prefixes nginx routes to the API on that host: `/v1`,
  `/t`, `/auth`, `/oauth`, `/unsubscribe`, `/health`) and **every other host**
  are handed back to Chromium's own network stack with
  `ses.fetch(request, { bypassCustomProtocolHandlers: true })`. That is the same
  stack the window would have used: this session's cookie jar is attached and
  updated, connections are pooled and kept alive, compression is negotiated,
  and bodies stream in both directions.
- **The websocket** (`wss://mail.govconnect.ke/ws/mailbox`) is not an https
  request, so the handler never sees it. Chromium opens it directly to the
  backend with the real Origin and this session's cookies.

The backend therefore sees exactly what a browser on mail.govconnect.ke sends:
the real Host, the real Origin, its own SameSite=Lax cookies, and the
double-submit `tfm_csrf` cookie echoed in `X-CSRF-Token` by the webmail's JS.
**Zero backend changes and zero changes to existing webmail code.**

## Why not `app://taifa` (the earlier plan)

The earlier plan served the bundle from a privileged custom scheme,
`app://taifa`, and proxied the API from the main process. Before building it,
both of its load-bearing assumptions were tested in Electron 45 (throwaway
probe, results below), and both fail:

| Test | `app://taifa` | real origin, intercepted (chosen) |
|---|---|---|
| Set-Cookie on a response from the handler is stored | no, jar stayed empty | yes, `tfm_csrf` stored for `.govconnect.ke` |
| Page JS can read `tfm_csrf` (double-submit CSRF) | no, `document.cookie` empty | yes |
| Websocket from `location.host` (`/ws/mailbox`) | `ws://taifa/ws/mailbox`: unresolvable; a webRequest redirect to a relay never fired, socket closed 1006 | goes natively to `wss://mail.govconnect.ke/ws/mailbox` with Origin `https://mail.govconnect.ke` and the jar's cookies |

Making `app://taifa` work would have needed a second, hand-maintained cookie
mirror for the CSRF cookie and a loopback websocket relay holding the session,
plus Host and Origin rewriting on everything. Serving the bundle for the real
origin needs none of it.

A localhost reverse proxy (`http://127.0.0.1:<port>`) was also considered: it
works for cookies and websockets, but it opens a TCP port that every local
process can reach, needs Host checks against DNS rebinding and a per-launch
secret, changes the storage origin (so existing users would be signed out and
lose their preferences), and depends on a stable port to keep localStorage.

Two further benefits of the real origin:

- **Existing users keep their session.** 0.1.x already used
  `persist:taifamail` on `https://mail.govconnect.ke`, so cookies, localStorage
  and preferences carry over when 0.2.0 auto-updates in.
- **Same CSP, same security headers.** The page's policy is the web build's own
  CSP (emitted by the desktop build as a `<meta>` tag with a hash for its single
  inline bootstrap script); `frame-ancestors 'none'` is added as a header, as on
  the web host.

## Security properties

- **No new network surface.** No TCP port, no proxy process, no relay. The only
  interception is inside the app's own session.
- **The handler never touches credentials.** It does not read, log, copy or
  rewrite cookies, tokens or bodies; Chromium attaches the jar to pass-through
  requests exactly as it would for a browser tab. `TAIFA_NET_LOG=1` logs
  method, path, status and timing only (and, for the websocket, cookie NAMES
  only, never values).
- **Cookies stay app-private and persistent**, in the `persist:taifamail`
  partition under the app's userData folder, as in 0.1.x.
- **The CSRF cookie stays readable by the webmail JS**, as on the web, because
  it is a normal cookie for the page's real origin.
- **Path containment.** Static files resolve strictly inside `renderer/`; any
  path that normalises outside it is refused.
- **Navigation lock is unchanged.** The only navigable origin is
  `https://mail.govconnect.ke`; anything else (a top-level navigation, a
  redirect, `window.open`, a link in an email) is denied in the app and handed
  to the OS browser through the existing scheme allowlist (https, http, mailto).
- **No bridge on the webmail page.** The preload still exposes nothing to it.
  Notifications use the standard Web Notification API (Electron implements it
  natively); the unread badge is read from the document title the webmail
  already sets. Neither needs IPC.
- **The service worker is not served** (`/sw.js` returns 404). On the web it
  caches the shell for flaky networks and prompts a reload after a deploy; in
  the app the shell is local and changes only with an app update, so a worker
  would only add a stale second copy.
- **What a compromised bundle could do** is what a compromised webmail can do
  in a browser: the renderer is sandboxed, context-isolated, without Node, and
  without a bridge. The trust boundary is the same as the thin shell's.

## Same pages as the browser

The app appends `TaifaMailApp/<version>` to the user agent, deliberately not the
0.1.x token `TaifaMailDesktop`. The webmail treats `TaifaMailDesktop` as "the old
thin shell" (`isDesktopShell()`): it hides the passkey button and its "or"
divider, hides the workspace-account link, and switches new-mail notifications
on by default. Those branches were written for 0.1.x on Electron 31. With the
new token the webmail takes exactly its browser code paths, so every auth and
onboarding page is the web page. Checked pixel for pixel against a browser build
of the same commit (/login, the sign-in code screen, /mailbox-2fa) and against
the live site for the routes reachable signed out.

Consequence: new-mail notifications follow the web flow. The webmail's own
prompt or the Settings toggle turns them on; the app grants the permission
without a second OS prompt.

## Desktop integration

- macOS title bar: `hiddenInset`, traffic lights at x 18, y 22 (as in Spaci).
  A user stylesheet injected by main makes the webmail's 60px top bar
  (`.tm-shell-topbar`) the drag handle and insets it past the traffic lights;
  its controls stay clickable. Pages without that bar (sign-in) get a 28px drag
  strip that takes no clicks. The browser build never gets this CSS.
- Windows: the native frame, themed through `nativeTheme` to match the webmail
  theme. A title bar overlay was not used: its caption buttons would sit on top
  of the webmail's right-hand toolbar, which has no room reserved for them.
- No white flash: the window background is the webmail's `--color-bg`
  (`#f5f8f6` light, `#101010` dark), chosen from the webmail's own
  `taifa-mail-theme` cookie before the window is created, and it follows later
  changes of that cookie and, for "system", of the OS.
- Menus: App (About, Settings Cmd+, , Make Default Email App, Check for
  Updates), File (New Message Cmd/Ctrl+N, Inbox Cmd/Ctrl+Shift+I), Edit, View,
  Window, Help. Menu, tray and mailto routes are opened through the webmail's
  own router (a synthetic link click), so there is no reload.
- mailto: registered for the app (`build.protocols`), handled on macOS through
  `open-url` and on Windows and Linux through the second-instance arguments,
  translated by `src/mailto.js` into the webmail's own compose route
  (`#INBOX?compose=new&to=..&subject=..`). The app never makes itself the
  default mail app on its own; a menu item lets the user choose to.
- Badge: dock count on macOS, an overlay dot on the Windows taskbar button, the
  launcher count on Linux, all from the `(n)` the webmail puts in its title.
- Startup: tray, popover and the updater start only after the window is shown.

## Known limits

- Passkeys: the button is shown exactly as on the web. On macOS, Electron 45
  exposes the WebAuthn API but has no authenticator UI: the platform
  authenticator reports unavailable and a request never answers (measured: still
  pending after 7s with a 5s timeout), so passkey sign-in does not complete on
  macOS. On Windows, Chromium uses the native Windows Hello API; not yet tested
  on a Windows machine. Password and emailed sign-in codes work everywhere.
- "Sign in with SSO" leaves the app for the identity provider (the navigation
  lock sends it to the browser), so SSO sign-in completes in the browser, not in
  the app. Unchanged from 0.1.x.
- Offline: the shell paints with no network, but mail needs the backend; the
  webmail shows its own connection state. Offline reading is a later phase.
