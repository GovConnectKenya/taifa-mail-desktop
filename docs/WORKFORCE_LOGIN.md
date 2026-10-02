# Institution sign-in in Taifa Mail Desktop

This branch extends the committed remote-webmail shell. It leaves the separate,
unfinished native rebuild untouched. Mailbox-only sign-in and server-side
IMAP/SMTP credentials retain their existing policies.

The Identity menu opens a bundled Institution selector. The existing Mail webmail
Institution sign-in also works: main intercepts only a main-frame navigation
from the exact trusted Mail origin to `/auth/workforce/start`, validates the Mail
workspace UUID, and opens central sign-in in the system browser. Mail bodies and
foreign pages cannot invoke the selector IPC or choose an arbitrary provider.

The main process uses pinned `openid-client` 6.8.8 with public-client
Authorization Code, PKCE S256, state, nonce, signed ID-token verification,
verified issuer/client audience and actual recent MFA assurance. Its state and
proofs last at most five minutes. No central credentials appear in Electron.
Tokens are never exposed to renderers, URLs, logs, files, or a generic IPC bridge.
Main erases token references after exchange, and clears pending proof state on
completion, cancellation, timeout and error.

Main exchanges the central access token with Mail's HTTPS native endpoint using
`{access_token, mail_org_id}`. It verifies the returned organization, lists only
assigned mailboxes and waits for explicit selection of a returned mailbox ID.
The backend remains responsible for current issuer/subject mapping, sponsorship,
lifecycle freshness, assurance, session fences and the current assignment graph.
Email is a display attribute and never an account-linking key.

Electron's existing Mail partition stores HttpOnly mailbox cookies. Native
requests use the exact configured Mail origin, include its latest CSRF cookie in
`X-CSRF-Token`, reject redirects and have a five-second deadline. Neither cookie
values nor central tokens cross the selector bridge. Cancelling after exchange
revokes the temporary account session using `/auth/logout`; it does not sign out
an independently existing mailbox session before explicit selection. Once a user
selects a mailbox, failure or cancellation also revokes the current mailbox
session, because its cookies may already have transferred before a lost response.
Cancellation clears relevant credentials from the local partition even if the
server refuses cleanup. Before selection it preserves an independent mailbox;
after an explicit selection it also clears mailbox credentials and retained
account slots, then reloads the remote renderer. If network failure prevents
server revocation, the selector retains that warning instead of presenting a
successful cancellation. Normal Quit waits for bounded pending-flow cleanup;
forced process termination cannot guarantee remote revocation.

## Operator configuration and reviewed registration

Default Mail origin: `https://mail.govconnect.ke`.
Default issuer: `https://accounts.govconnect.ke/realms/taifa-staff`.
Operators can select separate reviewed staging deployments with
`TAIFA_APP_ORIGIN` and `TAIFA_IDENTITY_ISSUER`. Central sign-in requires HTTPS,
normal certificate validation and a trusted exact issuer. No insecure transport
switch is provided. UI arguments cannot alter these values.

Register a reviewed public client with:

- Client ID: `taifa-mail-desktop`, client authentication disabled.
- Standard Authorization Code only, PKCE S256 required, no implicit/direct grants.
- Exact redirect URI: `ke.govconnect.taifamail.auth:/oauth2redirect`.
- Exact post-logout URI: `ke.govconnect.taifamail.auth:/logout`.
- Scopes: `openid workforce-login`, no refresh/offline scope for desktop.
- Signed ID tokens with client audience, nonce, actual `auth_time`, and approved
  `taifa-mfa` or `taifa-phishing-resistant` assurance. Provider assurance must
  reflect actual authentication, never requested ACR alone.
- Access tokens with Mail's configured API audience, authorized party
  `taifa-mail-desktop`, nonempty human subject/session ID, actual recent strong
  assurance and reviewed workforce claims. No production audience is guessed.
- A reviewed Mail backchannel logout registration, with signed logout tokens for
  this client audience. Issuer, audience, replay, session and person fences remain
  mandatory in the Mail backend.

Mail must enable `taifa-mail-desktop` in its configured native-client allowlist
and expose the exclusive `mail_org_id` native adapter. The exact selected Mail
organization resolves the current reviewed Institution mapping after token
verification. Passing both or neither organization selectors is invalid.

Packaging registers the owned reverse-DNS scheme on macOS, Windows and Linux.
It never adds that scheme to the email link or arbitrary external URL allowlist.
App callback handling accepts only the exact paths, one matching one-use pending
state and bounded parameters. A cold callback cannot create a session.

## Logout

The dedicated Identity menu action revokes the local Mail mailbox session first. It
then opens the provider's standard end-session endpoint in the system browser,
using the public client ID, registered post-logout callback and independent
state. No ID token is retained as a logout hint after sign-in. The provider may
ask for confirmation. The UI distinguishes local Mail logout from unconfirmed,
unavailable, or returned central logout. A browser callback is not a claim that
all other applications were revoked; signed backchannel processing enforces
server-side session retirement.

## Validation and remaining release gates

`npm test` exercises actual RSA-signed OIDC over a locally trusted HTTPS fixture,
wrong signature/issuer/audience/nonce/state/assurance/recency, PKCE, replay,
cancellation, expiry, Mail organization validation, latest CSRF and exact IPC
sender policy. `npm run test:electron` uses the real Electron runtime, sandboxed
BrowserWindow and HTTPS session cookie jar through OIDC, native exchange and
explicit mailbox selection. Its disposable mock Mail endpoint is not a claim of
production integration. `npm run pack` validates the local unpacked build.

Before deployment, reviewers must prove the reviewed native client and Mail API
configuration against the real staged provider/backend, actual system-browser
return into each signed OS installer, MFA/passkey behavior, signed backchannel
logout, lifecycle departure and provider-outage behavior. The reviewed Identity native client
registration profile requires its independent governance and real-provider
validation before production registration can be declared complete. The minimal
repository realm does not itself define a production MFA/LoA assurance flow. OS handler registration and
signed/notarized installer delivery require their own device/release proof.

Primary protocol and API references:

- [OAuth native application best practice (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252.html).
- [openid-client signed response verification](https://raw.githubusercontent.com/panva/openid-client/v6.8.8/docs/functions/enableNonRepudiationChecks.md).
- [openid-client grant checks](https://raw.githubusercontent.com/panva/openid-client/v6.8.8/docs/interfaces/AuthorizationCodeGrantChecks.md).
- [Electron session fetch](https://www.electronjs.org/docs/latest/api/session).
- [Electron registered deep links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app).

## Release and rollback boundaries

This source is a review candidate. The local macOS directory build was explicitly
unsigned and not notarized; those flags are validation arguments, not changed
release policy. Existing release signing, notarization, auto-update feeds,
artifact naming and platform entitlements remain intact. The inherited Electron
and builder versions were updated because their initial audit contained security
advisories. The candidate's final npm audit is recorded separately from installer
or production certification.

A rollback can disable new desktop enrollment by disabling the reviewed desktop
provider client and removing only `taifa-mail-desktop` from Mail's native allowlist.
Operators must separately retire already-issued sessions through the approved
server-side session revocation path; disabling enrollment or clearing local
cookies alone does not revoke previously issued server sessions. Institution
mandatory-SSO policy must remain one-way during rollback, with no password
fallback for managed staff. Existing mailbox-only and independently reviewed
mobile credentials retain their own policies. Do not deploy an old vulnerable
Electron runtime as a security rollback without a separate risk decision.
