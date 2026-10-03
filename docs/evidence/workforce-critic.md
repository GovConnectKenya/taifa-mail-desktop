# Desktop workforce security critic

Reviewed 2026-10-02 in the isolated `taifa-mail-desktop-identity` candidate. This independent review made no product or test edits. The implementation owner fixed the findings below; independent retests passed. No open high or medium finding remains in the reviewed desktop paths.

## Scope and boundaries

Reviewed `src/main.js`, `src/security.js`, `src/workforce-policy.js`, `src/workforce-flow.js`, `src/workforce-mail.js`, `src/workforce-window.js`, `src/workforce-preload.js`, and the bundled selector. Reviewed the existing protocol and Electron tests, then wrote separate probes under `/tmp/desktop-workforce-critic`.

The probes use a synthetic HTTPS Mail service and the real RSA-signed OIDC HTTPS fixture. Electron tests use the actual Electron 44.5.1 runtime, cookie store, native `session.fetch`, bundled sandboxed preload, and installed workforce IPC handlers. Only the generated test certificate is trusted, scoped to the test session. OIDC fixture transport and browser opening are injected at the test boundary. Production source has no certificate bypass.

These results do not establish live operator Keycloak registration, MFA policy enforcement, production audience mappers, central backchannel delivery, or production Mail server revocation. Those require the separate provider and backend evidence. Server revocation remains explicitly unconfirmed during an outage. Force-killing the process cannot guarantee asynchronous cleanup.

## Findings and independent closure

### Medium: overlapping logout could admit a subsequent native sign-in

Before the fix, delay local mailbox logout, start a new native flow while logout is awaiting its response, then release logout. The pending sign-in remained live. Its real RSA callback and explicit mailbox selection completed after local logout, producing two completion events. The independent reproduction and output are `overlap.cjs` and `overlap.json` in the scratch evidence directory.

The owner added a synchronous logout fence and rejects new starts while either local logout or the central logout transaction is pending. `overlap-fixed.cjs` passed: overlapping start rejected, aborted login callback rejected, forged logout callback rejected, and a new start allowed only after the matching central logout callback. No post-logout sign-in completed.

### Medium: uncertain handoff cancellation retained usable local mailbox credentials

Before the fix, an actual Electron selection request received HttpOnly mailbox access and refresh cookies, then its response remained incomplete. Both cleanup endpoints returned 503. Cancel through the actual bundled preload and installed IPC handler reported `idle`, with “Sign-in cancelled. You can start again.” The mailbox cookies remained in the actual Electron jar and the next synthetic cookie-authenticated request returned 200. `cancel-electron.cjs` and `cancel-electron.json` contain the independent reproduction and evidence.

The owner added local account and mailbox cookie removal, persisted the removal, refreshed the Mail window after an uncertain handoff, and preserved the cleanup warning through Cancel IPC and timeout. `cancel-electron-fixed.cjs` passed: the state remained `error` with the unconfirmed cleanup warning, only the CSRF cookie remained, and the next cookie-authenticated request returned 401.

`logout-electron-fixed.cjs` additionally passed explicit logout with server 503 and seeded account, mailbox, mailbox second-factor, and saved-account cookies. All relevant local credentials were removed; the next authenticated request returned 401. A forged central logout callback was rejected. The matching callback retained the warning that Mail server logout was not confirmed.

### Quit cleanup follow-up

The earlier `before-quit` handler launched cancellation without awaiting it. The owner now prevents Quit, waits for pending cancellation with a 20-second bound, then retries Quit with a completion fence. Repeated Quit requests cannot bypass the pending cleanup. Browser launching is bounded at five seconds.

`quit-handler.cjs` evaluates the exact final `main.js` handler in an independent Node VM. It passed deferred cleanup, repeated Quit, completion retry, and the explicit 20-second timeout. This is handler-level evidence, not a claim that force-kill or operating-system termination completes cleanup.

## Guard verification

`security-electron.cjs` passed in actual Electron:

- The actual installed `state`, `start`, `select`, `cancel`, and `logout` IPC handlers rejected a second WebContents even when it loaded the exact selector file and preload.
- Remote HTTPS content had neither `window.workforce` nor `require`.
- A trusted main-window, main-frame, exact same-origin start navigation entered the native flow with the selected UUID and reauthentication flag.
- A same-origin child frame initiating top-level navigation did not enter the native flow.
- A foreign popup was denied, sent to the external browser boundary, and did not enter the native flow.

Source and cryptographic tests also verify exact custom-scheme callback paths, bounded unique callback parameters, state comparison, PKCE S256, nonce, verified ID-token signature, issuer and client audience, actual recent `auth_time`, approved ACR, single callback redemption, and explicit assignment selection. Access tokens go only to the fixed Mail exchange endpoint and are cleared from the token response in `finally`. They are not passed to the selector or written to a persistence API. Mail requests use the fixed HTTPS origin, current CSRF cookie, fixed Origin header, rejected redirects, bounded responses, and exact returned organization and mailbox IDs.

## Final verification

From the desktop candidate directory:

```sh
npm test
npm run test:electron
```

Independent final rerun: 27 Node tests passed, zero failed. Actual Electron smoke passed, including cookie handoff, sandbox and bridge checks, and cleanup-503 credential removal followed by HTTP 401.

Separate independent commands:

```sh
node /tmp/desktop-workforce-critic/overlap-fixed.cjs
node /tmp/desktop-workforce-critic/quit-handler.cjs
node_modules/.bin/electron /tmp/desktop-workforce-critic/security-electron.cjs
node_modules/.bin/electron /tmp/desktop-workforce-critic/cancel-electron-fixed.cjs
node_modules/.bin/electron /tmp/desktop-workforce-critic/logout-electron-fixed.cjs
```

All passed. Logs and observed results are under `/tmp/desktop-workforce-critic`: `node-final.log`, `electron-final.log`, `overlap-fixed.json`, `quit-handler.json`, `security-electron.json`, `cancel-electron-fixed.json`, and `logout-electron-fixed.json`. Expected untrusted IPC rejection messages in the guard log are the tested denial behavior.
