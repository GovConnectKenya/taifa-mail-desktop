# Releasing the Windows client

Nothing here signs, tags or publishes by itself. The branch workflow (`.github/workflows/windows-native.yml`) builds unsigned,
self contained, unpackaged x64 and ARM64 folders and uploads them as workflow artifacts.

## What an owner has to decide

A code signing certificate is an owner decision. Without one, Windows SmartScreen shows "unknown publisher" and an MSIX cannot be installed.
Options: an OV or EV Authenticode certificate (EV removes the SmartScreen warm up), or Azure Trusted Signing.

## Authenticode signing of the folder build

The workflow has a signing step that runs only when the repository secret `WINDOWS_SIGN_PFX_BASE64` exists (the base64 of the .pfx)
together with `WINDOWS_SIGN_PFX_PASSWORD`. When the secrets are absent the step is skipped and the artifact stays unsigned.
It signs `TaifaMail.exe` and `TaifaMail.dll` with SHA-256 and an RFC 3161 timestamp, then deletes the decoded key from the runner.

## MSIX (recommended for distribution)

The project is unpackaged today so that CI artifacts run from a plain folder. To ship an MSIX: add a packaging project or set
`WindowsPackageType` to `MSIX` with a `Package.appxmanifest` whose publisher matches the certificate subject, build with
`msbuild /p:GenerateAppxPackageOnBuild=true`, and sign the package with the same certificate. Package identity also lets toasts and
the taskbar badge use the packaged APIs.

## Release steps (when the owner asks for a release)

1. Bump `Version` in `src/TaifaMail.App/TaifaMail.App.csproj`.
2. Run the workflow on the release branch with the signing secrets set; check the artifact is signed (`signtool verify /pa`).
3. Publish only after the owner approves. Never tag or publish from a feature branch.

## Not done on purpose

No auto-update channel, no tag or release job, no store submission.
