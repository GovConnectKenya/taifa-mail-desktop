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
  screen,
  session,
  shell,
} = require('electron');

const { APP_URL } = require('./config');
const { harden, installSessionHandlers } = require('./security');
const windowState = require('./window-state');
const { initUpdater, checkManual, getStatus, quitAndInstallNow } = require('./updater');

const PARTITION = 'persist:taifamail';

let win = null;
let tray = null;
let trayWin = null;
let isQuitting = false;
// Unread count, parsed from the webmail's document title (see the
// page-title-updated handler). Drives the tray tooltip, the dock badge and the
// popover's inbox badge. 0 until the webmail puts a count in its title.
let unreadCount = 0;

// The tray popover's fixed size. Deliberately compact: it is a menu-bar widget,
// not a second window.
const TRAY_W = 320;
const TRAY_H = 316;

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

  // Unread count from the document title. The webmail sets its tab title to
  // "Taifa Mail (3)" style; parse the number out of it and drive the tray
  // tooltip, the dock badge and the popover from one source. This needs no
  // bridge to the remote page: the title is a public property of the WebContents.
  // Until the webmail puts a count in the title it simply reads 0, which is
  // correct rather than a guess.
  win.webContents.on('page-title-updated', (_e, title) => {
    const m = /\((\d+)\)/.exec(title || '');
    const n = m ? Math.min(parseInt(m[1], 10), 9999) : 0;
    if (n === unreadCount) return;
    unreadCount = n;
    if (process.platform === 'darwin') app.dock.setBadge(n ? String(n) : '');
    else if (typeof app.setBadgeCount === 'function') app.setBadgeCount(n);
    if (tray && !tray.isDestroyed()) tray.setToolTip(unreadTooltip(''));
    pushTrayState();
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

// The updater's onState callback: keep the tooltip and the (live) popover in
// step with download progress. The right-click menu is built on demand, so
// there is nothing to rebuild here.
function updateStatusLabel() {
  if (tray && !tray.isDestroyed()) {
    const s = getStatus();
    let suffix = '';
    if (s.state === 'downloading') suffix = ` (update ${s.percent || 0}%)`;
    else if (s.state === 'ready') suffix = ' (update ready, restart to apply)';
    else if (s.state === 'error') suffix = ' (update check failed)';
    tray.setToolTip(unreadTooltip(suffix));
  }
  pushTrayState();
}

function unreadTooltip(suffix) {
  const base = unreadCount > 0 ? `Taifa Mail (${unreadCount} unread)` : 'Taifa Mail';
  return base + (suffix || '');
}

// The classic right-click menu, built fresh each time so its update label
// reflects the current state. Returned (not set as a persistent context menu)
// so a left click can drive the popover instead.
function buildTrayMenu() {
  const s = getStatus();
  const updateLabel =
    s.state === 'ready'
      ? 'Restart to update'
      : s.state === 'downloading'
        ? `Downloading update ${s.percent || 0}%`
        : 'Check for Updates...';

  return Menu.buildFromTemplate([
    { label: 'Open Taifa Mail', click: showWindow },
    { type: 'separator' },
    {
      label: updateLabel,
      enabled: s.state !== 'downloading',
      click: () => (s.state === 'ready' ? quitAndInstallNow() : checkManual()),
    },
    { type: 'separator' },
    {
      label: 'Quit Taifa Mail',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Tray popover
//
// A frameless, transparent local window (src/tray/popover.html) shown under the
// tray icon on a left click, hidden on blur. It is a file:// page, so it gets
// the taifaShell bridge (the remote webmail never does), and every button is a
// no-argument call that main services below. The classic right-click Menu stays
// as a fallback.
// ---------------------------------------------------------------------------

// The one payload the popover renders from. Pushed on every update-state change
// and every time the popover is shown, so it never opens showing stale info.
function pushTrayState() {
  if (!trayWin || trayWin.isDestroyed()) return;
  const s = getStatus();
  trayWin.webContents.send('tray:state', {
    update: { state: s.state, percent: s.percent, version: s.version },
    unread: unreadCount,
  });
}

function createTrayWindow() {
  trayWin = new BrowserWindow({
    width: TRAY_W,
    height: TRAY_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  trayWin.loadFile(path.join(__dirname, 'tray', 'popover.html'));
  // Dismiss on click-away, the expected behaviour for a menu-bar widget.
  trayWin.on('blur', () => {
    if (trayWin && !trayWin.isDestroyed()) trayWin.hide();
  });
  // Never actually close it: hide and keep it warm so the next click is instant.
  trayWin.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    trayWin.hide();
  });
}

function toggleTrayPopover() {
  if (!trayWin || trayWin.isDestroyed()) createTrayWindow();
  if (trayWin.isVisible()) {
    trayWin.hide();
    return;
  }
  // Position centred under the tray icon, clamped so it never runs off-screen.
  try {
    const tb = tray.getBounds();
    const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
    let x = Math.round(tb.x + tb.width / 2 - TRAY_W / 2);
    x = Math.max(area.x + 6, Math.min(x, area.x + area.width - TRAY_W - 6));
    // On macOS the tray sits at the top, so drop the popover just below it. On
    // Windows/Linux the tray is usually at the bottom, so anchor to the work
    // area top edge instead of running the popover off the bottom of the screen.
    const y =
      process.platform === 'darwin'
        ? Math.round(tb.y + tb.height + 4)
        : Math.round(area.y + 6);
    trayWin.setPosition(x, y, false);
  } catch (_) {
    // A bad bounds read must not stop the popover opening; it just opens where
    // it last was.
  }
  pushTrayState();
  trayWin.show();
  trayWin.focus();
}

// -- popover actions (each wired to a tray:* IPC channel in the ready block) --

function hideTrayPopover() {
  if (trayWin && !trayWin.isDestroyed() && trayWin.isVisible()) trayWin.hide();
}

// Show the window on the app, optionally navigating it there first. Used by the
// popover's Open Inbox / New Message / Settings, which each want the window
// forward and on a specific URL.
function showAppAt(url) {
  hideTrayPopover();
  if (!win || win.isDestroyed()) {
    createWindow();
  }
  if (url) {
    showingOffline = false;
    win.loadURL(url);
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
  createTrayWindow();

  // Left click opens the popover widget; right click shows the classic menu as
  // a fallback (and the only affordance on platforms where popover positioning
  // is unreliable).
  tray.on('click', toggleTrayPopover);
  tray.on('right-click', () => {
    hideTrayPopover();
    tray.popUpContextMenu(buildTrayMenu());
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

  // Tray popover actions. Each is a fixed channel from our own file:// popover;
  // main owns the URLs and decides the action. APP_URL already ends in '/', so
  // append bare query/path segments.
  ipcMain.on('tray:open-inbox', () => showAppAt(APP_URL));
  ipcMain.on('tray:new-message', () => showAppAt(`${APP_URL}?compose=1`));
  ipcMain.on('tray:open-settings', () => showAppAt(`${APP_URL}settings`));
  ipcMain.on('tray:check-updates', () => checkManual());
  ipcMain.on('tray:restart-update', () => quitAndInstallNow());
  ipcMain.on('tray:quit', () => {
    isQuitting = true;
    app.quit();
  });

  app.on('activate', () => showWindow());
});

// Deliberately a no-op: closing the last window hides to tray, it does not quit.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
});
