'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, ipcMain, shell } = require('electron');
const { WorkforceFlow } = require('./workforce-flow');
const { MailBridge } = require('./workforce-mail');
const { trustedSender, trustedStart } = require('./workforce-policy');
const { APP_ORIGIN } = require('./config');
const PAGE = path.join(__dirname, 'shell', 'workforce.html');
const PAGE_URL = pathToFileURL(PAGE).href;
function installWorkforce({ session, complete, mainContents }) {
  let pane;
  let state = { phase: 'idle', message: 'Enter the Mail workspace ID supplied by your Institution.' };
  const show = () => {
    if (pane && !pane.isDestroyed()) { pane.show(); pane.focus(); return; }
    pane = new BrowserWindow({ width: 490, height: 560, resizable: false, title: 'Taifa Identity',
      webPreferences: { additionalArguments: ['--taifa-auth-page=' + PAGE_URL], preload: path.join(__dirname, 'workforce-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, webSecurity: true },
    });
    pane.loadFile(PAGE);
    pane.on('closed', () => { pane = null; void flow.cancel(); });
  };
  const notify = (next) => {
    state = next;
    if (pane && !pane.isDestroyed()) pane.webContents.send('workforce:state', state);
  };
  const flow = new WorkforceFlow({
    issuer: process.env.TAIFA_IDENTITY_ISSUER || 'https://accounts.govconnect.ke/realms/taifa-staff',
    mail: new MailBridge(session, APP_ORIGIN), openExternal: url => shell.openExternal(url), notify,
    complete: () => { complete(); },
  });
  for (const name of ['state', 'start', 'select', 'cancel', 'logout']) {
    ipcMain.handle(`workforce:${name}`, async (event, arg) => {
      if (!trustedSender(event, pane?.webContents, PAGE_URL)) throw Error('Untrusted authentication caller');
      try {
        if (name === 'state') return state;
        if (name === 'start') {
          if (!arg || typeof arg !== 'object' || Object.keys(arg).some(k => !['orgId', 'reauth'].includes(k)) || typeof arg.reauth !== 'boolean') throw Error('Invalid request');
          await flow.start(arg.orgId, arg.reauth);
        }
        if (name === 'select') await flow.select(arg);
        if (name === 'cancel' && await flow.cancel()) { notify({ phase: 'idle', message: 'Sign-in cancelled. You can start again.' }); }
        if (name === 'logout') await flow.logout();
      } catch {
        notify({ phase: 'error', message: 'This operation is unavailable. Check the workspace ID and try again.' });
      }
      return null;
    });
  }
  return {
    show,
    receive: raw => flow.receive(raw),
    cancel: () => flow.cancel(),
    intercept(wc, event, url) {
      const params = trustedStart(wc, event, url, APP_ORIGIN, mainContents());
      if (!params) return false;
      event.preventDefault();
      show();
      void flow.start(params.orgId, params.reauth).catch(() => notify({ phase: 'error', message: 'Sign-in unavailable.' }));
      return true;
    },
    logout() { show(); void flow.logout().catch(() => notify({ phase: 'error', message: 'Mail logout could not be confirmed. Retry when online.' })); },
  };
}
module.exports = { installWorkforce };
