'use strict';
const fs = require('fs');
const path = require('path');

// Unread count from the webmail's document title. Only the webmail's own "(n) "
// prefix counts, not any number in brackets inside a subject or folder name
// ("Projects (2024)"). Capped at 9999 so the badge stays readable.
function parseUnread(title) {
  const m = /^\((\d+)\)\s/.exec(title || '');
  return m ? Math.min(parseInt(m[1], 10), 9999) : 0;
}

// Draws the unread count on the platform's badge surface. `deps` is injected so
// the logic is testable without Electron: { app, platform, getWindow, getOverlay }.
function createBadge(deps) {
  const { app, platform, getWindow, getOverlay } = deps;
  let shown = 0;

  function apply(n) {
    if (platform === 'darwin') {
      app.dock.setBadge(n ? String(n) : '');
    } else if (platform === 'win32') {
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.setOverlayIcon(n ? getOverlay() : null, n ? `${n} unread` : '');
    } else {
      app.setBadgeCount(n);
    }
  }

  return {
    // Set the badge and remember it.
    set(n) { shown = n; apply(n); },
    // Draw the remembered count again. The dock tile can lose its label (the
    // app was relaunched by the updater, Dock restarted, the system re-registered
    // the app), and the title handler only fires when the count CHANGES, so a
    // lost label would otherwise stay lost until the next new mail.
    reassert() { apply(shown); },
    get current() { return shown; },
  };
}

// macOS only enables the Notification Centre entry (banners, sounds, "Badge
// application icon") for an app after it has asked for authorization, and
// Electron asks only when the app first posts a native notification. The
// webmail uses the Web Notification API, whose permission this shell grants
// itself, so macOS is never asked until the first new-mail banner is attempted,
// which may be never. Post one quiet notification, once per profile, at a
// moment the user has just opened the app, so the system prompt appears then.
function requestNativeNotificationAuthorization(deps) {
  const { Notification, userDataDir, platform } = deps;
  if (platform !== 'darwin') return false;
  const marker = path.join(userDataDir, 'notification-authorization.json');
  try {
    if (fs.existsSync(marker)) return false;
  } catch { /* fall through and try */ }
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: 'Taifa Mail notifications are on',
    body: 'You will see new mail here. Change this in System Settings, Notifications.',
    silent: true,
  });
  n.show();
  try { fs.writeFileSync(marker, JSON.stringify({ requestedAt: new Date().toISOString() })); } catch { /* retry next launch */ }
  return true;
}

module.exports = { parseUnread, createBadge, requestNativeNotificationAuthorization };
