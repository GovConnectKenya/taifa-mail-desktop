'use strict';
// Round 3 critic #15: quoted text in printouts fell back to a sans font. The
// print document is Times throughout; code stays monospace.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrintHtml } = require('../src/print');

test('printed HTML bodies, quotes included, are set in Times', () => {
  const html = buildPrintHtml({ subject: 'Re: circular', messages: [{ fromName: 'A', fromAddr: 'a@x.ke', to: [], cc: [], date: '', html: '<p style="font-family:Arial">Hi</p><blockquote style="font-family:sans-serif">quoted</blockquote>', attachments: [] }] });
  assert.match(html, /\.body\.html, \.body\.html \* \{ font-family: 'Times New Roman', Times, 'Liberation Serif', serif !important; \}/);
  assert.match(html, /\.body\.html pre[^{]*\{ font-family: Menlo, Consolas, 'Liberation Mono', monospace !important; \}/);
  assert.ok(!/font-family:[^;]*(Arial|Helvetica|sans-serif)[^;]*!important/.test(html), 'no sans font forced anywhere');
  assert.ok(!/color: #(?!000|fff)[0-9a-f]{3,6}/i.test(html.split('</style>')[0]), 'still black and white');
});
