// Gmail Follow-ups as a hosted Claude connector (claude.ai, phone, desktop).
//
// Claude signs each person in through this Worker's OAuth endpoints, which
// hand off to Google. The Google refresh token is kept, encrypted, in the
// grant's props by @cloudflare/workers-oauth-provider. Every tool call runs
// the Apps Script API (Api.gs) as that person, exactly like the local server,
// and uses the same tools (../../tools.js). Attachments come from Google Drive.
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { buildServer } from '../../tools.js';
import manifest from '../../../appsscript.json';
import config from '../../config.json';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPES = [...manifest.oauthScopes, DRIVE_SCOPE, 'openid', 'email'];
// Only Claude's own redirect hosts may receive authorization codes.
const ALLOWED_REDIRECT_HOSTS = ['claude.ai', 'claude.com'];

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ───────── Google tokens ─────────────────────────────────────────

async function googleToken(env, body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google sign-in failed (' + (json.error_description || json.error || res.status) + '). Reconnect Gmail Follow-ups in Claude\'s connector settings.');
  return json;
}

// Access token for this person, refreshed from their refresh token and
// cached for its lifetime.
function tokenSource(env, props) {
  let cached = null;
  return async () => {
    if (cached && cached.exp > Date.now() + 60000) return cached.token;
    const t = await googleToken(env, { grant_type: 'refresh_token', refresh_token: props.refreshToken });
    cached = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
    return cached.token;
  };
}

// ───────── Apps Script and Drive ─────────────────────────────────

async function runScript(env, token, fn, params = []) {
  const res = await fetch('https://script.googleapis.com/v1/scripts/' + encodeURIComponent(env.DEPLOYMENT_ID || config.deploymentId) + ':run', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ function: fn, parameters: params })
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403 && /has not been used|disabled/i.test(JSON.stringify(body))) {
    throw new Error('Turn on "Google Apps Script API" at https://script.google.com/home/usersettings, wait a minute, then try again.');
  }
  if (!res.ok) throw new Error('Google returned ' + res.status + ': ' + ((body.error && body.error.message) || 'unknown error'));
  if (body.error) {
    const d = (body.error.details || [])[0] || {};
    const msg = d.errorMessage || body.error.message || 'The script failed.';
    if (/authoriz/i.test(msg)) throw new Error(msg + ' — open the Follow-up Scheduler sidebar in Gmail once and approve it, then try again.');
    throw new Error(msg);
  }
  return body.response ? body.response.result : undefined;
}

// Accepts a Drive link (…/d/ID/…, ?id=ID) or a bare file ID.
function driveId(ref) {
  const s = String(ref).trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  throw new Error('Attachment "' + s + '" is not a Google Drive link or file ID. On this connector, attach files by sharing their Google Drive link.');
}

const EXPORT_AS_PDF = /^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)$/;

async function readDriveFiles(token, refs) {
  const out = [];
  for (const ref of refs || []) {
    const id = driveId(ref);
    const auth = { Authorization: 'Bearer ' + await token() };
    const meta = await fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=name,mimeType,size&supportsAllDrives=true', { headers: auth });
    if (!meta.ok) throw new Error('Could not open Drive file ' + ref + ' (' + meta.status + '). Check the link and that your account can open it.');
    const m = await meta.json();
    let url, name = m.name, mimeType = m.mimeType;
    if (EXPORT_AS_PDF.test(m.mimeType)) {
      url = 'https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=application/pdf';
      mimeType = 'application/pdf';
      if (!/\.pdf$/i.test(name)) name += '.pdf';
    } else if (/^application\/vnd\.google-apps\./.test(m.mimeType)) {
      throw new Error('"' + m.name + '" is a Google ' + m.mimeType.split('.').pop() + ' and can\'t be attached. Attach a file, Doc, Sheet or Slides deck instead.');
    } else {
      url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&supportsAllDrives=true';
    }
    const res = await fetch(url, { headers: auth });
    if (!res.ok) throw new Error('Could not download "' + name + '" from Drive (' + res.status + ').');
    const buf = await res.arrayBuffer();
    out.push({ name, size: buf.byteLength, mimeType: mimeType || 'application/octet-stream', data: b64(buf) });
  }
  return out;
}

// ───────── MCP server (one per Claude session) ───────────────────

export class FollowUpsMCP extends McpAgent {
  async init() {
    const props = this.props || {};
    const token = tokenSource(this.env, props);
    const kv = this.env.OAUTH_KV;
    const prefix = 'gate:' + encodeURIComponent(props.email || 'unknown') + ':';
    this.server = buildServer({
      run: (fn, params) => runScript(this.env, token, fn, params),
      readFiles: (refs) => readDriveFiles(token, refs),
      fileHelp: 'Google Drive links (or file IDs) of files the user can open. Google Docs, Sheets and Slides are attached as PDF',
      gateStore: {
        get: async (k) => kv.get(prefix + k, 'json'),
        put: async (k, v) => kv.put(prefix + k, JSON.stringify(v), { expirationTtl: 3600 }),
        delete: async (k) => kv.delete(prefix + k)
      }
    });
  }
}

// ───────── Sign-in (Claude → this Worker → Google) ───────────────

async function authorize(request, env) {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const host = new URL(authReq.redirectUri).hostname;
  if (!ALLOWED_REDIRECT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return new Response('This connector only works with Claude.', { status: 400 });
  }
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put('signin:' + state, JSON.stringify(authReq), { expirationTtl: 600 });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL('/callback', request.url).href,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    hd: env.ALLOWED_DOMAIN,
    state
  }).toString();
  return Response.redirect(url.href, 302);
}

async function callback(request, env) {
  const q = new URL(request.url).searchParams;
  const state = q.get('state') || '';
  const saved = state && await env.OAUTH_KV.get('signin:' + state, 'json');
  if (!saved) return new Response('Sign-in expired. Go back to Claude and connect again.', { status: 400 });
  await env.OAUTH_KV.delete('signin:' + state);
  if (q.get('error')) return new Response('Sign-in was cancelled (' + q.get('error') + ').', { status: 400 });

  const tok = await googleToken(env, {
    grant_type: 'authorization_code', code: q.get('code') || '',
    redirect_uri: new URL('/callback', request.url).href
  });
  const claims = JSON.parse(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const email = String(claims.email || '').toLowerCase();
  if (!claims.email_verified || !email.endsWith('@' + env.ALLOWED_DOMAIN)) {
    return new Response('Only ' + env.ALLOWED_DOMAIN + ' accounts can use this connector.', { status: 403 });
  }
  const granted = String(tok.scope || '').split(' ');
  const missing = SCOPES.filter((s) => s.startsWith('https://') && !granted.includes(s));
  if (missing.length) return new Response('Some permissions were not granted: ' + missing.join(', ') + '. Connect again and allow all of them.', { status: 400 });
  if (!tok.refresh_token) return new Response('Google did not return a long-lived sign-in. Connect again.', { status: 400 });

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: saved,
    userId: encodeURIComponent(email),
    metadata: { email },
    scope: saved.scope,
    props: { email, refreshToken: tok.refresh_token }
  });
  return Response.redirect(redirectTo, 302);
}

const site = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/authorize') return await authorize(request, env);
      if (path === '/callback') return await callback(request, env);
    } catch (e) {
      return new Response('Sign-in error: ' + (e.message || e), { status: 500 });
    }
    if (path === '/') {
      return new Response('Gmail Follow-ups connector for Claude. Add ' + new URL('/mcp', request.url).href +
        ' as a custom connector in Claude (Settings → Connectors).', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  }
};

// The provider needs this Worker's own public URL, which is only known once a
// request arrives, so it is built on the first request.
let provider = null;
export default {
  fetch(request, env, ctx) {
    provider = provider || new OAuthProvider({
      apiHandlers: { '/mcp': FollowUpsMCP.serve('/mcp') },
      defaultHandler: site,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      accessTokenTTL: 3600,
      resourceMetadata: { resource: new URL('/mcp', request.url).href }
    });
    return provider.fetch(request, env, ctx);
  }
};
