# Gmail Follow-Up Tool

Auto-follow up on Gmail threads when prospects go quiet. Replies on the **same thread** (unlike Mailmeteor, which can only start a new campaign). Stops automatically the moment the prospect replies.

Pairs cleanly with Mailmeteor:
- **Mailmeteor** sends the cold campaign.
- **This tool** handles the conversational follow-ups after they reply once and then ghost.

## How it works

1. You apply a Gmail label like `FU/3d` to any thread you want to follow up on.
2. An hourly Apps Script checks every `FU/*` thread.
3. If `daysAfter` days have passed since *your* last message **and** the prospect hasn't replied → it sends your templated follow-up as a reply on the same thread.
4. The label rolls forward: `FU/3d` → `FU/7d` → `FU/14d` → done.
5. If the prospect replies at any point, the label is removed and follow-ups stop.

No backend. No Chrome extension. No third party reading your email. Runs on Google's servers under your own account.

## Install (5 minutes)

1. Go to **[script.google.com](https://script.google.com)** and click **New project**.
2. Name it something like *Gmail Follow-Up Tool*.
3. Delete the placeholder `function myFunction()` in `Code.gs`.
4. Open **`Code.gs`** from this repo, copy the entire file, paste into the script editor.
5. Open the project's **Project Settings** (gear icon on the left), tick **"Show 'appsscript.json' manifest file in editor"**. Then go back to the editor, open `appsscript.json`, replace its contents with the `appsscript.json` from this repo. (Edit `timeZone` to yours, e.g. `America/New_York`, `Asia/Kolkata`.)
6. In `Code.gs`, edit the `CONFIG` block at the top:
   - `senderFirstName` — your first name
   - `senderEmails` — every Gmail address you send from
   - templates and cadence if you want
7. Save (⌘S / Ctrl+S).
8. From the dropdown at the top, select function **`setup`** and click **Run**. Approve the OAuth permissions (Gmail access — it's running under your own account).
9. Done. The hourly trigger is now installed.

## Use it

After running `setup`, refresh Gmail. In any open thread, click the puzzle-piece icon in the right sidebar → **Follow-up Scheduler**. You'll see:

- **Preset stages** — one-click `FU/3d`, `FU/7d`, `FU/14d`.
- **Custom schedule** — fields for days, hours, minutes, and an optional one-off message. Set any combination (e.g. `0d 2h 30m`) and click **Schedule**. Resolution is 5 minutes (the trigger frequency).
- **Status / Cancel** — shows whether a thread is currently armed, with a one-click cancel.

Or skip the UI and apply labels directly with the Gmail keyboard shortcut `l` → `FU/3d`. Either path uses the same engine.

If the prospect replies at any point, follow-ups stop automatically.

### Manual test (recommended first time)

In the script editor:
- Set `dryRun: true` in CONFIG.
- Run `previewNow` — it logs what *would* be sent without sending anything.
- When happy, set `dryRun: false`.

### Manual scheduling from the editor

If you'd rather not click in Gmail:
```js
manualSchedule('https://mail.google.com/mail/u/0/#inbox/THREAD_ID', '3d')
```

## Customise

Edit the `stages` object in CONFIG. You can:

- Add more stages (`'21d'`, `'30d'`, etc.).
- Change the cadence — set `daysAfter` to any number of days.
- Rewrite templates. Placeholders: `{firstName}`, `{senderFirstName}`.
- Remove stages — if you only want one bump, set `nextLabel: null` on the first stage.
- Toggle `businessHoursOnly`, `skipWeekends`, `lookbackDays`, `maxPerRun`.

## Sharing it with other people

Two ways:

**1. Just send them this repo (easy).**
Each person creates their own Apps Script project at script.google.com and pastes the code. Five minutes, no marketplace listing needed. They control their own auth, quotas, and templates.

**2. Publish as a Google Workspace Add-on (more work).**
For non-technical users. Requires Google's verification process for sensitive Gmail scopes. Worth it only if you plan to distribute to dozens of strangers.

For now, option 1 is the move.

## Limits

- Personal Gmail: 100 emails/day quota for Apps Script. Workspace accounts: 1,500/day.
- The hourly trigger is the cheapest one Google allows. If you need finer-grained timing, change to `everyMinutes(15)` in `setup()`.
- Cold threads (no inbound message yet) are skipped by design — Mailmeteor handles those better.

## Troubleshooting

- **"Label FU/3d not found"** → run `setup()` once.
- **Permissions screen scary?** → It's the standard Google "this app isn't verified" screen for unpublished scripts. Click *Advanced → Go to project (unsafe)*. It's your own code under your own account.
- **No follow-ups firing** → check `View → Executions` in the script editor. Logs show why each thread was processed/skipped.
- **Wrong timezone in business hours** → fix `timeZone` in `appsscript.json`.

## License

MIT. Do whatever.
