'use strict';

// What the app says about a file drop the page could not attach (page-shim.js
// reports the outcome). One message, and an accurate one:
//
// - attached, or the page already explained the failure in its own toast
//   ('page-reported'): the app says nothing. Round 2 showed a native sheet
//   blaming "your connection" on top of the webmail's correct toast ("file
//   attachments are not available on this server right now").
// - the machine is offline: say so, since that is then the real cause.
// - otherwise: say the upload did not go through, without guessing why.
//
// Returns null (say nothing) or { message, detail }. Pure.
function dropAlert(data) {
  const outcome = data && data.outcome;
  if (!outcome || outcome === 'attached' || outcome === 'page-reported') return null;
  const n = Math.max(1, Number(data.count) || 0);
  const it = n === 1 ? 'it' : 'them';
  const names = Array.isArray(data.names) ? data.names.map((x) => String(x).slice(0, 80)).slice(0, 5) : [];
  const list = names.length ? `\n\n${names.join('\n')}${n > names.length ? `\nand ${n - names.length} more` : ''}` : '';
  const message = n === 1 ? 'The file wasn’t attached' : 'The files weren’t attached';
  let detail;
  if (outcome === 'no-composer') detail = `Taifa Mail couldn’t open a new message to attach ${it} to. Open a new message and drop ${it} there.`;
  else if (data.online === false) detail = `You’re offline. Attach ${it} again when you’re back online.`;
  else detail = `The upload didn’t go through. Try attaching ${it} again.`;
  return { message, detail: detail + list };
}

module.exports = { dropAlert };
