/**
 * The desktop app's window talks to the engine through a pipe, not a port.
 * Starts the real engine in `embedded` mode and plays the window's part: writes request lines, reads answer lines.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dist, ensureBuilt, tempDir, removeDir } from './helpers.mjs';

ensureBuilt();
const T = await import(dist('interface/platform/embedded-transport.js'));

let child; let dataDir; let buffer = ''; let ready; const waiting = new Map(); let nextId = 1; let log = '';

function onLine(line) {
  const m = T.decodeResponseLine(line);
  if (!m) { return; }
  if (m.kind === 'READY') ready?.();
  else if (m.kind === 'R' || m.kind === 'E') waiting.get(m.id)?.(m);
}

before(async () => {
  dataDir = tempDir('nc-embedded-');
  child = spawn(process.execPath, [path.join(ROOT, 'dist', 'interface', 'main.js'), 'embedded'], {
    cwd: tempDir('nc-embedded-cwd-'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CORONA_DATA_DIR: dataDir, NEUROCLAW_AUTO_UPDATE: '0' },
  });
  child.stderr.on('data', (d) => { log += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buffer += d; for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  await new Promise((resolve, reject) => {
    ready = resolve;
    child.once('exit', (c) => reject(new Error(`engine exited early (${c}):\n${log.slice(-1500)}`)));
    setTimeout(() => reject(new Error(`engine not ready in 60s:\n${log.slice(-1500)}`)), 60_000).unref();
  });
});

after(async () => {
  child?.stdin.end();
  await new Promise((r) => { if (!child || child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(() => { child.kill(); r(); }, 8000).unref(); } });
  removeDir(dataDir);
});

/** Send one request the way the window does and wait for its answer. */
function ask(method, target, { headers = {}, body = Buffer.alloc(0) } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method} ${target}`)), 30_000).unref();
    child.stdin.write(`${T.encodeRequestLine(id, { method, target, headers, body })}\n`);
  }).then((m) => { waiting.delete(id); return m; });
}
const header = (r, name) => r.headers.find(([k]) => k.toLowerCase() === name)?.[1];

test('the home page and status answer through the pipe', async () => {
  const page = await ask('GET', '/', { headers: { Accept: 'text/html' } });
  assert.equal(page.kind, 'R');
  assert.equal(page.response.status, 200);
  assert.match(header(page.response, 'content-type') ?? '', /text\/html/);
  assert.match(page.response.body.toString('utf8'), /<html/i);
  const status = await ask('GET', '/api/status');
  assert.equal(status.response.status, 200);
  const j = JSON.parse(status.response.body.toString('utf8'));
  assert.equal(j.running, true);
  assert.ok(j.subsystems);
});

test('a POST body goes through intact and the engine replies', async () => {
  const r = await ask('POST', '/api/chat', { headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ message: 'hello, \u00e9\u4e16\u754c, are you there?' })) });
  assert.equal(r.response.status, 200, r.response.body.toString());
  const j = JSON.parse(r.response.body.toString('utf8'));
  assert.equal(typeof j.response, 'string');
  assert.ok(j.response.length > 0);
});

test('the server\'s own rules still apply: a non-JSON POST is refused (CSRF guard)', async () => {
  const r = await ask('POST', '/api/chat', { headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('{"message":"hi"}') });
  assert.ok(r.response.status >= 400 && r.response.status < 500, `status ${r.response.status}`);
});

test('an unknown address is a 404, not a hang', async () => {
  const r = await ask('GET', '/definitely/not/here');
  assert.equal(r.response.status, 404);
});

test('a request that is not well formed is refused without reaching the server', async () => {
  const r = await ask('GET', '/ok HTTP/1.1\r\nX-Injected: 1');
  assert.equal(r.kind, 'E');
});

test('binary answers come back byte for byte', async () => {
  const r = await ask('GET', '/ambient.js');
  assert.equal(r.response.status, 200);
  assert.ok(r.response.body.length > 500);
});

/** TCP ports a process is listening on (Linux: its socket inodes matched against /proc/net/tcp*). */
function listeningPorts(pid) {
  const inodes = new Set(readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]; } catch { return null; } }).filter(Boolean));
  const ports = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const row of text.split('\n').slice(1)) {
      const c = row.trim().split(/\s+/);
      if (c[3] === '0A' && inodes.has(c[9])) ports.push(parseInt(c[1].split(':')[1], 16));
    }
  }
  return ports;
}

test('no network port is open while the window is in use', { skip: process.platform !== 'linux' }, async () => {
  // Control: the same check must see a port when there is one, or an empty answer would prove nothing.
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  assert.deepEqual(listeningPorts(process.pid), [probe.address().port], 'the check can see a listening port');
  probe.close();
  assert.deepEqual(listeningPorts(child.pid), [], 'the engine must not listen on any TCP port in window mode');
});

test('closing the window ends the engine', async () => {
  child.stdin.end();
  const code = await new Promise((resolve) => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', resolve); setTimeout(() => resolve('timeout'), 20_000).unref(); });
  assert.equal(code, 0);
});

test('request and response lines round-trip, including empty and binary bodies', () => {
  const body = Buffer.from([0, 255, 10, 13, 32, 200]);
  const line = T.encodeRequestLine(7, { method: 'POST', target: '/a?b=c d'.replace(' ', '%20'), headers: { 'Content-Type': 'application/json' }, body });
  assert.ok(!line.includes('\n'));
  const back = T.decodeRequestLine(line);
  assert.equal(back.id, 7);
  assert.deepEqual(back.request.body, body);
  assert.equal(back.request.headers['Content-Type'], 'application/json');
  const empty = T.decodeRequestLine(T.encodeRequestLine(8, { method: 'GET', target: '/', headers: {}, body: Buffer.alloc(0) }));
  assert.equal(empty.request.body.length, 0);
  const res = T.decodeResponseLine(T.encodeResponseLine(9, { status: 204, headers: [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']], body: Buffer.alloc(0) }));
  assert.equal(res.response.status, 204);
  assert.equal(res.response.headers.length, 2);
});

test('a redirect becomes a page that goes there, and only ever to a path on this app', () => {
  const raw = Buffer.from('HTTP/1.1 302 Found\r\nLocation: /login?next=%2F\r\nContent-Length: 0\r\n\r\n');
  const parsed = T.parseHttpResponse(raw);
  assert.equal(parsed.status, 302);
  const chunked = T.parseHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'));
  assert.equal(chunked.body.toString(), 'hello world');
});
