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
  Logger.log('processFollowUps build=advsvc-2 (cold recipients from first outbound + self-strip)');
  if (CONFIG.businessHoursOnly && !isBusinessHours_()) {
    Logger.log('Outside business hours — skipping run.');
    return;
  }

  const myEmails = CONFIG.senderEmails.map(function (e) { return e.toLowerCase(); });
  const cutoff = new Date(Date.now() - CONFIG.lookbackDays * 86400000);
  let sent = 0;

  for (const stageKey of Object.keys(CONFIG.stages)) {
    if (sent >= CONFIG.maxPerRun) {
      Logger.log('Hit maxPerRun (' + CONFIG.maxPerRun + ') — stopping.');
      break;
    }
    const stage = CONFIG.stages[stageKey];
    const labelName = CONFIG.labelPrefix + '/' + stageKey;
    const label = GmailApp.getUserLabelByName(labelName);
    if (!label) {
      Logger.log('Label "' + labelName + '" not found — run setup() first.');
      continue;
    }

    const threads = label.getThreads();
    Logger.log('Stage ' + stageKey + ': ' + threads.length + ' thread(s).');

    for (const thread of threads) {
      if (sent >= CONFIG.maxPerRun) break;
      try {
        if (processThread_(thread, label, stage, myEmails, cutoff)) sent++;
      } catch (e) {
        Logger.log('Error on thread ' + thread.getId() + ': ' + e);
      }
    }
  }

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

  let myLastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFromMe_(messages[i], myEmails)) { myLastIdx = i; break; }
  }
  if (myLastIdx === -1) {
    Logger.log('Custom: thread "' + thread.getFirstMessageSubject() +
      '" has NO outbound message from senderEmails ' + JSON.stringify(myEmails) +
      '. Senders found: ' + messages.map(function (m) { return m.getFrom(); }).join(' | ') +
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
  const myLast = messages[myLastIdx];
  let lastInbound = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isFromMe_(messages[i], myEmails)) { lastInbound = messages[i]; break; }
  }

  // Determine who to follow up with. Inbound reply = use that sender;
  // cold thread = use the original To: of my last sent message.
  let recipientEmail = '';
  let recipientName = '';
  if (lastInbound) {
    const p = parseAddress_(lastInbound.getFrom());
    recipientEmail = p.email;
    recipientName = p.name;
  } else {
    const toAddr = (myLast.getTo() || '').split(',')[0].trim();
    if (toAddr) {
      const p = parseAddress_(toAddr);
      recipientEmail = p.email;
      recipientName = p.name;
    }
  }
  if (!recipientEmail) {
    Logger.log('No recipient could be determined — clearing label.');
    thread.removeLabel(label);
    props.deleteProperty(key);
    return false;
  }

  const firstName = firstNameOf_(recipientName) || 'there';
  const firstStageKey = Object.keys(CONFIG.stages)[0];

  let sentAny = false;
  while (data.steps.length > 0 && data.steps[0].sendAt <= Date.now()) {
    const step = data.steps[0];
    const tmpl = step.message || CONFIG.stages[firstStageKey].template;
    const text = tmpl
      .replace(/\{firstName\}/g, firstName)
      .replace(/\{senderFirstName\}/g, CONFIG.senderFirstName);

    if (CONFIG.dryRun) {
      Logger.log('[DRY RUN custom] Would send to ' + recipientEmail + ':\n' + text);
      break;
    }

    const html = text.replace(/\n/g, '<br>');
    if (lastInbound) {
      const inboundFrom = parseAddress_(lastInbound.getFrom());
      sendThreadReply_(thread, {
        to: inboundFrom.email,
        body: text,
        html: html,
        replyToMessage: myLast
      });
    } else {
      const recipients = deriveColdRecipients_(messages, myEmails);
      if (!recipients.to) {
        Logger.log('Custom: could not derive non-self recipients for "' +
          thread.getFirstMessageSubject() + '" — clearing.');
        thread.removeLabel(label);
        props.deleteProperty(key);
        return sentAny;
      }
      sendThreadReply_(thread, {
        to: recipients.to,
        cc: recipients.cc,
        body: text,
        html: html,
        replyToMessage: myLast
      });
    }
    Logger.log('✓ Custom follow-up sent to ' + recipientEmail + ' (' + (data.steps.length - 1) + ' remaining).');
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


function processThread_(thread, currentLabel, stage, myEmails, cutoff) {
  const messages = thread.getMessages();
  if (messages.length === 0) return false;

  // Find my last sent message.
  let myLastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFromMe_(messages[i], myEmails)) { myLastIdx = i; break; }
  }
  if (myLastIdx === -1) {
    Logger.log('No outbound message in thread — clearing label.');
    thread.removeLabel(currentLabel);
    return false;
  }
  const myLast = messages[myLastIdx];

  // If a later message exists, prospect replied — stop following up.
  for (let i = myLastIdx + 1; i < messages.length; i++) {
    if (!isFromMe_(messages[i], myEmails)) {
      Logger.log('Prospect replied on "' + thread.getFirstMessageSubject() + '" — clearing label.');
      thread.removeLabel(currentLabel);
      return false;
    }
  }

  if (myLast.getDate() < cutoff) {
    Logger.log('Older than lookback window — clearing label.');
    thread.removeLabel(currentLabel);
    return false;
  }

  const daysSince = (Date.now() - myLast.getDate().getTime()) / 86400000;
  if (daysSince < stage.daysAfter) return false;

  // Find last inbound message (used for the reply target if it exists).
  let lastInbound = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isFromMe_(messages[i], myEmails)) { lastInbound = messages[i]; break; }
  }

  // Determine recipient: inbound sender if any, otherwise the original To: of my last sent.
  let recipientEmail = '';
  let recipientName = '';
  if (lastInbound) {
    const p = parseAddress_(lastInbound.getFrom());
    recipientEmail = p.email;
    recipientName = p.name;
  } else {
    const toAddr = (myLast.getTo() || '').split(',')[0].trim();
    if (toAddr) {
      const p = parseAddress_(toAddr);
      recipientEmail = p.email;
      recipientName = p.name;
    }
  }
  if (!recipientEmail) {
    Logger.log('No recipient could be determined — clearing label.');
    thread.removeLabel(currentLabel);
    return false;
  }

  const firstName = firstNameOf_(recipientName) || 'there';
  const text = stage.template
    .replace(/\{firstName\}/g, firstName)
    .replace(/\{senderFirstName\}/g, CONFIG.senderFirstName);
  const html = text.replace(/\n/g, '<br>');

  if (CONFIG.dryRun) {
    Logger.log('[DRY RUN] Would send to ' + recipientEmail + ':\n' + text);
    return false;
  }

  if (lastInbound) {
    const inboundFrom = parseAddress_(lastInbound.getFrom());
    sendThreadReply_(thread, {
      to: inboundFrom.email,
      body: text,
      html: html,
      replyToMessage: myLast
    });
  } else {
    const recipients = deriveColdRecipients_(messages, myEmails);
    if (!recipients.to) {
      Logger.log('Stage: could not derive non-self recipients for "' +
        thread.getFirstMessageSubject() + '" — clearing.');
      thread.removeLabel(currentLabel);
      return false;
    }
    sendThreadReply_(thread, {
      to: recipients.to,
      cc: recipients.cc,
      body: text,
      html: html,
      replyToMessage: myLast
    });
  }

  thread.removeLabel(currentLabel);
  if (stage.nextLabel) {
    thread.addLabel(getOrCreateLabel_(stage.nextLabel));
  }

  Logger.log('✓ Sent follow-up to ' + recipientEmail + ' (stage ' + stage.daysAfter + 'd).');
  return true;
}


// Send a reply on an existing Gmail thread using the Gmail Advanced Service.
// We bypass GmailMessage.reply() because it auto-CC's the original sender when
// replying to one of your own sent messages, producing "to me, Nabilla" output.
// Passing threadId to Gmail.Users.Messages.send threads the new message in
// Gmail's UI; In-Reply-To/References make every other mail client (and Gmail's
// own "in reply to" indicator) treat the new message as a reply to a specific
// prior message — chaining each follow-up off the previous one rather than off
// the original cold email.
//
// options: { to: string, cc?: string, body: string, html?: string,
//            subject?: string, replyToMessage?: GmailMessage }
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

  // Resolve the message we are replying to. Default to the latest message in
  // the thread so each follow-up chains off the prior one (which, given that
  // any prospect reply cancels the schedule, is always our previous outbound).
  let replyToMessage = options.replyToMessage || null;
  if (!replyToMessage) {
    const all = thread.getMessages();
    if (all.length > 0) replyToMessage = all[all.length - 1];
  }
  const chain = replyToMessage ? getReplyChainHeaders_(replyToMessage) : null;

  const boundary = '----=_omc_' + Math.random().toString(36).slice(2);
  let raw = '';
  raw += 'To: ' + to + '\r\n';
  if (cc) raw += 'Cc: ' + cc + '\r\n';
  raw += 'Subject: ' + encodeMimeSubject_(subject) + '\r\n';
  if (chain && chain.messageId) {
    raw += 'In-Reply-To: ' + chain.messageId + '\r\n';
    raw += 'References: ' + chain.references + '\r\n';
  }
  raw += 'MIME-Version: 1.0\r\n';
  raw += 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n';
  raw += '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/plain; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: 7bit\r\n';
  raw += '\r\n';
  raw += body + '\r\n';
  raw += '--' + boundary + '\r\n';
  raw += 'Content-Type: text/html; charset=UTF-8\r\n';
  raw += 'Content-Transfer-Encoding: 7bit\r\n';
  raw += '\r\n';
  raw += html + '\r\n';
  raw += '--' + boundary + '--';

  const encoded = Utilities.base64EncodeWebSafe(raw);
  return Gmail.Users.Messages.send({
    raw: encoded,
    threadId: thread.getId()
  }, 'me');
}


// Pull the RFC 822 Message-ID and References from a GmailMessage so the next
// outbound can quote them in In-Reply-To/References and continue the chain.
function getReplyChainHeaders_(message) {
  try {
    const meta = Gmail.Users.Messages.get('me', message.getId(), {
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'Message-Id', 'References']
    });
    const headers = (meta && meta.payload && meta.payload.headers) || [];
    let messageId = '';
    let references = '';
    for (let i = 0; i < headers.length; i++) {
      const name = (headers[i].name || '').toLowerCase();
      if (name === 'message-id' && !messageId) messageId = headers[i].value || '';
      else if (name === 'references' && !references) references = headers[i].value || '';
    }
    if (!messageId) return null;
    return {
      messageId: messageId,
      references: references ? (references + ' ' + messageId) : messageId
    };
  } catch (err) {
    Logger.log('getReplyChainHeaders_ failed: ' + err);
    return null;
  }
}

function encodeMimeSubject_(s) {
  if (!s) return '';
  // ASCII subjects pass through unchanged for readability.
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
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


// Run this ONCE after pasting the code. Creates labels + the hourly trigger.
function setup() {
  for (const k of Object.keys(CONFIG.stages)) {
    getOrCreateLabel_(CONFIG.labelPrefix + '/' + k);
    const next = CONFIG.stages[k].nextLabel;
    if (next) getOrCreateLabel_(next);
  }
  getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');

  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'processFollowUps') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('processFollowUps').timeBased().everyMinutes(1).create();

  Logger.log('Setup done. Trigger runs every 1 min. Use the Gmail sidebar (puzzle icon) to schedule, or apply FU/* labels manually.');
}


// ───────── Gmail Add-on UI ───────────────────────────────────────

function buildHomepage() { return buildCard_(null); }

function buildAddOn(e) {
  const threadId = e && e.gmail && e.gmail.threadId;
  return buildCard_(threadId);
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
        qSection.addWidget(
          CardService.newDecoratedText()
            .setTopLabel('Step ' + (idx + 1) + ' • ' + when)
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

  // Preset cadences (legacy 3d/7d/14d label-based).
  const presets = CardService.newCardSection()
    .setHeader('Tag with preset label')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  const presetButtons = CardService.newButtonSet();
  for (const k of Object.keys(CONFIG.stages)) {
    presetButtons.addButton(
      CardService.newTextButton()
        .setText('FU/' + k)
        .setOnClickAction(
          CardService.newAction()
            .setFunctionName('actionTagPreset')
            .setParameters({ threadId: threadId || '', stage: k })
        )
    );
  }
  presets.addWidget(presetButtons);
  card.addSection(presets);

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

function actionTagPreset(e) {
  const threadId = e.parameters.threadId;
  const stage = e.parameters.stage;
  if (!threadId) return notify_('Open a thread first.');
  const thread = GmailApp.getThreadById(threadId);
  // Clear any existing FU/* labels first
  clearFollowUpLabels_(thread);
  thread.addLabel(getOrCreateLabel_(CONFIG.labelPrefix + '/' + stage));
  return notify_('Tagged FU/' + stage + '.');
}

function actionScheduleCustom(e) {
  const threadId = e.parameters.threadId;
  if (!threadId) return notify_('Open a thread first.');
  const f = e.formInput || {};

  const tz = (f.tz || '').trim() || getPreferredTz_();
  setPreferredTz_(tz);
  const scheduleType = (f.scheduleType || 'relative').toLowerCase();

  let sendAt;
  if (scheduleType === 'absolute') {
    const pickerMs = getDateTimeInput_(e, 'sendAt');
    if (!pickerMs) return notify_('Pick a date and time.');
    // Gmail add-on DateTimePicker stores the user's chosen wall-clock as UTC components,
    // not as a true UTC moment. Extract those components in UTC, then reinterpret them
    // in the chosen timezone.
    const wall = Utilities.formatDate(new Date(pickerMs), 'UTC', 'yyyy-MM-dd HH:mm');
    sendAt = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    if (sendAt <= Date.now()) return notify_('Pick a future time.');
  } else {
    const amount = parseInt(f.amount || '0', 10) || 0;
    const unit = (f.unit || 'days').toLowerCase();
    if (amount <= 0) return notify_('Enter a number greater than 0.');

    let multiplier;
    if (unit === 'minutes') multiplier = 60 * 1000;
    else if (unit === 'hours') multiplier = 60 * 60 * 1000;
    else multiplier = 24 * 60 * 60 * 1000;

    sendAt = Date.now() + amount * multiplier;
  }

  const message = (f.message || '').trim();

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
  data.steps.push({ sendAt: sendAt, message: message, tz: tz });
  data.steps.sort(function (a, b) { return a.sendAt - b.sendAt; });
  props.setProperty(key, JSON.stringify(data));

  const thread = GmailApp.getThreadById(threadId);
  // Strip preset FU/* labels (3d/7d/14d) so they don't fight the custom queue,
  // but keep FU/Custom on the thread.
  clearOtherFollowUpLabels_(thread, CONFIG.labelPrefix + '/Custom');
  const customLabel = getOrCreateLabel_(CONFIG.labelPrefix + '/Custom');
  if (!hasLabel_(thread, customLabel.getName())) thread.addLabel(customLabel);

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(
      'Added step ' + data.steps.length + ' — fires ' + formatLocal_(sendAt, tz)
    ))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(threadId)))
    .build();
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
  return { steps: [{ amount: 3, unit: 'days', message: '' }] };
}

function getDraft_(threadId) {
  const raw = PropertiesService.getUserProperties().getProperty(DRAFT_PREFIX + threadId);
  if (!raw) return defaultDraft_();
  try {
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return defaultDraft_();
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
  return { steps: steps };
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
  let cumulative = 0;
  const newSteps = draft.steps.map(function (s) {
    let mult;
    if (s.unit === 'minutes') mult = 60 * 1000;
    else if (s.unit === 'hours') mult = 60 * 60 * 1000;
    else mult = 24 * 60 * 60 * 1000;
    cumulative += s.amount * mult;
    return { sendAt: now + cumulative, message: s.message, tz: tz };
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
  data.steps.push({ sendAt: sendAt, message: message, tz: tz });
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

  // Add each step at now + N days. Empty message = use stage 1 template.
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


// Manually queue a thread by ID or Gmail URL. Useful for testing.
//   manualSchedule('https://mail.google.com/mail/u/0/#inbox/THREAD_ID', '3d')
function manualSchedule(threadIdOrUrl, stageKey) {
  stageKey = stageKey || '3d';
  const idMatch = String(threadIdOrUrl).match(/[a-zA-Z0-9]{16,}/);
  const id = idMatch ? idMatch[0] : threadIdOrUrl;
  const thread = GmailApp.getThreadById(id);
  if (!thread) throw new Error('No thread for ID ' + id);
  thread.addLabel(getOrCreateLabel_(CONFIG.labelPrefix + '/' + stageKey));
  Logger.log('Labeled "' + thread.getFirstMessageSubject() + '" with FU/' + stageKey);
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
