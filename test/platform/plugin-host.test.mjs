/**
 * The plugin host (plugin_manager/host.ts): start order, services between plugins, routes that exist only while
 * their plugin runs, turning plugins off and on, and the guarded plugins that only the owner may turn off.
 * Pure logic: nothing here touches the disk or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, ensureBuilt } from './helpers.mjs';

ensureBuilt();
const { PluginHost } = await import(dist('plugin_manager/host.js'));

/** A plugin that records what the host did to it. */
function plug(id, extra = {}, log = []) {
  return {
    id,
    start: async () => { log.push(`start:${id}`); return extra.services ?? {}; },
    stop: async () => { log.push(`stop:${id}`); },
    ...extra,
  };
}

test('plugins start after what they require, and stop before it', async () => {
  const log = [];
  const host = new PluginHost();
  host.register(plug('c', { requires: ['b'] }, log));
  host.register(plug('b', { requires: ['a'] }, log));
  host.register(plug('a', {}, log));
  await host.startAll();
  assert.deepEqual(log, ['start:a', 'start:b', 'start:c']);
  log.length = 0;
  await host.stopAll();
  assert.deepEqual(log, ['stop:c', 'stop:b', 'stop:a']);
});

test('start order is the same however the plugins were registered', async () => {
  const order = async (ids) => {
    const log = [];
    const host = new PluginHost();
    for (const id of ids) host.register(plug(id, {}, log));
    await host.startAll();
    return log;
  };
  assert.deepEqual(await order(['x', 'y', 'z']), await order(['z', 'x', 'y']));
});

test('a cycle is reported, not started around', async () => {
  const host = new PluginHost();
  host.register(plug('a', { requires: ['b'] }));
  host.register(plug('b', { requires: ['a'] }));
  await assert.rejects(() => host.startAll(), /cycle/i);
});

test('one plugin failing does not stop the others, but whatever needs it is held back', async () => {
  const host = new PluginHost();
  host.register({ id: 'bad', start: () => { throw new Error('no disk'); } });
  host.register(plug('needs-bad', { requires: ['bad'] }));
  host.register(plug('fine'));
  await host.startAll();
  const by = Object.fromEntries(host.status().map(s => [s.id, s]));
  assert.equal(by.bad.state, 'failed');
  assert.match(by.bad.error, /no disk/);
  assert.equal(by['needs-bad'].state, 'failed');
  assert.match(by['needs-bad'].error, /needs "bad"/);
  assert.equal(by.fine.state, 'running');
});

test('a missing requirement is named', async () => {
  const host = new PluginHost();
  host.register(plug('a', { requires: ['ghost'] }));
  await host.startAll();
  assert.match(host.status()[0].error, /ghost.*not installed/);
});

test('services pass between plugins that require each other, and only those', async () => {
  const host = new PluginHost();
  host.register(plug('store', { provides: ['store.get'], services: { 'store.get': () => 42 } }));
  let seen;
  let sneaky;
  host.register({
    id: 'user', requires: ['store'],
    start: (ctx) => { seen = ctx.service('store.get')(); },
  });
  host.register({
    id: 'stranger',
    start: (ctx) => { sneaky = ctx.optionalService('store.get'); },
  });
  await host.startAll();
  assert.equal(seen, 42);
  assert.equal(sneaky, undefined, 'a plugin that did not require it cannot reach the service');
  assert.equal(host.service('store.get')(), 42);
});

test('a service that was promised but not returned fails the plugin', async () => {
  const host = new PluginHost();
  host.register({ id: 'liar', provides: ['x'], start: () => ({}) });
  await host.startAll();
  assert.equal(host.status()[0].state, 'failed');
  assert.match(host.status()[0].error, /promised service "x"/);
});

test('routes are served only while their plugin is running', async () => {
  const host = new PluginHost();
  host.register({
    id: 'hello',
    routes: [{ match: (p) => p === '/hi', handle: async (ctx) => { ctx.hit = true; return true; } }],
    start: () => undefined,
  });
  await host.startAll();
  const ctx = {};
  assert.equal(await host.dispatchRoute('/hi', 'GET', ctx), true);
  assert.equal(ctx.hit, true);
  assert.equal(await host.dispatchRoute('/other', 'GET', {}), false);
  await host.disable('hello', 'owner');
  assert.equal(await host.dispatchRoute('/hi', 'GET', {}), false, 'a turned-off plugin answers nothing');
});

test('a route that matches but declines lets the next one try', async () => {
  const host = new PluginHost();
  host.register({ id: 'first', order: 1, routes: [{ match: () => true, handle: () => false }], start: () => undefined });
  host.register({ id: 'second', order: 2, routes: [{ match: () => true, handle: () => true }], start: () => undefined });
  await host.startAll();
  assert.equal(await host.dispatchRoute('/x', 'GET', {}), true);
});

test('turning a plugin off stops what needs it, and turning it on brings that back', async () => {
  const log = [];
  const host = new PluginHost();
  host.register(plug('base', {}, log));
  host.register(plug('mid', { requires: ['base'] }, log));
  host.register(plug('top', { requires: ['mid'] }, log));
  host.register(plug('apart', {}, log));
  await host.startAll();
  log.length = 0;
  const off = await host.disable('base', 'owner');
  assert.equal(off.ok, true);
  assert.deepEqual(log, ['stop:top', 'stop:mid', 'stop:base']);
  assert.equal(host.isRunning('apart'), true);
  log.length = 0;
  const on = await host.enable('base');
  assert.equal(on.ok, true);
  assert.deepEqual(log, ['start:base', 'start:mid', 'start:top']);
});

test('enabling a plugin also enables what it needs', async () => {
  const host = new PluginHost({ load: () => ({ a: false, b: false }), save: () => {} });
  host.register(plug('a'));
  host.register(plug('b', { requires: ['a'] }));
  await host.startAll();
  assert.equal(host.isRunning('b'), false);
  const r = await host.enable('b');
  assert.equal(r.ok, true);
  assert.equal(host.isRunning('a'), true);
  assert.equal(host.isRunning('b'), true);
});

test('guarded plugins: the agent and the system cannot turn them off, the owner can', async () => {
  const log = [];
  const host = new PluginHost();
  host.register(plug('danger-protocol', { guarded: true }, log));
  host.register(plug('hive', { requires: ['danger-protocol'] }, log));
  await host.startAll();
  log.length = 0;

  for (const actor of ['agent', 'system']) {
    const r = await host.disable('danger-protocol', actor);
    assert.equal(r.ok, false);
    assert.match(r.reason, /guarded/);
  }
  assert.deepEqual(log, [], 'a refusal stops nothing');
  assert.equal(host.isRunning('danger-protocol'), true);
  assert.equal(host.isRunning('hive'), true);

  const owner = await host.disable('danger-protocol', 'owner');
  assert.equal(owner.ok, true);
  assert.equal(host.isRunning('danger-protocol'), false);
  assert.equal(host.isRunning('hive'), false);
});

test('the agent may turn off a plugin that merely sits on a guarded one; the guard stays up', async () => {
  const host = new PluginHost();
  host.register(plug('guard', { guarded: true }));
  host.register(plug('tool', { requires: ['guard'] }));
  await host.startAll();
  // Turning off "tool" is fine: it is not what holds the guard up.
  assert.equal((await host.disable('tool', 'agent')).ok, true);
  assert.equal(host.isRunning('guard'), true);
});

test('which plugins are off is saved, and honoured on the next start', async () => {
  let saved = {};
  const store = { load: () => ({ ...saved }), save: (e) => { saved = { ...e }; } };
  const first = new PluginHost(store);
  first.register(plug('a'));
  first.register(plug('b'));
  await first.startAll();
  await first.disable('b', 'owner');
  assert.deepEqual(saved, { b: false });

  const second = new PluginHost(store);
  second.register(plug('a'));
  second.register(plug('b'));
  await second.startAll();
  assert.equal(second.isRunning('a'), true);
  assert.equal(second.isRunning('b'), false);
  assert.equal(second.status().find(s => s.id === 'b').enabled, false);
});

test('a store that throws cannot break the host', async () => {
  const host = new PluginHost({ load: () => { throw new Error('unreadable'); }, save: () => { throw new Error('read-only'); } });
  host.register(plug('a'));
  await host.startAll();
  assert.equal(host.isRunning('a'), true);
  assert.equal((await host.disable('a', 'owner')).ok, true);
});

test('a plugin whose stop() throws is still stopped', async () => {
  const host = new PluginHost();
  host.register({ id: 'messy', start: () => undefined, stop: () => { throw new Error('half closed'); } });
  await host.startAll();
  await host.stopAll();
  const s = host.status()[0];
  assert.equal(s.state, 'stopped');
  assert.match(s.error, /half closed/);
});

test('duplicate ids and malformed plugins are refused at registration', () => {
  const host = new PluginHost();
  host.register(plug('a'));
  assert.throws(() => host.register(plug('a')), /already registered/);
  assert.throws(() => host.register({ id: '', start() {} }), /id/);
  assert.throws(() => host.register({ id: 'nostart' }), /start/);
});

test('state changes are announced, and a listener that throws is ignored', async () => {
  const host = new PluginHost();
  host.register(plug('a'));
  const seen = [];
  host.onEvent(() => { throw new Error('bad listener'); });
  host.onEvent((e) => seen.push(`${e.id}:${e.state}`));
  await host.startAll();
  assert.deepEqual(seen, ['a:starting', 'a:running']);
});
