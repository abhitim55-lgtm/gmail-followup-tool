#!/bin/sh
# Build dist/gmail-followup.mcpb: a Claude Desktop Extension of this MCP server.
# Double-click the .mcpb (or open it with Claude) and click Install. Claude then
# runs the server itself, in chats and in Cowork, and keeps it across restarts.
# Sign-in still lives in ~/.gmail-followup-mcp (run `npm run login` once).
set -e
cd "$(dirname "$0")"
OUT=dist
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp server.js appsScript.js auth.js config.json package.json package-lock.json "$STAGE/"
cp mcpb-manifest.json "$STAGE/manifest.json"
(cd "$STAGE" && npm ci --omit=dev --silent)
npx -y @anthropic-ai/mcpb@latest pack "$STAGE" "$OUT/gmail-followup.mcpb"
rm -rf "$STAGE"
echo "Built $OUT/gmail-followup.mcpb"
