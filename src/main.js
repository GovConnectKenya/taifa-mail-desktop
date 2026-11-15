'use strict';

// Taifa Mail desktop.
//
// The UI is the Taifa Mail webmail itself, bundled: renderer/ holds the output
// of the webmail's desktop build, and src/bundle.js serves it for the webmail
// origin from inside the app, so the window paints from local files with no
// network round trip. Only the backend API goes over the network, through
// Chromium's own stack in this app's session, so cookies, the CSRF
// double-submit and the mailbox websocket behave exactly as in a browser on
// https://mail.govconnect.ke. docs/BUNDLED_WEBMAIL.md explains the design.
//
// A clone with no renderer/ folder still runs: bundle.js then installs nothing
// and the window loads the live site, as the thin shell did.
//
// The only other local page is src/shell/offline.html, shown when the document
// itself cannot load (in practice only in that thin-shell fallback).

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  dialog,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
} = require('electron');

const LAUNCHED_AT = Date.now();

// A packaged app never exposes the DevTools protocol. With it, any local
// process could start the app with --remote-debugging-port and read the
// signed-in session (cookies included) over a socket. The Electron fuses close
// the Node-level equivalents (--inspect, ELECTRON_RUN_AS_NODE, NODE_OPTIONS);
// this closes the Chromium one. Development runs keep it.
if (app.isPackaged) {
  for (const sw of ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address']) {
    app.commandLine.removeSwitch(sw);
  }
}

const { APP_ORIGIN, APP_URL, THEME_BG, THEME_COOKIE } = require('./config');
const { harden, installSessionHandlers } = require('./security');
const { installBundle, uninstallBundle, bundleInfo } = require('./bundle');
const { mailtoToRoute } = require('./mailto');
const { createNotificationState, detect: detectNotificationState, settingsTarget, linuxGuidance, DOCS_URL } = require('./notify-state');
const { shouldReloadAfterFailedNavigation } = require('./route');
const { handleWillPreventUnload } = require('./unload-guard');
const windowState = require('./window-state');
const { parseUnread, createBadge, SEED_NOTIFY_PREF_JS } = require('./badge');
const { initUpdater, checkManual, checkNow, getStatus, quitAndInstallNow } = require('./updater');

const { registerUiScheme, installUiScheme, uiUrl } = require('./ui-scheme');

const PARTITION = 'persist:taifamail';

// Must be registered before 'ready'. Serves the tray popover and the offline
// page (see ui-scheme.js for why they are not file:// pages).
registerUiScheme();

let win = null;
let tray = null;
let trayWin = null;
let isQuitting = false;
// Unread count, parsed from the webmail's document title (see the
// page-title-updated handler). Drives the tray tooltip, the dock badge and the
// popover's inbox badge. 0 until the webmail puts a count in its title.
let unreadCount = 0;
// The resolved webmail theme, 'light' or 'dark'. Drives the window background.
let currentTheme = 'light';
// A mailto: that arrived before the window could take it (cold start from a
// link): opened as soon as the webmail has loaded.
let pendingRoute = null;
let appLoaded = false;
// TAIFA_TIMING=1 prints launch to ready-to-show and to first load.
const TIMING = process.env.TAIFA_TIMING === '1';

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
// UA parsing and security logs keep working, and the suffix still tells them
// the request came from the desktop app.
//
// Deliberately NOT the 0.1.x token `TaifaMailDesktop`. The webmail checks for
// that token (isDesktopShell) and then takes thin-shell code paths written for
// 0.1.x's Electron 31: it hides the passkey button and the "or" divider, hides
// the workspace-account link, and changes the notification defaults. This app
// runs the webmail on its real origin with a current Chromium, so it must get
// exactly the pages a browser gets. A distinct token keeps the webmail on its
// browser paths, while installed 0.1.x apps keep theirs.
app.userAgentFallback = `${app.userAgentFallback} TaifaMailApp/${app.getVersion()}`;

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
  win.loadURL(uiUrl('shell/offline.html'));
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
    // The webmail's own page background for the current theme, so the window
    // and the first paint are the same colour: no flash on a cold start.
    backgroundColor: THEME_BG[currentTheme],
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

  win.once('ready-to-show', () => {
    win.show();
    if (TIMING) console.log(`[timing] launch to ready-to-show: ${Date.now() - LAUNCHED_AT}ms`);
    // Everything that is not the window waits until it is on screen.
    setTimeout(startDeferred, 0);
  });

  // The macOS title bar is hidden and the traffic lights sit over the
  // webmail's top bar, so that bar must leave room for them and act as the
  // window's drag handle. Injected here, as app chrome, rather than written
  // into the webmail: the browser build never gets it.
  //
  // Only while the traffic lights are visible: in full screen macOS hides them
  // (and a full-screen window cannot be dragged), so the stylesheet is removed
  // and the top bar sits at the far left exactly as on the web. A zoomed
  // (maximised) window still shows the traffic lights, so it keeps the inset.
  if (process.platform === 'darwin') {
    win.webContents.on('dom-ready', () => {
      // A repeat dom-ready for the same document just adds an identical sheet.
      win.webContents.insertCSS(MAC_TITLEBAR_CSS, { cssOrigin: 'user' }).catch(() => {});
      syncFullScreenFlag();
    });
    win.webContents.on('did-finish-load', syncFullScreenFlag);
    win.on('enter-full-screen', syncFullScreenFlag);
    win.on('leave-full-screen', syncFullScreenFlag);
  }

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
      if (TIMING && !appLoaded) console.log(`[timing] launch to webmail loaded: ${Date.now() - LAUNCHED_AT}ms`);
      win.webContents.executeJavaScript(SEED_NOTIFY_PREF_JS).catch(() => {});
      if (!appLoaded && process.env.TAIFA_SMOKE_NOTIFY === '1') {
        // Release smoke test hook: proves a native notification reaches the
        // platform's notification service. Never set in normal use.
        trackNotification(new Notification({ title: 'Taifa Mail smoke test', body: 'notification reached the system' })).show();
      }
      appLoaded = true;
      if (pendingRoute) {
        const route = pendingRoute;
        pendingRoute = null;
        openRoute(route);
      }
    }
  });

  // Unread count from the document title. The webmail sets its tab title to
  // "Taifa Mail (3)" style; parse the number out of it and drive the tray
  // tooltip, the dock badge and the popover from one source. This needs no
  // bridge to the remote page: the title is a public property of the WebContents.
  // Until the webmail puts a count in the title it simply reads 0, which is
  // correct rather than a guess.
  win.webContents.on('page-title-updated', (_e, title) => {
    const n = parseUnread(title);
    if (n === unreadCount) return;
    unreadCount = n;
    badge.set(n);
    if (tray && !tray.isDestroyed()) tray.setToolTip(unreadTooltip(''));
    pushTrayState();
  });

  // The webmail cancels beforeunload while a send is pending. Without this
  // handler that silently blocks reloads, quit and the updater restart.
  win.webContents.on('will-prevent-unload', (e) => {
    const leave = handleWillPreventUnload({ dialog, win }, e);
    // Stay during a quit or an updater restart cancels the quit. Clear the flag
    // so a later window close hides to the tray again instead of destroying it.
    if (!leave) isQuitting = false;
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
// tray icon on a left click, hidden on blur. It is a taifa-ui:// page, so it gets
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

// Release smoke test hook (never set in normal use): TAIFA_SMOKE_TRAY=1 makes
// the app report whether the tray popover and the offline page load and get
// the bridge, then quit. Needs no display tray, so it works headless.
const SMOKE_TRAY = process.env.TAIFA_SMOKE_TRAY === '1';

async function smokeProbe(label, wc, loaded) {
  try {
    await loaded;
    const r = await wc.executeJavaScript(
      "JSON.stringify({ href: location.href, title: document.title, bridge: typeof window.taifaShell, body: document.body ? document.body.children.length : 0 })");
    console.log(`[smoke] ${label} loaded ${r}`);
  } catch (e) {
    console.log(`[smoke] ${label} FAILED ${e && e.message}`);
  }
}

function smokeReportTray(w) {
  const loaded = new Promise((resolve, reject) => {
    w.webContents.once('did-finish-load', resolve);
    w.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
  });
  smokeProbe('tray popover', w.webContents, loaded).then(async () => {
    const off = new BrowserWindow({
      show: false,
      webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const offLoaded = new Promise((resolve, reject) => {
      off.webContents.once('did-finish-load', resolve);
      off.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
    });
    off.loadURL(uiUrl('shell/offline.html'));
    await smokeProbe('offline page', off.webContents, offLoaded);
    console.log('[smoke] done');
    isQuitting = true;
    app.quit();
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
  trayWin.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.warn(`[shell] tray popover failed to load (${code} ${desc}): ${url}`);
  });
  trayWin.loadURL(uiUrl('tray/popover.html'));
  if (SMOKE_TRAY) smokeReportTray(trayWin);
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

// ---------------------------------------------------------------------------
// In-app navigation
//
// Menu items, the tray popover and mailto: links all open a webmail route.
// The navigation is done the way a click on a link in the webmail would be, so
// SvelteKit's own router handles it: no reload, the session and any open
// composer state stay put. The route is always one of ours (a constant, or a
// compose route built by mailto.js), passed as JSON, never spliced in as code.
// ---------------------------------------------------------------------------

const COMPOSE_ROUTE = '/#INBOX?compose=new';

const NAVIGATE_SCRIPT = `(route) => {
  const a = document.createElement('a');
  a.href = route;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}`;

function openRoute(route) {
  if (!win || win.isDestroyed()) {
    pendingRoute = route;
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!appLoaded || showingOffline) {
    pendingRoute = route;
    return;
  }
  win.webContents
    .executeJavaScript(`(${NAVIGATE_SCRIPT})(${JSON.stringify(route)})`, true)
    .catch((e) => {
      if (!shouldReloadAfterFailedNavigation(win.webContents.getURL(), APP_ORIGIN)) {
        console.warn('[shell] in-page navigation failed, not reloading the webmail:', e && e.message);
        return;
      }
      win.loadURL(new URL(route, APP_ORIGIN).toString());
    });
}

function openMailto(url) {
  const route = mailtoToRoute(url);
  if (route) openRoute(route);
}

// ---------------------------------------------------------------------------
// Unread badge
// ---------------------------------------------------------------------------

// Windows has no numeric taskbar badge, so it gets the platform convention: a
// small overlay dot on the taskbar button, with the count as its accessible
// description. Drawn once, in code, so no extra asset ships.
let overlayDot = null;
function getOverlayDot() {
  if (overlayDot) return overlayDot;
  const size = 16;
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, size / 2 - d));
      const i = (y * size + x) * 4;
      // BGRA. Brand red #860000, the webmail's danger colour.
      px[i] = 0x00;
      px[i + 1] = 0x00;
      px[i + 2] = 0x86;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  overlayDot = nativeImage.createFromBitmap(px, { width: size, height: size });
  return overlayDot;
}

// ---------------------------------------------------------------------------
// Notification state
//
// The webmail decides whether to notify from Notification.permission, which this
// app answers in security.js. It used to answer 'granted' unconditionally, so a
// macOS app that was never authorized (banners AND the Dock badge are dropped)
// still looked fine to the webmail. Now the answer follows the true OS state, so
// the webmail's own permission UI shows the problem, and its enable action
// (Notification.requestPermission) lands in openNotificationHelp.
// ---------------------------------------------------------------------------

const notifyState = createNotificationState();

// Notifications WE post (the smoke hook) report their own outcome. A denied
// macOS app still reports 'show', so there the unified-log verdict stays in
// charge and 'show' proves nothing.
function trackNotification(n) {
  n.on('failed', () => notifyState.setBlocked('notification-failed'));
  n.on('show', () => { if (process.platform !== 'darwin') notifyState.setOk(); });
  return n;
}

function openNotificationHelp() {
  const { reason } = notifyState.snapshot();
  if (process.platform === 'linux') {
    dialog
      .showMessageBox(win && !win.isDestroyed() && win.isVisible() ? win : undefined, {
        type: 'info',
        buttons: ['Open help', 'Close'],
        defaultId: 0,
        cancelId: 1,
        title: 'Taifa Mail',
        message: 'Notifications are off for Taifa Mail',
        detail: linuxGuidance(reason),
      })
      .then(({ response }) => { if (response === 0) return shell.openExternal(DOCS_URL); })
      .catch(() => {});
    return;
  }
  shell.openExternal(settingsTarget(process.platform).url).catch(() => {});
}

const badge = createBadge({
  app,
  platform: process.platform,
  getWindow: () => win,
  getOverlay: () => getOverlayDot(),
});

// ---------------------------------------------------------------------------
// Theme
//
// The window background follows the webmail's own theme preference (its
// taifa-mail-theme cookie, 'light' | 'dark' | 'system'), so the colour behind
// the first paint, the native frame and the traffic-light area all match the
// webmail. Read from the cookie jar: nothing is asked of the page.
// ---------------------------------------------------------------------------

async function readThemePreference(ses) {
  try {
    const [c] = await ses.cookies.get({ url: APP_URL, name: THEME_COOKIE });
    const v = c && decodeURIComponent(c.value);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch (_) {
    // An unreadable jar just means the default.
  }
  return 'light';
}

function applyTheme(pref) {
  nativeTheme.themeSource = pref;
  currentTheme = pref === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : pref;
  if (win && !win.isDestroyed()) win.setBackgroundColor(THEME_BG[currentTheme]);
}

// ---------------------------------------------------------------------------
// macOS title bar
// ---------------------------------------------------------------------------

// The signed-in top bar (.tm-shell-topbar, 60px) becomes the drag handle and
// starts its content after the traffic lights. Its controls stay clickable.
// Pages without that bar (sign-in, setup) get a slim drag strip along the top
// edge instead, which takes no clicks away from the page. In full screen the
// traffic lights are hidden and the window cannot be dragged, so none of this
// applies and the top bar sits at the far left, as on the web.
const MAC_TITLEBAR_CSS = `
html:not([data-taifa-fullscreen]) .tm-shell-topbar { -webkit-app-region: drag; padding-left: 88px !important; }
.tm-shell-topbar :is(button, a, input, select, textarea, label, [role], [tabindex], [contenteditable]) { -webkit-app-region: no-drag; }
html:not([data-taifa-fullscreen]):not(:has(.tm-shell-topbar)) body::before {
  content: ''; position: fixed; top: 0; left: 0; right: 0; height: 28px;
  -webkit-app-region: drag; z-index: 2147483647; pointer-events: none;
}
`;

// Tells the injected stylesheet whether the window is in full screen, through
// one attribute on <html> that only this app sets. (Removing an injected
// user-origin sheet is not reliable in Electron 45, so the sheet stays and
// keys off the attribute instead.)
function syncFullScreenFlag() {
  if (!win || win.isDestroyed()) return;
  const on = win.isFullScreen();
  win.webContents
    .executeJavaScript(`document.documentElement.toggleAttribute('data-taifa-fullscreen', ${on})`, true)
    .catch(() => {});
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
  const isMac = process.platform === 'darwin';
  const settingsItem = { label: isMac ? 'Settings...' : 'Settings', accelerator: 'CmdOrCtrl+,', click: () => openRoute('/settings') };
  const defaultMailItem = {
    label: 'Make Taifa Mail the Default Email App',
    click: () => app.setAsDefaultProtocolClient('mailto'),
  };
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              defaultMailItem,
              { label: 'Check for Updates...', click: () => checkManual() },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Message', accelerator: 'CmdOrCtrl+N', click: () => openRoute(COMPOSE_ROUTE) },
        { label: 'Inbox', accelerator: 'CmdOrCtrl+Shift+I', click: () => openRoute('/#INBOX') },
        { type: 'separator' },
        ...(isMac ? [] : [settingsItem, defaultMailItem, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Taifa Mail Help',
          click: () => shell.openExternal('https://govconnect.ke/docs'),
        },
        { type: 'separator' },
        { label: 'Notification Settings...', click: () => openNotificationHelp() },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Check for Updates...', click: () => checkManual() }, { role: 'about' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setAboutPanel() {
  const info = bundleInfo();
  app.setAboutPanelOptions({
    applicationName: 'Taifa Mail',
    applicationVersion: app.getVersion(),
    version: info ? `webmail ${info.webmail} (${String(info.commit).slice(0, 9)})` : 'live webmail',
    iconPath: brandingPath('icon.png'),
  });
}

// The backend said the bundled webmail is older than it supports
// (X-Taifa-Min-Desktop-Bundle, see bundle.js). For the rest of this launch the
// app goes back to being the thin shell: the interception is dropped and the
// window reloads the live site, which always matches the backend. Meanwhile
// the updater fetches the app build that carries a new enough bundle and
// offers the restart.
let fellBack = false;
function fallBackToLiveSite() {
  if (fellBack) return;
  fellBack = true;
  console.warn('[shell] bundled webmail is older than the backend requires: using the live site');
  uninstallBundle(session.fromPartition(PARTITION));
  if (win && !win.isDestroyed()) {
    const current = win.webContents.getURL();
    win.loadURL(current && current.startsWith(APP_ORIGIN) ? current : APP_URL);
  }
  checkNow();
}

// Tray, popover and updater are not needed to paint the window, so they start
// only once it is on screen.
let deferredStarted = false;
function startDeferred() {
  if (deferredStarted) return;
  deferredStarted = true;
  createTray();
  initUpdater({ onState: updateStatusLabel });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Hook every WebContents at creation, including any child or iframe contents,
// so the navigation lock applies by construction rather than per window.
app.on('web-contents-created', (_e, wc) => harden(wc));

// A second launch carries its arguments here, including a mailto: link on
// Windows and Linux (macOS delivers those through open-url instead).
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => /^mailto:/i.test(a));
  if (link) openMailto(link);
  else showWindow();
});

// macOS: links arrive through open-url, which can fire before ready on a cold
// start, so it is registered at the top level and parks the route until the
// webmail has loaded.
app.on('open-url', (e, url) => {
  if (!/^mailto:/i.test(url)) return;
  e.preventDefault();
  if (app.isReady()) openMailto(url);
  else pendingRoute = mailtoToRoute(url);
});

{
  const link = process.argv.find((a) => /^mailto:/i.test(a));
  if (link) pendingRoute = mailtoToRoute(link);
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  installUiScheme(ses, __dirname);
  installUiScheme(session.defaultSession, __dirname);
  // Read the OS notification state in the background: on macOS the verdict is in
  // our own unified log within a second of launch, well before the webmail asks.
  detectNotificationState({ platform: process.platform })
    .then((r) => { if (r.status === 'blocked') notifyState.setBlocked(r.reason); else if (r.status === 'ok') notifyState.setOk(); })
    .catch(() => {});
  installSessionHandlers(ses, { snapshot: () => notifyState.snapshot(), onBlockedRequest: openNotificationHelp });
  const bundled = installBundle(ses, { onTooOld: fallBackToLiveSite });
  if (!bundled) console.warn('[shell] no bundled webmail in renderer/: loading the live site');

  // 0.1.x registered the web build's service worker in this partition, and it
  // answers "/" from its own cached copy of the OLD shell before any request
  // reaches the bundle. The bundle never serves /sw.js, so that worker could
  // never update itself away. Clear workers and Cache Storage for the webmail
  // origin on every launch; cookies, localStorage and IndexedDB are untouched,
  // so the session and preferences stay.
  try {
    await ses.clearStorageData({ origin: APP_ORIGIN, storages: ['serviceworkers', 'cachestorage'] });
  } catch (e) {
    console.warn('[shell] could not clear the old service worker:', e && e.message);
  }
  ses.setSpellCheckerLanguages(['en-GB', 'en-US']);

  applyTheme(await readThemePreference(ses));
  createAppMenu();
  createWindow();
  setAboutPanel();
  if (!app.isPackaged && process.platform === 'darwin') app.dock.setIcon(brandingPath('icon.png'));

  // Follow the webmail's theme toggle and, for 'system', the OS.
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (cookie.name !== THEME_COOKIE) return;
    readThemePreference(ses).then(applyTheme);
  });
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource === 'system') applyTheme('system');
  });

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

  // Tray popover actions. Each is a fixed channel from our own taifa-ui:// popover;
  // main owns the routes and decides the action.
  ipcMain.on('tray:open-inbox', () => {
    hideTrayPopover();
    openRoute('/#INBOX');
  });
  ipcMain.on('tray:new-message', () => {
    hideTrayPopover();
    openRoute(COMPOSE_ROUTE);
  });
  ipcMain.on('tray:open-settings', () => {
    hideTrayPopover();
    openRoute('/settings');
  });
  ipcMain.on('tray:check-updates', () => checkManual());
  ipcMain.on('tray:restart-update', () => quitAndInstallNow());
  ipcMain.on('tray:quit', () => {
    isQuitting = true;
    app.quit();
  });

  app.on('activate', () => {
    showWindow();
    badge.reassert();
  });
  app.on('browser-window-focus', () => badge.reassert());
});

// Deliberately a no-op: closing the last window hides to tray, it does not quit.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
});
