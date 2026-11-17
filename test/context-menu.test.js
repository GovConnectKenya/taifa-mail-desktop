'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContextMenuTemplate, pickSpellLanguages, linkKind } = require('../src/context-menu');

const base = { x: 10, y: 20, selectionText: '', isEditable: false, editFlags: {}, linkURL: '', srcURL: '', mediaType: 'none', misspelledWord: '', dictionarySuggestions: [] };
const labels = (tpl) => tpl.map((i) => (i.type === 'separator' ? '---' : i.label || i.role));
const mk = (params, platform = 'darwin', calls = []) =>
  buildContextMenuTemplate({ ...base, ...params }, { platform, isDev: false }, (id, arg) => calls.push([id, arg]));

test('a misspelled word gets suggestions, Add to Dictionary and the edit items', () => {
  const calls = [];
  const tpl = mk({ isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive', 'relieve'], selectionText: 'recieve', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }, 'darwin', calls);
  assert.deepEqual(labels(tpl), ['receive', 'relieve', '---', 'Add to Dictionary', '---', 'Look Up “recieve”', '---', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
  tpl[0].click();
  tpl[3].click();
  assert.deepEqual(calls, [['replace-misspelling', 'receive'], ['add-to-dictionary', 'recieve']]);
});

test('no suggestions says so and still offers Add to Dictionary', () => {
  const tpl = mk({ isEditable: true, misspelledWord: 'Wanjiku', dictionarySuggestions: [] }, 'win32');
  assert.equal(tpl[0].label, 'No Guesses Found');
  assert.equal(tpl[0].enabled, false);
  assert.equal(tpl[2].label, 'Add to Dictionary');
});

test('suggestions are capped', () => {
  const tpl = mk({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  assert.equal(tpl.findIndex((i) => i.type === 'separator'), 6);
});

test('web links: open in browser and copy; mailto links: compose and copy the address', () => {
  const calls = [];
  const web = mk({ linkURL: 'https://example.org/read' }, 'linux', calls);
  assert.deepEqual(labels(web), ['Open Link in Browser', 'Copy Link']);
  web[0].click();
  assert.deepEqual(calls[0], ['open-link', 'https://example.org/read']);
  const mail = mk({ linkURL: 'mailto:a@b.ke' });
  assert.deepEqual(labels(mail), ['New Message to Address', 'Copy Email Address']);
});

test('links with schemes the app will not open get no link items', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url']) {
    assert.deepEqual(labels(mk({ linkURL: u })), [], u);
    assert.equal(linkKind(u), null, u);
  }
});

test('images: Copy Image at the click point, and Copy Image Address for web images', () => {
  const calls = [];
  const tpl = mk({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.org/a.png', x: 5, y: 6 }, 'darwin', calls);
  assert.deepEqual(labels(tpl), ['Copy Image', 'Copy Image Address']);
  tpl[0].click();
  assert.deepEqual(calls[0], ['copy-image', { x: 5, y: 6 }]);
  // An inline (blob:) image has no address worth copying.
  assert.deepEqual(labels(mk({ mediaType: 'image', srcURL: 'blob:https://mail.govconnect.ke/x' })), ['Copy Image']);
});

test('Look Up is macOS only; a plain selection gets Copy', () => {
  assert.deepEqual(labels(mk({ selectionText: 'circular' })), ['Look Up “circular”', '---', 'copy']);
  assert.deepEqual(labels(mk({ selectionText: 'circular' }, 'win32')), ['copy']);
  assert.ok(mk({ selectionText: 'a very long selection that goes on and on and on' })[0].label.length < 40);
});

test('Paste and Match Style only on macOS; nothing at all on a blank area', () => {
  assert.ok(!labels(mk({ isEditable: true, editFlags: { canPaste: true } }, 'win32')).includes('pasteAndMatchStyle'));
  assert.deepEqual(mk({}), []);
});

test('Inspect Element only in development', () => {
  const tpl = buildContextMenuTemplate({ ...base, selectionText: 'x' }, { platform: 'linux', isDev: true }, () => {});
  assert.equal(tpl[tpl.length - 1].label, 'Inspect Element');
});

test('spell languages follow the system where a dictionary exists', () => {
  const avail = ['en-GB', 'en-US', 'sw', 'fr', 'de'];
  assert.deepEqual(pickSpellLanguages(['en-KE', 'sw-KE'], avail), ['en-GB', 'sw']);
  assert.deepEqual(pickSpellLanguages(['fr-FR', 'en-US'], avail), ['fr', 'en-US']);
  assert.deepEqual(pickSpellLanguages(['ja-JP'], avail), ['en-GB', 'en-US']);
  assert.deepEqual(pickSpellLanguages([], []), ['en-GB', 'en-US']);
  assert.ok(pickSpellLanguages(['en-GB', 'en-US', 'fr', 'de'], avail).length <= 3);
});

test('right-click in the open message offers its actions, even with nothing selected', () => {
  const acts = [];
  const tpl = buildContextMenuTemplate({ x: 1, y: 1, editFlags: {} }, { platform: 'darwin', isDev: false, message: { canReplyAll: false, inWindow: false } }, (id, arg) => acts.push([id, arg]));
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['Reply', 'Reply All', 'Forward', 'Find in Message…', 'Print…', 'Open in New Window']);
  assert.equal(tpl.find((i) => i.label === 'Reply All').enabled, false);
  tpl.find((i) => i.label === 'Forward').click();
  assert.deepEqual(acts, [['menu', 'forward']]);
  const inWin = buildContextMenuTemplate({ editFlags: {} }, { platform: 'win32', message: { canReplyAll: true, inWindow: true } }, () => {});
  assert.ok(!inWin.some((i) => i.label === 'Open in New Window'), 'not inside a message window');
  // Outside the message, or in a field: unchanged.
  assert.equal(buildContextMenuTemplate({ editFlags: {} }, { platform: 'darwin', message: null }, () => {}).length, 0);
  assert.ok(!buildContextMenuTemplate({ isEditable: true, editFlags: {} }, { platform: 'darwin', message: { canReplyAll: true } }, () => {}).some((i) => i.label === 'Reply'));
});

test('a selection in the message keeps Copy and Look Up, then the message actions', () => {
  const tpl = buildContextMenuTemplate({ selectionText: 'budget', editFlags: { canCopy: true } }, { platform: 'darwin', message: { canReplyAll: true } }, () => {});
  const seq = tpl.map((i) => i.label || i.role || i.type);
  assert.ok(seq.indexOf('copy') < seq.indexOf('Reply'));
  assert.ok(seq[0].startsWith('Look Up'));
});
