'use strict';

// The About Taifa Mail window: the parts that need no Electron, so they can be
// tested. The window itself is created in main.js; the page is
// src/about/about.html, served from taifa-ui://app/about/about.html.

const path = require('path');

const ABOUT_SIZE = Object.freeze({ width: 420, height: 520 });

// What the page's buttons may ask main to open. The page sends a KEY, never a
// URL, so even a compromised page can only reach these fixed targets.
const ABOUT_LINKS = Object.freeze({
  'whats-new': { url: 'https://github.com/GovConnectKenya/taifa-mail-desktop/releases' },
  // The webmail has no help route of its own (its help is the docs site that
  // Help > Taifa Mail Help already opens), so Support goes there.
  help: { url: 'https://govconnect.ke/docs' },
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
function buildAboutInfo({ platform, appVersion, bundle, update }) {
  return {
    platform,
    appVersion,
    webmailVersion: bundle && bundle.webmail ? String(bundle.webmail) : '',
    webmailCommit: bundle && bundle.commit ? String(bundle.commit).slice(0, 9) : '',
    update: update ? { state: update.state, version: update.version, percent: update.percent } : { state: 'idle' },
  };
}

module.exports = { ABOUT_SIZE, ABOUT_LINKS, aboutLink, chromiumLicencePath, buildAboutInfo };
