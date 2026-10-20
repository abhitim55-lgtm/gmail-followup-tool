// =================================================================
// Gmail Follow-Up Tool
// Schedules follow-ups on existing email threads.
// Stops automatically when the prospect replies.
// Runs hourly via a time-based trigger you install with setup().
// =================================================================


// ───────── EDIT THIS SECTION ─────────────────────────────────────

const CONFIG = {
  // ── Owner-account identity ──────────────────────────────────────
  // These three settings apply ONLY to the account(s) listed in senderEmails
  // below — the person who originally set the script up. Anyone else who
  // installs the add-on (a teammate, an intern) gets their own identity
  // auto-detected from their Gmail account and "Send mail as" settings, and
  // can override the display name from the sidebar. The owner's name and
  // address never leak into someone else's outgoing mail.

  // Name for the {senderFirstName} placeholder in templates.
  senderFirstName: 'Abhishek',

  // Display name on the From: header of outgoing follow-ups.
  // Leave blank ('') to auto-detect from Gmail "Send mail as" settings.
  senderName: 'Abhishek Sehgal',

  // Extra Gmail addresses the OWNER sends from (lowercase), on top of the ones
  // auto-detected from the running account and its "Send mail as" aliases.
  // Also identifies which account counts as the owner. Usually leave as-is.
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

  // How often the scheduler wakes up to send due follow-ups, in minutes.
  // Apps Script only accepts 1, 5, 10, 15 or 30.
  // Keep this at 5 or higher. A 1-minute trigger fires ~1440 times a day, which
  // exhausts the daily script-runtime quota on consumer Gmail accounts — Google
  // then stops running the trigger and nothing sends, with no visible error.
  triggerIntervalMinutes: 5,

  // Deployment ID of the Follow-up Studio web app (Deploy → Manage
  // deployments). The sidebar's "Open Studio" button links here.
  studioDeploymentId: 'AKfycbxqfbAVuFNv968-Zb2eqDl664UlEDnEaWXbdvYicfV44s4jx4ytm0OkkV4v6SmNINduAA',

  // true = log only, don't actually send. Use for first-time testing.
  dryRun: false
};

// ───────── END EDIT SECTION ──────────────────────────────────────


// ───────── Per-user identity ─────────────────────────────────────
//
// The add-on is one script project but many installs: the owner plus anyone
// they share it with. Everything below resolves identity from the ACCOUNT
// CURRENTLY RUNNING, never from hardcoded config, so a teammate's follow-ups
// go out as them. CONFIG's sender* values are treated as owner-only defaults.

const SENDER_NAME_KEY = 'senderDisplayName';
const SENDER_FIRST_NAME_KEY = 'senderFirstName';

// The address of the account executing right now. getEffectiveUser() is the
// reliable one inside a time-based trigger; getActiveUser() covers the add-on
// UI context. Cached per execution.
let _cachedRunningEmail_ = null;
function getRunningEmail_() {
  if (_cachedRunningEmail_ !== null) return _cachedRunningEmail_;
  let email = '';
  try { email = Session.getEffectiveUser().getEmail() || ''; } catch (e) {}
  if (!email) {
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  }
  if (!email) {
    // Last resort: the primary "Send mail as" entry. Still the running user's
    // own address — we never fall back to a hardcoded one.
    try {
      const primary = getPrimarySendAs_();
      if (primary && primary.sendAsEmail) email = String(primary.sendAsEmail);
    } catch (e) {}
  }
  _cachedRunningEmail_ = email.toLowerCase();
  return _cachedRunningEmail_;
}

// The primary entry from Gmail "Send mail as" — source of the account's real
// display name. Cached per execution; null if the lookup fails.
let _cachedSendAsList_ = null;
function getSendAsList_() {
  if (_cachedSendAsList_ !== null) return _cachedSendAsList_;
  try {
    const res = Gmail.Users.Settings.SendAs.list('me');
    _cachedSendAsList_ = (res && res.sendAs) || [];
  } catch (e) {
    Logger.log('getSendAsList_: lookup failed (' + e + ').');
    _cachedSendAsList_ = [];
  }
  return _cachedSendAsList_;
}

function getPrimarySendAs_() {
  const list = getSendAsList_();
  for (let i = 0; i < list.length; i++) {
    if (list[i].isPrimary) return list[i];
  }
  return list.length ? list[0] : null;
}

// True when the account running this execution is the one CONFIG was written
// for. Only then do CONFIG.senderName / senderFirstName / senderEmails apply.
function isOwnerAccount_() {
  const me = getRunningEmail_();
  if (!me) return false;
  return (CONFIG.senderEmails || []).some(function (e) {
    return String(e).toLowerCase() === me;
  });
}

// Every address that counts as "me": the account running the script and all of
// its Gmail "Send mail as" aliases, plus CONFIG.senderEmails when this IS the
// owner's account. Auto-detection matters: if this list misses the real sending
// address, threads look like they have no outbound from us and schedules get
// cleared. Equally, it must NOT include someone else's address — a teammate
// would then treat the owner's messages as their own and reply on the wrong
// anchor. Cached per execution.
let _cachedMyEmails_ = null;
function getMyEmails_() {
  if (_cachedMyEmails_) return _cachedMyEmails_;
  const seen = {};
  const me = getRunningEmail_();
  if (me) seen[me] = true;
  getSendAsList_().forEach(function (s) {
    if (s.sendAsEmail) seen[String(s.sendAsEmail).toLowerCase()] = true;
  });
  if (isOwnerAccount_()) {
    (CONFIG.senderEmails || []).forEach(function (e) {
      if (e) seen[String(e).toLowerCase()] = true;
    });
  }
  _cachedMyEmails_ = Object.keys(seen);
  if (_cachedMyEmails_.length === 0) {
    Logger.log('getMyEmails_: could not resolve any address for the running account.');
  }
  return _cachedMyEmails_;
}

// Display name for the From: header. Priority: this user's saved override >
// their Gmail "Send mail as" display name > CONFIG.senderName (owner only).
function getSenderDisplayName_() {
  try {
    const saved = PropertiesService.getUserProperties().getProperty(SENDER_NAME_KEY);
    if (saved) return saved.trim();
  } catch (e) {}
  const primary = getPrimarySendAs_();
  if (primary && primary.displayName) return String(primary.displayName).trim();
  if (isOwnerAccount_()) return (CONFIG.senderName || '').trim();
  return '';
}

// Value for the {senderFirstName} placeholder. Same priority chain, falling
// back to the first word of the display name, then the local part of the email.
function getSenderFirstName_() {
  try {
    const saved = PropertiesService.getUserProperties().getProperty(SENDER_FIRST_NAME_KEY);
    if (saved) return saved.trim();
  } catch (e) {}
  if (isOwnerAccount_() && CONFIG.senderFirstName) return CONFIG.senderFirstName;
  const first = firstNameOf_(getSenderDisplayName_());
  if (first) return first;
  const email = getRunningEmail_();
  return email ? email.split('@')[0] : '';
}

function setSenderIdentity_(displayName, firstName) {
  const props = PropertiesService.getUserProperties();
  if (displayName) props.setProperty(SENDER_NAME_KEY, displayName);
  else props.deleteProperty(SENDER_NAME_KEY);
  if (firstName) props.setProperty(SENDER_FIRST_NAME_KEY, firstName);
  else props.deleteProperty(SENDER_FIRST_NAME_KEY);
}


function processFollowUps() {
  Logger.log('processFollowUps build=custom-only');
  // Self-repair from the trigger itself, so accounts with an outdated trigger
  // are fixed without anyone opening the sidebar.
  if (PropertiesService.getUserProperties().getProperty(SCHEDULER_INTERVAL_KEY) !==
      String(normalizeInterval_(CONFIG.triggerIntervalMinutes))) {
    ensureSchedulerQuiet_();
  }
  if (CONFIG.businessHoursOnly && !isBusinessHours_()) {
    Logger.log('Outside business hours — skipping run.');
    return;
  }

  const myEmails = getMyEmails_();
  const cutoff = new Date(Date.now() - CONFIG.lookbackDays * 86400000);
  let sent = 0;
  const errors = [];
  const gate = autopilotGate_();

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
        if (!gate.canSend()) {
          // Due, but outside the Autopilot window or over today's cap: leave it
          // queued; a later run inside the next allowed slot sends it.
          const next = gate.nextSlot();
          Logger.log('Autopilot: holding due follow-ups until ' +
            (next === null ? 'a sending day is switched on' : formatLocal_(next)) + '.');
          break;
        }
        if (processCustomThread_(thread, customLabel, data, myEmails, cutoff, gate)) sent++;
      } catch (e) {
        // A failed send used to be logged and forgotten: the step stayed queued,
        // the run looked clean, and the user saw a campaign that never fired.
        // Keep the step, but surface the reason in the sidebar.
        errors.push(thread.getFirstMessageSubject() + ': ' + e);
        Logger.log('Custom error on ' + thread.getId() + ': ' + e);
      }
    }
  }

  Logger.log('Done. Sent ' + sent + ' follow-up(s).' +
    (errors.length ? ' ' + errors.length + ' error(s).' : ''));

  try { recordRun_(Logger.getLog(), sent, errors); } catch (e) {}
}


// Persist the last N processFollowUps runs so we can read them back via clasp/editor.
const RUN_LOG_KEY = 'recentRuns';
const RUN_LOG_MAX = 20;
const LAST_RUN_KEY = 'lastRunSummary';

function recordRun_(text, sent, errors) {
  const props = PropertiesService.getUserProperties();
  let arr = [];
  const raw = props.getProperty(RUN_LOG_KEY);
  if (raw) { try { arr = JSON.parse(raw); } catch (e) { arr = []; } }
  arr.push({ at: Date.now(), text: String(text || '') });
  while (arr.length > RUN_LOG_MAX) arr.shift();
  props.setProperty(RUN_LOG_KEY, JSON.stringify(arr));

  // Compact summary the sidebar can render without parsing the whole log.
  props.setProperty(LAST_RUN_KEY, JSON.stringify({
    at: Date.now(),
    sent: sent || 0,
    errors: (errors || []).slice(0, 3)
  }));
  recordHeartbeat_('run', { sent: sent || 0, errors: errors || [] });
}

function getLastRunSummary_() {
  try {
    const raw = PropertiesService.getUserProperties().getProperty(LAST_RUN_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
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


function processCustomThread_(thread, label, data, myEmails, cutoff, gate) {
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

  const myLast = myLastIdx !== -1 ? messages[myLastIdx] : null;

  let sentAny = false;
  let idx = 0;
  while (idx < data.steps.length && data.steps[idx].sendAt <= Date.now()) {
    const step = data.steps[idx];
    const explicitMode = !!step.to;

    // Thread-mode steps need at least one outbound from us; otherwise nothing
    // to reply to. Explicit mode is allowed even without prior outbound.
    if (!explicitMode && myLastIdx === -1) {
      Logger.log('Custom: thread "' + thread.getFirstMessageSubject() +
        '" has NO outbound message from senderEmails ' + JSON.stringify(myEmails) +
        ' and no explicit recipients on the step. ' +
        'Senders found: ' + messages.map(function (m) { return m.getFrom(); }).join(' | ') +
        '. Clearing label and stored schedule.');
      thread.removeLabel(label);
      props.deleteProperty(key);
      return sentAny;
    }

    // Per-step condition decides whether we send, skip past, or cancel the whole campaign.
    const hasReply = stepHasReply_(messages, step, myEmails, myLastIdx);
    const condition = step.condition || 'no_reply';
    const decision = evaluateStepCondition_(condition, hasReply);
    if (decision === 'cancel') {
      Logger.log('Custom: condition "' + condition + '" hit — cancelling campaign on "' +
        thread.getFirstMessageSubject() + '".');
      thread.removeLabel(label);
      props.deleteProperty(key);
      return sentAny;
    }
    if (decision === 'defer') {
      // "If replied" step that's due but has no reply yet: hold it and keep
      // checking on later runs, without blocking steps behind it. Give up after
      // a grace window so a never-answered thread doesn't stay armed forever.
      if (Date.now() - step.sendAt > REPLIED_WAIT_MAX_MS) {
        Logger.log('Custom: condition "' + condition + '" never met within ' +
          Math.round(REPLIED_WAIT_MAX_MS / 86400000) + ' days — dropping step on "' +
          thread.getFirstMessageSubject() + '".');
        data.steps.splice(idx, 1);
      } else {
        Logger.log('Custom: condition "' + condition + '" not met yet — holding step on "' +
          thread.getFirstMessageSubject() + '".');
        idx++;
      }
      continue;
    }
    // Per-step recipient resolution. Priority: explicit > inbound sender > cold-derive.
    let toAddr = '', ccAddr = '', recipientName = '';
    if (step.to) {
      toAddr = step.to;
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
    const rendered = tmpl
      .replace(/\{firstName\}/g, firstName)
      .replace(/\{senderFirstName\}/g, getSenderFirstName_());
    const text = applySignatureToBody_(rendered);

    // Several steps of one thread can be due together; Autopilot's cap and
    // delay apply to each of them, not just the first.
    if (gate && !gate.canSend()) break;

    if (CONFIG.dryRun) {
      Logger.log('[DRY RUN custom] Would send to ' + toAddr +
        (ccAddr ? ' (cc ' + ccAddr + ')' : '') + ':\n' + text);
      if (gate) gate.record();
      break;
    }

    const html = text.replace(/\n/g, '<br>');
    // Additive: per-step / campaign-level cc and bcc layer on top of any
    // thread-derived defaults without replacing them.
    ccAddr = mergeRecipients_(ccAddr, step.cc || '');
    const bccAddr = (step.bcc || '').trim();
    const replyAnchor = messages[messages.length - 1] || null;
    sendThreadReply_(thread, {
      to: toAddr,
      cc: ccAddr,
      bcc: bccAddr,
      body: text,
      html: html,
      replyTo: replyAnchor
    });
    Logger.log('✓ Custom follow-up sent to ' + toAddr +
      (ccAddr ? ' (cc ' + ccAddr + ')' : '') +
      ' (' + (data.steps.length - 1) + ' remaining).');
    data.steps.splice(idx, 1);
    sentAny = true;
    if (gate) gate.record();
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
// options: { to: string, cc?: string, bcc?: string, body: string, html?: string,
//            subject?: string, replyTo?: GmailMessage }
// replyTo is the prior message we're answering — its Message-ID becomes our
// In-Reply-To and is appended to References, so external clients (Outlook, Apple Mail,
// non-Gmail recipients) render the message as a proper threaded reply.
function sendThreadReply_(thread, options) {
  const to = options.to;
  if (!to) throw new Error('sendThreadReply_: missing to');
  const cc = options.cc || '';
  const bcc = options.bcc || '';
  Logger.log('sendThreadReply_ → to="' + to + '" cc="' + cc + '" bcc="' + bcc + '" thread=' + thread.getId());
  const baseSubject = thread.getFirstMessageSubject() || '';
  const subject = options.subject ||
    (/^Re:\s*/i.test(baseSubject) ? baseSubject : 'Re: ' + baseSubject);
  const body = options.body || '';
  const html = options.html || body.replace(/\n/g, '<br>');

  const threadHeaders = readReplyHeaders_(options.replyTo);

  const encoded = buildRawMime_({
    to: to, cc: cc, bcc: bcc, subject: subject, body: body, html: html,
    inReplyTo: threadHeaders.inReplyTo, references: threadHeaders.references
  });
  return Gmail.Users.Messages.send({
    raw: encoded,
    threadId: thread.getId()
  }, 'me');
}

// Start a brand-new thread (the first email of a Studio campaign). Same MIME
// and From: identity as follow-up replies. Returns { id, threadId }.
function sendNewMessage_(options) {
  if (!options.to) throw new Error('sendNewMessage_: missing to');
  Logger.log('sendNewMessage_ → to="' + options.to + '" subject="' + options.subject + '"');
  const encoded = buildRawMime_({
    to: options.to, cc: options.cc || '', bcc: options.bcc || '',
    subject: options.subject || '', body: options.body || '',
    html: options.html || textToHtml_(options.body || '')
  });
  return Gmail.Users.Messages.send({ raw: encoded }, 'me');
}

// Plain text → minimal HTML: escaped, newlines as <br>.
function textToHtml_(text) {
  return '<div dir="ltr">' + escapeHtml_(text || '').replace(/\r?\n/g, '<br>') + '</div>';
}

// Assemble a multipart/alternative RFC 5322 message, web-safe base64 encoded
// for Gmail.Users.Messages.send.
function buildRawMime_(o) {
  const fromHeader = resolveFromHeader_();
  const boundary = '----=_omc_' + Math.random().toString(36).slice(2);
  let raw = '';
  if (fromHeader) raw += 'From: ' + fromHeader + '\r\n';
  raw += 'To: ' + o.to + '\r\n';
  if (o.cc) raw += 'Cc: ' + o.cc + '\r\n';
  if (o.bcc) raw += 'Bcc: ' + o.bcc + '\r\n';
  raw += 'Subject: ' + encodeMimeSubject_(o.subject) + '\r\n';
  if (o.inReplyTo) {
    raw += 'In-Reply-To: ' + o.inReplyTo + '\r\n';
    raw += 'References: ' + o.references + '\r\n';
  }
  raw += 'MIME-Version: 1.0\r\n';
  raw += 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n';
  raw += '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/plain; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: base64\r\n';
  raw += '\r\n';
  raw += encodeBase64Body_(o.body) + '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/html; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: base64\r\n';
  raw += '\r\n';
  raw += encodeBase64Body_(o.html) + '\r\n';
  raw += '--' + boundary + '--';
  return Utilities.base64EncodeWebSafe(raw);
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
// if no display name is available.
//
// Both parts resolve from the account running right now — never from CONFIG for
// anyone but the owner. Sending with someone else's address in From: is rejected
// by the Gmail API ("Invalid From header" / delegation denied), which surfaced as
// the campaign silently never sending. Returning '' is safe: Gmail then stamps
// the running account's own default From:. Cached per script execution.
let _cachedFromHeader_ = null;
function resolveFromHeader_() {
  if (_cachedFromHeader_ !== null) return _cachedFromHeader_;

  const email = getRunningEmail_();
  const name = getSenderDisplayName_();

  if (!email) {
    Logger.log('resolveFromHeader_: no address for the running account — letting Gmail set From:.');
    _cachedFromHeader_ = '';
    return _cachedFromHeader_;
  }

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


// Merge two comma-separated recipient lists, deduping by lowercased email.
// Either side may be blank/missing. Used to layer per-step or campaign-level
// CC/BCC on top of thread-derived defaults without double-listing anyone.
function mergeRecipients_(a, b) {
  const seen = {};
  const out = [];
  function add(list) {
    if (!list) return;
    String(list).split(',').forEach(function (s) {
      const trimmed = s.trim();
      if (!trimmed) return;
      const email = parseAddress_(trimmed).email.toLowerCase();
      if (!email) return;
      if (seen[email]) return;
      seen[email] = true;
      out.push(trimmed);
    });
  }
  add(a);
  add(b);
  return out.join(', ');
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


// ───────── Autopilot ─────────────────────────────────────────────
//
// Per-account sending rules, like Mailmeteor's Autopilot: which days and hours
// follow-ups may go out (in the preferred timezone), how many per day, and a
// minimum gap between two sends. Off by default. When on, a due follow-up that
// falls outside a window or over the daily cap simply stays queued and goes
// out on the first run inside the next allowed slot — nothing is dropped.

const AUTOPILOT_KEY = 'autopilot';
const AUTOPILOT_STATE_KEY = 'autopilotState'; // { day: 'yyyy-MM-dd', count, lastAt }
const AUTOPILOT_MAX_PER_DAY = 2000;
const AUTOPILOT_MAX_DELAY_MIN = 120;

function defaultAutopilot_() {
  const days = [];
  for (let d = 0; d < 7; d++) days.push({ on: d >= 1 && d <= 5, from: '09:00', to: '17:00' });
  return { enabled: false, days: days, maxPerDay: 50, delayMinutes: 5 };
}

function normalizeAutopilot_(s) {
  const def = defaultAutopilot_();
  s = s || {};
  const hhmm = function (v, fallback) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
    if (!m || +m[1] > 23 || +m[2] > 59) return fallback;
    return (m[1].length === 1 ? '0' : '') + m[1] + ':' + m[2];
  };
  const days = def.days.map(function (dd, i) {
    const x = (Array.isArray(s.days) && s.days[i]) || dd;
    let from = hhmm(x.from, dd.from), to = hhmm(x.to, dd.to);
    if (to <= from) { from = dd.from; to = dd.to; }
    return { on: !!x.on, from: from, to: to };
  });
  const int = function (v, lo, hi, fallback) {
    const n = Math.floor(Number(v));
    return isNaN(n) ? fallback : Math.max(lo, Math.min(hi, n));
  };
  return {
    enabled: !!s.enabled,
    days: days,
    maxPerDay: int(s.maxPerDay, 1, AUTOPILOT_MAX_PER_DAY, def.maxPerDay),
    delayMinutes: int(s.delayMinutes, 0, AUTOPILOT_MAX_DELAY_MIN, def.delayMinutes)
  };
}

function getAutopilot_() {
  let raw = null;
  try { raw = PropertiesService.getUserProperties().getProperty(AUTOPILOT_KEY); } catch (e) {}
  if (!raw) return defaultAutopilot_();
  try { return normalizeAutopilot_(JSON.parse(raw)); } catch (e) { return defaultAutopilot_(); }
}

function setAutopilot_(s) {
  const ap = normalizeAutopilot_(s);
  PropertiesService.getUserProperties().setProperty(AUTOPILOT_KEY, JSON.stringify(ap));
  return ap;
}

// Calendar date and weekday (0 = Sunday) of an instant, in tz.
function wallDate_(ms, tz) {
  const date = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
  return { date: date, dow: new Date(date + 'T00:00:00Z').getUTCDay() };
}

function readAutopilotState_(today) {
  let st = null;
  try { st = JSON.parse(PropertiesService.getUserProperties().getProperty(AUTOPILOT_STATE_KEY) || 'null'); } catch (e) {}
  st = st || {};
  return { day: today, count: st.day === today ? (st.count || 0) : 0, lastAt: st.lastAt || 0 };
}

// Earliest instant >= nowMs at which Autopilot allows a send, or null when no
// day is switched on. Looks at most a week ahead.
function autopilotNextSlot_(nowMs, ap, tz, state) {
  let earliest = nowMs;
  if (ap.delayMinutes && state.lastAt) earliest = Math.max(earliest, state.lastAt + ap.delayMinutes * 60000);
  for (let k = 0; k <= 8; k++) {
    const wd = wallDate_(earliest + k * 86400000, tz);
    const win = ap.days[wd.dow];
    if (!win.on) continue;
    if (wd.date === state.day && state.count >= ap.maxPerDay) continue;
    const start = Utilities.parseDate(wd.date + ' ' + win.from, tz, 'yyyy-MM-dd HH:mm').getTime();
    const end = Utilities.parseDate(wd.date + ' ' + win.to, tz, 'yyyy-MM-dd HH:mm').getTime();
    const cand = Math.max(earliest, start);
    if (cand < end) return cand;
  }
  return null;
}

// One per scheduler run. canSend() says whether a follow-up may go out right
// now; record() counts one that did.
function autopilotGate_() {
  const ap = getAutopilot_();
  if (!ap.enabled) return { enabled: false, canSend: function () { return true; }, record: function () {}, nextSlot: function () { return null; } };
  const tz = getPreferredTz_();
  const state = readAutopilotState_(wallDate_(Date.now(), tz).date);
  return {
    enabled: true,
    nextSlot: function () { return autopilotNextSlot_(Date.now(), ap, tz, state); },
    canSend: function () {
      const next = autopilotNextSlot_(Date.now(), ap, tz, state);
      return next !== null && next <= Date.now();
    },
    record: function () {
      const today = wallDate_(Date.now(), tz).date;
      if (state.day !== today) { state.day = today; state.count = 0; }
      state.count++;
      state.lastAt = Date.now();
      // A dry run sends nothing, so it must not use up today's allowance.
      if (!CONFIG.dryRun) PropertiesService.getUserProperties().setProperty(AUTOPILOT_STATE_KEY, JSON.stringify(state));
    }
  };
}

// For the Studio: settings plus where things stand today.
function autopilotStatus_() {
  const ap = getAutopilot_();
  const tz = getPreferredTz_();
  const state = readAutopilotState_(wallDate_(Date.now(), tz).date);
  const next = ap.enabled ? autopilotNextSlot_(Date.now(), ap, tz, state) : null;
  return {
    settings: ap,
    tz: tz,
    interval: normalizeInterval_(CONFIG.triggerIntervalMinutes),
    maxPerRun: CONFIG.maxPerRun,
    sentToday: state.count,
    sendingNow: !ap.enabled || (next !== null && next <= Date.now()),
    nextSlotLabel: next === null ? '' : Utilities.formatDate(new Date(next), tz, 'EEE, MMM d, h:mm a')
  };
}


// ───────── Scheduler installation ────────────────────────────────
//
// Nothing sends unless THIS user's Google account has a time-based trigger
// running processFollowUps. Triggers are per-account, not per-script: every
// person who installs the add-on needs their own, and they can't get one by
// opening the Apps Script editor (most users never can). They also disappear —
// Google disables a trigger that errors repeatedly or blows the daily runtime
// quota, with no notice in the UI.
//
// So we never rely on someone remembering to run setup(). ensureScheduler_()
// is called every time the sidebar opens and every time a campaign is saved,
// and repairs whatever is missing.

const SCHEDULER_ERROR_KEY = 'schedulerInstallError';

function schedulerTriggers_() {
  try {
    return ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'processFollowUps';
    });
  } catch (e) {
    return [];
  }
}

// Make sure this account has exactly one scheduler trigger at the configured
// interval, plus the FU/Custom label. Idempotent and cheap — safe to call on
// every card render. Returns { ok, installed, message }.
function ensureScheduler_() {
  const result = { ok: false, installed: false, message: '' };

  try {
    getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  } catch (e) {
    result.message = 'Could not create the ' + CONFIG.labelPrefix + '/Custom label: ' + e;
    recordSchedulerError_(result.message);
    return result;
  }

  let existing;
  try {
    existing = schedulerTriggers_();
  } catch (e) {
    result.message = 'Could not read triggers: ' + e;
    recordSchedulerError_(result.message);
    return result;
  }

  // Collapse duplicates — repeated repairs across versions can stack them up,
  // and each one sends the whole queue again.
  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      try { ScriptApp.deleteTrigger(existing[i]); } catch (e) {}
    }
    existing = existing.slice(0, 1);
  }

  // A trigger's interval can't be read back, so remember the one we created
  // it with. Triggers from older versions (some ran every minute and burned
  // the daily quota) have no record and get rebuilt at the configured interval.
  const props = PropertiesService.getUserProperties();
  const want = String(normalizeInterval_(CONFIG.triggerIntervalMinutes));
  if (existing.length === 1 && props.getProperty(SCHEDULER_INTERVAL_KEY) === want) {
    result.ok = true;
    clearSchedulerError_();
    return result;
  }
  existing.forEach(function (t) {
    try { ScriptApp.deleteTrigger(t); } catch (e) {}
  });

  try {
    ScriptApp.newTrigger('processFollowUps')
      .timeBased()
      .everyMinutes(Number(want))
      .create();
    props.setProperty(SCHEDULER_INTERVAL_KEY, want);
    result.ok = true;
    result.installed = true;
    clearSchedulerError_();
    Logger.log('ensureScheduler_: installed scheduler trigger for ' + getRunningEmail_());
  } catch (e) {
    result.message = String(e);
    recordSchedulerError_(result.message);
    Logger.log('ensureScheduler_: could not install trigger: ' + e);
  }
  return result;
}

const SCHEDULER_INTERVAL_KEY = 'schedulerIntervalMinutes';

// Apps Script only accepts 1, 5, 10, 15 or 30 for everyMinutes().
function normalizeInterval_(mins) {
  const allowed = [1, 5, 10, 15, 30];
  const n = parseInt(mins, 10);
  if (allowed.indexOf(n) !== -1) return n;
  return 5;
}

function recordSchedulerError_(msg) {
  try {
    PropertiesService.getUserProperties().setProperty(
      SCHEDULER_ERROR_KEY, JSON.stringify({ at: Date.now(), message: String(msg) })
    );
  } catch (e) {}
}

function clearSchedulerError_() {
  try { PropertiesService.getUserProperties().deleteProperty(SCHEDULER_ERROR_KEY); } catch (e) {}
}

function getSchedulerError_() {
  try {
    const raw = PropertiesService.getUserProperties().getProperty(SCHEDULER_ERROR_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// Best-effort repair from any UI entry point. Never throws — a scheduler
// problem must not stop a card from rendering.
function ensureSchedulerQuiet_() {
  try { return ensureScheduler_(); }
  catch (e) { return { ok: false, installed: false, message: String(e) }; }
}

// Optional: run once from the Apps Script editor. The add-on repairs itself
// without this, so it exists only for owner-side setup and testing.
function setup() {
  const res = ensureScheduler_();
  const msg = res.ok
    ? 'Setup done for ' + getRunningEmail_() + '. Scheduler runs every ' +
      normalizeInterval_(CONFIG.triggerIntervalMinutes) +
      ' min. Use the Gmail sidebar (puzzle icon) to schedule.'
    : 'Setup FAILED: ' + res.message;
  Logger.log(msg);
  return msg;
}


// ───────── Gmail Add-on UI ───────────────────────────────────────

// Opening the sidebar is the one moment we know the user is present and
// authorized, so it doubles as the self-repair hook for the scheduler.
function buildHomepage() {
  ensureSchedulerQuiet_();
  recordHeartbeat_('sidebar');
  return buildDashboardCard_();
}

function buildAddOn(e) {
  ensureSchedulerQuiet_();
  recordHeartbeat_('sidebar');
  const threadId = e && e.gmail && e.gmail.threadId;
  if (!threadId) return buildDashboardCard_();
  return buildCard_(threadId);
}


// ───────── Campaigns dashboard ─────────────────────────────────────
//
// The home card and its sub-screens live in Sidebar.gs.

// Every thread with something queued, soonest first. Shared by the sidebar
// dashboard and the Studio's Campaigns page.
function collectCampaigns_() {
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
      campaignName: data.campaignName || '',
      subject: thread.getFirstMessageSubject() || '(no subject)',
      stepCount: data.steps.length,
      nextSendAt: next.sendAt,
      tz: next.tz || getPreferredTz_(),
      to: next.to || '',
      permalink: thread.getPermalink()
    });
  });
  items.sort(function (a, b) { return a.nextSendAt - b.nextSendAt; });
  return items;
}

// Status panel. Every failure mode this tool has ever had was invisible from
// Gmail — no trigger, wrong sending identity, a send that threw. They are all
// reported here, in the sidebar, where the person using the tool actually looks.
// from: which screen hosts the panel ('home' | 'settings'), so its buttons
// redraw that screen.
function buildHealthSection_(items, from) {
  const section = CardService.newCardSection()
    .setHeader('Status')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(2);

  const triggers = schedulerTriggers_();
  const running = triggers.length > 0;
  const interval = normalizeInterval_(CONFIG.triggerIntervalMinutes);

  section.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Scheduler')
      .setText(running
        ? '<font color="#188038">Running</font> — checks every ' + interval + ' min'
        : '<font color="#d93025"><b>Not running — nothing will send</b></font>')
      .setWrapText(true)
      .setStartIcon(CardService.newIconImage().setIcon(
        running ? CardService.Icon.CLOCK : CardService.Icon.DESCRIPTION
      ))
  );

  const account = getRunningEmail_();
  const displayName = getSenderDisplayName_();
  section.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('Sending as')
      .setText(escapeHtml_(
        (displayName ? displayName + ' ' : '') + '<' + (account || 'unknown account') + '>'
      ))
      .setWrapText(true)
      .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.EMAIL))
  );

  if (!account) {
    section.addWidget(CardService.newTextParagraph().setText(
      '<font color="#d93025">Could not detect your Gmail address. Reopen the ' +
      'add-on and accept the permission prompt.</font>'
    ));
  }

  const installError = getSchedulerError_();
  if (!running && installError) {
    section.addWidget(CardService.newTextParagraph().setText(
      '<font color="#d93025">Last install attempt failed: ' +
      escapeHtml_(installError.message) + '</font>'
    ));
  }

  const lastRun = getLastRunSummary_();
  if (lastRun) {
    const ago = humanDelta_(Date.now() - lastRun.at);
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Last check')
        .setText(ago + ' ago — sent ' + lastRun.sent +
          ((lastRun.errors && lastRun.errors.length)
            ? ', <font color="#d93025">' + lastRun.errors.length + ' failed</font>'
            : ''))
        .setWrapText(true)
    );
    (lastRun.errors || []).forEach(function (err) {
      section.addWidget(CardService.newTextParagraph().setText(
        '<font color="#d93025">' + escapeHtml_(err) + '</font>'
      ));
    });
  } else if (running) {
    section.addWidget(CardService.newTextParagraph().setText(
      '<font color="#5f6368">No check has run yet. The first one happens within ' +
      interval + ' minutes.</font>'
    ));
  }

  const overdue = (items || []).filter(function (it) { return it.nextSendAt < Date.now() - 120000; });
  if (overdue.length > 0 && running) {
    section.addWidget(CardService.newTextParagraph().setText(
      '<font color="#d93025">' + overdue.length + ' step(s) are past due.</font> ' +
      'Tap "Send due now" to run immediately, then check the result here.'
    ));
  }

  const buttons = CardService.newButtonSet();
  buttons.addButton(
    CardService.newTextButton()
      .setText(running ? 'Re-check scheduler' : 'Fix scheduler')
      .setTextButtonStyle(running
        ? CardService.TextButtonStyle.TEXT
        : CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('actionFixScheduler')
        .setParameters({ from: from || 'home' }))
  );
  buttons.addButton(
    CardService.newTextButton()
      .setText('Send due now')
      .setOnClickAction(CardService.newAction().setFunctionName('actionRunNow')
        .setParameters({ from: from || 'home' }))
  );
  section.addWidget(buttons);

  return section;
}

// Install or repair this account's scheduler on demand.
function actionFixScheduler(e) {
  const res = ensureScheduler_();
  let msg;
  if (res.ok && res.installed) msg = 'Scheduler installed. Follow-ups will send from now on.';
  else if (res.ok) msg = 'Scheduler is running.';
  else msg = 'Could not install the scheduler: ' + res.message;
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(msg))
    .setNavigation(CardService.newNavigation().updateCard(screenFor_(e)))
    .build();
}

// Run the queue immediately instead of waiting for the next trigger. Also the
// fastest way to see a real error message, since failures land in the panel above.
function actionRunNow(e) {
  let msg;
  try {
    processFollowUps();
    const summary = getLastRunSummary_();
    if (!summary) {
      msg = 'Ran, but no result was recorded.';
    } else if (summary.errors && summary.errors.length) {
      msg = 'Sent ' + summary.sent + ', ' + summary.errors.length +
        ' failed: ' + summary.errors[0];
    } else {
      msg = summary.sent > 0
        ? 'Sent ' + summary.sent + ' follow-up(s).'
        : 'Nothing was due. Anything scheduled for later stays queued.';
    }
  } catch (err) {
    msg = 'Run failed: ' + err;
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(msg))
    .setNavigation(CardService.newNavigation().updateCard(screenFor_(e)))
    .build();
}

function actionRefreshDashboard() {
  ensureSchedulerQuiet_();
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

const ICON_URL_ = 'https://www.gstatic.com/images/icons/material/system/2x/schedule_send_googblue_48dp.png';

// Main thread card: who this goes to, what's already queued, and one-click
// "Start" for every saved sequence. The detailed builder lives on its own card
// (buildBuilderCard_) so the common path is a single click.
function buildCard_(threadId) {
  threadId = canonicalThreadId_(threadId);
  if (!threadId) return buildDashboardCard_();
  const ctx = getThreadContext_(threadId);

  const header = CardService.newCardHeader()
    .setTitle('Follow-ups')
    .setImageUrl(ICON_URL_)
    .setImageStyle(CardService.ImageStyle.CIRCLE);
  if (ctx) header.setSubtitle(ctx.subject || '(no subject)');
  const card = CardService.newCardBuilder().setHeader(header);

  if (ctx && ctx.recipient) {
    const who = CardService.newCardSection();
    who.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Follow-ups go to')
        .setText(escapeHtml_(ctx.recipient.name || ctx.recipient.email))
        .setBottomLabel(escapeHtml_(ctx.recipient.name ? ctx.recipient.email : ''))
        .setWrapText(true)
        .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.PERSON))
    );
    card.addSection(who);
  }

  // Already scheduled on this thread.
  const queue = getQueueForThread_(threadId);
  if (queue.length > 0) {
    const qSection = CardService.newCardSection()
      .setHeader('Scheduled · ' + queue.length + (queue.length === 1 ? ' email' : ' emails'));
    queue.forEach(function (step, idx) {
      const when = formatLocal_(step.sendAt, step.tz);
      const cond = conditionLabel_(step.condition);
      qSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel(when + (cond ? ' · ' + cond : ''))
          .setText(escapeHtml_((step.message || '(default bump message)').substring(0, 140)))
          .setWrapText(true)
          .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.CLOCK))
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
    qSection.addWidget(
      CardService.newTextButton()
        .setText('Cancel all')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionAskStop')
            .setParameters({ threadId: threadId, from: 'thread' })
        )
    );
    card.addSection(qSection);
  }

  // One-click sequences.
  const sequences = studioSequences_();
  const start = CardService.newCardSection()
    .setHeader(queue.length ? 'Add a sequence' : 'Start a sequence');
  if (sequences.length === 0) {
    start.addWidget(CardService.newTextParagraph().setText(
      '<font color="#5f6368">No sequences yet. Tap <b>New sequence</b> below ' +
      'to write your follow-ups once and reuse them on every email, or use ' +
      '<b>Custom follow-up</b> for a one-off.</font>'
    ));
  } else {
    start.addWidget(CardService.newTextParagraph().setText(
      '<font color="#5f6368">One click schedules every follow-up as a reply ' +
      'on this thread. Stops automatically when they reply.</font>'
    ));
    sequences.forEach(function (seq) {
      const first = (seq.steps[0] && seq.steps[0].message) || '';
      start.addWidget(
        CardService.newDecoratedText()
          .setTopLabel(escapeHtml_(seq.name))
          .setText(escapeHtml_(describeSequence_(seq.steps)))
          .setBottomLabel(escapeHtml_(first.replace(/\s+/g, ' ').substring(0, 70)))
          .setWrapText(true)
          .setButton(
            CardService.newTextButton()
              .setText('Start')
              .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
              .setOnClickAction(
                CardService.newAction()
                  .setFunctionName('actionStartSequence')
                  .setParameters({ threadId: threadId, name: seq.name })
              )
          )
      );
    });
  }
  card.addSection(start);

  const footer = CardService.newFixedFooter().setPrimaryButton(
    CardService.newTextButton()
      .setText('Custom follow-up')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('actionOpenBuilder')
          .setParameters({ threadId: threadId })
      )
  );
  footer.setSecondaryButton(
    CardService.newTextButton()
      .setText('New sequence')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('actionOpenSequenceEditor')
          .setParameters({ returnTo: 'thread', threadId: threadId })
      )
  );
  card.setFixedFooter(footer);

  return card.build();
}

function conditionLabel_(condition) {
  if (condition === 'replied') return 'if replied';
  if (condition === 'always') return 'always';
  return 'if no reply';
}

// "3 follow-ups · day 3, 7, 14" (cumulative days) or "2h → 1d" for mixed units.
function describeSequence_(steps) {
  const n = steps.length;
  const head = n + (n === 1 ? ' follow-up' : ' follow-ups');
  if (n === 0) return head;
  const allDays = steps.every(function (s) { return s.unit === 'days'; });
  if (allDays) {
    let day = 0;
    return head + ' · day ' + steps.map(function (s) { day += s.amount; return day; }).join(', ');
  }
  return head + ' · ' + steps.map(function (s) {
    return s.amount + (s.unit === 'hours' ? 'h' : s.unit === 'minutes' ? 'm' : 'd');
  }).join(' → ');
}

function actionOpenBuilder(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(buildBuilderCard_(threadId)))
    .build();
}

// One click: schedule a saved sequence's follow-ups on this thread.
function actionStartSequence(e) {
  const threadId = e.parameters.threadId;
  const name = e.parameters.name;
  if (!threadId) return notify_('Open a thread first.');
  const seq = getSequence_(name);
  if (!seq || !Array.isArray(seq.steps) || seq.steps.length === 0) {
    return notify_('Sequence "' + name + '" not found or has no follow-ups.');
  }
  const steps = seq.steps.slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
  const tz = getPreferredTz_();
  const armed = armThreadWithSteps_(threadId, steps, {
    tz: tz,
    recipients: seq.recipients || '',
    cc: seq.cc || '',
    bcc: seq.bcc || ''
  });
  const scheduler = ensureSchedulerQuiet_();
  const firstAt = armed.steps[0].sendAt;
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      scheduler.ok
        ? 'Started "' + name + '" — first follow-up ' + formatLocal_(firstAt, tz) + '.'
        : 'Saved, but the scheduler is NOT running — nothing will send. ' +
          'Open the Campaigns dashboard and tap "Fix scheduler".'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

// Detailed builder: per-step timing, conditions, recipients, one-offs.
function buildBuilderCard_(threadId) {
  threadId = canonicalThreadId_(threadId);
  const ctx = getThreadContext_(threadId);
  const header = CardService.newCardHeader()
    .setTitle('Custom follow-up')
    .setImageUrl(ICON_URL_)
    .setImageStyle(CardService.ImageStyle.CIRCLE);
  if (ctx) header.setSubtitle(ctx.subject || '(no subject)');
  const card = CardService.newCardBuilder().setHeader(header);

  const draft = getDraft_(threadId);

  // Campaign-level settings.
  const settings = CardService.newCardSection();
  settings.addWidget(CardService.newTextParagraph().setText(
    '<font color="#5f6368">Each email waits the chosen time after the previous one ' +
    'sends. Stops automatically if they reply.</font>'
  ));
  settings.addWidget(buildTimezoneDropdown_('campaignTz'));
  const autoName = (function () {
    try { return autoGenerateCampaignName_(GmailApp.getThreadById(threadId)); }
    catch (err) { return ''; }
  })();
  settings.addWidget(
    CardService.newTextInput()
      .setFieldName('campaignName')
      .setTitle('Campaign name (optional)')
      .setHint(autoName ? 'Blank = "' + autoName + '"' : 'Shown on the Campaigns dashboard.')
      .setValue(draft.campaignName || '')
  );
  card.addSection(settings);

  const recip = CardService.newCardSection()
    .setHeader('Recipients')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  recip.addWidget(
    CardService.newTextInput()
      .setFieldName('recipients')
      .setTitle('Send to (optional)')
      .setHint('Blank = auto-detect from the thread. Comma-separated, "Name <email>" ok.')
      .setValue(draft.recipients || '')
  );
  recip.addWidget(
    CardService.newTextInput()
      .setFieldName('cc')
      .setTitle('Cc (every email)')
      .setHint('Added to the thread\'s recipients, not replacing them.')
      .setValue(draft.cc || '')
  );
  recip.addWidget(
    CardService.newTextInput()
      .setFieldName('bcc')
      .setTitle('Bcc (every email)')
      .setValue(draft.bcc || '')
  );
  card.addSection(recip);

  draft.steps.forEach(function (step, idx) {
    card.addSection(buildStepSection_(idx, step, {
      total: draft.steps.length,
      firstLabel: 'Wait this long from now',
      exactDate: true,
      removeAction: CardService.newAction()
        .setFunctionName('actionRemoveDraftStep')
        .setParameters({ threadId: threadId, index: String(idx) })
    }));
  });

  const actions = CardService.newCardSection();
  const builderButtons = CardService.newButtonSet();
  if (draft.steps.length < MAX_CAMPAIGN_STEPS) {
    builderButtons.addButton(
      CardService.newTextButton()
        .setText('+ Add follow-up')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionAddDraftStep')
            .setParameters({ threadId: threadId })
        )
    );
  }
  builderButtons.addButton(
    CardService.newTextButton()
      .setText('Clear')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('actionClearDraft')
          .setParameters({ threadId: threadId })
      )
  );
  actions.addWidget(builderButtons);
  card.addSection(actions);

  // Sequences: load into the builder, or save the builder as a new one.
  const sequences = listSequences_();
  const seqSection = CardService.newCardSection()
    .setHeader('Sequences')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  if (sequences.length > 0) {
    const seqDd = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('sequenceName')
      .setTitle('Saved sequences')
      .addItem('— select —', '', true);
    sequences.forEach(function (n) { seqDd.addItem(n, n, false); });
    seqSection.addWidget(seqDd);
    seqSection.addWidget(
      CardService.newButtonSet()
        .addButton(
          CardService.newTextButton()
            .setText('Load into builder')
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('actionLoadSequence')
                .setParameters({ threadId: threadId })
            )
        )
        .addButton(
          CardService.newTextButton()
            .setText('Delete')
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('actionDeleteSequence')
                .setParameters({ threadId: threadId })
            )
        )
    );
    seqSection.addWidget(CardService.newDivider());
  }
  seqSection.addWidget(
    CardService.newTextInput()
      .setFieldName('newSequenceName')
      .setTitle('Save these follow-ups as a sequence')
      .setHint('Name it, then Save. Reuse it with one click on any thread.')
  );
  seqSection.addWidget(
    CardService.newTextButton()
      .setText('Save as sequence')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('actionSaveSequence')
          .setParameters({ threadId: threadId })
      )
  );
  card.addSection(seqSection);

  // One-off at an exact time.
  const oneOff = CardService.newCardSection()
    .setHeader('One email at an exact time')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  const prefillTz = getPreferredTz_();
  const tomorrowStr = Utilities.formatDate(new Date(Date.now() + 86400000), prefillTz, 'yyyy-MM-dd');
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
      .setFieldName('oneOffMessage')
      .setTitle('Message (optional)')
      .setMultiline(true)
      .setHint('Blank = default bump. Placeholders: {firstName}, {senderFirstName}')
  );
  oneOff.addWidget(
    CardService.newTextInput()
      .setFieldName('oneOffRecipients')
      .setTitle('Send to (optional)')
      .setHint('Blank = auto-detect from the thread.')
  );
  oneOff.addWidget(CardService.newTextInput().setFieldName('oneOffCc').setTitle('Cc (optional)'));
  oneOff.addWidget(CardService.newTextInput().setFieldName('oneOffBcc').setTitle('Bcc (optional)'));
  oneOff.addWidget(
    CardService.newTextButton()
      .setText('Schedule this email')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('actionScheduleOneOff')
          .setParameters({ threadId: threadId })
      )
  );
  card.addSection(oneOff);

  // Default-message presets.
  const presets = CardService.newCardSection()
    .setHeader('Quick presets (default message)')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  const presetButtons = CardService.newButtonSet();
  ['3-7-14', '1-3-7', '2-5-10'].forEach(function (p) {
    presetButtons.addButton(
      CardService.newTextButton()
        .setText(p + ' days')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionInsertSequence')
            .setParameters({ threadId: threadId, preset: p })
        )
    );
  });
  presets.addWidget(presetButtons);
  card.addSection(presets);

  card.setFixedFooter(
    CardService.newFixedFooter().setPrimaryButton(
      CardService.newTextButton()
        .setText('Save & schedule')
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionSaveCampaign')
            .setParameters({ threadId: threadId })
        )
    )
  );

  return card.build();
}

// One follow-up's editor: timing + message up front, the rest collapsed.
// Field names match readFormDraft_. Shared by the thread builder and the
// sequence editor. opts: { total, firstLabel, exactDate, removeAction }
function buildStepSection_(idx, step, opts) {
  const sec = CardService.newCardSection()
    .setHeader('Follow-up ' + (idx + 1))
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(4);
  sec.addWidget(CardService.newTextParagraph().setText(
    '<font color="#5f6368">' +
    (idx === 0 ? opts.firstLabel : 'Wait this long after follow-up ' + idx) +
    '</font>'
  ));
  sec.addWidget(
    CardService.newTextInput()
      .setFieldName('amount_' + idx)
      .setTitle('Wait')
      .setValue(String(step.amount || 3))
  );
  sec.addWidget(
    CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('unit_' + idx)
      .setTitle('Unit')
      .addItem('days', 'days', step.unit !== 'hours' && step.unit !== 'minutes')
      .addItem('hours', 'hours', step.unit === 'hours')
      .addItem('minutes', 'minutes', step.unit === 'minutes')
  );
  sec.addWidget(
    CardService.newTextInput()
      .setFieldName('message_' + idx)
      .setTitle('Message')
      .setMultiline(true)
      .setValue(step.message || '\n\n')
      .setHint('Blank = default bump. Placeholders: {firstName}, {senderFirstName}')
  );
  // Below the fold.
  sec.addWidget(buildConditionDropdown_('condition_' + idx, step.condition));
  buildAtTimeFields_('atTime_' + idx, step.atTime).forEach(function (w) { sec.addWidget(w); });
  if (opts.exactDate) {
    const absPicker = CardService.newDateTimePicker()
      .setFieldName('sendAtAbs_' + idx)
      .setTitle('Or on an exact date/time (overrides wait)');
    if (step.sendAtAbs) absPicker.setValueInMsSinceEpoch(step.sendAtAbs);
    sec.addWidget(absPicker);
  }
  sec.addWidget(
    CardService.newTextInput()
      .setFieldName('cc_' + idx)
      .setTitle('Cc — this email only')
      .setValue(step.cc || '')
  );
  sec.addWidget(
    CardService.newTextInput()
      .setFieldName('bcc_' + idx)
      .setTitle('Bcc — this email only')
      .setValue(step.bcc || '')
  );
  if (opts.total > 1) {
    sec.addWidget(
      CardService.newTextButton()
        .setText('Remove follow-up ' + (idx + 1))
        .setOnClickAction(opts.removeAction)
    );
  }
  return sec;
}

function formatLocal_(ms, tz) {
  const zone = tz || getPreferredTz_();
  return Utilities.formatDate(new Date(ms), zone, 'MMM d, h:mm a z');
}

// Parse "HH:MM" or "H:MM" (24h). Returns { h, m } or null.
function parseHHMM_(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return { h: h, m: mn };
}

// Read a SelectionInput (DROPDOWN/RADIO/etc.) field as string. Tries commonEventObject first.
function readSelectionInput_(e, fieldName) {
  try {
    const ce = e && e.commonEventObject;
    if (ce && ce.formInputs && ce.formInputs[fieldName]) {
      const si = ce.formInputs[fieldName].stringInputs;
      if (si && si.value && si.value.length > 0) {
        return String(si.value[0] || '').trim();
      }
    }
  } catch (err) {}
  try {
    const v = e && e.formInput && e.formInput[fieldName];
    if (v) return String(v).trim();
  } catch (err) {}
  return '';
}

// Take the wall-clock date of targetMs in tz, replace the time with hhmm in tz.
// If the resulting moment is earlier than targetMs, roll forward by one day.
function snapToTimeOfDay_(targetMs, hhmm, tz) {
  const dateStr = Utilities.formatDate(new Date(targetMs), tz, 'yyyy-MM-dd');
  const timeStr = ('0' + hhmm.h).slice(-2) + ':' + ('0' + hhmm.m).slice(-2);
  let snapped = Utilities.parseDate(dateStr + ' ' + timeStr, tz, 'yyyy-MM-dd HH:mm').getTime();
  if (snapped < targetMs) snapped += 24 * 60 * 60 * 1000;
  return snapped;
}

// Compute a single step's send time given the previous step's send time (or "now" for step 1).
//   - No atTime: exact offset (amount * unit) after prevMs.
//   - With atTime: apply the offset first, then snap to that wall-clock time on
//     the resulting date (rolling to the next day if that moment already passed).
function computeStepSendAt_(prevMs, amount, unit, atTime, tz) {
  let mult;
  if (unit === 'minutes') mult = 60 * 1000;
  else if (unit === 'hours') mult = 60 * 60 * 1000;
  else mult = 24 * 60 * 60 * 1000;
  const baseMs = prevMs + amount * mult;
  const hhmm = parseHHMM_(atTime);
  if (!hhmm) return baseMs;
  return snapToTimeOfDay_(baseMs, hhmm, tz);
}


// ───────── Campaign drafts & templates ─────────────────────────────

const DRAFT_PREFIX = 'draft_';
const TEMPLATE_PREFIX = 'template_';
const MAX_CAMPAIGN_STEPS = 10;

function defaultDraft_() {
  return {
    steps: [{ amount: 3, unit: 'days', atTime: '', sendAtAbs: 0, condition: 'no_reply', message: '', cc: '', bcc: '' }],
    recipients: '', cc: '', bcc: '', campaignName: ''
  };
}

function getDraft_(threadId) {
  const raw = PropertiesService.getUserProperties().getProperty(DRAFT_PREFIX + threadId);
  if (!raw) return defaultDraft_();
  try {
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return defaultDraft_();
    if (typeof d.recipients !== 'string') d.recipients = '';
    if (typeof d.cc !== 'string') d.cc = '';
    if (typeof d.bcc !== 'string') d.bcc = '';
    if (typeof d.campaignName !== 'string') d.campaignName = '';
    d.steps.forEach(function (s) {
      if (typeof s.cc !== 'string') s.cc = '';
      if (typeof s.bcc !== 'string') s.bcc = '';
      if (typeof s.atTime !== 'string') s.atTime = '';
      if (typeof s.condition !== 'string') s.condition = 'no_reply';
      if (typeof s.sendAtAbs !== 'number') s.sendAtAbs = 0;
    });
    return d;
  } catch (e) { return defaultDraft_(); }
}

function setDraft_(threadId, draft) {
  PropertiesService.getUserProperties().setProperty(DRAFT_PREFIX + threadId, JSON.stringify(draft));
}

function clearDraft_(threadId) {
  PropertiesService.getUserProperties().deleteProperty(DRAFT_PREFIX + threadId);
}

// Reads form inputs (amount_i, unit_i, message_i, cc_i, bcc_i) into a draft
// structure of the same length as the existing draft. Used by every action
// handler so user edits aren't lost when the card re-renders.
function readFormDraft_(e, currentDraft) {
  const f = e.formInput || {};
  const count = currentDraft.steps.length;
  const steps = [];
  for (let i = 0; i < count; i++) {
    const amount = parseInt(f['amount_' + i] || '0', 10);
    const condition = readSelectionInput_(e, 'condition_' + i) ||
      (currentDraft.steps[i] && currentDraft.steps[i].condition) || 'no_reply';
    const absMs = getDateTimeInput_(e, 'sendAtAbs_' + i);
    steps.push({
      amount: isNaN(amount) ? 0 : amount,
      unit: (f['unit_' + i] || 'days').toLowerCase(),
      atTime: resolveAtTime_(e, 'atTime_' + i),
      sendAtAbs: (absMs && absMs > 0) ? Number(absMs) : 0,
      condition: condition,
      message: (f['message_' + i] || '').trim(),
      cc: (f['cc_' + i] || '').trim(),
      bcc: (f['bcc_' + i] || '').trim()
    });
  }
  return {
    steps: steps,
    recipients: (f.recipients || '').trim(),
    cc: (f.cc || '').trim(),
    bcc: (f.bcc || '').trim(),
    campaignName: (f.campaignName || '').trim()
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

function deleteTemplate_(name) {
  PropertiesService.getUserProperties().deleteProperty(TEMPLATE_PREFIX + name);
}

// Templates (steps only) and sequences (steps + recipients) used to be two
// separate lists. They're one concept now: move each template into the
// sequence list, keeping both if the names collide. The template key is only
// removed after its sequence copy is written.
function migrateTemplatesToSequences_() {
  const props = PropertiesService.getUserProperties();
  listTemplates_().forEach(function (name) {
    const tpl = getTemplate_(name);
    if (!tpl || !Array.isArray(tpl.steps)) return; // leave unreadable data alone
    let target = name;
    for (let n = 1; props.getProperty(SEQUENCE_PREFIX + target); n++) {
      target = name + (n === 1 ? ' (template)' : ' (template ' + n + ')');
    }
    props.setProperty(SEQUENCE_PREFIX + target, JSON.stringify({
      steps: tpl.steps, recipients: '', cc: '', bcc: ''
    }));
    deleteTemplate_(name);
  });
}

// Coerce a stored/submitted sequence step into the draft-step shape.
function normalizeSeqStep_(s) {
  s = s || {};
  const amount = parseInt(s.amount, 10);
  const unit = ['days', 'hours', 'minutes'].indexOf(s.unit) !== -1 ? s.unit : 'days';
  const atTime = (typeof s.atTime === 'string' && parseHHMM_(s.atTime)) ? s.atTime : '';
  const condition = STEP_CONDITIONS.some(function (c) { return c.value === s.condition; })
    ? s.condition : 'no_reply';
  return {
    amount: amount > 0 ? amount : 3,
    unit: unit,
    atTime: atTime,
    sendAtAbs: 0,
    condition: condition,
    message: String(s.message || ''),
    cc: String(s.cc || ''),
    bcc: String(s.bcc || '')
  };
}

const SEQUENCE_PREFIX = 'seq_';

function listSequences_() {
  migrateTemplatesToSequences_();
  return PropertiesService.getUserProperties().getKeys()
    .filter(function (k) { return k.indexOf(SEQUENCE_PREFIX) === 0; })
    .map(function (k) { return k.substring(SEQUENCE_PREFIX.length); })
    .sort();
}

function getSequence_(name) {
  const raw = PropertiesService.getUserProperties().getProperty(SEQUENCE_PREFIX + name);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setSequence_(name, bundle) {
  PropertiesService.getUserProperties().setProperty(
    SEQUENCE_PREFIX + name,
    JSON.stringify(bundle)
  );
}

function deleteSequence_(name) {
  PropertiesService.getUserProperties().deleteProperty(SEQUENCE_PREFIX + name);
}


// ───────── Campaign action handlers ────────────────────────────────

function actionAddDraftStep(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  if (draft.steps.length >= MAX_CAMPAIGN_STEPS) {
    return notify_('Max ' + MAX_CAMPAIGN_STEPS + ' steps.');
  }
  draft.steps.push({ amount: 3, unit: 'days', atTime: '', sendAtAbs: 0, condition: 'no_reply', message: '', cc: '', bcc: '' });
  setDraft_(threadId, draft);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
    .build();
}

function actionRemoveDraftStep(e) {
  const threadId = e.parameters.threadId;
  const idx = parseInt(e.parameters.index, 10);
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  if (isNaN(idx) || idx < 0 || idx >= draft.steps.length) return notify_('Step not found.');
  draft.steps.splice(idx, 1);
  if (draft.steps.length === 0) {
    draft.steps.push({ amount: 3, unit: 'days', atTime: '', sendAtAbs: 0, condition: 'no_reply', message: '', cc: '', bcc: '' });
  }
  setDraft_(threadId, draft);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
    .build();
}

function actionClearDraft(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  clearDraft_(threadId);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Draft cleared.'))
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
    .build();
}

function actionSaveCampaign(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const draft = readFormDraft_(e, getDraft_(threadId));

  const formTz = ((e.formInput && e.formInput.campaignTz) || '').trim();
  const tz = formTz || getPreferredTz_();
  if (formTz) setPreferredTz_(formTz);

  // Validate: each step either has an absolute date in the future, or a positive
  // wait amount with a parseable optional atTime.
  for (let i = 0; i < draft.steps.length; i++) {
    const s = draft.steps[i];
    if (s.sendAtAbs && s.sendAtAbs > 0) {
      const wall = Utilities.formatDate(new Date(s.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
      const ms = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
      if (ms <= Date.now()) {
        // Drop the stale picker value from the persisted draft — the picker has
        // no "clear" affordance, so leaving it would block every future save.
        s.sendAtAbs = 0;
        setDraft_(threadId, draft);
        return CardService.newActionResponseBuilder()
          .setNotification(CardService.newNotification().setText(
            'Step ' + (i + 1) + ': specific date/time must be in the future.'
          ))
          .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
          .build();
      }
      continue;
    }
    if (!s.amount || s.amount <= 0) {
      // Persist current edits before returning so user doesn't lose them.
      setDraft_(threadId, draft);
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(
          'Step ' + (i + 1) + ': enter a wait amount greater than 0, or pick a specific date/time.'
        ))
        .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
        .build();
    }
    if (s.atTime && !parseHHMM_(s.atTime)) {
      setDraft_(threadId, draft);
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(
          'Step ' + (i + 1) + ': "At time" must be HH:MM (e.g. 09:00).'
        ))
        .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
        .build();
    }
  }

  const armed = armThreadWithSteps_(threadId, draft.steps, {
    tz: tz,
    campaignName: draft.campaignName,
    recipients: draft.recipients,
    cc: draft.cc,
    bcc: draft.bcc
  });
  const newSteps = armed.steps;
  const campaignName = armed.campaignName;

  clearDraft_(threadId);

  // A saved campaign is worthless without a scheduler to fire it. Say so in the
  // confirmation rather than reporting success for something that won't send.
  const scheduler = ensureSchedulerQuiet_();

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      scheduler.ok
        ? (campaignName ? '"' + campaignName + '" — ' : '') +
          'saved ' + newSteps.length + '-step campaign. Last step fires ' +
          formatLocal_(newSteps[newSteps.length - 1].sendAt, tz)
        : 'Saved, but the scheduler is NOT running — nothing will send. ' +
          'Open the Campaigns dashboard and tap "Fix scheduler".'
    ))
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildCard_(threadId)))
    .build();
}

// Schedule a list of draft-shaped steps ({amount, unit, atTime, sendAtAbs,
// condition, message, cc, bcc}) on a thread: computes each send time relative
// to the previous step, appends to anything already queued, and tags FU/Custom.
// Shared by the sidebar builder, one-click sequence start, and the Studio.
// opts: { tz, campaignName, recipients, cc, bcc, anchorMs }
function armThreadWithSteps_(threadId, steps, opts) {
  opts = opts || {};
  const tz = opts.tz || getPreferredTz_();
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('Thread not found: ' + threadId);

  // Campaign name: explicit > auto-derived from a Gmail label > none.
  let campaignName = (opts.campaignName || '').trim();
  if (!campaignName) campaignName = autoGenerateCampaignName_(thread);

  // atTime (if set) is authoritative wall-clock; unit just controls the date
  // floor relative to the previous step.
  const now = Date.now();
  const recipientsField = (opts.recipients || '').trim();
  const campaignCc = (opts.cc || '').trim();
  const campaignBcc = (opts.bcc || '').trim();
  let prevMs = opts.anchorMs || now;
  const newSteps = steps.map(function (s) {
    let sendAt;
    if (s.sendAtAbs && s.sendAtAbs > 0) {
      // Re-anchor the picker's UTC wall-clock to the campaign tz, same as one-offs.
      const wall = Utilities.formatDate(new Date(s.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
      sendAt = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    } else {
      sendAt = computeStepSendAt_(prevMs, s.amount, s.unit, s.atTime, tz);
    }
    prevMs = sendAt;
    const stepCc = mergeRecipients_(campaignCc, s.cc || '');
    const stepBcc = mergeRecipients_(campaignBcc, s.bcc || '');
    const obj = {
      sendAt: sendAt,
      message: s.message,
      tz: tz,
      createdAt: now,
      condition: s.condition || 'no_reply'
    };
    if (recipientsField) obj.to = recipientsField;
    if (stepCc) obj.cc = stepCc;
    if (stepBcc) obj.bcc = stepBcc;
    return obj;
  });

  // Append to existing scheduled queue (one-offs and prior campaigns coexist).
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  const existing = { steps: [] };
  const raw = props.getProperty(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.steps)) existing.steps = parsed.steps;
      else if (parsed && parsed.sendAt) {
        existing.steps = [{ sendAt: parsed.sendAt, message: parsed.message || '' }];
      }
      if (parsed && parsed.campaignName && !campaignName) {
        campaignName = parsed.campaignName;
      }
    } catch (e2) {}
  }
  existing.steps = existing.steps.concat(newSteps);
  existing.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  if (campaignName) existing.campaignName = campaignName;
  props.setProperty(key, JSON.stringify(existing));

  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  return { steps: newSteps, campaignName: campaignName, tz: tz };
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
  const oneOffBcc = (f.oneOffBcc || '').trim();

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
  if (oneOffBcc) stepObj.bcc = oneOffBcc;
  data.steps.push(stepObj);
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  props.setProperty(key, JSON.stringify(data));

  const thread = GmailApp.getThreadById(threadId);
  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  const scheduler = ensureSchedulerQuiet_();

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      scheduler.ok
        ? 'Added one-off — fires ' + formatLocal_(sendAt, tz)
        : 'Saved, but the scheduler is NOT running — nothing will send. ' +
          'Open the Campaigns dashboard and tap "Fix scheduler".'
    ))
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildCard_(threadId)))
    .build();
}

function actionSaveSequence(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};
  const name = (f.newSequenceName || '').trim();
  if (!name) return notify_('Enter a sequence name first.');
  const draft = readFormDraft_(e, getDraft_(threadId));
  for (let i = 0; i < draft.steps.length; i++) {
    if (!draft.steps[i].amount || draft.steps[i].amount <= 0) {
      setDraft_(threadId, draft);
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(
          'Step ' + (i + 1) + ': set a wait > 0 before saving.'
        ))
        .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
        .build();
    }
  }
  setSequence_(name, {
    steps: draft.steps,
    recipients: draft.recipients || '',
    cc: draft.cc || '',
    bcc: draft.bcc || ''
  });
  setDraft_(threadId, draft);
  Logger.log('actionSaveSequence: saved "' + name + '" (' + draft.steps.length +
             ' step(s), recipients="' + (draft.recipients || '') + '"). ' +
             'All sequences: ' + JSON.stringify(listSequences_()));
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Saved sequence "' + name + '" (' + draft.steps.length + ' step(s)' +
      (draft.recipients ? ', recipients included' : '') + ').'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
    .build();
}

function actionLoadSequence(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const name = readSelectionInput_(e, 'sequenceName');
  Logger.log('actionLoadSequence: name="' + name + '"');
  if (!name) return notify_('Pick a sequence first.');
  const seq = getSequence_(name);
  if (!seq || !Array.isArray(seq.steps) || seq.steps.length === 0) {
    return notify_('Sequence "' + name + '" not found or empty.');
  }
  const cleanSteps = seq.steps.slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
  const existingDraft = getDraft_(threadId);
  setDraft_(threadId, {
    steps: cleanSteps,
    recipients: seq.recipients || '',
    cc: seq.cc || '',
    bcc: seq.bcc || '',
    campaignName: existingDraft.campaignName || ''
  });
  Logger.log('actionLoadSequence: applied ' + cleanSteps.length + ' step(s), recipients="' + (seq.recipients || '') + '"');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Applied "' + name + '" (' + cleanSteps.length + ' step(s)' +
      (seq.recipients ? ', recipients filled' : '') + '). Review and Save campaign.'
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
    .build();
}

function actionDeleteSequence(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const name = readSelectionInput_(e, 'sequenceName');
  if (!name) return notify_('Pick a sequence first.');
  deleteSequence_(name);
  Logger.log('actionDeleteSequence: deleted "' + name + '"');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Deleted sequence "' + name + '".'))
    .setNavigation(CardService.newNavigation().updateCard(buildBuilderCard_(threadId)))
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
  try {
    const scriptTz = Session.getScriptTimeZone();
    if (scriptTz) return scriptTz;
  } catch (err) {}
  return DEFAULT_TZ;
}

function setPreferredTz_(tz) {
  if (!tz) return;
  try { PropertiesService.getUserProperties().setProperty(TZ_PREF_KEY, tz); } catch (err) {}
}

function buildTimezoneDropdown_(fieldName) {
  const preferred = getPreferredTz_();
  const input = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName(fieldName || 'tz')
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

// ───────── At-time dropdown ────────────────────────────────────────
//
// Hourly options spanning the day. Dropdown instead of free typing so users can
// click a value (previously a wall-clock text entry that was easy to mistype).
// Half-hour granularity is enough for cadence work; fold to "no specific time"
// for the default (exact offset from previous step).

const AT_TIME_OPTIONS = [
  { label: 'No specific time', value: '' },
  { label: '12:00 AM', value: '00:00' },
  { label: '1:00 AM',  value: '01:00' },
  { label: '2:00 AM',  value: '02:00' },
  { label: '3:00 AM',  value: '03:00' },
  { label: '4:00 AM',  value: '04:00' },
  { label: '5:00 AM',  value: '05:00' },
  { label: '6:00 AM',  value: '06:00' },
  { label: '7:00 AM',  value: '07:00' },
  { label: '8:00 AM',  value: '08:00' },
  { label: '9:00 AM',  value: '09:00' },
  { label: '9:30 AM',  value: '09:30' },
  { label: '10:00 AM', value: '10:00' },
  { label: '10:30 AM', value: '10:30' },
  { label: '11:00 AM', value: '11:00' },
  { label: '11:30 AM', value: '11:30' },
  { label: '12:00 PM', value: '12:00' },
  { label: '12:30 PM', value: '12:30' },
  { label: '1:00 PM',  value: '13:00' },
  { label: '1:30 PM',  value: '13:30' },
  { label: '2:00 PM',  value: '14:00' },
  { label: '2:30 PM',  value: '14:30' },
  { label: '3:00 PM',  value: '15:00' },
  { label: '3:30 PM',  value: '15:30' },
  { label: '4:00 PM',  value: '16:00' },
  { label: '4:30 PM',  value: '16:30' },
  { label: '5:00 PM',  value: '17:00' },
  { label: '5:30 PM',  value: '17:30' },
  { label: '6:00 PM',  value: '18:00' },
  { label: '7:00 PM',  value: '19:00' },
  { label: '8:00 PM',  value: '20:00' },
  { label: '9:00 PM',  value: '21:00' },
  { label: '10:00 PM', value: '22:00' },
  { label: '11:00 PM', value: '23:00' }
];

// Single dropdown for the "At time" control. CardService doesn't allow custom
// HTML or expose a TIME_ONLY picker in this runtime, so a plain SelectionInput
// is the cleanest UX available. Read back via resolveAtTime_.
function buildAtTimeFields_(fieldName, currentValue) {
  const cur = (currentValue || '').trim();
  const input = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName(fieldName)
    .setTitle('At time (optional)');
  let matched = false;
  AT_TIME_OPTIONS.forEach(function (opt) {
    const isSel = opt.value === cur;
    if (isSel) matched = true;
    input.addItem(opt.label, opt.value, isSel);
  });
  if (!matched && cur && parseHHMM_(cur)) input.addItem(cur, cur, true);
  return [input];
}

function resolveAtTime_(e, fieldName) {
  return readSelectionInput_(e, fieldName);
}


// ───────── Per-step send conditions ────────────────────────────────
//
// Each step carries a condition that decides whether the step actually sends
// when its sendAt fires. 'no_reply' preserves the original behavior (cancel
// the whole campaign if the recipient has replied). 'replied' inverts that.
// Open/click conditions are listed so the UI matches the user's mental model,
// but we don't ship open/click tracking yet — they fall back to always-send.

const STEP_CONDITIONS = [
  { label: 'If no reply (default)', value: 'no_reply' },
  { label: 'If replied',            value: 'replied'  },
  { label: 'No matter what',        value: 'always'   }
];

// How long a due "If replied" step waits for a reply before being dropped.
const REPLIED_WAIT_MAX_MS = 14 * 24 * 60 * 60 * 1000;

function buildConditionDropdown_(fieldName, currentValue) {
  const input = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName(fieldName)
    .setTitle('Send this step');
  const cur = currentValue || 'no_reply';
  STEP_CONDITIONS.forEach(function (opt) {
    input.addItem(opt.label, opt.value, opt.value === cur);
  });
  return input;
}

// Decide what to do for a step given its condition and the current reply state.
// Returns one of: 'send', 'defer', 'cancel'.
//   - send:   send the step now
//   - defer:  hold the step (keep waiting for a reply) without blocking later steps
//   - cancel: drop the whole campaign on this thread
function evaluateStepCondition_(condition, hasReply) {
  switch (condition) {
    case 'replied':
      return hasReply ? 'send' : 'defer';
    case 'always':
      return 'send';
    case 'no_reply':
    default:
      return hasReply ? 'cancel' : 'send';
  }
}

// True if a reply has arrived that should count against this step.
// Explicit-recipient mode: any message from a listed recipient after the
// step was scheduled. Thread mode: any non-self message after my last outbound.
function stepHasReply_(messages, step, myEmails, myLastIdx) {
  if (step && step.to) {
    const targets = parseAddressList_(step.to)
      .map(function (a) { return a.email.toLowerCase(); })
      .filter(function (e) { return e.length > 0; });
    const sinceMs = step.createdAt || 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.getDate().getTime() <= sinceMs) continue;
      const fromEmail = parseAddress_(m.getFrom()).email.toLowerCase();
      if (fromEmail && targets.indexOf(fromEmail) !== -1) return true;
    }
    return false;
  }
  if (myLastIdx === -1) return false;
  for (let i = myLastIdx + 1; i < messages.length; i++) {
    if (!isFromMe_(messages[i], myEmails)) return true;
  }
  return false;
}


// ───────── Campaign auto-naming from Gmail labels ──────────────────

// First user label on a thread that isn't one of ours (FU/*) and isn't a
// built-in system label. Used to auto-name a campaign after the topic label
// the user already organizes inboxes by.
function getThreadCampaignLabel_(thread) {
  if (!thread) return '';
  let labels = [];
  try { labels = thread.getLabels(); } catch (e) { return ''; }
  for (let i = 0; i < labels.length; i++) {
    const name = labels[i].getName();
    if (!name) continue;
    if (name.indexOf(CONFIG.labelPrefix + '/') === 0) continue;
    return name;
  }
  return '';
}

// Next sequential number for a "<Label> Active Campaign N" name, scanning
// every stored campaign across the user's properties.
function nextCampaignNumberForLabel_(labelName) {
  const props = PropertiesService.getUserProperties();
  const keys = props.getKeys().filter(function (k) { return k.indexOf('custom_') === 0; });
  const prefix = labelName + ' Active Campaign ';
  let max = 0;
  keys.forEach(function (k) {
    const raw = props.getProperty(k);
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.campaignName) return;
    if (data.campaignName.indexOf(prefix) !== 0) return;
    const tail = data.campaignName.substring(prefix.length).trim();
    const n = parseInt(tail, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return max + 1;
}

function autoGenerateCampaignName_(thread) {
  const label = getThreadCampaignLabel_(thread);
  if (!label) return '';
  return label + ' Active Campaign ' + nextCampaignNumberForLabel_(label);
}


// ───────── Signature ──────────────────────────────────────────────
//
// Single global signature appended to every follow-up the tool sends.
// Stored per-user via UserProperties so each Google account has its own.

const SIGNATURE_KEY = 'signature';

function getSignature_() {
  try {
    return PropertiesService.getUserProperties().getProperty(SIGNATURE_KEY) || '';
  } catch (e) { return ''; }
}

function setSignature_(text) {
  const props = PropertiesService.getUserProperties();
  if (text) props.setProperty(SIGNATURE_KEY, text);
  else props.deleteProperty(SIGNATURE_KEY);
}

// Append the saved signature to a message body, separated by a blank line.
// Idempotent-ish: if the body already ends with the exact signature, no double-append.
function applySignatureToBody_(body) {
  const sig = getSignature_();
  if (!sig) return body || '';
  const trimmed = (body || '').replace(/\s+$/, '');
  if (trimmed.length >= sig.length && trimmed.slice(-sig.length) === sig) return trimmed;
  return (trimmed ? trimmed + '\n\n' : '') + sig;
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
  const err = removeQueuedStep_(threadId, index);
  if (err) return notify_(err);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Removed.'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
}

// Drop one queued step (index into the time-sorted queue). Clears the label
// when nothing is left. Returns an error message, or '' on success.
function removeQueuedStep_(threadId, index) {
  const props = PropertiesService.getUserProperties();
  const key = 'custom_' + threadId;
  const raw = props.getProperty(key);
  if (!raw) return 'Nothing scheduled.';
  let data;
  try { data = JSON.parse(raw); } catch (err) { return 'Could not read schedule.'; }
  if (data.sendAt && !data.steps) {
    data = { steps: [{ sendAt: data.sendAt, message: data.message || '' }] };
  }
  if (!data.steps) data.steps = [];
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  if (isNaN(index) || index < 0 || index >= data.steps.length) return 'Step not found.';
  data.steps.splice(index, 1);

  if (data.steps.length === 0) {
    props.deleteProperty(key);
    const thread = GmailApp.getThreadById(threadId);
    const customLabel = GmailApp.getUserLabelByName(CONFIG.labelPrefix + '/Custom');
    if (thread && customLabel) thread.removeLabel(customLabel);
  } else {
    props.setProperty(key, JSON.stringify(data));
  }
  return '';
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
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildCard_(threadId)))
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
    const myEmails = getMyEmails_();
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

  // 1. Identity of the account this execution belongs to.
  log.push('Running as: ' + (getRunningEmail_() || '(unknown)'));
  log.push('Owner account (CONFIG applies): ' + (isOwnerAccount_() ? 'yes' : 'no — using auto-detected identity'));
  log.push('From: header will be: ' + (resolveFromHeader_() || '(Gmail default)'));
  log.push('{senderFirstName} renders as: ' + getSenderFirstName_());
  log.push('Effective "me" addresses: ' + JSON.stringify(getMyEmails_()));

  // 2. Trigger.
  const triggers = schedulerTriggers_();
  if (triggers.length === 0) {
    log.push('✗ No processFollowUps trigger in THIS account — nothing will ever send.');
    const installErr = getSchedulerError_();
    if (installErr) log.push('  last auto-install attempt failed: ' + installErr.message);
    log.push('  Fix: open the add-on sidebar (it self-installs), or run setup() here.');
  } else {
    log.push('✓ ' + triggers.length + ' processFollowUps trigger(s), every ' +
      normalizeInterval_(CONFIG.triggerIntervalMinutes) + ' min.');
  }

  // 2b. Last run.
  const lastRun = getLastRunSummary_();
  if (!lastRun) {
    log.push('✗ No scheduler run has ever completed in this account.');
  } else {
    log.push('Last run: ' + Utilities.formatDate(new Date(lastRun.at), getPreferredTz_(), 'MMM d HH:mm z') +
      ' — sent ' + lastRun.sent + ', ' + ((lastRun.errors || []).length) + ' error(s).');
    (lastRun.errors || []).forEach(function (err) { log.push('  ! ' + err); });
  }

  // 3. FU/Custom label and tagged threads.
  const customLabel = GmailApp.getUserLabelByName(CONFIG.labelPrefix + '/Custom');
  if (!customLabel) {
    log.push('✗ FU/Custom label missing in this account.');
  } else {
    const threads = customLabel.getThreads();
    log.push('FU/Custom: ' + threads.length + ' thread(s) tagged.');
    const props = PropertiesService.getUserProperties();
    const myEmails = getMyEmails_();
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
