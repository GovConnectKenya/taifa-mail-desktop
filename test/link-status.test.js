'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { linkStatusParts } = require('../src/link-status');
const { PAGE_SHIM_JS } = require('../src/page-shim');

const APP = 'https://mail.govconnect.ke';

test('a web link shows its real host, in its own part', () => {
  assert.deepEqual(linkStatusParts('https://example.org/read-more', APP), { pre: 'https://', host: 'example.org', rest: '/read-more' });
  assert.deepEqual(linkStatusParts('http://evil.example:8080/a?b=1#c', APP), { pre: 'http://', host: 'evil.example', rest: ':8080/a?b=1#c' });
  assert.deepEqual(linkStatusParts('https://example.org/', APP), { pre: 'https://', host: 'example.org', rest: '' });
});

test('look-alikes and credential tricks are shown for what they are', () => {
  // "paypal.com" with a Cyrillic a: the parser's punycode form shows.
  assert.equal(linkStatusParts('https://pаypal.com/login', APP).host, 'xn--pypal-4ve.com');
  // https://mail.govconnect.ke@evil.example/ goes to evil.example.
  const p = linkStatusParts('https://mail.govconnect.ke:secret@evil.example/x', APP);
  assert.equal(p.host, 'evil.example');
  assert.equal(p.pre, 'https://mail.govconnect.ke:•••@');
});

test('mailto shows the address; app routes and script URLs show nothing', () => {
  assert.deepEqual(linkStatusParts('mailto:jane%40ke.go?subject=x', APP), { pre: 'Email ', host: 'jane@ke.go', rest: '' });
  for (const u of ['', null, 'javascript:alert(1)', 'data:text/html,x', 'blob:https://mail.govconnect.ke/1', `${APP}/#INBOX/4`, 'not a url']) {
    assert.equal(linkStatusParts(u, APP), null, String(u));
  }
});

test('the bubble is drawn with text only and never takes clicks', () => {
  assert.ok(PAGE_SHIM_JS.includes("attachShadow({ mode: 'closed' })"));
  assert.ok(PAGE_SHIM_JS.includes('pointer-events:none'));
  assert.ok(!/\.link = [\s\S]{0,3000}innerHTML/.test(PAGE_SHIM_JS));
});
