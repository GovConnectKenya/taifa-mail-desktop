# Native deployment guard retake

Executed checkpoint, 2026-10-03. The current Desktop protocol retake passed with exit 0 against the verified official Keycloak 26.8.0 distribution and trusted HTTPS loopback issuer. The historical Mail interoperability results in `desktop-workforce-validation.md` remain evidence for their recorded source, not a new Mail backend execution claim.

The Desktop acceptance runner now explicitly supplies `IDENTITY_ENV=development` with its trusted HTTPS loopback issuer and the matching `MAIL_NATIVE_ENVIRONMENT`. It uses neither HTTP issuer fallback nor a staging/production alias. Existing exact native callback, approved API audience, signed token verification and genuine MFA checks are unchanged.

The separate Identity native governance helper covers current mounted owner proposals and exact queued worker checks, including actual-provider absence after owner or approver revocation. Its independent review records are synthetic fixture setup. Genuine TOTP is not relabeled as hardware approval. The Desktop runner's direct registration setup still uses a disposable bootstrap operator adapter; it does not itself prove production governance or service credential enrollment.

Without the separately coordinated `DESKTOP_MAIL_PROOF_FILE` test, the Desktop driver verifies genuine signed Mail-audience access tokens against the actual provider JWKS but uses an explicit local Mail sink. A runner retake alone does not establish a new mounted Mail/PostgreSQL exchange or revocation pass.

The sequential actual provider retake passed genuine password-only denial despite OTP enrollment, attained MFA, actual signed authentication time/subject/SID, public PKCE S256, exact client and Mail API audience checks, wrong state/nonce/verifier/audience denial, fresh MFA, provider logout, same-SID signed backchannel delivery and subsequent prompt-none denial. The driver captured the provider's exact private callback without invoking an OS handler. No hardware authentication or production approval was claimed.

Executed command from the Desktop repository:

```sh
env -u DESKTOP_MAIL_PROOF_FILE \
  DESKTOP_KEYCLOAK_NATIVE=1 \
  IDENTITY_PROJECT_ROOT=/path/to/taifa-identity \
  /path/to/taifa-identity/services/management/.venv/bin/python \
  scripts/keycloak-acceptance.py
```

Source at execution: Desktop `cb9b3f02237d47e7eb83d0280ab8e84d362e9c16`, with the narrow uncommitted runner update SHA-256 `8c786cb150094684e64be0dbd6eaa15bb5ea7e6c149223ac4dfc68f04097d0a8`; unchanged JavaScript driver SHA-256 `27129a78156919ad3d8bd8290f27622f1a0d0c66e4a63e9c9a032600a502c89e`. It imported current guarded Identity source `752f471a6461d2b280bc1e7918cc70047ae8cd23`. Log: `/tmp/desktop-native-current-guard-acceptance.log`.

The provider stopped and its temporary credential files were removed. Its unique database `desktop_identity_acceptance_344817349c54` remains retained for operator cleanup. A separate process inventory observed no matching owned provider, Python runner or Node driver after both current native fixtures completed. Python syntax and diff checks passed. Installed OS callbacks, signed device builds, actual hardware approval and production rollout remain separate gates.
