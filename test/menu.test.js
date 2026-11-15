'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMenuTemplate, menuSignature, flatItems } = require('../src/menu');
const { normaliseState } = require('../src/page-shim');

const page = (over = {}) => normaliseState({ signedIn: true, mail: true, search: true, online: true, path: '/', ...over });
const build = (platform, p, extra = {}) => buildMenuTemplate({ platform, isPackaged: true, page: p, spellcheck: true, ...extra }, () => {});
const byId = (tpl, id) => flatItems(tpl).find((i) => i.id === id && i.visible !== false);
const top = (tpl) => tpl.map((m) => m.label || m.role);

test('macOS has the app menu and a full mail client menu bar', () => {
  assert.deepEqual(top(build('darwin', page())), ['Taifa Mail', 'File', 'Edit', 'View', 'Mailbox', 'Message', 'windowMenu', 'help']);
  const app = build('darwin', page())[0].submenu;
  const labels = app.map((i) => i.label || i.role);
  for (const l of ['About Taifa Mail', 'Settings…', 'Check for Updates…', 'hide', 'quit']) assert.ok(labels.includes(l), l);
  assert.equal(byId(build('darwin', page()), 'settings').accelerator, 'CmdOrCtrl+,');
});

test('Windows and Linux put About, Settings, Updates and Quit in File and Help', () => {
  for (const platform of ['win32', 'linux']) {
    const tpl = build(platform, page());
    assert.deepEqual(top(tpl), ['File', 'Edit', 'View', 'Mailbox', 'Message', 'Window', 'help']);
    const file = tpl[0].submenu.map((i) => i.id || i.role);
    assert.ok(file.includes('settings') && file.includes('quit'), platform);
    const win = tpl.find((m) => m.label === 'Window').submenu;
    assert.ok(win.some((i) => i.id === 'maximise') && !win.some((i) => i.role === 'zoom'), 'zoom role is macOS only');
    const help = tpl.find((m) => m.role === 'help').submenu.map((i) => i.id);
    assert.ok(help.includes('check-updates') && help.includes('about'), platform);
  }
});

test('Cmd+R replies and nothing reloads on a common shortcut', () => {
  const tpl = build('darwin', page({ conversation: true, read: true }));
  assert.equal(byId(tpl, 'reply').accelerator, 'CmdOrCtrl+R');
  assert.equal(byId(tpl, 'reply-all').accelerator, 'CmdOrCtrl+Shift+R');
  assert.equal(byId(tpl, 'forward').accelerator, 'CmdOrCtrl+Shift+F');
  const reload = byId(tpl, 'reload');
  assert.equal(reload.accelerator, undefined, 'reload has no shortcut');
  const roles = [];
  JSON.stringify(tpl, (k, v) => { if (k === 'role') roles.push(v); return v; });
  assert.ok(!roles.includes('reload') && !roles.includes('forceReload'));
  // Reload sits under View > Developer.
  const view = tpl.find((m) => m.label === 'View');
  const dev = view.submenu.find((i) => i.label === 'Developer');
  assert.ok(dev.submenu.some((i) => i.id === 'reload'));
});

test('no two visible items share an accelerator', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const seen = new Map();
    const walk = (items) => {
      for (const it of items) {
        if (it.accelerator && it.visible !== false) {
          const k = it.accelerator.replace('CmdOrCtrl', platform === 'darwin' ? 'Cmd' : 'Ctrl');
          assert.ok(!seen.has(k), `${platform}: ${k} on ${it.id} and ${seen.get(k)}`);
          seen.set(k, it.id || it.role);
        }
        if (Array.isArray(it.submenu)) walk(it.submenu);
      }
    };
    walk(build(platform, page({ conversation: true, read: true }), { isPackaged: false }));
  }
});

test('Cmd+F searches mail, Cmd+P prints, Cmd+Shift+N opens a window', () => {
  const tpl = build('darwin', page({ conversation: true }));
  assert.equal(byId(tpl, 'search').accelerator, 'CmdOrCtrl+F');
  assert.equal(byId(tpl, 'print').accelerator, 'CmdOrCtrl+P');
  assert.equal(byId(tpl, 'new-window').accelerator, 'CmdOrCtrl+Shift+N');
  assert.equal(byId(tpl, 'new-message').accelerator, 'CmdOrCtrl+N');
});

test('Mailbox menu goes to the standard folders, and the old Inbox shortcut still works', () => {
  const tpl = build('darwin', page());
  const ids = ['folder:Inbox', 'folder:Sent', 'folder:Drafts', 'folder:Archive', 'folder:Trash'];
  ids.forEach((id, i) => assert.equal(byId(tpl, id).accelerator, `CmdOrCtrl+${i + 1}`));
  const hidden = flatItems(tpl).find((i) => i.id === 'folder:Inbox' && i.visible === false);
  assert.equal(hidden.accelerator, 'CmdOrCtrl+Shift+I');
  assert.equal(hidden.acceleratorWorksWhenHidden, true);
});

test('nothing page-dependent is enabled before the webmail loads', () => {
  const tpl = build('darwin', null);
  for (const id of ['new-message', 'reply', 'print', 'search', 'folder:Inbox', 'archive', 'open-window']) {
    assert.equal(byId(tpl, id).enabled, false, id);
  }
  for (const id of ['about', 'settings', 'check-updates', 'new-window', 'zoom-in', 'help']) {
    assert.equal(byId(tpl, id).enabled, true, id);
  }
});

test('message actions need an open conversation and no composer in front', () => {
  const none = build('darwin', page());
  for (const id of ['reply', 'forward', 'archive', 'delete', 'print', 'open-window']) assert.equal(byId(none, id).enabled, false, id);
  const open = build('darwin', page({ conversation: true, read: true, canArchive: true, canReplyAll: true }));
  for (const id of ['reply', 'reply-all', 'forward', 'archive', 'delete', 'print', 'open-window', 'mark-unread', 'star']) {
    assert.equal(byId(open, id).enabled, true, id);
  }
  const composing = build('darwin', page({ conversation: true, read: true, composer: true }));
  for (const id of ['reply', 'forward', 'archive', 'delete']) assert.equal(byId(composing, id).enabled, false, id);
  // Printing the open conversation is still fine while a composer is up.
  assert.equal(byId(composing, 'print').enabled, true);
  const modal = build('darwin', page({ conversation: true, modal: true }));
  assert.equal(byId(modal, 'reply').enabled, false);
});

test('Reply All follows the page; Archive follows the archive button', () => {
  assert.equal(byId(build('darwin', page({ conversation: true })), 'reply-all').enabled, false);
  assert.equal(byId(build('darwin', page({ conversation: true, canReplyAll: true })), 'reply-all').enabled, true);
  assert.equal(byId(build('darwin', page({ conversation: true })), 'archive').enabled, false);
});

test('read and star items flip with the conversation state', () => {
  const read = build('darwin', page({ conversation: true, read: true }));
  assert.ok(byId(read, 'mark-unread') && !byId(read, 'mark-read'));
  const unread = build('darwin', page({ conversation: true, unread: true }));
  assert.ok(byId(unread, 'mark-read') && !byId(unread, 'mark-unread'));
  assert.equal(byId(unread, 'mark-read').accelerator, 'CmdOrCtrl+Shift+U');
  const starred = build('darwin', page({ conversation: true, starred: true }));
  assert.equal(byId(starred, 'unstar').label, 'Remove Star');
  assert.equal(byId(build('darwin', page({ conversation: true })), 'star').label, 'Star');
});

test('Cmd+Delete is off while typing, and Windows and Linux bind no Delete key', () => {
  const typing = build('darwin', page({ conversation: true, typing: true }));
  assert.equal(byId(typing, 'delete').enabled, false);
  assert.equal(byId(build('darwin', page({ conversation: true })), 'delete').accelerator, 'Cmd+Backspace');
  assert.equal(byId(build('win32', page({ conversation: true })), 'delete').accelerator, undefined);
});

test('the spelling item reflects the preference', () => {
  assert.equal(byId(build('darwin', page(), { spellcheck: true }), 'spellcheck').checked, true);
  assert.equal(byId(build('darwin', page(), { spellcheck: false }), 'spellcheck').checked, false);
});

test('dev tools only in development builds', () => {
  const has = (tpl) => JSON.stringify(tpl).includes('toggleDevTools');
  assert.equal(has(build('darwin', page(), { isPackaged: true })), false);
  assert.equal(has(build('darwin', page(), { isPackaged: false })), true);
});

test('clicks call act with the item id and whether a shortcut triggered it', () => {
  const calls = [];
  const tpl = buildMenuTemplate({ platform: 'darwin', isPackaged: true, page: page({ conversation: true }), spellcheck: true }, (id, info) => calls.push([id, info]));
  byId(tpl, 'reply').click(null, null, { triggeredByAccelerator: true });
  byId(tpl, 'folder:Sent').click(null, null, {});
  assert.deepEqual(calls, [['reply', { accelerator: true }], ['folder:Sent', { accelerator: false }]]);
});

test('the signature changes only when the visible menu would', () => {
  const a = menuSignature(build('darwin', page({ conversation: true, read: true })));
  const b = menuSignature(build('darwin', page({ conversation: true, read: true, online: false })));
  const c = menuSignature(build('darwin', page({ conversation: true, unread: true })));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
