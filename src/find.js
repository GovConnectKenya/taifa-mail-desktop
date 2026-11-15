'use strict';

// Edit > Find > Find in Message: Chromium's find-in-page, scoped to the open
// message, with a find bar laid over the window.
//
// Scope. findInPage searches the whole window, so "Find in Message" would
// first land on a list row or a folder name. Chromium's find skips inert
// content (measured on Electron 45: 14 matches across the window, 0 with the
// rest of the window inert), so for the instant of each search everything
// outside the reader pane is marked inert, then restored, with the page's own
// focus put back. Matches inside the message's HTML frame are found too.
//
// The bar is a WebContentsView (src/find/find.html), not page DOM: it is never
// part of the text it searches, and page styles never reach it. One bar per
// mail window. It closes on Escape, when the window navigates to another
// conversation, and when the conversation closes.
//
// Electron is injected so the pure parts are unit tested.

const BAR_W = 380;
const BAR_H = 52;

// Where the bar sits: the top-right corner of the reader pane, just under its
// toolbar (pane is that rect in CSS pixels, zoom the page zoom factor),
// clamped into the window.
function barBounds(pane, zoom, content) {
  const z = zoom || 1;
  const right = pane ? Math.round((pane.x + pane.width) * z) : content.width;
  const top = pane ? Math.round(pane.y * z) : 60;
  const x = Math.max(8, Math.min(right - BAR_W - 8, content.width - BAR_W - 8));
  const y = Math.max(0, Math.min(top + 4, content.height - BAR_H));
  return { x, y, width: BAR_W, height: BAR_H };
}

// The conversation a URL shows ('#INBOX/12'), ignoring its ?params.
function conversationOf(url) {
  try {
    return new URL(url).hash.split('?')[0];
  } catch (_) {
    return '';
  }
}

// Marks everything outside the reader pane inert, remembering the focus.
const SCOPE_ON = `(() => {
  const r = document.querySelector('.tm-reader[data-open="1"]');
  const pane = r && (r.closest('.reader-pane') || r);
  if (!pane) return null;
  window.__taifaFindFocus = document.activeElement;
  let n = pane;
  while (n && n.parentElement && n !== document.documentElement) {
    for (const s of n.parentElement.children) {
      if (s !== n && !s.inert && s.tagName !== 'SCRIPT' && s.tagName !== 'STYLE') {
        s.inert = true;
        s.setAttribute('data-taifa-find-inert', '');
      }
    }
    n = n.parentElement;
  }
  const b = pane.getBoundingClientRect();
  return { x: b.left, y: b.top, width: b.width, height: b.height };
})()`;

const SCOPE_OFF = `(() => {
  document.querySelectorAll('[data-taifa-find-inert]').forEach((e) => { e.inert = false; e.removeAttribute('data-taifa-find-inert'); });
  const f = window.__taifaFindFocus;
  window.__taifaFindFocus = null;
  if (f && f.isConnected && document.activeElement !== f && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch (_) {} }
  return true;
})()`;

// The reader pane's rect, with its top moved down past the reader toolbar so
// the bar never covers a toolbar button.
const PANE_RECT = `(() => {
  const r = document.querySelector('.tm-reader[data-open="1"]');
  const pane = r && (r.closest('.reader-pane') || r);
  if (!pane) return null;
  const b = pane.getBoundingClientRect();
  let top = b.top;
  for (const t of r.querySelectorAll('.tm-reader-tool')) {
    const tb = t.getBoundingClientRect();
    if (tb.height && tb.bottom < b.top + 160) top = Math.max(top, tb.bottom);
  }
  return { x: b.left, y: top, width: b.width, height: b.height };
})()`;

// deps: { WebContentsView, uiUrl, preload, isMailWindow }
function createFinder(deps) {
  const { WebContentsView, uiUrl, preload, isMailWindow } = deps;
  const bars = new Map(); // BrowserWindow -> { view, text, matches, active, busy }

  function send(win, extra = {}) {
    const b = bars.get(win);
    if (!b || b.view.webContents.isDestroyed()) return;
    b.view.webContents.send('find:state', { matches: b.matches, active: b.active, text: b.text, ...extra });
  }

  async function place(win) {
    const b = bars.get(win);
    if (!b || win.isDestroyed()) return;
    const pane = await win.webContents.executeJavaScript(PANE_RECT, true).catch(() => null);
    if (!bars.has(win) || win.isDestroyed()) return;
    const c = win.getContentBounds();
    b.view.setBounds(barBounds(pane, win.webContents.getZoomFactor(), { width: c.width, height: c.height }));
  }

  // One search, scoped to the message, resolving to { matches, active }.
  async function run(win, text, opts) {
    const wc = win.webContents;
    const pane = await wc.executeJavaScript(SCOPE_ON, true).catch(() => null);
    if (!pane) {
      await wc.executeJavaScript(SCOPE_OFF, true).catch(() => {});
      return { matches: 0, active: 0 };
    }
    const result = await new Promise((resolve) => {
      let last = { matches: 0, active: 0 };
      const t = setTimeout(done, 1500);
      function on(_e, r) {
        if (r.matches !== undefined) last = { matches: r.matches, active: r.activeMatchOrdinal || last.active };
        if (r.finalUpdate) done();
      }
      function done() {
        clearTimeout(t);
        wc.removeListener('found-in-page', on);
        resolve(last);
      }
      wc.on('found-in-page', on);
      wc.findInPage(text, opts);
    });
    await wc.executeJavaScript(SCOPE_OFF, true).catch(() => {});
    return result;
  }

  async function query(win, text, forward, isNew) {
    const b = bars.get(win);
    if (!b) return;
    b.text = text;
    if (!text) {
      win.webContents.stopFindInPage('clearSelection');
      b.matches = 0;
      b.active = 0;
      send(win);
      return;
    }
    // Searches run one at a time; a newer one replaces any that is waiting.
    b.pendingQuery = { text, forward, isNew };
    if (b.busy) return;
    b.busy = true;
    while (b.pendingQuery && bars.get(win) === b) {
      const q = b.pendingQuery;
      b.pendingQuery = null;
      const r = await run(win, q.text, { forward: q.forward, findNext: !!q.isNew, matchCase: false });
      if (bars.get(win) !== b) break;
      b.matches = r.matches;
      b.active = r.active;
      if (!b.pendingQuery) send(win);
    }
    b.busy = false;
  }

  function open(win) {
    if (!isMailWindow(win)) return false;
    let b = bars.get(win);
    if (b) {
      send(win, { focus: true });
      b.view.webContents.focus();
      place(win);
      return true;
    }
    const view = new WebContentsView({
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    view.setBackgroundColor('#00000000');
    b = { view, text: '', matches: 0, active: 0, busy: false, pendingQuery: null, lastText: '' };
    bars.set(win, b);
    win.contentView.addChildView(view);
    place(win);
    const onResize = () => place(win);
    // Another conversation (or none): the matches no longer apply. The page
    // adding ?mid= to the same conversation's route is not a change.
    const at = conversationOf(win.webContents.getURL());
    const onInPage = (_e, url, isMainFrame) => {
      if (isMainFrame !== false && conversationOf(url) !== at) close(win, false);
    };
    const onStart = (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) close(win, false);
    };
    win.on('resize', onResize);
    win.webContents.on('did-navigate-in-page', onInPage);
    win.webContents.on('did-start-navigation', onStart);
    b.detach = () => {
      if (!win.isDestroyed()) {
        win.removeListener('resize', onResize);
        win.webContents.removeListener('did-navigate-in-page', onInPage);
        win.webContents.removeListener('did-start-navigation', onStart);
      }
    };
    view.webContents.once('did-finish-load', () => {
      if (b.lastText) send(win, { text: b.lastText, focus: true });
      view.webContents.focus();
    });
    view.webContents.loadURL(uiUrl('find/find.html'));
    return true;
  }

  function close(win, refocus = true) {
    const b = bars.get(win);
    if (!b) return;
    bars.delete(win);
    lastText.set(win, b.text);
    if (b.detach) b.detach();
    if (!win.isDestroyed()) {
      try {
        win.webContents.stopFindInPage('keepSelection');
      } catch (_) {}
      try {
        win.contentView.removeChildView(b.view);
      } catch (_) {}
      if (refocus) win.webContents.focus();
    }
    if (!b.view.webContents.isDestroyed()) b.view.webContents.close();
  }

  // The last text per window, so Cmd+G after closing the bar finds it again.
  const lastText = new WeakMap();

  // Cmd+G / Shift+Cmd+G: the next or previous match, opening the bar with the
  // last text when it is closed.
  function step(win, forward) {
    const b = bars.get(win);
    if (!b) {
      const t = lastText.get(win) || '';
      open(win);
      const nb = bars.get(win);
      if (nb && t) {
        nb.lastText = t;
        query(win, t, forward, true);
      }
      return;
    }
    if (b.text) query(win, b.text, forward, false);
  }

  function senderWindow(sender) {
    for (const [win, b] of bars) if (!b.view.webContents.isDestroyed() && b.view.webContents === sender) return win;
    return null;
  }

  // IPC from a find bar. Only a bar we created is listened to.
  function handle(channel, sender, text, forward) {
    const win = senderWindow(sender);
    if (!win) return;
    if (channel === 'find:query') query(win, String(text || '').slice(0, 500), true, true);
    else if (channel === 'find:step') step(win, forward !== false);
    else if (channel === 'find:close') close(win);
  }

  return { open, close, step, handle, isOpen: (win) => bars.has(win), _bars: bars };
}

module.exports = { createFinder, barBounds, conversationOf, BAR_W, BAR_H, SCOPE_ON, SCOPE_OFF };
