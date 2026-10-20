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
  return h;
}

function mcpListSequences() {
  return studioSequences_();
}

function mcpListCampaigns() {
  return studioCampaigns_();
}

function mcpListSentThreads(query) {
  return studioListThreads(query);
}

// p: { recipients, subject, body, sequence?, followUps?, campaignName, cc, bcc, tz, confirm }
// followUps are draft-shaped steps; sequence is a saved sequence's name whose
// follow-ups are used instead.
function mcpSendCampaign(p) {
  p = p || {};
  const steps = mcpCampaignSteps_(p);
  if (!p.confirm) return mcpCampaignPreview_(p, steps);
  const res = studioSendCampaign({
    recipients: p.recipients, subject: p.subject, body: p.body, followUps: steps,
    campaignName: p.campaignName, cc: p.cc, bcc: p.bcc, tz: p.tz
  });
  delete res.campaigns;
  return res;
}

// p: { threadId, sequence, tz, confirm }
function mcpStartSequenceOnThread(p) {
  p = p || {};
  const name = String(p.sequence || '');
  const seq = getSequence_(name);
  if (!seq || !Array.isArray(seq.steps) || seq.steps.length === 0) {
    throw new Error('Sequence "' + name + '" not found or has no follow-ups. Use list_sequences to see the names.');
  }
  const steps = seq.steps.slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
  const opts = {
    threadId: p.threadId, followUps: steps, tz: p.tz, campaignName: name,
    recipients: seq.recipients || '', cc: seq.cc || '', bcc: seq.bcc || ''
  };
  if (p.confirm) {
    const res = studioScheduleOnThread(opts);
    return { scheduled: true, thread: res.thread, schedulerOk: res.schedulerOk };
  }

  const thread = studioGetThread(p.threadId);
  const tz = mcpTz_(p.tz);
  const warnings = [];
  if (CONFIG.dryRun) warnings.push('Test mode is on (CONFIG.dryRun): follow-ups will be logged, not sent.');
  if (schedulerTriggers_().length === 0) {
    warnings.push('Sending is switched off, so follow-ups won\'t go out. Open the sidebar or Studio to fix the scheduler first.');
  }
  if (!thread.lastFromMe) {
    warnings.push('The last message on this thread is from ' + thread.lastFrom + ', not you. Follow-ups set to "if no reply" will not send.');
  }
  if (thread.queue.length) {
    warnings.push('This thread already has ' + thread.queue.length + ' follow-up(s) queued. These are added on top.');
  }
  const vars = { firstName: recipientFirstName_(parseAddress_(thread.recipient).name) || 'there' };
  return {
    preview: true,
    thread: { threadId: thread.threadId, subject: thread.subject, recipient: thread.recipient, permalink: thread.permalink },
    followUps: mcpScheduleLabels_(steps, tz, vars),
    warnings: warnings
  };
}

// Without confirm: what stopping would cancel. With confirm: stop it.
function mcpStopCampaign(threadId, confirm) {
  const id = String(threadId || '');
  const queue = id ? getQueueForThread_(id) : [];
  if (!queue.length) throw new Error('Nothing is scheduled on that thread. Use list_campaigns to see what is running.');
  if (!confirm) {
    const c = studioCampaigns_().filter(function (x) { return x.threadId === id; })[0] || {};
    return {
      preview: true,
      threadId: id,
      campaignName: c.campaignName || '',
      subject: c.subject || '',
      recipient: c.recipient || '',
      cancels: queue.map(function (s) {
        return { when: formatLocal_(s.sendAt, s.tz), condition: conditionLabel_(s.condition),
                 message: String(s.message || CONFIG.defaultTemplate).replace(/\s+/g, ' ').substring(0, 200) };
      })
    };
  }
  studioCancelCampaign(id);
  return { stopped: true, threadId: id, cancelled: queue.length };
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
    followUps: mcpScheduleLabels_(steps, tz, vars),
    timezone: tz,
    warnings: ncWarnings_(d, recips, steps)
  };
}

// When each step would go out if started now, plus its rendered message.
function mcpScheduleLabels_(steps, tz, vars) {
  let prev = Date.now();
  return steps.map(function (s) {
    if (s.sendAtAbs > 0) {
      const wall = Utilities.formatDate(new Date(s.sendAtAbs), 'UTC', 'yyyy-MM-dd HH:mm');
      prev = Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm').getTime();
    } else {
      prev = computeStepSendAt_(prev, s.amount, s.unit, s.atTime, tz);
    }
    return {
      when: 'About ' + formatLocal_(prev, tz),
      condition: conditionLabel_(s.condition),
      message: renderPlaceholders_(s.message || CONFIG.defaultTemplate, vars)
    };
  });
}

// Like studioTz_, but a preview never changes the saved timezone.
function mcpTz_(tz) {
  return TIMEZONE_CHOICES.some(function (c) { return c.value === tz; }) ? tz : getPreferredTz_();
}
