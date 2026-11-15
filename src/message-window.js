'use strict';

// "Open Conversation in New Window" (Cmd+O, and the webmail's own "Open in new
// window"): a focused window with one conversation in it, like a message window
// in Apple Mail or Outlook. Round 2 opened a second full client (rail, list and
// reader) at 980x800.
//
// It is the same webmail page, so every reader action works as in the main
// window (Reply, Reply All, Forward, Archive, Delete, Print, Find), with the
// rest of the app styled away: no top bar, no folder rail, no message list and
// no back to list. Round 3 asked for more:
//
// - a real title bar with the subject in it (a native frame on every platform);
// - its own size and position, remembered across launches and kept on screen;
// - newer and older (the reader's own buttons, and j and k), which move this
//   window to the next conversation. Anything else that changes the
//   conversation (archive, delete, move, the page advancing by itself) still
//   closes the window, since it is a window for THAT conversation.
//
// Pure, so it is unit tested (test/message-window.test.js).

const MESSAGE_SIZE = Object.freeze({ width: 860, height: 900 });

// '/#INBOX/174' or '/#folder/search/12?mid=...' -> true.
function isConversationRoute(route) {
  return typeof route === 'string' && /^\/#(?:folder\/)?[^/?#]+\/\d+(?:\?|$)/.test(route);
}

function messageWindowCss() {
  return `
.tm-shell-topbar, .tm-shell-rail, .list-col { display: none !important; }
.tm-shell-body { padding: 0 !important; height: 100vh !important; box-sizing: border-box !important; }
.tm-shell-main, .mail-wrap, .mail-app { margin: 0 !important; left: 0 !important; width: 100% !important; max-width: none !important; grid-template-columns: 1fr !important; }
.tm-shell-main { padding: 0 8px 8px !important; }
.reader-pane { flex: 1 1 auto !important; width: 100% !important; max-width: none !important; }
.tm-reader-back { display: none !important; }
`;
}

// Run in a message window's page: notes when the user asked for the newer or
// older conversation (the reader's own buttons, or j and k outside a field),
// so main can tell that move from the page advancing by itself.
const FOLLOW_JS = `(() => {
  if (window.__taifaFollowWired) return true;
  window.__taifaFollowWired = true;
  window.__taifaFollow = 0;
  const mark = () => { window.__taifaFollow = Date.now(); };
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.tm-reader-tool') : null;
    if (t && /^(Newer|Older) conversation$/.test(t.getAttribute('aria-label') || '')) mark();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[jk]$/i.test(e.key)) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    mark();
  }, true);
  return true;
})()`;
const FOLLOW_CHECK_JS = 'Date.now() - (window.__taifaFollow || 0) < 2500';

// Where a new message window goes. saved: the last message window's bounds,
// or null; displays: work areas [{ x, y, width, height }]; open: bounds of the
// message windows already open (a new one steps down and right of an exact
// overlap, as Apple Mail does); anchor: the window it was opened from.
function placeMessageWindow({ saved, displays, open = [], anchor, size = MESSAGE_SIZE }) {
  const areas = Array.isArray(displays) && displays.length ? displays : [{ x: 0, y: 0, width: 1440, height: 900 }];
  const fits = (b) =>
    areas.some((a) => b.x >= a.x - 8 && b.y >= a.y - 8 && b.x + Math.min(b.width, 200) <= a.x + a.width && b.y + 40 <= a.y + a.height);
  let b;
  if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && fits(saved)) {
    b = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.max(520, Math.round(saved.width)), height: Math.max(520, Math.round(saved.height)) };
  } else {
    const a = anchor ? areas.find((d) => anchor.x >= d.x && anchor.x < d.x + d.width && anchor.y >= d.y && anchor.y < d.y + d.height) || areas[0] : areas[0];
    const width = Math.min(size.width, a.width - 32);
    const height = Math.min(size.height, a.height - 32);
    // Centred on the window it came from, so it is clearly a new window and
    // not a 28 px offset copy of the main one.
    const cx = anchor ? anchor.x + anchor.width / 2 : a.x + a.width / 2;
    const cy = anchor ? anchor.y + anchor.height / 2 : a.y + a.height / 2;
    b = { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height };
  }
  for (let i = 0; i < 12 && open.some((o) => Math.abs(o.x - b.x) < 8 && Math.abs(o.y - b.y) < 8); i += 1) {
    b = { ...b, x: b.x + 24, y: b.y + 24 };
  }
  // Clamp into the display it is mostly on.
  const a = areas.find((d) => b.x + b.width / 2 >= d.x && b.x + b.width / 2 < d.x + d.width && b.y + b.height / 2 >= d.y && b.y + b.height / 2 < d.y + d.height) || areas[0];
  b.width = Math.min(b.width, a.width);
  b.height = Math.min(b.height, a.height);
  b.x = Math.min(Math.max(b.x, a.x), a.x + a.width - b.width);
  b.y = Math.min(Math.max(b.y, a.y), a.y + a.height - b.height);
  return b;
}

// The conversation a URL shows ('#INBOX/12'), without ?params.
function conversationKey(url) {
  try {
    return new URL(url).hash.split('?')[0];
  } catch (_) {
    return '';
  }
}

// Should the window close after its page moved from `fromUrl` to `toUrl`?
function shouldCloseOnNavigate(fromUrl, toUrl) {
  const a = conversationKey(fromUrl);
  return !!a && conversationKey(toUrl) !== a;
}

// The window title for a subject.
function messageTitle(subject) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim();
  return s ? (s.length > 120 ? `${s.slice(0, 119)}…` : s) : 'Taifa Mail';
}

module.exports = { MESSAGE_SIZE, isConversationRoute, messageWindowCss, conversationKey, shouldCloseOnNavigate, messageTitle, placeMessageWindow, FOLLOW_JS, FOLLOW_CHECK_JS };
