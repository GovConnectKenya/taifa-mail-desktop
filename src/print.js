'use strict';

// File > Print (Cmd+P): prints the open conversation, not the app window.
//
// The webmail's own "print" is a PDF download, and printing the main window
// would print the whole app (rail, list, toolbar). So the app asks the page for
// the open conversation (page-actions.js 'print': subject, and each expanded
// message's From, To, Date and body HTML), lays it out as a plain document and
// prints that from a hidden window with the system print dialog.
//
// The body HTML is the sender's, so the print window is locked down: no
// JavaScript, no preload, its own in-memory session, a CSP that allows only
// inline styles and images, and a request filter that lets through nothing but
// the document itself and images.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRINT_PARTITION = 'taifa-print';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CSP = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:";

// Pure: the print document for { subject, messages: [{ from, to, date, body }] }.
function buildPrintHtml(data) {
  const subject = escapeHtml((data && data.subject) || '(no subject)');
  const msgs = (data && Array.isArray(data.messages) ? data.messages : []).map((m) => {
    const rows = [
      ['From', m.from],
      ['To', m.to],
      ['Date', m.date],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><th>${k}:</th><td>${escapeHtml(v)}</td></tr>`)
      .join('');
    return `<section class="msg"><table class="hdr">${rows}</table><div class="body">${String(m.body || '')}</div></section>`;
  });
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${subject}</title>
<style>
  @page { margin: 16mm 14mm; }
  html, body { background: #fff !important; color: #000 !important; color-scheme: light !important; }
  body { margin: 0; font: 11pt/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 16pt; line-height: 1.3; margin: 0 0 12pt; }
  .msg { padding: 10pt 0 12pt; border-top: 1px solid #000; break-inside: auto; }
  .hdr { border-collapse: collapse; margin: 0 0 10pt; font-size: 10pt; }
  .hdr th { text-align: left; font-weight: 600; padding: 0 8pt 2pt 0; vertical-align: top; white-space: nowrap; }
  .hdr td { padding: 0 0 2pt; }
  .body { max-width: 100%; overflow-wrap: anywhere; }
  .body img { max-width: 100% !important; height: auto; }
  .body, .body * { color-scheme: light; }
</style></head>
<body><h1>${subject}</h1>${msgs.join('')}</body></html>`;
}

let sessionReady = false;
function printSession(session) {
  const ses = session.fromPartition(PRINT_PARTITION, { cache: false });
  if (!sessionReady) {
    sessionReady = true;
    ses.webRequest.onBeforeRequest((d, cb) => {
      const ok = (d.resourceType === 'mainFrame' && d.url.startsWith('file:')) || d.url.startsWith('data:') || (d.resourceType === 'image' && /^https?:/i.test(d.url));
      cb({ cancel: !ok });
    });
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
  }
  return ses;
}

// electron: { BrowserWindow, session, app }. opts.toPdf: return a PDF buffer
// instead of opening the print dialog (used by tests and the harness).
async function printConversation(electron, data, opts = {}) {
  const { BrowserWindow, session, app } = electron;
  const html = buildPrintHtml(data);
  const file = path.join(app.getPath('temp'), `taifa-print-${crypto.randomUUID()}.html`);
  await fs.promises.writeFile(file, html, { mode: 0o600 });
  const w = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: {
      session: printSession(session),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const cleanup = () => {
    if (!w.isDestroyed()) w.destroy();
    fs.promises.unlink(file).catch(() => {});
  };
  try {
    await w.loadFile(file);
    if (opts.toPdf) {
      const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      cleanup();
      return pdf;
    }
    return await new Promise((resolve) => {
      w.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
        cleanup();
        resolve({ ok, reason });
      });
    });
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { buildPrintHtml, printConversation, escapeHtml, PRINT_PARTITION };
