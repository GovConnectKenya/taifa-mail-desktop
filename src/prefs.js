'use strict';
const fs = require('fs');
const path = require('path');

// The few shell preferences the app keeps itself (the webmail keeps its own in
// its page storage). One small JSON file in userData; any read or write
// failure falls back to the defaults rather than stopping the app.
const DEFAULTS = Object.freeze({ spellcheck: true });

let file = null;
let cache = null;

function load(userData) {
  file = path.join(userData, 'shell-prefs.json');
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) {
  return (cache || DEFAULTS)[key];
}

function set(key, value) {
  cache = { ...(cache || DEFAULTS), [key]: value };
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch (_) {
    /* not worth failing over */
  }
}

module.exports = { load, get, set, DEFAULTS };
