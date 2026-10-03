# Desktop workforce candidate validation

Candidate worktree: `/Users/user/projects/rcfi/taifa-mail-desktop-identity`.
Branch: `codex/desktop-workforce`, based on committed `3d1c0fc`.
The original `taifa-mail-desktop` native rebuild edits were preserved.
No production deployment, signed release, or OS handler registration was claimed.

## Observed local checks

- `npm test`: 29 passed, zero failed or skipped. Latest local run completed in
  2.36 seconds. Real RSA ID tokens and HTTPS, signed issuer/client audience,
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
- Full production builder26 configuration schema validation passed, including
  the boolean notarization policy and retained updater/signing requirements.
  Actual Linux CI also passed the Electron runtime test with the SUID sandbox
  configured. Earlier failed CI runs exposed and corrected portable lock peer
  resolution and the legacy builder24 notarization configuration type.
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

## Actual official Keycloak and Mail interoperability

The complete coordinated run passed on 2026-10-02. `scripts/keycloak-acceptance.py`
used the official Keycloak26.8.0 distribution, process-local OpenJDK21, a bounded
512MB JVM, generated loopback HTTPS and its own unique native PostgreSQL database.
The [official release](https://github.com/keycloak/keycloak/releases/tag/26.8.0)
published the archive SHA256 pin
`9e41da899f838a58cd510fc98ed4f7cadc715aed5683e42aca20a0c9a2a3980a`.
It was confirmed through official HTTPS release metadata and checked before
extracting/executing the archive. Cached retries recheck that exact pin. This is
an official-distribution result, not an optimized Docker-image acceptance claim.

The driver used actual Admin REST and the reviewed Identity native registration
adapter, including strict registration replay. It generated a disposable genuine
password/OTP conditional-LoA browser flow. Both requested assurance names map to
distinct levels: password1, MFA2 and phishing-resistant3. No level3 authenticator
exists in this fixture, so it cannot claim phishing-resistant authentication.
No hardcoded assurance or authentication-time protocol mapper was introduced.
Actual provider REST exposed source-equivalent user-info defaults on the built-in
`auth_time` and ACR mappers, which the separate Identity adapter now handles
narrowly while retaining protected-claim and takeover checks.

The standard openid-client/Chrome driver proved a signed password-only downgrade
is denied even after OTP enrollment, real password plus OTP attains signed MFA,
client/Mail audiences and actual issuer are verified, wrong state/nonce/verifier
and audience are denied, callbacks are consumed once, fresh MFA rejects invalid
OTP, standard public-client logout requires the actual provider confirmation,
a signed desktop backchannel names the same SID and prompt-none fails after
logout. The exact private callback is captured from the provider HTTPS redirect.
No OS handler was registered or invoked by this driver.

The coordinated independent Mail test ran the actual mounted ASGI application
against native PostgreSQL using that provider's real discovery/JWKS and genuine
MFA access token. It passed: native exchange, assigned-mailbox listing,
unassigned selection denial, assigned selection, actual mailbox access,
cookie-free signed provider backchannel acceptance, exact
`403 central_access_revoked`, replay denial and durable retirement of the
workforce session and officer/mailbox refresh families. Result: **1 passed** in
80.45 seconds, with10 inherited warnings. It used no fake issuer, JWKS, claims,
provider token or logout event. The Electron cookie-jar runtime test remains a
separate HTTPS fixture test, so this does not claim one installed-device test
connecting all three components.

Reproduction with the isolated fixture prerequisites:

```sh
DESKTOP_KEYCLOAK_NATIVE=1 \
  /path/to/identity/services/management/.venv/bin/python \
  scripts/keycloak-acceptance.py
```

The runner requires Identity source, its Python dependencies/Playwright browser,
process-local Java21 and the private approved owner environment. Its native
fallback only permits the designated loopback PostgreSQL fixture. For coordinated
Mail verification, its separately owned opt-in test and single waiter use
`DESKTOP_MAIL_PROOF_FILE` with exclusive0600 proof files and bounded admission/
retirement markers. Those markers are written only after actual assertions.
Product timeouts are unchanged. Generated provider/runtime files are removed and
only the runner's own Java process is stopped. Automatic approval review rejected
disposable database removal, so unique fixture databases remain for operator
cleanup. A private retained-database manifest is recorded at
`/tmp/desktop-workforce-retained-databases.jsonl`; credentials and token values
are never included. At publication15 retained databases totalled195.4MiB. Private token artifacts belong to the coordinated test and
must be cleared by their owner.

Sanitized verdicts: `/tmp/desktop-workforce-keycloak-native.log` and
`/tmp/mail-keycloak-native-acceptance-final.log`. The initial Docker path remained
blocked by its control API. Docker was not restarted and unrelated containers
were untouched. Any queued `taifa-desktop-acceptance-*` Docker resources still
need operator inspection after the daemon recovers.

## Remaining release gates

Approved production assurance flow and governance/registration, installed system-
browser callback delivery on each supported platform, signed/notarized installers,
hardware passkeys, sponsored pilot, real lifecycle departure and outage behavior
remain release gates. Actual provider MFA/logout and actual Mail/PostgreSQL
admission/revocation are now observed fixture results. Production mandatory-SSO
policy remains one-way during rollback, with no local password fallback for
managed staff.
