# Gmail Follow-Up Tool for Claude (MCP)

This lets Claude (Claude Desktop or Claude Code) use the Follow-Up Tool directly: list your sequences and running campaigns, start a sequence on an email you already sent, send a new campaign, and stop follow-ups.

It runs on your computer and calls the same Apps Script project as the Gmail sidebar, **signed in as you**. Mail goes out from your own Gmail account, and it uses your own sequences, signature and timezone, exactly like the sidebar.

## What Claude can do

| Tool | What it does | Sends anything? |
|---|---|---|
| `status` | Which account is sending, whether the scheduler runs, last run, test mode | No |
| `list_sequences` | Your saved sequences and their steps | No |
| `list_campaigns` | Threads with follow-ups still scheduled | No |
| `list_sent_threads` | Your recent sent emails, to pick one to follow up on | No |
| `start_sequence_on_thread` | Schedule a sequence's follow-ups on a sent email | Only after you confirm |
| `send_campaign` | Send a first email to each person, then follow up on it | Only after you confirm |
| `stop_campaign` | Cancel the follow-ups on one thread | Only after you confirm |
| `sign_in` / `sign_out` | Connect or disconnect your Google account | No |

### Checks before anything sends

`send_campaign`, `start_sequence_on_thread` and `stop_campaign` always work in two steps:

1. **Preview.** Claude first gets back exactly what would happen: the recipients, the first email as the first person will see it (placeholders and signature filled in), the date of each follow-up, and the same warnings as the sidebar's "Check before sending" screen. These include skipped invalid addresses, `{placeholders}` that won't be filled in, people you already emailed in the last 14 days, a scheduler that is switched off, and test mode. Nothing is sent at this point.
2. **Confirm.** Only after you say yes does Claude call again with `confirm: true` and the one-time code from the preview. The server refuses if there was no preview, if anything changed since the preview (a different subject or recipient, for example), or if the preview is over 30 minutes old.

The Apps Script side also never sends unless `confirm` is true. To try things out without sending real mail, set `dryRun: true` in `CONFIG` (Code.gs). Confirmed sends are then only logged.

## Setup

Some steps are done once for the whole team by the person who owns the Apps Script project (**owner**). Some are done once by each person who wants to use it from Claude (**everyone**).

### 1. Owner: deploy the script as an API executable

`appsscript.json` already has `"executionApi": { "access": "ANYONE" }`, and `Api.gs` holds the functions Claude calls.

```bash
clasp push
```

```bash
clasp deploy -d "Claude MCP API"
```

Copy the deployment ID it prints (it starts with `AKfy`) into `mcp/config.json`:

```json
{ "deploymentId": "AKfy...your id..." }
```

Commit that file so teammates get it. The ID is not a secret.

**After every later code change**, update the same deployment instead of creating a new one:

```bash
clasp deploy -i AKfy...your id... -d "Claude MCP API"
```

A plain `clasp push` doesn't change what Claude runs. As with the Studio web app, the deployment keeps running the version it was given. While developing, the owner can set `GFU_DEV_MODE=1` to run the latest pushed code instead.

### 2. Owner: link the script to a standard Google Cloud project

The Apps Script API only runs a script for an OAuth client that belongs to the **same** Cloud project as the script. By default, Apps Script uses a hidden project you can't add a client to, so the script has to move to a normal one.

1. In [Google Cloud console](https://console.cloud.google.com/), pick or create a project (for example, the existing `eminent-card-501607-m6`). Note its **project number** from the project dashboard.
2. Go to **APIs & Services → Library**, then enable the **Apps Script API** and the **Gmail API**.
3. Go to **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - **Internal**: choose this if everyone who will use it is on `procmart.com`. There's no Google review, and sign-ins don't expire.
   - **External**: choose this if anyone uses a `@gmail.com` or other domain. Leave it in **Testing** and add each person under **Test users**. In Testing, Google makes people sign in again every 7 days. Publishing it would need Google's verification for Gmail access.
4. In the Apps Script editor, open **Project Settings → Google Cloud Platform (GCP) Project → Change project**, then enter the project number.

> **Heads-up:** after the project changes, everyone using the sidebar (owner and teammates) may be asked to approve the add-on again the next time they open it. Until they do, their automatic follow-ups can stop. Do this at a quiet time, then open the sidebar once on each account. Use the sidebar's **Status** panel to check the scheduler is running.

### 3. Owner: create the OAuth client

1. In the same Cloud project, go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. For **Application type**, choose **Desktop app**. Name it "Follow-Up Tool for Claude".
3. Click **Download JSON**.
4. Share that file with teammates. For a desktop app, Google treats this file as public, not as a password. Even so, keep it inside the team.

### 4. Everyone: install and sign in

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Get this repository onto your computer, then install the server:

   ```bash
   cd "/path/to/Gmail - FollowUp Tool/mcp" && npm install
   ```

3. Save the JSON from step 3 as `~/.gmail-followup-mcp/client_secret.json`. That's a folder called `.gmail-followup-mcp` in your home folder.
4. Turn on **Google Apps Script API** for your own account at <https://script.google.com/home/usersettings>. It's a one-time switch per Google account.
5. Open the Gmail sidebar once and approve the add-on, if you haven't already.
6. Sign in. Either ask Claude to "sign in to the follow-up tool" (it uses the `sign_in` tool), or run:

   ```bash
   cd "/path/to/Gmail - FollowUp Tool/mcp" && npm run login
   ```

   A browser opens. Pick the Gmail account you send from and approve. Your sign-in is saved only on this computer, in `~/.gmail-followup-mcp/token.json`. To remove it, use the `sign_out` tool.

### 5. Everyone: add it to Claude

**Claude Desktop:** go to Settings → Developer → Edit Config, and add this to `claude_desktop_config.json`. Use the real path to `server.js` on your computer, then restart Claude Desktop.

```json
{
  "mcpServers": {
    "gmail-followup": {
      "command": "node",
      "args": ["/Users/you/Documents/Gmail - FollowUp Tool/mcp/server.js"]
    }
  }
}
```

If Claude Desktop can't find `node`, put the full path from `which node` in `command`, for example `/opt/homebrew/bin/node`.

**Claude Code:**

```bash
claude mcp add gmail-followup -s user -- node "/Users/you/Documents/Gmail - FollowUp Tool/mcp/server.js"
```

Then try: *"What follow-up sequences do I have?"* or *"Preview sending my Default sequence to jane@acme.com. Don't send yet."*

## Settings

| Variable | What it does |
|---|---|
| `GFU_DEPLOYMENT_ID` | Overrides `deploymentId` in `config.json` |
| `GFU_OAUTH_CLIENT` | Path to the OAuth client JSON (default `~/.gmail-followup-mcp/client_secret.json`) |
| `GFU_HOME` | Where the sign-in is saved (default `~/.gmail-followup-mcp`) |
| `GFU_DEV_MODE=1` | Owner only: run the latest pushed code, using the script ID from `.clasp.json` |

Set these under `"env"` in the Claude Desktop config if needed.

## When something goes wrong

The server turns Google's errors into a sentence that says what to fix. The common ones are:

| Message mentions | Fix |
|---|---|
| "Not signed in" / "sign-in expired" | Use `sign_in` again. In Testing mode this happens every 7 days. |
| `script.google.com/home/usersettings` | Turn on the Apps Script API for your account (step 4.4). |
| "not linked to the same Google Cloud project" | Step 2.4 isn't done, or the OAuth client is from a different project. |
| "could not find an API-executable deployment" | Step 1: deployment missing, or wrong ID in `config.json`. |
| "has no mcpStatus()" (or another function) | The deployment has old code. Run `clasp push`, then `clasp deploy -i <id>`. |
| "Authorization is required" | Open the Gmail sidebar once and approve, then use `sign_in` again. |

To check a single call from a terminal: `node server.js call mcpStatus`. Read-only calls are safe. Don't use this to send: it skips the preview step.

## Development

```bash
cd mcp && npm test
```

This drives the server through a real MCP client with a fake script, so no Google account is used.

```bash
node test/harness.js
```

Run this from the repo root. It checks the Apps Script side, including `Api.gs`.
