#!/usr/bin/env node
// MCP server for the Gmail Follow-Up Tool. Claude talks to it over stdio; it
// calls the Apps Script project (Api.gs) as the signed-in Gmail user. The
// tools themselves live in tools.js (shared with the hosted connector).
//
//   node server.js          run the MCP server (what Claude Desktop starts)
//   node server.js login    sign in with Google from a terminal
//   node server.js logout   forget the saved sign-in
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as auth from './auth.js';
import * as appsScript from './appsScript.js';
import { buildServer as buildTools, createGate } from './tools.js';

export { createGate };

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip' };

// Attachments from this computer, by full path.
export async function readAttachments(paths) {
  return (paths || []).map((raw) => {
    const p = String(raw).replace(/^~(?=$|[\\/])/, os.homedir());
    let st;
    try { st = fs.statSync(p); } catch (e) { throw new Error('Attachment not found: ' + raw + '. Give the full path to the file on this computer.'); }
    if (!st.isFile()) throw new Error('Not a file: ' + raw);
    const name = path.basename(p);
    const ext = name.split('.').pop().toLowerCase();
    return { name, size: st.size, mimeType: MIME[ext] || 'application/octet-stream', data: fs.readFileSync(p).toString('base64') };
  });
}

export function buildServer({ run = appsScript.run } = {}) {
  return buildTools({
    run, readFiles: readAttachments, auth,
    fileHelp: 'full paths of files on this computer (e.g. "C:\\Users\\me\\Downloads\\quote.pdf" or "/Users/me/Downloads/quote.pdf")'
  });
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
