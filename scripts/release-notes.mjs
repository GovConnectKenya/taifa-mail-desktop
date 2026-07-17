#!/usr/bin/env node
// Renders one changelog.json entry as the GitHub release body.
//
// changelog.json is the source of truth for release notes, so the GitHub
// release has to be generated from it rather than from GitHub's own default,
// which is a list of commit subjects. Commit subjects are written for us; the
// release body is read by users, in the browser and in the in-app update
// dialog. This keeps the release page, govconnect.ke/desktop and
// /desktop/changelog all saying the same thing.
//
// Usage:
//   node scripts/release-notes.mjs           # the newest entry
//   node scripts/release-notes.mjs 0.2.0     # a specific version
//
// stdout is the notes and nothing else, because CI redirects it into a file
// (see .github/workflows/release.yml). Every diagnostic goes to stderr.

import { readFileSync } from 'node:fs';

const die = (...lines) => {
  console.error(lines.join('\n'));
  process.exit(1);
};

// The changelog's three note groups, and the headings users see. "added" reads
// as "New" on the release page: the JSON key is for us, the heading is for them.
const GROUPS = [
  ['added', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
];

let changelog;
try {
  changelog = JSON.parse(readFileSync('changelog.json', 'utf8'));
} catch (err) {
  die(`Could not read changelog.json: ${err.message}`);
}
if (!Array.isArray(changelog) || changelog.length === 0) {
  die('changelog.json is empty, so there are no release notes to print.');
}

const wanted = process.argv[2] ?? changelog[0]?.version;
const entry = changelog.find((e) => e && e.version === wanted);
if (!entry) {
  die(
    `changelog.json has no entry for version ${JSON.stringify(wanted)}.`,
    `Known versions: ${changelog.map((e) => e && e.version).filter(Boolean).join(', ') || '(none)'}`,
  );
}

const blocks = [];

if (typeof entry.summary === 'string' && entry.summary.trim() !== '') {
  blocks.push(entry.summary.trim());
}

for (const [key, heading] of GROUPS) {
  const items = Array.isArray(entry[key])
    ? entry[key].filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  if (items.length === 0) continue; // An empty group means nothing happened there, so say nothing.
  blocks.push(`### ${heading}\n${items.map((item) => `- ${item.trim()}`).join('\n')}`);
}

if (blocks.length === 0) {
  die(
    `The changelog entry for ${wanted} has no summary and no notes, so the release`,
    'body would be blank. Write the entry before releasing (scripts/release.mjs',
    'refuses this too).',
  );
}

// Blank lines between blocks: a "### " heading straight after a "- " bullet is
// ambiguous enough in Markdown parsers to not be worth relying on.
process.stdout.write(blocks.join('\n\n') + '\n');
