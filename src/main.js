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
  WebContentsView,
  clipboard,
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

// Test runs point the logs folder somewhere disposable.
if (process.env.TAIFA_LOGS_DIR) app.setAppLogsPath(process.env.TAIFA_LOGS_DIR);

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
const { harden, installSessionHandlers, openExternally, setAppWindowOpener } = require('./security');
const { installBundle, uninstallBundle, bundleInfo } = require('./bundle');
const { mailtoToRoute } = require('./mailto');
const { createNotificationState, detect: detectNotificationState, settingsTarget, linuxGuidance, permissionOverrideScript, createSettingsGate, DOCS_URL } = require('./notify-state');
const { createFallback, fallbackBody, pickNew } = require('./notify-fallback');
const { formatLine, appendLine } = require('./notify-log');
const { ABOUT_SIZE, aboutLink, chromiumLicencePath, buildAboutInfo } = require('./about');
const { shouldReloadAfterFailedNavigation } = require('./route');
const { handleWillPreventUnload } = require('./unload-guard');
const windowState = require('./window-state');
const { parseUnread, createBadge, SEED_NOTIFY_PREF_JS } = require('./badge');
const { initUpdater, checkManual, checkNow, getStatus, quitAndInstallNow } = require('./updater');

const { registerUiScheme, installUiScheme, uiUrl } = require('./ui-scheme');
const { PAGE_SHIM_JS, parseMarker, normaliseState } = require('./page-shim');
const { actionScript } = require('./page-actions');
const { buildMenuTemplate, menuSignature } = require('./menu');
const { buildContextMenuTemplate, pickSpellLanguages } = require('./context-menu');
const { createNotifier } = require('./notifier');
const { printConversation } = require('./print');
const { dropAlert } = require('./drop');
const { testNotificationReport } = require('./notify-test');
const { connectionView, createServerHealth } = require('./connection');
const { linkStatusParts } = require('./link-status');
const { createFinder } = require('./find');
const { MESSAGE_SIZE, isConversationRoute, messageWindowCss, shouldCloseOnNavigate, messageTitle } = require('./message-window');
const prefs = require('./prefs');

const PARTITION = 'persist:taifamail';

// Must be registered before 'ready'. Serves the tray popover and the offline
// page (see ui-scheme.js for why they are not file:// pages).
registerUiScheme();

let win = null;
let tray = null;
let trayWin = null;
let aboutWin = null;
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

// Every webmail window: the primary one (win) and any opened with File > New
// Window or "Open Conversation in New Window". They share the session, so they
// are the same signed-in mailbox.
const mailWindows = new Set();
// Page state per window (page-shim.js), keyed by webContents id.
const pageStates = new Map();

function mailWebPreferences() {
  return {
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
  };
}

function isMailWindow(w) {
  return !!(w && !w.isDestroyed() && mailWindows.has(w));
}

// Edit > Find > Find in Message (find.js).
const finder = createFinder({ WebContentsView, uiUrl, preload: path.join(__dirname, 'preload.js'), isMailWindow });

// What every webmail window gets, primary or not.
function wireMailWindow(w) {
  mailWindows.add(w);
  const wc = w.webContents;
  const wcId = wc.id;
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) w.on(ev, () => syncAudioMute(w));
  w.on('focus', () => scheduleMenuRefresh());
  wc.on('dom-ready', () => applyPageShim(w));
  wc.on('dom-ready', () => applyPermissionOverride(w));
  wc.on('console-message', (event, ...rest) => {
    const d = typeof event === 'object' && event && typeof event.message === 'string' ? event : { level: rest[0], message: rest[1] };
    if (handlePageMarker(w, d.message)) return;
    logPageConsole(d.level, d.message);
  });
  // A settings click is the only time the OS settings may open (settingsGate).
  wc.on('input-event', (_e, input) => {
    if (input && (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown')) settingsGate.noteGesture();
  });
  wc.on('context-menu', (_e, params) => showContextMenu(w, params));
  // The link status bubble: where a hovered link goes (link-status.js).
  wc.on('update-target-url', (_e, url) => {
    const parts = linkStatusParts(url, APP_ORIGIN);
    wc.executeJavaScript(`window.__taifaPageShim && window.__taifaPageShim.link && window.__taifaPageShim.link(${JSON.stringify(parts)})`).catch(() => {});
  });
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      pageStates.delete(wcId);
      scheduleMenuRefresh();
    }
  });
  wc.on('zoom-changed', (_e, dir) => zoomBy(w, dir === 'in' ? 0.5 : -0.5));

  // The macOS title bar is hidden and the traffic lights sit over the
  // webmail's top bar, so that bar must leave room for them and act as the
  // window's drag handle. Injected here, as app chrome, rather than written
  // into the webmail: the browser build never gets it.
  //
  // Only while the traffic lights are visible: in full screen macOS hides them
  // (and a full-screen window cannot be dragged), so the inset is switched off
  // and the top bar sits at the far left exactly as on the web. A zoomed
  // (maximised) window still shows the traffic lights, so it keeps the inset.
  if (process.platform === 'darwin') {
    wc.on('dom-ready', () => {
      // A repeat dom-ready for the same document just adds an identical sheet.
      wc.insertCSS(MAC_TITLEBAR_CSS, { cssOrigin: 'user' }).catch(() => {});
      syncWindowChrome(w);
    });
    wc.on('did-finish-load', () => syncWindowChrome(w));
    w.on('enter-full-screen', () => syncWindowChrome(w));
    w.on('leave-full-screen', () => syncWindowChrome(w));
  }

  // The webmail cancels beforeunload while a send is pending. Without this
  // handler that silently blocks reloads, quit and the updater restart.
  wc.on('will-prevent-unload', (e) => {
    const leave = handleWillPreventUnload({ dialog, win: w }, e);
    // Stay during a quit or an updater restart cancels the quit. Clear the flag
    // so a later window close hides to the tray again instead of destroying it.
    if (!leave) isQuitting = false;
  });

  w.on('close', () => finder.close(w, false));
  w.on('closed', () => {
    mailWindows.delete(w);
    pageStates.delete(wcId);
    scheduleMenuRefresh();
  });
}

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
    webPreferences: mailWebPreferences(),
  });

  if (bounds.isMaximized) win.maximize();
  windowState.track(win);
  wireMailWindow(win);

  win.once('ready-to-show', () => {
    win.show();
    // The window was in full screen when the app last quit: put it back.
    if (bounds.isFullScreen) win.setFullScreen(true);
    if (TIMING) console.log(`[timing] launch to ready-to-show: ${Date.now() - LAUNCHED_AT}ms`);
    // Everything that is not the window waits until it is on screen.
    setTimeout(startDeferred, 0);
  });

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
      applyPermissionOverride(win);
      applyPageShim(win);
      if (!appLoaded && process.env.TAIFA_SMOKE_NOTIFY === '1') {
        // Release smoke test hook: proves a native notification reaches the
        // platform's notification service. Never set in normal use.
        trackNotification(new Notification({ title: 'Taifa Mail smoke test', body: 'notification reached the system' })).show();
      }
      if (!appLoaded) fallback.markLoaded();
      appLoaded = true;
      if (pendingRoute) {
        const route = pendingRoute;
        pendingRoute = null;
        openRoute(route);
      }
    }
    scheduleMenuRefresh();
    pushTrayState();
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
    const prevUnread = unreadCount;
    unreadCount = n;
    considerFallback(fallback.onUnread(prevUnread, n));
    badge.set(n);
    if (n > 0) scheduleBadgeProbe();
    updateTrayTooltip();
    pushTrayState();
  });

  // Keep the app alive in the tray. A mail client that quits when you close the
  // window cannot notify you of mail.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    // Leaving full screen first: hiding a full-screen window on macOS leaves
    // an empty black Space behind.
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
      return;
    }
    win.hide();
  });

  loadApp();
}

// A second webmail window: File > New Window (a full client), or a single
// conversation in its own focused window (message-window.js). It closes for
// real, and it does not drive the badge or the offline page: the primary
// window owns those.
const messageWindows = new WeakSet();
function openMailWindow(route) {
  const anchor = BrowserWindow.getFocusedWindow() || win;
  const ab = anchor && !anchor.isDestroyed() ? anchor.getBounds() : null;
  const message = isConversationRoute(route);
  const size = message ? MESSAGE_SIZE : { width: 1200, height: 820 };
  const w = new BrowserWindow({
    ...size,
    ...(ab ? { x: ab.x + 28, y: ab.y + 28 } : {}),
    minWidth: message ? 520 : 720,
    minHeight: 520,
    show: false,
    backgroundColor: THEME_BG[currentTheme],
    icon: process.platform === 'linux' ? brandingPath('icon.png') : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 14 } : undefined,
    title: message ? 'Taifa Mail' : undefined,
    webPreferences: mailWebPreferences(),
  });
  if (message) {
    messageWindows.add(w);
    const wc = w.webContents;
    // Reader only, styled before the page draws, so the full client never flashes.
    wc.on('dom-ready', () => { wc.insertCSS(messageWindowCss(process.platform), { cssOrigin: 'user' }).catch(() => {}); });
    // The title is the subject, not the page's "Inbox · Taifa Mail".
    w.on('page-title-updated', (e) => e.preventDefault());
    // A window for THIS conversation: when it goes away, so does the window.
    let home = '';
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame === false || !home) return;
      if (shouldCloseOnNavigate(home, url) && !w.isDestroyed()) w.close();
    });
    wc.on('did-finish-load', () => {
      home = wc.getURL();
      if (process.platform !== 'darwin') w.setMenuBarVisibility(false);
    });
  }
  wireMailWindow(w);
  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) {
      w.show();
      w.focus();
    }
  });
  w.webContents.on('did-finish-load', () => {
    applyPermissionOverride(w);
    applyPageShim(w);
    scheduleMenuRefresh();
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    // The primary window owns the offline page and its retries.
    console.warn(`[shell] extra window failed to load (${code} ${desc}): ${url}`);
    if (!w.isDestroyed()) w.close();
    showWindow();
  });
  w.loadURL(new URL(route || '/', APP_ORIGIN).toString());
  return w;
}

// A message window's title follows its conversation's subject.
const SUBJECT_JS = "(() => { const h = document.querySelector('.tm-reader[data-open=\"1\"] h1'); return h ? h.textContent : ''; })()";
function syncMessageTitle(w) {
  if (!messageWindows.has(w) || w.isDestroyed()) return;
  w.webContents.executeJavaScript(SUBJECT_JS, true).then((s) => { if (!w.isDestroyed() && s) w.setTitle(messageTitle(s)); }).catch(() => {});
}

// The webmail window an action applies to: the focused one, else the primary.
function targetWindow() {
  const f = BrowserWindow.getFocusedWindow();
  if (isMailWindow(f)) return f;
  return win && !win.isDestroyed() ? win : null;
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  // macOS: an app hidden with Cmd+H keeps its windows hidden until the APP is
  // unhidden, and win.show() alone does not do that.
  if (process.platform === 'darwin') app.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

// The page shim (page-shim.js): reports window.focus() calls, takes over the
// page's new-mail notifications, reports what the page is showing (for the
// menus and the tray) and handles files dropped on the window. It talks back
// only through console markers, read in handlePageMarker.
//
// Why window.focus() needs it: a notification click in the page calls
// window.focus(), and measured in Electron 45 a renderer window.focus() reaches
// the browser process as NOTHING (no webContents or window event, the window
// stays hidden, minimised or behind), on every platform. The shim reports the
// call and main brings the window to the front. A page that fakes the marker
// can do no more than raise the window it already owns.
function applyPageShim(w) {
  if (!isMailWindow(w)) return;
  if (w === win && showingOffline) return;
  w.webContents.executeJavaScript(PAGE_SHIM_JS).catch(() => {});
}

// Page audio plays only while its window is in front. The webmail plays its own
// chime on a new message (when its Sound preference is on) and, with the window
// in the background, the OS plays the notification's sound: two sounds. Muting
// the page while it is not in front leaves exactly one.
function windowInFront(w = win) {
  return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused());
}

// Any webmail window in front: the user is looking at the app.
function appInFront() {
  for (const w of mailWindows) if (windowInFront(w)) return true;
  return false;
}

function syncAudioMute(w) {
  if (!w || w.isDestroyed()) return;
  w.webContents.setAudioMuted(!windowInFront(w));
}

// -- notification diagnostics and the new-mail safety net ---------------------
const logsDir = () => app.getPath('logs');
const notifyLogFile = () => path.join(logsDir(), 'notifications.log');
const pageLogFile = () => path.join(logsDir(), 'page-console.log');
const fallback = createFallback();

function logNotify(event, extra) {
  appendLine(notifyLogFile(), formatLine({
    event,
    os: notifyState.snapshot().status,
    osReason: notifyState.snapshot().reason,
    front: appInFront(),
    unread: unreadCount,
    ...extra,
  }));
}

// The page's console: warnings and errors only, truncated, to a log file.
function logPageConsole(level, message) {
  if (level !== 'warning' && level !== 'error') return;
  appendLine(pageLogFile(), formatLine({ level, msg: String(message).slice(0, 300) }));
}

// Native notifications for new mail (notifier.js). A click opens the exact
// conversation in the primary window and brings it forward.
const notifier = createNotifier({
  createNotification: (opts) => trackNotification(new Notification(opts)),
  platform: process.platform,
  onOpen: (route) => {
    showWindow();
    openRoute(route);
  },
  log: (event, extra) => logNotify(event, extra),
  soundOn: () => {
    const st = win && !win.isDestroyed() ? pageStates.get(win.webContents.id) : null;
    return !!(st && st.sound);
  },
});

// Every marker is page-controlled input: see page-shim.js.
function handlePageMarker(w, message) {
  const m = parseMarker(message);
  if (!m) return false;
  if (m.type === 'focus') {
    if (w === win) showWindow();
    else if (!w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  } else if (m.type === 'notify') {
    if (m.kind === 'attempted') fallback.pageAttempt();
    logNotify(`page-${m.kind}`, { permission: m.permission });
  } else if (m.type === 'post') {
    // The page posts when ITS window is not in front, but with several windows
    // another one may be: then the user is looking at the app, no banner.
    if (appInFront()) logNotify('notify-skipped', { reason: 'in-front' });
    else notifier.post(m.data);
  } else if (m.type === 'state') {
    pageStates.set(w.webContents.id, normaliseState(m.data));
    syncMessageTitle(w);
    scheduleMenuRefresh();
    if (w === win) {
      onSignInState(pageStates.get(w.webContents.id).signedIn);
      pushTrayState();
      updateTrayTooltip();
    }
  } else if (m.type === 'drop') {
    handleDropResult(w, m.data);
  }
  return true;
}

// Called when the unread count in the title went up while the app was not in
// front: waits a moment for the page's own notification, then, if the page
// stayed silent, announces the new mail itself (see src/notify-fallback.js). A
// second increase while waiting restarts the wait, so a burst is handled once.
let fallbackTimer = null;
let fallbackInc = null;
let inboxBaseline = null; // newest Inbox uid known at sign-in (or last announced)
function considerFallback(inc) {
  if (!inc || appInFront()) return;
  fallbackInc = fallbackInc ? { at: fallbackInc.at, delta: fallbackInc.delta + inc.delta } : inc;
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(async () => {
    const pending = fallbackInc;
    fallbackInc = null;
    fallbackTimer = null;
    if (appInFront() || !fallback.due(pending) || notifier.postedWithin(8000)) { logNotify('fallback-skipped', { reason: appInFront() ? 'in-front' : 'page-notified' }); return; }
    if (notifyState.snapshot().status === 'blocked') { logNotify('fallback-skipped', { reason: 'os-blocked' }); return; }
    let pref = 'on';
    try { pref = await win.webContents.executeJavaScript("localStorage.getItem('taifa_mb_notifications')"); } catch (_) { /* keep the default */ }
    if (pref === 'off') { logNotify('fallback-skipped', { reason: 'pref-off' }); return; }
    const head = await pageAction(win, 'inbox-head');
    const { fresh, baseline } = pickNew(head, inboxBaseline);
    if (head) inboxBaseline = baseline;
    if (fresh.length) {
      logNotify('fallback-posted', { reason: 'page-silent', kind: 'envelopes', n: fresh.length });
      for (const m of fresh) {
        notifier.post({ title: m.fromName || m.fromAddr, body: m.subject, snippet: m.snippet, fromAddr: m.fromAddr, tag: `mail-${m.folder}-${m.uid}` });
      }
      return;
    }
    logNotify('fallback-posted', { reason: 'page-silent', kind: head ? 'count-no-new-inbox' : 'count-no-list' });
    notifier.postFallback(unreadCount);
  }, 4000);
}

// Sign-in (or a switch of account): the count is about to jump from nothing to
// the whole unread total. Restart the settle window and take a fresh baseline
// a moment later, so only mail that arrives after sign-in is announced.
let signedIn = false;
function onSignInState(now) {
  if (now === signedIn) return;
  signedIn = now;
  inboxBaseline = null;
  if (!now) return;
  fallback.markLoaded();
  setTimeout(async () => {
    const head = await pageAction(win, 'inbox-head');
    if (head && inboxBaseline === null) inboxBaseline = pickNew(head, null).baseline;
  }, 6000);
}

// Help > Send Test Notification: posts a native notification and tells the
// user, in plain words, whether notifications work (notify-test.js). What the
// app and the page believe about permission goes to notifications.log.
async function sendTestNotification() {
  const js = (code) => (win && !win.isDestroyed() ? win.webContents.executeJavaScript(code).catch(() => 'unavailable') : Promise.resolve('no window'));
  const pagePermission = await js('typeof Notification === "undefined" ? "unsupported" : Notification.permission');
  const pagePref = await js("localStorage.getItem('taifa_mb_notifications')");
  let outcome = 'timeout';
  let reason = '';
  await new Promise((resolve) => {
    // trackNotification: a refusal also records the blocked state, so the app
    // stops reporting 'unknown' after macOS has said no.
    const n = trackNotification(new Notification({ title: 'Taifa Mail', body: 'Notifications are working. New mail will show up like this.' }));
    n.on('show', () => { outcome = 'shown'; resolve(); });
    n.on('failed', (_e, err) => { outcome = 'failed'; reason = String(err); resolve(); });
    n.on('click', () => showWindow());
    n.show();
    setTimeout(resolve, 3000);
  });
  const snap = notifyState.snapshot();
  logNotify('test', { permission: pagePermission, outcome, reason, pref: pagePref === null ? 'unset' : pagePref });
  const r = testNotificationReport({ platform: process.platform, outcome, osStatus: snap.status, pagePref });
  dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: outcome === 'failed' || snap.status === 'blocked' ? 'warning' : 'info', message: r.message, detail: r.detail, buttons: r.buttons, defaultId: 0, cancelId: r.buttons.length - 1 })
    .then(({ response }) => {
      const a = r.actions[response];
      if (a === 'os-settings') openNotificationHelp();
      else if (a === 'app-settings') openRoute('/settings');
    })
    .catch(() => {});
}

// The updater's onState callback: keep the tooltip and the (live) popover in
// step with download progress. The right-click menu is built on demand, so
// there is nothing to rebuild here.
function updateStatusLabel() {
  updateTrayTooltip();
  pushTrayState();
  pushAboutState();
}

// The one connection state (connection.js), from the primary window's page
// state, the offline page and the backend's health. The tray popover, the tray
// tooltip and the window all say the same words.
const serverHealth = createServerHealth();
function connectionInfo() {
  const st = win && !win.isDestroyed() ? pageStates.get(win.webContents.id) : null;
  return connectionView({ showingOffline, appLoaded, page: st || null, serverDown: serverHealth.down() });
}
function connectionState() {
  return connectionInfo().state;
}
// The backend's health changes without the page saying anything (a 502, a hung
// request), so it is re-read every few seconds while the tray is up.
let lastConnKey = '';
function watchConnection() {
  setInterval(() => {
    const c = connectionInfo();
    const key = `${c.state}|${c.label}`;
    if (key === lastConnKey) return;
    lastConnKey = key;
    updateTrayTooltip();
    pushTrayState();
  }, 3000).unref();
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  const s = getStatus();
  const parts = [];
  const conn = connectionInfo();
  if (conn.state !== 'online') parts.push(conn.label);
  if (s.state === 'downloading') parts.push(`update ${s.percent || 0}%`);
  else if (s.state === 'ready') parts.push('update ready, restart to apply');
  else if (s.state === 'error') parts.push('update check failed');
  tray.setToolTip(unreadTooltip(parts.length ? ` (${parts.join(', ')})` : ''));
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
      ? 'Restart to Update'
      : s.state === 'downloading'
        ? `Downloading Update ${s.percent || 0}%`
        : 'Check for Updates…';

  return Menu.buildFromTemplate([
    { label: 'Open Taifa Mail', click: showWindow },
    { label: 'New Message', click: () => composeIn(win) },
    { type: 'separator' },
    {
      label: updateLabel,
      enabled: s.state !== 'downloading',
      click: () => (s.state === 'ready' ? quitAndInstallNow() : checkForUpdatesUi()),
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

// A check the user asked for, from a menu: the About window opens and shows
// the whole story inline (checking, up to date, downloading, ready, or failed),
// the same states it shows for its own button. No silent clicks.
function checkForUpdatesUi() {
  const w = showAbout();
  const go = () => checkManual({ quiet: true });
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(go, 150));
  else go();
}

// ---------------------------------------------------------------------------
// About window
//
// A small fixed-size window served from taifa-ui://app/about/about.html. It
// replaces the native about panel. One instance: a second request focuses it.
// macOS shows only the close traffic light (minimise and zoom are disabled by
// the flags below); Windows and Linux are frameless and the page draws a close
// button. Every bridge call arrives on a fixed channel and is accepted only from
// this window's own contents.
// ---------------------------------------------------------------------------

const SMOKE_ABOUT = process.env.TAIFA_SMOKE_ABOUT === '1';

function aboutInfo() {
  return buildAboutInfo({ platform: process.platform, appVersion: app.getVersion(), bundle: bundleInfo(), update: getStatus() });
}

function pushAboutState() {
  if (!aboutWin || aboutWin.isDestroyed()) return;
  const s = getStatus();
  aboutWin.webContents.send('about:update', { state: s.state, version: s.version, percent: s.percent, fresh: true });
}

function showAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    if (aboutWin.isMinimized()) aboutWin.restore();
    aboutWin.show();
    aboutWin.focus();
    return aboutWin;
  }
  const isMac = process.platform === 'darwin';
  aboutWin = new BrowserWindow({
    width: ABOUT_SIZE.width,
    height: ABOUT_SIZE.height,
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About Taifa Mail',
    backgroundColor: THEME_BG[currentTheme],
    icon: process.platform === 'linux' ? brandingPath('icon.png') : undefined,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const w = aboutWin;
  if (!isMac) w.setMenuBarVisibility(false);
  w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
  w.on('closed', () => { if (aboutWin === w) aboutWin = null; });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.warn(`[shell] about window failed to load (${code} ${desc}): ${url}`);
  });
  w.loadURL(uiUrl('about/about.html'));
  return w;
}

function fromAbout(e) {
  return !!(aboutWin && !aboutWin.isDestroyed() && e.sender === aboutWin.webContents);
}

function registerAboutIpc() {
  ipcMain.handle('about:info', (e) => (fromAbout(e) ? aboutInfo() : null));
  ipcMain.on('about:check-updates', (e) => { if (fromAbout(e)) checkManual({ quiet: true }); });
  ipcMain.on('about:restart-update', (e) => { if (fromAbout(e)) quitAndInstallNow(); });
  ipcMain.on('about:close', (e) => { if (fromAbout(e)) aboutWin.close(); });
  ipcMain.on('about:open', (e, key) => {
    if (!fromAbout(e)) return;
    const t = aboutLink(key);
    if (!t) return;
    if (t.url) shell.openExternal(t.url).catch(() => {});
    else if (t.file) shell.openPath(chromiumLicencePath({ platform: process.platform, resourcesPath: process.resourcesPath, execPath: process.execPath })).catch(() => {});
  });
}

// Release smoke test hook (never set in normal use): TAIFA_SMOKE_DIAG=1 checks
// the notification diagnostics and the new-mail safety net with the window not
// in front: a page Notification is recorded (and suppresses the fallback), a
// silent unread increase posts the fallback, and the log has one line each.
const SMOKE_DIAG = process.env.TAIFA_SMOKE_DIAG === '1';
async function smokeDiag() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  win.hide();
  await wait(500);
  console.log(`[smoke] diag front=${windowInFront()} audioMuted=${win.webContents.isAudioMuted()}`);
  await win.webContents.executeJavaScript("new Notification('t', { tag: 'diag' }); 1");
  await wait(500);
  considerFallback({ at: Date.now(), delta: 1 });
  await wait(4800);
  console.log('[smoke] diag after a page notification: see log for fallback-skipped');
  notifyState.setOk();
  considerFallback({ at: Date.now() + 10000, delta: 1 });
  await wait(4800);
  try { console.log('[smoke] diag log:\n' + require('fs').readFileSync(notifyLogFile(), 'utf8')); } catch (e) { console.log(`[smoke] diag no log ${e.message}`); }
  console.log('[smoke] done');
  isQuitting = true;
  app.quit();
}

// Release smoke test hook (never set in normal use): TAIFA_SMOKE_PERM=1 forces
// the OS-blocked state and reports what the page sees: Notification.permission
// (must read 'default'), what requestPermission() resolves to (must be
// 'denied') and how many times the OS settings were asked to open.
const SMOKE_PERM = process.env.TAIFA_SMOKE_PERM === '1';
async function smokePerm() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let opened = 0;
  settingsOpenHook = () => { opened += 1; };
  await wait(3000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  console.log(`[smoke] perm before block: ${await js('Notification.permission')}`);
  notifyState.setBlocked('smoke');
  await wait(600);
  console.log(`[smoke] perm blocked: ${await js('Notification.permission')}`);
  // No gesture (webmail asking on its own): must not open settings.
  const r0 = await js("Notification.requestPermission()");
  console.log(`[smoke] perm request without gesture: ${r0} settingsOpened=${opened}`);
  // A click, then the request: opens once; a second request right after must not.
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 300, y: 300, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 300, y: 300, button: 'left', clickCount: 1 });
  await wait(300);
  const r1 = await js("Notification.requestPermission()");
  const r2 = await js("Notification.requestPermission()");
  console.log(`[smoke] perm request after click: ${r1} then ${r2} settingsOpened=${opened}`);
  notifyState.setOk();
  await wait(600);
  console.log(`[smoke] perm unblocked: ${await js('Notification.permission')}`);
  console.log('[smoke] done');
  isQuitting = true;
  app.quit();
}

// Release smoke test hook (never set in normal use): TAIFA_SMOKE_FOCUS=1 puts
// the main window in each "not in front" state, then calls window.focus() from
// the page (with a user gesture, as a notification click does) and reports what
// the window did. This is how the click path was measured.
const SMOKE_FOCUS = process.env.TAIFA_SMOKE_FOCUS === '1';
async function smokeFocus() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => `visible=${win.isVisible()} minimized=${win.isMinimized()} focused=${win.isFocused()}${process.platform === 'darwin' ? ` appHidden=${app.isHidden()}` : ''}`;
  await wait(2500);
  if (process.env.TAIFA_SMOKE_EVENTS === '1') for (const [label, o] of [['wc', win.webContents], ['win', win], ['app', app]]) { const e = o.emit; o.emit = function (n, ...a) { if (!/^(did-|page-|console|-)/.test(String(n))) console.log(`[evt] ${label} ${String(n)}`); return e.call(this, n, ...a); }; }
  const scenarios = [
    ['focused window', () => {}],
    ['minimised', () => win.minimize()],
    ['hidden to tray', () => win.hide()],
    ...(process.platform === 'darwin' ? [['app hidden (Cmd+H)', () => app.hide()]] : []),
  ];
  for (const [name, setup] of scenarios) {
    showWindow();
    await wait(600);
    setup();
    await wait(800);
    const before = state();
    const vis = await win.webContents.executeJavaScript("JSON.stringify({ hidden: document.hidden, vs: document.visibilityState, hasFocus: document.hasFocus() })").catch(() => '?');
    console.log(`[smoke] page view in '${name}': ${vis}`);
    // Same handler shape as the webmail's desktop-notify.ts: a Notification
    // whose onclick calls window.focus(). The click itself is dispatched from
    // script (an OS banner click cannot be driven from here).
    await win.webContents.executeJavaScript(
      "(() => { const n = new Notification('Taifa Mail focus test', { tag: 'focus-test' }); n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); }; n.dispatchEvent(new Event('click')); return 1; })()", true).catch(() => {});
    await wait(900);
    console.log(`[smoke] focus ${name}: before(${before}) after window.focus()(${state()})`);
  }
  console.log('[smoke] done');
  isQuitting = true;
  app.quit();
}

// Release smoke test hook (never set in normal use): TAIFA_SMOKE_ABOUT=1 opens
// the About window, reports what it rendered and whether it got its bridge,
// saves a light and a dark screenshot into TAIFA_SMOKE_ABOUT_DIR, then quits.
async function smokeAbout() {
  const fs = require('fs');
  const dir = process.env.TAIFA_SMOKE_ABOUT_DIR;
  const w = showAbout();
  try {
    await new Promise((resolve, reject) => {
      w.webContents.once('did-finish-load', resolve);
      w.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
    });
    await new Promise((r) => setTimeout(r, 900));
    const probe = await w.webContents.executeJavaScript(
      "JSON.stringify({ href: location.href, bridge: typeof window.taifaAbout, shell: typeof window.taifaShell, version: document.getElementById('v-app').textContent, webmail: document.getElementById('v-web').textContent, status: document.getElementById('status').textContent, closeButton: getComputedStyle(document.getElementById('close')).display, font: document.fonts.check(\"14px 'Google Sans'\") })");
    console.log(`[smoke] about loaded ${probe}`);
    const b = w.getContentBounds();
    console.log(`[smoke] about size ${b.width}x${b.height} resizable=${w.isResizable()} minimizable=${w.isMinimizable()} maximizable=${w.isMaximizable()}`);
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      for (const scheme of ['light', 'dark']) {
        nativeTheme.themeSource = scheme;
        await new Promise((r) => setTimeout(r, 700));
        const img = await w.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `about-${scheme}-${process.platform}.png`), img.toPNG());
        console.log(`[smoke] about screenshot ${scheme}`);
      }
      // The update states, pushed over the real channel, in both schemes.
      const states = {
        checking: { state: 'checking' },
        current: { state: 'current' },
        ready: { state: 'ready', version: '0.2.2' },
        error: { state: 'error' },
      };
      for (const scheme of ['light', 'dark']) {
        nativeTheme.themeSource = scheme;
        for (const [name, s] of Object.entries(states)) {
          w.webContents.send('about:update', s);
          await new Promise((r) => setTimeout(r, 400));
          fs.writeFileSync(path.join(dir, `about-${name}-${scheme}-${process.platform}.png`), (await w.webContents.capturePage()).toPNG());
        }
      }
      const layout = await w.webContents.executeJavaScript(
        "(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const tag = document.querySelector('.tag').getBoundingClientRect(); const foot = document.querySelector('footer').getBoundingClientRect(); return JSON.stringify({ tagLeft: Math.round(tag.left), tagRight: Math.round(tag.right), width: innerWidth, height: innerHeight, buttonBottom: Math.round(r('update').bottom), footerTop: Math.round(foot.top), footerBottom: Math.round(foot.bottom) }); })()");
      console.log(`[smoke] about layout ${layout}`);
      w.webContents.send('about:update', { state: 'idle' });
      // The licences view, scrolled to the top, in the current (dark) scheme.
      await w.webContents.executeJavaScript("document.getElementById('lic').click()");
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.join(dir, `about-licences-dark-${process.platform}.png`), (await w.webContents.capturePage()).toPNG());
    }
    // A second request must focus the same window, not make another.
    const again = showAbout();
    console.log(`[smoke] about single instance ${again === w} windows=${BrowserWindow.getAllWindows().filter((x) => x.webContents.getURL().includes('about/about.html')).length}`);
    // Escape closes (from the licences view the first press steps back).
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await new Promise((r) => setTimeout(r, 300));
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await new Promise((r) => setTimeout(r, 600));
    console.log(`[smoke] about closed by escape ${w.isDestroyed()}`);
  } catch (e) {
    console.log(`[smoke] about FAILED ${e && e.message}`);
  }
  console.log('[smoke] done');
  isQuitting = true;
  app.quit();
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
    conn: connectionInfo(),
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

// Runs one page action (page-actions.js) in a webmail window. Resolves to the
// action's result, or null when the window cannot take it.
function pageAction(w, name, arg) {
  if (!isMailWindow(w) || (w === win && (!appLoaded || showingOffline))) return Promise.resolve(null);
  return w.webContents.executeJavaScript(actionScript(name, arg), true).catch((e) => {
    console.warn(`[shell] page action ${name} failed:`, e && e.message);
    return null;
  });
}

function openRoute(route, target) {
  const w = target && isMailWindow(target) ? target : win;
  if (!w || w.isDestroyed()) {
    pendingRoute = route;
    createWindow();
    return;
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (w === win && (!appLoaded || showingOffline)) {
    pendingRoute = route;
    return;
  }
  w.webContents
    .executeJavaScript(actionScript('navigate', route), true)
    .catch((e) => {
      if (!shouldReloadAfterFailedNavigation(w.webContents.getURL(), APP_ORIGIN)) {
        console.warn('[shell] in-page navigation failed, not reloading the webmail:', e && e.message);
        return;
      }
      w.loadURL(new URL(route, APP_ORIGIN).toString());
    });
}

// New message in a window, composed over whatever folder it shows.
function composeIn(w) {
  const t = isMailWindow(w) ? w : win;
  if (!t || t.isDestroyed() || (t === win && (!appLoaded || showingOffline))) {
    openRoute(COMPOSE_ROUTE);
    return;
  }
  if (t === win) showWindow();
  else {
    t.show();
    t.focus();
  }
  pageAction(t, 'compose');
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

// -- the webmail's enable path ------------------------------------------------
// While the OS blocks notifications the page must read Notification.permission
// as 'default' (so its enable button calls requestPermission), see
// permissionOverrideScript in notify-state.js. Re-applied on every document and
// whenever the state flips. The request handler then opens the OS settings and
// answers 'denied', but only for a click: settingsGate.
const settingsGate = createSettingsGate();

function applyPermissionOverride(w) {
  const targets = w ? [w] : [...mailWindows];
  const blocked = notifyState.snapshot().status === 'blocked';
  for (const t of targets) {
    if (!isMailWindow(t) || (t === win && showingOffline)) continue;
    t.webContents.executeJavaScript(permissionOverrideScript(blocked)).catch(() => {});
  }
}
notifyState.subscribe(() => applyPermissionOverride());

let settingsOpenHook = null; // smoke tests only
function onBlockedNotificationRequest() {
  if (!settingsGate.shouldOpen()) return;
  if (settingsOpenHook) settingsOpenHook();
  else openNotificationHelp();
}

// Re-read the OS state. The launch probe can run before macOS has logged its
// authorization verdict, so it is repeated on the first notification request
// and a few seconds after the first badge. A verdict of 'unknown' changes nothing.
function reprobeNotifications() {
  return detectNotificationState({ platform: process.platform })
    .then((r) => { if (r.status === 'blocked') notifyState.setBlocked(r.reason); else if (r.status === 'ok') notifyState.setOk(); })
    .catch(() => {});
}
let firstRequestProbe = null;
function onFirstNotificationRequest() {
  if (!firstRequestProbe) {
    firstRequestProbe = Promise.race([reprobeNotifications(), new Promise((r) => setTimeout(r, 2500))]);
  }
  return firstRequestProbe;
}
let badgeProbeScheduled = false;
function scheduleBadgeProbe() {
  if (badgeProbeScheduled) return;
  badgeProbeScheduled = true;
  setTimeout(() => { reprobeNotifications(); }, 4000);
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
//
// The inset is set in CSS pixels, which scale with the page zoom, while the
// traffic lights do not. So main keeps --taifa-tl-inset at 88 screen pixels
// whatever the zoom (syncWindowChrome); 88px is only the fallback.
const MAC_TITLEBAR_CSS = `
html:not([data-taifa-fullscreen]) .tm-shell-topbar { -webkit-app-region: drag; padding-left: var(--taifa-tl-inset, 88px) !important; }
.tm-shell-topbar :is(button, a, input, select, textarea, label, [role], [tabindex], [contenteditable], vs-input-beam) { -webkit-app-region: no-drag; }
html:not([data-taifa-fullscreen]):not(:has(.tm-shell-topbar)) body::before {
  content: ''; position: fixed; top: 0; left: 0; right: 0; height: var(--taifa-drag-h, 28px);
  -webkit-app-region: drag; z-index: 2147483647; pointer-events: none;
}
`;

// Keeps the window chrome in step with full screen and zoom: one attribute on
// <html> that only this app sets for full screen (removing an injected
// user-origin sheet is not reliable in Electron 45, so the sheet stays and keys
// off the attribute), the inset in screen pixels, and the traffic lights
// centred on the 60px top bar at any zoom.
function syncWindowChrome(w) {
  if (!isMailWindow(w) || process.platform !== 'darwin') return;
  const on = w.isFullScreen();
  const z = w.webContents.getZoomFactor() || 1;
  const inset = (88 / z).toFixed(2);
  const drag = (28 / z).toFixed(2);
  w.webContents
    .executeJavaScript(`(() => { const r = document.documentElement; r.toggleAttribute('data-taifa-fullscreen', ${on}); r.style.setProperty('--taifa-tl-inset', '${inset}px'); r.style.setProperty('--taifa-drag-h', '${drag}px'); })()`, true)
    .catch(() => {});
  if (typeof w.setWindowButtonPosition === 'function') {
    const y = Math.max(8, Math.min(40, Math.round(22 + 30 * (z - 1))));
    try { w.setWindowButtonPosition({ x: 18, y }); } catch (_) { /* older macOS */ }
  }
}

// Zoom applies to the webmail origin, so every webmail window follows (Chromium
// keeps one zoom level per origin and session), and the chrome is re-synced in
// each. Clamped to the range the webmail's layout is tested at.
function setZoom(w, level) {
  if (!isMailWindow(w)) return;
  const l = Math.max(-3, Math.min(3, level));
  w.webContents.setZoomLevel(l);
  setTimeout(() => { for (const m of mailWindows) syncWindowChrome(m); }, 50);
}
function zoomBy(w, step) {
  if (!isMailWindow(w)) return;
  setZoom(w, w.webContents.getZoomLevel() + step);
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
//
// Not optional, and not polish. On macOS, without an app menu carrying the
// edit roles, Cmd+C / Cmd+V / Cmd+A do not work in the composer in a packaged
// build. The template is built in menu.js from the focused webmail window's
// state, and rebuilt when that state changes, so items that do not apply are
// greyed out (no Reply without an open conversation, and so on).
// ---------------------------------------------------------------------------

let menuSig = '';
let menuTimer = null;

function menuPageState() {
  const w = targetWindow();
  if (!w || (w === win && (!appLoaded || showingOffline))) return null;
  return pageStates.get(w.webContents.id) || null;
}

function refreshMenu() {
  menuTimer = null;
  const template = buildMenuTemplate(
    { platform: process.platform, isPackaged: app.isPackaged, page: menuPageState(), spellcheck: prefs.get('spellcheck') !== false },
    (id, info) => runMenuAction(id, info),
  );
  const sig = menuSignature(template);
  if (sig === menuSig) return;
  menuSig = sig;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function scheduleMenuRefresh() {
  if (!menuTimer) menuTimer = setTimeout(refreshMenu, 40);
}

// The page tools a Message menu item presses (page-actions.js TOOLS).
const MESSAGE_TOOLS = {
  archive: 'Archive',
  delete: 'Delete',
  spam: 'Report spam',
  move: 'Move to folder',
  'mark-read': 'Mark as read',
  'mark-unread': 'Mark as unread',
  star: 'Star',
  unstar: 'Remove star',
};
const REPLY_TEXT = { reply: 'Reply', 'reply-all': 'Reply all', forward: 'Forward' };
// Each standard folder's route, once seen (its IMAP path comes from the server).
const folderHashes = { Inbox: '#INBOX' };

const TYPING_PROBE = "(() => { const a = document.activeElement; const t = a && a.shadowRoot && a.shadowRoot.activeElement ? a.shadowRoot.activeElement : a; return !!(t && t !== document.body && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))); })()";

// Actions about the mailbox as a whole (folders, search, settings, a new
// message) go to the main window when a message window is in front.
const MAILBOX_ACTIONS = new Set(['settings', 'new-message', 'search', 'sidebar', 'shortcuts', 'refresh']);

async function runMenuAction(id, info = {}) {
  let w = targetWindow();
  if (w && messageWindows.has(w) && (MAILBOX_ACTIONS.has(id) || id.startsWith('folder:')) && win && !win.isDestroyed()) w = win;
  const surface = () => {
    if (!w) return;
    if (w === win) showWindow();
    else {
      w.show();
      w.focus();
    }
  };
  if (id.startsWith('folder:')) {
    surface();
    const name = id.slice('folder:'.length);
    const hash = await pageAction(w, 'folder', folderHashes[name] ? { name, hash: folderHashes[name] } : { name });
    if (typeof hash === 'string' && /^#[^?#\s]{1,300}$/.test(hash)) folderHashes[name] = hash;
    return;
  }
  if (MESSAGE_TOOLS[id]) {
    // Cmd+Delete is also "delete to start of line". If the shortcut reached us
    // while a text field had focus (the menu state can lag a keystroke behind),
    // hand the key back to the page instead of deleting the conversation.
    if (id === 'delete' && info.accelerator && w) {
      const typing = await w.webContents.executeJavaScript(TYPING_PROBE, true).catch(() => false);
      if (typing) {
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['meta'] });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace', modifiers: ['meta'] });
        return;
      }
    }
    await pageAction(w, 'tool', MESSAGE_TOOLS[id]);
    return;
  }
  if (REPLY_TEXT[id]) {
    await pageAction(w, 'reply', REPLY_TEXT[id]);
    return;
  }
  switch (id) {
    case 'about': showAbout(); return;
    case 'settings': openRoute('/settings', w); return;
    case 'check-updates': checkForUpdatesUi(); return;
    case 'default-mail': app.setAsDefaultProtocolClient('mailto'); return;
    case 'new-message': composeIn(w); return;
    case 'new-window': openMailWindow('/#INBOX'); return;
    case 'open-window': {
      const route = await pageAction(w, 'conversation');
      if (typeof route === 'string') openMailWindow(route);
      return;
    }
    case 'print': printOpenConversation(w); return;
    case 'find': surface(); if (!finder.open(w)) shell.beep(); return;
    case 'find-next': finder.step(w, true); return;
    case 'find-prev': finder.step(w, false); return;
    case 'search': {
      surface();
      const ok = await pageAction(w, 'search');
      if (!ok) shell.beep();
      return;
    }
    case 'spellcheck': {
      const on = prefs.get('spellcheck') === false;
      prefs.set('spellcheck', on);
      session.fromPartition(PARTITION).setSpellCheckerEnabled(on);
      menuSig = '';
      scheduleMenuRefresh();
      return;
    }
    case 'sidebar': await pageAction(w, 'sidebar'); return;
    case 'zoom-reset': setZoom(w, 0); return;
    case 'zoom-in': zoomBy(w, 0.5); return;
    case 'zoom-out': zoomBy(w, -0.5); return;
    case 'reload': if (w) w.webContents.reload(); return;
    case 'maximise': if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return;
    case 'refresh': await pageAction(w, 'refresh'); return;
    case 'help': openExternally('https://govconnect.ke/docs'); return;
    case 'shortcuts': surface(); await pageAction(w, 'shortcuts', process.platform === 'darwin' ? 'mac' : 'other'); return;
    case 'notification-settings': openNotificationHelp(); return;
    case 'test-notification': sendTestNotification(); return;
    default:
      console.warn(`[shell] unknown menu action ${id}`);
  }
}

// File > Print: the open conversation, through the system print dialog
// (print.js), never the app window itself.
let printing = false;
async function printOpenConversation(w) {
  if (printing || !isMailWindow(w)) return;
  printing = true;
  try {
    const data = await pageAction(w, 'print');
    if (!data) {
      // No conversation open (the menu item lags the page by a moment).
      shell.beep();
      return;
    }
    if (!Array.isArray(data.messages) || !data.messages.length) {
      dialog.showMessageBox(w, { type: 'warning', message: 'This conversation can’t be printed right now', detail: 'Taifa Mail can’t reach the server, and none of its messages are open on screen. Try again when you’re back online.', buttons: ['OK'] }).catch(() => {});
      return;
    }
    await printConversation({ BrowserWindow, session, app }, data);
  } catch (e) {
    console.warn('[shell] print failed:', e && e.message);
    dialog.showMessageBox(w, { type: 'warning', message: 'Could not print this conversation', detail: String((e && e.message) || e), buttons: ['OK'] }).catch(() => {});
  } finally {
    printing = false;
  }
}

// ---------------------------------------------------------------------------
// Right-click menu (context-menu.js)
// ---------------------------------------------------------------------------

// Did a right-click land in the open conversation? A message's HTML body is a
// frame inside the reader; anything else is checked by its point.
async function contextInMessage(w, params) {
  const st = pageStates.get(w.webContents.id);
  if (!st || !st.conversation || st.modal) return null;
  const message = { canReplyAll: !!st.canReplyAll, inWindow: messageWindows.has(w) };
  if (params.frame && params.frame !== w.webContents.mainFrame) return message;
  const x = Math.round(Number(params.x) || 0);
  const y = Math.round(Number(params.y) || 0);
  const hit = await w.webContents
    .executeJavaScript(`(() => { const e = document.elementFromPoint(${x}, ${y}); return !!(e && e.closest('.tm-reader[data-open="1"]') && !e.closest('.compose')); })()`, true)
    .catch(() => false);
  return hit ? message : null;
}

async function showContextMenu(w, params) {
  const wc = w.webContents;
  const message = await contextInMessage(w, params);
  if (w.isDestroyed()) return;
  const template = buildContextMenuTemplate(params, { platform: process.platform, isDev: !app.isPackaged, message }, (id, arg) => {
    switch (id) {
      case 'menu': runMenuAction(String(arg)); break;
      case 'replace-misspelling': wc.replaceMisspelling(String(arg)); break;
      case 'add-to-dictionary': wc.session.addWordToSpellCheckerDictionary(String(arg)); break;
      case 'look-up': if (process.platform === 'darwin') wc.showDefinitionForSelection(); break;
      case 'open-link': openExternally(String(arg)); break;
      case 'copy-link': clipboard.writeText(String(arg)); break;
      case 'compose-to': {
        const route = mailtoToRoute(String(arg));
        if (route) openRoute(route, w);
        break;
      }
      case 'copy-address': {
        try {
          clipboard.writeText(decodeURIComponent(new URL(String(arg)).pathname));
        } catch (_) { /* not a mailto we can read */ }
        break;
      }
      case 'copy-image': wc.copyImageAt(Math.round(arg.x), Math.round(arg.y)); break;
      case 'inspect': wc.inspectElement(Math.round(arg.x), Math.round(arg.y)); break;
      default: break;
    }
  });
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: w, frame: params.frame || undefined });
}

// A file drop the page could not attach (page-shim.js): one accurate message
// (drop.js), on the window it happened in, at most one sheet every few seconds.
// When the page explained the failure itself, the app says nothing.
let lastDropAlert = 0;
function handleDropResult(w, data) {
  appendLine(pageLogFile(), formatLine({ level: 'info', msg: `drop ${data && data.outcome} count=${Number(data && data.count) || 0}` }));
  const alert = dropAlert(data);
  if (!alert || !isMailWindow(w)) return;
  if (Date.now() - lastDropAlert < 3000) return;
  lastDropAlert = Date.now();
  dialog.showMessageBox(w, { type: 'warning', message: alert.message, detail: alert.detail, buttons: ['OK'] }).catch(() => {});
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
  watchConnection();
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
  reprobeNotifications();
  installSessionHandlers(ses, { snapshot: () => notifyState.snapshot(), onBlockedRequest: onBlockedNotificationRequest, onFirstRequest: onFirstNotificationRequest });
  const bundled = installBundle(ses, { onTooOld: fallBackToLiveSite, onBackendRequest: (p) => serverHealth.start(p) });
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
  // Spellcheck follows the system: macOS uses its own spell checker with the
  // system languages (setSpellCheckerLanguages is a no-op there); Windows and
  // Linux get the system's preferred languages that have a dictionary.
  prefs.load(app.getPath('userData'));
  ses.setSpellCheckerEnabled(prefs.get('spellcheck') !== false);
  if (process.platform !== 'darwin') {
    try {
      ses.setSpellCheckerLanguages(pickSpellLanguages(app.getPreferredSystemLanguages(), ses.availableSpellCheckerLanguages));
    } catch (e) {
      console.warn('[shell] spellcheck languages:', e && e.message);
    }
  }

  applyTheme(await readThemePreference(ses));
  refreshMenu();
  setAppWindowOpener((route) => openMailWindow(route));
  createWindow();
  registerAboutIpc();
  if (SMOKE_ABOUT) smokeAbout();
  if (SMOKE_FOCUS) smokeFocus();
  if (SMOKE_PERM) smokePerm();
  if (SMOKE_DIAG) smokeDiag();
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

  // The find bar's calls (find.js checks the sender is one of its bars).
  for (const ch of ['find:query', 'find:step', 'find:close']) {
    ipcMain.on(ch, (e, a, b) => finder.handle(ch, e.sender, ch === 'find:step' ? undefined : a, ch === 'find:step' ? a : b));
  }

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
    composeIn(win);
  });
  ipcMain.on('tray:open-settings', () => {
    hideTrayPopover();
    openRoute('/settings');
  });
  // The popover shows the result inline, so no dialog on top of it.
  ipcMain.on('tray:check-updates', () => checkManual({ quiet: true }));
  ipcMain.on('tray:restart-update', () => quitAndInstallNow());
  ipcMain.on('tray:quit', () => {
    isQuitting = true;
    app.quit();
  });

  app.on('activate', () => {
    showWindow();
    badge.reassert();
  });
  app.on('browser-window-focus', () => {
    badge.reassert();
    scheduleMenuRefresh();
  });

  // Development runs only (never a packaged build): a handle for driving the
  // app from the Node inspector in manual and automated UI checks.
  if (!app.isPackaged) {
    global.__taifaDev = { runMenuAction, pageAction, pageStates, mailWindows, openMailWindow, openRoute, notifier, notifyState, connectionState, connectionInfo, serverHealth, printConversation: (data) => printConversation({ BrowserWindow, session, app }, data, { toPdf: true }), getWin: () => win, finder, considerFallback, getInboxBaseline: () => inboxBaseline };
  }
  // macOS: clicking a notification banner activates the app. If the window is
  // hidden or minimised at that moment, bring it back.
  if (process.platform === 'darwin') {
    app.on('did-become-active', () => {
      if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized()) && !isQuitting) showWindow();
    });
  }
});

// Deliberately a no-op: closing the last window hides to tray, it does not quit.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
});
