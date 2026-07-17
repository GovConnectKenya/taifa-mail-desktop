'use strict';

// This preload is attached to REMOTE content: the window loads the webmail at
// https://mail.govconnect.ke, and webPreferences are fixed at window creation
// time, so the same preload also runs on the bundled file:// shell pages. There
// is no way to attach it to one and not the other.
//
// So it gates on the origin. Everything exposed to the remote app would be
// callable by anything running on mail.govconnect.ke, including anything that
// got there via XSS, a compromised npm dependency in the webmail's own build,
// or a hostile ad/iframe. The remote app is a web app: it already has every
// capability it needs from the browser. It gets NOTHING from us. Only our own
// bundled file:// pages get a bridge, and only a harmless one.
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

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('taifaShell', {
    // Safe even in principle: it takes no arguments, and all it can do is ask
    // main to load the webmail again. Called a thousand times by a hostile
    // caller, the worst outcome is a reload, which is what the button next to
    // it does anyway. Main still owns the URL, and main still rate-limits.
    retry: () => ipcRenderer.send('shell:retry'),

    // Pushed by main on 'shell:state' as { attempt, nextRetryInSeconds, message }.
    // Returns an unsubscribe function so a page that re-subscribes (or lives a
    // long time) does not pile up listeners on the channel.
    onState: (cb) => sub('shell:state', cb),
  });
}

function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
