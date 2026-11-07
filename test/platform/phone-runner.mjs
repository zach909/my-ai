/**
 * Runs the phone's server bundle the way the phone does, so it can be tested and looked at without a phone.
 *
 *   node test/platform/phone-runner.mjs [--port N] [--data DIR]
 *
 * It prints `PHONE_SERVER_PORT=<n>` and then serves the phone's pages and API on 127.0.0.1:<n>, the same job
 * PhoneServer.kt does on Android. What makes it a fair stand-in for a WebView:
 *   - Node's own `process`, `Buffer` and `global` conveniences are removed before the bundle runs, so anything the
 *     engine still reaches for in Node, instead of through the project's shims, fails here as it would on a phone;
 *   - the bundle's only way to storage or the outside is `NativeHost.call`, implemented below over a private folder:
 *     /phone/home and /phone/tmp are writable storage, /phone/app is the repository, read-only (the files the app
 *     ships), and nothing else on this computer is visible.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const realProcess = process;
const dataRoot = arg('--data') || fs.mkdtempSync(path.join(os.tmpdir(), 'nc-phone-'));
const bundle = fs.readFileSync(path.join(ROOT, 'mobile/server/bundle/neuroclaw-server.js'), 'utf8');

// ---- the phone's storage ----
const appReads = new Set(); // /phone/app paths the engine looked at; PHONE_RUNNER_APP_LOG=<file> writes them out on exit
function real(virtual, write) {
  const v = path.posix.normalize(virtual);
  if (v === '/phone/app' || v.startsWith('/phone/app/')) {
    if (write) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
    appReads.add(v);
    return path.join(ROOT, v.slice('/phone/app'.length));
  }
  if (v === '/phone/home' || v.startsWith('/phone/home/') || v === '/phone/tmp' || v.startsWith('/phone/tmp/') || v === '/phone') return path.join(dataRoot, v.slice('/phone'.length));
  throw Object.assign(new Error('outside the app'), { code: v === '/' ? 'EACCES' : 'ENOENT' });
}
const kind = (st) => (st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file');
const b64 = (b) => Buffer.from(b).toString('base64');

const hostLog = (line) => realProcess.stderr.write(line + '\n'); // not `console`: the bundle replaces the global console with one that logs through the host
const pending = new Map(); // http request id -> response being built
const ops = {
  'fs.stat': ({ path: p }) => { const st = fs.statSync(real(p)); return { kind: kind(st), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode }; },
  'fs.readdir': ({ path: p }) => fs.readdirSync(real(p), { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file' })),
  'fs.read': ({ path: p }) => b64(fs.readFileSync(real(p))),
  'fs.readRange': ({ path: p, pos, len }) => {
    const fd = fs.openSync(real(p), 'r');
    try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, pos); return b64(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  },
  'fs.write': ({ path: p, data, append }) => { const r = real(p, true); (append ? fs.appendFileSync : fs.writeFileSync)(r, Buffer.from(data, 'base64')); return null; },
  'fs.writeAt': ({ path: p, data, pos }) => {
    const fd = fs.openSync(real(p, true), 'r+');
    try { fs.writeSync(fd, Buffer.from(data, 'base64'), 0, undefined, pos); } finally { fs.closeSync(fd); }
    return null;
  },
  'fs.mkdir': ({ path: p, recursive }) => { fs.mkdirSync(real(p, true), { recursive }); return null; },
  'fs.rm': ({ path: p, recursive, force, filesOnly, dirsOnly }) => {
    const r = real(p, true);
    if (filesOnly) fs.unlinkSync(r); else if (dirsOnly) fs.rmdirSync(r); else fs.rmSync(r, { recursive, force });
    return null;
  },
  'fs.rename': ({ from, to }) => { fs.renameSync(real(from, true), real(to, true)); return null; },
  'fs.copy': ({ from, to }) => { fs.copyFileSync(real(from), real(to, true)); return null; },
  'fs.realpath': ({ path: p }) => { real(p); return path.posix.normalize(p); },
  'fs.mkdtemp': ({ prefix }) => { const r = real(prefix, true); const d = fs.mkdtempSync(r); return '/phone' + d.slice(dataRoot.length); },
  log: ({ level, message }) => { if (realProcess.env.PHONE_RUNNER_LOG || level === 'error') hostLog(`[phone ${level}] ${message}`); return null; },
  ready: () => null,
  failed: ({ error }) => { hostLog(`[phone failed] ${error}`); return null; },
  'http.head': ({ id, status, message, headers }) => { const r = pending.get(id); if (r) { r.status = status; r.message = message; r.headers = headers; r.res.writeHead(status, message, headers); } return null; },
  'http.chunk': ({ id, data }) => { pending.get(id)?.res.write(Buffer.from(data, 'base64')); return null; },
  'http.end': ({ id }) => { const r = pending.get(id); if (r) { r.res.end(); pending.delete(id); } return null; },
};
const hostCall = (op, argsJson) => {
  try {
    const fn = ops[op];
    if (!fn) return JSON.stringify({ ok: false, code: 'ENOSYS', message: `unknown host op ${op}` });
    return JSON.stringify({ ok: true, value: fn(JSON.parse(argsJson)) });
  } catch (e) {
    return JSON.stringify({ ok: false, code: e.code || 'EIO', message: e.message });
  }
};

// ---- keep what the front door needs, then remove Node's conveniences from the engine's world ----

let nextId = 1;
globalThis.NativeHost = { call: hostCall };
for (const name of ['process', 'Buffer', 'global']) { try { delete globalThis[name]; } catch { /* non-configurable */ } }
if (typeof globalThis.process !== 'undefined' || typeof globalThis.Buffer !== 'undefined') {
  realProcess.stderr.write('phone-runner: could not remove Node globals\n');
  realProcess.exit(2);
}
vm.runInThisContext(bundle, { filename: 'neuroclaw-server.js' });
if (typeof globalThis.NeuroClawServer?.request !== 'function') { realProcess.stderr.write('phone-runner: the bundle did not expose NeuroClawServer\n'); realProcess.exit(2); }

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const id = nextId++;
    pending.set(id, { res });
    const body = Uint8Array.from(Array.prototype.concat.apply([], chunks.map((c) => Array.from(c))));
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    let bin = ''; for (const b of body) bin += String.fromCharCode(b);
    globalThis.NeuroClawServer.request(id, req.method, req.url, JSON.stringify(headers), body.length ? btoa(bin) : '');
  });
});
if (realProcess.env.PHONE_RUNNER_APP_LOG) {
  const dump = () => { try { fs.writeFileSync(realProcess.env.PHONE_RUNNER_APP_LOG, [...appReads].sort().join('\n') + '\n'); } catch { /* best effort */ } };
  realProcess.on('SIGTERM', () => { dump(); realProcess.exit(0); });
  realProcess.on('exit', dump);
}
server.listen(Number(arg('--port') || 0), '127.0.0.1', () => {
  realProcess.stdout.write(`PHONE_SERVER_PORT=${server.address().port}\nPHONE_DATA=${dataRoot}\n`);
});
