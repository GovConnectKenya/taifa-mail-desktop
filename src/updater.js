'use strict';

// Auto-update for Taifa Mail Desktop, backed by electron-updater.
//
// The update feed is GitHub Releases, configured by build.publish
// (provider: github) in package.json. electron-updater needs the mac "zip"
// target to exist in build.mac.target: it cannot update from a .dmg, so a
// mac release that ships only a .dmg will check, find the new version, and
// then fail to download it.
//
// On a packaged build the updater checks the feed 8 seconds after launch and
// every six hours after that, downloads any newer release in the background,
// and installs it on quit (or immediately, if the user accepts the "Update
// ready" prompt). In dev it does nothing real, it just reports a "dev" status.
//
// Note for macOS: silent auto-install requires the app to be code-signed and
// notarized. The check and download work without signing, but quitAndInstall
// on an unsigned mac build will be blocked by Gatekeeper.
//
// Why there are no ipcMain handlers in this file: this app is a thin shell
// around the REMOTE webmail at mail.govconnect.ke. The renderer is not ours,
// and it gets no preload bridge (see src/preload.js), so there is nobody to
// serve an 'update:check' IPC call and nowhere to render an update banner.
// The user-facing surface for updates is entirely in the main process: the
// tray menu and the Help menu (fed by onState), plus the one dialog below.
// That is deliberate. Do not add ipcMain handlers here expecting a renderer
// to call them.

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// state: idle | checking | available | current | downloading | ready | error | dev
let lastStatus = { state: 'idle', at: Date.now() };
let onState = () => {};
let wired = false;

// True only while a check the user explicitly asked for is in flight. It is the
// one condition under which an error is allowed to become a dialog: the user
// pressed a button and is owed an answer. Background checks stay quiet.
let manualCheck = false;

function setState(payload) {
  lastStatus = { ...payload, at: Date.now() };
  try {
    onState(lastStatus);
  } catch (e) {
    // A throwing consumer (a tray menu rebuild, say) must not take the updater
    // down with it, and must not turn into an unhandled rejection either.
    console.error('[updater] onState consumer threw:', e);
  }
}

function wireEvents() {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking' }));

  autoUpdater.on('update-available', (info) =>
    setState({ state: 'available', version: info && info.version })
  );

  autoUpdater.on('update-not-available', (info) => {
    // Terminal for a manual check: nothing more is coming, so stop treating a
    // later background error as if the user had asked for it.
    manualCheck = false;
    setState({
      state: 'current',
      version: (info && info.version) || app.getVersion(),
    });
  });

  autoUpdater.on('error', (err) => {
    const message = String((err && err.message) || err);
    // Log, report through onState, and otherwise say nothing. A modal error box
    // popping up on its own every time a background check hits a flaky network
    // is its own bug: links here are not always reliable, and a user who is
    // simply on bad hotel wifi has done nothing wrong and can do nothing about
    // it. The tray tooltip carries the bad news quietly instead.
    console.error('[updater]', message);
    const wasManual = manualCheck;
    manualCheck = false;
    setState({ state: 'error', message });
    if (wasManual) surfaceError(message);
  });

  autoUpdater.on('download-progress', (p) =>
    setState({ state: 'downloading', percent: Math.round((p && p.percent) || 0) })
  );

  autoUpdater.on('update-downloaded', (info) => {
    const version = info && info.version;
    manualCheck = false;
    setState({ state: 'ready', version });
    promptRestart(version);
  });
}

function promptRestart(version) {
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: version
        ? `Taifa Mail ${version} has been downloaded.`
        : 'A new version of Taifa Mail has been downloaded.',
      detail:
        'Restart to finish installing it. If you choose Later, the update installs the next time you quit Taifa Mail.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      // Let the download settle (and this dialog finish closing) before tearing
      // the app down, same as the template does.
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    })
    .catch((e) => console.error('[updater] restart prompt failed:', e));
}

// Only ever reached from checkManual: see the comment on the 'error' handler.
function surfaceError(message) {
  dialog
    .showMessageBox({
      type: 'warning',
      title: 'Could not check for updates',
      message: 'Taifa Mail could not reach the update server.',
      detail: `You can keep using Taifa Mail. Try again later.\n\n${message}`,
      buttons: ['OK'],
      defaultId: 0,
    })
    .catch((e) => console.error('[updater] error dialog failed:', e));
}

async function check() {
  try {
    return await autoUpdater.checkForUpdates();
  } catch (e) {
    // electron-updater normally emits 'error' for the same failure, and that
    // handler owns the reporting. Only report here if it did not, so a manual
    // check cannot produce two dialogs for one failure.
    if (manualCheck) {
      const message = String((e && e.message) || e);
      manualCheck = false;
      setState({ state: 'error', message });
      surfaceError(message);
    }
    return null;
  }
}

// { onState: (status) => void }. Called on every transition; main.js uses it to
// drive the tray tooltip and menu items.
function initUpdater(opts) {
  if (opts && typeof opts.onState === 'function') onState = opts.onState;

  if (!app.isPackaged) {
    // Nothing real to check against: a dev build has no release to compare to.
    setState({ state: 'dev', version: app.getVersion() });
    return;
  }

  wireEvents();
  setTimeout(() => check(), 8000);
  setInterval(() => check(), 6 * 60 * 60 * 1000);
}

// Tray menu and Help > Check for Updates.
async function checkManual() {
  if (!app.isPackaged) {
    setState({ state: 'dev', version: app.getVersion() });
    return;
  }
  // main.js reuses this same click handler for the tray item it relabels
  // "Restart to update" once a download has landed. Re-checking the feed then
  // would be pointless (the update is already on disk) and the item would do
  // nothing visible, so re-offer the restart the user dismissed earlier.
  if (lastStatus.state === 'ready') {
    promptRestart(lastStatus.version);
    return;
  }
  wireEvents();
  manualCheck = true;
  await check();
}

function getStatus() {
  return lastStatus;
}

module.exports = { initUpdater, checkManual, getStatus };
