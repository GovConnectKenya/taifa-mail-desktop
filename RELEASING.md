# Releasing Taifa Mail desktop

Releases are automated. You write the changelog, run one command, and CI does the
rest: build for macOS, Windows and Linux, then publish the installers and the
update feed to GitHub Releases. `build.publish` is `provider: github`, so
electron-updater reads the feed straight from Releases. There is no website sync
step and no separate feed to keep in step.

## One-time setup

In the GitHub repo settings (Settings, Secrets and variables, Actions) add:

- `MAC_CERTS`: your Developer ID Application certificate, exported as a `.p12`
  and base64-encoded. CI passes it to electron-builder as `CSC_LINK`.
  (`base64 -i cert.p12 | pbcopy`)
- `MAC_CERTS_PASSWORD`: the password you set when exporting the `.p12`.
- `APPLE_ID`: the Apple ID used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: an app-specific password for that Apple ID,
  generated at appleid.apple.com. Not the account password.
- `APPLE_TEAM_ID`: the Apple Developer team ID.

`GITHUB_TOKEN` is provided automatically and is used to upload the installers.
There is no `RELEASE_PUBLISH_SECRET`: that belonged to the website sync job,
which this repo does not have.

The repo must stay **public**. `provider: github` fetches the update feed
anonymously; a private repo would force us to embed a token in the shipped app,
where any user could read it back out.

## Cutting a release

1. Add a new entry to the TOP of `changelog.json`:

   ```json
   {
     "version": "0.2.0",
     "date": "2026-08-01",
     "tag": "Latest",
     "major": false,
     "summary": "One line on what this release is about.",
     "added": ["New thing", "Another new thing"],
     "improved": ["Something nicer"],
     "fixed": ["A bug squashed"]
   }
   ```

   Do not add a `files` array, the build fills in sha512 and sizes.

2. Run:

   ```bash
   make release      # or: npm run release
   ```

   This syncs `package.json` to the version, commits, tags `v0.2.0` and pushes.
   The top entry of `changelog.json` is the single source of truth for the
   version: `package.json` follows it, never the other way round.

3. The tag triggers `.github/workflows/release.yml`, which:
   - builds and packages the app on macOS (x64 + arm64), Windows and Linux,
   - uploads the installers, blockmaps and `latest*.yml` to the GitHub Release.

That is it. Installed copies pick up the update on their next check.

## Load-bearing details, please do not tidy these away

Each of these looks like clutter and is not. All three are real bugs that were
paid for once already.

### 1. `zip` in the mac targets

`build.mac.target` is `["dmg", "zip"]`. The `.dmg` is what people download; the
`.zip` is what electron-updater actually updates from. electron-updater cannot
apply an update from a `.dmg`. Drop `zip` and the app still builds, still ships,
and silently never updates itself on macOS.

### 2. `notarize.teamId` is a hardcoded literal

`build.mac.notarize.teamId` is the literal `YAD95QLFD7`, not
`${env.APPLE_TEAM_ID}`. electron-builder does **not** interpolate `${env.*}` in
that field: it passes the string through verbatim and notarization fails against
a team ID that does not exist. This was diagnosed and fixed once in spaci
(commit 651be23). The `APPLE_TEAM_ID` secret is still set in CI because the
notarization tooling reads it from the environment as well, so the two must
agree. If the team ID ever changes, change it in **both** places.

### 3. The macOS signing env is only on the macOS build step

The workflow has two build steps that run the same command, split only by
`if: matrix.os == ...`. That is deliberate. `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set on the
macOS step alone. On Windows and Linux those secrets resolve to empty strings,
and electron-builder reads an empty `CSC_LINK` as a bad certificate path and
fails the build. Merging the two steps back into one "to remove duplication"
reintroduces that (spaci commit 20e978e).

Two more things in the workflow that look redundant and are not:

- `npm install --no-audit --no-fund`, not `npm ci`. The lockfile is resolved on
  one OS and omits electron-builder's other-platform optional dependencies, so
  `npm ci` fails its strict lock check on every runner.
- `--publish never` followed by an explicit `softprops/action-gh-release@v2`
  upload. electron-builder's own publisher races across the three runners and
  can clobber `latest*.yml`.

### The entitlements file is copied verbatim

`build/entitlements.mac.plist` is copied as-is from the proven template. The
hardened runtime is mandatory for notarization, and Electron needs every key in
that file (JIT, unsigned executable memory, dyld environment variables, library
validation) to run under it. Trimming keys that "look unsafe" produces an app
that notarizes and then crashes on launch.

## The tag prefix and the update provider are coupled

This repo is standalone, so the tag `v*.*.*` is safe. **If this ever moves into
the taifa-mail monorepo**, the tag MUST become `desktop-v*.*.*`, because
`taifa-mail/.github/workflows/release.yml` already fires on `v*` and the two
workflows would race on the same tag.

That change is **two-part, in a single commit**:

1. rename the tag prefix (workflow trigger + `scripts/release.mjs`), **and**
2. switch `build.publish` to `provider: generic`.

electron-updater's `GitHubProvider` derives the version by stripping a leading
`v` and semver-parsing the remainder. It cannot cope with a `desktop-v` prefix.
Doing either half without the other ships a build whose updater silently never
finds an update: CI stays green, the release page looks correct, and every
installed copy quietly stops receiving updates.

## Notes

- macOS auto-**install** requires a signed and notarized build. The check and the
  download work fine unsigned, but `quitAndInstall` on an unsigned mac build is
  blocked by Gatekeeper: the update downloads and then never applies.
- Windows and Linux builds are unsigned. Windows SmartScreen will warn on first
  run until we buy a code-signing certificate.
