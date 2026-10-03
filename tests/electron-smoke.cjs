'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { fixture } = require('./oidc-fixture.cjs');
const { WorkforceFlow } = require('../src/workforce-flow');
const { MailBridge } = require('../src/workforce-mail');
const { trustedSender } = require('../src/workforce-policy');
const { pathToFileURL } = require('node:url');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-electron-profile-')));
const ORG = 'abce1234-1234-4123-8123-123412341234';
const ID = 'abce1234-1234-4123-8123-123412341235';
let server, provider, dir;
app.whenReady().then(async () => {
  provider = await fixture();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mail-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const calls = [];
  let origin;
  let failCleanup = false, failSelection = false;
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push(req.url);
    if (req.method === 'POST') {
      assert.equal(req.headers.origin, origin);
      assert.equal(req.headers['x-csrf-token'], 'real-csrf');
      assert.match(req.headers.cookie, /tfm_csrf=real-csrf/);
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/cookie-probe') { res.statusCode = /tfm_mb_access=/.test(req.headers.cookie || '') ? 200 : 401; return res.end('{}'); }
    if (['/auth/mailbox/logout', '/auth/logout'].includes(req.url)) { res.statusCode = failCleanup ? 503 : 200; return res.end('{}'); }
    if (req.url === '/auth/csrf') {
      res.setHeader('Set-Cookie', 'tfm_csrf=real-csrf; Path=/; Secure; SameSite=Lax');
      return res.end('{}');
    }
    if (req.url === '/api/workforce/native/exchange') {
      assert.deepEqual(JSON.parse(body), { access_token: 'mail-api-access', mail_org_id: ORG });
      res.setHeader('Set-Cookie', ['tfm_access_token=opaque-officer; Path=/; Secure; HttpOnly; SameSite=Lax', 'tfm_refresh_token=opaque-refresh; Path=/; Secure; HttpOnly; SameSite=Lax']);
      return res.end(JSON.stringify({ org_id: ORG }));
    }
    if (req.url === '/api/workforce/native/mailboxes') {
      assert.match(req.headers.cookie, /tfm_access_token=opaque-officer/);
      return res.end(JSON.stringify([{ id: ID, org_id: ORG, address: 'assigned@institution.gov' }]));
    }
    if (req.url === '/api/workforce/native/mailbox') {
      assert.deepEqual(JSON.parse(body), { mailbox_id: ID });
      res.setHeader('Set-Cookie', ['tfm_mb_access=opaque-mailbox; Path=/; Secure; HttpOnly; SameSite=Lax', 'tfm_mb_refresh=opaque-mailbox-refresh; Path=/; Secure; HttpOnly; SameSite=Lax', 'tfm_access_token=; Path=/; Secure; HttpOnly; Max-Age=0', 'tfm_refresh_token=; Path=/; Secure; HttpOnly; Max-Age=0']);
      res.statusCode = failSelection ? 503 : 200;
      return res.end(JSON.stringify({ id: ID, org_id: ORG }));
    }
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Remote Mail fixture</title><p>Mail</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'https://127.0.0.1:' + server.address().port;
  const ses = session.fromPartition('desktop-smoke');
  // Test-only trust for this generated certificate, never a production switch.
  ses.setCertificateVerifyProc((request, cb) => cb(request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  const urls = [], updates = [];
  let complete = 0;
  const flow = new WorkforceFlow({ issuer: provider.issuer, mail: new MailBridge(ses, origin), clientLoader: async () => provider.client, openExternal: async url => urls.push(url), notify: state => updates.push(state), complete: () => complete++ });
  await flow.start(ORG);
  await flow.receive(provider.response(urls[0]));
  assert.equal(flow.pending.phase, 'selection');
  assert.equal(complete, 0);
  await flow.select(ID);
  assert.equal(complete, 1);
  assert.equal(flow.pending, null);
  const cookies = await ses.cookies.get({ url: origin });
  assert.equal(cookies.find(c => c.name === 'tfm_mb_access').httpOnly, true);
  assert.equal(cookies.some(c => c.name === 'tfm_access_token'), false);
  assert.equal(cookies.some(c => c.name === 'tfm_refresh_token'), false);
  assert.deepEqual(calls, ['/auth/csrf', '/api/workforce/native/exchange', '/api/workforce/native/mailboxes', '/api/workforce/native/mailbox']);
  assert.equal(JSON.stringify(updates).includes('opaque'), false);
  // The server transfers cookies and then refuses cleanup. Cancellation must
  // still remove the local credentials, without claiming server revocation.
  failSelection = failCleanup = true;
  await flow.start(ORG); await flow.receive(provider.response(urls.at(-1)));
  await flow.select(ID);
  assert.match(updates.at(-1).message, /cleanup could not be confirmed/);
  assert.equal((await ses.cookies.get({ url: origin })).some(c => ['tfm_mb_access', 'tfm_mb_refresh', 'tfm_access_token', 'tfm_refresh_token'].includes(c.name)), false);
  assert.equal((await ses.fetch(origin + '/cookie-probe', { credentials: 'include' })).status, 401);
  const PAGE = path.join(__dirname, '..', 'src', 'shell', 'workforce.html');
  const PAGE_URL = pathToFileURL(PAGE).href;
  const preferences = { partition: 'desktop-smoke', sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'src', 'workforce-preload.js'), additionalArguments: ['--taifa-auth-page=' + PAGE_URL] };
  const pane = new BrowserWindow({ show: false, webPreferences: preferences });
  const { ipcMain } = require('electron');
  ipcMain.handle('workforce:state', event => {
    assert.equal(trustedSender(event, pane.webContents, PAGE_URL), true);
    return { phase: 'selection', message: 'Select', mailboxes: [{ id: ID, address: '<script>not executable</script>@institution.gov' }] };
  });
  await pane.loadFile(PAGE);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await pane.webContents.executeJavaScript('typeof window.workforce.start'), 'function');
  assert.equal(await pane.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await pane.webContents.executeJavaScript('document.querySelector("#mailboxes button").textContent'), '<script>not executable</script>@institution.gov');
  assert.equal(await pane.webContents.executeJavaScript('document.querySelector("#mailboxes script")'), null);
  await pane.loadURL(origin);
  assert.equal(await pane.webContents.executeJavaScript('typeof window.workforce'), 'undefined');
  pane.destroy();
  ipcMain.removeHandler('workforce:state');
  console.log('PASS Electron runtime: RSA OIDC, native HTTPS exchange, real session cookie jar, CSRF, explicit selection, sandboxed selector, no remote bridge, cleanup503 removes transferred credentials and next request401. Electron ' + process.versions.electron);
  await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
}).catch(async err => {
  console.error(err.stack);
  server?.closeAllConnections(); server?.close();
  await provider?.close();
  app.exit(1);
});
setTimeout(() => { console.error('Electron smoke timeout'); app.exit(1); }, 30000).unref();
