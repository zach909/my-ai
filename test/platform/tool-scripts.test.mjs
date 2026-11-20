/**
 * Tool scripts: a script that runs features and tools (models && skills/core/script-runner.ts, plugins/scripts.ts).
 * Real child processes started with Node's permission model; the only thing stood in for is the tool caller, which in
 * the server is PluginRegistry.runTool. Node built-ins only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const R = await import(dist('models && skills/core/script-runner.js'));
const P = await import(dist('plugins/scripts.js'));
const { PluginRegistry } = await import(dist('plugin_manager/registry.js'));
const { NetSkillMesh } = await import(dist('models && skills/core/net-skill-mesh.js'));
import { spawnSync } from 'node:child_process';

/** A tool caller that records what it was asked and answers from a table. */
function caller(table = {}) {
  const seen = [];
  const fn = async (tool, input) => {
    seen.push([tool, input]);
    const r = table[tool];
    if (typeof r === 'function') return r(input);
    return r ?? { status: 'unavailable', text: `${tool} is not switched on.` };
  };
  fn.seen = seen;
  return fn;
}

/* ------------------------------------------------------------------ basics */

test('a script runs, calls a tool, prints and returns', async () => {
  const call = caller({ calendar: { status: 'ran', text: '2 events' } });
  const r = await R.runScript('const a = await tools.call("calendar", "list events tomorrow"); console.log("got", a); return a.length;', call, ['calendar']);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.value, '8');
  assert.equal(r.output, 'got 2 events');
  assert.deepEqual(call.seen, [['calendar', 'list events tomorrow']]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].status, 'ran');
  assert.equal(r.stopped, null);
});

test('tools.list shows the tools it was given, minus the scripts tool', async () => {
  const r = await R.runScript('return tools.list().join(",");', caller(), ['calendar', 'scripts', 'email']);
  assert.equal(r.value, 'calendar,email');
});

test('a script that throws reports its own error, and is not "stopped"', async () => {
  const r = await R.runScript('throw new Error("nope")', caller());
  assert.equal(r.ok, false);
  assert.equal(r.stopped, null);
  assert.match(r.message, /nope/);
  const syntax = await R.runScript('this is not valid (((', caller());
  assert.equal(syntax.ok, false);
});

test('a tool that is not there, or refuses, is an error the script can catch', async () => {
  const call = caller({ files: { status: 'refused', text: 'not the owner' } });
  const r = await R.runScript('try { await tools.call("files", "read x"); } catch (e) { return "caught " + e.message; }', call);
  assert.equal(r.ok, true);
  assert.match(r.value, /caught refused: not the owner/);
});

test('calls run one at a time, in order, even when started together', async () => {
  const order = [];
  const call = caller({
    slow: async () => { order.push('slow:start'); await new Promise((x) => setTimeout(x, 120)); order.push('slow:end'); return { status: 'ran', text: 'a' }; },
    fast: async () => { order.push('fast'); return { status: 'ran', text: 'b' }; },
  });
  const r = await R.runScript('const [a, b] = await Promise.all([tools.call("slow", "x"), tools.call("fast", "y")]); return a + b;', call, ['slow', 'fast']);
  assert.equal(r.value, 'ab');
  assert.deepEqual(order, ['slow:start', 'slow:end', 'fast'], 'fast waited for slow to finish');
});

/* --------------------------------------------------------------- the gate */

test('a held call stops the script at that call: nothing after it runs, and it is not retried', async () => {
  const call = caller({
    email: { status: 'held', text: 'Waiting for your OK (approval abc123).' },
    calendar: { status: 'ran', text: 'fine' },
  });
  const r = await R.runScript('await tools.call("calendar", "a"); await tools.call("email", "send"); await tools.call("calendar", "after"); return "done";', call, ['calendar', 'email']);
  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'held');
  assert.equal(r.held.tool, 'email');
  assert.match(r.held.message, /approval abc123/);
  assert.deepEqual(call.seen.map((c) => c[0]), ['calendar', 'email'], 'the call after the held one never happened');
  assert.match(r.message, /needs your approval/);
});

test('a script cannot start a script, and a bad call is refused before it reaches any tool', async () => {
  const call = caller({ scripts: { status: 'ran', text: 'should never run' } });
  const r = await R.runScript(`
    const out = [];
    for (const [t, i] of [["scripts", "script: 1"], ["../etc", "x"], ["calendar", 42], ["calendar", "x".repeat(5000)]]) {
      try { await tools.call(t, i); out.push("ran"); } catch (e) { out.push(e.message.split(":")[0]); }
    }
    return out.join(",");`, call, ['calendar']);
  assert.equal(r.value, 'refused,refused,refused,refused');
  assert.deepEqual(call.seen, [], 'none of them reached the gate');
  assert.deepEqual(r.calls.map((c) => c.status), ['blocked', 'invalid', 'invalid', 'invalid']);
});

test('too many calls stops the script', async () => {
  const call = caller({ t: { status: 'ran', text: 'ok' } });
  const r = await R.runScript('for (let i = 0; i < 50; i++) await tools.call("t", "x"); return "end";', call, ['t'], { maxCalls: 3 });
  assert.equal(r.stopped, 'too-many-calls');
  assert.equal(call.seen.length, 3);
});

/* ------------------------------------------------------------ the boundary */

/** Start a child with exactly the flags a script gets, but a probe in place of the program. */
function probe() {
  const code = `
    const r = {};
    const t = (k, f) => { try { r[k] = String(f()).slice(0, 40); } catch (e) { r[k] = 'DENIED ' + (e.code || e.name); } };
    t('fs', () => require('node:fs').readFileSync('/etc/hostname', 'utf8'));
    t('spawn', () => require('node:child_process').execSync('echo ESCAPED'));
    t('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
    t('env', () => Object.keys(process.env).length);
    t('eval', () => new Function('return 1')());
    t('net', () => typeof require('node:net').connect);
    console.log(JSON.stringify(r));`;
  const x = spawnSync(process.execPath, [...R.scriptChildFlags(), '-e', code], { env: {}, encoding: 'utf8' });
  return JSON.parse(x.stdout);
}

test('the child process is denied files, programs, workers and eval, and has no environment', () => {
  const r = probe();
  assert.match(r.fs, /^DENIED/, 'no file reads');
  assert.match(r.spawn, /^DENIED/, 'no programs');
  assert.match(r.worker, /^DENIED/, 'no worker threads');
  assert.match(r.eval, /^DENIED EvalError/, 'no string-eval, which is the way out of a vm context');
  assert.equal(r.env, '0', 'no environment variables');
});

test('KNOWN LIMIT: Node\'s permission model does not restrict the network, and this test says so', () => {
  // If a future Node denies this, the test fails and script-runner.ts\'s header should be updated to say the limit is gone.
  assert.equal(probe().net, 'function');
});

test('the escape that works on a vm bridge does not work here', async () => {
  // In-process, handing a script one function lets it reach the real process and run a command (shown in the
  // design notes of script-runner.ts). Here the same attempt must fail, and nothing may be executed.
  const attempts = [
    'return tools.call.constructor("return process.getBuiltinModule(\\"node:child_process\\").execSync(\\"echo ESCAPED\\").toString()")();',
    'return this.constructor.constructor("return process")().env.HOME;',
    'return (function(){ return this; })().process.mainModule.require("node:fs").readFileSync("/etc/hostname","utf8");',
  ];
  for (const code of attempts) {
    const r = await R.runScript(code, caller());
    assert.equal(r.ok, false, code);
    if (!/mainModule/.test(code)) assert.match(r.message, /Code generation from strings disallowed/, 'stopped by the eval ban, not by luck: ' + code);
    assert.ok(!/ESCAPED/.test(JSON.stringify(r)), 'nothing ran: ' + code);
    assert.equal(r.value, null);
  }
});

test('a script that loops forever is stopped, not waited for', async () => {
  const t0 = Date.now();
  const r = await R.runScript('while (true) {}', caller(), [], { timeoutMs: 8000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 7500, 'the in-child limit (5 s) cuts a busy loop before the outer one');
  const waiting = await R.runScript('await new Promise(() => {});', caller(), [], { timeoutMs: 700 });
  assert.equal(waiting.stopped, 'timeout');
});

test('a long return value and long printing are clipped', async () => {
  const r = await R.runScript('console.log("x".repeat(100)); return "y".repeat(100000);', caller(), [], { maxOutputChars: 50 });
  assert.equal(r.ok, true);
  assert.ok(r.value.length <= 60, 'the returned value is clipped');
  assert.ok(r.output.length <= 60, 'the printed output is clipped');
});

test('a script that writes far too much is killed', async () => {
  const r = await R.runScript('console.log("x".repeat(1200000)); return 1;', caller());
  assert.equal(r.stopped, 'too-much-output');
  assert.equal(r.ok, false);
});

test('it fails closed when a child with the permission model cannot be started', async () => {
  const r = await R.runScript('return 1', caller(), [], {}, { spawnChild: () => { throw new Error('spawn blocked'); } });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'could-not-start');
  assert.match(r.message, /could not be started/);
  // and what it asks for is the locked-down form, never a plain `node -e`
  let seen = [];
  await R.runScript('return 1', caller(), [], {}, { spawnChild: (args) => { seen = args; throw new Error('stop'); } });
  assert.ok(seen.includes('--permission'));
  assert.ok(seen.includes('--disallow-code-generation-from-strings'));
});

test('empty and oversized scripts are refused without starting anything', async () => {
  let started = 0;
  const deps = { spawnChild: () => { started++; throw new Error('should not start'); } };
  assert.match((await R.runScript('   ', caller(), [], {}, deps)).message, /no script/);
  assert.match((await R.runScript('x'.repeat(9000), caller(), [], {}, deps)).message, /too long/);
  assert.equal(started, 0);
});

/* ---------------------------------------------------------- plugin and gate */

test('the plugin answers only to "script:" and "script help", so ordinary chat falls through', async () => {
  const plugin = new P.ScriptsPlugin({ id: 'scripts', name: 'Scripts', type: 'api-connection', capabilities: ['scripts'] });
  for (const text of ['what is the script for this movie', 'please script a demo', 'scripting is fun', '']) {
    assert.equal(await plugin.onMessage(text), null, JSON.stringify(text));
  }
  assert.match((await plugin.onMessage('script help')).result, /tools\.call/);
  assert.equal(plugin.wouldAct('script: return 1'), true);
  assert.equal(plugin.wouldAct('script help'), false);
});

test('without a registry it says so instead of running anything', async () => {
  const plugin = new P.ScriptsPlugin({ id: 'scripts', name: 'Scripts', type: 'api-connection', capabilities: ['scripts'] });
  assert.match((await plugin.onMessage('script: return 1')).result, /not attached/);
});

test('through a real registry: the script reaches tools only by runTool, so the gate applies to each call', async () => {
  const mesh = new NetSkillMesh(2);
  const registry = new PluginRegistry(mesh);
  const asked = [];
  registry.setGate({
    check: (pluginId, input) => { asked.push(pluginId); return pluginId === 'danger' ? { allow: false, message: 'Waiting for your OK (approval a1).', approvalId: 'a1' } : { allow: true }; },
  });
  const def = (id) => ({ id, name: id, type: 'api-connection', capabilities: [id] });
  const echo = (id) => ({ ...Object.create(null), getDefinition: () => def(id), isActive: () => true, onActivate: async () => {}, onDeactivate: async () => {}, onMessage: async (m) => `${id} got ${m}`, wouldAct: () => true });
  const scripts = new P.ScriptsPlugin(def('scripts'));
  registry.register(def('scripts'), scripts);
  registry.register(def('safe'), echo('safe'));
  registry.register(def('danger'), echo('danger'));
  for (const id of ['scripts', 'safe', 'danger']) await registry.activate(id);
  const out = (await scripts.onMessage('script: const a = await tools.call("safe", "hi"); await tools.call("danger", "boom"); return a;')).result;
  assert.match(out, /Calls:/);
  assert.match(out, /safe: ran/);
  assert.match(out, /danger: held/);
  assert.match(out, /needs your approval/);
  assert.deepEqual(asked, ['safe', 'danger'], 'the gate saw every call, in order');
});
