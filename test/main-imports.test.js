'use strict';
// main.js cannot be loaded outside Electron, so a call to a helper it forgot
// to import only shows up at run time, as an uncaught exception that blocks
// the app behind a modal alert. This catches that class of bug: every function
// that main.js calls and that one of the shell's own modules exports must be
// imported (or defined) in main.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('main.js imports every shell helper it calls', () => {
  const src = path.join(__dirname, '..', 'src');
  // Comments and string contents removed, so prose like "failed to load (...)"
  // is not a call.
  const main = fs
    .readFileSync(path.join(src, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  const exported = new Map();
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.js') && f !== 'main.js' && f !== 'preload.js')) {
    let mod;
    try {
      mod = require(path.join(src, f));
    } catch (_) {
      continue; // needs Electron at load time
    }
    for (const k of Object.keys(mod || {})) if (typeof mod[k] === 'function') exported.set(k, f);
  }
  const declared = new Set();
  for (const m of main.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of main.matchAll(/const\s*\{([^}]+)\}\s*=\s*require/g)) for (const n of m[1].split(',')) declared.add(n.split(':').pop().trim());
  const missing = [];
  for (const m of main.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (exported.has(name) && !declared.has(name)) missing.push(`${name} (from ${exported.get(name)})`);
  }
  assert.deepEqual([...new Set(missing)], []);
});
