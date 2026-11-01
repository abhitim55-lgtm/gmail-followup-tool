// The Gmail Follow-Up Tool's MCP tools, shared by the local server
// (server.js, stdio, files from disk) and the hosted connector (worker/,
// files from Google Drive). Nothing here touches the disk or a browser.
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ───────── Preview → confirm gate ────────────────────────────────
// Every preview hands out a one-time code tied to the exact arguments it
// showed. A confirmed call must bring that code back with the same arguments,
// so nothing is sent or stopped that the user didn't see first.

const CODE_TTL_MS = 30 * 60 * 1000;

// store: optional { get(key), put(key, value), delete(key) } (async) so codes
// survive between requests on the hosted server; default is in memory.
export function createGate(now = Date.now, store = null) {
  const mem = new Map();
  const st = store || {
    get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v); }, delete: async (k) => { mem.delete(k); }
  };
  const fingerprint = (kind, args) => {
    const rest = { ...args };
    delete rest.confirm;
    delete rest.confirmation_code;
    const canon = JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
    return crypto.createHash('sha256').update(kind + canon).digest('hex');
  };
  return {
    async issue(kind, args) {
      const code = crypto.randomBytes(3).toString('hex');
      await st.put(code, { fp: fingerprint(kind, args), at: now() });
      return code;
    },
    // '' when fine, else why not.
    async check(kind, args) {
      const code = String(args.confirmation_code || '');
      const entry = code ? await st.get(code) : null;
      if (!code || !entry) return 'Show the preview first: call this tool without confirm, show the result to the user, and pass back its confirmation_code once they say yes.';
      if (now() - entry.at > CODE_TTL_MS) { await st.delete(code); return 'That preview is over 30 minutes old. Preview again.'; }
      if (entry.fp !== fingerprint(kind, args)) return 'The arguments changed since the preview. Preview again with the new arguments and show it to the user.';
      await st.delete(code);
      return '';
    }
  };
}

// ───────── Tools ─────────────────────────────────────────────────

const addresses = (what) => z.array(z.string()).max(50).optional().describe(what);

const followUpSchema = (fileHelp) => z.object({
  wait: z.number().int().nonnegative().optional().describe('How long after the previous email (or after the first email). Used with unit. 0 = send on the next scheduler run (within about 5 minutes).'),
  unit: z.enum(['days', 'hours', 'minutes']).optional().describe('Unit for wait. Default days.'),
  at_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Optional 24h time of day, e.g. "09:30": after waiting, send at this time.'),
  send_at: z.string().regex(/^(now|\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})$/).optional().describe('Instead of wait: an exact date and time, "YYYY-MM-DD HH:MM", in the campaign timezone, or "now" for the next scheduler run (within about 5 minutes).'),
  to: addresses('start_sequence_on_thread only, with reply_mode "custom": To for this one email, replacing the sequence-level to.'),
  cc: addresses('Cc for this one email. In start_sequence_on_thread (reply_mode "custom") it replaces the sequence-level cc, e.g. to drop someone from the last email; in send_campaign and save_sequence it is added to the campaign cc.'),
  bcc: addresses('Bcc for this one email. Same rules as cc.'),
  condition: z.enum(['no_reply', 'replied', 'always']).optional().describe('no_reply (default): only if they have not replied. replied: only if they replied. always: no matter what.'),
  message: z.string().optional().describe('Follow-up text. Placeholders: {firstName}, {senderFirstName}. Blank uses the default bump message.'),
  attachments: z.array(z.string()).max(10).optional().describe('Files to attach to this follow-up: ' + fileHelp + '.')
});

// withFiles: include the files' contents (only for the confirmed call; the
// preview just lists names, so nothing heavy goes to Google twice).
async function toStep(f, withFiles, files) {
  const step = { amount: f.wait, unit: f.unit || 'days', atTime: f.at_time || '', condition: f.condition || 'no_reply', message: f.message || '' };
  const override = {};
  for (const k of ['to', 'cc', 'bcc']) if (f[k] !== undefined) override[k] = f[k];
  if (Object.keys(override).length) step.override = override;
  if (f.attachments && f.attachments.length) {
    const got = await files.many(f.attachments);
    if (withFiles) step.attachments = got.map((x) => ({ name: x.name, mimeType: x.mimeType, data: x.data }));
    else step.attachNames = got.map((x) => x.name);
  }
  if (f.send_at === 'now' || (f.wait === 0 && !f.send_at)) {
    step.sendNow = true;
    step.amount = 0;
    step.atTime = '';
  } else if (f.send_at) {
    // The script takes an exact time as the wall clock encoded as UTC ms.
    const [d, t] = f.send_at.split(' ');
    step.sendAtAbs = Date.parse(d + 'T' + t.padStart(5, '0') + ':00Z');
  }
  return step;
}

const MAX_ATTACH_BYTES = 15 * 1024 * 1024;

// Read every file a request mentions once (first email + all follow-ups) and
// enforce the size limit. readFiles(refs) → [{ name, size, mimeType, data }].
function fileCache(readFiles) {
  const cache = new Map();
  const one = async (ref) => {
    if (!cache.has(ref)) cache.set(ref, readFiles([ref]).then((r) => r[0]));
    return cache.get(ref);
  };
  const many = async (refs) => Promise.all((refs || []).map((r) => one(String(r))));
  const checkTotal = async (args) => {
    const all = [...(args.attachments || []), ...(args.follow_ups || []).flatMap((f) => f.attachments || [])];
    const files = await many(all);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_ATTACH_BYTES) throw new Error('Attachments add up to more than 15 MB. Send fewer or smaller files, or put a link in the email instead.');
  };
  return { many, checkTotal };
}

const instructions = (o) => [
  'Gmail Follow-ups sends emails and follow-up replies from the user\'s own Gmail account. Follow-ups reply on the same thread and stop by themselves when the person replies.',
  'One request can do everything: when the user describes who to email, what to say and what follow-ups to send, build it with the tools here. Use send_campaign with follow_ups written inline (no need to save a sequence first), or save_sequence first if they want to reuse it.',
  'For an email they already sent, find it with list_sent_threads, then start_sequence_on_thread with a saved sequence or inline follow_ups.',
  'Who follow-ups go to: by default the last person outside the user\'s company who wrote on the thread (colleagues are never followed up with). In multi-party threads, ask or check who the client is and use reply_mode "custom" with to/cc (and stop_on_reply_from with the client\'s domains), or reply_mode "reply_all". Replies from the user\'s own colleagues never stop a sequence unless stop_on_any_reply is true.',
  'To manage what is running: list_campaigns shows every scheduled follow-up with a step number. stop_campaign stops a thread, a whole campaign, one person or everything; cancel_follow_up drops one step; edit_follow_up changes a step\'s text, time or condition; pause_follow_ups / resume_follow_ups hold and release without cancelling.',
  'Anything that sends, schedules, stops or deletes returns a preview first. Show the preview, including every warning, and ask the user. Only after a clear yes, call again with confirm: true and the confirmation_code.',
  'Attachments: ' + o.fileHelp + '. The first email takes attachments in send_campaign; any follow-up (inline or in save_sequence) takes its own. 15 MB total per request. A follow-up\'s files are kept in a Gmail draft titled "[Follow-ups] attachment holder" until they are sent; tell the user not to delete it.',
  'Do not look for or edit this tool\'s files on disk; everything goes through these tools.' +
    (o.signIn ? ' If a tool says the user is not signed in, use sign_in.' : '')
].join('\n');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (title, obj) => text(title + '\n\n' + JSON.stringify(obj, null, 2));

const PREVIEW_NOTE = 'NOTHING HAS BEEN DONE YET. Show the user this preview (recipients, the email, follow-up dates and every warning) and ask them to confirm. Only if they clearly say yes, call the tool again with exactly the same arguments plus confirm: true and confirmation_code: ';

// run(fn, params): calls Api.gs as the user. readFiles(refs): attachment
// contents. fileHelp: how the user gives files (paths here, Drive links on
// the hosted server). auth: { signIn, signOut, NeedsSetup } for the local
// server only; the hosted one signs in through the Claude connector.
export function buildServer({ run, readFiles, fileHelp, auth = null, version = '1.4.0', gateStore = null }) {
  const server = new McpServer({ name: 'gmail-followup', version },
    { instructions: instructions({ fileHelp, signIn: !!auth }) });
  const gate = createGate(Date.now, gateStore);
  const fu = followUpSchema(fileHelp);

  // Wraps a handler so failures come back as readable tool errors.
  const tool = (name, config, handler) => server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      const prefix = auth && e instanceof auth.NeedsSetup ? 'Setup needed: ' : '';
      return { isError: true, content: [{ type: 'text', text: prefix + (e.message || String(e)) }] };
    }
  });

  if (auth) {
  tool('sign_in', {
    title: 'Sign in with Google',
    description: 'Sign in to the Gmail account the Follow-Up Tool should use. Opens a browser window; the user picks their account and approves. Needed once per computer, or after signing out.'
  }, async () => {
    const res = await auth.signIn();
    let msg = 'Signed in as ' + (res.email || 'your Google account') + '.';
    if (res.missing.length) msg += ' Warning: these permissions were not granted, so some actions may fail: ' + res.missing.join(', ');
    return text(msg);
  });

  tool('sign_out', {
    title: 'Sign out',
    description: 'Forget the saved Google sign-in on this computer.'
  }, async () => text(auth.signOut() ? 'Signed out.' : 'Was not signed in.'));
  }

  tool('status', {
    title: 'Status',
    description: 'Which Gmail account is sending, whether the follow-up scheduler is running, when it last ran, test mode, timezone, the user\'s own company domains, and every scheduled follow-up with its To/Cc/Bcc. Start here if something seems off.',
    annotations: { readOnlyHint: true }
  }, async () => json('Follow-Up Tool status:', await run('mcpStatus')));

  tool('list_sequences', {
    title: 'List sequences',
    description: 'Saved follow-up sequences (name, subject, first message and follow-up steps). Use a name with send_campaign or start_sequence_on_thread.',
    annotations: { readOnlyHint: true }
  }, async () => {
    const seqs = await run('mcpListSequences');
    return json(seqs.length ? seqs.length + ' saved sequence(s):' : 'No saved sequences yet. Create one in the Gmail sidebar (Sequences).', seqs);
  });

  tool('list_campaigns', {
    title: 'List running campaigns',
    description: 'Threads with follow-ups still scheduled: subject, and for every scheduled follow-up when it goes out and its To, Cc and Bcc (as the thread stands now).',
    annotations: { readOnlyHint: true }
  }, async () => {
    const list = await run('mcpListCampaigns');
    return json(list.length ? list.length + ' thread(s) with follow-ups scheduled:' : 'No follow-ups are scheduled right now.', list);
  });

  tool('list_sent_threads', {
    title: 'List sent emails',
    description: 'Recent emails the user sent (up to 25), to pick one to follow up on. "waiting" means the last message is from the user (no reply yet); "armed" means follow-ups are already scheduled.',
    inputSchema: { query: z.string().optional().describe('Extra Gmail search, e.g. "to:jane@acme.com" or "subject:proposal newer_than:7d". Default: last 30 days.') },
    annotations: { readOnlyHint: true }
  }, async ({ query }) => json('Recent sent emails:', await run('mcpListSentThreads', [query || ''])));

  tool('start_sequence_on_thread', {
    title: 'Start a sequence on a sent email',
    description: 'Schedule follow-ups as replies on an email the user already sent: either a saved sequence (sequence) or follow-ups written right here (follow_ups). Every follow-up stays in the same Gmail thread ("Re: <subject>", replying to the latest message when it sends). Find the email with list_sent_threads. First call (no confirm) only returns a preview: To, Cc, Bcc, send time, condition and the full message of every follow-up, plus warnings. After the user approves, call again with confirm: true and the confirmation_code from the preview.',
    inputSchema: {
      thread_id: z.string().describe('threadId from list_sent_threads.'),
      sequence: z.string().optional().describe('Saved sequence name from list_sequences. Takes priority over follow_ups.'),
      follow_ups: z.array(fu).max(10).optional().describe('Follow-ups written for this email, if not using a saved sequence.'),
      reply_mode: z.enum(['last_sender', 'reply_all', 'custom']).optional().describe('Who follow-ups go to. last_sender (default): the last person outside the user\'s company who wrote. reply_all: everyone on the latest message, minus the user (colleagues go in Cc). custom: exactly to/cc/bcc; required whenever to, cc or bcc is given.'),
      to: addresses('reply_mode "custom": To for every follow-up (at least one).'),
      cc: addresses('reply_mode "custom": Cc for every follow-up.'),
      bcc: addresses('reply_mode "custom": Bcc for every follow-up.'),
      stop_on_reply_from: z.array(z.string()).max(20).optional().describe('Domains or addresses whose reply stops the "if no reply" follow-ups, e.g. ["jotun.com", "jotun.ae"]. Default: anyone in To/Cc outside the user\'s company (custom), or anyone outside it.'),
      stop_on_any_reply: z.boolean().optional().describe('Also stop when one of the user\'s own colleagues replies. Default false.'),
      campaign_name: z.string().optional().describe('Optional label to find this later.'),
      timezone: z.string().optional().describe('IANA timezone for the send times, e.g. "Asia/Kolkata". Default: the user\'s saved timezone.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    const files = fileCache(readFiles);
    await files.checkTotal(args);
    const p = { threadId: args.thread_id, sequence: args.sequence || '', followUps: await Promise.all((args.follow_ups || []).map((f) => toStep(f, false, files))),
      campaignName: args.campaign_name || '', tz: args.timezone || '' };
    if (args.reply_mode) p.replyMode = args.reply_mode;
    for (const k of ['to', 'cc', 'bcc']) if (args[k] !== undefined) p[k] = args[k];
    if (args.stop_on_reply_from !== undefined) p.stopOnReplyFrom = args.stop_on_reply_from;
    if (args.stop_on_any_reply) p.stopOnAnyReply = true;
    if (!args.confirm) {
      const pv = await run('mcpStartSequenceOnThread', [p]);
      const code = await gate.issue('start', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = await gate.check('start', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    const res = await run('mcpStartSequenceOnThread', [{ ...p, confirm: true,
      followUps: await Promise.all((args.follow_ups || []).map((f) => toStep(f, true, files))) }]);
    return json(res.schedulerOk
      ? 'Follow-ups scheduled. They stop by themselves when the person replies.'
      : 'Saved, but the scheduler is NOT running, so nothing will send. Open the Gmail sidebar to fix it.', res);
  });

  tool('send_campaign', {
    title: 'Send a campaign',
    description: 'Send a new first email to each recipient (each gets their own thread) and schedule follow-ups that reply on it and stop when they reply. First call (no confirm) sends nothing: it returns a preview of the recipients, the first email as the first recipient sees it, the follow-up dates and warnings. Show it to the user. Only after they approve, call again with the same arguments plus confirm: true and the confirmation_code. Up to 50 recipients.',
    inputSchema: {
      recipients: z.union([z.string(), z.array(z.string())]).describe('Email addresses, bare or "Jane Doe <jane@acme.com>". A name lets {firstName} work.'),
      subject: z.string().describe('Subject. Can use {firstName}.'),
      body: z.string().describe('First email, plain text. Placeholders: {firstName}, {senderFirstName}. The user\'s signature is added automatically.'),
      sequence: z.string().optional().describe('Use this saved sequence\'s follow-ups (name from list_sequences). Takes priority over follow_ups.'),
      follow_ups: z.array(fu).max(10).optional().describe('Follow-ups to schedule, in order, if not using a saved sequence.'),
      campaign_name: z.string().optional().describe('Optional label to find this campaign later.'),
      attachments: z.array(z.string()).max(10).optional().describe('Files to attach to the FIRST email: ' + fileHelp + '. Follow-ups take their own attachments inside follow_ups. 15 MB in total across the first email and all follow-ups.'),
      cc: z.union([z.string(), z.array(z.string())]).optional().describe('Cc on the first email and every follow-up of each recipient.'),
      bcc: z.union([z.string(), z.array(z.string())]).optional().describe('Bcc on the first email and every follow-up.'),
      timezone: z.string().optional().describe('IANA timezone for follow-up times. Default: the user\'s saved timezone.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    const files = fileCache(readFiles);
    const p = {
      recipients: Array.isArray(args.recipients) ? args.recipients.join('\n') : args.recipients,
      subject: args.subject, body: args.body,
      sequence: args.sequence || '',
      followUps: await Promise.all((args.follow_ups || []).map((f) => toStep(f, false, files))),
      campaignName: args.campaign_name || '', cc: [].concat(args.cc || []).join(', '), bcc: [].concat(args.bcc || []).join(', '), tz: args.timezone || ''
    };
    await files.checkTotal(args);
    const firstFiles = await files.many(args.attachments);
    p.attachmentNames = firstFiles.map((f) => f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)');
    if (!args.confirm) {
      const pv = await run('mcpSendCampaign', [p]);
      const code = await gate.issue('send', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = await gate.check('send', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    const res = await run('mcpSendCampaign', [{ ...p, confirm: true,
      followUps: await Promise.all((args.follow_ups || []).map((f) => toStep(f, true, files))),
      attachments: firstFiles.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) }]);
    let head = res.dryRun
      ? 'Test mode: nothing was actually sent (CONFIG.dryRun is on).'
      : 'Sent to ' + res.sent + ' recipient(s).';
    if (res.failed && res.failed.length) head += ' ' + res.failed.length + ' failed; see "failed". Do not resend to the ones that worked.';
    if (res.notArmed && res.notArmed.length) head += ' For ' + res.notArmed.length + ' the email went out but follow-ups were not scheduled; see "notArmed".';
    if (!res.schedulerOk) head += ' The scheduler is NOT running, so follow-ups will not go out until it is fixed in the Gmail sidebar.';
    return json(head, res);
  });

  tool('save_sequence', {
    title: 'Save a sequence',
    description: 'Create a reusable follow-up sequence, or edit one (pass original_name to rename or replace). Sends nothing. Afterwards it can be used by name in send_campaign, start_sequence_on_thread, the Gmail sidebar and the Follow-ups page. Show the user the steps you are about to save.',
    inputSchema: {
      name: z.string().min(1).max(80).describe('Sequence name, e.g. "Standard 3-touch".'),
      follow_ups: z.array(fu).min(1).max(10).describe('The follow-ups, in order. Each needs wait (and unit) and usually a message.'),
      subject: z.string().optional().describe('Optional subject that pre-fills a new campaign.'),
      first_message: z.string().optional().describe('Optional first email that pre-fills a new campaign.'),
      cc: addresses('Default Cc for every follow-up of this sequence.'),
      bcc: addresses('Default Bcc for every follow-up of this sequence.'),
      reply_mode: z.enum(['last_sender', 'reply_all', 'custom']).optional().describe('Default reply_mode when this sequence is started on a thread (custom then still needs to there).'),
      stop_on_reply_from: z.array(z.string()).max(20).optional().describe('Default stop_on_reply_from (domains or addresses).'),
      original_name: z.string().optional().describe('When editing: the current name of the sequence.'),
      overwrite: z.boolean().optional().describe('Replace an existing sequence with the same name.')
    }
  }, async (args) => {
    for (const f of args.follow_ups) {
      if (f.send_at) throw new Error('Sequences are reusable, so use wait/unit (and at_time), not an exact send_at date.');
      if (!f.wait) throw new Error('Every follow-up in a sequence needs a wait (e.g. wait: 3, unit: "days").');
      if (f.to) throw new Error('A saved sequence is reused on many threads, so a follow-up cannot have its own to. Give to when starting it with start_sequence_on_thread.');
    }
    const files = fileCache(readFiles);
    await files.checkTotal(args);
    const steps = await Promise.all(args.follow_ups.map((f) => toStep(f, true, files)));
    const seq = {
      name: args.name, originalName: args.original_name || '', overwrite: !!args.overwrite,
      subject: args.subject || '', firstMessage: args.first_message || '', steps
    };
    for (const k of ['cc', 'bcc']) if (args[k] !== undefined) seq[k] = args[k];
    if (args.reply_mode) seq.replyMode = args.reply_mode;
    if (args.stop_on_reply_from !== undefined) seq.stopOnReplyFrom = args.stop_on_reply_from;
    const res = await run('mcpSaveSequence', [seq]);
    return json('Saved sequence "' + args.name + '".', res);
  });

  tool('delete_sequence', {
    title: 'Delete a sequence',
    description: 'Delete a saved sequence. First call (no confirm) shows it. After the user approves, call again with confirm: true and the confirmation_code. Campaigns already running keep their follow-ups.',
    inputSchema: {
      name: z.string().describe('Name from list_sequences.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    if (!args.confirm) {
      const pv = await run('mcpDeleteSequence', [args.name, false]);
      const code = await gate.issue('delseq', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = await gate.check('delseq', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    return json('Deleted.', await run('mcpDeleteSequence', [args.name, true]));
  });

  // Which follow-ups a stop/pause/resume applies to: exactly one of these.
  const selector = {
    thread_id: z.string().optional().describe('One email thread (threadId from list_campaigns).'),
    campaign_name: z.string().optional().describe('Every thread in a campaign, by its name as list_campaigns shows it.'),
    recipient: z.string().optional().describe('Every thread whose follow-ups go to this email address.'),
    all: z.boolean().optional().describe('Everything that is scheduled.')
  };
  const toSel = (a) => {
    const picked = ['thread_id', 'campaign_name', 'recipient', 'all'].filter((k) => a[k]);
    if (picked.length !== 1) throw new Error('Give exactly one of thread_id, campaign_name, recipient or all.');
    return { threadId: a.thread_id || '', campaignName: a.campaign_name || '', recipient: a.recipient || '', all: !!a.all };
  };
  // Preview first, then the confirmed call. fn(confirm) runs on Apps Script.
  const gated = (kind, args, fn, doneMsg) => (async () => {
    if (!args.confirm) {
      const pv = await fn(false);
      const code = await gate.issue(kind, args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = await gate.check(kind, args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    return json(doneMsg, await fn(true));
  })();
  const confirmArgs = { confirm: z.boolean().optional(), confirmation_code: z.string().optional() };
  const toAbs = (t) => {
    if (!t) return 0;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})$/.exec(t);
    if (!m) throw new Error('Use "YYYY-MM-DD HH:MM" for times.');
    return Date.parse(m[1] + 'T' + m[2].padStart(5, '0') + ':00Z');
  };

  tool('stop_campaign', {
    title: 'Stop follow-ups',
    description: 'Cancel every scheduled follow-up on one thread, a whole campaign (all its recipients), everything going to one person, or everything. First call shows exactly what would be cancelled; after the user approves, call again with confirm: true and the confirmation_code.',
    inputSchema: { ...selector, ...confirmArgs }
  }, async (args) => {
    const sel = toSel(args);
    return gated('stop', args, (c) => run('mcpStopCampaign', [sel, c]), 'Stopped. No more follow-ups will go out on these threads.');
  });

  tool('cancel_follow_up', {
    title: 'Cancel one follow-up',
    description: 'Cancel a single scheduled follow-up on a thread and keep the others. step is the number shown by list_campaigns. Preview first, then confirm.',
    inputSchema: { thread_id: z.string(), step: z.number().int().positive(), ...confirmArgs }
  }, async (args) => gated('cancel1', args, (c) => run('mcpCancelFollowUp', [args.thread_id, args.step, c]), 'Cancelled that follow-up.'));

  tool('edit_follow_up', {
    title: 'Edit a scheduled follow-up',
    description: 'Change one scheduled follow-up: its message, when it sends, or its condition. step is the number shown by list_campaigns. Preview shows before and after; then confirm.',
    inputSchema: {
      thread_id: z.string(),
      step: z.number().int().positive(),
      message: z.string().optional().describe('New text. Placeholders: {firstName}, {senderFirstName}.'),
      send_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/).optional().describe('New send time, "YYYY-MM-DD HH:MM" in the user\'s timezone.'),
      condition: z.enum(['no_reply', 'replied', 'always']).optional(),
      timezone: z.string().optional(),
      ...confirmArgs
    }
  }, async (args) => {
    const p = { threadId: args.thread_id, step: args.step, message: args.message || '', sendAtAbs: toAbs(args.send_at),
                condition: args.condition || '', tz: args.timezone || '' };
    return gated('edit', args, (c) => run('mcpEditFollowUp', [p, c]), 'Updated.');
  });

  tool('pause_follow_ups', {
    title: 'Pause follow-ups',
    description: 'Hold follow-ups without cancelling them: one thread, a campaign, everything to one person, or all (which also holds anything started later). Optional until "YYYY-MM-DD HH:MM" resumes by itself. Follow-ups that come due while paused go out on the first run after resuming. Preview, then confirm.',
    inputSchema: { ...selector, until: z.string().optional().describe('Resume automatically at this time, "YYYY-MM-DD HH:MM".'), ...confirmArgs }
  }, async (args) => {
    const sel = toSel(args);
    return gated('pause', args, (c) => run('mcpPause', [sel, true, toAbs(args.until), c]), 'Paused.');
  });

  tool('resume_follow_ups', {
    title: 'Resume follow-ups',
    description: 'Undo a pause for one thread, a campaign, one person, or all. Follow-ups that came due while paused go out within a few minutes. Preview, then confirm.',
    inputSchema: { ...selector, ...confirmArgs }
  }, async (args) => {
    const sel = toSel(args);
    return gated('resume', args, (c) => run('mcpPause', [sel, false, 0, c]), 'Resumed.');
  });

  return server;
}

