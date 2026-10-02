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

The reviewed Apple Developer team ID `YAD95QLFD7` is a literal in the macOS
release step, which passes it as `APPLE_TEAM_ID`. It is not a secret.

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
     "tag": "",
     "major": false,
     "summary": "One line on what this release is about.",
     "added": ["New thing", "Another new thing"],
     "improved": ["Something nicer"],
     "fixed": ["A bug squashed"]
   }
   ```

   Do not add a `files` array, the build fills in sha512 and sizes.

   **Do not write a status word into `tag`.** "Latest", "Unreleased" and the
   like are NOT stored here: the download and changelog pages derive them from
   the GitHub releases API (the single source of truth for what is actually
   published), so a hand-typed status can never drift from reality. This is
   exactly the trap that once showed "not published yet" for every platform
   while a perfectly good release sat on GitHub: `changelog.json[0]` was a
   version whose notes were written before `make release` cut its tag, and the
   page trusted the entry's `"tag": "Latest"` instead of the release feed.

   It is normal and expected for the top entry to sit here for a while before
   you release it: you write the notes, they merge, and only later do you run
   `make release`. During that window the download page keeps offering the
   latest ACTUALLY-published release, and the changelog page shows the new entry
   with an "Unreleased" badge. `tag` is now only for a genuine free-text label
   on a specific release ("First release", "Security"); leave it "" otherwise.

2. Run:

   ```bash
   make release      # or: npm run release
   ```

   This syncs `package.json` to the version, commits, tags `v0.2.0` and pushes.
   The top entry of `changelog.json` is the single source of truth for the
   version: `package.json` follows it, never the other way round.

3. The tag triggers `.github/workflows/release.yml`, which:
   - builds and packages the app on macOS (x64 + arm64), Windows and Linux,
   - renders the release body from `changelog.json` (`scripts/release-notes.mjs`),
   - uploads the installers, blockmaps and `latest*.yml` to the GitHub Release.

That is it. Installed copies pick up the update on their next check.

### Bump arguments

`scripts/release.mjs` takes an optional bump argument:

```bash
node scripts/release.mjs               # release changelog.json[0] as written
node scripts/release.mjs patch         # changelog.json[0] must be a patch bump
node scripts/release.mjs minor         # ... a minor bump
node scripts/release.mjs major         # ... a major bump
node scripts/release.mjs 0.4.2         # ... exactly 0.4.2
npm run release -- minor               # same thing through npm
```

The argument is a **check, not an instruction**. It computes what the next
version should be (bumping from `package.json`) and then requires
`changelog.json[0].version` to agree. If they disagree the script stops and
tells you both numbers: it will not rewrite the changelog for you. The version
and the notes at `changelog.json[0]` are one unit, written together by a human
for one specific release. A script that silently changed the version would
leave the bullets describing a release that no longer exists, and nothing
downstream would ever notice.

`make release` passes no argument, which is the "changelog.json[0] as written"
path. That is still the normal way to release.

Two more behaviours worth knowing:

- **`patch` walks forward past taken tags.** If `package.json` says `0.2.0` but
  `v0.2.1` is already tagged (a release cut from another clone, a release commit
  that never landed), `patch` resolves to `v0.2.2` rather than failing. The next
  free patch number is always the right answer. This does **not** apply to
  `minor`, `major` or an explicit version: those collide loudly, because
  skipping one would mean inventing a version nobody asked for.
- **Explicit versions never auto-skip.** `node scripts/release.mjs 0.4.2` fails
  if `v0.4.2` exists. You asked for a specific number; you get it or an error.

The script also refuses to run from a dirty working tree (it commits only
`changelog.json` and `package.json`, so anything else you have open would be
left behind by the tag), and refuses to run from a branch other than `main`.
Pass `--allow-any-branch` to override the branch check. There is no override for
the dirty check.

### The changelog gate

For a **minor or major** release, the script prints the changelog entry and asks
you to confirm it describes this version:

```
  v0.3.0  (minor release, up from 0.2.0)  2026-08-01
  Search that actually finds things.
    added    Full-text search across every folder.
    fixed    Attachments no longer vanish from drafts.

Do those notes describe v0.3.0? [y/N]
```

Anything but `y` aborts before anything is committed, tagged or pushed. The
mistake this catches is a real one and it is silent: a new version number over
last release's bullets, shipped straight to the download page.

If stdin is not a terminal the script **fails** rather than skipping the
question. A piped or scripted run must never be able to tag a minor or major
release whose notes nobody has read. There is no `--yes` flag on purpose: a flag
that skips the gate ends up in a script, and then there is no gate.

Patch releases are not gated. The question is keyed on the size of the version
step, not on how you invoked the script, so `node scripts/release.mjs 0.3.0`
from `0.2.0` asks it too.

## `changelog.json` is a data contract, not prose

Three things read this file now:

1. **The GitHub release body.** CI runs `scripts/release-notes.mjs` and feeds the
   result to the release action as `body_path`.
2. **The govconnect.ke/desktop download page**, which renders the top entry.
3. **/desktop/changelog**, which renders all of them.

So it is an API with three consumers, not a text file you jot notes in. Which
means:

- **Keep the shape.** `version`, `date` (real ISO `YYYY-MM-DD`), `tag`, `major`,
  `summary`, `added`, `improved`, `fixed`. `scripts/release.mjs` validates all of
  it before tagging: a bad date, an empty summary, or an entry with no bullets in
  any of the three groups is refused. That is not pedantry, those cases render as
  a blank card on the download page.
- **Bullets are short and user-facing.** "Fixed crash on launch", not "Resolved
  null pointer in BrowserWindow handler". The reader is someone who wants to know
  whether to click Update, not someone reading our diff.
- **`summary` is one sentence** and carries the release on its own. It is the
  first line of the release body and the only line the download page shows.
- **Never edit a shipped entry's `version` or `date`.** Past entries are history
  that three pages already render. Fix a wrong bullet if you must; do not
  renumber.

## Fixing a bad release

First, the mental model, because `provider: github` has no feed file to revert.
The updater asks GitHub for this repo's **latest release** and reads `latest.yml`
/ `latest-mac.yml` from that release's assets. That is the entire feed. Whatever
GitHub currently calls "Latest" is what every installed copy sees on its next
check. There is no pointer file to edit and nothing to sync.

Two consequences that decide what you should actually do:

- **Removing a release does not roll anyone back.** electron-updater will not
  downgrade (`allowDowngrade` is off, and we do not set it). Everyone already on
  the bad version stays on the bad version. Pulling the release only stops it
  spreading to people who have not updated yet.
- **The fix that reaches those users is a new version.** A higher number is the
  only thing the updater will act on.

So the default answer is: **ship a patch, do not delete anything.**

```bash
# changelog.json gets a new entry at the top, honestly describing the fix:
#   { "version": "0.2.1", ..., "fixed": ["Fixed a crash on launch."] }
node scripts/release.mjs patch
```

That is the whole procedure for a bug, and it is what you want in almost every
case. Users on the bad build get the fix, users on the old build skip straight
past it, and the history stays true.

### When to pull the release as well

Only when the build is actively harmful and has not spread widely: it destroys
data, it will not launch at all, or it has a security problem. Pulling it stops
new downloads and stops the update offer while you build the patch. Do this
first, then ship the patch anyway.

```bash
# Preferred: demote it. The artifacts stay put for diagnosis, but GitHub stops
# calling it Latest, which is exactly what the updater asks for.
gh release edit v0.2.0 --prerelease

# Confirm what the feed now serves (gh release view with no tag = the latest):
gh release view --json tagName,isPrerelease
```

Demoting to a pre-release is enough because the updater resolves the latest
**non-prerelease** release. (This holds only while we leave `allowPrerelease`
off. If that ever changes, demoting stops hiding anything and you have to
delete.) GitHub should promote the previous release to Latest automatically;
check with the command above, and if it did not, set it explicitly:

```bash
gh release edit v0.1.9 --latest
```

If you want it gone entirely, tag included:

```bash
gh release delete v0.2.0 --cleanup-tag --yes
git fetch --prune --prune-tags origin      # drop the local tag too
```

Deleting takes the installers with it, so anyone mid-download gets a 404, and
the sha512 that already-updated copies verified against is gone. That is fine as
long as you understand it is a removal, not an undo.

### Do not reuse the version number

Whatever you do, do not delete `v0.2.0` and re-tag a fixed `v0.2.0`. Everyone who
already installed the bad 0.2.0 is on 0.2.0, the updater compares versions and
finds nothing newer, and they are stranded on the broken build permanently. The
sha512 in the feed will also no longer match the binary they hold. Burn the
number and ship 0.2.1.

`scripts/release.mjs` will not let you reuse a number anyway: it fails if the tag
exists, and after `--cleanup-tag` plus a prune it would happily tag it again, so
this one is on you.

## Load-bearing details, please do not tidy these away

Each of these looks like clutter and is not. All three are real bugs that were
paid for once already.

### 0. `artifactName` has no space in it, and that is the whole point

`build.artifactName` is `TaifaMail-${version}-${arch}.${ext}`. It exists because
`productName` is "Taifa Mail", with a space, and a space in an artifact name
silently breaks auto-update on macOS and Linux.

Three components disagree about what a space becomes:

- electron-builder names the file `Taifa Mail-0.1.0-arm64.dmg`,
- it writes `Taifa-Mail-0.1.0-arm64.dmg` (hyphens) into `latest-mac.yml`,
- GitHub stores the release asset as `Taifa.Mail-0.1.0-arm64.dmg` (dots).

electron-updater reads the name out of the yml and fetches it from the release,
so it asks for the hyphen name, gets a 404, and the update never installs. This
shipped in v0.1.0 and was fixed in v0.1.1:

```
Taifa-Mail-0.1.0-arm64-mac.zip   (what the feed said)      -> 404
Taifa.Mail-0.1.0-arm64-mac.zip   (what was on the release) -> 200
```

Nothing fails loudly. CI is green, the release page looks right, the app reports
"up to date" or downloads nothing, and only a user who never gets an update ever
notices. Windows was unaffected the whole time, purely because `win.artifactName`
already had no space in it.

So: **keep every artifact name free of spaces.** If you change `productName`, or
add a target, check that the name in `latest*.yml` matches the asset on the
release before you trust the release. One command:

```bash
R=GovConnectKenya/taifa-mail-desktop
curl -sL "https://github.com/$R/releases/latest/download/latest-mac.yml" | grep -E "^ +- url:|^path:"
# then confirm one of them actually resolves:
curl -sIL "https://github.com/$R/releases/latest/download/<name-from-above>" -o /dev/null -w '%{http_code}\n'
```

200 means the feed and the release agree. 404 means auto-update is broken for
every installed copy.

### 1. `zip` in the mac targets

`build.mac.target` is `["dmg", "zip"]`. The `.dmg` is what people download; the
`.zip` is what electron-updater actually updates from. electron-updater cannot
apply an update from a `.dmg`. Drop `zip` and the app still builds, still ships,
and silently never updates itself on macOS.

### 2. The notarization team is a hardcoded literal

Builder26 uses `build.mac.notarize: true` and reads the team from
`APPLE_TEAM_ID`. The macOS release step supplies the reviewed literal
`YAD95QLFD7`; it does not interpolate a template inside a builder configuration
field. Builder24's former `{teamId: ...}` object is invalid in builder26.
If the approved team changes, update that workflow literal through review.
Required certificate and notarization credentials are validated before the
release build so missing secrets cannot silently skip notarization.

### 3. The macOS signing env is only on the macOS build step

The workflow has two build steps that run the same command, split only by
`if: matrix.os == ...`. That is deliberate. `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set on the
macOS step alone. On Windows and Linux those secrets resolve to empty strings,
and electron-builder reads an empty `CSC_LINK` as a bad certificate path and
fails the build. Merging the two steps back into one "to remove duplication"
reintroduces that (spaci commit 20e978e).

Two more things in the workflow that look redundant and are not:

- Release installation still uses `npm install --no-audit --no-fund`.
  Security CI proves the lockfile with `npm ci`. The builder's Windows packaging
  peer is explicitly pinned so npm10 and npm11 resolve the same required graph.
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
