# Desktop workforce candidate validation

Candidate worktree: `/Users/user/projects/rcfi/taifa-mail-desktop-identity`.
Branch: `codex/desktop-workforce`, based on committed `3d1c0fc`.
The original `taifa-mail-desktop` native rebuild edits were preserved.
No production deployment, signed release, or OS handler registration was claimed.

## Observed local checks

- `npm test`: 28 passed, zero failed or skipped. Latest local run completed in
  2.87 seconds. Real RSA ID tokens and HTTPS, signed issuer/client audience,
  nonce/state/PKCE, approved actual MFA/recency, one-use callback, bounded paths,
  mailbox/org response validation, precise IPC authority, cancellation races,
  logout ordering and local credential clearing are covered.
- `npm run test:electron`: passed in actual Electron 44.5.1. It performed real
  RSA OIDC and HTTPS native handoff through Electron's cookie jar, explicit
  mailbox selection, HttpOnly cookie transfer, correct CSRF, local sandboxed
  selector and remote-page bridge absence. A transferred-cookie response followed
  by cleanup HTTP503 cleared local account/mailbox credentials, reloaded the
  renderer, preserved the unconfirmed-revocation warning and yielded HTTP401 on
  the next cookie-authenticated request. Mail in this harness is a test server,
  so this is runtime/protocol seam proof, not actual Mail backend admission.
- `npm audit --json`: zero vulnerabilities after pinning Electron44.5.1,
  electron-builder26.15.3, its required Windows packaging peer,
  openid-client6.8.8 and compatible transitive patches.
  The inherited dependency tree initially reported11high and1critical findings.
- `npm run pack -- --mac --arm64 -c.mac.identity=null -c.mac.notarize=false`:
  passed. The unpacked app's Info.plist declared the exact
  `ke.govconnect.taifamail.auth` URL scheme. This build was unsigned and not
  notarized. It does not prove installed OS callback delivery. The generated
  unpacked directory was removed during the disk-space incident after preserving
  build and protocol evidence. Product source was not removed.
- `git diff --check`: passed.

Evidence artifacts: `/tmp/desktop-workforce-node-tests.log`,
`/tmp/desktop-workforce-electron.log`, `/tmp/desktop-workforce-pack.log`,
`/tmp/desktop-workforce-pack-protocols.log`,
`/tmp/desktop-workforce-npm-audit-final.json`.

## Independent review

The existing Sign/Mail reviewer independently reproduced and verified the fixes
for overlapping logout/sign-in and failed cancellation cleanup. Its actual
Electron IPC cancellation and explicit offline-logout probes observed removed
credentials, denied subsequent cookie-authenticated requests and retained server
revocation warnings. It also verified normal Quit cleanup ordering and its bound.
See [the independent critic](workforce-critic.md) for separate evidence and limits.

## Real Keycloak driver and remaining gates

`scripts/keycloak-acceptance.py` launches only disposable generated PostgreSQL and
Keycloak26.8 resources. It uses the reviewed Identity native client registration
helper and actual Admin REST, genuine password plus required TOTP/conditional-LoA
flows, real signed client/Mail audiences, negative state/nonce/verifier/audience
checks, provider logout and signed backchannel receipt. Its companion standard
openid-client/Chrome driver captures the exact private callback from the
provider's HTTPS redirect to avoid altering OS handler registrations. The proof
sink verifies actual signed Mail-audience tokens but is not the Mail backend.

This driver is syntax checked but has no successful real-provider result yet.
The first run blocked at Docker network creation, while Docker's control API
also timed out on a bounded server-version read. Only this task's blocked runner
and network-create child were stopped. Docker was not restarted and unrelated
containers were untouched. Potential queued disposable resources use only the
`taifa-desktop-acceptance-*` prefix and need cleanup after the daemon recovers.

Release gates remain actual approved provider flow/registration and runtime
proof, actual Mail/PostgreSQL admission with those provider tokens, installed
system-browser callback delivery on each platform, signed/notarized installers,
provider outages, MFA/passkey behavior, lifecycle departure and server-side
session revocation. Production mandatory-SSO policy remains one-way during
rollback, with no local password fallback for managed staff.
