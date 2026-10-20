// Google sign-in for the MCP server: a desktop OAuth flow (browser + loopback
// redirect + PKCE), with the token kept on this computer only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.GFU_HOME || path.join(os.homedir(), '.gmail-followup-mcp');
const TOKEN_FILE = path.join(HOME, 'token.json');
const CLIENT_FILE = process.env.GFU_OAUTH_CLIENT || path.join(HOME, 'client_secret.json');

// scripts.run needs a token with every scope the script declares, so read
// them from the manifest next door; this list is the fallback.
const FALLBACK_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.addons.execute',
  'https://www.googleapis.com/auth/gmail.addons.current.message.metadata',
  'https://www.googleapis.com/auth/gmail.addons.current.action.compose',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.storage'
];

export function scopes() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'appsscript.json'), 'utf8'));
    if (Array.isArray(m.oauthScopes) && m.oauthScopes.length) return m.oauthScopes;
  } catch (e) {}
  return FALLBACK_SCOPES;
}

export class NeedsSetup extends Error {}

// The team's client file usually arrives as a download. If it isn't in place
// yet, take the newest client_secret*.json from Downloads and copy it in, so
// setup needs no terminal (teammates on Windows use Claude Desktop only).
export function adoptDownloadedClient() {
  if (process.env.GFU_OAUTH_CLIENT || fs.existsSync(CLIENT_FILE)) return;
  const dir = path.join(os.homedir(), 'Downloads');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^client_secret.*\.json$/i.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch (e) { return; }
  for (const { f } of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const c = raw.installed || raw.web || raw;
      if (!/\.apps\.googleusercontent\.com$/.test(c.client_id || '')) continue;
      fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
      fs.copyFileSync(f, CLIENT_FILE);
      try { fs.chmodSync(CLIENT_FILE, 0o600); } catch (e) {}
      return;
    } catch (e) {}
  }
}

function loadClient() {
  adoptDownloadedClient();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')); }
  catch (e) {
    throw new NeedsSetup('No OAuth client found at ' + CLIENT_FILE + '. Download client_secret.json from the ' +
      'team\'s "Follow-ups Tool – Team Install" Drive folder into your Downloads folder, then try again.');
  }
  const c = raw.installed || raw.web || raw;
  if (!c.client_id) throw new NeedsSetup(CLIENT_FILE + ' is not an OAuth client JSON file.');
  return { id: c.client_id, secret: c.client_secret || '' };
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (e) { return null; }
}

function saveToken(t) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function signedIn() {
  const t = readToken();
  return !!(t && t.refresh_token);
}

export function signOut() {
  try { fs.unlinkSync(TOKEN_FILE); return true; } catch (e) { return false; }
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('Google sign-in failed: ' + (body.error_description || body.error || res.status));
    err.code = body.error;
    throw err;
  }
  return body;
}

// A valid access token, refreshed when it's about to expire.
export async function accessToken() {
  const t = readToken();
  if (!t || !t.refresh_token) throw new NeedsSetup('Not signed in yet. Use the sign_in tool (or run `npm run login` in mcp/).');
  if (t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
  const client = loadClient();
  let fresh;
  try {
    fresh = await tokenRequest({
      client_id: client.id, client_secret: client.secret,
      refresh_token: t.refresh_token, grant_type: 'refresh_token'
    });
  } catch (e) {
    if (e.code === 'invalid_grant') {
      signOut();
      throw new NeedsSetup('Your Google sign-in expired or was revoked. Use the sign_in tool again.');
    }
    throw e;
  }
  t.access_token = fresh.access_token;
  t.expires_at = Date.now() + (fresh.expires_in || 3600) * 1000;
  saveToken(t);
  return t.access_token;
}

function openBrowser(url) {
  // Windows: rundll32 hands the URL straight to the default browser. `cmd /c
  // start` would treat the &s in Google's sign-in URL as command separators.
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch (e) {}
}

// Opens Google's consent page in the browser and waits for the redirect back
// to a one-shot local server. Resolves with the signed-in email.
export async function signIn({ timeoutMs = 180000, log = () => {} } = {}) {
  const client = loadClient();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const server = http.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const redirectUri = 'http://127.0.0.1:' + server.address().port;

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes().concat(['openid', 'email']).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out. Try again.')); }, timeoutMs);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      if (!q.get('code') && !q.get('error')) { res.writeHead(404).end(); return; }
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>' + (ok ? 'Signed in. You can close this tab and go back to Claude.' : 'Sign-in did not finish. Go back to Claude and try again.') + '</h2>');
      clearTimeout(timer);
      server.close();
      if (ok) resolve(q.get('code'));
      else reject(new Error('Sign-in was cancelled' + (q.get('error') ? ' (' + q.get('error') + ')' : '') + '.'));
    });
    log('Opening your browser to sign in with Google. If it does not open, visit:\n' + url);
    openBrowser(url);
  });

  const tok = await tokenRequest({
    client_id: client.id, client_secret: client.secret, code,
    code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code'
  });
  const granted = String(tok.scope || '').split(' ');
  const missing = scopes().filter((s) => !granted.includes(s));
  let email = '';
  try { email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch (e) {}
  saveToken({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    email
  });
  return { email, missing };
}

export function signedInEmail() {
  const t = readToken();
  return (t && t.email) || '';
}
