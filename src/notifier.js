'use strict';

// New-mail notifications, posted by the app.
//
// The page still decides WHEN to notify (its preference, its permission and its
// "is the window in front" check, see page-shim.js); this module decides HOW:
//
// - one native notification per message: sender as the title, the subject
//   (macOS subtitle) and the snippet as the body;
// - a burst (several messages within groupMs) becomes one summary, so ten
//   messages arriving together do not stack ten banners;
// - the same message reported twice (a second window, a reconnect replaying the
//   event) is posted once;
// - clicking opens that exact conversation (or, for a summary, its folder) and
//   brings the window forward;
// - silent unless the webmail's own "play a sound" setting is on.
//
// Electron is injected (createNotification), so this is unit tested.

const { parseMailTag, folderView } = require('./route');

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// What one message notification says. Pure.
function messageContent({ title, body, snippet }, platform) {
  const from = clip(title, 80) || 'New message';
  const subject = clip(body, 120) || '(no subject)';
  const snip = clip(snippet, 180);
  if (platform === 'darwin') return { title: from, subtitle: subject, body: snip };
  return { title: from, body: snip ? `${subject}\n${snip}` : subject };
}

// What a summary for several messages says. Pure.
function summaryContent(items) {
  const n = items.length;
  const senders = [];
  for (const it of items) {
    const s = clip(it.title, 40) || 'Unknown sender';
    if (!senders.includes(s)) senders.push(s);
  }
  const shown = senders.slice(0, 3).join(', ');
  const more = senders.length > 3 ? ` and ${senders.length - 3} more` : '';
  return { title: `${n} new messages`, body: `From ${shown}${more}` };
}

// Where a click on a summary goes: the folder they all arrived in, else Inbox.
function summaryRoute(items) {
  const folders = new Set(items.map((i) => (i.mail ? i.mail.folder : 'INBOX')));
  if (folders.size === 1) {
    const [f] = folders;
    return `/#${folderView(f)}`;
  }
  return '/#INBOX';
}

// deps: {
//   createNotification(opts) -> a Notification-like (on, show, close),
//   platform, now(), setTimeout, clearTimeout,
//   onOpen(route), log(event, extra), soundOn() -> boolean,
//   groupMs (default 1500), dedupeMs (default 10 minutes), maxPerMinute (20)
// }
function createNotifier(deps) {
  const {
    createNotification,
    platform,
    now = Date.now,
    setTimeout: setT = setTimeout,
    clearTimeout: clearT = clearTimeout,
    onOpen,
    log = () => {},
    soundOn = () => false,
    groupMs = 1500,
    dedupeMs = 10 * 60 * 1000,
    maxPerMinute = 20,
  } = deps;

  const seen = new Map(); // tag -> time
  const live = new Set(); // keep references: a collected Notification loses its click handler
  let buffer = [];
  let timer = null;
  let posted = []; // times of posted notifications, for the rate limit
  let lastPostAt = -Infinity;
  let fallbackNote = null;

  function keep(n, ttl = 30 * 60 * 1000) {
    live.add(n);
    const drop = () => live.delete(n);
    n.on('close', drop);
    setT(drop, ttl);
    return n;
  }

  function show(opts, route, kind) {
    const t = now();
    posted = posted.filter((x) => t - x < 60000);
    if (posted.length >= maxPerMinute) {
      log('notify-dropped', { reason: 'rate' });
      return null;
    }
    posted.push(t);
    lastPostAt = t;
    const n = keep(createNotification({ ...opts, silent: !soundOn() }));
    n.on('click', () => {
      log('notify-clicked', { kind });
      onOpen(route);
    });
    n.on('show', () => log('notify-shown', { kind }));
    n.on('failed', (_e, err) => log('notify-failed', { kind, reason: String(err) }));
    n.show();
    return n;
  }

  function flush() {
    timer = null;
    const items = buffer;
    buffer = [];
    if (!items.length) return;
    // Real messages supersede a pending "N unread" fallback.
    if (fallbackNote) {
      try {
        fallbackNote.close();
      } catch (_) {}
      fallbackNote = null;
    }
    if (items.length === 1) {
      const it = items[0];
      show(messageContent(it, platform), it.mail ? `/${it.mail.hash}` : '/#INBOX', 'message');
    } else {
      show(summaryContent(items), summaryRoute(items), 'summary');
    }
  }

  return {
    // A notification the page asked for: { title, body, tag, snippet }.
    post(data) {
      const tag = String((data && data.tag) || '');
      const t = now();
      for (const [k, at] of seen) if (t - at > dedupeMs) seen.delete(k);
      if (tag && seen.has(tag)) {
        log('notify-duplicate');
        return false;
      }
      if (tag) seen.set(tag, t);
      buffer.push({ title: data.title, body: data.body, snippet: data.snippet, mail: parseMailTag(tag) });
      if (!timer) timer = setT(flush, groupMs);
      return true;
    },

    // The safety net (notify-fallback.js decided the page stayed silent). One
    // at a time: a newer count replaces the older banner instead of stacking.
    postFallback(unread) {
      if (fallbackNote) {
        try {
          fallbackNote.close();
        } catch (_) {}
      }
      const body = unread === 1 ? 'You have 1 unread message in your Inbox.' : `You have ${unread} unread messages in your Inbox.`;
      fallbackNote = show({ title: 'New mail', body }, '/#INBOX', 'fallback');
      return fallbackNote;
    },

    // True when the app posted a notification within ms (the fallback then
    // has nothing to add).
    postedWithin(ms) {
      return now() - lastPostAt < ms || buffer.length > 0;
    },

    get liveCount() {
      return live.size;
    },
    _flush: flush,
    _cancel() {
      if (timer) clearT(timer);
      timer = null;
    },
  };
}

module.exports = { createNotifier, messageContent, summaryContent, summaryRoute };
