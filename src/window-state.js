'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Remembers window geometry across launches. Zero dependency on purpose: this is
// ~50 lines, and electron-window-state is thinly maintained for what it does.
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  // Any failure here (missing file, truncated write, hand-edited JSON) falls
  // through to defaults. A corrupt state file must never stop the app opening.
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

// True when the rect overlaps at least one pixel of some display's work area.
// `screen` is required lazily: it throws if touched before app.whenReady() on
// some platforms, and this module is required at the top of main.js.
function intersectsSomeWorkArea(b) {
  const { screen } = require('electron');
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + b.width > w.x &&
    b.y < w.y + w.height && b.y + b.height > w.y);
}

function restoreBounds(defaults) {
  const centred = { width: defaults.width, height: defaults.height, isMaximized: false };
  const saved = readState();
  if (!saved) return centred;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(Number.isFinite)) return centred;
  // Validate against the CURRENT displays, not the ones the rect was saved from.
  // Otherwise unplugging the monitor the app was last on restores the window to
  // coordinates no display covers any more: the app launches, reports itself
  // running, and is invisible. That reaches us as a "the app won't open" ticket
  // and is miserable to diagnose remotely. Dropping x/y lets Electron centre it.
  if (!intersectsSomeWorkArea({ x, y, width, height })) return centred;
  return { x, y, width, height, isMaximized: !!saved.isMaximized };
}

function track(win) {
  let timer = null;
  const save = () => {
    try {
      // getNormalBounds, not getBounds: while maximized, getBounds returns the
      // maximized rect, so un-maximizing after a restart would spring to full
      // screen instead of back to the size the user actually chose.
      const b = win.getNormalBounds();
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify({ ...b, isMaximized: win.isMaximized() }));
    } catch (_) { /* a state file we cannot write is not worth a crash */ }
  };
  // resize and move fire continuously through a drag, so coalesce instead of
  // writing the file on every frame.
  const queue = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  win.on('resize', queue);
  win.on('move', queue);
  // Save synchronously on close: a pending debounce would never fire once the
  // window is gone, losing the last move or resize. The window is not destroyed
  // yet at this point, so the bounds are still readable.
  win.on('close', () => { clearTimeout(timer); save(); });
}

module.exports = { restoreBounds, track };
