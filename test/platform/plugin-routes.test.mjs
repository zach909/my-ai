/**
 * The server's route groups as plugins (interface/server-plugins.ts), on the real compiled server: the list,
 * turning a group off so its paths stop answering, what turning off one plugin takes with it, that the choice
 * is kept across a restart, and that the plugin that turns plugins back on cannot turn itself off.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { api, ensureBuilt, removeDir, startServer, tempDir } from './helpers.mjs';

ensureBuilt();

const GROUPS = ['plugin-host-routes', 'platform-routes', 'accounts-routes', 'hosted-routes', 'corona-routes', 'memory-topics-routes', 'prompt-memory-routes', 'safety-routes', 'weights-routes', 'agent-routes', 'commons-routes'];
const dataDir = tempDir('nc-plugins-');
const servers = [];
after(async () => { for (const s of servers) await s.stop(); removeDir(dataDir); });

const boot = async () => { const s = await startServer({ dataDir }); servers.push(s); return s; };
const byId = (list) => Object.fromEntries(list.map((p) => [p.id, p]));

test('every route group is a running plugin, and the safety-facing ones are guarded', async () => {
  const srv = await boot();
  const r = await api(srv.url, '/api/plugin-host');
  assert.equal(r.status, 200);
  const plugins = byId(r.json.plugins);
  assert.deepEqual(Object.keys(plugins).sort(), [...GROUPS].sort());
  for (const id of GROUPS) assert.equal(plugins[id].state, 'running', `${id} should be running`);
  for (const id of ['accounts-routes', 'safety-routes', 'agent-routes', 'plugin-host-routes']) assert.equal(plugins[id].guarded, true, `${id} should be guarded`);
  assert.equal(plugins['memory-topics-routes'].guarded, false);
  assert.deepEqual(plugins['hosted-routes'].requires, ['accounts-routes']);
});

test('the routes the plugins own still answer as they did', async () => {
  const srv = await boot();
  for (const p of ['/api/memory-topics', '/api/agent', '/api/safety', '/api/commons', '/api/app-info']) {
    const r = await api(srv.url, p);
    assert.equal(r.status, 200, `${p} should answer 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  }
});

test('a plugin turned off stops answering, and turning it on brings it back', async () => {
  const srv = await boot();
  const before = await api(srv.url, '/api/memory-topics');
  assert.equal(before.status, 200);

  const off = await api(srv.url, '/api/plugin-host/memory-topics-routes/disable', { method: 'POST' });
  assert.equal(off.status, 200);
  assert.equal(off.json.ok, true);
  assert.notEqual((await api(srv.url, '/api/memory-topics')).status, 200, 'its path must stop answering');
  // The others are untouched.
  assert.equal((await api(srv.url, '/api/agent')).status, 200);

  const on = await api(srv.url, '/api/plugin-host/memory-topics-routes/enable', { method: 'POST' });
  assert.equal(on.status, 200);
  assert.equal((await api(srv.url, '/api/memory-topics')).status, 200);
});

test('turning off the accounts plugin also stops hosted mode, which needs it', async () => {
  const srv = await boot();
  const off = await api(srv.url, '/api/plugin-host/accounts-routes/disable', { method: 'POST' });
  assert.equal(off.status, 200);
  assert.deepEqual([...off.json.changed].sort(), ['accounts-routes', 'hosted-routes']);
  const list = byId((await api(srv.url, '/api/plugin-host')).json.plugins);
  assert.equal(list['accounts-routes'].state, 'stopped');
  assert.equal(list['hosted-routes'].state, 'stopped');
  assert.equal(list['agent-routes'].state, 'running');

  const on = await api(srv.url, '/api/plugin-host/accounts-routes/enable', { method: 'POST' });
  assert.equal(on.json.ok, true);
  const after = byId((await api(srv.url, '/api/plugin-host')).json.plugins);
  assert.equal(after['hosted-routes'].state, 'running', 'what was stopped only because of it comes back');
});

test('the plugin that turns plugins on cannot turn itself off, and unknown ids are refused', async () => {
  const srv = await boot();
  const self = await api(srv.url, '/api/plugin-host/plugin-host-routes/disable', { method: 'POST' });
  assert.equal(self.status, 409);
  assert.match(self.json.reason, /turned back on/);
  assert.equal(byId((await api(srv.url, '/api/plugin-host')).json.plugins)['plugin-host-routes'].state, 'running');

  const ghost = await api(srv.url, '/api/plugin-host/nothing-here/disable', { method: 'POST' });
  assert.equal(ghost.status, 409);
  assert.match(ghost.json.reason, /No plugin called/);
});

test('which plugins are off is kept across a restart', async () => {
  const first = await boot();
  assert.equal((await api(first.url, '/api/plugin-host/weights-routes/disable', { method: 'POST' })).status, 200);
  await first.stop();

  const file = path.join(dataDir, 'config', 'plugins.json');
  assert.ok(existsSync(file), 'the choice is written next to the other config files');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['weights-routes'], false);

  const second = await boot();
  const list = byId((await api(second.url, '/api/plugin-host')).json.plugins);
  assert.equal(list['weights-routes'].enabled, false);
  assert.equal(list['weights-routes'].state, 'stopped');
  assert.equal(list['commons-routes'].state, 'running');
  await api(second.url, '/api/plugin-host/weights-routes/enable', { method: 'POST' });
});
