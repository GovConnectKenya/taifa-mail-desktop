#!/usr/bin/env node
// Stage the bundled webmail into renderer/ before packaging.
//
//   TAIFA_MAIL_DIR=/path/to/taifa-mail node scripts/stage-webmail.mjs [--build]
//
// TAIFA_MAIL_DIR is a checkout of GovConnectKenya/taifa-mail (default:
// ../taifa-mail next to this repo). With --build the webmail's desktop bundle
// is built first (npm ci + webmail/scripts/build-desktop.mjs); without it an
// existing webmail/.desktop/build is staged as is.
//
// A package must never ship without its UI, so any problem here is a hard
// failure: no bundle, no index.html, no fonts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mailDir = path.resolve(root, process.env.TAIFA_MAIL_DIR || '../taifa-mail');
const webmail = path.join(mailDir, 'webmail');
const bundle = path.join(webmail, '.desktop', 'build');
const target = path.join(root, 'renderer');

function fail(msg) {
  console.error(`stage-webmail: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(webmail, 'package.json'))) {
  fail(`no webmail at ${webmail}. Set TAIFA_MAIL_DIR to a taifa-mail checkout.`);
}

if (process.argv.includes('--build')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: webmail, stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync(process.execPath, ['scripts/build-desktop.mjs'], { cwd: webmail, stdio: 'inherit' });
}

for (const required of ['index.html', '_app', 'fonts', 'desktop-bundle.json']) {
  if (!fs.existsSync(path.join(bundle, required))) {
    fail(`${path.join(bundle, required)} is missing. Build it with: node scripts/stage-webmail.mjs --build`);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(bundle, target, { recursive: true });
const info = JSON.parse(fs.readFileSync(path.join(target, 'desktop-bundle.json'), 'utf8'));
console.log(`stage-webmail: staged webmail ${info.webmail} @ ${String(info.commit).slice(0, 9)} into renderer/`);
