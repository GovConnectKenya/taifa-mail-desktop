'use strict';

// mailto: link -> the webmail's compose route.
//
// The webmail already accepts a prefilled compose on its mail route
// (webmail/src/mail/mail-url.ts): "#INBOX?compose=new&to=..&cc=..&bcc=..
// &subject=..&body=..", with address lists comma-joined AFTER each address is
// encoded, so a comma inside one address survives as %2C. This only translates
// RFC 6068 into that; the webmail validates every field as it does for any URL.
//
// The input is attacker controlled (any web page can link to mailto:), so the
// output is only ever a route on our own origin, built from parsed parts, never
// a string the link chose.

const MAX_FIELD = 8000;

function splitAddresses(value) {
  return value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function mailtoToRoute(link) {
  let u;
  try {
    u = new URL(link);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'mailto:') return null;

  let pathTo = '';
  try {
    pathTo = decodeURIComponent(u.pathname || '');
  } catch (_) {
    pathTo = '';
  }
  const fields = { to: splitAddresses(pathTo), cc: [], bcc: [], subject: '', body: '' };
  for (const [rawKey, rawValue] of u.searchParams) {
    const key = rawKey.toLowerCase();
    const value = rawValue.slice(0, MAX_FIELD);
    if (key === 'to' || key === 'cc' || key === 'bcc') fields[key].push(...splitAddresses(value));
    else if (key === 'subject' && !fields.subject) fields.subject = value;
    else if (key === 'body' && !fields.body) fields.body = value;
  }

  const params = ['compose=new'];
  for (const key of ['to', 'cc', 'bcc']) {
    if (fields[key].length) params.push(`${key}=${fields[key].map(encodeURIComponent).join(',')}`);
  }
  if (fields.subject) params.push(`subject=${encodeURIComponent(fields.subject)}`);
  if (fields.body) params.push(`body=${encodeURIComponent(fields.body)}`);
  return `/#INBOX?${params.join('&')}`;
}

module.exports = { mailtoToRoute };
