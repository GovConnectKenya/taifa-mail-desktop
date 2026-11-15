'use strict';

// One connection state, worded the same in the window, the tray popover and the
// tray tooltip.
//
// Round 2: the popover said "Offline" while the window said "Reconnecting…"
// (the app turned a long reconnect into "offline" after 45 seconds, the window
// never did), and during a 502 or a hung backend the tray stayed green while
// the window had lost the mailbox. Now:
//
// - whatever the window shows, the tray says, in the window's own words (the
//   offline banner's first sentence, or the "Reconnecting…" chip);
// - when the window shows nothing but the backend is failing (server health,
//   below), the tray says "Can’t reach the server";
// - no timers turn one state into another behind the window's back.
//
// Pure, so it is unit tested (test/connection.test.js).

const LABELS = Object.freeze({
  online: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'You’re offline',
  server: 'Can’t reach the server',
});

function firstSentence(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?…])(\s|$)/.exec(s);
  const out = (m ? m[1] : s).replace(/\.$/, '');
  return out.length > 48 ? `${out.slice(0, 47)}…` : out;
}

// in: { showingOffline, appLoaded, page (normaliseState, or null), serverDown }
// out: { state: 'online' | 'connecting' | 'reconnecting' | 'offline', label }
function connectionView({ showingOffline, appLoaded, page, serverDown }) {
  if (showingOffline) return { state: 'offline', label: LABELS.server };
  if (!page) return appLoaded ? (serverDown ? { state: 'offline', label: LABELS.server } : { state: 'online', label: LABELS.online }) : { state: 'connecting', label: LABELS.connecting };
  // The webmail's offline banner: offline, stale (a saved copy) or recovering.
  if (page.offlineBanner) {
    if (page.connKind === 'recovering') return { state: 'reconnecting', label: 'Checking for new mail…' };
    return { state: 'offline', label: firstSentence(page.connText) || LABELS.offline };
  }
  if (!page.online) return { state: 'offline', label: LABELS.offline };
  // The webmail's "Reconnecting…" chip (its live-updates socket is down).
  if (page.degraded) return { state: 'reconnecting', label: firstSentence(page.connText) || LABELS.reconnecting };
  if (serverDown) return { state: 'offline', label: LABELS.server };
  return { state: 'online', label: LABELS.online };
}

// Server health, from the backend requests the app itself forwards (bundle.js).
// Down when the latest finished request failed at the server (502, 503, 504)
// or never got an answer, or when a request has been waiting longer than
// hungMs with nothing finishing meanwhile (a hung backend). Any other answer,
// 4xx included, proves the server is there.
function createServerHealth({ now = Date.now, hungMs = 20000 } = {}) {
  let lastOkAt = 0;
  let lastFailed = false; // the latest finished request's verdict
  const pending = new Map();
  let seq = 0;
  const watched = (p) => p === '/health' || p.startsWith('/v1/');
  return {
    start(pathname) {
      if (!watched(String(pathname || ''))) return () => {};
      const id = ++seq;
      pending.set(id, now());
      let done = false;
      return (status) => {
        if (done) return;
        done = true;
        pending.delete(id);
        const failed = !status || status === 502 || status === 503 || status === 504;
        lastFailed = failed;
        if (!failed) lastOkAt = now();
      };
    },
    down() {
      const t = now();
      if (lastFailed) return true;
      for (const at of pending.values()) {
        if (t - at > hungMs && t - lastOkAt > hungMs) return true;
      }
      return false;
    },
    get pending() {
      return pending.size;
    },
  };
}

module.exports = { connectionView, createServerHealth, firstSentence, LABELS };
