# Follow-ups for Gmail (Chrome extension)

Adds **Follow-ups** to Gmail's left menu, right under Drafts. Click it and your
campaigns open in Gmail's main pane, like Mailmeteor's "Campaigns": a list with
status, a composer with follow-ups, a preview that checks everything before
sending, and a report showing where each person is in the sequence. Click Inbox
(or any label, or Back) to return to your mail. The Gmail sidebar add-on keeps
working as before.

## Install (2 minutes, once per person)

1. Copy this `chrome-extension` folder to your computer (keep it somewhere it won't be deleted).
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `chrome-extension` folder.
5. Reload Gmail. **Follow-ups** appears under Drafts.

To update later: replace the folder's files, then click the ↻ on the extension
card in `chrome://extensions` and reload Gmail.

For a team without Developer mode, publish it as a **private (unlisted)** item
on the Chrome Web Store and share the link (one-time $5 developer fee).

## Good to know

- It only shows the Studio web app. Your emails never pass through the
  extension, and it has no special permissions.
- ProcMart accounts open the Studio through the procmart.com link, so the
  right Google account is used even when several are signed in.
- If it ever shows a Google sign-in or "unable to open the file" inside
  Gmail, open the Studio link from the Gmail sidebar add-on in its own tab once.
- Gmail changes its page now and then. If the menu item disappears after a
  Gmail update, the selectors in `content.js` (`.TK`, `.aim`, `.nH.bkK`)
  need a refresh. Nothing else breaks: the sidebar add-on is separate.
- The address `#followups` is the extension's page; reloading Gmail on it
  goes back to the inbox (Gmail doesn't know that address).
- The deployment ID in `content.js` must match `studioDeploymentId` in Code.gs.
