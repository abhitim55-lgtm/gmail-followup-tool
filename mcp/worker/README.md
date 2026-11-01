# Gmail Follow-ups: hosted Claude connector (phone, web, desktop)

The same tools as the local MCP server (`../tools.js`), hosted on Cloudflare
Workers (free plan), so Claude can use them from the phone app and claude.ai.

**Connector URL:** `https://gmail-followups.gmail-followup-connector.workers.dev/mcp`

## Add it (each person, once)

1. claude.ai → **Customize → Connectors → + Add → Add custom connector**.
2. Name `Gmail Follow-ups`, URL above → **Continue** → **Add** → **Connect**.
3. Pick your **procmart.com** Google account → **Continue** → **Allow**.
4. It now works in Claude on the web, the phone app and Claude Desktop.

Only procmart.com accounts can connect. Each person signs in as themselves,
so mail goes from their own Gmail. Every send, stop, edit or delete previews
first and waits for a yes.

Attachments: on this connector, give Google Drive links (Docs, Sheets and
Slides are attached as PDF). The local server takes file paths instead.

## How it works

- `@cloudflare/workers-oauth-provider` is the OAuth server Claude talks to.
  `/authorize` hands off to Google; `/callback` keeps the user's Google refresh
  token in the grant's encrypted props. Only claude.ai / claude.com redirect
  URIs are accepted.
- `FollowUpsMCP` (an `agents` McpAgent, SQLite Durable Object) builds the tools
  per session and calls the Apps Script API deployment in `../config.json`
  (`Api.gs`) with that user's Google token.
- Preview → confirm codes are kept in KV (1 hour), one-time, per user.

## Deploy

```bash
cd mcp/worker && npm install && npx wrangler deploy
```

Secrets (set once): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from the
"Gmail Follow-ups Claude connector" Web OAuth client in Google Cloud project
`eminent-card-501607-m6` (redirect URI `<worker>/callback`):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

After changing `Api.gs`, update the "Claude MCP API" deployment
(`clasp deploy -i <id>`); the connector picks it up without a redeploy.
