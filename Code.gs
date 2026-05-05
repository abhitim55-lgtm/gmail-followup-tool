// =================================================================
// Gmail Follow-Up Tool
// Schedules follow-ups on existing email threads.
// Stops automatically when the prospect replies.
// Runs hourly via a time-based trigger you install with setup().
// =================================================================


// ───────── EDIT THIS SECTION ─────────────────────────────────────

const CONFIG = {
  // Your name for the {senderFirstName} placeholder in templates.
  senderFirstName: 'Abhishek',

  // All Gmail addresses YOU send from (lowercase).
  // Add aliases here if you send from multiple addresses.
  senderEmails: [
    'abhishek.sehgal@procmart.com'
  ],

  // Gmail label prefix. Threads labeled FU/<key> get processed by stage <key>.
  labelPrefix: 'FU',

  // Follow-up stages. Each stage is independent.
  //   daysAfter:  send if N days have passed since YOUR last message
  //   template:   message body. Placeholders: {firstName}, {senderFirstName}
  //   nextLabel:  what to relabel as after sending. null = stop here.
  stages: {
    '3d': {
      daysAfter: 3,
      template: 'Hey {firstName} — just bumping this back up. Any thoughts when you get a sec?\n\n{senderFirstName}',
      nextLabel: 'FU/7d'
    },
    '7d': {
      daysAfter: 7,
      template: 'Hey {firstName} — circling back on this. Worth a quick chat?\n\n{senderFirstName}',
      nextLabel: 'FU/14d'
    },
    '14d': {
      daysAfter: 14,
      template: '{firstName} — last nudge from me. Happy to pick this back up if now isn\'t the right moment.\n\n{senderFirstName}',
      nextLabel: null
    }
  },