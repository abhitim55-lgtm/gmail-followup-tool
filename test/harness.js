// Local tests for the Apps Script code: stubs Google's services, loads
// Code.gs + Studio.gs into one global scope (as Apps Script does), and checks
// the generated MIME, schedules and team status. Run: node test/harness.js
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const ROOT = path.join(__dirname, '..') + '/';
const ME = 'abhishek.sehgal@procmart.com';

function makeEnv() {
  const userProps = {}, scriptProps = {};
  const propSvc = (store) => ({
    getProperty: k => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    deleteProperty: k => { delete store[k]; },
    getKeys: () => Object.keys(store)
  });
  const threads = {}, labels = {};
  let msgSeq = 0, threadSeq = 0, draftSeq = 0;
  const drafts = {};
  const sent = [], sentMime = [];
  let runningEmail = ME;
  function mkMessage(o) {
    const id = 'm' + (++msgSeq);
    return { id, getId: () => id, getFrom: () => o.from, getTo: () => o.to || '', getCc: () => o.cc || '',
             getDate: () => new Date(o.date || Date.now()), getPlainBody: () => o.body || '', raw: o };
  }
  function mkThread(id, subject, messages) {
    const t = { id, subject, messages, labels: new Set(),
      getId: () => id, getFirstMessageSubject: () => subject, getMessages: () => t.messages,
      getPermalink: () => 'https://mail.google.com/mail/#all/' + id,
      getLabels: () => [...t.labels].map(n => labels[n]),
      addLabel: l => t.labels.add(l.getName()), removeLabel: l => t.labels.delete(l.getName()) };
    threads[id] = t; return t;
  }
  function mkLabel(name) {
    labels[name] = labels[name] || { getName: () => name, getThreads: () => Object.values(threads).filter(t => t.labels.has(name)) };
    return labels[name];
  }
  function decodeRaw(raw) {
    const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const headers = {};
    mime.split('\r\n\r\n')[0].split('\r\n').forEach(l => { const i = l.indexOf(': '); headers[l.slice(0, i)] = l.slice(i + 2); });
    const parts = mime.split(/------=_omc_\w+/).filter(p => p.includes('Content-Type: text/'));
    const dec = p => Buffer.from(p.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');
    return { headers, text: dec(parts[0]), html: dec(parts[1]) };
  }
  const parts = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, Error, RegExp, parseInt, isNaN, Promise, Intl,
    Logger: { log: () => {}, getLog: () => '' },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => runningEmail }),
      getActiveUser: () => ({ getEmail: () => runningEmail }),
      getScriptTimeZone: () => 'Asia/Jakarta'
    },
    PropertiesService: { getUserProperties: () => propSvc(userProps), getScriptProperties: () => propSvc(scriptProps) },
    Utilities: {
      base64Encode: (s) => Buffer.from(Array.isArray(s) ? Buffer.from(s) : Buffer.from(s, 'utf8')).toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      Charset: { UTF_8: 'utf8' },
      formatDate: (d, tz, fmt) => {
        const p = parts(d, tz);
        if (fmt === 'yyyy-MM-dd HH:mm') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
        if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${tz}`;
      },
      parseDate: (s, tz) => { // wall clock in tz → instant
        const [d, t] = s.split(' ');
        const guess = Date.parse(d + 'T' + (t || '00:00') + ':00Z');
        const off = x => { const p = parts(new Date(x), tz); return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - x; };
        return new Date(guess - off(guess));
      },
      sleep: () => {}
    },
    ScriptApp: {
      getProjectTriggers: () => [{ getHandlerFunction: () => 'processFollowUps' }],
      deleteTrigger: () => {},
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/WRONG/exec' }),
      newTrigger: () => { throw new Error('no'); }
    },
    GmailApp: {
      getDraft: id => { const d = drafts[id]; if (!d) throw new Error('no draft ' + id);
        return { getId: () => id, getMessage: () => ({ getSubject: () => d.subject, getAttachments: () => d.files.map(f => ({
          getName: () => f.name, getContentType: () => f.type, getBytes: () => [...Buffer.from(f.data, 'base64')] })) }),
          deleteDraft: () => { delete drafts[id]; } }; },
      getDrafts: () => Object.keys(drafts).map(id => ctx.GmailApp.getDraft(id)),
      getThreadById: id => threads[id] || null,
      getUserLabelByName: n => labels[n] || null,
      createLabel: n => mkLabel(n),
      getAliases: () => [],
      search: () => Object.values(threads)
    },
    Gmail: {
      Users: {
        Settings: { SendAs: { list: () => ({ sendAs: [{ sendAsEmail: runningEmail, displayName: 'Test User', isPrimary: true, isDefault: true }] }) } },
        Drafts: { create: (res) => { const id = 'd' + (++draftSeq); const raw = Buffer.from(res.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
          const subject = ((raw.match(/^Subject: (.*)$/m) || [])[1] || '').trim()
            .replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
          const files = [...raw.matchAll(/Content-Type: ([^;\r\n]+); name="([^"]+)"[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(m => ({ type: m[1], name: m[2], data: m[3].replace(/\s+/g, '') }));
          drafts[id] = { subject, files }; return { id }; } },
        Messages: {
          get: () => ({ payload: { headers: [{ name: 'Message-ID', value: '<orig@x>' }] } }),
          send: (res) => {
            sentMime.push(Buffer.from(res.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            const d = decodeRaw(res.raw);
            sent.push({ ...d, threadId: res.threadId || null });
            const t = res.threadId ? threads[res.threadId] : mkThread('t' + (++threadSeq), d.headers.Subject, []);
            t.messages.push(mkMessage({ from: d.headers.From, to: d.headers.To, cc: d.headers.Cc }));
            return { id: 'x', threadId: t.id };
          }
        }
      }
    },
    HtmlService: {}
  };
  // Chainable CardService stub that records every string for assertions.
  const texts = [];
  const chain = () => new Proxy(function () {}, {
    get: (_, prop) => prop === 'build' ? () => ({ texts })
      : (...args) => { args.forEach(a => typeof a === 'string' && texts.push(a)); return chain(); }
  });
  ctx.CardService = new Proxy({}, { get: (_, p) => /^new/.test(p) ? () => chain() : new Proxy({}, { get: () => 'ENUM' }) });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(ROOT + 'Code.gs', 'utf8') + '\n' + fs.readFileSync(ROOT + 'Studio.gs', 'utf8') + '\n' + fs.readFileSync(ROOT + 'Sidebar.gs', 'utf8') + '\n' + fs.readFileSync(ROOT + 'Api.gs', 'utf8'), ctx);
  const actAs = (email) => {
    runningEmail = email;
    vm.runInContext('_cachedRunningEmail_ = null; _cachedSendAsList_ = null; _cachedMyEmails_ = null; _cachedFromHeader_ = null;', ctx);
  };
  return { sentMime, drafts, ctx, userProps, scriptProps, threads, sent, texts, mkThread, mkMessage, actAs };
}

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { console.log('✗', name, '\n   ', e.message); process.exitCode = 1; }
}

test('Studio campaign: first email per recipient, follow-ups armed', () => {
  const E = makeEnv();
  E.userProps.signature = 'Abhishek\nProcMart';
  const t0 = Date.now();
  const res = E.ctx.studioSendCampaign({
    recipients: '"Doe, Jane" <jane@acme.com>\nsam@globex.com, jane@acme.com, not-an-email',
    subject: 'Quick idea for {firstName}',
    body: 'Hi {firstName},\n\n<b>5 < 6</b> — thoughts?',
    followUps: [{ amount: 3, unit: 'days', condition: 'no_reply', message: 'Bump {firstName}' },
                { amount: '4', unit: 'days', atTime: '09:00', condition: 'always', message: '' }],
    campaignName: 'Q4 outreach', tz: 'Asia/Kolkata'
  });
  assert.strictEqual(res.sent, 2); assert.strictEqual(res.failed.length, 0);
  const [a, b] = E.sent;
  assert.strictEqual(a.headers.To, '"Doe, Jane" <jane@acme.com>');
  assert.strictEqual(a.headers.Subject, 'Quick idea for Jane');
  assert.ok(a.headers.From.includes(ME));
  assert.ok(a.text.startsWith('Hi Jane,') && a.text.endsWith('Abhishek\nProcMart'));
  assert.ok(a.html.includes('&lt;b&gt;5 &lt; 6&lt;/b&gt;'));
  assert.strictEqual(b.headers.To, 'sam@globex.com');
  assert.ok(b.text.startsWith('Hi there,'));
  const stored = JSON.parse(E.userProps.custom_t1);
  assert.strictEqual(stored.steps.length, 2); assert.strictEqual(stored.campaignName, 'Q4 outreach');
  assert.ok(Math.abs(stored.steps[0].sendAt - t0 - 3 * 86400000) < 5000);
  assert.strictEqual(E.ctx.Utilities.formatDate(new Date(stored.steps[1].sendAt), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm').slice(11), '09:00');
  assert.ok(E.threads.t1.labels.has('FU/Custom'));
});

test('Studio campaign validates input and sends nothing on error', () => {
  const E = makeEnv();
  assert.throws(() => E.ctx.studioSendCampaign({ recipients: 'a@b.co', subject: '', body: 'x' }), /subject/);
  assert.throws(() => E.ctx.studioSendCampaign({ recipients: 'nobody', subject: 's', body: 'x' }), /recipient/);
  assert.throws(() => E.ctx.studioSendCampaign({ recipients: 'a@b.co', subject: 's', body: 'x', followUps: [{ amount: 0 }] }), /wait/);
  assert.throws(() => E.ctx.studioSendCampaign({ recipients: Array.from({ length: 51 }, (_, i) => `u${i}@x.co`).join('\n'), subject: 's', body: 'x' }), /Up to 50/);
  assert.strictEqual(E.sent.length, 0);
});

test('follow-up fires as a threaded reply; reply from them cancels the rest', () => {
  const E = makeEnv();
  E.ctx.studioSendCampaign({ recipients: 'Jane Roe <jane@acme.com>', subject: 'Hello', body: 'First',
    followUps: [{ amount: 1, unit: 'minutes', message: 'Bump {firstName}' }, { amount: 1, unit: 'days', message: 'Bump 2' }] });
  let data = JSON.parse(E.userProps.custom_t1); data.steps[0].sendAt = Date.now() - 1000;
  E.userProps.custom_t1 = JSON.stringify(data);
  E.ctx.processFollowUps();
  const fu = E.sent[1];
  assert.strictEqual(fu.threadId, 't1'); assert.strictEqual(fu.headers.Subject, 'Re: Hello');
  assert.strictEqual(fu.headers.To, '"Jane Roe" <jane@acme.com>');
  assert.strictEqual(fu.headers['In-Reply-To'], '<orig@x>');
  assert.ok(fu.text.startsWith('Bump Jane'));
  E.threads.t1.messages.push(E.mkMessage({ from: 'Jane <jane@acme.com>', to: ME }));
  data = JSON.parse(E.userProps.custom_t1); data.steps[0].sendAt = Date.now() - 1000;
  E.userProps.custom_t1 = JSON.stringify(data);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2, 'no bump after their reply');
  assert.ok(!E.userProps.custom_t1);
});

test('send succeeded but arming failed is not reported as a failed send', () => {
  const E = makeEnv();
  const orig = E.ctx.GmailApp.getThreadById;
  E.ctx.GmailApp.getThreadById = () => null;
  const res = E.ctx.studioSendCampaign({ recipients: 'a@b.co', subject: 's', body: 'b', followUps: [{ amount: 1 }] });
  E.ctx.GmailApp.getThreadById = orig;
  assert.strictEqual(res.sent, 1); assert.strictEqual(res.failed.length, 0); assert.strictEqual(res.notArmed.length, 1);
});

test('templates migrate into sequences without losing data on name clashes', () => {
  const E = makeEnv();
  E.userProps.template_X = JSON.stringify({ steps: [{ amount: 1, message: 'tpl' }] });
  E.userProps.seq_X = JSON.stringify({ steps: [] });
  E.userProps['seq_X (template)'] = JSON.stringify({ steps: [] });
  E.userProps.template_Broken = '{not json';
  E.ctx.listSequences_();
  assert.strictEqual(JSON.parse(E.userProps['seq_X (template 2)']).steps[0].message, 'tpl');
  assert.ok(!E.userProps.template_X && E.userProps.template_Broken);
});

test('studioSaveSequence saves, renames, keeps sidebar recipients, validates', () => {
  const E = makeEnv();
  E.userProps.seq_Old = JSON.stringify({ steps: [{ amount: 1, unit: 'days' }], recipients: 'keep@me.co' });
  const list = E.ctx.studioSaveSequence({ name: 'New', originalName: 'Old', subject: 'S', firstMessage: 'F',
    steps: [{ amount: 3, unit: 'days', condition: 'replied', message: 'm' }, { amount: '2', unit: 'bogus', atTime: '25:00' }] });
  assert.deepStrictEqual(list.map(s => s.name), ['New']);
  const s = JSON.parse(E.userProps.seq_New);
  assert.strictEqual(s.recipients, 'keep@me.co'); assert.strictEqual(s.steps[1].unit, 'days'); assert.strictEqual(s.steps[1].atTime, '');
  assert.throws(() => E.ctx.studioSaveSequence({ name: '', steps: [] }), /name/);
  assert.throws(() => E.ctx.studioSaveSequence({ name: 'big', steps: [{ amount: 1, message: 'x'.repeat(9000) }] }), /too long/);
});

test('sidebar: one-click Start, cards render, builder saves', () => {
  const E = makeEnv();
  E.mkThread('th', 'Intro', [E.mkMessage({ from: ME, to: 'Pat <pat@co.io>' })]);
  E.userProps.seq_Bumps = JSON.stringify({ steps: [{ amount: 2, unit: 'days', message: 'a' }, { amount: 5, unit: 'days', message: 'b' }] });
  E.ctx.buildCard_('th');
  assert.ok(E.texts.includes('<b>Bumps</b>') && E.texts.includes('New sequence'));
  E.ctx.actionStartSequence({ parameters: { threadId: 'th', name: 'Bumps' } });
  const d = JSON.parse(E.userProps.custom_th);
  assert.strictEqual(d.steps.length, 2);
  assert.ok(Math.abs(d.steps[1].sendAt - Date.now() - 7 * 86400000) < 5000);
  E.ctx.buildBuilderCard_('th'); E.ctx.buildDashboardCard_();
  E.ctx.actionSaveCampaign({ parameters: { threadId: 'th' }, formInput: { amount_0: '3', unit_0: 'days', message_0: 'yo' }, commonEventObject: { formInputs: {} } });
  assert.strictEqual(JSON.parse(E.userProps.custom_th).steps.length, 3);
});

test('existing thread: exact date, per-step cc, list, remove', () => {
  const E = makeEnv();
  const t = E.mkThread('th', 'Intro', [E.mkMessage({ from: ME, to: 'Pat <pat@co.io>', body: 'Hello Pat' })]);
  const tomorrow = E.ctx.Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Kolkata', 'yyyy-MM-dd');
  const res = E.ctx.studioScheduleOnThread({ threadId: 'th', tz: 'Asia/Kolkata', followUps: [
    { amount: 1, unit: 'days', sendAtAbs: Date.parse(tomorrow + 'T09:00:00Z'), condition: 'always', message: 'A', cc: 'boss@co.io' },
    { amount: 2, unit: 'days', message: 'B' }] });
  assert.strictEqual(res.thread.queue.length, 2);
  const q = JSON.parse(E.userProps.custom_th).steps;
  assert.strictEqual(E.ctx.Utilities.formatDate(new Date(q[0].sendAt), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'), tomorrow + ' 09:00');
  assert.strictEqual(q[0].cc, 'boss@co.io');
  const list = E.ctx.studioListThreads('');
  assert.ok(list[0].armed && list[0].waiting && list[0].recipient.includes('pat@co.io'));
  E.ctx.studioRemoveStep('th', 0); E.ctx.studioRemoveStep('th', 0);
  assert.ok(!E.userProps.custom_th && !t.labels.has('FU/Custom'));
  assert.throws(() => E.ctx.studioScheduleOnThread({ threadId: 'th', followUps: [{ sendAtAbs: Date.parse('2020-01-01T09:00:00Z') }] }), /future/);
  assert.throws(() => E.ctx.studioScheduleOnThread({ threadId: 'nope', followUps: [{ amount: 1 }] }), /could not be found/);
});

test('Open Studio link: configured deployment, procmart form for procmart users', () => {
  const E = makeEnv();
  const id = vm.runInContext('CONFIG.studioDeploymentId', E.ctx);
  assert.strictEqual(E.ctx.getStudioUrl_(), 'https://script.google.com/a/macros/procmart.com/s/' + id + '/exec');
  E.actAs('revasha.kayana@procmart.com');
  assert.strictEqual(E.ctx.getStudioUrl_(), 'https://script.google.com/a/macros/procmart.com/s/' + id + '/exec');
  E.actAs('someone@gmail.com');
  assert.strictEqual(E.ctx.getStudioUrl_(), 'https://script.google.com/macros/s/' + id + '/exec');
});

test('teammate sends as themselves, never as the owner', () => {
  const E = makeEnv();
  E.actAs('nabilla.amara@procmart.com');
  E.ctx.studioSendCampaign({ recipients: 'x@y.co', subject: 's', body: 'b' });
  assert.ok(E.sent[0].headers.From.includes('nabilla.amara@procmart.com'));
  assert.ok(!E.sent[0].headers.From.includes('Abhishek'));
});

test('team status: teammate heartbeats visible to the owner only', () => {
  const E = makeEnv();
  E.actAs('nabilla.amara@procmart.com');
  E.ctx.buildAddOn({});
  E.ctx.processFollowUps();
  assert.strictEqual(E.ctx.studioTeam_(), null, 'teammate cannot see the team list');
  E.actAs(ME);
  const team = E.ctx.studioTeam_();
  assert.strictEqual(team.length, 1);
  assert.strictEqual(team[0].email, 'nabilla.amara@procmart.com');
  assert.ok(team[0].sidebar && !team[0].studio && team[0].running && /ago/.test(team[0].lastRun), JSON.stringify(team[0]));
  assert.ok(Array.isArray(E.ctx.studioBootstrap().team));
});

test('sidebar home: menu, Studio link, alert only when broken', () => {
  const E = makeEnv();
  E.ctx.buildDashboardCard_();
  assert.ok(E.texts.includes('New campaign') && E.texts.includes('Sequences') && E.texts.includes('Settings') && E.texts.includes('Follow up a sent email'));
  assert.ok(E.texts.some(t => /Follow-ups are on/.test(t)), 'status line like the page');
  assert.ok(E.texts.includes('Open the full page'));
  assert.ok(!E.texts.includes('Fix it'));
  E.ctx.ScriptApp.getProjectTriggers = () => [];
  E.texts.length = 0; E.ctx.buildDashboardCard_();
  assert.ok(E.texts.includes('Fix it'));
});

test('sidebar new campaign: pick sequence prefills, send arms follow-ups, draft cleared', () => {
  const E = makeEnv();
  E.userProps.seq_Std = JSON.stringify({ subject: 'Idea for {firstName}', firstMessage: 'Hi {firstName}', steps: [{ amount: 3, unit: 'days', message: 'bump' }, { amount: 4, unit: 'days', message: 'last' }] });
  const ce = v => ({ commonEventObject: { formInputs: { ncSequence: { stringInputs: { value: [v] } } } } });
  E.ctx.actionNcPickSequence({ formInput: { ncTo: 'Jane Roe <jane@acme.com>\nsam@x.co' }, ...ce('Std') });
  const d = JSON.parse(E.userProps.nc_draft);
  assert.strictEqual(d.subject, 'Idea for {firstName}'); assert.strictEqual(d.body, 'Hi {firstName}');
  E.texts.length = 0; E.ctx.buildNewCampaignCard_();
  assert.ok(E.texts.some(t => /3 days after the first email/.test(t)), 'step preview shown');
  E.ctx.actionNcReview({ formInput: { ncTo: d.recipients, ncSubject: d.subject, ncBody: '\n\n' + d.body + '\n' }, ...ce('Std') });
  assert.strictEqual(E.sent.length, 0, 'review sends nothing');
  assert.ok(E.texts.includes('Send to 2 people') && E.texts.some(t => /Idea for Jane/.test(t)));
  assert.ok(E.texts.some(t => /sam@x.co have no name|1 of 2 have no name/.test(t)), 'no-name warning');
  E.ctx.actionNcSend();
  assert.strictEqual(E.sent.length, 2);
  assert.strictEqual(E.sent[0].headers.Subject, 'Idea for Jane');
  assert.ok(E.sent[0].text.startsWith('Hi Jane'));
  assert.strictEqual(JSON.parse(E.userProps.custom_t1).steps.length, 2);
  assert.ok(!E.userProps.nc_draft);
});

test('sidebar new campaign: cap, validation, test send goes to me only', () => {
  const E = makeEnv();
  E.ctx.actionNcReview({ formInput: { ncTo: Array.from({ length: 11 }, (_, i) => `u${i}@x.co`).join(','), ncSubject: 's', ncBody: 'b' } });
  E.ctx.actionNcSend();
  E.ctx.actionNcReview({ formInput: { ncTo: 'a@b.co', ncSubject: '', ncBody: 'b' } });
  E.ctx.actionNcSend();
  assert.strictEqual(E.sent.length, 0);
  E.ctx.actionNcTest({ formInput: { ncTo: 'Jane Roe <jane@acme.com>', ncSubject: 'Hi {firstName}', ncBody: 'Yo {firstName}' } });
  assert.strictEqual(E.sent.length, 1);
  assert.strictEqual(E.sent[0].headers.To, ME); assert.strictEqual(E.sent[0].headers.Subject, '[Test] Hi Jane');
  assert.ok(!Object.keys(E.userProps).some(k => k.startsWith('custom_')));
});

test('sidebar new campaign: partial failure keeps only failed addresses', () => {
  const E = makeEnv();
  const send = E.ctx.Gmail.Users.Messages.send;
  E.ctx.Gmail.Users.Messages.send = (r) => { if (Buffer.from(r.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString().includes('bad@x.co')) throw new Error('Invalid To'); return send(r); };
  E.ctx.actionNcReview({ formInput: { ncTo: 'ok@x.co, bad@x.co', ncSubject: 's', ncBody: 'b' } });
  E.ctx.actionNcSend();
  assert.strictEqual(E.sent.length, 1);
  assert.strictEqual(JSON.parse(E.userProps.nc_draft).recipients, 'bad@x.co');
});

test('sidebar sequence editor: new, rename, delete; per-step cc kept; dup name refused', () => {
  const E = makeEnv();
  E.ctx.actionOpenSequenceEditor({ parameters: { returnTo: 'list' } });
  assert.strictEqual(JSON.parse(E.userProps.seq_edit).steps.length, 2);
  E.ctx.actionSeqAddStep({ formInput: { seqName: 'A', amount_0: '2', unit_0: 'days', message_0: 'one', cc_0: 'boss@co.io', amount_1: '5', unit_1: 'hours', message_1: 'two' }, commonEventObject: { formInputs: {} } });
  assert.strictEqual(JSON.parse(E.userProps.seq_edit).steps.length, 3);
  const form = { seqName: 'A', seqSubject: 'Subj', seqFirst: '\n\nFirst', amount_0: '2', unit_0: 'days', message_0: 'one', cc_0: 'boss@co.io', amount_1: '5', unit_1: 'hours', message_1: 'two', amount_2: '1', unit_2: 'days' };
  E.ctx.actionSeqSave({ formInput: form, commonEventObject: { formInputs: {} } });
  const a = JSON.parse(E.userProps.seq_A);
  assert.strictEqual(a.steps.length, 3); assert.strictEqual(a.steps[0].cc, 'boss@co.io'); assert.strictEqual(a.steps[1].unit, 'hours');
  assert.strictEqual(a.firstMessage, 'First'); assert.ok(!E.userProps.seq_edit);
  E.userProps.seq_B = JSON.stringify({ steps: [{ amount: 1 }] });
  E.ctx.actionOpenSequenceEditor({ parameters: { name: 'A', returnTo: 'list' } });
  E.ctx.actionSeqSave({ formInput: { ...form, seqName: 'B' }, commonEventObject: { formInputs: {} } });
  assert.ok(E.userProps.seq_A && JSON.parse(E.userProps.seq_B).steps.length === 1, 'dup name refused');
  E.ctx.actionSeqSave({ formInput: { ...form, seqName: 'C' }, commonEventObject: { formInputs: {} } });
  assert.ok(!E.userProps.seq_A && E.userProps.seq_C, 'renamed');
  E.ctx.actionOpenSequenceEditor({ parameters: { name: 'C', returnTo: 'list' } });
  E.ctx.actionSeqAskDelete({ formInput: { ...form, seqName: 'C' }, commonEventObject: { formInputs: {} } });
  E.ctx.actionSeqDelete({ parameters: {} });
  assert.ok(!E.userProps.seq_C);
});

test('sidebar: sent-email list opens threads; settings save name, tz, signature', () => {
  const E = makeEnv();
  E.mkThread('th', 'Pricing', [E.mkMessage({ from: ME, to: 'Pat <pat@co.io>' })]);
  E.ctx.buildSentThreadsCard_('');
  assert.ok(E.texts.includes('Pricing') && E.texts.some(t => /No reply yet/.test(t)));
  E.ctx.actionSaveSettings({ formInput: { senderDisplayName: 'Abhi S', senderFirstNameField: 'Abhi', signatureText: 'Abhi\nProcMart\n\n' },
    commonEventObject: { formInputs: { settingsTz: { stringInputs: { value: ['Asia/Kolkata'] } } } } });
  assert.strictEqual(E.userProps.preferredTz, 'Asia/Kolkata');
  assert.strictEqual(E.ctx.getSignature_(), 'Abhi\nProcMart');
  assert.strictEqual(E.ctx.getSenderDisplayName_(), 'Abhi S');
  E.ctx.buildSettingsCard_();
  E.ctx.actionRunNow({ parameters: { from: 'settings' } });
});

test('checks: review warns on skipped/unknown placeholders/no follow-ups; stop and delete need confirmation', () => {
  const E = makeEnv();
  E.ctx.actionNcReview({ formInput: { ncTo: 'a@b.co, not-an-email', ncSubject: 'Hi {company}', ncBody: 'b' } });
  assert.ok(E.texts.some(t => /Skipped, not a valid email: not-an-email/.test(t)));
  assert.ok(E.texts.some(t => /\{company\} won/.test(t)));
  assert.ok(E.texts.some(t => /No follow-ups picked/.test(t)));
  E.mkThread('th', 'Intro', [E.mkMessage({ from: ME, to: 'Pat <pat@co.io>' })]);
  E.userProps.seq_S = JSON.stringify({ steps: [{ amount: 2, unit: 'days', message: 'a' }] });
  E.ctx.actionStartSequence({ parameters: { threadId: 'th', name: 'S' } });
  E.ctx.actionAskStop({ parameters: { threadId: 'th', from: 'home' } });
  assert.ok(E.userProps.custom_th, 'asking does not stop');
  E.ctx.actionStopConfirmed({ parameters: { threadId: 'th', from: 'thread' } });
  assert.ok(!E.userProps.custom_th && !E.threads.th.labels.has('FU/Custom'));
  E.ctx.actionOpenSequenceEditor({ parameters: { name: 'S', returnTo: 'list' } });
  E.ctx.actionSeqAskDelete({ formInput: { seqName: 'S', amount_0: '2', unit_0: 'days' }, commonEventObject: { formInputs: {} } });
  assert.ok(E.userProps.seq_S, 'asking does not delete');
  E.ctx.actionSeqDelete({ parameters: {} });
  assert.ok(!E.userProps.seq_S);
});

test('home shows getting-started only for a brand-new user', () => {
  const E = makeEnv();
  E.ctx.buildDashboardCard_();
  assert.ok(E.texts.includes('Getting started'));
  E.userProps.seq_S = JSON.stringify({ steps: [{ amount: 2 }] });
  E.texts.length = 0; E.ctx.buildDashboardCard_();
  assert.ok(!E.texts.includes('Getting started'));
});

test('MCP API: send_campaign previews without sending, sends only with confirm', () => {
  const E = makeEnv();
  E.userProps.seq_S = JSON.stringify({ steps: [{ amount: 2, unit: 'days', message: 'Bump {firstName}' }, { amount: 3, unit: 'days', message: '' }] });
  const p = { recipients: 'Jane Roe <jane@acme.com>, bad-one, sam@globex.com', subject: 'Hi {firstName}', body: 'Hello {firstName} {company}', sequence: 'S', tz: 'Asia/Kolkata' };
  const pv = E.ctx.mcpSendCampaign(p);
  assert.strictEqual(E.sent.length, 0);
  assert.ok(pv.preview);
  assert.strictEqual(JSON.stringify(pv.recipients), JSON.stringify(['Jane Roe <jane@acme.com>', 'sam@globex.com']));
  assert.strictEqual(pv.firstEmail.subject, 'Hi Jane');
  assert.strictEqual(pv.followUps.length, 2);
  assert.strictEqual(pv.followUps[0].message, 'Bump Jane');
  assert.ok(/^About /.test(pv.followUps[1].when));
  assert.ok(pv.warnings.some(w => /Skipped, not a valid email: bad-one/.test(w)));
  assert.ok(pv.warnings.some(w => /\{company\} won/.test(w)));
  assert.throws(() => E.ctx.mcpSendCampaign({ recipients: 'a@b.co', subject: '', body: 'x' }), /subject/);
  assert.throws(() => E.ctx.mcpSendCampaign({ recipients: 'a@b.co', subject: 's', body: 'x', sequence: 'Nope' }), /not found/);
  assert.strictEqual(E.sent.length, 0);
  const res = E.ctx.mcpSendCampaign(Object.assign({ confirm: true }, p));
  assert.strictEqual(res.sent, 2); assert.strictEqual(E.sent.length, 2);
  assert.strictEqual(JSON.parse(E.userProps.custom_t1).steps.length, 2);
});

test('MCP API: sequence on a thread and stop both need confirm', () => {
  const E = makeEnv();
  E.mkThread('th', 'Intro', [E.mkMessage({ from: ME, to: 'Pat Lee <pat@co.io>' })]);
  E.userProps.seq_S = JSON.stringify({ steps: [{ amount: 2, unit: 'days', message: 'Hi {firstName}' }] });
  const pv = E.ctx.mcpStartSequenceOnThread({ threadId: 'th', sequence: 'S' });
  assert.ok(pv.preview && !E.userProps.custom_th);
  assert.strictEqual(pv.followUps[0].message, 'Hi Pat');
  assert.throws(() => E.ctx.mcpStopCampaign('th'), /Nothing is scheduled/);
  const ok = E.ctx.mcpStartSequenceOnThread({ threadId: 'th', sequence: 'S', confirm: true });
  assert.ok(ok.scheduled && E.userProps.custom_th);
  assert.strictEqual(JSON.parse(E.userProps.custom_th).campaignName, 'S');
  const stopPv = E.ctx.mcpStopCampaign('th');
  assert.ok(stopPv.preview && stopPv.cancels.length === 1 && E.userProps.custom_th);
  const stopped = E.ctx.mcpStopCampaign('th', true);
  assert.ok(stopped.stopped && !E.userProps.custom_th && !E.threads.th.labels.has('FU/Custom'));
  assert.strictEqual(E.sent.length, 0);
  assert.strictEqual(E.ctx.mcpListSequences()[0].name, 'S');
  assert.ok('running' in E.ctx.mcpStatus());
});

test('scheduler: old trigger with no interval record is rebuilt at 5 min, once', () => {
  const E = makeEnv();
  let triggers = [{ getHandlerFunction: () => 'processFollowUps', old: true }], created = [];
  E.ctx.ScriptApp.getProjectTriggers = () => triggers;
  E.ctx.ScriptApp.deleteTrigger = (t) => { triggers = triggers.filter(x => x !== t); };
  E.ctx.ScriptApp.newTrigger = () => { const b = { timeBased: () => b, everyMinutes: (m) => { b.m = m; return b; },
    create: () => { created.push(b.m); triggers.push({ getHandlerFunction: () => 'processFollowUps' }); } }; return b; };
  E.ctx.processFollowUps();
  assert.deepStrictEqual(created, [5]); assert.strictEqual(triggers.length, 1); assert.ok(!triggers[0].old);
  E.ctx.processFollowUps(); E.ctx.ensureScheduler_();
  assert.deepStrictEqual(created, [5], 'no rebuild once recorded');
});

test('Studio campaign log: list shows status, report shows each person\'s stage, stop marks it', () => {
  const E = makeEnv();
  E.ctx.studioSendCampaign({ recipients: 'Jane <jane@acme.com>\nsam@globex.com', subject: 'Hi', body: 'First',
    followUps: [{ amount: 1, unit: 'days' }, { amount: 2, unit: 'days' }], campaignName: 'Q4' });
  let st = E.ctx.studioState();
  assert.strictEqual(st.campaignList.length, 1);
  const row = st.campaignList[0];
  assert.strictEqual(row.name, 'Q4'); assert.strictEqual(row.status, 'active');
  assert.strictEqual(row.recipients, 2); assert.strictEqual(row.active, 2); assert.strictEqual(row.steps, 2);
  // Jane replies: the scheduler drops her follow-ups.
  E.threads.t1.messages.push(E.mkMessage({ from: 'Jane <jane@acme.com>', to: ME }));
  const d = JSON.parse(E.userProps.custom_t1); d.steps[0].sendAt = Date.now() - 1000; E.userProps.custom_t1 = JSON.stringify(d);
  E.ctx.processFollowUps();
  let rep = E.ctx.studioGetCampaign(row.id);
  assert.strictEqual(rep.totals.recipients, 2); assert.strictEqual(rep.totals.replied, 1); assert.strictEqual(rep.totals.active, 1);
  const jane = rep.people.find(p => p.email === 'jane@acme.com'), sam = rep.people.find(p => p.email === 'sam@globex.com');
  assert.strictEqual(jane.status, 'replied'); assert.strictEqual(jane.stages.join(), 'sent,skipped,skipped');
  assert.strictEqual(sam.status, 'active'); assert.strictEqual(sam.stages.join(), 'sent,next,pending');
  E.ctx.studioStopCampaign(row.id);
  rep = E.ctx.studioGetCampaign(row.id);
  assert.strictEqual(rep.people.find(p => p.email === 'sam@globex.com').status, 'stopped');
  assert.strictEqual(E.ctx.studioState().campaignList[0].status, 'ended');
  assert.strictEqual(E.sent.length, 2, 'stopping and reporting never send');
});

test('Studio campaign list groups follow-ups started from Gmail; log keeps 30 campaigns', () => {
  const E = makeEnv();
  E.mkThread('th', 'Proposal', [E.mkMessage({ from: ME, to: 'Kim <kim@x.co>' })]);
  E.ctx.studioScheduleOnThread({ threadId: 'th', followUps: [{ amount: 2, unit: 'days' }] });
  const list = E.ctx.studioState().campaignList;
  assert.strictEqual(list.length, 1); assert.ok(list[0].id.indexOf('g:') === 0); assert.strictEqual(list[0].status, 'active');
  const rep = E.ctx.studioGetCampaign(list[0].id);
  assert.strictEqual(rep.people.length, 1); assert.strictEqual(rep.people[0].status, 'active');
  for (let i = 0; i < 33; i++) E.ctx.logCampaign_({ name: 'c' + i, subject: 's', steps: 0, recipients: [] });
  assert.strictEqual(Object.keys(E.userProps).filter(k => k.indexOf('clog_') === 0).length, 30);
});

test('Studio preview runs the review checks and never sends; test goes to me only', () => {
  const E = makeEnv();
  const p = E.ctx.studioPreview({ recipients: 'sam@globex.com, nope', subject: 'Hi {firstName} {company}', body: 'x',
    followUps: [{ amount: 3, unit: 'days', message: '' }], tz: 'Asia/Kolkata' });
  assert.strictEqual(p.blockers.length, 0);
  assert.ok(p.warnings.some(w => /nope/.test(w)), 'skipped address');
  assert.ok(p.warnings.some(w => /\{company\}/.test(w)), 'unknown placeholder');
  assert.ok(p.warnings.some(w => /default/.test(w)), 'blank follow-up uses default');
  assert.strictEqual(p.schedule.length, 1); assert.strictEqual(p.from, ME);
  const bad = E.ctx.studioPreview({ recipients: '', subject: '', body: '', followUps: [{ amount: 0 }] });
  assert.strictEqual(bad.blockers.length, 4);
  assert.strictEqual(E.ctx.studioPreview({ mode: 'thread', followUps: [] }).blockers.length, 1);
  assert.ok(!Object.values(E.userProps).includes('Asia/Kolkata'), 'preview never saves the timezone');
  assert.strictEqual(E.sent.length, 0);
  E.ctx.studioSendTest({ step: 0, recipients: 'Jane Roe <jane@acme.com>', subject: 'Hello', body: 'B', followUps: [{ message: 'Bump {firstName}' }] });
  assert.strictEqual(E.sent.length, 1);
  assert.ok(E.sent[0].headers.To.includes(ME)); assert.strictEqual(E.sent[0].headers.Subject, '[Test] Re: Hello');
  assert.ok(E.sent[0].text.startsWith('Bump Jane'));
  assert.strictEqual(E.ctx.studioState().campaignList.length, 0, 'a test is not a campaign');
});

// ───── Autopilot ─────
// Arms one due follow-up per recipient and returns the env. Times are in UTC so
// the windows below line up with the real clock.
function autopilotEnv(n, ap) {
  const E = makeEnv();
  E.userProps.preferredTz = 'UTC';
  E.ctx.studioSendCampaign({ recipients: Array.from({ length: n }, (_, i) => `p${i}@x.co`).join('\n'), subject: 'Hi', body: 'First',
    followUps: [{ amount: 1, unit: 'days', message: 'Bump' }] });
  for (let i = 1; i <= n; i++) {
    const d = JSON.parse(E.userProps['custom_t' + i]); d.steps[0].sendAt = Date.now() - 1000; E.userProps['custom_t' + i] = JSON.stringify(d);
  }
  if (ap) E.ctx.studioSaveAutopilot(ap);
  E.sent.length = 0;
  return E;
}
const today = new Date().getUTCDay();
const week = (fn) => Array.from({ length: 7 }, (_, d) => fn(d));
const allDay = { on: true, from: '00:00', to: '23:59' };
const queued = (E, n) => Array.from({ length: n }, (_, i) => E.userProps['custom_t' + (i + 1)]).filter(Boolean).length;

test('autopilot: off by default, follow-ups go out as soon as due', () => {
  const E = autopilotEnv(2);
  assert.strictEqual(E.ctx.studioBootstrap().autopilot.settings.enabled, false);
  const def = E.ctx.studioBootstrap().autopilot.settings.days;
  assert.strictEqual(def.map(d => d.on).join(), 'false,true,true,true,true,true,false');
  assert.ok(def.every(d => d.from === '09:00' && d.to === '17:00'));
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2);
});

test('autopilot: due follow-up outside the sending days is held, then sent inside the window', () => {
  const E = autopilotEnv(2, { enabled: true, maxPerDay: 50, delayMinutes: 0, days: week(d => d === today ? { on: false } : allDay) });
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 0, 'nothing sent on a day that is off');
  assert.strictEqual(queued(E, 2), 2, 'held, not dropped');
  const st = E.ctx.autopilotStatus_();
  assert.strictEqual(st.sendingNow, false); assert.ok(st.nextSlotLabel, 'shows the next slot');
  E.ctx.studioSaveAutopilot({ enabled: true, maxPerDay: 50, delayMinutes: 0, days: week(() => allDay) });
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2); assert.strictEqual(queued(E, 2), 0);
});

test('autopilot: hours outside the window hold follow-ups until it opens', () => {
  const h = new Date().getUTCHours();
  // A 1-hour window that starts two hours from now (or ended two hours ago).
  const p = n => (n < 10 ? '0' : '') + n + ':00';
  const win = h <= 20 ? { on: true, from: p(h + 2), to: p(h + 3) } : { on: true, from: p(h - 3), to: p(h - 2) };
  const E = autopilotEnv(1, { enabled: true, delayMinutes: 0, days: week(() => win) });
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 0); assert.strictEqual(queued(E, 1), 1);
});

test('autopilot: daily cap defers the rest to the next day', () => {
  const E = autopilotEnv(3, { enabled: true, maxPerDay: 2, delayMinutes: 0, days: week(() => allDay) });
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2); assert.strictEqual(queued(E, 3), 1);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2, 'cap holds across runs on the same day');
  const st = JSON.parse(E.userProps.autopilotState); st.day = '2000-01-01'; E.userProps.autopilotState = JSON.stringify(st);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 3, 'a new day resets the count'); assert.strictEqual(queued(E, 3), 0);
});

test('autopilot: minimum delay spaces sends across runs, also within one thread', () => {
  const E = autopilotEnv(2, { enabled: true, maxPerDay: 50, delayMinutes: 10, days: week(() => allDay) });
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 1);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 1, 'too soon after the last send');
  const st = JSON.parse(E.userProps.autopilotState); st.lastAt -= 11 * 60000; E.userProps.autopilotState = JSON.stringify(st);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2);
  // Two steps of one thread due at once: still one per delay.
  E.userProps.custom_t1 = JSON.stringify({ steps: [{ sendAt: Date.now() - 2000, message: 'a' }, { sendAt: Date.now() - 1000, message: 'b' }] });
  E.threads.t1.labels.add('FU/Custom');
  const st2 = JSON.parse(E.userProps.autopilotState); st2.lastAt -= 11 * 60000; E.userProps.autopilotState = JSON.stringify(st2);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 3); assert.strictEqual(JSON.parse(E.userProps.custom_t1).steps.length, 1);
});

test('autopilot: dry run respects the cap but does not use up the day', () => {
  const E = autopilotEnv(2, { enabled: true, maxPerDay: 1, delayMinutes: 0, days: week(() => allDay) });
  vm.runInContext('CONFIG.dryRun = true', E.ctx);
  E.ctx.processFollowUps();
  vm.runInContext('CONFIG.dryRun = false', E.ctx);
  assert.strictEqual(E.sent.length, 0); assert.ok(!E.userProps.autopilotState);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 1);
});

test('autopilot: settings are cleaned up when saved', () => {
  const E = makeEnv();
  const st = E.ctx.studioSaveAutopilot({ enabled: 1, maxPerDay: '-4', delayMinutes: 'abc',
    days: [{ on: true, from: '18:00', to: '09:00' }, { on: true, from: '7:30', to: '25:00' }] });
  const s = st.settings;
  assert.strictEqual(s.enabled, true); assert.strictEqual(s.maxPerDay, 1); assert.strictEqual(s.delayMinutes, 5);
  assert.strictEqual(JSON.stringify(s.days[0]), JSON.stringify({ on: true, from: '09:00', to: '17:00' }), 'reversed window falls back');
  assert.strictEqual(s.days[1].from, '07:30'); assert.strictEqual(s.days[1].to, '17:00');
  assert.strictEqual(s.days[6].on, false);
  assert.strictEqual(E.ctx.studioSaveAutopilot({ maxPerDay: 99999, delayMinutes: 999 }).settings.maxPerDay, 2000);
  assert.strictEqual(E.ctx.getAutopilot_().delayMinutes, 120);
});

test('MCP API: save, rename-guard, overwrite and delete a sequence', () => {
  const E = makeEnv();
  const step = { amount: 3, unit: 'days', message: 'Bump {firstName}' };
  const r = E.ctx.mcpSaveSequence({ name: 'A', steps: [step, { amount: 4, unit: 'days', message: 'Last' }] });
  assert.strictEqual(r.saved, 'A'); assert.strictEqual(JSON.parse(E.userProps.seq_A).steps.length, 2);
  assert.throws(() => E.ctx.mcpSaveSequence({ name: 'A', steps: [step] }), /already exists/);
  E.ctx.mcpSaveSequence({ name: 'A', overwrite: true, steps: [step] });
  assert.strictEqual(JSON.parse(E.userProps.seq_A).steps.length, 1);
  E.ctx.mcpSaveSequence({ name: 'B', originalName: 'A', steps: [step] });
  assert.ok(!E.userProps.seq_A && E.userProps.seq_B, 'renamed');
  assert.ok(E.ctx.mcpDeleteSequence('B', false).preview && E.userProps.seq_B, 'preview keeps it');
  E.ctx.mcpDeleteSequence('B', true);
  assert.ok(!E.userProps.seq_B);
  assert.throws(() => E.ctx.mcpDeleteSequence('nope', false), /No sequence/);
  assert.strictEqual(E.sent.length, 0);
});

test('attachments: first email, a follow-up via holder draft, then cleanup', () => {
  const E = makeEnv();
  const pdf = Buffer.from('%PDF-1.4 quote').toString('base64');
  const res = E.ctx.mcpSendCampaign({ confirm: true, recipients: 'Jane Roe <jane@acme.com>', subject: 'Quote', body: 'Hi {firstName}',
    attachments: [{ name: 'quote.pdf', mimeType: 'application/pdf', data: pdf }],
    followUps: [{ amount: 1, unit: 'minutes', message: 'Specs attached', attachments: [{ name: 'specs.pdf', mimeType: 'application/pdf', data: pdf }] }] });
  assert.strictEqual(res.sent, 1, JSON.stringify(res));
  const first = Buffer.from(E.sent[0].raw || '', 'base64');
  const mime0 = E.sentRaw ? E.sentRaw[0] : null;
  const step = JSON.parse(E.userProps.custom_t1).steps[0];
  assert.ok(step.attachDraftId && step.attachNames[0] === 'specs.pdf', JSON.stringify(step));
  assert.strictEqual(Object.keys(E.drafts).length, 1, 'one holder draft');
  const data = JSON.parse(E.userProps.custom_t1); data.steps[0].sendAt = Date.now() - 1000;
  E.userProps.custom_t1 = JSON.stringify(data);
  E.ctx.processFollowUps();
  assert.strictEqual(E.sent.length, 2, 'follow-up sent');
  assert.ok(E.sentMime[0].includes('multipart/mixed') && E.sentMime[0].includes('filename="quote.pdf"'), 'first email has quote.pdf');
  assert.ok(E.sentMime[1].includes('filename="specs.pdf"') && E.sentMime[1].includes(pdf), 'follow-up has specs.pdf');
  assert.strictEqual(E.sent[1].threadId, 't1', 'follow-up still threaded');
  assert.strictEqual(Object.keys(E.drafts).length, 0, 'holder cleaned up');
});

test('attachments: a saved sequence keeps its holder across reuse', () => {
  const E = makeEnv();
  const pdf = Buffer.from('x').toString('base64');
  E.ctx.mcpSaveSequence({ name: 'S', steps: [{ amount: 1, unit: 'minutes', message: 'm', attachments: [{ name: 'a.pdf', mimeType: 'application/pdf', data: pdf }] }] });
  E.ctx.mcpSendCampaign({ confirm: true, recipients: 'a@b.co', subject: 's', body: 'b', sequence: 'S' });
  const data = JSON.parse(E.userProps.custom_t1); data.steps[0].sendAt = Date.now() - 1000;
  E.userProps.custom_t1 = JSON.stringify(data);
  E.ctx.processFollowUps();
  assert.ok(E.sentMime[1].includes('filename="a.pdf"'));
  assert.strictEqual(Object.keys(E.drafts).length, 1, 'sequence still needs it');
  E.ctx.mcpDeleteSequence('S', true);
  assert.strictEqual(Object.keys(E.drafts).length, 0, 'gone once the sequence is deleted');
});

console.log(`\n${pass} passed`);
