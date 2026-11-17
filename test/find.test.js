'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { barBounds, conversationOf, SCOPE_ON, SCOPE_OFF, BAR_W, BAR_H } = require('../src/find');
const { resolveUiRequest } = require('../src/ui-scheme');
const fs = require('fs');
const path = require('path');

test('the bar sits at the reader pane’s top-right, scaled by zoom, inside the window', () => {
  const content = { width: 1200, height: 820 };
  assert.deepEqual(barBounds({ x: 760, y: 60, width: 440, height: 760 }, 1, content), { x: 1200 - BAR_W - 8, y: 64, width: BAR_W, height: BAR_H });
  const z = barBounds({ x: 500, y: 60, width: 400, height: 700 }, 0.75, content);
  assert.equal(z.x, Math.round(900 * 0.75) - BAR_W - 8);
  assert.equal(z.y, 45 + 4);
  const tiny = barBounds(null, 1, { width: 300, height: 40 });
  assert.ok(tiny.x >= 8 && tiny.y >= 0);
});

test('only another conversation closes the bar, not ?params on the same one', () => {
  assert.equal(conversationOf('https://mail.govconnect.ke/#INBOX/12?mid=%3Cx%3E'), conversationOf('https://mail.govconnect.ke/#INBOX/12'));
  assert.notEqual(conversationOf('https://mail.govconnect.ke/#INBOX/12'), conversationOf('https://mail.govconnect.ke/#INBOX/13'));
  assert.equal(conversationOf('nonsense'), '');
});

test('the scope scripts compile, restore every inert mark and the focus', () => {
  assert.doesNotThrow(() => new Function(`return ${SCOPE_ON}`));
  assert.doesNotThrow(() => new Function(`return ${SCOPE_OFF}`));
  assert.ok(SCOPE_ON.includes("setAttribute('data-taifa-find-inert'"));
  assert.ok(SCOPE_OFF.includes("removeAttribute('data-taifa-find-inert')") && SCOPE_OFF.includes('focus({ preventScroll: true })'));
});

test('the find bar page and its icons are served, and use only chevrons', () => {
  const root = path.join(__dirname, '..', 'src');
  for (const f of ['find/find.html', 'find/icons/arrow-up3.svg', 'find/icons/arrow-down4.svg', 'find/icons/close.svg']) {
    const file = resolveUiRequest(`taifa-ui://app/${f}`, root);
    assert.ok(file && fs.existsSync(file), f);
  }
  const html = fs.readFileSync(path.join(root, 'find/find.html'), 'utf8');
  assert.ok(html.includes("e.key === 'Escape'") && html.includes("e.key === 'Enter'") && html.includes('e.shiftKey'));
  assert.ok(html.includes("'No matches'") && html.includes("' of '"));
  assert.ok(!/—/.test(html), 'no em dashes');
});
