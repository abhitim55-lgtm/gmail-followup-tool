// =================================================================
// Gmail sidebar screens. Everything the team needs, without leaving Gmail:
//
//   Home ─┬─ New campaign            write an email to new people + follow-ups
//         ├─ Follow up on a sent email   pick a thread, Start a sequence
//         ├─ Sequences ── editor     write follow-ups once, reuse them
//         ├─ Settings                name, signature, timezone, status, team
//         └─ Scheduled list          everything queued, Open / Cancel
//
// The Follow-up Studio (Studio.gs) has the same features full-page; the home
// screen links to it. Add-ons can't put an item in Gmail's left navigation —
// the chrome-extension/ folder does that, opening the Studio inside Gmail.
// The FU/Custom label is the left-nav view of every thread with follow-ups.
// =================================================================

// Add-on actions time out after ~30 s, and each send + schedule takes ~2 s.
const SIDEBAR_MAX_RECIPIENTS = 10;
const NC_DRAFT_KEY = 'nc_draft';
const SEQ_EDIT_KEY = 'seq_edit';


// ───────── Navigation helpers ────────────────────────────────────

function push_(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

function update_(card, msg) {
  const b = CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card));
  if (msg) b.setNotification(CardService.newNotification().setText(msg));
  return b.build();
}

// The screen an action should redraw, from its `from` parameter.
function screenFor_(e) {
  const from = e && e.parameters && e.parameters.from;
  return from === 'settings' ? buildSettingsCard_() : buildDashboardCard_();
}

// ───────── Look & feel ───────────────────────────────────────────
//
// The sidebar mirrors the Follow-ups page (StudioPage.html): same name, same
// Gmail blue, same Material icons and menu labels, same status line.

const BRAND_BLUE = '#0b57d0';

// A Material icon (same set as the Follow-ups page), in the page's blue.
// Served as a PNG from Google's icon CDN: CardService's MaterialIcon renders
// through an icon font that Gmail's add-on frame doesn't load, so it showed
// the icon's name ("account_tree") instead of the icon. `legacy` is unused
// now but documents the closest built-in icon.
function icon_(name, legacy) {
  return CardService.newIconImage()
    .setIconUrl('https://www.gstatic.com/images/icons/material/system/2x/' + name + '_googblue_24dp.png');
}

// Filled button in the page's blue.
function blueButton_(text) {
  return CardService.newTextButton()
    .setText(text)
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor(BRAND_BLUE);
}

function navRow_(title, subtitle, icon, fn, params) {
  const action = CardService.newAction().setFunctionName(fn);
  if (params) action.setParameters(params);
  return CardService.newDecoratedText()
    .setText(title)
    .setBottomLabel(subtitle)
    .setWrapText(true)
    .setStartIcon(icon)
    .setOnClickAction(action);
}

// "● Follow-ups are on · Checks every 5 min · last 2m ago", as on the page.
function statusSection_() {
  const running = schedulerTriggers_().length > 0;
  const lastRun = getLastRunSummary_();
  const interval = normalizeInterval_(CONFIG.triggerIntervalMinutes);
  return CardService.newCardSection().addWidget(
    CardService.newDecoratedText()
      .setText(running ? '<font color="#146c2e">●</font> <b>Follow-ups are on</b>'
        : '<font color="#b3261e">●</font> <b>Follow-ups are off</b>')
      .setBottomLabel(running
        ? 'Checks every ' + interval + ' min' + (lastRun ? ' · last ' + humanDelta_(Date.now() - lastRun.at) + ' ago' : '')
        : 'Nothing will send. Open Settings and tap Fix scheduler.')
      .setWrapText(true)
      .setOnClickAction(CardService.newAction().setFunctionName('actionOpenSettings'))
  );
}

function grey_(html) {
  return CardService.newTextParagraph().setText('<font color="#5f6368">' + html + '</font>');
}

function screenHeader_(title, subtitle) {
  const h = CardService.newCardHeader()
    .setTitle(title)
    .setImageUrl(ICON_URL_)
    .setImageStyle(CardService.ImageStyle.CIRCLE);
  if (subtitle) h.setSubtitle(subtitle);
  return h;
}


// ───────── Home ──────────────────────────────────────────────────

function buildDashboardCard_() {
  const items = collectCampaigns_();
  const account = getRunningEmail_();
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_('Follow-ups', account || ''));

  const alert = buildHomeAlert_(items);
  if (alert) card.addSection(alert);

  const seqCount = listSequences_().length;
  if (seqCount === 0 && items.length === 0) {
    card.addSection(
      CardService.newCardSection()
        .setHeader('Getting started')
        .addWidget(CardService.newTextParagraph().setText(
          '<b>1.</b> Check your name and signature in <b>Settings</b>.<br>' +
          '<b>2.</b> Write a <b>sequence</b>: the follow-ups to send if someone doesn\'t reply.<br>' +
          '<b>3.</b> Start a <b>New campaign</b>, or open any email you sent and tap <b>Start</b>.<br><br>' +
          '<font color="#5f6368">Follow-ups reply on the same thread and stop by themselves the moment they reply. ' +
          'You always see a review screen before anything is sent.</font>'))
        .addWidget(CardService.newTextButton().setText('Write my first sequence')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor(BRAND_BLUE)
          .setOnClickAction(CardService.newAction().setFunctionName('actionOpenSequenceEditor')
            .setParameters({ returnTo: 'list' })))
    );
  }
  // Same menu, labels and icons as the Follow-ups page's right rail.
  const studioUrl = getStudioUrl_();
  const menu = CardService.newCardSection();
  menu.addWidget(navRow_('Follow up a sent email',
    'Pick an email you already sent and start follow-ups on it.',
    icon_('forward_to_inbox', 'INVITE'), 'actionOpenSentThreads'));
  menu.addWidget(navRow_('Sequences',
    (seqCount ? seqCount + ' saved · ' : '') + 'Write your follow-ups once, reuse them anywhere.',
    icon_('account_tree', 'BOOKMARK'), 'actionOpenSequences'));
  menu.addWidget(navRow_('Settings',
    'Your name, signature, timezone, and whether sending works.',
    icon_('settings', 'DESCRIPTION'), 'actionOpenSettings'));
  if (studioUrl) {
    menu.addWidget(
      CardService.newDecoratedText()
        .setText('Open the full page')
        .setBottomLabel('Campaign reports, Autopilot and more room. Also under Follow-ups in Gmail\'s left menu.')
        .setWrapText(true)
        .setStartIcon(icon_('open_in_new', 'STAR'))
        .setOpenLink(CardService.newOpenLink().setUrl(studioUrl))
    );
  }
  card.addSection(menu);

  const queued = items.reduce(function (n, it) { return n + it.stepCount; }, 0);
  const list = CardService.newCardSection()
    .setHeader(items.length
      ? 'Campaigns · ' + items.length + (items.length === 1 ? ' email' : ' emails') +
        ', ' + queued + (queued === 1 ? ' follow-up' : ' follow-ups') + ' queued'
      : 'Campaigns');
  if (items.length === 0) {
    list.addWidget(grey_('Nothing scheduled yet. Start a <b>New campaign</b>, or open ' +
      'any email you sent and tap <b>Start</b> on a sequence.'));
  }
  items.forEach(function (it, idx) {
    const due = it.nextSendAt - Date.now();
    const status = due > 0 ? 'in ' + humanDelta_(due) : Math.abs(Math.round(due / 60000)) + 'm overdue';
    const displayTitle = it.campaignName ? it.campaignName + ' — ' + it.subject : it.subject;
    list.addWidget(
      CardService.newDecoratedText()
        .setTopLabel(it.stepCount + (it.stepCount === 1 ? ' follow-up' : ' follow-ups') + ' left · next ' + status)
        .setText(escapeHtml_(displayTitle))
        .setBottomLabel(escapeHtml_(formatLocal_(it.nextSendAt, it.tz) + (it.to ? ' → ' + it.to.substring(0, 50) : '')))
        .setWrapText(true)
        .setStartIcon(icon_('schedule_send', 'CLOCK'))
        .setOnClickAction(
          CardService.newAction().setFunctionName('actionOpenThreadCard').setParameters({ threadId: it.threadId })
        )
    );
    list.addWidget(
      CardService.newButtonSet()
        .addButton(CardService.newTextButton().setText('Open email')
          .setOpenLink(CardService.newOpenLink().setUrl(it.permalink)))
        .addButton(CardService.newTextButton().setText('Stop follow-ups')
          .setOnClickAction(CardService.newAction().setFunctionName('actionAskStop')
            .setParameters({ threadId: it.threadId, from: 'home' })))
    );
    if (idx < items.length - 1) list.addWidget(CardService.newDivider());
  });
  list.addWidget(
    CardService.newTextButton()
      .setText('Refresh')
      .setOnClickAction(CardService.newAction().setFunctionName('actionRefreshDashboard'))
  );
  card.addSection(list);
  card.addSection(statusSection_());

  card.setFixedFooter(
    CardService.newFixedFooter().setPrimaryButton(
      blueButton_('New campaign')
        .setOnClickAction(CardService.newAction().setFunctionName('actionOpenNewCampaign'))
    )
  );
  return card.build();
}

// Only shown when something is wrong; a healthy home screen stays quiet.
function buildHomeAlert_(items) {
  const running = schedulerTriggers_().length > 0;
  const lastRun = getLastRunSummary_();
  const overdue = items.filter(function (it) { return it.nextSendAt < Date.now() - 120000; });
  let text, button;
  if (!running) {
    text = '<font color="#d93025"><b>Sending is switched off.</b></font> Follow-ups won\'t go out until you fix it.';
    button = CardService.newTextButton().setText('Fix it')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor(BRAND_BLUE)
      .setOnClickAction(CardService.newAction().setFunctionName('actionFixScheduler').setParameters({ from: 'home' }));
  } else if (lastRun && lastRun.errors && lastRun.errors.length) {
    text = '<font color="#d93025"><b>' + lastRun.errors.length + ' follow-up(s) failed</b></font> on the last check: ' +
      escapeHtml_(String(lastRun.errors[0]).substring(0, 160));
    button = CardService.newTextButton().setText('Details')
      .setOnClickAction(CardService.newAction().setFunctionName('actionOpenSettings'));
  } else if (overdue.length) {
    text = '<font color="#d93025">' + overdue.length + ' follow-up(s) are past due.</font>';
    button = CardService.newTextButton().setText('Send them now')
      .setOnClickAction(CardService.newAction().setFunctionName('actionRunNow').setParameters({ from: 'home' }));
  } else {
    return null;
  }
  return CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(text))
    .addWidget(button);
}

function actionOpenNewCampaign() { return push_(buildNewCampaignCard_()); }
function actionOpenSentThreads() { return push_(buildSentThreadsCard_('')); }
function actionOpenSequences() { return push_(buildSequencesCard_()); }
function actionOpenSettings() { return push_(buildSettingsCard_()); }


// ───────── New campaign ──────────────────────────────────────────

function getNcDraft_() {
  const blank = { recipients: '', subject: '', body: '', sequence: '', campaignName: '', cc: '', bcc: '' };
  try {
    const d = JSON.parse(PropertiesService.getUserProperties().getProperty(NC_DRAFT_KEY) || 'null');
    if (d) Object.keys(blank).forEach(function (k) { if (typeof d[k] === 'string') blank[k] = d[k]; });
  } catch (e) {}
  return blank;
}

function setNcDraft_(d) {
  PropertiesService.getUserProperties().setProperty(NC_DRAFT_KEY, JSON.stringify(d));
}

function readNcForm_(e) {
  const f = (e && e.formInput) || {};
  return {
    recipients: String(f.ncTo || '').trim(),
    subject: String(f.ncSubject || '').trim(),
    body: String(f.ncBody || '').replace(/^\s*\n/, '').replace(/\s+$/, ''),
    sequence: readSelectionInput_(e, 'ncSequence'),
    campaignName: String(f.ncName || '').trim(),
    cc: String(f.ncCc || '').trim(),
    bcc: String(f.ncBcc || '').trim()
  };
}

// "3 days later, at 9:00 AM · if no reply"
function stepTimingLabel_(s, idx) {
  const unit = s.amount === 1 ? s.unit.replace(/s$/, '') : s.unit;
  const at = AT_TIME_OPTIONS.filter(function (o) { return o.value && o.value === s.atTime; })[0];
  return s.amount + ' ' + unit + ' after ' + (idx === 0 ? 'the first email' : 'follow-up ' + idx) +
    (at ? ', at ' + at.label : '') + ' · ' + conditionLabel_(s.condition);
}

function buildNewCampaignCard_() {
  const d = getNcDraft_();
  const seqs = studioSequences_();
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_('New campaign', 'Everyone gets their own email thread'));

  const main = CardService.newCardSection();
  main.addWidget(
    CardService.newTextInput()
      .setFieldName('ncTo')
      .setTitle('To')
      .setMultiline(true)
      .setValue(d.recipients)
      .setHint('One per line or comma-separated, up to ' + SIDEBAR_MAX_RECIPIENTS +
        '. "Jane Doe <jane@acme.com>" fills {firstName}.')
  );
  main.addWidget(CardService.newTextInput().setFieldName('ncSubject').setTitle('Subject').setValue(d.subject));
  main.addWidget(
    CardService.newTextInput()
      .setFieldName('ncBody')
      .setTitle('Email')
      .setMultiline(true)
      .setValue(d.body || '\n\n\n')
      .setHint('{firstName} and {senderFirstName} get filled in. Your signature is added automatically.')
  );
  card.addSection(main);

  const fu = CardService.newCardSection().setHeader('Follow-ups');
  if (seqs.length === 0) {
    fu.addWidget(grey_('No sequences yet. A sequence is your follow-up emails, e.g. ' +
      '"bump after 3 days, again after 7". Write one once and pick it here every time.'));
    fu.addWidget(
      CardService.newTextButton()
        .setText('Write a sequence')
        .setOnClickAction(CardService.newAction().setFunctionName('actionNcNewSequence'))
    );
  } else {
    const dd = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('ncSequence')
      .setTitle('If they don\'t reply, send')
      .addItem('No follow-ups', '', !d.sequence)
      .setOnChangeAction(CardService.newAction().setFunctionName('actionNcPickSequence'));
    seqs.forEach(function (s) {
      dd.addItem(s.name + ' — ' + describeSequence_(s.steps), s.name, s.name === d.sequence);
    });
    fu.addWidget(dd);
    const picked = seqs.filter(function (s) { return s.name === d.sequence; })[0];
    if (picked) {
      picked.steps.forEach(function (s, i) {
        fu.addWidget(
          CardService.newDecoratedText()
            .setTopLabel(escapeHtml_(stepTimingLabel_(s, i)))
            .setText(escapeHtml_((s.message || '(default bump message)').replace(/\s+/g, ' ').substring(0, 160)))
            .setWrapText(true)
        );
      });
      fu.addWidget(grey_('Follow-ups reply on the same thread and stop the moment they reply.'));
    }
  }
  card.addSection(fu);

  const more = CardService.newCardSection()
    .setHeader('More options')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  more.addWidget(CardService.newTextInput().setFieldName('ncName').setTitle('Campaign name (optional)')
    .setValue(d.campaignName).setHint('Shown in the Scheduled list on the home screen.'));
  more.addWidget(CardService.newTextInput().setFieldName('ncCc').setTitle('Cc (every email)').setValue(d.cc));
  more.addWidget(CardService.newTextInput().setFieldName('ncBcc').setTitle('Bcc (every email)').setValue(d.bcc));
  card.addSection(more);

  card.setFixedFooter(
    CardService.newFixedFooter()
      .setPrimaryButton(
        CardService.newTextButton().setBackgroundColor(BRAND_BLUE).setText('Review & send')
          .setOnClickAction(CardService.newAction().setFunctionName('actionNcReview'))
      )
      .setSecondaryButton(
        CardService.newTextButton().setText('Send me a test')
          .setOnClickAction(CardService.newAction().setFunctionName('actionNcTest'))
      )
  );
  return card.build();
}

// Picking a sequence pre-fills an empty subject/email from it.
function actionNcPickSequence(e) {
  const d = readNcForm_(e);
  const seq = d.sequence ? getSequence_(d.sequence) : null;
  if (seq) {
    if (!d.subject && seq.subject) d.subject = String(seq.subject);
    if (!d.body && seq.firstMessage) d.body = String(seq.firstMessage);
  }
  setNcDraft_(d);
  return update_(buildNewCampaignCard_());
}

function actionNcNewSequence(e) {
  setNcDraft_(readNcForm_(e));
  return openSequenceEditor_('', { returnTo: 'nc' });
}

function actionNcTest(e) {
  const d = readNcForm_(e);
  setNcDraft_(d);
  if (!d.subject || !d.body) return notify_('Write a subject and an email first.');
  const me = getRunningEmail_();
  if (!me) return notify_('Could not detect your Gmail address. Reopen the add-on.');
  const first = parseRecipientInput_(d.recipients)[0];
  const vars = { firstName: first ? (recipientFirstName_(first.name) || 'there') : 'there' };
  if (CONFIG.dryRun) return notify_('Dry run is on (CONFIG.dryRun) — test not sent.');
  try {
    sendNewMessage_({
      to: me,
      subject: '[Test] ' + renderPlaceholders_(d.subject, vars),
      body: applySignatureToBody_(renderPlaceholders_(d.body, vars))
    });
  } catch (err) {
    return notify_('Test failed: ' + ((err && err.message) || err));
  }
  return notify_('Test sent to ' + me + (first ? ', written as if to ' + first.email : '') + '.');
}

// Checks that block sending. Returns an error message, or '' if OK.
function ncBlocker_(d) {
  if (!d.recipients) return 'Add at least one email address in To.';
  const count = parseRecipientInput_(d.recipients).length;
  if (count === 0) return 'No valid email address in To. Use jane@acme.com or Jane Doe <jane@acme.com>.';
  if (count > SIDEBAR_MAX_RECIPIENTS) {
    return 'Up to ' + SIDEBAR_MAX_RECIPIENTS + ' people per send — you added ' + count +
      '. Send the first ' + SIDEBAR_MAX_RECIPIENTS + ', then the rest (or use the Studio).';
  }
  if (!d.subject) return 'Add a subject.';
  if (!d.body) return 'Write the email.';
  if (d.sequence && !getSequence_(d.sequence)) return 'The sequence "' + d.sequence + '" no longer exists. Pick another.';
  return '';
}

function ncFollowUps_(d) {
  const seq = d.sequence ? getSequence_(d.sequence) : null;
  return seq ? (seq.steps || []).slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_) : [];
}

// Things worth a second look but not blocking: shown on the review screen.
function ncWarnings_(d, recips, steps) {
  const w = [];
  if (CONFIG.dryRun) w.push('Test mode is on (CONFIG.dryRun): nothing will actually be sent.');
  if (steps.length && schedulerTriggers_().length === 0) {
    w.push('Sending is switched off, so follow-ups won\'t go out. Go to Settings → Fix scheduler first.');
  }
  if (!steps.length) w.push('No follow-ups picked. They\'ll only get this first email.');
  const skipped = String(d.recipients).split(/[\n,;]+/).map(function (t) { return t.trim(); })
    .filter(function (t) {
      return t && !recips.some(function (r) { return t.toLowerCase().indexOf(r.email.toLowerCase()) !== -1; });
    });
  if (skipped.length) w.push('Skipped, not a valid email: ' + skipped.slice(0, 5).join(', '));
  const allText = [d.subject, d.body].concat(steps.map(function (s) { return s.message; })).join('\n');
  if (/\{firstName\}/.test(allText)) {
    const noName = recips.filter(function (r) { return !recipientFirstName_(r.name); }).length;
    if (noName) w.push(noName + ' of ' + recips.length + ' have no name, so {firstName} will say "there" for them.');
  }
  const unknown = (allText.match(/\{[A-Za-z_]+\}/g) || []).filter(function (p, i, a) {
    return a.indexOf(p) === i && p !== '{firstName}' && p !== '{senderFirstName}';
  });
  if (unknown.length) w.push(unknown.join(', ') + ' won\'t be filled in. It will appear exactly as typed.');
  steps.forEach(function (s, i) {
    if (!s.message) w.push('Follow-up ' + (i + 1) + ' has no message, so it sends the default: "' +
      CONFIG.defaultTemplate.replace(/\s+/g, ' ').substring(0, 60) + '…"');
  });
  recips.forEach(function (r) {
    try {
      if (GmailApp.search('in:sent to:' + r.email + ' newer_than:14d', 0, 1).length) {
        w.push('You already emailed ' + r.email + ' in the last 14 days.');
      }
    } catch (err) {}
  });
  if (!getSignature_()) w.push('You have no signature set (Settings).');
  return w;
}

function actionNcReview(e) {
  const d = readNcForm_(e);
  setNcDraft_(d);
  const blocker = ncBlocker_(d);
  if (blocker) return notify_(blocker);
  return push_(buildNcReviewCard_(d));
}

function buildNcReviewCard_(d) {
  const recips = parseRecipientInput_(d.recipients);
  const steps = ncFollowUps_(d);
  const tz = getPreferredTz_();
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_('Check before sending', recips.length + (recips.length === 1 ? ' person' : ' people') +
      (steps.length ? ' · ' + steps.length + ' follow-up(s) each' : ' · no follow-ups')));

  const warnings = ncWarnings_(d, recips, steps);
  if (warnings.length) {
    const ws = CardService.newCardSection().setHeader('Please check');
    warnings.forEach(function (t) {
      ws.addWidget(CardService.newTextParagraph().setText('<font color="#b06000">⚠ ' + escapeHtml_(t) + '</font>'));
    });
    card.addSection(ws);
  }

  const to = CardService.newCardSection().setHeader('To');
  to.addWidget(CardService.newTextParagraph().setText(recips.map(function (r) {
    return escapeHtml_(r.name ? r.name + ' <' + r.email + '>' : r.email);
  }).join('<br>')));
  card.addSection(to);

  const first = recips[0];
  const vars = { firstName: recipientFirstName_(first.name) || 'there' };
  card.addSection(
    CardService.newCardSection()
      .setHeader('First email, as ' + (first.name || first.email) + ' will see it')
      .addWidget(CardService.newTextParagraph().setText(
        '<b>' + escapeHtml_(renderPlaceholders_(d.subject, vars)) + '</b><br><br>' +
        escapeHtml_(applySignatureToBody_(renderPlaceholders_(d.body, vars))).replace(/\n/g, '<br>')))
  );

  if (steps.length) {
    const fu = CardService.newCardSection().setHeader('Then, on the same thread');
    let prev = Date.now();
    steps.forEach(function (s) {
      prev = computeStepSendAt_(prev, s.amount, s.unit, s.atTime, tz);
      fu.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('About ' + formatLocal_(prev, tz) + ' · ' + conditionLabel_(s.condition))
          .setText(escapeHtml_(renderPlaceholders_(s.message || CONFIG.defaultTemplate, vars).replace(/\s+/g, ' ').substring(0, 200)))
          .setWrapText(true)
      );
    });
    fu.addWidget(grey_('Stops by itself the moment they reply. You can stop it any time from the home screen.'));
    card.addSection(fu);
  }

  card.setFixedFooter(
    CardService.newFixedFooter()
      .setPrimaryButton(CardService.newTextButton().setBackgroundColor(BRAND_BLUE)
        .setText('Send to ' + recips.length + (recips.length === 1 ? ' person' : ' people'))
        .setOnClickAction(CardService.newAction().setFunctionName('actionNcSend')))
      .setSecondaryButton(CardService.newTextButton().setText('Back to edit')
        .setOnClickAction(CardService.newAction().setFunctionName('actionPop')))
  );
  return card.build();
}

function actionPop() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popCard())
    .build();
}

// Fired from the review card, so it works off the saved draft.
function actionNcSend() {
  const d = getNcDraft_();
  const blocker = ncBlocker_(d);
  if (blocker) return notify_(blocker);
  const followUps = ncFollowUps_(d);

  let res;
  try {
    res = studioSendCampaign({
      recipients: d.recipients, subject: d.subject, body: d.body, followUps: followUps,
      campaignName: d.campaignName, cc: d.cc, bcc: d.bcc, tz: getPreferredTz_()
    });
  } catch (err) {
    return notify_(String((err && err.message) || err));
  }

  if (res.failed.length) {
    // Keep only the addresses that failed, so "Send" again can't double-send.
    d.recipients = res.failed.map(function (f) { return f.email; }).join('\n');
    setNcDraft_(d);
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().popCard().updateCard(buildNewCampaignCard_()))
      .setNotification(CardService.newNotification().setText(
      'Sent to ' + res.sent + '. ' + res.failed.length + ' failed (left in To): ' + res.failed[0].error))
      .build();
  }

  PropertiesService.getUserProperties().deleteProperty(NC_DRAFT_KEY);
  let msg = res.dryRun
    ? 'Dry run (CONFIG.dryRun) — nothing was sent.'
    : 'Sent to ' + res.sent + (res.sent === 1 ? ' person' : ' people') +
      (followUps.length ? ', ' + followUps.length + ' follow-up(s) each scheduled' : '') + '.';
  if (res.notArmed.length) {
    msg += ' Follow-ups could NOT be scheduled for ' + res.notArmed.length +
      ' — open those emails and tap Start.';
  } else if (followUps.length && !res.schedulerOk) {
    msg += ' But sending is switched off — tap "Fix it" on the home screen.';
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(msg))
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildDashboardCard_()))
    .build();
}


// ───────── Follow up on a sent email ─────────────────────────────

function buildSentThreadsCard_(query) {
  let threads = [], error = '';
  try { threads = studioListThreads(query); } catch (err) { error = String((err && err.message) || err); }
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_('Follow up on a sent email', 'Tap an email to start follow-ups'));

  const search = CardService.newCardSection();
  search.addWidget(
    CardService.newTextInput()
      .setFieldName('stQuery')
      .setTitle('Search sent mail')
      .setValue(query || '')
      .setHint('e.g. jane@acme.com, or subject:pricing. Blank = last 30 days.')
  );
  search.addWidget(
    CardService.newTextButton().setText('Search')
      .setOnClickAction(CardService.newAction().setFunctionName('actionSentSearch'))
  );
  card.addSection(search);

  const list = CardService.newCardSection();
  if (error) list.addWidget(CardService.newTextParagraph().setText('<font color="#d93025">' + escapeHtml_(error) + '</font>'));
  else if (threads.length === 0) list.addWidget(grey_('No sent emails found.'));
  threads.forEach(function (t) {
    // Top labels are plain text; no colour markup there.
    const state = t.armed ? 'Follow-ups scheduled' : t.waiting ? 'No reply yet' : 'They replied';
    list.addWidget(
      CardService.newDecoratedText()
        .setTopLabel(state + ' · ' + t.lastLabel)
        .setText(escapeHtml_(t.subject))
        .setBottomLabel(escapeHtml_(t.recipient))
        .setWrapText(true)
        .setOnClickAction(
          CardService.newAction().setFunctionName('actionOpenThreadCard').setParameters({ threadId: t.threadId })
        )
    );
  });
  card.addSection(list);
  return card.build();
}

function actionSentSearch(e) {
  const q = String(((e && e.formInput) || {}).stQuery || '').trim();
  return update_(buildSentThreadsCard_(q));
}


// ───────── Sequences ─────────────────────────────────────────────

function buildSequencesCard_() {
  const seqs = studioSequences_();
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_('Sequences', 'Follow-up emails you write once and reuse'));
  const list = CardService.newCardSection();
  if (seqs.length === 0) {
    list.addWidget(grey_('A sequence is a set of follow-ups — e.g. "bump after 3 days, again after 7". ' +
      'Write it once, then start it on any email with one click.'));
  }
  seqs.forEach(function (s) {
    const first = (s.steps[0] && s.steps[0].message) || '';
    list.addWidget(
      CardService.newDecoratedText()
        .setTopLabel(escapeHtml_(describeSequence_(s.steps)))
        .setText('<b>' + escapeHtml_(s.name) + '</b>')
        .setBottomLabel(escapeHtml_(first.replace(/\s+/g, ' ').substring(0, 80)))
        .setWrapText(true)
        .setButton(
          CardService.newTextButton().setText('Edit')
            .setOnClickAction(CardService.newAction().setFunctionName('actionOpenSequenceEditor')
              .setParameters({ name: s.name, returnTo: 'list' }))
        )
    );
  });
  card.addSection(list);
  card.setFixedFooter(
    CardService.newFixedFooter().setPrimaryButton(
      CardService.newTextButton().setBackgroundColor(BRAND_BLUE).setText('New sequence')
        .setOnClickAction(CardService.newAction().setFunctionName('actionOpenSequenceEditor')
          .setParameters({ returnTo: 'list' }))
    )
  );
  return card.build();
}

function getSeqEdit_() {
  try {
    const ed = JSON.parse(PropertiesService.getUserProperties().getProperty(SEQ_EDIT_KEY) || 'null');
    if (ed && Array.isArray(ed.steps) && ed.steps.length) return ed;
  } catch (e) {}
  return { originalName: '', name: '', subject: '', firstMessage: '', steps: [normalizeSeqStep_({})], returnTo: 'list', threadId: '' };
}

function setSeqEdit_(ed) {
  PropertiesService.getUserProperties().setProperty(SEQ_EDIT_KEY, JSON.stringify(ed));
}

// params: { name?, returnTo: 'list' | 'nc' | 'thread', threadId? }
function actionOpenSequenceEditor(e) {
  const p = (e && e.parameters) || {};
  return openSequenceEditor_(p.name || '', { returnTo: p.returnTo || 'list', threadId: p.threadId || '' });
}

function openSequenceEditor_(name, ret) {
  let ed;
  if (name) {
    const s = getSequence_(name);
    if (!s) return notify_('Sequence "' + name + '" not found.');
    const steps = (Array.isArray(s.steps) ? s.steps : []).slice(0, MAX_CAMPAIGN_STEPS).map(normalizeSeqStep_);
    ed = {
      originalName: name, name: name,
      subject: String(s.subject || ''), firstMessage: String(s.firstMessage || ''),
      steps: steps.length ? steps : [normalizeSeqStep_({})]
    };
  } else {
    ed = {
      originalName: '', name: '', subject: '', firstMessage: '',
      steps: [normalizeSeqStep_({ amount: 3 }), normalizeSeqStep_({ amount: 4 })]
    };
  }
  ed.returnTo = ret.returnTo;
  ed.threadId = ret.threadId || '';
  setSeqEdit_(ed);
  return push_(buildSequenceEditorCard_());
}

function readSeqEditForm_(e) {
  const cur = getSeqEdit_();
  const f = (e && e.formInput) || {};
  return {
    originalName: cur.originalName,
    returnTo: cur.returnTo,
    threadId: cur.threadId,
    name: String(f.seqName || '').trim(),
    subject: String(f.seqSubject || '').trim(),
    firstMessage: String(f.seqFirst || '').replace(/^\s*\n/, '').replace(/\s+$/, ''),
    steps: readFormDraft_(e, { steps: cur.steps }).steps
  };
}

function buildSequenceEditorCard_() {
  const ed = getSeqEdit_();
  const card = CardService.newCardBuilder()
    .setHeader(screenHeader_(ed.originalName ? 'Edit sequence' : 'New sequence',
      'Each follow-up replies on the same thread. Stops when they reply.'));

  const top = CardService.newCardSection();
  top.addWidget(
    CardService.newTextInput().setFieldName('seqName').setTitle('Sequence name')
      .setValue(ed.name).setHint('e.g. "Standard 3-touch" or "GPC buyers"')
  );
  card.addSection(top);

  ed.steps.forEach(function (step, idx) {
    card.addSection(buildStepSection_(idx, step, {
      total: ed.steps.length,
      firstLabel: 'Wait this long after the first email',
      exactDate: false,
      removeAction: CardService.newAction().setFunctionName('actionSeqRemoveStep')
        .setParameters({ index: String(idx) })
    }));
  });

  const buttons = CardService.newButtonSet();
  if (ed.steps.length < MAX_CAMPAIGN_STEPS) {
    buttons.addButton(CardService.newTextButton().setText('+ Add follow-up')
      .setOnClickAction(CardService.newAction().setFunctionName('actionSeqAddStep')));
  }
  if (ed.originalName) {
    buttons.addButton(CardService.newTextButton().setText('Delete sequence')
      .setOnClickAction(CardService.newAction().setFunctionName('actionSeqAskDelete')));
  }
  card.addSection(CardService.newCardSection().addWidget(buttons));

  const first = CardService.newCardSection()
    .setHeader('First email (optional)')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);
  first.addWidget(grey_('Pre-fills the subject and email in New campaign when you pick this sequence.'));
  first.addWidget(CardService.newTextInput().setFieldName('seqSubject').setTitle('Subject').setValue(ed.subject));
  first.addWidget(CardService.newTextInput().setFieldName('seqFirst').setTitle('Email').setMultiline(true)
    .setValue(ed.firstMessage || '\n\n'));
  card.addSection(first);

  card.setFixedFooter(
    CardService.newFixedFooter().setPrimaryButton(
      CardService.newTextButton().setBackgroundColor(BRAND_BLUE).setText('Save sequence')
        .setOnClickAction(CardService.newAction().setFunctionName('actionSeqSave'))
    )
  );
  return card.build();
}

function actionSeqAddStep(e) {
  const ed = readSeqEditForm_(e);
  if (ed.steps.length >= MAX_CAMPAIGN_STEPS) return notify_('At most ' + MAX_CAMPAIGN_STEPS + ' follow-ups.');
  ed.steps.push(normalizeSeqStep_({}));
  setSeqEdit_(ed);
  return update_(buildSequenceEditorCard_());
}

function actionSeqRemoveStep(e) {
  const ed = readSeqEditForm_(e);
  const idx = parseInt(e.parameters.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= ed.steps.length) return notify_('Follow-up not found.');
  ed.steps.splice(idx, 1);
  if (ed.steps.length === 0) ed.steps.push(normalizeSeqStep_({}));
  setSeqEdit_(ed);
  return update_(buildSequenceEditorCard_());
}

function actionSeqSave(e) {
  const ed = readSeqEditForm_(e);
  setSeqEdit_(ed);
  if (ed.name && ed.name !== ed.originalName && getSequence_(ed.name)) {
    return notify_('There is already a sequence called "' + ed.name + '". Pick another name.');
  }
  try {
    studioSaveSequence(ed);
  } catch (err) {
    return notify_(String((err && err.message) || err));
  }
  PropertiesService.getUserProperties().deleteProperty(SEQ_EDIT_KEY);
  if (ed.returnTo === 'nc') {
    const d = getNcDraft_();
    d.sequence = ed.name;
    setNcDraft_(d);
  }
  return leaveSequenceEditor_(ed, 'Saved "' + ed.name + '".');
}

function actionSeqAskDelete(e) {
  const ed = readSeqEditForm_(e);
  setSeqEdit_(ed);
  return push_(buildConfirmCard_('Delete "' + ed.originalName + '"?',
    'You can\'t undo this. Emails already scheduled with it keep their follow-ups.',
    'Delete sequence', 'actionSeqDelete', {}));
}

function actionSeqDelete() {
  const ed = getSeqEdit_();
  if (ed.originalName) deleteSequence_(ed.originalName);
  PropertiesService.getUserProperties().deleteProperty(SEQ_EDIT_KEY);
  const d = getNcDraft_();
  if (d.sequence === ed.originalName) { d.sequence = ''; setNcDraft_(d); }
  return leaveSequenceEditor_(ed, 'Deleted "' + ed.originalName + '".', true);
}

// Back to whichever screen opened the editor, redrawn so it shows the change.
// fromConfirm: also pop the confirmation card sitting on top of the editor.
function leaveSequenceEditor_(ed, msg, fromConfirm) {
  let back;
  if (ed.returnTo === 'nc') back = buildNewCampaignCard_();
  else if (ed.returnTo === 'thread' && ed.threadId) back = buildCard_(ed.threadId);
  else back = buildSequencesCard_();
  const nav = CardService.newNavigation().popCard();
  if (fromConfirm) nav.popCard();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(msg))
    .setNavigation(nav.updateCard(back))
    .build();
}


// ───────── Confirmations ─────────────────────────────────────────

function buildConfirmCard_(title, text, confirmLabel, fn, params) {
  return CardService.newCardBuilder()
    .setHeader(screenHeader_(title))
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(escapeHtml_(text))))
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(CardService.newTextButton().setBackgroundColor(BRAND_BLUE).setText(confirmLabel)
          .setOnClickAction(CardService.newAction().setFunctionName(fn).setParameters(params)))
        .setSecondaryButton(CardService.newTextButton().setText('Keep it')
          .setOnClickAction(CardService.newAction().setFunctionName('actionPop')))
    )
    .build();
}

// params: { threadId, from: 'home' | 'thread' }
function actionAskStop(e) {
  const p = e.parameters || {};
  const queue = getQueueForThread_(p.threadId);
  let subject = '';
  try { subject = GmailApp.getThreadById(p.threadId).getFirstMessageSubject(); } catch (err) {}
  return push_(buildConfirmCard_('Stop follow-ups?',
    (subject ? '"' + subject + '": ' : '') + queue.length + ' scheduled follow-up(s) will not be sent. ' +
    'The emails already sent stay as they are.',
    'Stop follow-ups', 'actionStopConfirmed', { threadId: p.threadId, from: p.from || 'home' }));
}

function actionStopConfirmed(e) {
  const p = e.parameters || {};
  if (!p.threadId) return notify_('No thread.');
  PropertiesService.getUserProperties().deleteProperty('custom_' + p.threadId);
  try {
    const thread = GmailApp.getThreadById(p.threadId);
    if (thread) clearFollowUpLabels_(thread);
  } catch (err) {}
  const back = p.from === 'thread' ? buildCard_(p.threadId) : buildDashboardCard_();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Stopped. Nothing more will be sent on that email.'))
    .setNavigation(CardService.newNavigation().popCard().updateCard(back))
    .build();
}


// ───────── Settings ──────────────────────────────────────────────

function buildSettingsCard_() {
  const card = CardService.newCardBuilder().setHeader(screenHeader_('Settings', getRunningEmail_()));
  card.addSection(buildHealthSection_(collectCampaigns_(), 'settings'));

  const you = CardService.newCardSection().setHeader('You');
  you.addWidget(
    CardService.newTextInput().setFieldName('senderDisplayName').setTitle('Your name (shown as the sender)')
      .setValue(getSenderDisplayName_()).setHint('Blank = your Gmail name')
  );
  you.addWidget(
    CardService.newTextInput().setFieldName('senderFirstNameField').setTitle('First name for {senderFirstName}')
      .setValue(getSenderFirstName_())
  );
  you.addWidget(buildTimezoneDropdown_('settingsTz'));
  you.addWidget(
    CardService.newTextInput().setFieldName('signatureText').setTitle('Signature (added to every email)')
      .setMultiline(true).setValue(getSignature_() || '\n\n').setHint('Leave blank for none.')
  );
  you.addWidget(
    CardService.newTextButton().setText('Save')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor(BRAND_BLUE)
      .setOnClickAction(CardService.newAction().setFunctionName('actionSaveSettings'))
  );
  card.addSection(you);

  // Owner only: is every teammate's copy actually sending?
  const team = studioTeam_();
  if (team && team.length) {
    const sec = CardService.newCardSection()
      .setHeader('Team · ' + team.length)
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);
    team.forEach(function (m) {
      sec.addWidget(
        CardService.newDecoratedText()
          .setTopLabel(escapeHtml_(m.name ? m.name + ' · ' + m.email : m.email))
          .setText(m.running ? '<font color="#188038">Sending works</font>'
            : '<font color="#d93025">Sending is off</font> — ask them to open this panel')
          .setBottomLabel(escapeHtml_(m.lastRun
            ? 'Last check ' + m.lastRun + ', sent ' + m.lastRunSent + (m.lastRunError ? ' · error: ' + m.lastRunError : '')
            : 'Never ran'))
          .setWrapText(true)
      );
    });
    card.addSection(sec);
  }
  return card.build();
}

function actionSaveSettings(e) {
  const f = (e && e.formInput) || {};
  setSenderIdentity_(String(f.senderDisplayName || '').trim(), String(f.senderFirstNameField || '').trim());
  _cachedFromHeader_ = null;
  setSignature_(String(f.signatureText || '').replace(/\s+$/, ''));
  const tz = readSelectionInput_(e, 'settingsTz');
  if (TIMEZONE_CHOICES.some(function (c) { return c.value === tz; })) setPreferredTz_(tz);
  return update_(buildSettingsCard_(), 'Saved.');
}
