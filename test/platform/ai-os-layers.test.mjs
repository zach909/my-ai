/**
 * AI OS layers: only the four named layers are reachable, requests are validated before any tool is touched,
 * and kernel commands are Linux-only. Run: node --test test/platform/ai-os-layers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(root, 'dist', 'interface', 'platform', 'ai-os-layers.js')).href);

const recorder = () => { const calls = []; return { calls, run: async (tool, request) => { calls.push([tool, request]); return { status: 'ran', text: 'ok' }; } }; };

test('exactly four layers map to exactly four tools', () => {
  assert.deepEqual(L.AI_OS_LAYERS.map((l) => [l.id, l.tool]), [
    ['gui', 'desktop'], ['app', 'terminal'], ['kernel', 'linux-permission-tools'], ['skill', 'skill-maker'],
  ]);
});

test('each layer runs its own tool and nothing else', async () => {
  const r = recorder();
  await L.runLayer('gui', ' click Save ', r.run, 'linux');
  await L.runLayer('skill', 'make a skill for tides', r.run, 'darwin');
  assert.deepEqual(r.calls, [['desktop', 'click Save'], ['skill-maker', 'make a skill for tides']]);
});

test('other features are not reachable', async () => {
  const r = recorder();
  for (const layer of ['email', 'camera', 'desktop', 'terminal', '', undefined, 7]) {
    const out = await L.runLayer(layer, 'hi', r.run, 'linux');
    assert.equal(out.status, 'bad-request');
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

test('kernel commands are Linux only', async () => {
  const r = recorder();
  assert.equal((await L.runLayer('kernel', 'list services', r.run, 'win32')).status, 'unavailable');
  assert.equal(r.calls.length, 0);
  assert.equal((await L.runLayer('kernel', 'list services', r.run, 'linux')).status, 'ran');
  assert.equal(L.layerList('darwin').find((l) => l.id === 'kernel').available, false);
  assert.equal(L.layerList('linux').every((l) => l.available), true);
});

test('a held or refused outcome from the gate is passed through unchanged', async () => {
  const out = await L.runLayer('app', 'rm -rf x', async () => ({ status: 'held', text: 'waiting for approval' }), 'linux');
  assert.deepEqual(out, { status: 'held', text: 'waiting for approval' });
});
