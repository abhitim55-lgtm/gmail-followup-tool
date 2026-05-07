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

  // Display name on the From: header of outgoing follow-ups (e.g. "Abhishek Sehgal").
  // Leave blank ('') to auto-detect from your Gmail "Send mail as" settings.
  senderName: 'Abhishek Sehgal',

  // All Gmail addresses YOU send from (lowercase).
  // Add aliases here if you send from multiple addresses.
  senderEmails: [
    'abhishek.sehgal@procmart.com'
  ],

  // Gmail label prefix. The only label we actively process is FU/Custom.
  labelPrefix: 'FU',

  // Default message body when a custom step's message is left blank.
  // Placeholders: {firstName}, {senderFirstName}
  defaultTemplate: 'Hey {firstName} — just bumping this back up. Any thoughts when you get a sec?\n\n{senderFirstName}',

  // Only send during 9am–6pm in the script timezone (set in appsscript.json).
  businessHoursOnly: false,

  // Skip Saturdays and Sundays.
  skipWeekends: false,

  // Don't process threads with last sent message older than this.
  lookbackDays: 90,

  // Cap on follow-ups per run. Safety net.
  maxPerRun: 25,

  // true = log only, don't actually send. Use for first-time testing.
  dryRun: false
};

// ───────── END EDIT SECTION ──────────────────────────────────────


function processFollowUps() {
  Logger.log('processFollowUps build=custom-only');
  if (CONFIG.businessHoursOnly && !isBusinessHours_()) {
    Logger.log('Outside business hours — skipping run.');
    return;
  }

  const myEmails = CONFIG.senderEmails.map(function (e) { return e.toLowerCase(); });
  const cutoff = new Date(Date.now() - CONFIG.lookbackDays * 86400000);
  let sent = 0;

  // Custom multi-step schedules (set via the sidebar UI).
  const customLabel = GmailApp.getUserLabelByName(CONFIG.labelPrefix + '/Custom');
  if (!customLabel) {
    Logger.log('Custom: FU/Custom label DOES NOT EXIST in this account. Run setup() in the same account where you use the sidebar.');
  } else {
    const customThreads = customLabel.getThreads();
    Logger.log('Custom: FU/Custom label exists, ' + customThreads.length + ' thread(s) tagged.');
    const props = PropertiesService.getUserProperties();
    const allKeys = props.getKeys().filter(function (k) { return k.indexOf('custom_') === 0; });
    Logger.log('Custom: ' + allKeys.length + ' schedule(s) stored in user properties.');
    for (const thread of customThreads) {
      if (sent >= CONFIG.maxPerRun) break;
      const key = 'custom_' + thread.getId();
      const raw = props.getProperty(key);
      Logger.log('Custom: thread "' + thread.getFirstMessageSubject() + '" (id=' + thread.getId() + ') — stored=' + (raw ? 'yes' : 'NO'));
      if (!raw) { thread.removeLabel(customLabel); continue; }
      try {
        let data = JSON.parse(raw);
        if (data.sendAt && !data.steps) {
          data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
        }
        if (!data.steps || data.steps.length === 0) {
          Logger.log('Custom: empty steps — clearing.');
          props.deleteProperty(key);
          thread.removeLabel(customLabel);
          continue;
        }
        data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
        const firstStepIn = data.steps[0].sendAt - Date.now();
        Logger.log('Custom: ' + data.steps.length + ' step(s), first fires in ' + Math.round(firstStepIn / 1000) + 's.');
        if (firstStepIn > 0) continue;
        if (processCustomThread_(thread, customLabel, data, myEmails, cutoff)) sent++;
      } catch (e) {
        Logger.log('Custom error on ' + thread.getId() + ': ' + e);
      }
    }
  }

  Logger.log('Done. Sent ' + sent + ' follow-up(s).');

  try { recordRun_(Logger.getLog()); } catch (e) {}
}


// Persist the last N processFollowUps runs so we can read them back via clasp/editor.
const RUN_LOG_KEY = 'recentRuns';
const RUN_LOG_MAX = 20;

function recordRun_(text) {
  const props = PropertiesService.getUserProperties();
  let arr = [];
  const raw = props.getProperty(RUN_LOG_KEY);
  if (raw) { try { arr = JSON.parse(raw); } catch (e) { arr = []; } }
  arr.push({ at: Date.now(), text: String(text || '') });
  while (arr.length > RUN_LOG_MAX) arr.shift();
  props.setProperty(RUN_LOG_KEY, JSON.stringify(arr));
}

// Run from the editor (or via `clasp run lastRunReport`) to see recent trigger runs.
function lastRunReport(n) {
  n = n || 5;
  const raw = PropertiesService.getUserProperties().getProperty(RUN_LOG_KEY);
  if (!raw) return 'No recorded runs yet — trigger may not have fired since the latest deploy.';
  let arr = [];
  try { arr = JSON.parse(raw); } catch (e) { return 'Run log corrupt.'; }
  if (arr.length === 0) return 'No recorded runs yet.';
  const tz = getPreferredTz_();
  const recent = arr.slice(-n).reverse();
  const out = recent.map(function (r) {
    const at = Utilities.formatDate(new Date(r.at), tz, 'MMM d HH:mm:ss z');
    return '=== run @ ' + at + ' ===\n' + r.text.trim();
  }).join('\n\n');
  Logger.log(out);
  return out;
}


function processCustomThread_(thread, label, data, myEmails, cutoff) {
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + thread.getId();
  const messages = thread.getMessages();

  // Locate my last outbound and the most recent inbound — used as fallbacks
  // when a step does not specify explicit recipients.
  let myLastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFromMe_(messages[i], myEmails)) { myLastIdx = i; break; }
  }
  let lastInbound = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isFromMe_(messages[i], myEmails)) { lastInbound = messages[i]; break; }
  }

  const nextStep = data.steps[0];
  const explicitMode = !!(nextStep && nextStep.to);

  if (explicitMode) {
    // In explicit mode the user picked specific recipients, so the thread does
    // not need to contain any of my outbound mail. Auto-cancel only if one of
    // the listed recipients sent something AFTER the step was scheduled.
    const targets = parseAddressList_(nextStep.to)
      .map(function (a) { return a.email.toLowerCase(); })
      .filter(function (e) { return e.length > 0; });
    const sinceMs = nextStep.createdAt || 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.getDate().getTime() <= sinceMs) continue;
      const fromEmail = parseAddress_(m.getFrom()).email.toLowerCase();
      if (fromEmail && targets.indexOf(fromEmail) !== -1) {
        Logger.log('Custom (explicit): "' + fromEmail + '" replied since step was scheduled — cancelling.');
        thread.removeLabel(label);
        props.deleteProperty(key);
        return false;
      }
    }
  } else {
    if (myLastIdx === -1) {
      Logger.log('Custom: thread "' + thread.getFirstMessageSubject() +
        '" has NO outbound message from senderEmails ' + JSON.stringify(myEmails) +
        ' and no explicit recipients on the next step. ' +
        'Senders found: ' + messages.map(function (m) { return m.getFrom(); }).join(' | ') +
        '. Clearing label and stored schedule.');
      thread.removeLabel(label);
      props.deleteProperty(key);
      return false;
    }
    for (let i = myLastIdx + 1; i < messages.length; i++) {
      if (!isFromMe_(messages[i], myEmails)) {
        Logger.log('Prospect replied — cancelling all custom follow-ups.');
        thread.removeLabel(label);
        props.deleteProperty(key);
        return false;
      }
    }
  }

  const myLast = myLastIdx !== -1 ? messages[myLastIdx] : null;

  let sentAny = false;
  while (data.steps.length > 0 && data.steps[0].sendAt <= Date.now()) {
    const step = data.steps[0];

    // Per-step recipient resolution. Priority: explicit > inbound sender > cold-derive.
    let toAddr = '', ccAddr = '', recipientName = '';
    if (step.to) {
      toAddr = step.to;
      ccAddr = step.cc || '';
      const first = parseAddressList_(toAddr)[0];
      if (first) recipientName = first.name || '';
    } else if (lastInbound) {
      const p = parseAddress_(lastInbound.getFrom());
      toAddr = p.email;
      recipientName = p.name;
    } else if (myLast) {
      const recipients = deriveColdRecipients_(messages, myEmails);
      if (!recipients.to) {
        Logger.log('Custom: could not derive non-self recipients for "' +
          thread.getFirstMessageSubject() + '" — clearing.');
        thread.removeLabel(label);
        props.deleteProperty(key);
        return sentAny;
      }
      toAddr = recipients.to;
      ccAddr = recipients.cc;
      const first = parseAddressList_(toAddr)[0];
      if (first) recipientName = first.name || '';
    } else {
      Logger.log('Custom: no recipients resolvable for step on "' +
        thread.getFirstMessageSubject() + '" — clearing.');
      thread.removeLabel(label);
      props.deleteProperty(key);
      return sentAny;
    }

    const firstName = firstNameOf_(recipientName) || 'there';
    const tmpl = step.message || CONFIG.defaultTemplate;
    const text = tmpl
      .replace(/\{firstName\}/g, firstName)
      .replace(/\{senderFirstName\}/g, CONFIG.senderFirstName);

    if (CONFIG.dryRun) {
      Logger.log('[DRY RUN custom] Would send to ' + toAddr +
        (ccAddr ? ' (cc ' + ccAddr + ')' : '') + ':\n' + text);
      break;
    }

    const html = text.replace(/\n/g, '<br>');
    const replyAnchor = messages[messages.length - 1] || null;
    sendThreadReply_(thread, {
      to: toAddr,
      cc: ccAddr,
      body: text,
      html: html,
      replyTo: replyAnchor
    });
    Logger.log('✓ Custom follow-up sent to ' + toAddr +
      (ccAddr ? ' (cc ' + ccAddr + ')' : '') +
      ' (' + (data.steps.length - 1) + ' remaining).');
    data.steps.shift();
    sentAny = true;
  }

  if (data.steps.length === 0) {
    thread.removeLabel(label);
    props.deleteProperty(key);
  } else {
    props.setProperty(key, JSON.stringify(data));
  }
  return sentAny;
}


// Send a reply on an existing Gmail thread using the Gmail Advanced Service.
// We bypass GmailMessage.reply() because it auto-CC's the original sender when
// replying to one of your own sent messages, producing "to me, Nabilla" output.
// Passing threadId to Gmail.Users.Messages.send threads the new message correctly
// and lets us fully control To: / Cc:.
//
// options: { to: string, cc?: string, body: string, html?: string, subject?: string,
//            replyTo?: GmailMessage }
// replyTo is the prior message we're answering — its Message-ID becomes our
// In-Reply-To and is appended to References, so external clients (Outlook, Apple Mail,
// non-Gmail recipients) render the message as a proper threaded reply.
function sendThreadReply_(thread, options) {
  const to = options.to;
  if (!to) throw new Error('sendThreadReply_: missing to');
  const cc = options.cc || '';
  Logger.log('sendThreadReply_ → to="' + to + '" cc="' + cc + '" thread=' + thread.getId());
  const baseSubject = thread.getFirstMessageSubject() || '';
  const subject = options.subject ||
    (/^Re:\s*/i.test(baseSubject) ? baseSubject : 'Re: ' + baseSubject);
  const body = options.body || '';
  const html = options.html || body.replace(/\n/g, '<br>');

  const threadHeaders = readReplyHeaders_(options.replyTo);

  const fromHeader = resolveFromHeader_();

  const boundary = '----=_omc_' + Math.random().toString(36).slice(2);
  let raw = '';
  if (fromHeader) raw += 'From: ' + fromHeader + '\r\n';
  raw += 'To: ' + to + '\r\n';
  if (cc) raw += 'Cc: ' + cc + '\r\n';
  raw += 'Subject: ' + encodeMimeSubject_(subject) + '\r\n';
  if (threadHeaders.inReplyTo) {
    raw += 'In-Reply-To: ' + threadHeaders.inReplyTo + '\r\n';
    raw += 'References: ' + threadHeaders.references + '\r\n';
  }
  raw += 'MIME-Version: 1.0\r\n';
  raw += 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n';
  raw += '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/plain; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: base64\r\n';
  raw += '\r\n';
  raw += encodeBase64Body_(body) + '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/html; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: base64\r\n';
  raw += '\r\n';
  raw += encodeBase64Body_(html) + '\r\n';
  raw += '--' + boundary + '--';

  const encoded = Utilities.base64EncodeWebSafe(raw);
  return Gmail.Users.Messages.send({
    raw: encoded,
    threadId: thread.getId()
  }, 'me');
}

function encodeMimeSubject_(s) {
  if (!s) return '';
  // ASCII subjects pass through unchanged for readability.
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
}

// Base64-encode a string as UTF-8 with RFC 2045 line wrapping at 76 chars.
// Required for body parts so multi-byte characters (smart quotes, em-dashes, etc.)
// survive transport instead of being mangled to "?" by 7bit-only relays.
function encodeBase64Body_(s) {
  const b64 = Utilities.base64Encode(s || '', Utilities.Charset.UTF_8);
  return b64.replace(/.{76}/g, '$&\r\n');
}

// Build the From: header value: '"Display Name" <email@host>' or just the email
// if no display name is available. Display name comes from CONFIG.senderName when
// set, otherwise from the user's Gmail "Send mail as" settings (matches what shows
// up when they reply manually). Cached per script execution.
let _cachedFromHeader_ = null;
function resolveFromHeader_() {
  if (_cachedFromHeader_ !== null) return _cachedFromHeader_;

  let email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  if (!email && CONFIG.senderEmails && CONFIG.senderEmails.length) {
    email = CONFIG.senderEmails[0];
  }

  let name = (CONFIG.senderName || '').trim();
  if (!name) {
    try {
      const sendAs = Gmail.Users.Settings.SendAs.list('me');
      const list = (sendAs && sendAs.sendAs) || [];
      let primary = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].isPrimary) { primary = list[i]; break; }
      }
      if (!primary && list.length) primary = list[0];
      if (primary && primary.displayName) name = String(primary.displayName).trim();
    } catch (e) {
      Logger.log('resolveFromHeader_: SendAs lookup failed: ' + e);
    }
  }

  if (!email) { _cachedFromHeader_ = ''; return _cachedFromHeader_; }

  if (name) {
    // ASCII names: RFC 5322 quoted-string. Non-ASCII: RFC 2047 encoded-word.
    const phrase = /^[\x00-\x7F]*$/.test(name)
      ? '"' + name.replace(/(["\\])/g, '\\$1') + '"'
      : '=?UTF-8?B?' + Utilities.base64Encode(name, Utilities.Charset.UTF_8) + '?=';
    _cachedFromHeader_ = phrase + ' <' + email + '>';
  } else {
    _cachedFromHeader_ = email;
  }
  return _cachedFromHeader_;
}

// Read RFC 5322 threading headers from the message we're replying to.
// Returns { inReplyTo, references } where references is the prior chain plus
// the anchor's Message-ID, per RFC 5322 §3.6.4. Returns empty strings if the
// anchor is missing or the lookup fails — caller falls back to no headers
// (original behavior) rather than failing the send.
function readReplyHeaders_(replyTo) {
  if (!replyTo) return { inReplyTo: '', references: '' };
  try {
    const meta = Gmail.Users.Messages.get('me', replyTo.getId(), {
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References']
    });
    const headers = (meta && meta.payload && meta.payload.headers) || [];
    let messageId = '';
    let priorRefs = '';
    for (let i = 0; i < headers.length; i++) {
      const name = (headers[i].name || '').toLowerCase();
      if (name === 'message-id') messageId = headers[i].value || '';
      else if (name === 'references') priorRefs = headers[i].value || '';
    }
    if (!messageId) return { inReplyTo: '', references: '' };
    const references = priorRefs ? (priorRefs + ' ' + messageId) : messageId;
    return { inReplyTo: messageId, references: references };
  } catch (e) {
    Logger.log('readReplyHeaders_ failed: ' + e + ' — sending without threading headers.');
    return { inReplyTo: '', references: '' };
  }
}


function isFromMe_(message, myEmails) {
  const from = (message.getFrom() || '').toLowerCase();
  return myEmails.some(function (e) { return from.indexOf(e) !== -1; });
}


// Strip our own addresses from a comma-separated header value (To: or Cc:).
// Defends against thread state where a prior buggy follow-up listed ourselves.
function stripSelfRecipients_(headerValue, myEmails) {
  if (!headerValue) return '';
  const lower = myEmails.map(function (e) { return e.toLowerCase(); });
  return headerValue
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) {
      if (!s) return false;
      const email = parseAddress_(s).email.toLowerCase();
      return email && lower.indexOf(email) === -1;
    })
    .join(', ');
}


// Derive recipients for a cold-thread follow-up from the FIRST outbound message
// in the thread — that's the original cold email and reflects the user's true intent.
// Using "myLast" instead is brittle: a prior buggy follow-up can poison the headers.
function deriveColdRecipients_(messages, myEmails) {
  let firstMine = null;
  for (let i = 0; i < messages.length; i++) {
    if (isFromMe_(messages[i], myEmails)) { firstMine = messages[i]; break; }
  }
  if (!firstMine) return { to: '', cc: '' };
  return {
    to: stripSelfRecipients_(firstMine.getTo(), myEmails),
    cc: stripSelfRecipients_(firstMine.getCc(), myEmails)
  };
}


function parseAddress_(s) {
  if (!s) return { name: '', email: '' };
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: s.trim() };
}


// Split a comma-separated header value (To: / Cc:) into [{name, email}, ...].
function parseAddressList_(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map(function (c) { return c.trim(); })
    .filter(function (c) { return c.length > 0; })
    .map(parseAddress_);
}


function firstNameOf_(name) {
  if (!name) return '';
  const cleaned = name.replace(/[",]/g, ' ').trim();
  const first = cleaned.split(/\s+/)[0] || '';
  if (first.indexOf('@') !== -1) return '';
  return first;
}


function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}


function isBusinessHours_() {
  const now = new Date();
  const day = now.getDay();
  if (CONFIG.skipWeekends && (day === 0 || day === 6)) return false;
  const hour = now.getHours();
  return hour >= 9 && hour < 18;
}


// Run this ONCE after pasting the code. Creates the FU/Custom label + the trigger.
function setup() {
  getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');

  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'processFollowUps') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('processFollowUps').timeBased().everyMinutes(1).create();

  Logger.log('Setup done. Trigger runs every 1 min. Use the Gmail sidebar (puzzle icon) to schedule.');
}


// ───────── Gmail Add-on UI ───────────────────────────────────────

function buildHomepage() { return buildDashboardCard_(); }

function buildAddOn(e) {
  const threadId = e && e.gmail && e.gmail.threadId;
  if (!threadId) return buildDashboardCard_();
  return buildCard_(threadId);
}


// ───────── Campaigns dashboard ─────────────────────────────────────
//
// Note: Gmail Add-ons cannot add an item to Gmail's left navigation rail
// (the "Inbox / Sent / Drafts" list — that's controlled by Gmail itself).
// What Mailmeteor shows there is actually their own web app surface, not
// an add-on. The closest equivalent we can offer is this dashboard card,
// reachable via the sidebar puzzle-piece icon when no thread is open, plus
// the FU/Custom Gmail label which already acts as a "saved search" view of
// every thread with a scheduled follow-up.
function buildDashboardCard_() {
  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('Campaigns')
        .setSubtitle('All threads with scheduled follow-ups')
        .setImageUrl('https://www.gstatic.com/images/icons/material/system/2x/schedule_send_googblue_48dp.png')
        .setImageStyle(CardService.ImageStyle.CIRCLE)
    );

  const props = PropertiesService.getUserProperties();
  const allKeys = props.getKeys().filter(function (k) { return k.indexOf('custom_') === 0; });

  const items = [];
  allKeys.forEach(function (key) {
    const threadId = key.substring('custom_'.length);
    const raw = props.getProperty(key);
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (data.sendAt && !data.steps) {
      data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
    }
    if (!data.steps || data.steps.length === 0) return;
    let thread;
    try { thread = GmailApp.getThreadById(threadId); } catch (e) { return; }
    if (!thread) return;
    data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
    const next = data.steps[0];
    items.push({
      threadId: threadId,
      subject: thread.getFirstMessageSubject() || '(no subject)',
      stepCount: data.steps.length,
      nextSendAt: next.sendAt,
      tz: next.tz || getPreferredTz_(),
      to: next.to || '',
      permalink: thread.getPermalink()
    });
  });
  items.sort(function (a, b) { return a.nextSendAt - b.nextSendAt; });

  // Summary section.
  const summary = CardService.newCardSection();
  summary.addWidget(CardService.newTextParagraph().setText(
    items.length === 0
      ? '<font color="#5f6368">No active campaigns. Open a thread and use the sidebar to schedule one.</font>'
      : '<b>' + items.length + '</b> active campaign' + (items.length === 1 ? '' : 's') +
        ' • <b>' + items.reduce(function (n, it) { return n + it.stepCount; }, 0) +
        '</b> step' + (items.reduce(function (n, it) { return n + it.stepCount; }, 0) === 1 ? '' : 's') + ' queued'
  ));
  summary.addWidget(
    CardService.newTextButton()
      .setText('Refresh')
      .setOnClickAction(CardService.newAction().setFunctionName('actionRefreshDashboard'))
  );
  card.addSection(summary);

  // One row per campaign.
  if (items.length > 0) {
    const list = CardService.newCardSection().setHeader('Scheduled');
    items.forEach(function (it, idx) {
      const due = it.nextSendAt - Date.now();
      const status = due > 0 ? 'in ' + humanDelta_(due) : Math.abs(Math.round(due / 60000)) + 'm overdue';
      const recipientHint = it.to
        ? ' → ' + it.to.substring(0, 50)
        : '';
      const dt = CardService.newDecoratedText()
        .setTopLabel(it.stepCount + ' step' + (it.stepCount === 1 ? '' : 's') +
          ' • next ' + status)
        .setText(escapeHtml_(it.subject))
        .setBottomLabel(escapeHtml_(formatLocal_(it.nextSendAt, it.tz) + recipientHint))
        .setWrapText(true)
        .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.CLOCK))
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionOpenThreadCard')
            .setParameters({ threadId: it.threadId })
        );
      list.addWidget(dt);

      const rowButtons = CardService.newButtonSet();
      rowButtons.addButton(
        CardService.newTextButton()
          .setText('Open in Gmail')
          .setOpenLink(CardService.newOpenLink().setUrl(it.permalink))
      );
      rowButtons.addButton(
        CardService.newTextButton()
          .setText('Cancel')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('actionDeleteCampaign')
              .setParameters({ threadId: it.threadId })
          )
      );
      list.addWidget(rowButtons);
      if (idx < items.length - 1) list.addWidget(CardService.newDivider());
    });
    card.addSection(list);
  }

  return card.build();
}

function actionRefreshDashboard() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildDashboardCard_()))
    .build();
}

function actionOpenThreadCard(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('No thread.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(buildCard_(threadId)))
    .build();
}

function actionDeleteCampaign(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('No thread.');
  PropertiesService.getUserProperties().deleteProperty('custom_' + threadId);
  try {
    const thread = GmailApp.getThreadById(threadId);
    if (thread) clearFollowUpLabels_(thread);
  } catch (err) {}
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Campaign cancelled.'))
    .setNavigation(CardService.newNavigation().updateCard(buildDashboardCard_()))
    .build();
}

function humanDelta_(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return min + 'm';
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + 'h';
  const d = Math.round(hr / 24);
  return d + 'd';
}

// Canonicalize a thread ID. e.gmail.threadId can differ in format from
// thread.getId() — using thread.getId() everywhere ensures storage keys match
// what processFollowUps looks up at trigger time.
function canonicalThreadId_(idLike) {
  if (!idLike) return '';
  try {
    const t = GmailApp.getThreadById(idLike);
    if (t) return t.getId();
  } catch (err) {}
  return idLike;
}

function buildCard_(threadId) {
  threadId = canonicalThreadId_(threadId);
  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('Follow-up Scheduler')
        .setImageUrl('https://www.gstatic.com/images/icons/material/system/2x/schedule_send_googblue_48dp.png')
        .setImageStyle(CardService.ImageStyle.CIRCLE)
    );

  // Thread context — subject + recipient as clean DecoratedText rows.
  if (threadId) {
    const ctx = getThreadContext_(threadId);
    if (ctx) {
      const ctxSection = CardService.newCardSection().setHeader('Thread');
      ctxSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('Subject')
          .setText(escapeHtml_(ctx.subject || '(no subject)'))
          .setWrapText(true)
          .setStartIcon(
            CardService.newIconImage().setIcon(CardService.Icon.EMAIL)
          )
      );
      const recipientText = ctx.recipient
        ? (ctx.recipient.name || ctx.recipient.email)
        : 'unknown';
      const recipientBottom = ctx.recipient && ctx.recipient.name
        ? ctx.recipient.email
        : '';
      ctxSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('To')
          .setText(escapeHtml_(recipientText))
          .setBottomLabel(escapeHtml_(recipientBottom))
          .setWrapText(true)
          .setStartIcon(
            CardService.newIconImage().setIcon(CardService.Icon.PERSON)
          )
      );
      card.addSection(ctxSection);
    }
  }

  // Scheduled queue.
  if (threadId) {
    const queue = getQueueForThread_(threadId);
    if (queue.length > 0) {
      const qSection = CardService.newCardSection()
        .setHeader('Scheduled • ' + queue.length + (queue.length === 1 ? ' step' : ' steps'));
      queue.forEach(function (step, idx) {
        const when = formatLocal_(step.sendAt, step.tz);
        const preview = (step.message || '(uses default template)').substring(0, 140);
        const toLabel = step.to
          ? ' • → ' + step.to.substring(0, 60)
          : '';
        qSection.addWidget(
          CardService.newDecoratedText()
            .setTopLabel('Step ' + (idx + 1) + ' • ' + when + toLabel)
            .setText(escapeHtml_(preview))
            .setWrapText(true)
            .setStartIcon(
              CardService.newIconImage().setIcon(CardService.Icon.CLOCK)
            )
            .setButton(
              CardService.newTextButton()
                .setText('Remove')
                .setOnClickAction(
                  CardService.newAction()
                    .setFunctionName('actionRemoveStep')
                    .setParameters({ threadId: threadId, index: String(idx) })
                )
            )
        );
      });
      card.addSection(qSection);
    }
  }

  // ── Build campaign: multi-step relative offsets, plain-text per step ───────
  if (threadId) {
    const draft = getDraft_(threadId);
    const campaign = CardService.newCardSection().setHeader('Build campaign');

    campaign.addWidget(CardService.newTextParagraph().setText(
      '<font color="#5f6368">Each step waits the chosen time after the previous step ' +
      'sends. Auto-cancels if the recipient replies at any point.</font>'
    ));

    campaign.addWidget(
      CardService.newTextInput()
        .setFieldName('recipients')
        .setTitle('Send to (optional)')
        .setHint('Override recipients. Comma-separated emails or "Name <email>". Blank = auto-detect from the thread.')
        .setValue(draft.recipients || '')
    );
    campaign.addWidget(
      CardService.newTextInput()
        .setFieldName('cc')
        .setTitle('Cc (optional)')
        .setValue(draft.cc || '')
    );

    draft.steps.forEach(function (step, idx) {
      campaign.addWidget(CardService.newDivider());
      campaign.addWidget(CardService.newTextParagraph().setText(
        '<b>Step ' + (idx + 1) + '</b>' +
        (idx === 0
          ? ' <font color="#5f6368">— wait this long after now</font>'
          : ' <font color="#5f6368">— wait this long after step ' + idx + ' sends</font>')
      ));
      campaign.addWidget(
        CardService.newTextInput()
          .setFieldName('amount_' + idx)
          .setTitle('Wait')
          .setValue(String(step.amount || 3))
      );
      campaign.addWidget(
        CardService.newSelectionInput()
          .setType(CardService.SelectionInputType.DROPDOWN)
          .setFieldName('unit_' + idx)
          .setTitle('Unit')
          .addItem('days', 'days', step.unit !== 'hours' && step.unit !== 'minutes')
          .addItem('hours', 'hours', step.unit === 'hours')
          .addItem('minutes', 'minutes', step.unit === 'minutes')
      );
      campaign.addWidget(
        CardService.newTextInput()
          .setFieldName('message_' + idx)
          .setTitle('Message')
          .setMultiline(true)
          .setValue(step.message || '')
          .setHint('Blank = use default template. Placeholders: {firstName}, {senderFirstName}')
      );
      if (draft.steps.length > 1) {
        campaign.addWidget(
          CardService.newTextButton()
            .setText('Remove step ' + (idx + 1))
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('actionRemoveDraftStep')
                .setParameters({ threadId: threadId, index: String(idx) })
            )
        );
      }
    });

    campaign.addWidget(CardService.newDivider());

    const builderButtons = CardService.newButtonSet();
    if (draft.steps.length < 10) {
      builderButtons.addButton(
        CardService.newTextButton()
          .setText('+ Add step')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('actionAddDraftStep')
              .setParameters({ threadId: threadId })
          )
      );
    }
    builderButtons.addButton(
      CardService.newTextButton()
        .setText('Save campaign')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionSaveCampaign')
            .setParameters({ threadId: threadId })
        )
    );
    builderButtons.addButton(
      CardService.newTextButton()
        .setText('Clear draft')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionClearDraft')
            .setParameters({ threadId: threadId })
        )
    );
    campaign.addWidget(builderButtons);

    if (draft.steps.length >= 10) {
      campaign.addWidget(CardService.newTextParagraph().setText(
        '<font color="#5f6368"><i>Max 10 steps. Remove one to add another.</i></font>'
      ));
    }

    card.addSection(campaign);
  }

  // ── Templates: save / load / delete saved cadences ─────────────────────────
  if (threadId) {
    const templates = listTemplates_();
    const tplSection = CardService.newCardSection()
      .setHeader('Templates')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);

    if (templates.length > 0) {
      const dd = CardService.newSelectionInput()
        .setType(CardService.SelectionInputType.DROPDOWN)
        .setFieldName('templateName')
        .setTitle('Saved templates')
        .addItem('— select —', '', true);
      templates.forEach(function (t) { dd.addItem(t, t, false); });
      tplSection.addWidget(dd);

      const tplButtons = CardService.newButtonSet();
      tplButtons.addButton(
        CardService.newTextButton()
          .setText('Load')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('actionLoadTemplate')
              .setParameters({ threadId: threadId })
          )
      );
      tplButtons.addButton(
        CardService.newTextButton()
          .setText('Delete')
          .setOnClickAction(
            CardService.newAction()
              .setFunctionName('actionDeleteTemplate')
              .setParameters({ threadId: threadId })
          )
      );
      tplSection.addWidget(tplButtons);
      tplSection.addWidget(CardService.newDivider());
    } else {
      tplSection.addWidget(CardService.newTextParagraph().setText(
        '<font color="#5f6368">No saved templates yet.</font>'
      ));
    }

    tplSection.addWidget(
      CardService.newTextInput()
        .setFieldName('newTemplateName')
        .setTitle('Save current draft as template')
        .setHint('Enter a name then click Save')
    );
    tplSection.addWidget(
      CardService.newTextButton()
        .setText('Save as template')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionSaveTemplate')
            .setParameters({ threadId: threadId })
        )
    );
    card.addSection(tplSection);
  }

  // ── One-off scheduled message: specific date/time, single step ─────────────
  if (threadId) {
    const oneOff = CardService.newCardSection()
      .setHeader('One-off at specific time')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);

    oneOff.addWidget(CardService.newTextParagraph().setText(
      '<font color="#5f6368">Schedule a single follow-up at an exact date/time. ' +
      'For multi-step cadences, use Build campaign above.</font>'
    ));

    const prefillTz = getPreferredTz_();
    const tomorrowMs = Date.now() + 24 * 60 * 60 * 1000;
    const tomorrowStr = Utilities.formatDate(new Date(tomorrowMs), prefillTz, 'yyyy-MM-dd');
    const prefillMs = Utilities.parseDate(tomorrowStr + ' 09:00', 'UTC', 'yyyy-MM-dd HH:mm').getTime();
    oneOff.addWidget(
      CardService.newDateTimePicker()
        .setFieldName('sendAt')
        .setTitle('Send at')
        .setValueInMsSinceEpoch(prefillMs)
    );
    oneOff.addWidget(buildTimezoneDropdown_());
    oneOff.addWidget(
      CardService.newTextInput()
        .setFieldName('oneOffRecipients')
        .setTitle('Send to (optional)')
        .setHint('Override recipients. Blank = auto-detect from the thread.')
    );
    oneOff.addWidget(
      CardService.newTextInput()
        .setFieldName('oneOffCc')
        .setTitle('Cc (optional)')
    );
    oneOff.addWidget(
      CardService.newTextInput()
        .setFieldName('oneOffMessage')
        .setTitle('Message (optional)')
        .setMultiline(true)
        .setHint('Blank = use default template. Placeholders: {firstName}, {senderFirstName}')
    );
    oneOff.addWidget(
      CardService.newTextButton()
        .setText('Add one-off')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionScheduleOneOff')
            .setParameters({ threadId: threadId })
        )
    );
    card.addSection(oneOff);
  }

  // Quick multi-step sequences (one click adds N steps at once).
  if (threadId) {
    const seqSection = CardService.newCardSection()
      .setHeader('Quick sequences')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);
    seqSection.addWidget(
      CardService.newTextParagraph().setText(
        '<font color="#5f6368">Adds multiple steps in one click.</font>'
      )
    );
    const seqButtons = CardService.newButtonSet();
    seqButtons.addButton(
      CardService.newTextButton()
        .setText('3-7-14 days')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionInsertSequence')
            .setParameters({ threadId: threadId, preset: '3-7-14' })
        )
    );
    seqButtons.addButton(
      CardService.newTextButton()
        .setText('1-3-7 days')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionInsertSequence')
            .setParameters({ threadId: threadId, preset: '1-3-7' })
        )
    );
    seqButtons.addButton(
      CardService.newTextButton()
        .setText('2-5-10 days')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionInsertSequence')
            .setParameters({ threadId: threadId, preset: '2-5-10' })
        )
    );
    seqSection.addWidget(seqButtons);
    card.addSection(seqSection);
  }

  // Cancel all on thread.
  if (threadId) {
    const cancelSection = CardService.newCardSection();
    cancelSection.addWidget(
      CardService.newTextButton()
        .setText('Cancel all on this thread')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionCancel')
            .setParameters({ threadId: threadId })
        )
    );
    card.addSection(cancelSection);
  }

  return card.build();
}

function formatLocal_(ms, tz) {
  const zone = tz || getPreferredTz_();
  return Utilities.formatDate(new Date(ms), zone, 'MMM d, h:mm a z');
}


// ───────── Campaign drafts & templates ─────────────────────────────

const DRAFT_PREFIX = 'draft_';
const TEMPLATE_PREFIX = 'template_';
const MAX_CAMPAIGN_STEPS = 10;

function defaultDraft_() {
  return { steps: [{ amount: 3, unit: 'days', message: '' }], recipients: '', cc: '' };
}

function getDraft_(threadId) {
  const raw = PropertiesService.getUserProperties().getProperty(DRAFT_PREFIX + threadId);
  if (!raw) return defaultDraft_();
  try {
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return defaultDraft_();
    if (typeof d.recipients !== 'string') d.recipients = '';
    if (typeof d.cc !== 'string') d.cc = '';
    return d;
  } catch (e) { return defaultDraft_(); }
}

function setDraft_(threadId, draft) {
  PropertiesService.getUserProperties().setProperty(DRAFT_PREFIX + threadId, JSON.stringify(draft));
}

function clearDraft_(threadId) {
  PropertiesService.getUserProperties().deleteProperty(DRAFT_PREFIX + threadId);
}

// Reads form inputs (amount_i, unit_i, message_i) into a draft structure of the
// same length as the existing draft. Used by every action handler so user edits
// aren't lost when the card re-renders.
function readFormDraft_(e, currentDraft) {
  const f = e.formInput || {};
  const count = currentDraft.steps.length;
  const steps = [];
  for (let i = 0; i < count; i++) {
    const amount = parseInt(f['amount_' + i] || '0', 10);
    steps.push({
      amount: isNaN(amount) ? 0 : amount,
      unit: (f['unit_' + i] || 'days').toLowerCase(),
      message: (f['message_' + i] || '').trim()
    });
  }
  return {
    steps: steps,
    recipients: (f.recipients || '').trim(),
    cc: (f.cc || '').trim()
  };
}

function listTemplates_() {
  return PropertiesService.getUserProperties().getKeys()
    .filter(function (k) { return k.indexOf(TEMPLATE_PREFIX) === 0; })
    .map(function (k) { return k.substring(TEMPLATE_PREFIX.length); })
    .sort();
}

function getTemplate_(name) {
  const raw = PropertiesService.getUserProperties().getProperty(TEMPLATE_PREFIX + name);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setTemplateSteps_(name, steps) {
  PropertiesService.getUserProperties().setProperty(
    TEMPLATE_PREFIX + name,
    JSON.stringify({ steps: steps })
  );
}

function deleteTemplate_(name) {
  PropertiesService.getUserProperties().deleteProperty(TEMPLATE_PREFIX + name);
}


// ───────── Campaign action handlers ────────────────────────────────

function actionAddDraftStep(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  if (draft.steps.length >= MAX_CAMPAIGN_STEPS) {
    return notify_('Max ' + MAX_CAMPAIGN_STEPS + ' steps.');
  }
  draft.steps.push({ amount: 3, unit: 'days', message: '' });
  setDraft_(threadId, draft);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionRemoveDraftStep(e) {
  const threadId = e.parameters.threadId;
  const idx = parseInt(e.parameters.index, 10);
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  if (isNaN(idx) || idx < 0 || idx >= draft.steps.length) return notify_('Step not found.');
  draft.steps.splice(idx, 1);
  if (draft.steps.length === 0) draft.steps.push({ amount: 3, unit: 'days', message: '' });
  setDraft_(threadId, draft);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionClearDraft(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  clearDraft_(threadId);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Draft cleared.'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionSaveCampaign(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));

  // Validate: each step must have a positive wait amount.
  for (let i = 0; i < draft.steps.length; i++) {
    const s = draft.steps[i];
    if (!s.amount || s.amount <= 0) {
      // Persist current edits before returning so user doesn't lose them.
      setDraft_(threadId, draft);
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(
          'Step ' + (i + 1) + ': enter a wait amount greater than 0.'
        ))
        .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
        .build();
    }
  }

  // Compute cumulative offsets — each step waits after the previous step's send.
  const tz = getPreferredTz_();
  const now = Date.now();
  const recipientsField = (draft.recipients || '').trim();
  const ccField = (draft.cc || '').trim();
  let cumulative = 0;
  const newSteps = draft.steps.map(function (s) {
    let mult;
    if (s.unit === 'minutes') mult = 60 * 1000;
    else if (s.unit === 'hours') mult = 60 * 60 * 1000;
    else mult = 24 * 60 * 60 * 1000;
    cumulative += s.amount * mult;
    const obj = {
      sendAt: now + cumulative,
      message: s.message,
      tz: tz,
      createdAt: now
    };
    if (recipientsField) obj.to = recipientsField;
    if (ccField) obj.cc = ccField;
    return obj;
  });

  // Append to existing scheduled queue (one-offs and prior campaigns coexist).
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  let existing = { steps: [] };
  const raw = props.getProperty(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.steps)) existing.steps = parsed.steps;
      else if (parsed && parsed.sendAt) {
        existing.steps = [{ sendAt: parsed.sendAt, message: parsed.message || '' }];
      }
    } catch (e2) {}
  }
  existing.steps = existing.steps.concat(newSteps);
  existing.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  props.setProperty(key, JSON.stringify(existing));

  // Tag thread with FU/Custom.
  const thread = GmailApp.getThreadById(threadId);
  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  clearDraft_(threadId);

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Saved ' + newSteps.length + '-step campaign. Last step fires ' +
      formatLocal_(newSteps[newSteps.length - 1].sendAt, tz)
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionScheduleOneOff(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};
  const tz = (f.tz || '').trim() || getPreferredTz_();
  setPreferredTz_(tz);

  const pickerMs = getDateTimeInput_(e, 'sendAt');
  if (!pickerMs) return notify_('Pick a date and time.');
  const wall = Utilities.formatDate(new Date(pickerMs), 'UTC', 'yyyy-MM-dd HH:mm');
  const sendAt = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
  if (sendAt <= Date.now()) return notify_('Pick a future time.');

  const message = (f.oneOffMessage || '').trim();
  const oneOffTo = (f.oneOffRecipients || '').trim();
  const oneOffCc = (f.oneOffCc || '').trim();

  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  let data = { steps: [] };
  const raw = props.getProperty(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.steps)) data.steps = parsed.steps;
      else if (parsed && parsed.sendAt) {
        data.steps = [{ sendAt: parsed.sendAt, message: parsed.message || '' }];
      }
    } catch (err) {}
  }
  const stepObj = { sendAt: sendAt, message: message, tz: tz, createdAt: Date.now() };
  if (oneOffTo) stepObj.to = oneOffTo;
  if (oneOffCc) stepObj.cc = oneOffCc;
  data.steps.push(stepObj);
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  props.setProperty(key, JSON.stringify(data));

  const thread = GmailApp.getThreadById(threadId);
  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Added one-off — fires ' + formatLocal_(sendAt, tz)
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionLoadTemplate(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};
  const name = (f.templateName || '').trim();
  if (!name) return notify_('Pick a template first.');
  const tpl = getTemplate_(name);
  if (!tpl || !Array.isArray(tpl.steps)) return notify_('Template "' + name + '" not found.');
  setDraft_(threadId, { steps: tpl.steps.slice(0, MAX_CAMPAIGN_STEPS) });
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Loaded "' + name + '" (' + tpl.steps.length + ' step(s)).'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionSaveTemplate(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};
  const name = (f.newTemplateName || '').trim();
  if (!name) return notify_('Enter a template name first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  for (let i = 0; i < draft.steps.length; i++) {
    if (!draft.steps[i].amount || draft.steps[i].amount <= 0) {
      setDraft_(threadId, draft);
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(
          'Step ' + (i + 1) + ': set a wait > 0 before saving.'
        ))
        .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
        .build();
    }
  }
  setTemplateSteps_(name, draft.steps);
  setDraft_(threadId, draft);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Saved template "' + name + '" (' + draft.steps.length + ' step(s)).'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionDeleteTemplate(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};
  const name = (f.templateName || '').trim();
  if (!name) return notify_('Pick a template first.');
  deleteTemplate_(name);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Deleted template "' + name + '".'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

const DEFAULT_TZ = 'Asia/Jakarta';
const TZ_PREF_KEY = 'preferredTz';

const TIMEZONE_CHOICES = [
  { label: 'Jakarta (WIB, UTC+7)', value: 'Asia/Jakarta' },
  { label: 'Singapore (SGT, UTC+8)', value: 'Asia/Singapore' },
  { label: 'India (IST, UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'UAE — Dubai (GST, UTC+4)', value: 'Asia/Dubai' },
  { label: 'Bangkok / Hanoi (ICT, UTC+7)', value: 'Asia/Bangkok' },
  { label: 'Hong Kong (HKT, UTC+8)', value: 'Asia/Hong_Kong' },
  { label: 'Tokyo (JST, UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Sydney (AEST/AEDT)', value: 'Australia/Sydney' },
  { label: 'UTC', value: 'UTC' },
  { label: 'London (GMT/BST)', value: 'Europe/London' },
  { label: 'Berlin / Paris (CET/CEST)', value: 'Europe/Berlin' },
  { label: 'US Eastern (NY)', value: 'America/New_York' },
  { label: 'US Central (Chicago)', value: 'America/Chicago' },
  { label: 'US Mountain (Denver)', value: 'America/Denver' },
  { label: 'US Pacific (LA)', value: 'America/Los_Angeles' }
];

function getPreferredTz_() {
  try {
    const v = PropertiesService.getUserProperties().getProperty(TZ_PREF_KEY);
    if (v) return v;
  } catch (err) {}
  return DEFAULT_TZ;
}

function setPreferredTz_(tz) {
  if (!tz) return;
  try { PropertiesService.getUserProperties().setProperty(TZ_PREF_KEY, tz); } catch (err) {}
}

function buildTimezoneDropdown_() {
  const preferred = getPreferredTz_();
  const input = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('tz')
    .setTitle('Timezone');
  let matched = false;
  TIMEZONE_CHOICES.forEach(function (tz) {
    const isSelected = tz.value === preferred;
    if (isSelected) matched = true;
    input.addItem(tz.label, tz.value, isSelected);
  });
  // Fallback: if stored preference isn't in our list, force first option selected.
  if (!matched) {
    // Rebuild with first item selected by default. SelectionInput already added items —
    // simplest fix: append a marker that won't be selected won't work, so just trust the
    // first item is what the renderer picks when nothing else is marked selected.
  }
  return input;
}

function getUserTimezone_(e) {
  try {
    if (e && e.userTimezone && e.userTimezone.id) return e.userTimezone.id;
    if (e && e.commonEventObject && e.commonEventObject.timeZone && e.commonEventObject.timeZone.id) {
      return e.commonEventObject.timeZone.id;
    }
  } catch (err) {}
  return Session.getScriptTimeZone();
}

function getDateTimeInput_(e, fieldName) {
  try {
    const ce = e && e.commonEventObject;
    if (ce && ce.formInputs && ce.formInputs[fieldName]) {
      const dti = ce.formInputs[fieldName].dateTimeInput;
      if (dti && dti.msSinceEpoch != null) return Number(dti.msSinceEpoch);
    }
  } catch (err) {}
  try {
    const v = e && e.formInput && e.formInput[fieldName];
    if (v) return Number(v);
  } catch (err) {}
  return null;
}

function actionRemoveStep(e) {
  const threadId = e.parameters.threadId;
  const index = parseInt(e.parameters.index, 10);
  if (!threadId) return notify_('No thread.');
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  const raw = props.getProperty(key);
  if (!raw) return notify_('Nothing scheduled.');
  let data;
  try { data = JSON.parse(raw); } catch (err) { return notify_('Could not read schedule.'); }
  if (data.sendAt && !data.steps) {
    data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
  }
  if (!data.steps) data.steps = [];
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  if (isNaN(index) || index < 0 || index >= data.steps.length) {
    return notify_('Step not found.');
  }
  data.steps.splice(index, 1);

  if (data.steps.length === 0) {
    props.deleteProperty(key);
    const thread = GmailApp.getThreadById(threadId);
    const customLabel = GmailApp.getUserLabelByName(CONFIG.labelPrefix + '/Custom');
    if (customLabel) thread.removeLabel(customLabel);
  } else {
    props.setProperty(key, JSON.stringify(data));
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Removed.'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionCancel(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('No thread.');
  const thread = GmailApp.getThreadById(threadId);
  clearFollowUpLabels_(thread);
  PropertiesService.getUserProperties().deleteProperty('custom_' + threadId);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Cancelled all follow-ups on this thread.'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function actionInsertSequence(e) {
  const threadId = e.parameters.threadId;
  const preset = e.parameters.preset || '3-7-14';
  if (!threadId) return notify_('Open a thread first.');

  const dayOffsets = preset
    .split('-')
    .map(function (d) { return parseInt(d, 10); })
    .filter(function (d) { return !isNaN(d) && d > 0; });
  if (dayOffsets.length === 0) return notify_('Bad sequence preset.');

  const now = Date.now();
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  let data = { steps: [] };
  const raw = props.getProperty(key);
  if (raw) {
    try {
      data = JSON.parse(raw);
      if (data.sendAt && !data.steps) {
        data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
      }
      if (!data.steps) data.steps = [];
    } catch (err) {
      data = { steps: [] };
    }
  }

  // Add each step at now + N days. Empty message = use CONFIG.defaultTemplate.
  dayOffsets.forEach(function (d) {
    data.steps.push({ sendAt: now + d * 86400000, message: '' });
  });
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  props.setProperty(key, JSON.stringify(data));

  const thread = GmailApp.getThreadById(threadId);
  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Added ' + dayOffsets.length + '-step sequence (' + preset + ' days).'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

function clearFollowUpLabels_(thread) {
  const labels = thread.getLabels();
  for (const l of labels) {
    if (l.getName().indexOf(CONFIG.labelPrefix + '/') === 0) thread.removeLabel(l);
  }
}

function clearOtherFollowUpLabels_(thread, keepName) {
  const labels = thread.getLabels();
  for (const l of labels) {
    const n = l.getName();
    if (n.indexOf(CONFIG.labelPrefix + '/') === 0 && n !== keepName) thread.removeLabel(l);
  }
}

function hasLabel_(thread, name) {
  return thread.getLabels().some(function (l) { return l.getName() === name; });
}

function getThreadContext_(threadId) {
  try {
    const thread = GmailApp.getThreadById(threadId);
    if (!thread) return null;
    const messages = thread.getMessages();
    const myEmails = CONFIG.senderEmails.map(function (e) { return e.toLowerCase(); });
    let lastInbound = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!isFromMe_(messages[i], myEmails)) { lastInbound = messages[i]; break; }
    }
    let recipient = null;
    if (lastInbound) {
      recipient = parseAddress_(lastInbound.getFrom());
    } else {
      // No inbound message — fall back to the To: of my first sent message.
      for (let i = 0; i < messages.length; i++) {
        if (isFromMe_(messages[i], myEmails)) {
          const to = (messages[i].getTo() || '').split(',')[0].trim();
          if (to) recipient = parseAddress_(to);
          break;
        }
      }
    }
    return {
      subject: thread.getFirstMessageSubject(),
      recipient: recipient
    };
  } catch (e) {
    return null;
  }
}

function getQueueForThread_(threadId) {
  const raw = PropertiesService.getUserProperties().getProperty('custom_' + threadId);
  if (!raw) return [];
  try {
    let data = JSON.parse(raw);
    if (data.sendAt && !data.steps) {
      data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
    }
    const steps = (data.steps || []).slice();
    steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
    return steps;
  } catch (e) {
    return [];
  }
}

function escapeHtml_(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}


// One-shot dry run. Run this manually from the editor to preview what would be sent.
function previewNow() {
  const original = CONFIG.dryRun;
  CONFIG.dryRun = true;
  try { processFollowUps(); } finally { CONFIG.dryRun = original; }
}


// Run this from the editor (Run → diagnose) to see why nothing is sending.
// Output appears in View → Logs (or the Executions tab).
function diagnose() {
  const log = [];
  log.push('=== Follow-Up Tool diagnostic ===');

  // 1. Active account.
  let activeEmail = '';
  try { activeEmail = Session.getActiveUser().getEmail(); } catch (e) {}
  log.push('Active account: ' + (activeEmail || '(unknown)'));
  log.push('Configured senderEmails: ' + JSON.stringify(CONFIG.senderEmails));
  if (activeEmail) {
    const matches = CONFIG.senderEmails.some(function (s) {
      return s.toLowerCase() === activeEmail.toLowerCase();
    });
    if (matches) {
      log.push('  ✓ Active account is in senderEmails.');
    } else {
      log.push('  ✗ MISMATCH: active account is NOT in senderEmails. Add "' +
        activeEmail + '" to CONFIG.senderEmails or schedules will silently clear.');
    }
  }

  // 2. Trigger.
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'processFollowUps';
  });
  if (triggers.length === 0) {
    log.push('✗ No processFollowUps trigger installed. Run setup() once.');
  } else {
    log.push('✓ ' + triggers.length + ' processFollowUps trigger(s) installed.');
  }

  // 3. FU/Custom label and tagged threads.
  const customLabel = GmailApp.getUserLabelByName(CONFIG.labelPrefix + '/Custom');
  if (!customLabel) {
    log.push('✗ FU/Custom label missing. Run setup().');
  } else {
    const threads = customLabel.getThreads();
    log.push('FU/Custom: ' + threads.length + ' thread(s) tagged.');
    const props = PropertiesService.getUserProperties();
    const myEmails = CONFIG.senderEmails.map(function (s) { return s.toLowerCase(); });
    threads.forEach(function (thread) {
      const subj = thread.getFirstMessageSubject();
      const id = thread.getId();
      const raw = props.getProperty('custom_' + id);
      if (!raw) {
        log.push('  • "' + subj + '": LABELED but NO schedule stored — will be cleared next run.');
        return;
      }
      let data;
      try { data = JSON.parse(raw); } catch (e) { log.push('  • "' + subj + '": stored JSON broken.'); return; }
      const steps = data.steps || (data.sendAt ? [{ sendAt: data.sendAt, message: data.message }] : []);
      const messages = thread.getMessages();
      let myLast = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isFromMe_(messages[i], myEmails)) { myLast = messages[i]; break; }
      }
      const fromMeStatus = myLast
        ? '✓ found my last sent at ' + Utilities.formatDate(myLast.getDate(), getPreferredTz_(), 'MMM d HH:mm z')
        : '✗ NO outbound message from senderEmails — schedule will be cleared on next run';
      log.push('  • "' + subj + '" (' + steps.length + ' step(s)): ' + fromMeStatus);
      steps.forEach(function (step, idx) {
        const due = step.sendAt - Date.now();
        const tz = step.tz || getPreferredTz_();
        log.push('      step ' + (idx + 1) + ': fires ' +
          Utilities.formatDate(new Date(step.sendAt), tz, 'MMM d HH:mm z') +
          ' (' + (due > 0 ? 'in ' + Math.round(due / 60000) + ' min' : Math.round(-due / 60000) + ' min OVERDUE') + ')');
      });
    });
  }

  // 4. Recent execution failures.
  log.push('Tip: open Executions in the Apps Script editor to see recent processFollowUps runs.');

  log.push('=== end ===');
  Logger.log(log.join('\n'));
  return log.join('\n');
}
