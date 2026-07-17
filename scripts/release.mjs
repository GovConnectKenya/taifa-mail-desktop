#!/usr/bin/env node
// `make release` engine.
//
// Reads the newest entry in changelog.json, syncs package.json to that version,
// commits, tags v<version> and pushes. The pushed tag triggers
// .github/workflows/release.yml, which builds the installers for every platform
// and publishes them to GitHub Releases. electron-updater reads the update feed
// straight from Releases, so there is no separate feed to sync.
//
// Usage:
//   node scripts/release.mjs                     release changelog.json[0] as written
//   node scripts/release.mjs patch               changelog.json[0] must be a patch bump
//   node scripts/release.mjs minor               ... a minor bump (asks you to confirm)
//   node scripts/release.mjs major               ... a major bump (asks you to confirm)
//   node scripts/release.mjs 0.4.2               changelog.json[0] must be exactly 0.4.2
//   node scripts/release.mjs minor --allow-any-branch
//
// To cut a release:
//   1. Add a new entry to the TOP of changelog.json:
//        { "version": "0.2.0", "date": "2026-08-01", "tag": "Latest",
//          "major": false, "summary": "...",
//          "added": [...], "improved": [...], "fixed": [...] }
//      Do NOT add a "files" array, the build fills sha512 and sizes.
//   2. Run:  make release    (or:  npm run release, or with a bump argument:
//            npm run release -- minor)
//
// WHY A BUMP ARGUMENT NEVER REWRITES changelog.json:
// The bump argument is a check, not an instruction. changelog.json[0] stays the
// single source of truth, because the version and the notes at [0] are one unit:
// a human wrote those bullets to describe one specific release. If the script
// silently rewrote the version to match a bump argument, the notes would keep
// describing the release the human had in mind while the tag, package.json, the
// GitHub release body and the download page all said something else, and nothing
// would ever flag it. So when the two disagree we stop and make the human pick.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const git = (...a) => execFileSync('git', a, { stdio: 'inherit' });
const gitOut = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
// Like gitOut but per line, and WITHOUT trimming: `git status --porcelain`
// encodes the status in the first two columns, so " M changelog.json" starts
// with a space that carries meaning. Trimming the whole blob eats the first
// line's leading space and shifts every path by one character.
const gitLines = (...a) =>
  execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter((line) => line !== '');

const die = (...lines) => {
  console.error(lines.join('\n'));
  process.exit(1);
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const RELEASE_BRANCH = 'main';
// The only paths this script is allowed to find dirty: it stages and commits
// these two itself, and editing changelog.json is step 1 of every release.
const OWNED_PATHS = new Set(['changelog.json', 'package.json']);
const NOTE_GROUPS = ['added', 'improved', 'fixed'];

const USAGE = [
  'Usage: node scripts/release.mjs [patch|minor|major|<version>] [--allow-any-branch]',
  '',
  '  no argument        release changelog.json[0] exactly as written',
  '  patch|minor|major  compute the bump and require changelog.json[0] to agree',
  '  <version>          require changelog.json[0] to be exactly this version',
  '  --allow-any-branch release from a branch other than ' + RELEASE_BRANCH,
].join('\n');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--allow-any-branch');
if (unknownFlags.length > 0) die(`Unknown flag: ${unknownFlags[0]}`, '', USAGE);

const allowAnyBranch = argv.includes('--allow-any-branch');
const positional = argv.filter((a) => !a.startsWith('--'));
if (positional.length > 1) die(`Too many arguments: ${positional.join(' ')}`, '', USAGE);

const bumpArg = positional[0] ?? null;
if (bumpArg !== null && !['patch', 'minor', 'major'].includes(bumpArg) && !SEMVER.test(bumpArg)) {
  die(`Not a bump keyword or a version: ${JSON.stringify(bumpArg)}`, '', USAGE);
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

const parts = (v) => v.split('.').map(Number);

const bumped = (v, kind) => {
  const [major, minor, patch] = parts(v);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

// What kind of step is `to` relative to `from`? Used to decide whether the
// changelog gate applies, so it is keyed on the actual version change and not
// on how the release was invoked: `release.mjs 0.2.0` from 0.1.0 is just as
// much a minor release as `release.mjs minor`, and deserves the same question.
const stepKind = (from, to) => {
  const [aMajor, aMinor, aPatch] = parts(from);
  const [bMajor, bMinor, bPatch] = parts(to);
  if (bMajor !== aMajor) return bMajor > aMajor ? 'major' : 'backwards';
  if (bMinor !== aMinor) return bMinor > aMinor ? 'minor' : 'backwards';
  if (bPatch !== aPatch) return bPatch > aPatch ? 'patch' : 'backwards';
  return 'none';
};

// Reject 2026-02-31 and friends, not just the wrong shape.
const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// ---------------------------------------------------------------------------
// Validate the changelog entry
//
// These notes are not decoration: they become the GitHub release body, the
// govconnect.ke/desktop download page and /desktop/changelog. A release with an
// empty summary or no bullets renders as a blank card, so it is a bug, and the
// cheapest place to catch it is before the tag exists.
// ---------------------------------------------------------------------------

const changelog = readJson('changelog.json');
if (!Array.isArray(changelog) || changelog.length === 0) {
  die('changelog.json is empty. Add a release entry at the top first.');
}

const entry = changelog[0];
const version = entry.version;

if (!SEMVER.test(version || '')) {
  die(`The top changelog entry has an invalid version: ${JSON.stringify(version)}`);
}

if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !isRealDate(entry.date)) {
  die(
    `The top changelog entry has an invalid "date": ${JSON.stringify(entry.date)}`,
    'It must be a real ISO date, like "2026-08-01".',
  );
}

if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
  die(
    'The top changelog entry is missing a non-empty "summary".',
    'The summary is the first line of the GitHub release body and the blurb on',
    'the download page. One user-facing sentence on what this release is about.',
  );
}

let noteCount = 0;
for (const group of NOTE_GROUPS) {
  if (entry[group] === undefined) continue;
  if (!Array.isArray(entry[group])) {
    die(`The top changelog entry's "${group}" must be an array of strings.`);
  }
  for (const item of entry[group]) {
    if (typeof item !== 'string' || item.trim() === '') {
      die(`The top changelog entry has an empty item in "${group}". Remove it or write it.`);
    }
  }
  noteCount += entry[group].length;
}
if (noteCount === 0) {
  die(
    `The top changelog entry (${version}) has no notes.`,
    'At least one of "added", "improved" or "fixed" must have an item: they are',
    'what the release page and the in-app update dialog show the user.',
  );
}

// ---------------------------------------------------------------------------
// Git preflight
// ---------------------------------------------------------------------------

const branch = gitOut('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== RELEASE_BRANCH && !allowAnyBranch) {
  die(
    `On branch "${branch}", not "${RELEASE_BRANCH}".`,
    `Releases are cut from ${RELEASE_BRANCH} so the tag matches what was reviewed.`,
    'Pass --allow-any-branch if you really mean to tag this branch.',
  );
}

// A dirty tree is a trap: this script commits changelog.json and package.json
// and nothing else, so any other edit you have open stays behind while the tag
// moves on. You would ship a release that is missing the fix you just wrote.
const dirty = gitLines('status', '--porcelain')
  // Porcelain lines are "XY path", or "XY old -> new" for a rename. The two
  // status columns are fixed width, so the path always starts at column 3.
  .map((line) => line.slice(3).split(' -> ').pop())
  .filter((path) => !OWNED_PATHS.has(path));
if (dirty.length > 0) {
  die(
    'The working tree has changes that this release would leave behind:',
    ...dirty.map((p) => `  ${p}`),
    '',
    'Commit or stash them first. Only changelog.json and package.json are',
    'allowed to be dirty here, because this script commits them for you.',
  );
}

// Tags are the collision surface, and the local list is only as good as the
// last fetch. Without this, a tag someone else already pushed looks free right
// up until `git push` rejects it, leaving you with a local commit and tag to
// unpick. Not fatal: releasing offline should still be possible.
try {
  execFileSync('git', ['fetch', '--tags', '--quiet', 'origin'], { stdio: 'pipe' });
} catch {
  console.warn('Warning: could not fetch tags from origin. Checking local tags only.');
}
const tags = new Set(gitLines('tag', '--list', 'v*'));

// ---------------------------------------------------------------------------
// Work out the target version and check the changelog agrees
// ---------------------------------------------------------------------------

const pkg = readJson('package.json');
if (!SEMVER.test(pkg.version || '')) {
  die(`package.json has an invalid version: ${JSON.stringify(pkg.version)}`);
}
// package.json is where the last release landed: this script syncs it to the
// changelog on every run, so it is the version we are bumping FROM.
const current = pkg.version;

let target;
if (bumpArg === null) {
  target = version; // changelog.json[0] is the whole story.
} else if (SEMVER.test(bumpArg)) {
  // An explicit version is a deliberate act, so it does not get auto-skipped
  // below: if it collides, the human asked for the wrong number and should be
  // told, not quietly given a different one.
  target = bumpArg;
} else if (bumpArg === 'patch') {
  target = bumped(current, 'patch');
  // Patch collision auto-skip. package.json can legitimately lag the tags (a
  // release cut from another clone, a release commit that never landed), and
  // for a patch the next free number is always the right answer, so walk
  // forward instead of failing. Only patches: skipping a minor or major would
  // be inventing a version number nobody asked for.
  const firstChoice = target;
  while (tags.has(`v${target}`)) target = bumped(target, 'patch');
  if (target !== firstChoice) {
    console.log(`v${firstChoice} is already tagged. The next free patch is v${target}.`);
  }
} else {
  target = bumped(current, bumpArg);
}

if (target !== version) {
  die(
    `The bump argument and changelog.json do not agree.`,
    '',
    `  ${bumpArg === null ? 'changelog.json[0]' : `"${bumpArg}" from ${current}`} wants:  ${target}`,
    `  changelog.json[0].version says: ${version}`,
    '',
    'changelog.json[0] is the source of truth for the notes, and the notes and',
    'the version are one unit, so this script will not rewrite it for you.',
    'Fix whichever one is wrong:',
    `  - if ${target} is right, set changelog.json[0].version to "${target}"`,
    `  - if ${version} is right, run:  node scripts/release.mjs ${version}`,
  );
}

// Keep the `v` prefix. electron-updater's GitHubProvider strips a leading `v`
// and semver-parses the rest, so any other prefix needs provider: generic.
// See the tag warning at the top of .github/workflows/release.yml.
const tag = `v${version}`;
if (tags.has(tag)) {
  die(`Tag ${tag} already exists. Bump the version in changelog.json.`);
}

const kind = stepKind(current, version);
if (kind === 'backwards') {
  die(
    `${version} is behind package.json's ${current}.`,
    'Releasing backwards would publish an update feed that every installed copy',
    'ignores (electron-updater will not downgrade). Fix changelog.json[0].version.',
  );
}

// ---------------------------------------------------------------------------
// The changelog gate
//
// A minor or major release is the one people actually read the notes for, and
// the classic mistake is a new version number over last release's bullets. So
// print the entry and make a human say yes. There is no --yes flag on purpose:
// a flag to skip the gate is a flag someone puts in a script, and then the gate
// is gone.
// ---------------------------------------------------------------------------

if (kind === 'minor' || kind === 'major') {
  console.log('');
  console.log(`  ${tag}  (${kind} release, up from ${current})  ${entry.date}`);
  console.log(`  ${entry.summary}`);
  for (const group of NOTE_GROUPS) {
    for (const item of entry[group] ?? []) console.log(`    ${group.padEnd(8)} ${item}`);
  }
  console.log('');

  if (!process.stdin.isTTY) {
    die(
      `Refusing to tag ${tag}, a ${kind} release, without a human confirming the changelog.`,
      '',
      'stdin is not a terminal, so there is nobody to ask. This is deliberate: a',
      'piped or scripted run must never be able to tag a release whose notes',
      'nobody has checked. Run this from a terminal.',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question(`Do those notes describe ${tag}? [y/N] `);
  } catch {
    // Ctrl+C or Ctrl+D at the prompt. readline rejects, and an unhandled
    // rejection here would dump a stack trace over what is simply a "no".
    answer = 'n';
  } finally {
    rl.close();
  }
  if (answer.trim().toLowerCase() !== 'y') {
    die('Aborted. Nothing was committed, tagged or pushed.');
  }
}

// ---------------------------------------------------------------------------
// Ship it
// ---------------------------------------------------------------------------

// Sync package.json version to the changelog.
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`package.json version -> ${version}`);
}

// Stage and commit only if something actually changed.
git('add', 'package.json', 'changelog.json');
const staged = gitOut('diff', '--cached', '--name-only');
if (staged) {
  git('commit', '-m', `Release ${tag}`);
} else {
  console.log('Nothing new to commit, tagging the current commit.');
}

git('tag', '-a', tag, '-m', `Taifa Mail ${tag}`);
git('push', 'origin', 'HEAD');
git('push', 'origin', tag);

console.log(`\nReleased ${tag}. GitHub Actions is now building and publishing it.`);
console.log('Watch it at: https://github.com/GovConnectKenya/taifa-mail-desktop/actions');
