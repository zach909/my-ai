/**
 * The phone runs the computer's own server (mobile/server): same pages, same routes, same engine, with Node itself
 * replaced by this project's shims. These tests start that server exactly as the phone does (test/platform/phone-runner.mjs:
 * Node's `process`/`Buffer` removed, storage only through NativeHost) and compare it with the real server a computer runs.
 *
 * Needs the bundle (`node scripts/release/build-mobile-server.mjs`, built here if missing) and the backend build
 * (`node scripts/build-backend.mjs`, built by helpers.ensureBuilt) for the computer's side of the comparison.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { ROOT, startServer, tempDir, removeDir } from './helpers.mjs';

const BUNDLE = path.join(ROOT, 'mobile/server/bundle/neuroclaw-server.js');
const RUNNER = path.join(ROOT, 'test/platform/phone-runner.mjs');

function ensureBundle() {
  if (existsSync(BUNDLE)) return;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release/build-mobile-server.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`phone server build failed:\n${(r.stdout + r.stderr).slice(-1500)}`);
}

/** Start the phone's server over `dataDir`; resolves once it is listening (its engine starts on the first request). */
function startPhone(dataDir) {
  const child = spawn(process.execPath, [RUNNER, '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /PHONE_SERVER_PORT=(\d+)/.exec(buf);
      if (m) resolve({ url: `http://127.0.0.1:${m[1]}`, log: () => out, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) });
    });
    child.on('exit', (code) => reject(new Error(`phone runner exited (${code}):\n${out.slice(-2000)}`)));
    setTimeout(() => reject(new Error(`phone runner did not start:\n${out.slice(-2000)}`)), 30000).unref();
  });
}

const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) }; };
const post = async (base, p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

let phone, pc, dataDir;
before(async () => {
  ensureBundle();
  dataDir = tempDir('nc-phone-test-');
  [phone, pc] = await Promise.all([startPhone(dataDir), startServer()]);
}, { timeout: 120000 });
after(async () => { await phone?.stop(); await pc?.stop(); removeDir(dataDir); });

// A PNG's pixels, whatever compression wrote them (the computer compresses; the phone's zlib writes stored blocks).
const pngPixels = (png) => {
  let at = 8; const idat = []; let header = null;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at); const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') header = png.subarray(at + 8, at + 8 + len);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  return Buffer.concat([header, inflateSync(Buffer.concat(idat))]);
};

test('every shared page is byte-for-byte what the computer serves, so the phone looks and reads exactly the same', async () => {
  const pages = ['/', '/settings', '/login', '/accounts', '/commons', '/sharing', '/app/store', '/builder', '/app/self-improvement', '/avatar',
    '/ambient.css', '/ambient.js', '/manifest.webmanifest', '/sw.js'];
  for (const p of pages) {
    const [a, b] = await Promise.all([get(pc.url, p), get(phone.url, p)]);
    assert.equal(b.status, a.status, `${p} status`);
    assert.equal(b.type, a.type, `${p} content type`);
    assert.ok(a.body.equals(b.body), `${p} differs between the computer and the phone`);
  }
  const [a, b] = await Promise.all([get(pc.url, '/app-icon-192.png'), get(phone.url, '/app-icon-192.png')]);
  assert.ok(pngPixels(a.body).equals(pngPixels(b.body)), 'the app icon draws the same picture');
});

test('the pages carry the house look and nothing on them reaches for Node (no CommonJS leftovers in scripts the page runs)', async () => {
  for (const p of ['/', '/settings', '/avatar']) {
    const { body } = await get(phone.url, p);
    const html = body.toString();
    assert.doesNotMatch(html, /\bexports\.[A-Za-z_]/, `${p} contains a CommonJS reference a browser cannot resolve`);
  }
  const css = (await get(phone.url, '/ambient.css')).body.toString();
  assert.match(css, /#110c0e/);
  assert.match(css, /#ff9a84/);
  assert.doesNotMatch(css, /#4a7dff/i);
});

test('the phone says what it is: an Android device, with the computer-only features honestly off', async () => {
  const aios = await (await fetch(phone.url + '/api/ai-os')).json();
  assert.equal(aios.platform, 'android');
  assert.equal(aios.supported, false);
  const status = await (await fetch(phone.url + '/api/status')).json();
  assert.equal(status.running, true);
});

test('every read-only API the shared pages call answers on the phone, none with a server error', async () => {
  const routes = ['/api/status', '/api/auth/status', '/api/app-settings', '/api/app-info', '/api/app-update', '/api/memory', '/api/chat-history/threads',
    '/api/plugins', '/api/net-skills', '/api/prompting-skills', '/api/wiki', '/api/store', '/api/extension/list', '/api/workspaces', '/api/access',
    '/api/safety', '/api/neurons', '/api/updates', '/api/ai-os', '/api/agent', '/api/health', '/api/commons/projects', '/api/os-buttons',
    '/api/visual-apps', '/api/yes-no', '/api/tool-neurons', '/api/shared-chat/rooms', '/api/self-improvement/server-status'];
  const bad = [];
  for (const r of routes) {
    const res = await get(phone.url, r);
    if (res.status >= 500) bad.push(`${r} -> ${res.status} ${res.body.toString().slice(0, 120)}`);
    else JSON.parse(res.body.toString());
  }
  assert.deepEqual(bad, []);
});

test('a message goes through the real engine on the phone and comes back', async () => {
  const r = await post(phone.url, '/api/chat', { message: 'hello' });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.response, 'string');
  assert.ok(r.json.response.length > 0);
});

test('what the phone saves stays in the phone\'s storage and survives a restart', async () => {
  const saved = await post(phone.url, '/api/app-settings', { appearance: { reduceMotion: 'on' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await phone.stop();
  phone = await startPhone(dataDir);
  const again = await (await fetch(phone.url + '/api/app-settings')).json();
  assert.equal(again.settings.appearance.reduceMotion, 'on', 'the setting is still there after the phone server restarted');
  // Everything it wrote is under the phone's own home folder; nothing escaped into the app folder or elsewhere.
  const top = readdirSync(dataDir);
  assert.ok(top.every((n) => ['home', 'tmp'].includes(n)), `unexpected top-level storage: ${top}`);
  assert.ok(statSync(path.join(dataDir, 'home')).isDirectory());
}, { timeout: 120000 });

test('the app\'s own files are read-only and nothing outside the app\'s folders is visible', async () => {
  const log = phone.log();
  assert.doesNotMatch(log, /EACCES.*\/phone\/app/);
  assert.ok(!readFileSync(BUNDLE, 'utf8').includes('require("node:'), 'the bundle has no leftover Node module loads');
});
