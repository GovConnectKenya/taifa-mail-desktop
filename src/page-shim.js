'use strict';

// The one script the app runs inside the webmail page.
//
// The webmail gets no preload bridge (see preload.js), so the page and main talk
// through two narrow paths only: main runs fixed scripts in the page
// (executeJavaScript, page-actions.js), and the page reports back through
// console markers that main reads from the 'console-message' event. Every
// marker is treated as hostile input in main: a page that fakes one can do no
// more than it already could with the web APIs it has (raise its own window,
// post a notification, report some booleans).
//
// The shim is written as a real function and serialised with toString(), so it
// is parsed and checked like any other code instead of living in a string.

const MARKS = Object.freeze({
  focus: '\u0001taifa-focus-request',
  // Diagnostics, as before: kind ('attempted', 'shown', ...) and permission.
  notify: '\u0001taifa-notify:',
  // A new-mail notification the page asked for, as JSON. Main posts it.
  post: '\u0001taifa-post:',
  // What the page is showing (booleans and a route), as JSON. Drives the menus.
  state: '\u0001taifa-state:',
  // The outcome of a file drop, as JSON.
  drop: '\u0001taifa-drop:',
});

const MAX_MARKER = 16 * 1024;

/* eslint-disable no-undef */
function pageShim(cfg) {
  try {
    if (window.__taifaPageShim) {
      window.__taifaPageShim.report(true);
      return;
    }
    const say = (m) => {
      try {
        console.debug(m);
      } catch (_) {}
    };
    const api = {};
    Object.defineProperty(window, '__taifaPageShim', { value: api, configurable: false, enumerable: false });

    // -- window.focus() requests (a notification click) -----------------------
    const origFocus = window.focus.bind(window);
    window.focus = function () {
      say(cfg.focus);
      return origFocus();
    };

    // -- the mailbox socket: remember the envelope of each new message --------
    // The webmail's own notification carries sender and subject only. The
    // snippet is in the websocket event that triggered it, so the shim listens
    // (read only) to the sockets the page opens and keeps the last few
    // envelopes, keyed like the notification tag (mail-<folder>-<uid>).
    const recent = new Map();
    const remember = (payload) => {
      const d = payload && typeof payload === 'object' ? payload.data || payload.payload || payload : null;
      const m = d && d.message;
      if (!m || m.uid == null || typeof d.folder !== 'string') return;
      recent.set(d.folder + '\u0000' + m.uid, {
        snippet: typeof m.snippet === 'string' ? m.snippet : '',
        fromAddr: typeof m.from_addr === 'string' ? m.from_addr : '',
      });
      while (recent.size > 40) recent.delete(recent.keys().next().value);
    };
    const WS = window.WebSocket;
    if (typeof WS === 'function') {
      window.WebSocket = new Proxy(WS, {
        construct(target, args) {
          const ws = Reflect.construct(target, args);
          try {
            ws.addEventListener('message', (ev) => {
              if (typeof ev.data !== 'string' || ev.data.indexOf('mailbox_message_new') < 0) return;
              try {
                remember(JSON.parse(ev.data));
              } catch (_) {}
            });
          } catch (_) {}
          return ws;
        },
      });
    }

    // -- new-mail notifications go to the app ---------------------------------
    // The page decides WHEN to notify (its preference, permission and focus
    // checks are unchanged). The app decides HOW: one native notification per
    // message with the snippet, bursts grouped into one, duplicates from a
    // second window dropped, and a click that opens that exact conversation.
    // The page gets back a stand-in with the Notification shape, so its own
    // code (onclick, close) keeps working.
    const N = window.Notification;
    if (typeof N === 'function') {
      const diag = (kind) => say(cfg.notify + kind + ':' + N.permission);
      class Stand extends EventTarget {
        constructor(title, opts) {
          super();
          this.title = String(title);
          this.body = String((opts && opts.body) || '');
          this.tag = String((opts && opts.tag) || '');
          this.data = opts ? opts.data : undefined;
          this.onclick = null;
          this.onshow = null;
          this.onclose = null;
          this.onerror = null;
        }
        dispatchEvent(ev) {
          const h = this['on' + ev.type];
          if (typeof h === 'function') {
            try {
              h.call(this, ev);
            } catch (_) {}
          }
          return super.dispatchEvent(ev);
        }
        close() {
          this.dispatchEvent(new Event('close'));
        }
      }
      window.Notification = new Proxy(N, {
        construct(target, args) {
          diag('attempted');
          const title = args[0];
          const opts = args[1] || {};
          // Only mail notifications (tag mail-<folder>-<uid>) are taken over.
          // Anything else, and any page without permission, keeps the browser's
          // own behaviour.
          const tag = String(opts.tag || '');
          const m = /^mail-(.+)-(\d+)$/.exec(tag);
          if (!m || N.permission !== 'granted') return Reflect.construct(target, args);
          const extra = recent.get(m[1] + '\u0000' + m[2]) || {};
          say(
            cfg.post +
              JSON.stringify({
                title: String(title).slice(0, 200),
                body: String(opts.body || '').slice(0, 300),
                tag: tag.slice(0, 400),
                snippet: String(extra.snippet || '').slice(0, 400),
                fromAddr: String(extra.fromAddr || '').slice(0, 200),
              })
          );
          const stand = new Stand(title, opts);
          setTimeout(() => stand.dispatchEvent(new Event('show')), 0);
          return stand;
        },
      });
    }

    // -- what the page is showing, for the menus and the tray -----------------
    const q = (s) => document.querySelector(s);
    const typing = () => {
      const a = document.activeElement;
      const t = a && a.shadowRoot && a.shadowRoot.activeElement ? a.shadowRoot.activeElement : a;
      if (!t || t === document.body) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName;
      return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !/^(button|checkbox|radio|submit|reset|range|color|file)$/i.test(t.type || ''));
    };
    const snapshot = () => {
      const reader = q('.tm-reader[data-open="1"]');
      const tool = (label) => (reader ? reader.querySelector('.tm-reader-tool[aria-label="' + label + '"]') : null);
      const replyBtn = (text) =>
        reader ? [...reader.querySelectorAll('.tm-reader-reply')].some((b) => b.textContent.trim() === text) : false;
      const compose = q('.compose:not(.minimized)');
      const archive = tool('Archive');
      return {
        path: location.pathname,
        mail: !!q('.rail-item') && location.pathname === '/',
        signedIn: !!q('.tm-shell-topbar'),
        conversation: !!reader,
        composer: !!compose,
        composerMinimized: !!q('.compose.minimized'),
        modal: !!q('[aria-modal="true"]'),
        typing: typing(),
        read: !!tool('Mark as unread'),
        unread: !!tool('Mark as read'),
        starred: !!tool('Remove star'),
        canArchive: !!(archive && !archive.disabled),
        canReplyAll: replyBtn('Reply all'),
        search: !!q('[data-search-input]'),
        online: navigator.onLine,
        degraded: !!q('.tm-conn'),
        offlineBanner: !!q('.tm-shell-offline'),
        sound: (() => {
          try {
            return localStorage.getItem('taifa_mb_notifications_sound') === '1';
          } catch (_) {
            return false;
          }
        })(),
      };
    };
    let last = '';
    let timer = null;
    const report = (force) => {
      clearTimeout(timer);
      timer = null;
      try {
        const s = JSON.stringify(snapshot());
        if (s === last && !force) return;
        last = s;
        say(cfg.state + s);
      } catch (_) {}
    };
    const soon = () => {
      if (!timer) timer = setTimeout(report, 120);
    };
    api.report = report;
    for (const ev of ['hashchange', 'popstate', 'online', 'offline', 'focusin', 'focusout', 'click', 'keyup']) {
      window.addEventListener(ev, soon, true);
    }
    new MutationObserver(soon).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-open', 'disabled', 'class'],
    });
    setTimeout(() => report(true), 0);

    // -- files dropped on the window -----------------------------------------
    // The composer takes drops on itself. Anywhere else, Chromium would try to
    // open the file, which the app blocks, so the drop silently did nothing.
    // Now a drop anywhere opens a new message with the files attached, or adds
    // them to the open composer, and reports whether they arrived.
    const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
    let veil = null;
    let veilTimer = null;
    const showVeil = (on) => {
      clearTimeout(veilTimer);
      if (on && !veil) {
        veil = document.createElement('div');
        veil.setAttribute('data-taifa-drop', '');
        veil.setAttribute('role', 'status');
        veil.textContent = 'Drop files to attach them to a message';
        veil.style.cssText =
          'position:fixed;inset:12px;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
          'border:2px dashed var(--color-accent,#00864e);border-radius:16px;pointer-events:none;' +
          'background:color-mix(in srgb,var(--color-bg,#f5f8f6) 82%,transparent);color:var(--color-text,#111);' +
          'font:600 15px/1.4 var(--font-sans,system-ui),system-ui,sans-serif;';
        document.body.appendChild(veil);
      }
      if (!on && veil) {
        veilTimer = setTimeout(() => {
          if (veil) veil.remove();
          veil = null;
        }, 60);
      }
    };
    // One .att row per attachment, in any phase (MailComposerCore.svelte).
    const attachRows = () => document.querySelectorAll('.compose .att').length;
    const fileInput = () => {
      const c = q('.compose');
      if (!c) return null;
      return [...c.querySelectorAll('input[type="file"][multiple]')].find((i) => !i.accept) || null;
    };
    const waitFor = (fn, ms) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          const v = fn();
          if (v || Date.now() - t0 > ms) resolve(v);
          else setTimeout(tick, 80);
        };
        tick();
      });
    let preDrop = 0;
    const deliver = async (files, viaComposer) => {
      const names = files.map((f) => f.name).slice(0, 5);
      const before = viaComposer ? preDrop : attachRows();
      let input = viaComposer ? null : fileInput();
      if (!viaComposer && !input) {
        // No composer: open a new message where the user is, then attach.
        const h = location.hash.replace(/\?.*$/, '') || '#INBOX';
        if (location.pathname === '/') location.hash = h + '?compose=new';
        else location.href = '/#INBOX?compose=new';
        input = await waitFor(fileInput, 5000);
        if (!input) {
          say(cfg.drop + JSON.stringify({ outcome: 'no-composer', count: files.length, names }));
          return;
        }
      }
      if (!viaComposer) {
        try {
          const dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {
          say(cfg.drop + JSON.stringify({ outcome: 'failed', count: files.length, names }));
          return;
        }
      }
      // Something must show for every drop: an upload row, or an error row. A
      // row that appears and is then silently removed (the server refused the
      // upload) is a failure too, so the row must still be there a moment later.
      const held = async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          await new Promise((r) => setTimeout(r, 400));
          if (attachRows() <= before) return false;
        }
        return true;
      };
      const ok = (await waitFor(() => attachRows() > before, 6000)) && (await held());
      say(cfg.drop + JSON.stringify({ outcome: ok ? 'attached' : 'failed', count: files.length, names }));
    };
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      showVeil(!q('.compose:not(.minimized)'));
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) showVeil(false);
    });
    // Capture phase: count the composer's attachment rows before it acts.
    window.addEventListener('drop', (e) => {
      if (hasFiles(e)) preDrop = attachRows();
    }, true);
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      showVeil(false);
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      // The composer handles drops on itself (and calls preventDefault). Still
      // watch for the result, since a failed upload used to vanish silently.
      const handled = e.defaultPrevented;
      e.preventDefault();
      deliver(files, handled);
    });
  } catch (_) {}
}
/* eslint-enable no-undef */

const PAGE_SHIM_JS = `(${pageShim.toString()})(${JSON.stringify(MARKS)})`;

// Reads a console message. Returns { type, ... } for one of ours, else null.
// Never throws: the message is page-controlled.
function parseMarker(message) {
  if (typeof message !== 'string' || message.charCodeAt(0) !== 1 || message.length > MAX_MARKER) return null;
  if (message === MARKS.focus) return { type: 'focus' };
  const json = (prefix, type) => {
    if (!message.startsWith(prefix)) return undefined;
    try {
      const data = JSON.parse(message.slice(prefix.length));
      return data && typeof data === 'object' && !Array.isArray(data) ? { type, data } : null;
    } catch (_) {
      return null;
    }
  };
  for (const [prefix, type] of [[MARKS.post, 'post'], [MARKS.state, 'state'], [MARKS.drop, 'drop']]) {
    const r = json(prefix, type);
    if (r !== undefined) return r;
  }
  if (message.startsWith(MARKS.notify)) {
    const [kind, permission] = message.slice(MARKS.notify.length).split(':');
    return { type: 'notify', kind: String(kind || ''), permission: String(permission || '') };
  }
  return null;
}

// The page state, reduced to the fields main trusts, all booleans except path.
const STATE_KEYS = [
  'mail', 'signedIn', 'conversation', 'composer', 'composerMinimized', 'modal', 'typing', 'read', 'unread',
  'starred', 'canArchive', 'canReplyAll', 'search', 'online', 'degraded', 'offlineBanner', 'sound',
];
function normaliseState(data) {
  const s = {};
  for (const k of STATE_KEYS) s[k] = !!(data && data[k]);
  s.path = data && typeof data.path === 'string' ? data.path.slice(0, 200) : '';
  if (data && data.online === undefined) s.online = true;
  return s;
}

module.exports = { MARKS, PAGE_SHIM_JS, pageShim, parseMarker, normaliseState, STATE_KEYS };
