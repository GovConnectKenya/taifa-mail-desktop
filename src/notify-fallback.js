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
// same time, the app reads the newest unread Inbox envelopes itself (the same
// list API the page uses, page-actions.js 'inbox-head') and posts them through
// the notifier like any other: sender as the title, subject and snippet, bursts
// grouped, a click opens the conversation. Only when that read fails (offline,
// or the new mail went to another folder) does it post the plain count.
//
// The settle window restarts at sign-in (markLoaded is called again then), so a
// fresh sign-in, where the count jumps from nothing to the whole unread total,
// raises no banner. The baseline is the newest Inbox uid seen at that point:
// only mail that arrives after it is ever announced.

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

// The unread Inbox envelopes newer than the baseline uid, oldest first, and
// the new baseline. items: [{ uid, unread, ... }] from 'inbox-head'. A null
// baseline (not taken yet) announces nothing and just takes one. Pure.
function pickNew(items, baseline) {
  const list = Array.isArray(items) ? items.filter((i) => i && Number.isSafeInteger(i.uid) && i.uid > 0) : [];
  const top = list.reduce((m, i) => Math.max(m, i.uid), 0);
  if (baseline == null) return { fresh: [], baseline: top || null };
  const fresh = list.filter((i) => i.unread && i.uid > baseline).sort((a, b) => a.uid - b.uid);
  return { fresh, baseline: Math.max(baseline, top) };
}

function fallbackBody(unread) {
  return unread === 1 ? 'You have 1 unread message.' : `You have ${unread} unread messages.`;
}

module.exports = { createFallback, fallbackBody, pickNew };
