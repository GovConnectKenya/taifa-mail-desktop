'use strict';

// This preload is attached to REMOTE content: the window loads the webmail at
// https://mail.govconnect.ke, and webPreferences are fixed at window creation
// time, so the same preload also runs on the bundled shell pages (taifa-ui://app). There
// is no way to attach it to one and not the other.
//
// So it gates on the origin. Everything exposed to the remote app would be
// callable by anything running on mail.govconnect.ke, including anything that
// got there via XSS, a compromised npm dependency in the webmail's own build,
// or a hostile ad/iframe. The remote app is a web app: it already has every
// capability it needs from the browser. It gets NOTHING from us. Only our own
// bundled taifa-ui:// pages get a bridge, and only a harmless one.
//
// THE RULE, for anyone tempted to add to this file later: every method here
// must be safe when called with hostile arguments by an attacker who has XSS on
// the page. No fs. No generic ipcRenderer passthrough (do not expose `send`,
// `invoke`, or `on` with a caller-supplied channel). No
// shell.openExternal(arbitraryUrl), which is remote code execution wearing a
// hat. Validate in main, never here: this file runs in the renderer process and
// anything it checks, an attacker can simply not call.
//
// sandbox: true is set on the window, so this preload may only use ipcRenderer
// and contextBridge. Do not require anything else, it will not resolve.

const { contextBridge, ipcRenderer } = require('electron');

const IS_UI = location.protocol === 'taifa-ui:' && location.hostname === 'app';
const IS_ABOUT = IS_UI && location.pathname === '/about/about.html';

// The About window gets its own, smaller bridge and not taifaShell: it has no
// use for the tray or retry calls. Every method is a fixed channel. open() takes
// a KEY from a fixed set that main re-checks against its own allowlist, never a
// URL or a path.
if (IS_ABOUT) {
  contextBridge.exposeInMainWorld('taifaAbout', {
    getInfo: () => ipcRenderer.invoke('about:info'),
    checkUpdates: () => ipcRenderer.send('about:check-updates'),
    restartUpdate: () => ipcRenderer.send('about:restart-update'),
    open: (key) => ipcRenderer.send('about:open', String(key)),
    close: () => ipcRenderer.send('about:close'),
    // Pushed by main on 'about:update' as { state, version, percent }.
    onUpdate: (cb) => sub('about:update', cb),
  });
}

if (IS_UI && !IS_ABOUT) {
  contextBridge.exposeInMainWorld('taifaShell', {
    // -- offline page ----------------------------------------------------
    // Safe even in principle: it takes no arguments, and all it can do is ask
    // main to load the webmail again. Called a thousand times by a hostile
    // caller, the worst outcome is a reload, which is what the button next to
    // it does anyway. Main still owns the URL, and main still rate-limits.
    retry: () => ipcRenderer.send('shell:retry'),

    // Pushed by main on 'shell:state' as { attempt, nextRetryInSeconds, message }.
    // Returns an unsubscribe function so a page that re-subscribes (or lives a
    // long time) does not pile up listeners on the channel.
    onState: (cb) => sub('shell:state', cb),

    // -- tray popover ----------------------------------------------------
    // Every method here is the same safety class as retry(): no arguments, a
    // single fixed channel, and only ever reachable from OUR own taifa-ui:// pages
    // (the remote webmail never gets this bridge, see the header). Main owns
    // every URL and decides every action, so the worst a caller can do is
    // trigger a navigation or a quit, which the popover's own buttons already
    // do. No caller-supplied channel, no arguments to validate.
    openInbox: () => ipcRenderer.send('tray:open-inbox'),
    newMessage: () => ipcRenderer.send('tray:new-message'),
    openSettings: () => ipcRenderer.send('tray:open-settings'),
    checkUpdates: () => ipcRenderer.send('tray:check-updates'),
    restartUpdate: () => ipcRenderer.send('tray:restart-update'),
    quit: () => ipcRenderer.send('tray:quit'),

    // Pushed by main on 'tray:state' as { update: {state, percent, version},
    // unread }. Same unsubscribe contract as onState.
    onTrayState: (cb) => sub('tray:state', cb),
  });
}

function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
