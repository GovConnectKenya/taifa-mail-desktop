# Releasing Taifa Mail for macOS

Nothing here has been run. Signing, notarization and upload are manual steps for the owner. The project is only prepared for them.

## What is configured

- Debug: ad hoc signing (`CODE_SIGN_IDENTITY "-"`), no certificate needed, hardened runtime off.
- Release: manual signing with `Developer ID Application`, team `YAD95QLFD7` (the team the existing desktop app uses), hardened runtime on, secure timestamp.
- Entitlements (`TaifaMail/TaifaMail.entitlements`): app sandbox, network client, user selected files read and write. Nothing else: no JIT, no unsigned executable memory, no library validation exception.

## Steps (do these yourself, in order)

1. Install the Developer ID Application certificate for team YAD95QLFD7 in the login keychain.
2. Build and archive:
   `xcodebuild -scheme TaifaMail -configuration Release -destination 'generic/platform=macOS' -archivePath build/TaifaMail.xcarchive archive`
3. Export the signed app (a `ExportOptions.plist` with `method` set to `developer-id` and `teamID` set to `YAD95QLFD7`):
   `xcodebuild -exportArchive -archivePath build/TaifaMail.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export`
4. Zip it for notarization: `ditto -c -k --keepParent build/export/TaifaMail.app build/TaifaMail.zip`
5. Store notarytool credentials once: `xcrun notarytool store-credentials taifa-notary --apple-id <id> --team-id YAD95QLFD7` (it asks for an app specific password; never put it in the repo).
6. Submit and wait: `xcrun notarytool submit build/TaifaMail.zip --keychain-profile taifa-notary --wait`
7. Staple: `xcrun stapler staple build/export/TaifaMail.app`
8. Verify: `spctl --assess --type execute --verbose build/export/TaifaMail.app` and `codesign --verify --deep --strict --verbose=2 build/export/TaifaMail.app`
9. Build the distribution disk image or zip from the stapled app. Tag and publish only when the owner says so.

## Checks before a release

- `macos/scripts/check-release-no-preview.sh` must print OK (no preview or fixture code in Release).
- Unit tests pass on the release commit.
- The bundled fonts carry their OFL text (`TaifaMail/Resources/Fonts/OFL.txt`).
