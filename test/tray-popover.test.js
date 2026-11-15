'use strict';
// Round 3 critic #15: the popover showed the unread count twice, wrote the
// update feed's version with innerHTML, and drew hand-made icons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PAGES } = require('../src/ui-scheme');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'tray', 'popover.html'), 'utf8');

test('no innerHTML anywhere in the popover', () => {
  assert.ok(!/innerHTML/.test(html));
});

test('the count appears once: the pill, with the sentence for assistive tech only', () => {
  assert.ok(!/inboxSub\.textContent = n/.test(html), 'the subtitle never repeats the number');
  assert.match(html, /setAttribute\('aria-label', 'Open Inbox, '/);
});

test('icons are the vendored Iconsax files, served by the app, no inline drawings', () => {
  // The only inline SVG is the Taifa brand mark.
  const svgs = html.match(/<svg[^>]*>/g) || [];
  assert.deepEqual(svgs.map((t) => /class="mark"/.test(t)), svgs.map(() => true), 'no hand-drawn interface icons');
  for (const n of ['direct-inbox', 'edit', 'setting']) {
    assert.ok(html.includes(`taifa-ui://app/tray/icons/${n}.svg`), n);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'tray', 'icons', `${n}.svg`)), n);
    assert.equal(PAGES[`tray/icons/${n}.svg`], `tray/icons/${n}.svg`, 'served by taifa-ui://');
  }
});
