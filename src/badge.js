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

// The webmail posts its own new-mail notifications (sender and subject) through
// the Web Notification API, but only when its local preference is "on". Its
// default for that preference is "on" only for the 0.1.x user agent token
// (TaifaMailDesktop), which this app deliberately no longer sends, so on a
// fresh profile the preference is unset and the webmail stays silent. Seed it
// to "on" ONLY when it was never set: an explicit "off" is the user's choice.
const NOTIFY_PREF_KEY = 'taifa_mb_notifications';
const SEED_NOTIFY_PREF_JS =
  `(() => { try { if (localStorage.getItem('${NOTIFY_PREF_KEY}') === null) { localStorage.setItem('${NOTIFY_PREF_KEY}', 'on'); return 'seeded'; } return localStorage.getItem('${NOTIFY_PREF_KEY}'); } catch (e) { return 'error'; } })()`;

module.exports = { NOTIFY_PREF_KEY, SEED_NOTIFY_PREF_JS, parseUnread, createBadge };
