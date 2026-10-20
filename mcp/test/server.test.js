// Drives the MCP server through a real MCP client with a fake Apps Script
// backend, so no Google account is touched. Run: npm test (in mcp/).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gfu-'));
process.env.GFU_HOME = home;
process.env.GFU_DEPLOYMENT_ID = 'AKfyTEST';
const { buildServer, createGate } = await import('../server.js');
const appsScript = await import('../appsScript.js');

async function connect(run) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ run }).connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return client;
}

function fakeBackend() {
  const calls = [];
  const run = async (fn, params = []) => {
    calls.push([fn, params]);
    const p = params[0] || {};
    if (fn === 'mcpListSequences') return [{ name: 'Default', steps: [{ amount: 3 }] }];
    if (fn === 'mcpSendCampaign') return p.confirm ? { sent: 1, failed: [], notArmed: [], schedulerOk: true, dryRun: false } : { preview: true, recipients: ['a@b.co'], warnings: ['w'] };
    if (fn === 'mcpStopCampaign') return params[1] ? { stopped: true } : { preview: true, cancels: [{}] };
    return null;
  };
  return { calls, run };
}

const bodyOf = (r) => r.content[0].text;
const codeOf = (r) => JSON.parse(bodyOf(r).slice(bodyOf(r).indexOf('\n\n') + 2)).confirmation_code;

test('lists the expected tools', async () => {
  const c = await connect(fakeBackend().run);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['list_campaigns', 'list_sent_threads', 'list_sequences', 'send_campaign',
    'sign_in', 'sign_out', 'start_sequence_on_thread', 'status', 'stop_campaign']);
});

test('send_campaign: preview first, confirm only with the matching code and same args', async () => {
  const be = fakeBackend();
  const c = await connect(be.run);
  const args = { recipients: ['Jane <a@b.co>'], subject: 'Hi', body: 'Hello', follow_ups: [{ wait: 2 }, { send_at: '2030-01-02 9:30' }] };

  const noPreview = await c.callTool({ name: 'send_campaign', arguments: { ...args, confirm: true } });
  assert.ok(noPreview.isError && /preview first/i.test(bodyOf(noPreview)));
  assert.strictEqual(be.calls.length, 0);

  const pv = await c.callTool({ name: 'send_campaign', arguments: args });
  assert.ok(/NOTHING HAS BEEN DONE YET/.test(bodyOf(pv)));
  const sentP = be.calls[0][1][0];
  assert.strictEqual(sentP.recipients, 'Jane <a@b.co>');
  assert.ok(!sentP.confirm);
  assert.deepStrictEqual(sentP.followUps[0], { amount: 2, unit: 'days', atTime: '', condition: 'no_reply', message: '' });
  assert.strictEqual(sentP.followUps[1].sendAtAbs, Date.UTC(2030, 0, 2, 9, 30));
  const code = codeOf(pv);

  const changed = await c.callTool({ name: 'send_campaign', arguments: { ...args, subject: 'Other', confirm: true, confirmation_code: code } });
  assert.ok(changed.isError && /changed/.test(bodyOf(changed)));

  const ok = await c.callTool({ name: 'send_campaign', arguments: { ...args, confirm: true, confirmation_code: code } });
  assert.ok(!ok.isError && /Sent to 1/.test(bodyOf(ok)));
  assert.strictEqual(be.calls.at(-1)[1][0].confirm, true);

  const reused = await c.callTool({ name: 'send_campaign', arguments: { ...args, confirm: true, confirmation_code: code } });
  assert.ok(reused.isError, 'a code works once');
});

test('stop_campaign needs a preview too', async () => {
  const be = fakeBackend();
  const c = await connect(be.run);
  const bad = await c.callTool({ name: 'stop_campaign', arguments: { thread_id: 't1', confirm: true, confirmation_code: 'abc' } });
  assert.ok(bad.isError);
  const pv = await c.callTool({ name: 'stop_campaign', arguments: { thread_id: 't1' } });
  assert.deepStrictEqual(be.calls[0], ['mcpStopCampaign', ['t1', false]]);
  const ok = await c.callTool({ name: 'stop_campaign', arguments: { thread_id: 't1', confirm: true, confirmation_code: codeOf(pv) } });
  assert.ok(!ok.isError);
  assert.deepStrictEqual(be.calls[1], ['mcpStopCampaign', ['t1', true]]);
});

test('gate codes expire after 30 minutes', () => {
  let t = 0;
  const g = createGate(() => t);
  const code = g.issue('send', { a: 1 });
  t = 31 * 60 * 1000;
  assert.match(g.check('send', { a: 1, confirmation_code: code }), /30 minutes/);
});

test('not signed in gives a setup message, not a crash', async () => {
  const c = await connect(appsScript.run);
  const r = await c.callTool({ name: 'list_sequences', arguments: {} });
  assert.ok(r.isError && /Setup needed: Not signed in/.test(bodyOf(r)));
});

test('scripts.run errors become plain explanations', async () => {
  fs.writeFileSync(path.join(home, 'token.json'), JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600e3 }));
  const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  await assert.rejects(appsScript.run('x', [], { fetchImpl: reply(403, { error: { message: 'User has not enabled the Apps Script API.' } }) }), /usersettings/);
  await assert.rejects(appsScript.run('x', [], { fetchImpl: reply(404, { error: { message: 'Requested entity was not found.' } }) }), /API-executable deployment/);
  await assert.rejects(appsScript.run('mcpX', [], { fetchImpl: reply(200, { error: { details: [{ errorMessage: 'Script function not found: mcpX' }] } }) }), /new version/);
  await assert.rejects(appsScript.run('x', [], { fetchImpl: reply(200, { error: { details: [{ errorMessage: 'Add a subject.' }] } }) }), /^ScriptError: Add a subject\.$|Add a subject\./);
  let sent;
  const got = await appsScript.run('mcpStatus', [1], { fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ response: { result: { running: true } } }) }; } });
  assert.deepStrictEqual(got, { running: true });
  assert.match(sent.url, /\/v1\/scripts\/AKfyTEST:run$/);
  assert.deepStrictEqual(JSON.parse(sent.init.body), { function: 'mcpStatus', parameters: [1], devMode: false });
  assert.strictEqual(sent.init.headers.Authorization, 'Bearer a');
});
