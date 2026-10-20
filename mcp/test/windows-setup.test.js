// Teammates on Windows set up through Claude Desktop only: the client file
// arrives in Downloads and must be picked up without any terminal step.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const AUTH = new URL('../auth.js', import.meta.url).href;

function runIn(home, code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GFU_HOME: path.join(home, '.gmail-followup-mcp'), GFU_OAUTH_CLIENT: '' },
    encoding: 'utf8'
  });
}

test('client_secret*.json in Downloads is copied into place; junk is ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gfu-'));
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'client_secret_junk.json'), '{"nope":1}');
  fs.writeFileSync(path.join(dl, 'client_secret_123-abc.apps.googleusercontent.com.json'),
    JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'x' } }));
  const r = runIn(home, `const a = await import(${JSON.stringify(AUTH)}); a.adoptDownloadedClient();`);
  assert.strictEqual(r.status, 0, r.stderr);
  const placed = JSON.parse(fs.readFileSync(path.join(home, '.gmail-followup-mcp', 'client_secret.json'), 'utf8'));
  assert.strictEqual(placed.installed.client_id, '123-abc.apps.googleusercontent.com');
});

test('nothing in Downloads: nothing is created', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gfu-'));
  const r = runIn(home, `const a = await import(${JSON.stringify(AUTH)}); a.adoptDownloadedClient();`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.gmail-followup-mcp', 'client_secret.json')));
});
