#!/usr/bin/env node
// Write minimumSystemVersion into release/latest-mac.yml.
//
// From 0.2.0 the app runs on Electron 45, which needs macOS 13 (the bundle's
// LSMinimumSystemVersion is 13.0). Installed 0.1.x apps supported macOS 10.15+,
// and their electron-updater (6.8.x, AppUpdater.isUpdateAvailable) skips an
// update only when the feed carries minimumSystemVersion, compared with
// os.release(), the DARWIN version. electron-builder 24 never writes the field,
// so without this a Mac on macOS 10.15 to 12 would auto-update into an app that
// cannot launch.
//
// Darwin 22 is macOS 13. The field is top-level feed metadata, so no sha512 in
// the file changes. Run after electron-builder on the macOS leg; a no-op when
// there is no latest-mac.yml (Windows and Linux).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_DARWIN = '22.0.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const feed = path.join(root, 'release', 'latest-mac.yml');

if (!fs.existsSync(feed)) {
  console.log('set-min-macos: no release/latest-mac.yml, nothing to do');
  process.exit(0);
}
let yml = fs.readFileSync(feed, 'utf8');
if (/^minimumSystemVersion:/m.test(yml)) {
  yml = yml.replace(/^minimumSystemVersion:.*$/m, `minimumSystemVersion: ${MIN_DARWIN}`);
} else {
  yml = yml.replace(/\n*$/, '\n') + `minimumSystemVersion: ${MIN_DARWIN}\n`;
}
fs.writeFileSync(feed, yml);
console.log(`set-min-macos: latest-mac.yml minimumSystemVersion ${MIN_DARWIN} (macOS 13)`);
