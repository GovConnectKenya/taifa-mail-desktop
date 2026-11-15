'use strict';

// "Open Conversation in New Window" (Cmd+O, and the webmail's own "Open in new
// window"): a focused window with one conversation in it, like a message window
// in Apple Mail or Outlook. Round 2 opened a second full client (rail, list and
// reader) at 980x800.
//
// It is the same webmail page, so every reader action works as in the main
// window (Reply, Reply All, Forward, Archive, Delete, Print, Find), with the
// rest of the app styled away: no top bar, no folder rail, no message list, and
// none of the list navigation (back to list, newer/older conversation). The
// window closes itself when its conversation goes away (archived, deleted,
// moved) or the page moves to another one, since it is a window for THAT
// conversation. Its title is the conversation's subject.
//
// Pure, so it is unit tested (test/message-window.test.js).

const MESSAGE_SIZE = Object.freeze({ width: 860, height: 900 });

// '/#INBOX/174' or '/#folder/search/12?mid=...' -> true.
function isConversationRoute(route) {
  return typeof route === 'string' && /^\/#(?:folder\/)?[^/?#]+\/\d+(?:\?|$)/.test(route);
}

function messageWindowCss(platform) {
  // macOS: the traffic lights sit over the top-left corner, so the reader
  // starts below them and the strip they sit in drags the window.
  const mac = platform === 'darwin';
  return `
.tm-shell-topbar, .tm-shell-rail, .list-col { display: none !important; }
.tm-shell-body { padding: ${mac ? '38px' : '0'} 0 0 !important; height: 100vh !important; box-sizing: border-box !important; }
.tm-shell-main, .mail-wrap, .mail-app { margin: 0 !important; left: 0 !important; width: 100% !important; max-width: none !important; grid-template-columns: 1fr !important; }
.tm-shell-main { padding: 0 8px 8px !important; }
.reader-pane { flex: 1 1 auto !important; width: 100% !important; max-width: none !important; }
.tm-reader-back, .tm-reader-position, .tm-reader-tool[aria-label="Newer conversation"], .tm-reader-tool[aria-label="Older conversation"] { display: none !important; }
${mac ? `html::before { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 38px; -webkit-app-region: drag; z-index: 2147483647; }` : ''}
`;
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

module.exports = { MESSAGE_SIZE, isConversationRoute, messageWindowCss, conversationKey, shouldCloseOnNavigate, messageTitle };
