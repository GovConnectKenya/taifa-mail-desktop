'use strict';

// Taifa Mail desktop: a thin shell around the webmail at mail.govconnect.ke.
//
// There is no local renderer for the app itself. The webmail talks to its
// backend over same-origin relative paths with HttpOnly cookies, and derives
// its WebSocket URL from window.location.host, so a window pointed straight at
// the real origin inherits working auth, CSRF, passkeys and live mail events
// for free. Bundling the SvelteKit build locally would mean reworking all four
// of those in code that the sibling govconnect.ke app also depends on.
//
// The only local page is src/shell/offline.html, shown when the document
// itself cannot load.

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  powerMonitor,
  session,
  shell,
} = require('electron');

const { APP_URL } = require('./config');
const { harden, installSessionHandlers } = require('./security');
const windowState = require('./window-state');
const { initUpdater, checkManual, getStatus } = require('./updater');

const PARTITION = 'persist:taifamail';

let win = null;
let tray = null;
let isQuitting = false;

// Offline retry state. Reset every time we successfully load the app.
let retryTimer = null;
let retryAttempt = 0;
let showingOffline = false;

// The single instance lock must be taken before anything else, and crucially
// before app.whenReady(). A second launch (including one carrying a mailto:
// argument) should focus the running window, not start a rival process with a
// second lock on the same cookie jar.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Appending rather than replacing keeps the real Chrome UA intact, so backend
// UA parsing and security logs keep working. This suffix is how the web app can
// tell it is running inside the shell without us exposing any preload bridge:
// navigator.userAgent.includes('TaifaMailDesktop').
app.userAgentFallback = `${app.userAgentFallback} TaifaMailDesktop/${app.getVersion()}`;

// Required on Windows for notifications to be attributed to the app rather than
// to electron.exe, and for correct taskbar grouping. Must match build.appId.
app.setAppUserModelId('ke.govconnect.taifamail');

function brandingPath(file) {
  return path.join(__dirname, '..', 'assets', 'branding', file);
}

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  clearRetry();
  // 2s, 4s, 8s, 16s, then hold at 30s. Long enough not to hammer a server that
  // is down, short enough that a user watching the window sees it come back.
  const delay = Math.min(2000 * Math.pow(2, retryAttempt), 30000);
  retryAttempt += 1;

  pushShellState({
    attempt: retryAttempt,
    nextRetryInSeconds: Math.round(delay / 1000),
    message: 'Waiting to reconnect',
  });

  retryTimer = setTimeout(() => loadApp(), delay);
}

function pushShellState(state) {
  if (win && !win.isDestroyed() && showingOffline) {
    win.webContents.send('shell:state', state);
  }
}

function showOffline() {
  showingOffline = true;
  win.loadFile(path.join(__dirname, 'shell', 'offline.html'));
  // The page subscribes on load, so announce the first countdown once it is up
  // rather than into the void.
  win.webContents.once('did-finish-load', () => scheduleRetry());
}

function loadApp() {
  clearRetry();
  showingOffline = false;
  win.loadURL(APP_URL);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const bounds = windowState.restoreBounds({ width: 1200, height: 820 });

  win = new BrowserWindow({
    ...bounds,
    minWidth: 940,
    minHeight: 640,
    show: false,
    // Brand black, so a cold start does not flash white before the app paints.
    backgroundColor: '#050100',
    icon: process.platform === 'linux' ? brandingPath('icon.png') : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 22 } : undefined,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: true,
      // Load-bearing, not a nicety. Closing to tray hides the window, and a
      // hidden window gets Chromium background throttling, which clamps timers
      // to roughly 1Hz. The webmail's mailbox WebSocket runs a 30s heartbeat and
      // treats more than 75s of silence as a dead socket, so throttled timers
      // make that logic misfire. A mail client that stops noticing mail while
      // minimised is broken.
      backgroundThrottling: false,
    },
  });

  if (bounds.isMaximized) win.maximize();
  windowState.track(win);

  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    // ERR_ABORTED. Fires routinely on redirects and on a load we superseded
    // ourselves. Treating it as an outage would flash the offline page during
    // ordinary navigation.
    if (code === -3) return;
    console.error('[shell] main frame failed to load', code, desc, url);
    showOffline();
  });

  win.webContents.on('did-finish-load', () => {
    // Only a real app load clears the backoff. The offline page finishing its
    // own load must not reset the counter, or the backoff never grows.
    if (!showingOffline) {
      retryAttempt = 0;
      clearRetry();
    }
  });

  // Keep the app alive in the tray. A mail client that quits when you close the
  // window cannot notify you of mail.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });

  loadApp();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateStatusLabel() {
  if (!tray || tray.isDestroyed()) return;
  const s = getStatus();
  let suffix = '';
  if (s.state === 'downloading') suffix = ` (update ${s.percent || 0}%)`;
  else if (s.state === 'ready') suffix = ' (update ready, restart to apply)';
  else if (s.state === 'error') suffix = ' (update check failed)';
  tray.setToolTip(`Taifa Mail${suffix}`);
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const s = getStatus();
  const updateLabel =
    s.state === 'ready'
      ? 'Restart to update'
      : s.state === 'downloading'
        ? `Downloading update ${s.percent || 0}%`
        : 'Check for Updates...';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Taifa Mail', click: showWindow },
      { type: 'separator' },
      {
        label: updateLabel,
        enabled: s.state !== 'downloading',
        click: () => checkManual(),
      },
      { type: 'separator' },
      {
        label: 'Quit Taifa Mail',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  // On macOS the menu bar recolours a template image for light and dark, so it
  // must be the monochrome asset, never the colour logo.
  const image =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(brandingPath('trayTemplate.png'))
      : nativeImage.createFromPath(brandingPath('tray-win.ico'));

  if (process.platform === 'darwin') image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip('Taifa Mail');
  buildTrayMenu();
  // Windows and Linux users expect a left click to open the app. On macOS a
  // left click opens the context menu, which Tray does for us.
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow();
  });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function createAppMenu() {
  // Not optional, and not polish. On macOS, without an app menu carrying the
  // editMenu roles, Cmd+C / Cmd+V / Cmd+A do not work in the composer in a
  // packaged build. People write real email in this thing.
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Taifa Mail Help',
          click: () => shell.openExternal('https://govconnect.ke/docs'),
        },
        { label: 'Check for Updates...', click: () => checkManual() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Hook every WebContents at creation, including any child or iframe contents,
// so the navigation lock applies by construction rather than per window.
app.on('web-contents-created', (_e, wc) => harden(wc));

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  installSessionHandlers(ses);
  ses.setSpellCheckerLanguages(['en-GB', 'en-US']);

  createAppMenu();
  createWindow();
  createTray();

  initUpdater({ onState: updateStatusLabel });

  // A laptop waking from sleep has a dead socket and, often, no network yet.
  // If we are sitting on the offline page, try again immediately rather than
  // waiting out a backoff that started before the lid closed.
  powerMonitor.on('resume', () => {
    if (showingOffline) {
      retryAttempt = 0;
      loadApp();
    }
  });

  // Retry now, from the offline page's button.
  ipcMain.on('shell:retry', () => {
    retryAttempt = 0;
    loadApp();
  });

  app.on('activate', () => showWindow());
});

// Deliberately a no-op: closing the last window hides to tray, it does not quit.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
});
