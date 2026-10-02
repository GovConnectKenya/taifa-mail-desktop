'use strict';
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { CALLBACK, CLIENT_ID } = require('../src/workforce-policy');
async function fixture() {
  const oidc = await import('openid-client');
  const jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256', { extractable: true });
  const other = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'reviewed-key', alg: 'RS256', use: 'sig' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-oidc-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  let issuer;
  const codes = new Map();
  const requests = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, async (req, res) => {
    const url = new URL(req.url, issuer);
    requests.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', end_session_endpoint: issuer + '/logout', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }));
    if (url.pathname.endsWith('/jwks')) return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname.endsWith('/token')) {
      let raw = '';
      for await (const part of req) raw += part;
      const params = new URLSearchParams(raw);
      const code = codes.get(params.get('code'));
      codes.delete(params.get('code'));
      if (!code || params.get('client_id') !== CLIENT_ID || params.get('redirect_uri') !== CALLBACK || createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== code.challenge) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = { nonce: code.nonce, auth_time: now, acr: 'taifa-mfa', sid: 'central-session', ...(code.override || {}) };
      const jwt = await new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'reviewed-key' }).setIssuer(code.issuer || issuer).setAudience(code.audience || CLIENT_ID).setSubject('central-subject').setIssuedAt(now).setExpirationTime(now + 300).sign(code.badSignature ? other.privateKey : pair.privateKey);
      return res.end(JSON.stringify({ access_token: 'mail-api-access', token_type: 'Bearer', expires_in: 300, id_token: jwt }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = 'https://127.0.0.1:' + server.address().port + '/realm';
  // Test-only CA transport still verifies the actual HTTPS certificate. No
  // insecure transport option exists in desktop production configuration.
  const trustedFetch = (url, options = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method || 'GET', headers: Object.fromEntries(new Headers(options.headers).entries()), ca: cert, signal: options.signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(options.body instanceof URLSearchParams ? options.body.toString() : options.body);
  });
  const client = {
    ...oidc,
    discovery: (url, id, metadata, auth, options) => oidc.discovery(url, id, metadata, auth, { ...options, [oidc.customFetch]: trustedFetch }),
  };
  return {
    issuer, client, requests,
    response(authorizeUrl, overrides = {}) {
      const url = new URL(authorizeUrl);
      const code = 'code-' + codes.size + '-' + requests.length;
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'), ...overrides });
      return CALLBACK + '?code=' + code + '&state=' + url.searchParams.get('state') + '&iss=' + encodeURIComponent(issuer);
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
module.exports = { fixture };
