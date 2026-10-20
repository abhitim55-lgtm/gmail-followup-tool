# Gmail Follow-Up Tool

Auto-follow up on Gmail threads when prospects go quiet. Replies on the **same thread** (unlike Mailmeteor, which can only start a new campaign). Stops automatically the moment the prospect replies.

Pairs cleanly with Mailmeteor:
- **Mailmeteor** sends the cold campaign.
- **This tool** handles the conversational follow-ups after they reply once and then ghost.

## How it works

Two ways in, same scheduler underneath:

Everything lives in the **Gmail sidebar** (Follow-up Scheduler, right-hand panel). With no email open you get the home screen:

- **New campaign** — To (up to 10 people, `Name <email>` fills `{firstName}`), subject, email, then pick a sequence under *If they don't reply, send*. **Send me a test** mails it to yourself first; **Send** gives everyone their own thread and queues the follow-ups as replies on it.
- **Follow up on a sent email** — your recent sent mail (searchable); tap one to start a sequence on it.
- **Sequences** — write follow-ups once (wait, message, condition, time of day, Cc/Bcc), reuse them anywhere.
- **Settings** — your name, signature, timezone, sending status (**Fix scheduler** / **Send due now**), and for the owner, whether each teammate's copy is sending.
- **Scheduled** — every thread with follow-ups queued, with Open email / Stop follow-ups.

With an email open: **Start** any sequence in one click, or **Custom follow-up** for one-off timing, exact dates and one-off emails.

Gmail add-ons can only live in this side panel; the left-menu item comes from the Chrome extension below. The `FU/Custom` label in the left menu lists every thread with follow-ups.

**Follow-up Studio** (Studio.gs/StudioPage.html) is the full-page version with the same features, linked from the sidebar's home screen. The `chrome-extension/` folder adds it to Gmail's left menu under Drafts and opens it inside Gmail. See [chrome-extension/README.md](chrome-extension/README.md).

**From Claude:** the `mcp/` folder is a small local MCP server. Claude Desktop or Claude Code can use it to list sequences and campaigns, start a sequence on a sent email, send a campaign, or stop follow-ups. It runs as your own Gmail account, and it always shows a preview first. Nothing sends until you confirm. `Api.gs` holds the functions it calls. For setup, see [mcp/README.md](mcp/README.md).

Safety checks: every New campaign goes through a **Check before sending** screen (who gets it, the first email as they'll see it, follow-up dates, and warnings: no follow-ups, missing names for {firstName}, unknown placeholders, invalid addresses, people you emailed in the last 14 days, sending switched off). Stopping follow-ups and deleting a sequence both ask first.

Both tag the thread `FU/Custom`. A time-based trigger sends each due step as a proper reply on the same thread — correct `In-Reply-To`/`References` headers, your Gmail display name, your signature appended. The trigger installs itself the first time you open the sidebar or Studio and repairs itself if it disappears.

Per-step conditions:
- **If no reply** (default) — sends unless the prospect replied; a reply cancels the whole campaign.
- **If replied** — holds the step until a reply arrives (gives up after 14 days).
- **No matter what** — always sends.

No backend. No Chrome extension. No third party reading your email. Runs on Google's servers under your own account.

## Install (5 minutes)

1. Go to **[script.google.com](https://script.google.com)** and click **New project**.
2. Name it something like *Gmail Follow-Up Tool*.
3. Delete the placeholder `function myFunction()` in `Code.gs`.
4. Open **`Code.gs`** from this repo, copy the entire file, paste into the script editor.
5. Open the project's **Project Settings** (gear icon), tick **"Show 'appsscript.json' manifest file in editor"**. Replace the manifest contents with the `appsscript.json` from this repo. (Edit `timeZone` to yours, e.g. `Asia/Kolkata`, `America/New_York`.)
6. In `Code.gs`, edit the `CONFIG` block at the top:
   - `senderFirstName` / `senderName` / `senderEmails` — the **owner account** defaults. These apply only to the account whose address is in `senderEmails`; everyone else gets their own identity auto-detected (see [Sharing](#sharing-it-with-other-people)).
   - Default template and safety toggles if you want.
7. Save (⌘S / Ctrl+S).
8. From the dropdown at the top, select function **`setup`** and click **Run**. Approve the OAuth permissions (Gmail access — it's running under your own account).
9. Refresh Gmail and look for **Follow-up Scheduler** in the right sidebar. The **Status** panel there confirms the scheduler is running and which address it will send from.

If you deploy with [clasp](https://github.com/google/clasp) instead: `clasp push`. Running `setup` is optional — opening the sidebar installs the trigger.

### Turn on the Studio (one time)

The Studio is a web app served from the same script, so it needs a web-app deployment:

1. `clasp push`, then in the Apps Script editor: **Deploy → New deployment → ⚙ Web app**. Execute as **User accessing the web app**, access **Anyone with Google account** (each person only ever sees and sends from their own Gmail). Deploy and authorize.
2. Copy the deployment ID into `studioDeploymentId` in CONFIG (Code.gs) and `clasp push` — the sidebar's **Open Studio** button links there. Bookmark the `/exec` URL too.
3. After later code changes, `clasp push` and then **Deploy → Manage deployments → Edit → New version** (or `clasp deploy -i <deploymentId>`) so the web app picks them up. The sidebar uses the latest pushed code automatically.

## Use it

- **Studio** → *New campaign* for fresh outreach; *Sequences* to write follow-ups once and reuse them.
- **Sidebar, thread open** → **Start** a sequence in one click, or **Custom follow-up** for one-off timing.
- **Sidebar, no thread open** → the Campaigns dashboard: every armed thread, next fire time, cancel, plus **Status** (scheduler running? sending as? last check? failed sends?) with **Fix scheduler** / **Send due now**, and **Your name** / **Signature**.

Saved "templates" from older versions were merged into **Sequences** automatically the first time you open the new version — nothing to do.

### Manual test (recommended first time)

In the script editor:
- Set `dryRun: true` in CONFIG.
- Run `previewNow` — it logs what *would* be sent without sending anything.
- When happy, set `dryRun: false`.

### Debugging

- Run **`diagnose`** from the editor — it checks your account vs. detected sender addresses, the trigger, the `FU/Custom` label, and prints every stored schedule with fire times.
- Run **`lastRunReport`** — prints the logs of the last few trigger runs.
- Or check **View → Executions** in the script editor.

## Customise

Edit `CONFIG` at the top of `Code.gs`:

- `defaultTemplate` — used when a step's message is blank. Placeholders: `{firstName}`, `{senderFirstName}`.
- `businessHoursOnly`, `skipWeekends`, `lookbackDays`, `maxPerRun`, `dryRun`.
- `triggerIntervalMinutes` — how often the scheduler wakes up. Apps Script allows `1`, `5`, `10`, `15`, `30`; default `5`. **Don't set this to 1**: ~1,440 runs a day exhausts the daily script-runtime quota on a consumer Gmail account, and Google then stops running the trigger with no visible error.

## Sharing it with other people

The script is multi-user safe: identity, schedules, templates, signature, timezone and the trigger are all stored **per Google account**. Nothing in `CONFIG` leaks into a second user's outgoing mail — the `sender*` values apply only to the account listed in `senderEmails`, and everyone else is auto-detected from their own Gmail "Send mail as" settings.

Two ways to share:

**1. Send them this repo (easy).**
Each person creates their own Apps Script project at script.google.com and pastes the code. Five minutes, no marketplace listing needed. They control their own auth, quotas, and templates.

**2. Share one script project via an add-on deployment.**
Deploy → **Test deployments** → *Install*, and share the project with their Google account (Editor access is enough to install). Then, **in their Gmail**:
1. Refresh Gmail, open the **Follow-up Scheduler** sidebar, and accept the OAuth prompt.
2. Check the **Status** panel: it must say *Scheduler: Running* and show **their** address under *Sending as*. If it doesn't, tap **Fix scheduler**.
3. Set their **Your name** and **Signature** on the dashboard.
4. Schedule a test follow-up a few minutes out and confirm it lands.

Each user's trigger, schedules and identity are independent — cancelling or reinstalling on one account never touches the other.

## Limits

- Personal Gmail: 100 emails/day quota for Apps Script. Workspace accounts: 1,500/day. The Studio sends to at most 50 recipients per click; first emails and follow-ups both count toward the daily quota.
- Personal Gmail also caps total trigger runtime at ~90 min/day — the reason `triggerIntervalMinutes` defaults to 5.
- Scheduling resolution = trigger frequency (5 minutes by default).

## Troubleshooting

- **Nothing sends** → open the sidebar dashboard and read the **Status** panel first: it reports a missing scheduler, an unresolved sending address, and the last failed send. **Fix scheduler** repairs the trigger; **Send due now** runs the queue immediately and shows the real error. Only if that's inconclusive, run `diagnose()` in the editor.
- **Nothing sends for a second user** → triggers are per-account. Have them open the sidebar in *their* Gmail once and accept the permission prompt; that installs their scheduler.
- **Follow-ups went out under the wrong name** → set **Your name** on their dashboard; blank means "use my Gmail display name".
- **Permissions screen scary?** → It's the standard Google "this app isn't verified" screen for unpublished scripts. Click *Advanced → Go to project (unsafe)*. It's your own code under your own account.
- **Wrong times** → set the timezone in the sidebar's Timezone dropdown (it's remembered), and fix `timeZone` in `appsscript.json`.

## License

MIT. Do whatever.
