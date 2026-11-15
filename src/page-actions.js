'use strict';

// What the menu bar, the tray and the shortcuts ask the webmail to do.
//
// The webmail has no bridge (preload.js), so each action is this one fixed
// function, run in the page with a name and a JSON argument. Nothing is ever
// spliced in as code. Each action works the way the user would: it clicks the
// webmail's own button or changes the route the way its own links do, so the
// webmail's rules (what is enabled, undo toasts, drafts) all still apply.
//
// The selectors come from the webmail at WEBMAIL_REF (see docs/BUNDLED_WEBMAIL.md):
// reader toolbar buttons by aria-label (Reader.svelte), reply buttons by text,
// rail rows by their name, the search field by data-search-input.

// The reader toolbar buttons an action may press, by aria-label.
const TOOLS = Object.freeze(['Archive', 'Delete', 'Mark as read', 'Mark as unread', 'Star', 'Remove star', 'Report spam', 'Move to folder', 'Label', 'Snooze']);
// The reply buttons, by their text.
const REPLIES = Object.freeze(['Reply', 'Reply all', 'Forward']);
// The standard folders a menu item may open, by their rail name.
const FOLDERS = Object.freeze(['Inbox', 'Sent', 'Drafts', 'Archive', 'Trash', 'Junk']);

/* eslint-disable no-undef */
async function pageAction(name, arg) {
  const q = (s) => document.querySelector(s);
  const onMail = () => location.pathname === '/';
  const reader = () => q('.tm-reader[data-open="1"]');
  const waitFor = (fn, ms) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const v = fn();
        if (v || Date.now() - t0 > ms) resolve(v || null);
        else setTimeout(tick, 60);
      };
      tick();
    });
  // A click on a link, so SvelteKit's router takes it (used across pages).
  const link = (href) => {
    const a = document.createElement('a');
    a.href = href;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  // Inside the mail page a route is only a hash, and the page routes on
  // 'hashchange'. A link click there is swallowed by the router without a
  // hashchange, which is why File > Inbox did nothing from another folder.
  const go = (route) => {
    if (route.startsWith('/#') && onMail()) {
      const h = route.slice(1);
      if (location.hash !== h) location.hash = h;
      return 'hash';
    }
    link(route);
    return 'link';
  };
  const railItem = (label) =>
    [...document.querySelectorAll('.rail-item')].find((b) => {
      const n = b.querySelector('.rail-item-name');
      return n && n.textContent.trim() === label;
    });

  // Navigation tickets. Cmd+4 then Cmd+1 in quick succession run two actions
  // at once, and the older one's retry loop used to click its folder again
  // after the newer one had landed. Each navigation takes a ticket on arrival
  // (scripts start in the order main sent them), and an action whose ticket is
  // no longer the latest stops before its next click: the last shortcut
  // pressed always wins.
  const navActions = { navigate: 1, folder: 1, compose: 1 };
  const ticket = navActions[name] ? (window.__taifaNavTicket = (window.__taifaNavTicket || 0) + 1) : 0;
  const superseded = () => ticket !== window.__taifaNavTicket;

  switch (name) {
    case 'navigate':
      return go(String(arg));

    case 'folder': {
      // arg: { name, hash? }. hash is the folder's route as last seen, which
      // main remembers so another page can link straight to it.
      const label = arg.name;
      if (label === 'Inbox') return go('/#INBOX') && '#INBOX';
      // From another page: open the mail page, then let it settle (it applies
      // its own first route, and may auto-open a conversation) before acting.
      const quiet = async () => {
        let h = location.hash;
        let since = Date.now();
        const t0 = Date.now();
        while (Date.now() - t0 < 4000) {
          await new Promise((r) => setTimeout(r, 100));
          if (superseded()) return;
          if (location.hash !== h) {
            h = location.hash;
            since = Date.now();
          } else if (onMail() && railItem(label) && Date.now() - since >= 600) return;
        }
      };
      if (!onMail()) {
        go(arg.hash ? '/' + arg.hash : '/#INBOX');
        await quiet();
        if (superseded()) return 'superseded';
      }
      const arrived = () => document.title.replace(/^\(\d+\)\s*/, '').startsWith(label + ' ·');
      const settled = async () => {
        if (!(await waitFor(() => superseded() || arrived(), 1200)) || superseded()) return false;
        await new Promise((r) => setTimeout(r, 400));
        return !superseded() && arrived();
      };
      if (arg.hash && onMail()) {
        // The folder's route is known: open it directly, the way Inbox is.
        go('/' + arg.hash);
        if (await settled()) return location.hash.split('?')[0];
        if (superseded()) return 'superseded';
      }
      // The page titles itself after the open folder ("Sent · Taifa Mail").
      // Coming from another page, its own first route (#INBOX) can land after
      // the click, so the click is repeated until the folder stays open.
      for (let i = 0; i < 4; i += 1) {
        const item = await waitFor(() => superseded() || (onMail() && railItem(label)), 5000);
        if (superseded()) return 'superseded';
        if (!item) return false;
        item.click();
        if (await settled()) return location.hash.split('?')[0];
        if (superseded()) return 'superseded';
      }
      return arrived() ? location.hash.split('?')[0] : false;
    }

    case 'compose': {
      // The page's own Compose control: the rail's primary button, or the
      // phone layout's floating one. Pressing it runs the page's startCompose,
      // which tucks any other composer (a minimised reply included) and opens
      // a new message. Rewriting the route to ?compose=new did nothing while
      // a reply was minimised, since its route already carried compose=reply.
      const composeButton = () =>
        [...document.querySelectorAll('.tm-shell-primary, .tm-compose-fab')].find((b) => {
          const name = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
          return /\bcompose\b/i.test(name) && !b.disabled;
        }) || null;
      const expanded = () => q('.compose:not(.minimized)');
      if (!onMail()) {
        // From another page: open the mail page, then compose there.
        link('/#INBOX');
        const ready = await waitFor(() => superseded() || (onMail() && composeButton()), 6000);
        if (superseded()) return 'superseded';
        if (!ready) {
          link('/#INBOX?compose=new');
          return 'link';
        }
      }
      // A message is already being written: bring it forward instead.
      const open = expanded();
      if (open) {
        const f = open.querySelector('input, [contenteditable="true"]');
        if (f) f.focus();
        return 'focused';
      }
      const b = composeButton();
      if (b) {
        b.click();
        if (await waitFor(expanded, 2000)) return 'button';
      }
      // No button on screen (an unusual layout): the page's own "c" shortcut,
      // live while every composer is only a minimised bar.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }));
      if (await waitFor(expanded, 1000)) return 'key';
      // Last resort, the route: compose over the current folder, not the Inbox.
      const base = location.hash.split('?')[0] || '#INBOX';
      location.hash = base + '?compose=new';
      return 'hash';
    }

    case 'tool': {
      const r = reader();
      const b = r && r.querySelector('.tm-reader-tool[aria-label="' + String(arg).replace(/"/g, '') + '"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }

    case 'reply': {
      const r = reader();
      if (!r) return false;
      // The latest message's buttons: the last match in the thread.
      const b = [...r.querySelectorAll('.tm-reader-reply')].filter((x) => x.textContent.trim() === arg).pop();
      if (!b) return false;
      b.click();
      return true;
    }

    // The server is answering again (main probed it): press the page's own
    // retry, so the mailbox and its live updates come back now instead of on
    // the page's next backoff tick. Only the page's retry controls.
    case 'reconnect': {
      const boot = q('.tm-boot-retry');
      if (boot && !boot.disabled) {
        boot.click();
        return 'mailbox';
      }
      const chip = q('.tm-conn');
      if (chip) {
        chip.click();
        return 'live';
      }
      return false;
    }

    case 'refresh': {
      const b = q('button[aria-label="Refresh"]');
      if (!b) return false;
      b.click();
      return true;
    }

    case 'search': {
      const el = q('[data-search-input]');
      if (!el) return false;
      el.focus();
      const inner = el.shadowRoot && el.shadowRoot.querySelector('input');
      if (inner) {
        inner.focus();
        inner.select();
      }
      return true;
    }

    case 'sidebar': {
      const b = q('.tm-shell-burger');
      if (!b) return false;
      b.click();
      return true;
    }

    case 'shortcuts':
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', metaKey: arg === 'mac', ctrlKey: arg !== 'mac', bubbles: true }));
      return true;

    // The newest Inbox conversations' envelopes (notify-fallback.js): what a
    // new-mail notification needs when the page posted none. Read only; the
    // same list call the page makes, which never changes read state.
    case 'inbox-head': {
      let id = '';
      try {
        id = localStorage.getItem('taifa-mail-last-mailbox') || '';
      } catch (_) {}
      if (!/^[\w-]{1,64}$/.test(id)) return null;
      try {
        const res = await fetch('/v1/inbox/' + encodeURIComponent(id) + '/conversations?folder=INBOX&limit=15&offset=0', { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const body = await res.json();
        return (Array.isArray(body.items) ? body.items : []).map((c) => {
          const m = c.latest || {};
          return {
            uid: Number(m.uid) || 0,
            folder: String(m.folder || 'INBOX').slice(0, 300),
            unread: !!c.unread && !m.seen,
            fromName: String(m.from_name || '').slice(0, 200),
            fromAddr: String(m.from_addr || '').slice(0, 200),
            subject: String(m.subject || '').slice(0, 300),
            snippet: String(m.snippet || '').slice(0, 400),
          };
        });
      } catch (_) {
        return null;
      }
    }

    // The open conversation as an in-app route, for "Open in New Window".
    case 'conversation': {
      if (!reader() || !onMail()) return null;
      const h = location.hash.split('?')[0];
      return /^#[^/]+\/\d+$/.test(h) ? '/' + h : null;
    }

    // The open conversation, for printing: every message in it, expanded or
    // not, plain text or HTML. The reader only renders the messages that are
    // expanded (and mounts at most three HTML frames), so the thread comes from
    // the same conversation API the reader uses, with mark_seen=false: printing
    // never changes read state. A message whose HTML frame is on screen is
    // taken from that frame instead, so its images are the ones the user chose
    // to load; any other remote image is left out (the print window has no
    // network at all). When the server cannot be reached, the messages on
    // screen are printed and the document says so.
    case 'print': {
      const r = reader();
      if (!r || !onMail()) return null;
      const h1 = r.querySelector('h1');
      const subject = h1 ? h1.textContent.trim() : '';
      const fmt = (d) => {
        try {
          return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
        } catch (_) {
          return d.toString();
        }
      };
      // A rendered frame's body, with same-origin and blob images inlined as
      // data URLs (the clone has the URLs, the live document has the pixels)
      // and remote ones removed.
      const frameBody = (ifr) => {
        try {
          const live = ifr.contentDocument;
          const doc = live.cloneNode(true);
          const liveImgs = [...live.querySelectorAll('img')];
          const copy = [...doc.querySelectorAll('img')];
          liveImgs.forEach((img, i) => {
            if (!copy[i]) return;
            try {
              const u = new URL(img.currentSrc || img.src, location.href);
              if (u.protocol === 'data:') return;
              if ((u.origin === location.origin || u.protocol === 'blob:') && img.complete && img.naturalWidth) {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                c.getContext('2d').drawImage(img, 0, 0);
                copy[i].setAttribute('src', c.toDataURL('image/png'));
                copy[i].removeAttribute('srcset');
                return;
              }
            } catch (_) {}
            copy[i].remove();
          });
          doc.querySelectorAll('script, base, meta, link, iframe, object, embed').forEach((x) => x.remove());
          return doc.body ? doc.body.innerHTML : '';
        } catch (_) {
          return null;
        }
      };
      // What the reader shows for each message, oldest first: the sender's
      // address (to match against the API) and the HTML frame when mounted.
      const shown = [...r.querySelectorAll('.tm-reader-message')].map((m) => {
        const contact = m.querySelector('[aria-label^="Contact details for "]');
        const email = contact ? contact.getAttribute('aria-label').replace('Contact details for ', '').trim().toLowerCase() : '';
        const ifr = m.querySelector('iframe');
        const pre = m.querySelector('pre.tm-reader-text:not(.tm-reader-quoted)');
        const dated = [...m.querySelectorAll('span[title]')].find((s) => /\d/.test(s.getAttribute('title')));
        return { email, ifr, pre, collapsed: m.classList.contains('collapsed'), date: dated ? dated.getAttribute('title') : '' };
      });

      const route = /^#((?:folder\/)?[^/?#]+)\/(\d+)$/.exec(location.hash.split('?')[0]);
      let id = '';
      try {
        id = localStorage.getItem('taifa-mail-last-mailbox') || '';
      } catch (_) {}
      let thread = null;
      let total = 0;
      if (route && id && /^[\w-]{1,64}$/.test(id)) {
        const folder = decodeURIComponent(route[1].replace(/^folder\//, '').replace(/\+/g, ' '));
        const qs = new URLSearchParams({ folder, uid: route[2], limit: '100', mark_seen: 'false', bodies: 'all' });
        try {
          const res = await fetch('/v1/inbox/' + encodeURIComponent(id) + '/conversation?' + qs, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (res.ok) {
            const win = await res.json();
            if (win && Array.isArray(win.messages)) {
              thread = win.messages.slice();
              total = Number(win.total) || thread.length;
            }
          }
        } catch (_) {}
      }

      if (thread) {
        // Oldest first, as the reader shows them.
        const ts = (m) => (m.date_ts ? m.date_ts * 1000 : Date.parse(m.date || '') || 0);
        thread.sort((a, b) => ts(a) - ts(b));
        // Line the reader's messages up with the newest end of the thread
        // (the reader may show only the latest window of a long thread).
        const offset = thread.length - shown.length;
        const messages = thread.map((m, i) => {
          const d = m.body && typeof m.body === 'object' ? { ...m, ...m.body } : m;
          const s = offset >= 0 ? shown[i - offset] : null;
          let html = null;
          if (s && s.ifr && (!s.email || s.email === String(d.from_addr || '').toLowerCase())) html = frameBody(s.ifr);
          if (html === null && typeof d.html === 'string' && d.html) {
            // The server's sanitised HTML; inline parts are already data URLs.
            const doc = new DOMParser().parseFromString(d.html, 'text/html');
            doc.querySelectorAll('img').forEach((img) => {
              if (!/^data:/i.test(img.getAttribute('src') || '')) img.remove();
            });
            doc.querySelectorAll('script, base, meta, link, iframe, object, embed').forEach((x) => x.remove());
            html = doc.body ? doc.body.innerHTML : '';
          }
          const t = ts(d);
          return {
            fromName: String(d.from_name || ''),
            fromAddr: String(d.from_addr || ''),
            to: Array.isArray(d.to) ? d.to.map(String) : [],
            cc: Array.isArray(d.cc) ? d.cc.map(String) : [],
            date: t ? fmt(new Date(t)) : String(d.date || ''),
            html: html === null ? undefined : html,
            text: html === null ? String(d.text || d.snippet || '') : undefined,
            attachments: Array.isArray(d.attachments) ? d.attachments.map((a) => ({ name: String(a.filename || 'attachment'), size: Number(a.size) || 0 })) : [],
          };
        });
        return { subject, total, messages };
      }

      // No server: what is on screen. Collapsed rows have no body to print.
      const messages = [];
      r.querySelectorAll('.tm-reader-message').forEach((m, i) => {
        const s = shown[i];
        if (s.collapsed) return;
        const html = s.ifr ? frameBody(s.ifr) : null;
        if (html === null && !s.pre) return;
        messages.push({ fromName: '', fromAddr: s.email, to: [], cc: [], date: s.date, html: html === null ? undefined : html, text: html === null ? s.pre.textContent : undefined, attachments: [] });
      });
      const skipped = shown.length - messages.length;
      return {
        subject,
        total: shown.length,
        messages,
        note: skipped > 0 ? 'Taifa Mail could not reach the server, so only the open messages are printed (' + messages.length + ' of ' + shown.length + ').' : '',
      };
    }

    default:
      return null;
  }
}
/* eslint-enable no-undef */

const VALID = {
  navigate: (a) => typeof a === 'string' && /^\/(#|settings\b|$)/.test(a) && a.length < 2000,
  folder: (a) => !!a && FOLDERS.includes(a.name) && (a.hash === undefined || (typeof a.hash === 'string' && /^#[^?#\s]{1,300}$/.test(a.hash))),
  compose: (a) => a === undefined || a === null,
  tool: (a) => TOOLS.includes(a),
  reply: (a) => REPLIES.includes(a),
  refresh: () => true,
  reconnect: (a) => a === undefined || a === null,
  search: () => true,
  sidebar: () => true,
  shortcuts: (a) => a === 'mac' || a === 'other',
  conversation: () => true,
  print: () => true,
  'inbox-head': (a) => a === undefined || a === null,
};

// The script for one action. Throws for an unknown action or a bad argument,
// so a programming error shows up in tests instead of running in the page.
function actionScript(name, arg) {
  if (!Object.prototype.hasOwnProperty.call(VALID, name) || !VALID[name](arg)) {
    throw new Error(`invalid page action: ${name}`);
  }
  return `(${pageAction.toString()})(${JSON.stringify(name)}, ${JSON.stringify(arg === undefined ? null : arg)})`;
}

module.exports = { actionScript, pageAction, TOOLS, REPLIES, FOLDERS };
