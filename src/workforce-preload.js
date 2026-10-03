'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// This preload is assigned only to the bundled selector. Main verifies the
// exact file URL, WebContents, and main frame on every invocation.
const expectedPage = process.argv.find(arg => arg.startsWith('--taifa-auth-page='))?.slice('--taifa-auth-page='.length);
if (location.href === expectedPage && location.protocol === 'file:') contextBridge.exposeInMainWorld('workforce', Object.freeze({
  state: () => ipcRenderer.invoke('workforce:state'),
  start: (orgId, reauth) => ipcRenderer.invoke('workforce:start', { orgId, reauth }),
  select: id => ipcRenderer.invoke('workforce:select', id),
  cancel: () => ipcRenderer.invoke('workforce:cancel'),
  logout: () => ipcRenderer.invoke('workforce:logout'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('workforce:state', listener);
    return () => ipcRenderer.removeListener('workforce:state', listener);
  },
}));
