# Taifa Mail desktop

A thin Electron shell around the Taifa Mail webmail at
[mail.govconnect.ke](https://mail.govconnect.ke). It gives the webmail a real
app window, a tray icon and automatic updates. That is the whole job.

## Why it is thin

The webmail talks to its backend over same-origin relative API paths and
authenticates with HttpOnly cookies. A window that loads the remote origin
directly therefore inherits auth, CSRF and WebSocket connections for free, with
no token plumbing and no second auth path to keep in step with the web app. The
alternative (bundling the frontend and pointing it at a remote API) would turn
every request cross-origin and mean rebuilding all of that by hand. So the shell
stays a shell: ship the window, let the web app be the web app.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts Electron with `--dev`. Set `TAIFA_APP_ORIGIN` to point the
window at a different deployment, for example staging or a local dev server:

```bash
TAIFA_APP_ORIGIN=https://staging.mail.govconnect.ke npm run dev
TAIFA_APP_ORIGIN=http://localhost:5173 npm run dev
```

It defaults to `https://mail.govconnect.ke`.

## Building

```bash
make dist     # builds installers into release/, publishes nothing
make pack     # unpacked build, faster, for a quick local check
```

## Releasing

Add an entry to the top of `changelog.json`, then `make release`. See
[RELEASING.md](RELEASING.md) for the full flow, the one-time signing secrets,
and the load-bearing build settings that must not be tidied away.
