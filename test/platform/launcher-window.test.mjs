/**
 * The desktop launcher opens NeuroClaw's own window with no browser and no port.
 * A stand-in window program (a script that speaks the same line protocol as native/host) plays the web view's part, so
 * this checks the launcher, the pipe and the real engine together. The native program itself is checked by its own
 * unit tests (node scripts/build-window-host.mjs --test) and, for the real web view, by CI on each OS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dist, ensureBuilt, tempDir, removeDir, startServer } from './helpers.mjs';
import { stageApp } from '../../scripts/release/stage-app.mjs';
import { windowHostPath } from '../../scripts/desktop-launcher.mjs';

ensureBuilt();
const posix = process.platform !== 'win32';
const T = await import(dist('interface/platform/embedded-transport.js'));

let staged;
function stage() {
  if (staged) return staged;
  const out = tempDir('nc-stage-w-');
  stageApp({ out, channel: 'beta', commit: 'b'.repeat(40), runtime: false });
  staged = out;
  return out;
}
const isolated = (dir) => ({ CORONA_DATA_DIR: path.join(dir, 'data'), NEUROCLAW_APP_HOME: path.join(dir, 'home'), HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, 'local'), XDG_DATA_HOME: path.join(dir, 'xdg') });

/** A window program that asks for the given requests, saves what comes back, and closes. */
function fakeWindow(dir, { asks, exitCode = 0 }) {
  const script = path.join(dir, 'fake-window.mjs');
  const result = path.join(dir, 'window-result.json');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const T = await import(${JSON.stringify(dist('interface/platform/embedded-transport.js'))});
const asks = ${JSON.stringify(asks)};
const got = {}; let ready = false; let buf = '';
const done = () => { writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ready, got })); process.exit(${exitCode}); };
if (${exitCode} !== 0) done();
asks.forEach((a, i) => process.stdout.write(T.encodeRequestLine(i + 1, { method: a.method ?? 'GET', target: a.target, headers: a.headers ?? {}, body: Buffer.from(a.body ?? '') }) + '\\n'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const m = T.decodeResponseLine(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (!m) continue;
    if (m.kind === 'READY') ready = true;
    if (m.kind === 'R') got[m.id] = { status: m.response.status, type: (m.response.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1], body: m.response.body.toString('utf8').slice(0, 4000) };
    if (m.kind === 'E') got[m.id] = { error: m.message };
    if (Object.keys(got).length === asks.length) done();
  }
});
setTimeout(done, 80000);
`);
  const exe = path.join(dir, 'fake-window');
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(exe, 0o755);
  return { exe, result: () => JSON.parse(readFileSync(result, 'utf8')) };
}

function runLauncher(out, dir, env, args = []) {
  const child = spawn(process.execPath, [path.join(out, 'app', 'scripts', 'desktop-launcher.mjs'), ...args], { cwd: path.parse(out).root, env: { ...process.env, ...isolated(dir), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); setTimeout(() => { child.kill(); resolve('timeout'); }, 120_000).unref(); });
  return { exited, log: () => log };
}

test('the window program is found next to the runtime, and an explicit path wins', () => {
  assert.equal(windowHostPath('linux', '/r/node', {}, (p) => p === path.join('/r', 'neuroclaw-window')), path.join('/r', 'neuroclaw-window'));
  assert.equal(windowHostPath('win32', 'C:\\r\\node.exe', {}, (p) => p.endsWith('neuroclaw-window.exe')).endsWith('neuroclaw-window.exe'), true);
  assert.equal(windowHostPath('linux', '/r/node', { NEUROCLAW_WINDOW_HOST: '/x/w' }, (p) => p === '/x/w'), '/x/w');
  assert.equal(windowHostPath('linux', '/r/node', {}, () => false), null);
});

test('launcher: the window opens the app through the engine on a pipe, with no browser and no port, and closing it stops the engine', { skip: !posix }, async () => {
  const out = stage(); const dir = tempDir('nc-lw1-');
  try {
    const w = fakeWindow(dir, { asks: [{ target: '/', headers: { Accept: 'text/html' } }, { target: '/api/status' }, { method: 'POST', target: '/api/chat', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hello there' }) }] });
    const l = runLauncher(out, dir, { NEUROCLAW_WINDOW_HOST: w.exe, NEUROCLAW_BROWSER: '/nonexistent-browser' });
    const code = await l.exited;
    assert.equal(code, 0, l.log());
    const r = w.result();
    assert.equal(r.ready, true, 'the window was told the engine is ready');
    assert.equal(r.got[1].status, 200); assert.match(r.got[1].type, /text\/html/);
    assert.equal(JSON.parse(r.got[2].body).running, true);
    assert.equal(r.got[3].status, 200); assert.equal(typeof JSON.parse(r.got[3].body).response, 'string');
    assert.match(l.log(), /no network port/);
    assert.ok(!/browser/i.test(l.log().replace(/no browser/gi, '')), 'no browser involved: ' + l.log());
    assert.equal(existsSync(path.join(dir, 'data', 'launcher.json')), false, 'the pid file is cleaned up when the window closes');
  } finally { removeDir(dir); }
});

test('launcher: when a NeuroClaw web server is already running (AI OS mode), the window uses it instead of a second engine', async () => {
  const out = stage(); const dir = tempDir('nc-lw2-'); const srv = await startServer();
  try {
    const w = fakeWindow(dir, { asks: [{ target: '/api/status' }, { target: '/' }] });
    const l = runLauncher(out, dir, { NEUROCLAW_WINDOW_HOST: w.exe }, ['--port', String(srv.port)]);
    assert.equal(await l.exited, 0, l.log());
    const r = w.result();
    assert.equal(JSON.parse(r.got[1].body ?? 'null')?.running, true, JSON.stringify(r) + l.log());
    assert.equal(r.got[2].status, 200);
    assert.match(l.log(), /already running/);
    assert.equal((await fetch(`${srv.url}/api/status`)).ok, true, 'the server it did not start is still up');
  } finally { await srv.stop(); removeDir(dir); }
});

test('launcher: with no web view on the computer it says so and fails, it does not open a browser', { skip: !posix }, async () => {
  const out = stage(); const dir = tempDir('nc-lw3-');
  try {
    const w = fakeWindow(dir, { asks: [], exitCode: 3 });
    const l = runLauncher(out, dir, { NEUROCLAW_WINDOW_HOST: w.exe });
    assert.equal(await l.exited, 1, l.log());
    assert.match(l.log(), /web view/i);
  } finally { removeDir(dir); }
});

test('launcher: with no window program at all it says so and fails', { skip: !posix }, async () => {
  const out = stage(); const dir = tempDir('nc-lw4-');
  try {
    const l = runLauncher(out, dir, { NEUROCLAW_WINDOW_HOST: path.join(dir, 'missing') });
    assert.equal(await l.exited, 1, l.log());
    assert.match(l.log(), /no window program/i);
  } finally { removeDir(dir); }
});
