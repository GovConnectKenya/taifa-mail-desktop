'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { aboutLink, chromiumLicencePath, buildAboutInfo, ABOUT_SIZE } = require('../src/about');
const { PAGES, contentType, resolveUiRequest } = require('../src/ui-scheme');

test('the About window is 720x440', () => {
  assert.deepEqual({ ...ABOUT_SIZE }, { width: 720, height: 440 });
});

test('aboutLink accepts only the fixed keys', () => {
  assert.equal(aboutLink('whats-new').url, 'https://github.com/GovConnectKenya/taifa-mail-desktop/releases');
  assert.ok(aboutLink('help').url.startsWith('https://'));
  assert.equal(aboutLink('rcfi').url, 'https://rcfi.co.ke');
  assert.equal(aboutLink('webmail').url, 'https://mail.taifa.go.ke');
  assert.equal(aboutLink('chromium-licences').file, 'LICENSES.chromium.html');
  for (const bad of ['', 'https://evil.example', '../x', 'constructor', '__proto__', 'toString', undefined, null, 5]) {
    assert.equal(aboutLink(bad), null, String(bad));
  }
});

test('chromiumLicencePath follows the platform layout', () => {
  assert.equal(
    chromiumLicencePath({ platform: 'darwin', resourcesPath: '/Applications/Taifa Mail.app/Contents/Resources', execPath: '/x' }),
    '/Applications/Taifa Mail.app/Contents/Frameworks/Electron Framework.framework/Resources/LICENSES.chromium.html');
  assert.equal(
    chromiumLicencePath({ platform: 'linux', resourcesPath: '/opt/Taifa Mail/resources', execPath: '/opt/Taifa Mail/taifa-mail' }),
    path.join('/opt/Taifa Mail', 'LICENSES.chromium.html'));
});

test('buildAboutInfo shortens the commit and tolerates a missing bundle', () => {
  const i = buildAboutInfo({ platform: 'darwin', appVersion: '0.2.1', bundle: { webmail: '0.5.0', commit: '5d365f6f467d76c11d1876033663f3b5d96bdf59' }, update: { state: 'current', version: '0.2.1', at: 1 } });
  assert.equal(i.webmailCommit, '5d365f6f4');
  assert.equal(i.webmailVersion, '0.5.0');
  assert.deepEqual(i.update, { state: 'current', version: '0.2.1', percent: undefined });
  const none = buildAboutInfo({ platform: 'linux', appVersion: '0.2.1', bundle: null, update: null });
  assert.equal(none.webmailVersion, '');
  assert.deepEqual(none.update, { state: 'idle' });
});

test('every About asset in the allowlist exists on disk with a content type', () => {
  const root = path.join(__dirname, '..', 'src');
  const about = Object.keys(PAGES).filter((k) => k.startsWith('about/'));
  assert.ok(about.includes('about/about.html'));
  for (const k of about) {
    assert.ok(fs.existsSync(path.join(root, PAGES[k])), k);
    assert.notEqual(contentType(PAGES[k]), 'application/octet-stream', k);
    assert.equal(resolveUiRequest(`taifa-ui://app/${k}`, root), path.join(root, PAGES[k]));
  }
});

test('the About page references only allowlisted taifa-ui assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'about', 'about.html'), 'utf8');
  const refs = [...html.matchAll(/taifa-ui:\/\/app\/([\w./-]+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const r of refs) assert.ok(Object.prototype.hasOwnProperty.call(PAGES, r), r);
});
