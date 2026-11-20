/**
 * AI OS layers: only the four named layers are reachable, requests are validated before any tool is touched,
 * and the OS-commands and button-clicker layers are native on Linux, Windows and macOS.
 * Run: node --test test/platform/ai-os-layers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(root, 'dist', 'interface', 'platform', 'ai-os-layers.js')).href);

const recorder = () => { const calls = []; return { calls, run: async (tool, request) => { calls.push([tool, request]); return { status: 'ran', text: 'ok' }; } }; };

test('exactly four layers, deepest first, each mapped to one tool', () => {
  assert.deepEqual(L.AI_OS_LAYERS.map((l) => [l.id, l.tool]), [
    ['os', 'os-commands'], ['app', 'terminal'], ['gui', 'desktop'], ['skill', 'skill-maker'],
  ]);
});

test('each layer runs its own tool and nothing else', async () => {
  const r = recorder();
  await L.runLayer('gui', 'windows', r.run, 'linux');
  await L.runLayer('skill', 'make a skill for tides', r.run, 'darwin');
  await L.runLayer('os', 'services', r.run, 'win32');
  await L.runLayer('app', 'ls -la', r.run, 'darwin');
  assert.deepEqual(r.calls, [
    ['desktop', 'desktop windows'], ['skill-maker', 'make a skill for tides'], ['os-commands', 'os services'], ['terminal', 'run ls -la'],
  ]);
});

test('a request that already names its tool is not prefixed twice', async () => {
  const r = recorder();
  await L.runLayer('gui', 'desktop screenshot', r.run, 'win32');
  await L.runLayer('os', 'os disks', r.run, 'linux');
  await L.runLayer('app', 'run echo hi', r.run, 'linux');
  assert.deepEqual(r.calls, [['desktop', 'desktop screenshot'], ['os-commands', 'os disks'], ['terminal', 'run echo hi']]);
});

test('"kernel" is still accepted as another name for the OS-commands layer', async () => {
  const r = recorder();
  assert.equal((await L.runLayer('kernel', 'uptime', r.run, 'linux')).status, 'ran');
  assert.deepEqual(r.calls, [['os-commands', 'os uptime']]);
  assert.equal(L.resolveLayerId('Kernel'), 'os');
});

test('on Linux the older Linux-permission-tool questions still reach the Linux permission tools', async () => {
  const r = recorder();
  await L.runLayer('kernel', 'list linux permission tools', r.run, 'linux');
  await L.runLayer('kernel', 'list linux permission tools', r.run, 'win32');
  assert.deepEqual(r.calls, [['linux-permission-tools', 'list linux permission tools'], ['os-commands', 'os list linux permission tools']]);
});

test('other features are not reachable', async () => {
  const r = recorder();
  for (const layer of ['email', 'camera', 'desktop', 'terminal', 'linux-permission-tools', '', undefined, 7, '__proto__', 'constructor']) {
    const out = await L.runLayer(layer, 'hi', r.run, 'linux');
    assert.equal(out.status, 'bad-request', String(layer));
  }
  assert.equal(r.calls.length, 0);
});

test('bad requests never reach a tool', async () => {
  const r = recorder();
  for (const req of ['', '   ', 'x'.repeat(L.AI_OS_REQUEST_MAX + 1), null, {}]) {
    assert.equal((await L.runLayer('app', req, r.run, 'linux')).status, 'bad-request');
  }
  assert.equal(r.calls.length, 0);
});

test('the OS-commands and button-clicker layers are native on Linux, Windows and macOS', async () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const list = L.layerList(platform);
    assert.equal(list.length, 4);
    assert.ok(list.every((l) => l.available && l.native), platform);
    const r = recorder();
    assert.equal((await L.runLayer('os', 'info', r.run, platform)).status, 'ran', platform);
    assert.equal((await L.runLayer('gui', 'probe', r.run, platform)).status, 'ran', platform);
  }
  assert.match(L.layerList('win32').find((l) => l.id === 'os').native, /PowerShell/);
  assert.match(L.layerList('darwin').find((l) => l.id === 'gui').native, /osascript/);
  assert.match(L.layerList('linux').find((l) => l.id === 'gui').native, /X11/);
});

test('a system with no native backend says so and runs nothing', async () => {
  const r = recorder();
  assert.equal((await L.runLayer('os', 'info', r.run, 'freebsd')).status, 'unavailable');
  assert.equal((await L.runLayer('gui', 'windows', r.run, 'freebsd')).status, 'unavailable');
  assert.equal(r.calls.length, 0);
  assert.equal(L.layerList('freebsd').find((l) => l.id === 'os').available, false);
});

test('a held or refused outcome from the gate is passed through unchanged', async () => {
  const out = await L.runLayer('app', 'rm -rf x', async () => ({ status: 'held', text: 'waiting for approval' }), 'linux');
  assert.deepEqual(out, { status: 'held', text: 'waiting for approval' });
});
