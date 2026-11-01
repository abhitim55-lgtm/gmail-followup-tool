// =================================================================
// API for the local MCP server (mcp/ in this repo).
//
// Claude calls these through the Apps Script API (scripts.run), signed in as
// the person using it, so they run as that person's own Gmail account just
// like the sidebar. scripts.run can't call functions ending in "_", hence
// these thin public wrappers.
//
// Anything that sends or stops mail works in two calls: without confirm it
// only returns a preview (who, what, when, warnings); with confirm: true it
// does it. The MCP server also checks the confirmed call matches the preview.
// =================================================================

function mcpStatus() {
  const h = studioHealth_();
  h.dryRun = !!CONFIG.dryRun;
  h.displayName = getSenderDisplayName_();
  h.timezone = getPreferredTz_();
  h.signatureSet = !!getSignature_();
  h.ownDomains = myDomains_();
  const pa = pauseState_();
  h.pausedAll = pa.paused;
  if (pa.until) h.pausedUntil = formatLocal_(pa.until, h.timezone);
  h.scheduled = mcpListCampaigns().map(function (c) {
    return { subject: c.subject, campaignName: c.campaignName, threadId: c.threadId, followUps: c.followUps };
  });
  return h;
}

function mcpListSequences() {
  return studioSequences_();
}

// Create or update a saved sequence. Sends nothing.
// s: { name, originalName?, subject?, firstMessage?, steps: [draft-shaped step] }
function mcpSaveSequence(s) {
  s = s || {};
  const name = String(s.name || '').trim();
  const original = String(s.originalName || '').trim();
  if (name && name !== original && getSequence_(name) && !s.overwrite) {
    throw new Error('A sequence called "' + name + '" already exists. Use a different name, or pass overwrite: true to replace it.');
  }
  const seq = {
    name: name, originalName: original || (s.overwrite ? name : ''),
    subject: s.subject || '', firstMessage: s.firstMessage || '',
    steps: mcpStashStepFiles_(mcpAdditiveStepRecipients_(s.steps, 'a saved sequence'))
  };
  if (s.cc !== undefined) seq.cc = mcpAddressList_(s.cc, 'cc').join(', ');
  if (s.bcc !== undefined) seq.bcc = mcpAddressList_(s.bcc, 'bcc').join(', ');
  if (s.replyMode !== undefined) seq.replyMode = mcpReplyMode_(s.replyMode);
  if (s.stopOnReplyFrom !== undefined) seq.stopOnReplyFrom = mcpStopList_(s.stopOnReplyFrom);
  const list = studioSaveSequence(seq);
  cleanupAttachmentHolders_(); // files of a replaced version
  return { saved: name, sequence: list.filter(function (x) { return x.name === name; })[0] || null };
}

// Without confirm: what would be deleted. With confirm: delete it.
// Running campaigns keep their already-scheduled follow-ups either way.
function mcpDeleteSequence(name, confirm) {
  const n = String(name || '');
  const seq = studioSequences_().filter(function (x) { return x.name === n; })[0];
  if (!seq) throw new Error('No sequence called "' + n + '". Use list_sequences to see the names.');
  if (!confirm) return { preview: true, sequence: seq, note: 'Campaigns already running keep their follow-ups.' };
  studioDeleteSequence(n);
  cleanupAttachmentHolders_();
  return { deleted: n };
}

// Steps from the MCP may carry files ({ attachments: [{name,mimeType,data}] }).
// Turn each step's files into a holder draft, leaving only its id on the step.
function mcpStashStepFiles_(steps) {
  return (steps || []).map(function (s) {
    const files = Array.isArray(s.attachments) ? s.attachments : [];
    const out = {};
    Object.keys(s).forEach(function (k) { if (k !== 'attachments') out[k] = s[k]; });
    if (files.length) {
      out.attachDraftId = createAttachmentHolder_(files);
      out.attachNames = files.map(function (f) { return f.name; });
    }
    return out;
  });
}

// Each running campaign, with who every scheduled follow-up will go to (as
// the thread stands now; reply_all and last_sender are worked out again when
// each one sends).
function mcpListCampaigns() {
  const myEmails = getMyEmails_();
  return studioCampaigns_().map(function (c) {
    let messages = [];
    try { messages = threadMessages_(GmailApp.getThreadById(c.threadId)); } catch (e) {}
    c.paused = isThreadPaused_(c.threadId);
    c.followUps = getQueueForThread_(c.threadId).map(function (s, i) {
      const r = resolveStepRecipients_(messages, s, myEmails);
      return {
        step: i + 1,
        message: String(s.message || CONFIG.defaultTemplate).replace(/\s+/g, ' ').substring(0, 160),
        attachments: s.attachNames || [],
        when: formatLocal_(s.sendAt, s.tz), condition: conditionLabel_(s.condition),
        replyMode: s.replyMode || (s.to ? 'custom' : 'last_sender'),
        to: r.to, cc: r.cc, bcc: r.bcc
      };
    });
    return c;
  });
}

function mcpListSentThreads(query) {
  return studioListThreads(query);
}

// p: { recipients, subject, body, sequence?, followUps?, campaignName, cc, bcc, tz, confirm }
// followUps are draft-shaped steps; sequence is a saved sequence's name whose
// follow-ups are used instead.
function mcpSendCampaign(p) {
  p = p || {};
  p.cc = mcpAddressList_(p.cc, 'cc').join(', ');
  p.bcc = mcpAddressList_(p.bcc, 'bcc').join(', ');
  const steps = mcpAdditiveStepRecipients_(mcpCampaignSteps_(p), 'send_campaign');
  if (!p.confirm) return mcpCampaignPreview_(p, steps);
  const res = studioSendCampaign({
    recipients: p.recipients, subject: p.subject, body: p.body, followUps: mcpStashStepFiles_(steps),
    campaignName: p.campaignName, cc: p.cc, bcc: p.bcc, tz: p.tz,
    attachments: Array.isArray(p.attachments) ? p.attachments : []
  });
  delete res.campaigns;
  return res;
}

// p: { threadId, sequence?, followUps?, tz, campaignName, confirm,
//      to?, cc?, bcc?, replyMode?, stopOnReplyFrom?, stopOnAnyReply? }
// followUps may carry override: { to?, cc?, bcc? } replacing the
// sequence-level lists for that one email (custom mode).
function mcpStartSequenceOnThread(p) {
  p = p || {};
  const name = String(p.sequence || '');
  let seq = null, steps;
  if (name) {
    seq = getSequence_(name);
    if (!seq || !Array.isArray(seq.steps) || seq.steps.length === 0) {
      throw new Error('Sequence "' + name + '" not found or has no follow-ups. Use list_sequences to see the names.');
    }
    steps = seq.steps.slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
  } else {
    steps = Array.isArray(p.followUps) ? p.followUps : [];
    if (!steps.length) throw new Error('Give either a saved sequence name or the follow-ups to send.');
  }
  seq = seq || {};
  const plan = mcpRecipientPlan_(p, steps, seq);
  const custom = plan.mode === 'custom';
  const opts = {
    threadId: p.threadId, followUps: plan.steps, tz: p.tz, campaignName: name || String(p.campaignName || ''),
    // custom mode carries final lists on each step; the others layer the
    // sequence's cc/bcc on top of the thread's recipients, as before.
    recipients: plan.mode === 'last_sender' ? (seq.recipients || '') : '',
    cc: custom ? '' : (seq.cc || ''), bcc: custom ? '' : (seq.bcc || '')
  };
  if (p.confirm) {
    opts.followUps = mcpStashStepFiles_(opts.followUps);
    const res = studioScheduleOnThread(opts);
    return { scheduled: true, thread: res.thread, schedulerOk: res.schedulerOk };
  }
  return mcpThreadPreview_(p, plan, opts);
}

function mcpThreadPreview_(p, plan, opts) {
  const threadId = canonicalThreadId_(String(p.threadId || ''));
  const t = threadId && GmailApp.getThreadById(threadId);
  if (!t) throw new Error('That email thread could not be found.');
  const thread = studioGetThread(threadId);
  const messages = threadMessages_(t);
  const myEmails = getMyEmails_();
  const domains = myDomains_();
  const tz = mcpTz_(p.tz);
  const steps = studioSteps_(opts.followUps, tz, true);
  const timing = mcpScheduleLabels_(steps, tz, {});
  const warnings = [];
  if (CONFIG.dryRun) warnings.push('Test mode is on (CONFIG.dryRun): follow-ups will be logged, not sent.');
  if (schedulerTriggers_().length === 0) {
    warnings.push('Sending is switched off, so follow-ups won\'t go out. Open the sidebar or Studio to fix the scheduler first.');
  }
  if (thread.queue.length) {
    warnings.push('This thread already has ' + thread.queue.length + ' follow-up(s) queued. These are added on top.');
  }

  // A client reply that nobody has answered yet.
  let myLastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (isFromMe_(messages[i], myEmails)) { myLastIdx = i; break; } }
  for (let i = messages.length - 1; i > myLastIdx; i--) {
    const from = parseAddress_(messages[i].getFrom());
    if (!from.email) continue;
    warnings.push((from.name || from.email) + ' wrote on ' + formatLocal_(messages[i].getDate().getTime(), tz) +
      ', after your last email. Any reply stops follow-ups set to "if no reply", so those will be cancelled ' +
      'on the next run. Reply on the thread first, then start follow-ups, or use "No matter what".');
    break;
  }

  const rows = steps.map(function (s, i) {
    const stored = {
      to: s.exactRecipients ? s.to : (opts.recipients || ''),
      cc: s.exactRecipients ? s.cc : mergeRecipients_(opts.cc, s.cc || ''),
      bcc: s.exactRecipients ? s.bcc : mergeRecipients_(opts.bcc, s.bcc || ''),
      replyMode: s.replyMode
    };
    const r = resolveStepRecipients_(messages, stored, myEmails);
    const label = 'Follow-up ' + (i + 1);
    const at = timing[i].at;
    const toList = parseAddressList_(r.to);
    const external = toList.filter(function (a) { return isValidEmail_(a.email) && !isOwnDomain_(a.email, myEmails); });
    const everyone = toList.concat(parseAddressList_(r.cc), parseAddressList_(r.bcc));
    if (!toList.length) {
      warnings.push(label + ': nobody to send to could be worked out from this thread. Use reply_mode "custom" with to.');
    } else if (!external.length && everyone.some(function (a) { return isOwnDomain_(a.email, myEmails); })) {
      warnings.push(label + ' would go To ' + r.to + ' only: nobody outside ' + (domains.join(', ') || 'your account') +
        ' is in To. ' + (s.exactRecipients ? 'Put the client in to.' : 'It will not be sent. Use reply_mode "custom" with the client in to.'));
    }
    if (!s.sendNow && at < Date.now()) warnings.push(label + ' is set for ' + formatLocal_(at, tz) + ', which is in the past. Pick a future time, or send_at: "now".');
    const weekend = [];
    external.forEach(function (a) {
      const w = recipientWeekend_(a.email, tz);
      if (w.days.indexOf(weekdayIn_(at, tz)) !== -1) weekend.push(a.email + ' (' + w.label + ')');
    });
    if (weekend.length) warnings.push(label + ' (' + formatLocal_(at, tz) + ') falls on the weekend for ' + weekend.join(', ') + '.');
    const vars = { firstName: recipientFirstName_(r.name) || 'there' };
    return {
      when: timing[i].when,
      to: r.to, cc: r.cc, bcc: r.bcc,
      condition: timing[i].condition,
      message: applySignatureToBody_(renderPlaceholders_(s.message || CONFIG.defaultTemplate, vars)),
      attachments: timing[i].attachments
    };
  });

  const stops = 'A reply from anyone other than you after your last email (client, anyone else on the thread, or a colleague)';
  return {
    preview: true,
    thread: { threadId: thread.threadId, subject: thread.subject, replySubject: /^Re:/i.test(thread.subject) ? thread.subject : 'Re: ' + thread.subject,
              permalink: thread.permalink },
    replyMode: plan.mode,
    stopsWhen: stops + ' stops the follow-ups marked "if no reply".',
    timezone: tz,
    followUps: rows,
    warnings: warnings
  };
}

// Which threads a stop/pause/resume applies to.
// sel: { threadId? | campaignName? | recipient? | all? }
function mcpSelectThreads_(sel) {
  sel = sel || {};
  const all = studioCampaigns_();
  let out;
  if (sel.threadId) out = all.filter(function (c) { return c.threadId === String(sel.threadId); });
  else if (sel.campaignName) {
    const n = String(sel.campaignName).trim().toLowerCase();
    out = all.filter(function (c) { return String(c.campaignName || c.subject || '').trim().toLowerCase() === n; });
  } else if (sel.recipient) {
    const e = String(sel.recipient).trim().toLowerCase();
    out = all.filter(function (c) {
      if (String(c.recipient || '').toLowerCase().indexOf(e) !== -1) return true;
      return getQueueForThread_(c.threadId).some(function (st) {
        return [st.to, st.cc].join(',').toLowerCase().indexOf(e) !== -1;
      });
    });
  } else if (sel.all) out = all;
  else throw new Error('Say which follow-ups: thread_id, campaign_name, recipient, or all.');
  if (!out.length) throw new Error('No scheduled follow-ups match that. Use list_campaigns to see what is running.');
  return out;
}

function mcpThreadSummary_(c) {
  return {
    threadId: c.threadId, campaignName: c.campaignName || '', subject: c.subject || '', recipient: c.recipient || '',
    paused: isThreadPaused_(c.threadId),
    followUps: getQueueForThread_(c.threadId).map(function (s, i) {
      return { step: i + 1, when: formatLocal_(s.sendAt, s.tz), condition: conditionLabel_(s.condition),
               message: String(s.message || CONFIG.defaultTemplate).replace(/\s+/g, ' ').substring(0, 160) };
    })
  };
}

// Stop every follow-up on the selected threads. Without confirm: preview.
// Kept callable as mcpStopCampaign(threadId, confirm) for older servers.
function mcpStopCampaign(sel, confirm) {
  if (typeof sel === 'string') sel = { threadId: sel };
  const threads = mcpSelectThreads_(sel);
  if (!confirm) {
    return { preview: true, threads: threads.map(mcpThreadSummary_),
             followUpsCancelled: threads.reduce(function (n, c) { return n + c.stepCount; }, 0) };
  }
  let n = 0;
  threads.forEach(function (c) { n += c.stepCount; studioCancelCampaign(c.threadId); });
  cleanupAttachmentHolders_();
  return { stopped: threads.length, cancelled: n, threadIds: threads.map(function (c) { return c.threadId; }) };
}

// Cancel one follow-up. step is 1-based, as list_campaigns shows it.
function mcpCancelFollowUp(threadId, step, confirm) {
  const id = String(threadId || '');
  const queue = getQueueForThread_(id);
  const i = parseInt(step, 10) - 1;
  if (!queue.length) throw new Error('Nothing is scheduled on that thread. Use list_campaigns.');
  if (isNaN(i) || i < 0 || i >= queue.length) throw new Error('That thread has follow-ups 1 to ' + queue.length + '.');
  const c = mcpThreadSummary_({ threadId: id, campaignName: '', subject: '', recipient: '' });
  if (!confirm) {
    const meta = studioCampaigns_().filter(function (x) { return x.threadId === id; })[0] || {};
    return { preview: true, subject: meta.subject || '', recipient: meta.recipient || '', cancels: c.followUps[i],
             remaining: c.followUps.length - 1 };
  }
  const err = removeQueuedStep_(id, i);
  if (err) throw new Error(err);
  cleanupAttachmentHolders_();
  return { cancelled: c.followUps[i], remaining: queue.length - 1 };
}

// Change one follow-up's message, send time or condition.
// p: { threadId, step (1-based), message?, sendAtAbs? (wall clock as UTC ms), condition?, tz? }
function mcpEditFollowUp(p, confirm) {
  p = p || {};
  const id = String(p.threadId || '');
  const queue = getQueueForThread_(id);
  const i = parseInt(p.step, 10) - 1;
  if (!queue.length) throw new Error('Nothing is scheduled on that thread. Use list_campaigns.');
  if (isNaN(i) || i < 0 || i >= queue.length) throw new Error('That thread has follow-ups 1 to ' + queue.length + '.');
  const cur = queue[i];
  const tz = mcpTz_(p.tz || cur.tz);
  const changes = {};
  if (typeof p.message === 'string' && p.message.trim()) changes.message = p.message;
  if (p.condition) changes.condition = p.condition;
  if (p.sendAtAbs) {
    const wall = Utilities.formatDate(new Date(p.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
    const ms = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    if (ms <= Date.now()) throw new Error('Pick a time in the future.');
    changes.sendAt = ms;
  }
  if (!Object.keys(changes).length) throw new Error('Nothing to change: give a new message, send time or condition.');
  const before = { when: formatLocal_(cur.sendAt, cur.tz || tz), condition: conditionLabel_(cur.condition),
                   message: cur.message || CONFIG.defaultTemplate };
  const after = { when: changes.sendAt ? formatLocal_(changes.sendAt, tz) : before.when,
                  condition: changes.condition ? conditionLabel_(changes.condition) : before.condition,
                  message: changes.message || before.message };
  if (!confirm) return { preview: true, threadId: id, step: i + 1, before: before, after: after };
  const err = editQueuedStep_(id, i, changes);
  if (err) throw new Error(err);
  return { edited: true, threadId: id, now: after };
}

// Pause or resume. sel: { threadId? | campaignName? | recipient? | all? }, until: ms or 0.
// Pausing "all" holds every follow-up, including ones started later.
function mcpPause(sel, paused, untilAbs, confirm) {
  sel = sel || {};
  const tz = getPreferredTz_();
  let until = 0;
  if (untilAbs) {
    const wall = Utilities.formatDate(new Date(untilAbs), 'UTC', 'yyyy-MM-dd HH:mm');
    until = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    if (until <= Date.now()) throw new Error('Pick a resume time in the future.');
  }
  if (sel.all) {
    const pa = pauseState_();
    const count = studioCampaigns_().length;
    if (!confirm) {
      return { preview: true, scope: 'all', action: paused ? 'pause' : 'resume', threads: count,
               currentlyPaused: pa.paused, until: until ? formatLocal_(until, tz) : '',
               note: paused ? 'Nothing will send until you resume' + (until ? ' (or until ' + formatLocal_(until, tz) + ')' : '') +
                 '. Follow-ups that come due meanwhile go out on the first run after resuming.'
                 : 'Follow-ups that came due while paused go out within a few minutes.' };
    }
    setPauseAll_(paused, until);
    return { done: true, scope: 'all', paused: paused, until: until ? formatLocal_(until, tz) : '' };
  }
  const threads = mcpSelectThreads_(sel);
  if (!confirm) {
    return { preview: true, action: paused ? 'pause' : 'resume', until: until ? formatLocal_(until, tz) : '',
             threads: threads.map(mcpThreadSummary_),
             note: paused ? 'These follow-ups hold until you resume. Ones that come due meanwhile go out after resuming.'
                          : 'Follow-ups that came due while paused go out within a few minutes.' };
  }
  threads.forEach(function (c) { setThreadPaused_(c.threadId, paused, until); });
  return { done: true, paused: paused, threads: threads.length };
}


// ───────── Helpers ───────────────────────────────────────────────

function mcpCampaignSteps_(p) {
  if (p.sequence) {
    const seq = getSequence_(String(p.sequence));
    if (!seq) throw new Error('Sequence "' + p.sequence + '" not found. Use list_sequences to see the names.');
    return (seq.steps || []).slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
  }
  return Array.isArray(p.followUps) ? p.followUps : [];
}

// Same checks studioSendCampaign makes (so the preview fails where the send
// would), then what the sidebar's review screen shows.
function mcpCampaignPreview_(p, rawSteps) {
  const d = { recipients: String(p.recipients || ''), subject: String(p.subject || '').trim(), body: String(p.body || '') };
  if (!d.subject) throw new Error('Add a subject.');
  if (!d.body.trim()) throw new Error('Write the first email.');
  const recips = parseRecipientInput_(d.recipients);
  if (recips.length === 0) throw new Error('Add at least one recipient email.');
  if (recips.length > STUDIO_MAX_RECIPIENTS) {
    throw new Error('Up to ' + STUDIO_MAX_RECIPIENTS + ' recipients per send. You added ' + recips.length + '.');
  }
  const tz = mcpTz_(p.tz);
  const steps = studioSteps_(rawSteps, tz);
  const first = recips[0];
  const vars = { firstName: recipientFirstName_(first.name) || 'there' };
  return {
    preview: true,
    from: getRunningEmail_(),
    recipients: recips.map(function (r) { return r.name ? r.name + ' <' + r.email + '>' : r.email; }),
    cc: String(p.cc || ''),
    bcc: String(p.bcc || ''),
    firstEmail: {
      shownAs: first.name || first.email,
      subject: renderPlaceholders_(d.subject, vars),
      body: applySignatureToBody_(renderPlaceholders_(d.body, vars))
    },
    // Each person's follow-ups reply on their own thread, to them.
    followUps: mcpScheduleLabels_(steps, tz, vars).map(function (row, i) {
      return { when: row.when, to: 'each recipient (' + formatAddress_(first) + ' shown)',
        cc: mergeRecipients_(String(p.cc || ''), steps[i].cc || ''), bcc: mergeRecipients_(String(p.bcc || ''), steps[i].bcc || ''),
        condition: row.condition, message: row.message, attachments: row.attachments };
    }),
    attachments: (p.attachmentNames || []).map(String),
    timezone: tz,
    warnings: ncWarnings_(d, recips, steps)
  };
}

// When each step would go out if started now, plus its rendered message.
function mcpScheduleLabels_(steps, tz, vars) {
  let prev = Date.now();
  return steps.map(function (s, i) {
    if (s.sendNow) {
      return {
        at: prev,
        when: i === 0 ? 'Now: on the next scheduler run (within about ' + normalizeInterval_(CONFIG.triggerIntervalMinutes) + ' min, ' + formatLocal_(prev, tz) + ')'
          : 'Right after follow-up ' + i + ', on the same or next scheduler run',
        condition: conditionLabel_(s.condition),
        message: renderPlaceholders_(s.message || CONFIG.defaultTemplate, vars),
        attachments: (s.attachNames && s.attachNames.length) ? s.attachNames : (s.attachments || []).map(function (f) { return f.name; })
      };
    }
    if (s.sendAtAbs > 0) {
      const wall = Utilities.formatDate(new Date(s.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
      prev = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    } else {
      prev = computeStepSendAt_(prev, s.amount, s.unit, s.atTime, tz);
    }
    return {
      at: prev,
      when: 'About ' + formatLocal_(prev, tz),
      condition: conditionLabel_(s.condition),
      message: renderPlaceholders_(s.message || CONFIG.defaultTemplate, vars),
      attachments: (s.attachNames && s.attachNames.length) ? s.attachNames
        : (s.attachments || []).map(function (f) { return f.name; })
    };
  });
}

// Like studioTz_, but a preview never changes the saved timezone.
function mcpTz_(tz) {
  return TIMEZONE_CHOICES.some(function (c) { return c.value === tz; }) ? tz : getPreferredTz_();
}


// ───────── Recipient control ─────────────────────────────────────

const REPLY_MODES = ['last_sender', 'reply_all', 'custom'];

function mcpReplyMode_(m) {
  const mode = String(m || 'last_sender');
  if (REPLY_MODES.indexOf(mode) === -1) throw new Error('reply_mode must be one of: ' + REPLY_MODES.join(', ') + '.');
  return mode;
}

// Addresses from an array or a comma/semicolon/newline separated string, each
// bare or "Name <email>". Throws naming any that aren't valid.
function mcpAddressList_(value, field) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[;\n]|,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const out = [], bad = [], seen = {};
  items.forEach(function (raw) {
    const s = String(raw || '').trim();
    if (!s) return;
    const a = parseAddress_(s);
    if (!isValidEmail_(a.email)) { bad.push(s); return; }
    const k = a.email.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push(formatAddress_({ name: a.name.replace(/^"|"$/g, ''), email: a.email }));
  });
  if (bad.length) throw new Error('Not a valid email address in ' + field + ': ' + bad.join(', '));
  return out;
}

// stop_on_reply_from: domains ("jotun.com") or addresses.
function mcpStopList_(value) {
  const items = Array.isArray(value) ? value : (value ? String(value).split(/[,;\s]+/) : []);
  return items.map(function (x) { return String(x || '').trim().toLowerCase().replace(/^@/, ''); })
    .filter(String)
    .map(function (x) {
      if (x.indexOf('@') !== -1 ? !isValidEmail_(x) : !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)) {
        throw new Error('stop_on_reply_from: "' + x + '" is not a domain (like jotun.com) or an email address.');
      }
      return x;
    });
}

const has_ = function (o, k) { return !!o && o[k] !== undefined && o[k] !== null; };

// Works out reply mode, stop rules and, in custom mode, each step's final
// To/Cc/Bcc. Returns { mode, stopOnReplyFrom, stopOnAnyReply, steps }.
function mcpRecipientPlan_(p, steps, seq) {
  const mode = mcpReplyMode_(p.replyMode || seq.replyMode);
  const callSet = ['to', 'cc', 'bcc'].some(function (k) { return has_(p, k); }) ||
    steps.some(function (s) { return ['to', 'cc', 'bcc'].some(function (k) { return has_(s.override, k); }); });
  if (callSet && mode !== 'custom') {
    throw new Error('to, cc and bcc need reply_mode: "custom". Add it, or leave them out to reply to ' +
      (mode === 'reply_all' ? 'everyone on the latest message.' : 'the last person outside your company who wrote.'));
  }
  const stopOn = mcpStopList_(has_(p, 'stopOnReplyFrom') ? p.stopOnReplyFrom : seq.stopOnReplyFrom);
  const anyReply = !!p.stopOnAnyReply;
  const baseTo = mcpAddressList_(p.to, 'to');
  const baseCc = has_(p, 'cc') ? mcpAddressList_(p.cc, 'cc') : mcpAddressList_(seq.cc || '', 'the sequence\'s cc');
  const baseBcc = has_(p, 'bcc') ? mcpAddressList_(p.bcc, 'bcc') : mcpAddressList_(seq.bcc || '', 'the sequence\'s bcc');
  const out = steps.map(function (s, i) {
    const o = s.override || {};
    const step = {};
    Object.keys(s).forEach(function (k) { if (k !== 'override') step[k] = s[k]; });
    step.replyMode = mode;
    step.stopOnReplyFrom = stopOn;
    if (anyReply) step.stopOnAnyReply = true;
    if (mode === 'custom') {
      const n = 'follow-up ' + (i + 1);
      const to = has_(o, 'to') ? mcpAddressList_(o.to, n + ' to') : baseTo;
      if (!to.length) throw new Error('reply_mode "custom" needs at least one address in to' + (has_(o, 'to') ? ' (' + n + ' has an empty to).' : '.'));
      const cc = has_(o, 'cc') ? mcpAddressList_(o.cc, n + ' cc') : mcpAddressList_(mergeRecipients_(baseCc.join(', '), s.cc || ''), n + ' cc');
      const bcc = has_(o, 'bcc') ? mcpAddressList_(o.bcc, n + ' bcc') : mcpAddressList_(mergeRecipients_(baseBcc.join(', '), s.bcc || ''), n + ' bcc');
      step.exactRecipients = true;
      step.to = to.join(', ');
      step.cc = cc.join(', ');
      step.bcc = bcc.join(', ');
    }
    return step;
  });
  return { mode: mode, stopOnReplyFrom: stopOn, stopOnAnyReply: anyReply, steps: out };
}

// Per-step cc/bcc from the MCP (override lists) become the usual step cc/bcc
// strings, added to the campaign's. A per-step to makes no sense here.
function mcpAdditiveStepRecipients_(steps, where) {
  return (steps || []).map(function (s, i) {
    const o = s.override || {};
    if (has_(o, 'to')) throw new Error('Follow-up ' + (i + 1) + ': a per-follow-up "to" only works in start_sequence_on_thread, not ' + where + '.');
    const step = {};
    Object.keys(s).forEach(function (k) { if (k !== 'override') step[k] = s[k]; });
    if (has_(o, 'cc')) step.cc = mergeRecipients_(s.cc || '', mcpAddressList_(o.cc, 'follow-up ' + (i + 1) + ' cc').join(', '));
    if (has_(o, 'bcc')) step.bcc = mergeRecipients_(s.bcc || '', mcpAddressList_(o.bcc, 'follow-up ' + (i + 1) + ' bcc').join(', '));
    return step;
  });
}
