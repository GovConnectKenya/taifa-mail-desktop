'use strict';
const fs = require('fs');
const path = require('path');

// One line per notification attempt, and nothing about the mail itself: the
// event (attempted, shown, failed, clicked, fallback-posted, ...), the permission
// the page saw, whether the window was in front, the unread count and a reason.
// Written under the app's logs folder so "no notification arrived" can be
// diagnosed after the fact.

const MAX_BYTES = 512 * 1024;

function formatLine(fields, at = new Date()) {
  const parts = [at.toISOString()];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${String(v).replace(/[\r\n\s]+/g, '_').slice(0, 120)}`);
  }
  return parts.join(' ');
}

// Appends a line; when the file passes MAX_BYTES it is moved to <file>.1 first.
function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (_) { /* no file yet */ }
    fs.appendFileSync(file, `${line}\n`);
  } catch (_) { /* logging must never break the app */ }
}

module.exports = { formatLine, appendLine, MAX_BYTES };
