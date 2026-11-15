'use strict';

// The application menu, as a pure template builder: no Electron here, so the
// structure, accelerators and enabled states are unit tested
// (test/menu.test.js). main.js passes the result to Menu.buildFromTemplate and
// rebuilds it when the page state changes (a conversation opens, the composer
// closes), which is how items grey out when they do not apply.
//
// Keyboard model, chosen to match Apple Mail and Outlook rather than a browser:
// Cmd+R is Reply (never reload), Shift+Cmd+R Reply All, Shift+Cmd+F Forward,
// Cmd+F finds in the open message (else searches mail; Opt+Cmd+F always
// searches), Cmd+G finds the next match, Cmd+P prints the open conversation, Cmd+1..5 go to the
// standard folders. Reload lives under View > Developer with no shortcut.

// ctx: {
//   platform, isPackaged,
//   page: the page state from page-shim.js (normaliseState), or null while the
//         webmail is not loaded (offline page, first paint),
//   spellcheck: boolean,
// }
// act(id, extra) is called on click. Every actionable item has an id.
function buildMenuTemplate(ctx, act) {
  const isMac = ctx.platform === 'darwin';
  const p = ctx.page || null;
  const ready = !!(p && p.signedIn);
  const quiet = ready && !p.modal; // nothing modal covers the page
  const conv = quiet && p.conversation;
  // Message actions: a conversation is open and no composer is in front of it.
  const msg = conv && !p.composer;
  const click = (id) => (_item, _win, event) => act(id, { accelerator: !!(event && event.triggeredByAccelerator) });
  const item = (id, label, accelerator, enabled = true, extra = {}) => ({
    id,
    label,
    ...(accelerator ? { accelerator } : {}),
    enabled: !!enabled,
    click: click(id),
    ...extra,
  });
  const sep = { type: 'separator' };
  const settings = item('settings', isMac ? 'Settings…' : 'Settings', 'CmdOrCtrl+,', true);
  const defaultMail = item('default-mail', 'Make Taifa Mail the Default Email App', null, true);
  const updates = item('check-updates', 'Check for Updates…', null, true);
  const about = item('about', 'About Taifa Mail', null, true);

  const appMenu = {
    label: 'Taifa Mail',
    submenu: [about, sep, settings, updates, defaultMail, sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }],
  };

  const fileMenu = {
    label: 'File',
    submenu: [
      item('new-message', 'New Message', 'CmdOrCtrl+N', ready),
      item('new-window', 'New Window', 'CmdOrCtrl+Shift+N', true),
      item('open-window', 'Open Conversation in New Window', 'CmdOrCtrl+O', conv),
      sep,
      item('print', 'Print…', 'CmdOrCtrl+P', conv),
      sep,
      ...(isMac ? [] : [settings, defaultMail, sep]),
      isMac ? { role: 'close' } : { role: 'close', label: 'Close Window' },
      ...(isMac ? [] : [{ role: 'quit', label: 'Quit Taifa Mail', accelerator: 'Ctrl+Q' }]),
    ],
  };

  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      sep,
      {
        label: 'Find',
        // Cmd+F follows what is on screen, as in Apple Mail: with a message
        // open (and no composer in front of it) it finds in that message;
        // otherwise it searches mail. The menu shows Cmd+F on whichever item
        // it will run right now. Opt+Cmd+F always searches mail.
        submenu: [
          item('find', 'Find in Message…', msg ? 'CmdOrCtrl+F' : null, msg),
          item('find-next', 'Find Next', 'CmdOrCtrl+G', msg),
          item('find-prev', 'Find Previous', 'CmdOrCtrl+Shift+G', msg),
          ...(isMac ? [] : [
            item('find-next', 'Find Next', 'F3', msg, { visible: false, acceleratorWorksWhenHidden: true }),
            item('find-prev', 'Find Previous', 'Shift+F3', msg, { visible: false, acceleratorWorksWhenHidden: true }),
          ]),
          sep,
          item('search', 'Search Mail', msg ? 'Alt+CmdOrCtrl+F' : 'CmdOrCtrl+F', ready && p.search),
          ...(msg ? [] : [item('search', 'Search Mail', 'Alt+CmdOrCtrl+F', ready && p.search, { visible: false, acceleratorWorksWhenHidden: true })]),
        ],
      },
      {
        label: 'Spelling and Grammar',
        submenu: [item('spellcheck', 'Check Spelling While Typing', null, true, { type: 'checkbox', checked: !!ctx.spellcheck })],
      },
    ],
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      item('sidebar', 'Toggle Sidebar', isMac ? 'Ctrl+Cmd+S' : 'Ctrl+Shift+S', quiet),
      sep,
      item('zoom-reset', 'Actual Size', 'CmdOrCtrl+0', true),
      item('zoom-in', 'Zoom In', 'CmdOrCtrl+Plus', true),
      // Cmd+= is what most keyboards actually send for "zoom in".
      item('zoom-in', 'Zoom In', 'CmdOrCtrl+=', true, { visible: false, acceleratorWorksWhenHidden: true }),
      item('zoom-out', 'Zoom Out', 'CmdOrCtrl+-', true),
      sep,
      { role: 'togglefullscreen' },
      sep,
      {
        label: 'Developer',
        submenu: [
          item('reload', 'Reload Webmail', null, true),
          ...(ctx.isPackaged ? [] : [{ role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' }]),
        ],
      },
    ],
  };

  const mailboxMenu = {
    label: 'Mailbox',
    submenu: [
      item('folder:Inbox', 'Inbox', 'CmdOrCtrl+1', ready),
      // The old File > Inbox shortcut keeps working.
      item('folder:Inbox', 'Inbox', 'CmdOrCtrl+Shift+I', ready, { visible: false, acceleratorWorksWhenHidden: true }),
      item('folder:Sent', 'Sent', 'CmdOrCtrl+2', ready),
      item('folder:Drafts', 'Drafts', 'CmdOrCtrl+3', ready),
      item('folder:Archive', 'Archive', 'CmdOrCtrl+4', ready),
      item('folder:Trash', 'Trash', 'CmdOrCtrl+5', ready),
      sep,
      item('refresh', 'Refresh', isMac ? 'Alt+Cmd+N' : 'F5', ready && p.mail),
    ],
  };

  const messageMenu = {
    label: 'Message',
    submenu: [
      item('reply', 'Reply', 'CmdOrCtrl+R', msg),
      item('reply-all', 'Reply All', 'CmdOrCtrl+Shift+R', msg && p.canReplyAll),
      item('forward', 'Forward', 'CmdOrCtrl+Shift+F', msg),
      sep,
      item('archive', 'Archive', isMac ? 'Ctrl+Cmd+A' : 'Ctrl+Shift+E', msg && p.canArchive),
      // Cmd+Delete also deletes text to the start of the line, so it is only
      // live while nothing editable has focus (and main re-sends the key to
      // the page if the state was stale). No Delete key binding on Windows and
      // Linux, where that key is constant in text fields: '#' still works.
      item('delete', 'Move to Trash', isMac ? 'Cmd+Backspace' : null, msg && !p.typing),
      item('spam', 'Report Spam', 'CmdOrCtrl+Shift+J', msg),
      item('move', 'Move to Folder…', null, msg),
      sep,
      p && p.unread
        ? item('mark-read', 'Mark as Read', 'CmdOrCtrl+Shift+U', msg)
        : item('mark-unread', 'Mark as Unread', 'CmdOrCtrl+Shift+U', msg && p.read),
      p && p.starred
        ? item('unstar', 'Remove Star', 'CmdOrCtrl+Shift+L', msg)
        : item('star', 'Star', 'CmdOrCtrl+Shift+L', msg),
    ],
  };

  const windowMenu = isMac
    ? { role: 'windowMenu' }
    : { label: 'Window', submenu: [{ role: 'minimize' }, item('maximise', 'Maximise', null, true), sep, { role: 'close', label: 'Close Window' }] };

  const helpMenu = {
    role: 'help',
    submenu: [
      item('help', 'Taifa Mail Help', null, true),
      item('shortcuts', 'Keyboard Shortcuts', 'CmdOrCtrl+/', ready),
      sep,
      item('notification-settings', 'Notification Settings…', null, true),
      item('test-notification', 'Send Test Notification', null, true),
      ...(isMac ? [] : [sep, updates, about]),
    ],
  };

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, mailboxMenu, messageMenu, windowMenu, helpMenu];
}

// The parts of a template that decide whether the built menu must change: ids,
// labels, enabled and checked. Used to skip rebuilding the native menu when the
// page reports a state change that the menu does not show.
function menuSignature(template) {
  const out = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.type === 'separator') continue;
      out.push(`${it.id || it.role || it.label}|${it.label || ''}|${it.enabled === false ? 0 : 1}|${it.checked ? 1 : 0}`);
      if (Array.isArray(it.submenu)) walk(it.submenu);
    }
  };
  walk(template);
  return out.join('\n');
}

// Every item with an id, flattened, for tests and lookups.
function flatItems(template) {
  const out = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.id) out.push(it);
      if (Array.isArray(it.submenu)) walk(it.submenu);
    }
  };
  walk(template);
  return out;
}

module.exports = { buildMenuTemplate, menuSignature, flatItems };
