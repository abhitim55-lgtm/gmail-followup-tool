// Calls a public function in the Follow-Up Tool's Apps Script project through
// the Apps Script API (scripts.run), as the signed-in user.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, NeedsSetup } from './auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Which script to run. scripts.run wants the API-executable deployment ID
// (new Apps Script IDE); it comes from GFU_DEPLOYMENT_ID or config.json.
// In dev mode the script ID from ../.clasp.json runs the latest pushed code.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8')); } catch (e) { return {}; }
}

export function target() {
  if (devMode()) {
    const id = process.env.GFU_SCRIPT_ID || readJson('../.clasp.json').scriptId;
    if (id) return id;
  }
  const id = process.env.GFU_DEPLOYMENT_ID || readJson('config.json').deploymentId;
  if (!id) {
    throw new NeedsSetup('No API deployment ID yet. Create the API-executable deployment and put its ID in ' +
      'mcp/config.json as {"deploymentId": "AKfy..."} (mcp/README.md, step 1).');
  }
  return id;
}

// GFU_DEV_MODE=1 runs the latest pushed code instead of the deployed version.
// Only works for the script's owner; handy while developing.
const devMode = () => process.env.GFU_DEV_MODE === '1';

export class ScriptError extends Error {}

export async function run(fn, params = [], { fetchImpl = fetch } = {}) {
  const token = await accessToken();
  const res = await fetchImpl('https://script.googleapis.com/v1/scripts/' + encodeURIComponent(target()) + ':run', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ function: fn, parameters: params, devMode: devMode() })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ScriptError(explainHttpError(res.status, body));
  if (body.error) {
    // The script itself threw: details[0].errorMessage is its message.
    const d = (body.error.details || [])[0] || {};
    const msg = d.errorMessage || body.error.message || 'The script failed.';
    if (/Script function not found/i.test(msg)) {
      throw new ScriptError('The deployed script has no ' + fn + '(). Push the latest code and create a new version of the API deployment (mcp/README.md, step 1).');
    }
    if (/authoriz/i.test(msg)) {
      throw new ScriptError(msg + ' — open the Gmail sidebar once to approve the add-on, then sign in here again with the sign_in tool.');
    }
    throw new ScriptError(msg);
  }
  return body.response ? body.response.result : undefined;
}

function explainHttpError(status, body) {
  const e = body.error || {};
  const msg = e.message || ('HTTP ' + status);
  if (status === 401) return 'Google says the sign-in is not valid (' + msg + '). Use the sign_in tool again.';
  if (status === 403 && /Apps Script API has not been used|is disabled/i.test(msg)) {
    return 'The Apps Script API is not enabled in the Google Cloud project behind your OAuth client. ' +
      'Enable it there (mcp/README.md, step 2). Google said: ' + msg;
  }
  if (status === 403 && /User has not enabled the Apps Script API/i.test(msg)) {
    return 'Turn on "Google Apps Script API" for your account at https://script.google.com/home/usersettings, wait a minute, then try again.';
  }
  if (status === 403) {
    return 'Google refused the call (' + msg + '). Usually the script is not linked to the same Google Cloud project ' +
      'as the OAuth client, or your account cannot access the script (mcp/README.md, steps 2-3).';
  }
  if (status === 404) {
    return 'Google could not find an API-executable deployment for this script (' + msg + '). ' +
      'Create one (mcp/README.md, step 1), or check GFU_SCRIPT_ID / GFU_DEPLOYMENT_ID.';
  }
  return 'Apps Script API error: ' + msg;
}
