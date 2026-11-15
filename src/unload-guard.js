'use strict';

// The webmail cancels beforeunload while a send is held in its undo window or in
// flight. In Electron a cancelled beforeunload blocks any reload, navigation,
// window close during quit, or updater restart SILENTLY: no dialog, and the app
// just refuses to go. 'will-prevent-unload' is the hook that gives it the
// browser behaviour: ask, and let the user choose.
//
// Stay is the default (and what Escape does). Leave calls event.preventDefault(),
// which tells Electron to ignore the page's objection and carry on.
//
// The dialog is attached to the window only when it is visible: a modal sheet on
// a hidden (tray) window can never be seen, which would hang a quit forever.
function handleWillPreventUnload({ dialog, win }, event) {
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  const options = {
    type: 'question',
    buttons: ['Stay', 'Leave'],
    defaultId: 0,
    cancelId: 0,
    title: 'Taifa Mail',
    message: 'A message is still being sent. Leave anyway?',
    detail: 'If you leave now the message may not be sent.',
  };
  const choice = visible ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
  if (choice === 1) event.preventDefault();
  return choice === 1;
}

module.exports = { handleWillPreventUnload };
