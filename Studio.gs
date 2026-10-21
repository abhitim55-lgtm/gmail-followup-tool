// =================================================================
// Follow-up Studio — full-page web app for the same script.
//
// The Gmail sidebar is fine for "start a sequence on this thread", but
// writing a cold email plus its follow-ups needs room. The Studio is a
// Mailmeteor-style composer: write the first email, pull a saved sequence's
// follow-ups in with one click, send. Every recipient gets their own thread
// and the follow-ups reply on it through the same scheduler as the sidebar.
//
// Runs as the person opening it (webapp.executeAs = USER_ACCESSING), so
// identity, sequences and schedules are per-account exactly like the add-on.
// Public functions below are called from StudioPage.html via google.script.run.
// =================================================================

const STUDIO_MAX_RECIPIENTS = 50;
const SEQUENCE_MAX_BYTES = 8500; // UserProperties caps a value at 9 KB.

function doGet() {
  ensureSchedulerQuiet_();
  recordHeartbeat_('studio');
  return HtmlService.createHtmlOutputFromFile('StudioPage')
    .setTitle('Follow-up Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setFaviconUrl(ICON_URL_)
    // The Chrome extension shows the Studio inside Gmail in an iframe.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Where the sidebar's "Open Studio" button points. Built from the deployment
// ID in CONFIG: ScriptApp.getService().getUrl() can't be used here — called
// from the add-on it returns a different deployment's URL ("unable to open
// the file"). Accounts on the owner's Workspace domain get the /a/macros/
// <domain>/ form so the browser opens it as that account rather than
// whichever Google account happens to be signed in first.
function getStudioUrl_() {
  const id = CONFIG.studioDeploymentId;
  if (!id) return '';
  const email = (getRunningEmail_() || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  const ownerDomain = ((CONFIG.senderEmails[0] || '').toLowerCase().split('@')[1]) || '';
  if (domain && domain === ownerDomain && !/^(gmail|googlemail)\.com$/.test(domain)) {
    return 'https://script.google.com/a/macros/' + domain + '/s/' + id + '/exec';
  }
  return 'https://script.google.com/macros/s/' + id + '/exec';
}


// ───────── Read ──────────────────────────────────────────────────

function studioBootstrap() {
  const campaigns = studioCampaigns_();
  return {
    me: {
      email: getRunningEmail_(),
      displayName: getSenderDisplayName_(),
      firstName: getSenderFirstName_()
    },
    signature: getSignature_(),
    tz: getPreferredTz_(),
    tzChoices: TIMEZONE_CHOICES,
    atTimes: AT_TIME_OPTIONS,
    conditions: STEP_CONDITIONS,
    maxSteps: MAX_CAMPAIGN_STEPS,
    maxRecipients: STUDIO_MAX_RECIPIENTS,
    defaultTemplate: CONFIG.defaultTemplate,
    dryRun: !!CONFIG.dryRun,
    sequences: studioSequences_(),
    campaigns: campaigns,
    campaignList: studioCampaignList_(campaigns),
    health: studioHealth_(),
    autopilot: autopilotStatus_(),
    team: studioTeam_()
  };
}

// Everything the page redraws after a change: per-thread queue, campaign
// list (with status) and scheduler health.
function studioState() {
  const campaigns = studioCampaigns_();
  return { campaigns: campaigns, campaignList: studioCampaignList_(campaigns), health: studioHealth_() };
}

function studioSequences_() {
  return listSequences_().map(function (name) {
    const seq = getSequence_(name) || {};
    return {
      name: name,
      subject: String(seq.subject || ''),
      firstMessage: String(seq.firstMessage || ''),
      steps: (Array.isArray(seq.steps) ? seq.steps : []).slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_),
      recipients: String(seq.recipients || ''),
      cc: String(seq.cc || ''),
      bcc: String(seq.bcc || '')
    };
  });
}

function studioCampaigns_() {
  return collectCampaigns_().map(function (it) {
    let recipient = it.to;
    if (!recipient) {
      try {
        const msgs = GmailApp.getThreadById(it.threadId).getMessages();
        recipient = stripSelfRecipients_(msgs[0].getTo(), getMyEmails_());
      } catch (e) {}
    }
    return {
      threadId: it.threadId,
      campaignName: it.campaignName,
      subject: it.subject,
      recipient: recipient || '',
      stepCount: it.stepCount,
      nextSendAt: it.nextSendAt,
      nextLabel: formatLocal_(it.nextSendAt, it.tz),
      permalink: it.permalink
    };
  });
}

function studioHealth_() {
  const lastRun = getLastRunSummary_();
  const err = getSchedulerError_();
  return {
    running: schedulerTriggers_().length > 0,
    interval: normalizeInterval_(CONFIG.triggerIntervalMinutes),
    account: getRunningEmail_(),
    lastRunAgo: lastRun ? humanDelta_(Date.now() - lastRun.at) : '',
    lastRunSent: lastRun ? lastRun.sent : 0,
    lastRunErrors: lastRun ? (lastRun.errors || []) : [],
    installError: err ? err.message : ''
  };
}


// ───────── Sequences ─────────────────────────────────────────────

// seq: { name, originalName?, subject, firstMessage, steps: [...] }
function studioSaveSequence(seq) {
  seq = seq || {};
  const name = String(seq.name || '').trim();
  if (!name) throw new Error('Give the sequence a name.');
  if (name.length > 80) throw new Error('Keep the name under 80 characters.');
  const rawSteps = Array.isArray(seq.steps) ? seq.steps : [];
  if (rawSteps.length > MAX_CAMPAIGN_STEPS) {
    throw new Error('A sequence can have at most ' + MAX_CAMPAIGN_STEPS + ' follow-ups.');
  }
  rawSteps.forEach(function (s, i) {
    if (!(parseInt(s.amount, 10) > 0)) {
      throw new Error('Follow-up ' + (i + 1) + ': the wait must be more than 0.');
    }
  });
  const originalName = String(seq.originalName || '').trim();
  const previous = getSequence_(originalName || name) || {};
  const bundle = {
    subject: String(seq.subject || ''),
    firstMessage: String(seq.firstMessage || ''),
    steps: rawSteps.map(normalizeSeqStep_),
    // The Studio doesn't edit these; keep whatever the sidebar saved.
    recipients: previous.recipients || '',
    cc: previous.cc || '',
    bcc: previous.bcc || ''
  };
  if (JSON.stringify(bundle).length > SEQUENCE_MAX_BYTES) {
    throw new Error('This sequence is too long to store (Google limits each to ~9 KB). Shorten the messages.');
  }
  setSequence_(name, bundle);
  if (originalName && originalName !== name) deleteSequence_(originalName);
  return studioSequences_();
}

function studioDeleteSequence(name) {
  if (name) deleteSequence_(String(name));
  return studioSequences_();
}


// ───────── Campaigns ─────────────────────────────────────────────

// p: { recipients, subject, body, followUps: [step], campaignName, cc, bcc, tz }
// Sends the first email to each recipient as its own new thread, then queues
// the follow-ups on that thread. Returns per-recipient results; one bad
// address doesn't stop the rest.
function studioSendCampaign(p) {
  p = p || {};
  const subject = String(p.subject || '').trim();
  const body = String(p.body || '').replace(/\s+$/, '');
  if (!subject) throw new Error('Add a subject.');
  if (!body.trim()) throw new Error('Write the first email.');

  const recipients = parseRecipientInput_(p.recipients);
  if (recipients.length === 0) throw new Error('Add at least one recipient email.');
  if (recipients.length > STUDIO_MAX_RECIPIENTS) {
    throw new Error('Up to ' + STUDIO_MAX_RECIPIENTS + ' recipients per send (Gmail daily limits). You added ' +
      recipients.length + '.');
  }

  const tz = studioTz_(p.tz);
  const steps = studioSteps_(p.followUps, tz);
  const cc = String(p.cc || '').trim();
  const bcc = String(p.bcc || '').trim();
  const campaignName = String(p.campaignName || '').trim();

  const results = [];
  recipients.forEach(function (r) {
    const to = formatAddress_(r);
    try {
      const vars = { firstName: recipientFirstName_(r.name) || 'there' };
      const renderedSubject = renderPlaceholders_(subject, vars);
      const text = applySignatureToBody_(renderPlaceholders_(body, vars));
      if (CONFIG.dryRun) {
        Logger.log('[DRY RUN studio] Would send to ' + to + ': ' + renderedSubject + '\n' + text);
        results.push({ email: r.email, ok: true, dryRun: true });
        return;
      }
      const sent = sendNewMessage_({ to: to, cc: cc, bcc: bcc, subject: renderedSubject, body: text,
        attachments: p.attachments || [] });
      // From here the email is out: never report this recipient as failed, or
      // the page offers to resend and they get it twice.
      let firstFollowUp = 0, armError = '';
      if (steps.length > 0) {
        try {
          waitForThread_(sent.threadId);
          const armed = armThreadWithSteps_(sent.threadId, steps, {
            tz: tz,
            campaignName: campaignName,
            cc: cc,
            bcc: bcc,
            anchorMs: Date.now()
          });
          firstFollowUp = armed.steps[0].sendAt;
        } catch (armErr) {
          armError = String((armErr && armErr.message) || armErr);
          Logger.log('studioSendCampaign: sent to ' + to + ' but follow-ups not scheduled: ' + armError);
        }
      }
      results.push({
        email: r.email, ok: true, threadId: sent.threadId, armError: armError,
        firstFollowUp: firstFollowUp ? formatLocal_(firstFollowUp, tz) : ''
      });
    } catch (e) {
      Logger.log('studioSendCampaign: ' + to + ' failed: ' + e);
      results.push({ email: r.email, ok: false, error: String((e && e.message) || e) });
    }
  });

  const delivered = results.filter(function (x) { return x.ok && x.threadId; });
  if (delivered.length) {
    logCampaign_({
      name: campaignName, subject: subject, steps: steps.length,
      recipients: delivered.map(function (x) { return { e: x.email, t: x.threadId }; })
    });
  }

  const scheduler = ensureSchedulerQuiet_();
  return {
    notArmed: results.filter(function (x) { return x.ok && x.armError; }),
    sent: results.filter(function (x) { return x.ok; }).length,
    failed: results.filter(function (x) { return !x.ok; }),
    results: results,
    schedulerOk: !!scheduler.ok,
    dryRun: !!CONFIG.dryRun,
    campaigns: studioCampaigns_()
  };
}

function studioCancelCampaign(threadId) {
  if (!threadId) throw new Error('No thread.');
  markCampaignStopped_(threadId);
  PropertiesService.getUserProperties().deleteProperty('custom_' + threadId);
  try {
    const thread = GmailApp.getThreadById(threadId);
    if (thread) clearFollowUpLabels_(thread);
  } catch (e) {}
  return studioCampaigns_();
}


// ───────── Campaign log & report ─────────────────────────────────
//
// The scheduler only keeps threads that still have follow-ups queued, so a
// campaign vanished from view the moment it finished. Each send now leaves a
// small record (who got it, on which thread) so the page can list campaigns
// as active / ended and show where every recipient is in the sequence.
// Per account, in UserProperties; one key per campaign (each ≤ 9 KB).

const CLOG_PREFIX = 'clog_';
const CLOG_MAX = 30;

// entry: { name, subject, steps, recipients: [{ e: email, t: threadId }] }
function logCampaign_(entry) {
  try {
    const props = PropertiesService.getUserProperties();
    const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    const rec = {
      id: id, name: String(entry.name || ''), subject: String(entry.subject || '').slice(0, 200),
      steps: entry.steps || 0, createdAt: Date.now(), recipients: entry.recipients || []
    };
    props.setProperty(CLOG_PREFIX + id, JSON.stringify(rec));
    const old = readCampaignLogs_().slice(CLOG_MAX);
    old.forEach(function (c) { props.deleteProperty(CLOG_PREFIX + c.id); });
    return id;
  } catch (e) {
    Logger.log('logCampaign_ failed: ' + e);
    return '';
  }
}

// Newest first.
function readCampaignLogs_() {
  const props = PropertiesService.getUserProperties();
  return props.getKeys()
    .filter(function (k) { return k.indexOf(CLOG_PREFIX) === 0; })
    .map(function (k) { try { return JSON.parse(props.getProperty(k)); } catch (e) { return null; } })
    .filter(function (c) { return c && c.id && Array.isArray(c.recipients); })
    .sort(function (a, b) { return b.createdAt - a.createdAt; });
}

function markCampaignStopped_(threadId) {
  const props = PropertiesService.getUserProperties();
  readCampaignLogs_().forEach(function (c) {
    let hit = false;
    c.recipients.forEach(function (r) { if (r.t === threadId && !r.s) { r.s = 1; hit = true; } });
    if (hit) props.setProperty(CLOG_PREFIX + c.id, JSON.stringify(c));
  });
}

// One row per campaign. Threads with follow-ups that didn't come from a
// logged send (started from the sidebar on a sent email, or before the log
// existed) are grouped by campaign name, else subject.
// threads: studioCampaigns_() output.
function studioCampaignList_(threads) {
  const tz = getPreferredTz_();
  const armed = {};
  threads.forEach(function (t) { armed[t.threadId] = t; });
  const used = {};
  const rows = readCampaignLogs_().map(function (c) {
    let active = 0, stopped = 0, next = null;
    c.recipients.forEach(function (r) {
      const a = armed[r.t];
      if (a) {
        used[r.t] = true;
        active++;
        if (!next || a.nextSendAt < next.nextSendAt) next = a;
      } else if (r.s) stopped++;
    });
    return {
      id: c.id, name: c.name || c.subject || '(no subject)', subject: c.subject,
      createdAt: c.createdAt, createdLabel: Utilities.formatDate(new Date(c.createdAt), tz, 'MMM d'),
      recipients: c.recipients.length, steps: c.steps, active: active,
      nextLabel: next ? next.nextLabel : '',
      status: active ? 'active' : (stopped === c.recipients.length ? 'stopped' : 'ended')
    };
  });
  const groups = {};
  const order = [];
  threads.forEach(function (t) {
    if (used[t.threadId]) return;
    const name = t.campaignName || t.subject || '(no subject)';
    let g = groups[name];
    if (!g) {
      g = groups[name] = { id: 'g:' + name, name: name, subject: t.subject, createdAt: 0, createdLabel: '',
        recipients: 0, steps: 0, active: 0, nextLabel: '', nextAt: 0, status: 'active' };
      order.push(g);
    }
    g.recipients++;
    g.active++;
    g.steps = Math.max(g.steps, t.stepCount);
    if (!g.nextAt || t.nextSendAt < g.nextAt) { g.nextAt = t.nextSendAt; g.nextLabel = t.nextLabel; }
  });
  return order.map(function (g) { delete g.nextAt; return g; }).concat(rows);
}

// Report for one campaign: totals plus each recipient's stage.
function studioGetCampaign(id) {
  id = String(id || '');
  const tz = getPreferredTz_();
  let c;
  if (id.indexOf('g:') === 0) {
    const name = id.slice(2);
    const threads = studioCampaigns_().filter(function (t) { return (t.campaignName || t.subject || '(no subject)') === name; });
    if (!threads.length) throw new Error('Nothing is scheduled for “' + name + '” any more.');
    c = { id: id, name: name, subject: threads[0].subject, createdAt: 0, steps: 0, grouped: true,
          recipients: threads.map(function (t) { return { e: t.recipient, t: t.threadId }; }) };
  } else {
    c = readCampaignLogs_().filter(function (x) { return x.id === id; })[0];
    if (!c) throw new Error('That campaign could not be found.');
  }
  const myEmails = getMyEmails_();
  const people = c.recipients.map(function (r) { return campaignRecipientState_(r, c.steps, myEmails); });
  const count = function (st) { return people.filter(function (p) { return p.status === st; }).length; };
  const replied = people.filter(function (p) { return p.replied; }).length;
  return {
    id: c.id, name: c.name || c.subject || '(no subject)', subject: c.subject, grouped: !!c.grouped,
    createdLabel: c.createdAt ? formatLocal_(c.createdAt, tz) : '',
    steps: c.steps,
    status: count('active') ? 'active' : (count('stopped') === people.length ? 'stopped' : 'ended'),
    totals: {
      recipients: people.length,
      followUpsSent: people.reduce(function (n, p) { return n + p.sent; }, 0),
      replied: replied,
      replyRate: people.length ? Math.round(replied * 100 / people.length) : 0,
      active: count('active'),
      finished: people.length - count('active')
    },
    people: people
  };
}

// stages: one entry per email in the sequence (first email included):
// 'sent' | 'next' | 'pending' | 'skipped'.
function campaignRecipientState_(r, plannedSteps, myEmails) {
  const out = { email: r.e || '', threadId: r.t, permalink: '', status: 'missing', replied: false,
                sent: 0, total: plannedSteps || 0, nextLabel: '', stages: [] };
  let thread = null;
  try { thread = GmailApp.getThreadById(r.t); } catch (e) {}
  if (!thread) { out.stages = ['skipped']; return out; }
  const msgs = thread.getMessages();
  const mine = msgs.filter(function (m) { return isFromMe_(m, myEmails); }).length;
  out.permalink = thread.getPermalink();
  out.replied = msgs.some(function (m) { return !isFromMe_(m, myEmails); });
  const queue = getQueueForThread_(r.t);
  out.sent = Math.max(0, mine - 1);
  out.total = queue.length ? out.sent + queue.length : Math.max(out.total, out.sent);
  if (queue.length) {
    out.status = 'active';
    out.nextLabel = formatLocal_(queue[0].sendAt, queue[0].tz);
  } else if (r.s) out.status = 'stopped';
  else if (out.replied) out.status = 'replied';
  else out.status = out.sent >= out.total ? 'completed' : 'ended';
  out.stages.push('sent');
  for (let i = 0; i < out.total; i++) {
    if (i < out.sent) out.stages.push('sent');
    else if (queue.length) out.stages.push(i === out.sent ? 'next' : 'pending');
    else out.stages.push('skipped');
  }
  return out;
}

// Stop every follow-up still queued in a campaign.
function studioStopCampaign(id) {
  const rep = studioGetCampaign(id);
  rep.people.forEach(function (p) { if (p.status === 'active') studioCancelCampaign(p.threadId); });
  return studioState();
}


// ───────── Preview & test (before anything sends) ────────────────

// The same checks the sidebar's review screen runs (ncWarnings_), plus the
// ones that would make the send fail, and when each follow-up would go out.
// p: like studioSendCampaign, or { mode: 'thread', threadId, followUps, tz }.
// Never sends, never changes saved settings.
function studioPreview(p) {
  p = p || {};
  const tz = TIMEZONE_CHOICES.some(function (c) { return c.value === p.tz; }) ? p.tz : getPreferredTz_();
  const blockers = [];
  let steps = [];
  try { steps = studioSteps_(p.followUps, tz); } catch (e) { blockers.push(String(e.message || e)); }

  let warnings;
  let count = 0;
  if (p.mode === 'thread') {
    if (!steps.length && !blockers.length) blockers.push('Add at least one follow-up.');
    warnings = [];
    if (CONFIG.dryRun) warnings.push('Test mode is on (CONFIG.dryRun): nothing will actually be sent.');
    if (steps.length && schedulerTriggers_().length === 0) {
      warnings.push('Sending is switched off, so follow-ups won\'t go out. Fix it in Settings first.');
    }
  } else {
    const d = { recipients: String(p.recipients || ''), subject: String(p.subject || ''), body: String(p.body || '') };
    const recips = parseRecipientInput_(d.recipients);
    count = recips.length;
    if (!count) blockers.push('Add at least one recipient.');
    if (count > STUDIO_MAX_RECIPIENTS) blockers.push('Up to ' + STUDIO_MAX_RECIPIENTS + ' recipients per send. You added ' + count + '.');
    if (!d.subject.trim()) blockers.push('Add a subject.');
    if (!d.body.trim()) blockers.push('Write the first email.');
    warnings = count ? ncWarnings_(d, recips.slice(0, STUDIO_MAX_RECIPIENTS), steps) : [];
  }

  let prev = Date.now();
  const schedule = steps.map(function (s) {
    if (s.sendAtAbs > 0) {
      const wall = Utilities.formatDate(new Date(s.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
      prev = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    } else {
      prev = computeStepSendAt_(prev, s.amount, s.unit, s.atTime, tz);
    }
    return { when: formatLocal_(prev, tz), condition: conditionLabel_(s.condition) };
  });
  return { from: getRunningEmail_(), count: count, blockers: blockers, warnings: warnings, schedule: schedule, dryRun: !!CONFIG.dryRun };
}

// Sends one email of the campaign to the signed-in person only, written as
// if to the first recipient. step: -1 = first email, else follow-up index.
function studioSendTest(p) {
  p = p || {};
  const me = getRunningEmail_();
  if (!me) throw new Error('Could not detect your Gmail address. Reload the page.');
  const step = parseInt(p.step, 10);
  const isFollowUp = step >= 0;
  const fu = isFollowUp ? ((p.followUps || [])[step] || {}) : null;
  const subject = String(p.subject || '').trim();
  const body = isFollowUp ? String(fu.message || CONFIG.defaultTemplate) : String(p.body || '');
  if (!subject || !body.trim()) throw new Error('Write a subject and an email first.');
  const first = parseRecipientInput_(p.recipients)[0];
  const vars = { firstName: first ? (recipientFirstName_(first.name) || 'there') : 'there' };
  const renderedSubject = renderPlaceholders_(subject, vars);
  const finalSubject = '[Test] ' + (isFollowUp && !/^re:/i.test(renderedSubject) ? 'Re: ' : '') + renderedSubject;
  if (CONFIG.dryRun) return { to: me, dryRun: true };
  sendNewMessage_({ to: me, subject: finalSubject, body: applySignatureToBody_(renderPlaceholders_(body, vars)) });
  return { to: me, dryRun: false };
}


// ───────── Existing threads (emails already sent from Gmail) ────

// Recent sent threads to follow up on. query is any extra Gmail search.
function studioListThreads(query) {
  const extra = String(query || '').trim();
  const threads = GmailApp.search('in:sent ' + (extra || 'newer_than:30d'), 0, 25);
  const myEmails = getMyEmails_();
  const props = PropertiesService.getUserProperties();
  const tz = getPreferredTz_();
  return threads.map(function (t) {
    const msgs = t.getMessages();
    const last = msgs[msgs.length - 1];
    return {
      threadId: t.getId(),
      subject: t.getFirstMessageSubject() || '(no subject)',
      recipient: threadRecipientLabel_(msgs, myEmails),
      lastLabel: formatLocal_(last.getDate().getTime(), tz),
      waiting: isFromMe_(last, myEmails),
      armed: !!props.getProperty('custom_' + t.getId()),
      count: msgs.length
    };
  });
}

function studioGetThread(threadId) {
  const t = GmailApp.getThreadById(String(threadId || ''));
  if (!t) throw new Error('That email thread could not be found.');
  const myEmails = getMyEmails_();
  const msgs = t.getMessages();
  const last = msgs[msgs.length - 1];
  const tz = getPreferredTz_();
  let snippet = '';
  try { snippet = last.getPlainBody().replace(/\s+/g, ' ').trim().slice(0, 280); } catch (e) {}
  return {
    threadId: t.getId(),
    subject: t.getFirstMessageSubject() || '(no subject)',
    recipient: threadRecipientLabel_(msgs, myEmails),
    permalink: t.getPermalink(),
    count: msgs.length,
    lastFromMe: isFromMe_(last, myEmails),
    lastFrom: parseAddress_(last.getFrom()).name || parseAddress_(last.getFrom()).email,
    lastLabel: formatLocal_(last.getDate().getTime(), tz),
    snippet: snippet,
    queue: getQueueForThread_(t.getId()).map(function (s) {
      return {
        label: formatLocal_(s.sendAt, s.tz),
        message: s.message || '',
        condition: s.condition || 'no_reply',
        to: s.to || '', cc: s.cc || '', bcc: s.bcc || ''
      };
    })
  };
}

// p: { threadId, followUps, recipients, cc, bcc, tz, campaignName }
function studioScheduleOnThread(p) {
  p = p || {};
  const threadId = canonicalThreadId_(String(p.threadId || ''));
  if (!threadId || !GmailApp.getThreadById(threadId)) throw new Error('That email thread could not be found.');
  const tz = studioTz_(p.tz);
  const steps = studioSteps_(p.followUps, tz);
  if (steps.length === 0) throw new Error('Add at least one follow-up.');
  armThreadWithSteps_(threadId, steps, {
    tz: tz,
    campaignName: String(p.campaignName || ''),
    recipients: String(p.recipients || ''),
    cc: String(p.cc || ''),
    bcc: String(p.bcc || '')
  });
  const scheduler = ensureSchedulerQuiet_();
  return { thread: studioGetThread(threadId), campaigns: studioCampaigns_(), schedulerOk: !!scheduler.ok };
}

function studioRemoveStep(threadId, index) {
  const err = removeQueuedStep_(String(threadId || ''), parseInt(index, 10));
  if (err) throw new Error(err);
  return { thread: studioGetThread(threadId), campaigns: studioCampaigns_() };
}

function studioCancelThread(threadId) {
  const campaigns = studioCancelCampaign(threadId);
  return { thread: studioGetThread(threadId), campaigns: campaigns };
}


// ───────── Settings & health ─────────────────────────────────────

// s: { displayName, firstName, signature, tz }
function studioSaveSettings(s) {
  s = s || {};
  setSenderIdentity_(String(s.displayName || '').trim(), String(s.firstName || '').trim());
  _cachedFromHeader_ = null;
  setSignature_(String(s.signature || '').replace(/\s+$/, ''));
  if (TIMEZONE_CHOICES.some(function (c) { return c.value === s.tz; })) setPreferredTz_(s.tz);
  return studioBootstrap();
}

// s: { enabled, days: [7 × { on, from, to }] (Sunday first), maxPerDay, delayMinutes }
function studioSaveAutopilot(s) {
  setAutopilot_(s || {});
  return autopilotStatus_();
}

function studioFixScheduler() {
  const res = ensureScheduler_();
  return { ok: !!res.ok, message: res.ok ? '' : String(res.message || ''), health: studioHealth_() };
}

function studioRunNow() {
  processFollowUps();
  const summary = getLastRunSummary_() || { sent: 0, errors: [] };
  return {
    sent: summary.sent || 0,
    errors: summary.errors || [],
    health: studioHealth_(),
    campaigns: studioCampaigns_()
  };
}


// ───────── Team status ───────────────────────────────────────────
//
// Triggers, settings and schedules are per-account, so the owner can't see
// whether a teammate's copy actually runs. Each account drops a small status
// record in ScriptProperties (shared by everyone on this script) whenever it
// opens the Studio, opens the Gmail sidebar, or its scheduler runs. Status
// only — never message content or recipients. Only the owner sees the list.

const TEAM_PREFIX = 'team_';

// where: 'studio' | 'sidebar' | 'run'. run: { sent, errors } for 'run'.
function recordHeartbeat_(where, run) {
  try {
    const email = getRunningEmail_();
    if (!email) return;
    const sp = PropertiesService.getScriptProperties();
    const key = TEAM_PREFIX + email;
    let hb = {};
    try { hb = JSON.parse(sp.getProperty(key) || '{}') || {}; } catch (e) { hb = {}; }
    const now = Date.now();
    hb.email = email;
    if (where === 'run') {
      hb.runAt = now;
      hb.runSent = (run && run.sent) || 0;
      hb.runErrors = (run && run.errors && run.errors.length) || 0;
      hb.runError = (run && run.errors && run.errors[0]) ? String(run.errors[0]).slice(0, 200) : '';
      hb.schedulerOn = true;
    } else {
      if (where === 'studio') hb.studioAt = now;
      if (where === 'sidebar') hb.sidebarAt = now;
      hb.name = getSenderDisplayName_() || hb.name || '';
      hb.schedulerOn = schedulerTriggers_().length > 0;
    }
    sp.setProperty(key, JSON.stringify(hb));
  } catch (e) {
    Logger.log('recordHeartbeat_ failed: ' + e);
  }
}

function studioTeam_() {
  if (!isOwnerAccount_()) return null;
  const sp = PropertiesService.getScriptProperties();
  const tz = getPreferredTz_();
  const when = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'MMM d, h:mm a') : ''; };
  return sp.getKeys()
    .filter(function (k) { return k.indexOf(TEAM_PREFIX) === 0; })
    .map(function (k) {
      let hb;
      try { hb = JSON.parse(sp.getProperty(k)); } catch (e) { return null; }
      if (!hb || !hb.email) return null;
      // A scheduler that hasn't reported in 3 intervals has stopped.
      const stale = hb.runAt && (Date.now() - hb.runAt > 3 * normalizeInterval_(CONFIG.triggerIntervalMinutes) * 60000 + 120000);
      return {
        email: hb.email,
        name: hb.name || '',
        studio: when(hb.studioAt),
        sidebar: when(hb.sidebarAt),
        running: !!hb.schedulerOn && !stale,
        lastRun: hb.runAt ? humanDelta_(Date.now() - hb.runAt) + ' ago' : '',
        lastRunSent: hb.runSent || 0,
        lastRunError: hb.runError || ''
      };
    })
    .filter(function (x) { return x; })
    .sort(function (a, b) { return a.email < b.email ? -1 : 1; });
}


// ───────── Helpers ───────────────────────────────────────────────

// Pull every address out of free-form input: one per line, comma/semicolon
// separated, bare or "Name <email>" (quoted names may contain commas).
// Deduped by lowercased email, order preserved.
function parseRecipientInput_(text) {
  const re = /(?:"([^"]*)"|([^<>,;\n"]*?))\s*<\s*([^<>\s,;]+@[^<>\s,;]+)\s*>|([^\s<>,;"]+@[^\s<>,;"]+)/g;
  const out = [];
  const seen = {};
  let m;
  const s = String(text || '');
  while ((m = re.exec(s)) !== null) {
    const email = (m[3] || m[4] || '').trim();
    const name = (m[1] || m[2] || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    const k = email.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ name: name, email: email });
  }
  return out;
}

function formatAddress_(r) {
  if (!r.name) return r.email;
  const phrase = /^[\x00-\x7F]*$/.test(r.name)
    ? '"' + r.name.replace(/(["\\])/g, '\\$1') + '"'
    : '=?UTF-8?B?' + Utilities.base64Encode(r.name, Utilities.Charset.UTF_8) + '?=';
  return phrase + ' <' + r.email + '>';
}

function studioTz_(tz) {
  const ok = TIMEZONE_CHOICES.some(function (c) { return c.value === tz; });
  const out = ok ? tz : getPreferredTz_();
  if (ok) setPreferredTz_(out);
  return out;
}

// Validate + normalize follow-ups from the page. A step either waits
// (amount/unit/atTime after the previous one) or fires at an exact moment:
// sendAtAbs is the picked wall-clock encoded as UTC ms, like the sidebar's
// date picker, and is re-anchored to tz by armThreadWithSteps_.
function studioSteps_(rawSteps, tz) {
  const raw = Array.isArray(rawSteps) ? rawSteps : [];
  if (raw.length > MAX_CAMPAIGN_STEPS) throw new Error('At most ' + MAX_CAMPAIGN_STEPS + ' follow-ups.');
  return raw.map(function (s, i) {
    const step = normalizeSeqStep_(s);
    const abs = Number(s && s.sendAtAbs) || 0;
    if (abs > 0) {
      const wall = Utilities.formatDate(new Date(abs), 'UTC', 'yyyy-MM-dd HH:mm');
      if (Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime() <= Date.now()) {
        throw new Error('Follow-up ' + (i + 1) + ': pick a date and time in the future.');
      }
      step.sendAtAbs = abs;
      return step;
    }
    if (!(parseInt(s && s.amount, 10) > 0)) {
      throw new Error('Follow-up ' + (i + 1) + ': the wait must be more than 0.');
    }
    return step;
  });
}

// Who follow-ups on this thread go to, for display.
function threadRecipientLabel_(msgs, myEmails) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isFromMe_(msgs[i], myEmails)) return msgs[i].getFrom();
  }
  return deriveColdRecipients_(msgs, myEmails).to || '';
}

// A just-sent message's thread can take a moment to become readable.
function waitForThread_(threadId) {
  for (let i = 0; i < 4; i++) {
    try { if (GmailApp.getThreadById(threadId)) return; } catch (e) {}
    Utilities.sleep(500);
  }
}

// "Doe, Jane" is "Last, First"; anything else is "First Last".
function recipientFirstName_(name) {
  const n = String(name || '');
  return firstNameOf_(n.indexOf(',') !== -1 ? n.slice(n.indexOf(',') + 1) : n);
}

function renderPlaceholders_(tmpl, vars) {
  return String(tmpl || '')
    .replace(/\{firstName\}/g, vars.firstName || 'there')
    .replace(/\{senderFirstName\}/g, getSenderFirstName_());
}
