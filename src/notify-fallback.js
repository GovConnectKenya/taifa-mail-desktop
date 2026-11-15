'use strict';

// A safety net for new-mail notifications.
//
// The webmail posts its own notification from the mailbox websocket event, but
// only when that event carries the new message's envelope. The backend attaches
// the envelope on a best-effort basis (backend/app/api/inbound.py: a delivery
// whose Message-ID is not yet indexed, or a lookup that times out, sends a
// hint-only event), and then the webmail updates the list and the unread count
// in the title but posts NO notification. The count in the title still rises,
// so the app watches for that: when the unread count goes up while the window is
// not in front and the page did not post a notification of its own around the
// same time, the app posts a plain one ("3 unread messages", no sender or
// subject: the app never reads message content).

function createFallback({ now = Date.now, settleMs = 10000, lookbackMs = 3000 } = {}) {
  let loadedAt = null;
  let lastPageAttempt = -Infinity;
  return {
    // The webmail finished loading. Counts that appear in the first seconds are
    // the initial mailbox sync, not new mail.
    markLoaded() { loadedAt = now(); },
    // The page created a Notification of its own.
    pageAttempt() { lastPageAttempt = now(); },
    // A title count change. Returns an increase record, or null.
    onUnread(prev, next) {
      if (loadedAt === null || now() - loadedAt < settleMs) return null;
      if (!(next > prev)) return null;
      return { at: now(), delta: next - prev };
    },
    // True when the page did NOT post a notification for this increase.
    due(inc) { return !(lastPageAttempt >= inc.at - lookbackMs); },
  };
}

function fallbackBody(unread) {
  return unread === 1 ? 'You have 1 unread message.' : `You have ${unread} unread messages.`;
}

module.exports = { createFallback, fallbackBody };
