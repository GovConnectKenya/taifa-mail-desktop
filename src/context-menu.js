'use strict';

// The right-click menu for text, links and images, as a pure template builder
// (test/context-menu.test.js). Electron shows nothing on right-click unless the
// app builds a menu, so before this there were no spelling suggestions, no
// Copy Link and no Look Up anywhere.
//
// The webmail keeps its own menus: it calls preventDefault on right-clicks over
// the message list and the folder rail, and Chromium then never raises the
// 'context-menu' event, so this only appears where the page shows nothing.
//
// params is Electron's ContextMenuParams. Link and image URLs come from email
// HTML, so they are attacker controlled: the actions that use them go through
// main, which opens only the schemes config.js allows.

const MAX_SUGGESTIONS = 6;

function truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function linkKind(url) {
  try {
    const p = new URL(url).protocol;
    if (p === 'mailto:') return 'mailto';
    if (p === 'http:' || p === 'https:') return 'web';
  } catch (_) {
    /* not a URL */
  }
  return null;
}

// ctx: { platform, isDev }. act(id, arg) runs an action.
function buildContextMenuTemplate(params, ctx, act) {
  const isMac = ctx.platform === 'darwin';
  const flags = params.editFlags || {};
  const sel = String(params.selectionText || '');
  const hasSel = sel.trim().length > 0;
  const sections = [];
  const click = (id, arg) => () => act(id, arg);

  // Spelling: only on a misspelled word in an editable field.
  if (params.isEditable && params.misspelledWord) {
    const sugg = (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS);
    const s = sugg.length
      ? sugg.map((w) => ({ label: w, click: click('replace-misspelling', w) }))
      : [{ label: 'No Guesses Found', enabled: false }];
    s.push({ type: 'separator' });
    s.push({ label: 'Add to Dictionary', click: click('add-to-dictionary', params.misspelledWord) });
    sections.push(s);
  }

  // Look Up (macOS), on a selection.
  if (isMac && hasSel) {
    sections.push([{ label: `Look Up “${truncate(sel, 24)}”`, click: click('look-up') }]);
  }

  // Links.
  const kind = params.linkURL ? linkKind(params.linkURL) : null;
  if (kind === 'web') {
    sections.push([
      { label: 'Open Link in Browser', click: click('open-link', params.linkURL) },
      { label: 'Copy Link', click: click('copy-link', params.linkURL) },
    ]);
  } else if (kind === 'mailto') {
    sections.push([
      { label: 'New Message to Address', click: click('compose-to', params.linkURL) },
      { label: 'Copy Email Address', click: click('copy-address', params.linkURL) },
    ]);
  }

  // Images.
  if (params.mediaType === 'image' && params.hasImageContents !== false) {
    const s = [{ label: 'Copy Image', click: click('copy-image', { x: params.x, y: params.y }) }];
    if (linkKind(params.srcURL) === 'web') s.push({ label: 'Copy Image Address', click: click('copy-link', params.srcURL) });
    sections.push(s);
  }

  // Editing.
  if (params.isEditable) {
    sections.push([
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: !!flags.canCopy },
      { role: 'paste', enabled: !!flags.canPaste },
      ...(isMac ? [{ role: 'pasteAndMatchStyle', enabled: !!flags.canPaste }] : []),
      { role: 'selectAll', enabled: flags.canSelectAll !== false },
    ]);
  } else if (hasSel) {
    sections.push([{ role: 'copy', enabled: flags.canCopy !== false }]);
  }

  if (ctx.isDev) sections.push([{ label: 'Inspect Element', click: click('inspect', { x: params.x, y: params.y }) }]);

  const out = [];
  for (const s of sections) {
    if (out.length) out.push({ type: 'separator' });
    out.push(...s);
  }
  return out;
}

// The spell checker languages for Windows and Linux: the system's preferred
// languages that Chromium has a dictionary for, in order. macOS uses the
// system spell checker with the system's own languages, so this is not called
// there. Falls back to British then US English.
function pickSpellLanguages(preferred, available) {
  const avail = new Map((available || []).map((l) => [String(l).toLowerCase(), l]));
  const out = [];
  const add = (l) => {
    if (l && !out.includes(l)) out.push(l);
  };
  for (const raw of preferred || []) {
    const tag = String(raw).replace('_', '-');
    const lower = tag.toLowerCase();
    if (avail.has(lower)) add(avail.get(lower));
    else {
      // en-KE has no dictionary; its base language does.
      const base = lower.split('-')[0];
      const match = [...avail.keys()].find((k) => k === base || k.startsWith(`${base}-`));
      if (match) add(avail.get(match));
    }
    if (out.length >= 3) break;
  }
  if (!out.length) for (const l of ['en-GB', 'en-US']) if (avail.has(l.toLowerCase())) add(avail.get(l.toLowerCase()));
  return out.length ? out : ['en-GB', 'en-US'];
}

module.exports = { buildContextMenuTemplate, pickSpellLanguages, linkKind };
