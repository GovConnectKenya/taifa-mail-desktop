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
          if (location.hash !== h) {
            h = location.hash;
            since = Date.now();
          } else if (onMail() && railItem(label) && Date.now() - since >= 600) return;
        }
      };
      if (!onMail()) {
        go(arg.hash ? '/' + arg.hash : '/#INBOX');
        await quiet();
      }
      const arrived = () => document.title.replace(/^\(\d+\)\s*/, '').startsWith(label + ' ·');
      const settled = async () => {
        if (!(await waitFor(arrived, 1200))) return false;
        await new Promise((r) => setTimeout(r, 400));
        return arrived();
      };
      if (arg.hash && (await settled())) return location.hash.split('?')[0];
      // The page titles itself after the open folder ("Sent · Taifa Mail").
      // Coming from another page, its own first route (#INBOX) can land after
      // the click, so the click is repeated until the folder stays open.
      for (let i = 0; i < 4; i += 1) {
        const item = await waitFor(() => onMail() && railItem(label), 5000);
        if (!item) return false;
        item.click();
        if (await settled()) return location.hash.split('?')[0];
      }
      return arrived() ? location.hash.split('?')[0] : false;
    }

    case 'compose': {
      if (!onMail()) {
        link('/#INBOX?compose=new');
        return 'link';
      }
      // A message is already being written: bring it forward instead.
      const open = q('.compose:not(.minimized)');
      if (open) {
        const f = open.querySelector('input, [contenteditable="true"]');
        if (f) f.focus();
        return 'focused';
      }
      // Stay where the user is: compose over the current folder, not the Inbox.
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

    // The open conversation as an in-app route, for "Open in New Window".
    case 'conversation': {
      if (!reader() || !onMail()) return null;
      const h = location.hash.split('?')[0];
      return /^#[^/]+\/\d+$/.test(h) ? '/' + h : null;
    }

    // The open conversation, for printing: the subject, and each expanded
    // message's header lines and body HTML. Same-origin images (inline parts)
    // are inlined as data URLs, since the print window has no session.
    case 'print': {
      const r = reader();
      if (!r) return null;
      const h1 = r.querySelector('h1');
      const messages = [...r.querySelectorAll('.tm-reader-message')]
        .filter((m) => m.querySelector('iframe'))
        .map((m) => {
          const contact = m.querySelector('[aria-label^="Contact details for "]');
          const email = contact ? contact.getAttribute('aria-label').replace('Contact details for ', '') : '';
          const nameBtn = [...m.querySelectorAll('button')].find((b) => !b.getAttribute('aria-label') && b.querySelector('span') && email && b.textContent.includes(email));
          const name = nameBtn && nameBtn.firstChild ? nameBtn.firstChild.textContent.trim() : '';
          const toBtn = m.querySelector('button[aria-haspopup="dialog"]');
          const dated = [...m.querySelectorAll('span[title]')].find((s) => /\d/.test(s.getAttribute('title')));
          const ifr = m.querySelector('iframe');
          let body = '';
          try {
            const doc = ifr.contentDocument.cloneNode(true);
            // Same-origin read of live images: the clone has the same URLs, the
            // live document has the decoded pixels.
            const live = [...ifr.contentDocument.querySelectorAll('img')];
            const copy = [...doc.querySelectorAll('img')];
            live.forEach((img, i) => {
              try {
                const u = new URL(img.currentSrc || img.src, location.href);
                if ((u.origin === location.origin || u.protocol === 'blob:') && img.complete && img.naturalWidth && copy[i]) {
                  const c = document.createElement('canvas');
                  c.width = img.naturalWidth;
                  c.height = img.naturalHeight;
                  c.getContext('2d').drawImage(img, 0, 0);
                  copy[i].setAttribute('src', c.toDataURL('image/png'));
                  copy[i].removeAttribute('srcset');
                }
              } catch (_) {}
            });
            doc.querySelectorAll('script, base, meta[http-equiv]').forEach((x) => x.remove());
            body = doc.body ? doc.body.innerHTML : '';
          } catch (_) {}
          return {
            from: name && email ? name + ' <' + email + '>' : name || email,
            to: toBtn ? toBtn.textContent.trim().replace(/^to\s+/i, '') : '',
            date: dated ? dated.getAttribute('title') : '',
            body,
          };
        });
      return { subject: h1 ? h1.textContent.trim() : '', messages };
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
  search: () => true,
  sidebar: () => true,
  shortcuts: (a) => a === 'mac' || a === 'other',
  conversation: () => true,
  print: () => true,
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
