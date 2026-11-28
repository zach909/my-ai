#!/usr/bin/env node
/**
 * osai: talk to the AI OS layers from a terminal. The same command on Linux, Windows and macOS.
 *
 *   osai status                  the layers, what each uses on this system, and whether the engine answers
 *   osai os WORDS...             the system's own commands:  osai os services   /   osai os restart sshd
 *   osai app WORDS...            terminal / app commands:    osai app ls -la
 *   osai gui WORDS...            the button clicker:         osai gui windows   /   osai gui screenshot
 *   osai skill WORDS...          the auto skill maker
 *   (osai kernel ... is the old name for osai os ...)
 *   add --json for machine-readable output
 *
 * It only carries the request to the NeuroClaw engine on THIS computer (POST /api/ai-os/layer) and prints
 * what comes back. It has no power of its own: the engine's tool gate, Computer Access switches and approval
 * queue decide what happens, exactly as for chat. The engine address must be loopback.
 *
 * Exit code: 0 ran, 3 held for approval, 2 engine not reachable, 1 anything else.
 * Needs the engine running (turn on AI OS mode so it starts at sign-in). Node built-ins only.
 */

const LAYERS = ['os', 'app', 'gui', 'skill'];
const ALIASES = { kernel: 'os' };
const MAX_REQUEST = 600;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function usage() {
  console.log(`usage: osai status | osai ${LAYERS.join('|')} WORDS...   (add --json for machine-readable output)`);
}

/** The engine to talk to. Must be this computer: a request is never sent off the machine. */
export function engineUrl(env = process.env) {
  const port = Number(env.NEUROCLAW_WEB_PORT) || 7861;
  const url = (env.OSAI_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  let u;
  try { u = new URL(url); } catch { throw new Error(`OSAI_URL is not a URL: ${url}`); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (u.protocol !== 'http:' || !local) throw new Error(`the AI OS engine must be on this computer (http://127.0.0.1:PORT), not ${url}`);
  return url;
}

export function cleanRequest(words) {
  const text = (Array.isArray(words) ? words.join(' ') : String(words ?? '')).replace(CONTROL, ' ').trim();
  if (!text) throw new Error('say what you want, e.g.: osai os services');
  if (text.length > MAX_REQUEST) throw new Error(`too long: ${text.length} characters (the limit is ${MAX_REQUEST})`);
  return text;
}

function headers(env = process.env) {
  const h = { 'Content-Type': 'application/json' };
  if (env.NEUROCLAW_WEB_PASSWORD) h.Authorization = `Basic ${Buffer.from(`:${env.NEUROCLAW_WEB_PASSWORD}`).toString('base64')}`;
  return h;
}

async function call(method, body, env = process.env, fetchFn = fetch) {
  const url = `${engineUrl(env)}/api/ai-os/layer`;
  let res;
  try {
    res = await fetchFn(url, { method, headers: headers(env), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(65000) });
  } catch {
    const e = new Error(`cannot reach the NeuroClaw engine at ${url}. Start NeuroClaw first (or turn on AI OS mode so it starts at sign-in).`);
    e.code = 'UNREACHABLE';
    throw e;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.status) throw new Error(`the engine said ${res.status}: ${json.error || res.statusText}`);
  return json;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch, out = console) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const first = (args.shift() || 'help').toLowerCase();
  if (first === 'help' || first === '-h' || first === '--help') { usage(); return 0; }
  try {
    if (first === 'status') {
      const body = await call('GET', undefined, env, fetchFn);
      if (json) out.log(JSON.stringify(body, null, 2));
      else for (const l of body.layers || []) out.log(`${l.available ? 'ok  ' : 'no  '} ${String(l.id).padEnd(6)} ${l.label}${l.native ? ` (${l.native})` : ''}${l.reason ? ` - ${l.reason}` : ''}`);
      return 0;
    }
    const layer = ALIASES[first] || first;
    if (!LAYERS.includes(layer)) { out.error(`unknown layer "${first}". AI OS has: ${LAYERS.join(', ')}.`); return 1; }
    const result = await call('POST', { layer, request: cleanRequest(args) }, env, fetchFn);
    if (json) out.log(JSON.stringify(result, null, 2));
    else out.log(result.text ?? '');
    return result.status === 'ran' ? 0 : result.status === 'held' ? 3 : 1;
  } catch (e) {
    out.error(`osai: ${e.message}`);
    return e.code === 'UNREACHABLE' ? 2 : 1;
  }
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
