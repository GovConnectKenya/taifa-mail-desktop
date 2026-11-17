'use strict';

// File > Print (Cmd+P): prints the open conversation, not the app window.
//
// The webmail's own "print" is a PDF download, and printing the main window
// would print the whole app (rail, list, toolbar). So the app asks the page for
// the whole open conversation (page-actions.js 'print': every message, plain
// text or HTML, collapsed or not), lays it out as a plain black and white
// document and prints that from a hidden window with the system print dialog.
//
// The body HTML is the sender's, so the print window is locked down: no
// JavaScript, no preload, its own in-memory session, a CSP that allows only
// inline styles and data: images, and a request filter that lets through
// nothing but the document itself. The print window never touches the network.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRINT_PARTITION = 'taifa-print';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// "Name <addr>", or whichever half is known.
function person(name, addr) {
  const n = String(name || '').trim();
  const a = String(addr || '').trim();
  if (n && a && n.toLowerCase() !== a.toLowerCase()) return `${n} <${a}>`;
  return n || a;
}

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean).join(', ') : String(v || ''));

// One message as print HTML. Pure.
function messageHtml(m) {
  const rows = [
    ['From', person(m.fromName, m.fromAddr)],
    ['Date', m.date],
    ['To', list(m.to)],
    ['Cc', list(m.cc)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${k}:</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const body = typeof m.html === 'string' ? `<div class="body html">${m.html}</div>` : `<div class="body text">${escapeHtml(m.text || '')}</div>`;
  const atts = Array.isArray(m.attachments) && m.attachments.length
    ? `<div class="atts"><div class="atts-h">${m.attachments.length === 1 ? '1 attachment' : `${m.attachments.length} attachments`}</div><ul>${m.attachments
      .map((a) => {
        const size = fmtSize(a.size);
        return `<li>${escapeHtml(a.name || 'attachment')}${size ? ` <span class="size">(${size})</span>` : ''}</li>`;
      })
      .join('')}</ul></div>`
    : '';
  return `<section class="msg"><table class="hdr">${rows}</table>${body}${atts}</section>`;
}

// Pure: the print document for
// { subject, total, note, messages: [{ fromName, fromAddr, to[], cc[], date, html | text, attachments[] }] }.
function buildPrintHtml(data) {
  const subject = escapeHtml((data && data.subject) || '(no subject)');
  const messages = data && Array.isArray(data.messages) ? data.messages : [];
  const n = messages.length;
  const total = Math.max(n, Number(data && data.total) || 0);
  const count = total > n ? `${n} of ${total} messages (the latest ${n})` : n === 1 ? '1 message' : `${n} messages`;
  const note = data && data.note ? `<p class="note">${escapeHtml(data.note)}</p>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${subject}</title>
<style>
  @page { margin: 18mm 16mm; }
  html, body { background: #fff !important; color: #000 !important; color-scheme: light only !important; }
  body { margin: 0; font: 11pt/1.45 'Times New Roman', Times, 'Liberation Serif', serif; -webkit-print-color-adjust: economy; }
  h1 { font-size: 17pt; line-height: 1.25; font-weight: bold; margin: 0 0 2pt; }
  .count { font-size: 10pt; margin: 0 0 10pt; }
  .note { font-size: 10pt; font-style: italic; margin: 0 0 10pt; }
  .msg { padding: 10pt 0 12pt; border-top: 0.75pt solid #000; }
  .hdr { border-collapse: collapse; margin: 0 0 10pt; font-size: 10.5pt; }
  .hdr th { text-align: left; font-weight: bold; padding: 0 8pt 1pt 0; vertical-align: top; white-space: nowrap; }
  .hdr td { padding: 0 0 1pt; overflow-wrap: anywhere; }
  .body { max-width: 100%; overflow-wrap: anywhere; }
  .body.text { white-space: pre-wrap; font: inherit; }
  /* Black and white: the sender's colours and backgrounds go, its layout stays. */
  .body.html, .body.html * { color: #000 !important; background-color: transparent !important; background-image: none !important; border-color: #000 !important; box-shadow: none !important; text-shadow: none !important; }
  /* One typeface, as the document rules ask: the sender's fonts (and the quote
     blocks' sans fallback, round 3) give way to Times. Code stays monospace. */
  .body.html, .body.html * { font-family: 'Times New Roman', Times, 'Liberation Serif', serif !important; }
  .body.html pre, .body.html pre *, .body.html code, .body.html code *, .body.html kbd, .body.html samp, .body.html tt { font-family: Menlo, Consolas, 'Liberation Mono', monospace !important; }
  .body.html blockquote { margin: 4pt 0 4pt 4pt !important; padding-left: 8pt !important; border-left: 0.75pt solid #000 !important; }
  .body.html a { text-decoration: underline; }
  .body img { max-width: 100% !important; height: auto !important; filter: grayscale(1); }
  .body table { max-width: 100% !important; }
  .atts { margin: 10pt 0 0; font-size: 10.5pt; }
  .atts-h { font-weight: bold; }
  .atts ul { margin: 2pt 0 0; padding-left: 16pt; }
</style></head>
<body><h1>${subject}</h1><p class="count">${count}</p>${note}${messages.map(messageHtml).join('')}</body></html>`;
}

let sessionReady = false;
function printSession(session) {
  const ses = session.fromPartition(PRINT_PARTITION, { cache: false });
  if (!sessionReady) {
    sessionReady = true;
    ses.webRequest.onBeforeRequest((d, cb) => {
      const ok = (d.resourceType === 'mainFrame' && d.url.startsWith('file:')) || d.url.startsWith('data:');
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

module.exports = { buildPrintHtml, messageHtml, printConversation, escapeHtml, fmtSize, PRINT_PARTITION };
