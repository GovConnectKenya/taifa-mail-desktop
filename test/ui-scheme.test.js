'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { uiUrl, resolveUiRequest, PAGES } = require('../src/ui-scheme');

const ROOT = path.join(path.sep, 'opt', 'Taifa Mail', 'resources', 'app.asar', 'src');

test('uiUrl builds the app-scheme URL for each known page', () => {
  assert.equal(uiUrl('tray/popover.html'), 'taifa-ui://app/tray/popover.html');
  assert.equal(uiUrl('shell/offline.html'), 'taifa-ui://app/shell/offline.html');
});

test('uiUrl refuses a page that is not allowlisted', () => {
  assert.throws(() => uiUrl('main.js'));
  assert.throws(() => uiUrl('../main.js'));
});

test('resolveUiRequest maps each page to its file, even under a path with a space', () => {
  for (const page of Object.keys(PAGES)) {
    assert.equal(resolveUiRequest(uiUrl(page), ROOT), path.join(ROOT, PAGES[page]));
  }
});

test('resolveUiRequest rejects anything that is not exactly an allowlisted page', () => {
  const bad = [
    'taifa-ui://app/main.js',
    'taifa-ui://app/',
    'taifa-ui://app/tray/',
    'taifa-ui://app/tray/popover.html?x=1',
    'taifa-ui://app/tray/popover.html#x',
    'taifa-ui://app/tray/../main.js',
    'taifa-ui://app/%2e%2e/main.js',
    'taifa-ui://app/tray%2fpopover.html',
    'taifa-ui://other/tray/popover.html',
    'taifa-ui://user@app/tray/popover.html',
    'taifa-ui://app:81/tray/popover.html',
    'file:///etc/passwd',
    'https://app/tray/popover.html',
    'not a url',
    '',
  ];
  for (const u of bad) assert.equal(resolveUiRequest(u, ROOT), null, u);
});
