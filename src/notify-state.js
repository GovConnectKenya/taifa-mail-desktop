'use strict';
const { execFile } = require('child_process');

// Whether the OS will let this app show notifications and the Dock badge.
//
// Electron 45 exposes no authorization status, and a denied macOS app does NOT
// raise Notification 'failed' (measured on macOS 27: the request logs
// "didGrant: 0 hasError: 1", the notification is still reported as shown). So
// the state comes from three sources:
//   macOS   the app's own unified-log line for requestAuthorization, read once
//           per launch (a public field, no private API, no extra permission);
//   Windows 'failed' events from notifications we post ourselves;
//   Linux   whether anything owns org.freedesktop.Notifications on the session
//           bus, plus 'failed' events.
// Everything that cannot be determined stays 'unknown', and unknown shows
// nothing: a banner that cries wolf is worse than none.

const DOCS_URL = 'https://govconnect.ke/docs';
const MAC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ke.govconnect.taifamail';
const WIN_SETTINGS_URL = 'ms-settings:notifications';

function createNotificationState() {
  let status = 'unknown'; // 'unknown' | 'ok' | 'blocked'
  let reason = '';
  const listeners = new Set();
  const emit = () => { for (const l of listeners) { try { l(api.snapshot()); } catch { /* a listener must not break the state */ } } };
  const api = {
    snapshot: () => ({ status, reason }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setBlocked(why) {
      if (status === 'blocked' && reason === why) return;
      status = 'blocked'; reason = why || 'blocked'; emit();
    },
    // A success overrides an earlier block: the user fixed it.
    setOk() {
      if (status === 'ok') return;
      status = 'ok'; reason = ''; emit();
    },
  };
  return api;
}

// -- macOS -----------------------------------------------------------------

// Reads the Electron line "Requested authorization [ didGrant: 0 hasError: 1 ...".
// Several lines may exist; the last one wins.
function parseMacAuthLog(text) {
  let verdict = 'unknown';
  for (const line of String(text || '').split('\n')) {
    const m = /Requested authorization \[\s*didGrant:\s*(\d)\s+hasError:\s*(\d)/.exec(line);
    if (!m) continue;
    verdict = m[1] === '1' && m[2] === '0' ? 'ok' : 'blocked';
  }
  return verdict;
}

function checkMacAuthorization({ exec = execFile, pid = process.pid, last = '15m' } = {}) {
  return new Promise((resolve) => {
    exec(
      '/usr/bin/log',
      ['show', '--last', last, '--info', '--debug', '--style', 'compact', '--predicate', `processID == ${pid} AND eventMessage CONTAINS "Requested authorization"`],
      { timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? 'unknown' : parseMacAuthLog(stdout)),
    );
  });
}

// -- Linux -----------------------------------------------------------------

function parseDbusNameHasOwner(text) {
  if (/boolean true/.test(text || '')) return 'ok';
  if (/boolean false/.test(text || '')) return 'blocked';
  return 'unknown';
}

function checkLinuxNotificationService({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(
      'dbus-send',
      ['--session', '--dest=org.freedesktop.DBus', '--print-reply', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.Notifications'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? 'unknown' : parseDbusNameHasOwner(stdout)),
    );
  });
}

// One probe per launch, per platform. Windows has nothing to read ahead of
// time, so it stays unknown until a 'failed' event.
async function detect({ platform, execFileFn } = {}) {
  if (platform === 'darwin') return { status: await checkMacAuthorization({ exec: execFileFn }), reason: 'macos-authorization' };
  if (platform === 'linux') return { status: await checkLinuxNotificationService({ exec: execFileFn }), reason: 'linux-no-notification-service' };
  return { status: 'unknown', reason: '' };
}

// -- guidance --------------------------------------------------------------

function settingsTarget(platform) {
  if (platform === 'darwin') return { url: MAC_SETTINGS_URL, button: 'Open settings' };
  if (platform === 'win32') return { url: WIN_SETTINGS_URL, button: 'Open settings' };
  return { url: DOCS_URL, button: 'How to fix' };
}

// The webmail's enable button needs Notification.permission to read 'default'
// while the OS blocks notifications: its ensureNotificationPermission() returns
// early on 'denied' and never calls requestPermission(). Electron's check
// handler can only answer allowed or not (the page then reads 'denied'), so the
// app overrides the getter in the page instead (see PERMISSION_OVERRIDE_JS in
// main.js). This builds that script for the given state.
function permissionOverrideScript(blocked) {
  return `(() => {
    try {
      if (typeof Notification === 'undefined') return;
      const K = '__taifaPermDesc';
      if (${blocked ? 'true' : 'false'}) {
        if (!window[K]) window[K] = Object.getOwnPropertyDescriptor(Notification, 'permission') || null;
        Object.defineProperty(Notification, 'permission', { configurable: true, enumerable: true, get: () => 'default' });
      } else if (K in window) {
        if (window[K]) Object.defineProperty(Notification, 'permission', window[K]);
        else delete Notification.permission;
        delete window[K];
      }
    } catch (_) {}
  })()`;
}

// Opens the OS notification settings at most once per user gesture, and never
// more often than minIntervalMs. A request with no gesture behind it (the
// webmail asking on its own at startup) does nothing, so the app never throws a
// settings window at someone who did not click anything.
function createSettingsGate({ now = Date.now, gestureWindowMs = 3000, minIntervalMs = 15000 } = {}) {
  let lastGesture = -Infinity;
  let lastOpen = -Infinity;
  return {
    noteGesture() { lastGesture = now(); },
    shouldOpen() {
      const t = now();
      if (t - lastGesture > gestureWindowMs) return false;
      if (t - lastOpen < minIntervalMs) return false;
      lastOpen = t;
      return true;
    },
  };
}

// What the webmail's own permission UI should be told. Electron can only
// answer a permission CHECK with allowed or not (the page sees 'granted' or
// 'denied', never 'default'), so unknown stays allowed: the webmail then behaves
// exactly as before, and only a known OS block turns into 'denied'.
function notificationsAllowed(snapshot) {
  return snapshot.status !== 'blocked';
}

// The check handler for every permission. Non-notification permissions are
// untouched: allow-list only. `isAllowedOrigin` is the existing origin test.
function permissionCheck({ permission, origin, allowlist, isAllowedOrigin, snapshot }) {
  if (!isAllowedOrigin(origin) || !allowlist.has(permission)) return false;
  if (permission === 'notifications') return notificationsAllowed(snapshot);
  return true;
}

// The request handler. Notification.requestPermission() reaches it even when the
// check said 'denied' (measured, Electron 45), which makes it the hook for the
// webmail's "enable" action: when the OS has blocked notifications, send the
// user to the OS switch. Returns { grant, openSettings }.
function permissionRequest({ permission, url, allowlist, isAllowedOrigin, snapshot }) {
  if (!isAllowedOrigin(url) || !allowlist.has(permission)) return { grant: false, openSettings: false };
  if (permission === 'notifications' && !notificationsAllowed(snapshot)) return { grant: false, openSettings: true };
  return { grant: true, openSettings: false };
}

// Linux needs words as well as a link: with no notification service there is no
// settings pane to open.
function linuxGuidance(reason) {
  if (reason === 'linux-no-notification-service') {
    return 'No notification service is running, so Taifa Mail cannot show new-mail banners. Install one (dunst, mako, or your desktop environment\u2019s) and start a new session.';
  }
  return 'Notifications are blocked for Taifa Mail. Check your desktop environment\u2019s notification settings.';
}

module.exports = {
  createNotificationState, parseMacAuthLog, checkMacAuthorization, parseDbusNameHasOwner,
  checkLinuxNotificationService, detect, settingsTarget, notificationsAllowed,
  permissionCheck, permissionRequest, linuxGuidance, permissionOverrideScript, createSettingsGate,
  DOCS_URL, MAC_SETTINGS_URL, WIN_SETTINGS_URL,
};
