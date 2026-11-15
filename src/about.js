'use strict';

// The About Taifa Mail window: the parts that need no Electron, so they can be
// tested. The window itself is created in main.js; the page is
// src/about/about.html, served from taifa-ui://app/about/about.html.

const path = require('path');
const { APP_ORIGIN } = require('./config');

// Two columns: the illustration panel and the details (4px grid).
const ABOUT_SIZE = Object.freeze({ width: 720, height: 440 });

// What the page's buttons may ask main to open. The page sends a KEY, never a
// URL, so even a compromised page can only reach these fixed targets.
const ABOUT_LINKS = Object.freeze({
  'whats-new': { url: 'https://github.com/GovConnectKenya/taifa-mail-desktop/releases' },
  // The webmail has no help route of its own (its help is the docs site that
  // Help > Taifa Mail Help already opens), so Support goes there.
  help: { url: 'https://govconnect.ke/docs' },
  rcfi: { url: 'https://rcfi.co.ke' },
  // The host the app itself talks to (round 3 found mail.taifa.go.ke here).
  webmail: { url: APP_ORIGIN },
  'chromium-licences': { file: 'LICENSES.chromium.html' },
});

function aboutLink(key) {
  return Object.prototype.hasOwnProperty.call(ABOUT_LINKS, key) ? ABOUT_LINKS[key] : null;
}

// Where Electron puts LICENSES.chromium.html: next to the executable on
// Windows and Linux, inside the framework's resources on macOS.
function chromiumLicencePath({ platform, resourcesPath, execPath }) {
  if (platform === 'darwin') {
    return path.join(path.dirname(resourcesPath), 'Frameworks', 'Electron Framework.framework', 'Resources', 'LICENSES.chromium.html');
  }
  return path.join(path.dirname(execPath), 'LICENSES.chromium.html');
}

// The payload the page renders its version rows from.
// update.fresh: the state is from the last minute, so the page shows it even
// when it is a transient one (checking, error) the user just asked for.
function buildAboutInfo({ platform, appVersion, bundle, update, now = Date.now() }) {
  return {
    platform,
    appVersion,
    webmailHost: new URL(APP_ORIGIN).host,
    webmailVersion: bundle && bundle.webmail ? String(bundle.webmail) : '',
    webmailCommit: bundle && bundle.commit ? String(bundle.commit).slice(0, 9) : '',
    update: update
      ? { state: update.state, version: update.version, percent: update.percent, fresh: typeof update.at === 'number' && now - update.at < 60000 }
      : { state: 'idle' },
  };
}

module.exports = { ABOUT_SIZE, ABOUT_LINKS, aboutLink, chromiumLicencePath, buildAboutInfo };
