'use strict';

// openRoute navigates inside the page. If that script ever fails, the old
// fallback was loadURL, which reloads the whole webmail and drops anything in
// flight (a message in its undo-send window, an open composer). Reload only
// when the window is not on the webmail at all (offline page, blank page);
// when it is, a failed in-page navigation is left alone rather than destroyed.
function shouldReloadAfterFailedNavigation(currentUrl, appOrigin) {
  try {
    return new URL(currentUrl).origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

module.exports = { shouldReloadAfterFailedNavigation };
