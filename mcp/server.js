#!/usr/bin/env node
// MCP server for the Gmail Follow-Up Tool. Claude talks to it over stdio; it
// calls the Apps Script project (Api.gs) as the signed-in Gmail user.
//
//   node server.js          run the MCP server (what Claude Desktop starts)
//   node server.js login    sign in with Google from a terminal
//   node server.js logout   forget the saved sign-in
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as auth from './auth.js';
import * as appsScript from './appsScript.js';

// ───────── Preview → confirm gate ────────────────────────────────
// Every preview hands out a one-time code tied to the exact arguments it
// showed. A confirmed call must bring that code back with the same arguments,
// so nothing is sent or stopped that the user didn't see first.

const CODE_TTL_MS = 30 * 60 * 1000;

export function createGate(now = Date.now) {
  const issued = new Map();
  const fingerprint = (kind, args) => {
    const rest = { ...args };
    delete rest.confirm;
    delete rest.confirmation_code;
    const canon = JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
    return crypto.createHash('sha256').update(kind + canon).digest('hex');
  };
  return {
    issue(kind, args) {
      const code = crypto.randomBytes(3).toString('hex');
      issued.set(code, { fp: fingerprint(kind, args), at: now() });
      return code;
    },
    // '' when fine, else why not.
    check(kind, args) {
      const code = String(args.confirmation_code || '');
      const entry = issued.get(code);
      if (!code || !entry) return 'Show the preview first: call this tool without confirm, show the result to the user, and pass back its confirmation_code once they say yes.';
      if (now() - entry.at > CODE_TTL_MS) { issued.delete(code); return 'That preview is over 30 minutes old. Preview again.'; }
      if (entry.fp !== fingerprint(kind, args)) return 'The arguments changed since the preview. Preview again with the new arguments and show it to the user.';
      issued.delete(code);
      return '';
    }
  };
}

// ───────── Tools ─────────────────────────────────────────────────

const followUpSchema = z.object({
  wait: z.number().int().positive().optional().describe('How long after the previous email (or after the first email). Used with unit.'),
  unit: z.enum(['days', 'hours', 'minutes']).optional().describe('Unit for wait. Default days.'),
  at_time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Optional 24h time of day, e.g. "09:30": after waiting, send at this time.'),
  send_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/).optional().describe('Instead of wait: an exact date and time, "YYYY-MM-DD HH:MM", in the campaign timezone.'),
  condition: z.enum(['no_reply', 'replied', 'always']).optional().describe('no_reply (default): only if they have not replied. replied: only if they replied. always: no matter what.'),
  message: z.string().optional().describe('Follow-up text. Placeholders: {firstName}, {senderFirstName}. Blank uses the default bump message.'),
  attachments: z.array(z.string()).max(10).optional().describe('Files to attach to this follow-up, as full paths on this computer.')
});

// withFiles: include the files' contents (only for the confirmed call; the
// preview just lists names, so nothing heavy goes to Google twice).
function toStep(f, withFiles = false) {
  const step = { amount: f.wait, unit: f.unit || 'days', atTime: f.at_time || '', condition: f.condition || 'no_reply', message: f.message || '' };
  if (f.attachments && f.attachments.length) {
    const files = readAttachments(f.attachments);
    if (withFiles) step.attachments = files.map((x) => ({ name: x.name, mimeType: x.mimeType, data: x.data }));
    else step.attachNames = files.map((x) => x.name);
  }
  if (f.send_at) {
    // The script takes an exact time as the wall clock encoded as UTC ms.
    const [d, t] = f.send_at.split(' ');
    step.sendAtAbs = Date.parse(d + 'T' + t.padStart(5, '0') + ':00Z');
  }
  return step;
}

const MAX_ATTACH_BYTES = 15 * 1024 * 1024;
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip' };

// Read attachment files from this computer. Throws a readable error for a
// missing file or when they are too big for one email.
export function totalAttachmentBytes(args) {
  const all = [...(args.attachments || []), ...(args.follow_ups || []).flatMap((f) => f.attachments || [])];
  return readAttachments(all).reduce((n, f) => n + f.size, 0);
}

export function readAttachments(paths) {
  const out = [];
  let total = 0;
  for (const raw of paths || []) {
    const p = String(raw).replace(/^~(?=$|[\\/])/, os.homedir());
    let st;
    try { st = fs.statSync(p); } catch (e) { throw new Error('Attachment not found: ' + raw + '. Give the full path to the file on this computer.'); }
    if (!st.isFile()) throw new Error('Not a file: ' + raw);
    total += st.size;
    if (total > MAX_ATTACH_BYTES) throw new Error('Attachments add up to more than 15 MB. Send fewer or smaller files, or share a Drive link in the email instead.');
    const name = path.basename(p);
    const ext = name.split('.').pop().toLowerCase();
    out.push({ name, size: st.size, mimeType: MIME[ext] || 'application/octet-stream', data: fs.readFileSync(p).toString('base64') });
  }
  return out;
}

const INSTRUCTIONS = [
  'Gmail Follow-ups sends emails and follow-up replies from the user\'s own Gmail account. Follow-ups reply on the same thread and stop by themselves when the person replies.',
  'One request can do everything: when the user describes who to email, what to say and what follow-ups to send, build it with the tools here. Use send_campaign with follow_ups written inline (no need to save a sequence first), or save_sequence first if they want to reuse it.',
  'For an email they already sent, find it with list_sent_threads, then start_sequence_on_thread with a saved sequence or inline follow_ups.',
  'Anything that sends, schedules, stops or deletes returns a preview first. Show the preview, including every warning, and ask the user. Only after a clear yes, call again with confirm: true and the confirmation_code.',
  'Attachments: give full file paths on this computer. The first email takes attachments in send_campaign; any follow-up (inline or in save_sequence) takes its own. 15 MB total per request. A follow-up\'s files are kept in a Gmail draft titled "[Follow-ups] attachment holder" until they are sent; tell the user not to delete it.',
  'Do not look for or edit this tool\'s files on disk; everything goes through these tools. If a tool says the user is not signed in, use sign_in.'
].join('\n');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (title, obj) => text(title + '\n\n' + JSON.stringify(obj, null, 2));

const PREVIEW_NOTE = 'NOTHING HAS BEEN DONE YET. Show the user this preview (recipients, the email, follow-up dates and every warning) and ask them to confirm. Only if they clearly say yes, call the tool again with exactly the same arguments plus confirm: true and confirmation_code: ';

export function buildServer({ run = appsScript.run } = {}) {
  const server = new McpServer({ name: 'gmail-followup', version: '1.1.0' }, { instructions: INSTRUCTIONS });
  const gate = createGate();

  // Wraps a handler so failures come back as readable tool errors.
  const tool = (name, config, handler) => server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      const prefix = e instanceof auth.NeedsSetup ? 'Setup needed: ' : '';
      return { isError: true, content: [{ type: 'text', text: prefix + (e.message || String(e)) }] };
    }
  });

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

  tool('status', {
    title: 'Status',
    description: 'Which Gmail account is sending, whether the follow-up scheduler is running, when it last ran, test mode, timezone. Start here if something seems off.',
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
    description: 'Threads with follow-ups still scheduled: who, subject, how many steps are left and when the next one goes out.',
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
    description: 'Schedule follow-ups as replies on an email the user already sent: either a saved sequence (sequence) or follow-ups written right here (follow_ups). Find the email with list_sent_threads. First call (no confirm) only returns a preview with dates and warnings. After the user approves, call again with confirm: true and the confirmation_code from the preview.',
    inputSchema: {
      thread_id: z.string().describe('threadId from list_sent_threads.'),
      sequence: z.string().optional().describe('Saved sequence name from list_sequences. Takes priority over follow_ups.'),
      follow_ups: z.array(followUpSchema).max(10).optional().describe('Follow-ups written for this email, if not using a saved sequence.'),
      campaign_name: z.string().optional().describe('Optional label to find this later.'),
      timezone: z.string().optional().describe('IANA timezone for the send times, e.g. "Asia/Kolkata". Default: the user\'s saved timezone.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    totalAttachmentBytes(args);
    const p = { threadId: args.thread_id, sequence: args.sequence || '', followUps: (args.follow_ups || []).map((f) => toStep(f)),
      campaignName: args.campaign_name || '', tz: args.timezone || '' };
    if (!args.confirm) {
      const pv = await run('mcpStartSequenceOnThread', [p]);
      const code = gate.issue('start', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = gate.check('start', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    const res = await run('mcpStartSequenceOnThread', [{ ...p, confirm: true,
      followUps: (args.follow_ups || []).map((f) => toStep(f, true)) }]);
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
      follow_ups: z.array(followUpSchema).max(10).optional().describe('Follow-ups to schedule, in order, if not using a saved sequence.'),
      campaign_name: z.string().optional().describe('Optional label to find this campaign later.'),
      attachments: z.array(z.string()).max(10).optional().describe('Files to attach to the FIRST email, as full paths on this computer (e.g. "C:\\Users\\me\\Downloads\\quote.pdf" or "/Users/me/Downloads/quote.pdf"). Follow-ups take their own attachments inside follow_ups. 15 MB in total across the first email and all follow-ups.'),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      timezone: z.string().optional().describe('IANA timezone for follow-up times. Default: the user\'s saved timezone.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    const p = {
      recipients: Array.isArray(args.recipients) ? args.recipients.join('\n') : args.recipients,
      subject: args.subject, body: args.body,
      sequence: args.sequence || '',
      followUps: (args.follow_ups || []).map((f) => toStep(f)),
      campaignName: args.campaign_name || '', cc: args.cc || '', bcc: args.bcc || '', tz: args.timezone || ''
    };
    totalAttachmentBytes(args);
    const files = readAttachments(args.attachments);
    p.attachmentNames = files.map((f) => f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)');
    if (!args.confirm) {
      const pv = await run('mcpSendCampaign', [p]);
      const code = gate.issue('send', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = gate.check('send', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    const res = await run('mcpSendCampaign', [{ ...p, confirm: true,
      followUps: (args.follow_ups || []).map((f) => toStep(f, true)),
      attachments: files.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) }]);
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
      follow_ups: z.array(followUpSchema).min(1).max(10).describe('The follow-ups, in order. Each needs wait (and unit) and usually a message.'),
      subject: z.string().optional().describe('Optional subject that pre-fills a new campaign.'),
      first_message: z.string().optional().describe('Optional first email that pre-fills a new campaign.'),
      original_name: z.string().optional().describe('When editing: the current name of the sequence.'),
      overwrite: z.boolean().optional().describe('Replace an existing sequence with the same name.')
    }
  }, async (args) => {
    const steps = args.follow_ups.map((f) => {
      if (f.send_at) throw new Error('Sequences are reusable, so use wait/unit (and at_time), not an exact send_at date.');
      if (!f.wait) throw new Error('Every follow-up in a sequence needs a wait (e.g. wait: 3, unit: "days").');
      return toStep(f, true);
    });
    totalAttachmentBytes(args);
    const res = await run('mcpSaveSequence', [{
      name: args.name, originalName: args.original_name || '', overwrite: !!args.overwrite,
      subject: args.subject || '', firstMessage: args.first_message || '', steps
    }]);
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
      const code = gate.issue('delseq', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = gate.check('delseq', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    return json('Deleted.', await run('mcpDeleteSequence', [args.name, true]));
  });

  tool('stop_campaign', {
    title: 'Stop follow-ups on a thread',
    description: 'Cancel every scheduled follow-up on one thread. First call (no confirm) shows what would be cancelled. After the user approves, call again with confirm: true and the confirmation_code.',
    inputSchema: {
      thread_id: z.string().describe('threadId from list_campaigns.'),
      confirm: z.boolean().optional(),
      confirmation_code: z.string().optional()
    }
  }, async (args) => {
    if (!args.confirm) {
      const pv = await run('mcpStopCampaign', [args.thread_id, false]);
      const code = gate.issue('stop', args);
      return json(PREVIEW_NOTE + '"' + code + '".', { ...pv, confirmation_code: code });
    }
    const why = gate.check('stop', args);
    if (why) return { isError: true, content: [{ type: 'text', text: why }] };
    return json('Stopped. No more follow-ups will go out on this thread.', await run('mcpStopCampaign', [args.thread_id, true]));
  });

  return server;
}

// ───────── Entry point ───────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') {
    const res = await auth.signIn({ log: (m) => console.log(m) });
    console.log('Signed in as ' + (res.email || 'your Google account') + '.');
    if (res.missing.length) console.log('Not granted: ' + res.missing.join(', '));
    return;
  }
  if (cmd === 'logout') { console.log(auth.signOut() ? 'Signed out.' : 'Was not signed in.'); return; }
  if (cmd === 'whoami') { console.log(auth.signedInEmail() || 'Not signed in.'); return; }
  if (cmd === 'call') {
    // Debug: node server.js call mcpStatus '[...params]'
    console.log(JSON.stringify(await appsScript.run(process.argv[3], JSON.parse(process.argv[4] || '[]')), null, 2));
    return;
  }
  await buildServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
