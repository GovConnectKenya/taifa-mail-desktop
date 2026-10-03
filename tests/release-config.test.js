'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
test('full release config satisfies pinned builder schema and preserves signing/update requirements', async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  await validateConfiguration(packageJson.build, null);
  assert.equal(packageJson.build.mac.notarize, true);
  assert(packageJson.build.mac.target.includes('zip'));
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert(fs.existsSync(path.join(__dirname, '..', packageJson.build.mac.entitlements)));
  assert.equal(packageJson.build.artifactName.includes(' '), false);
  assert(packageJson.scripts.pack.includes('--publish never'));
});
