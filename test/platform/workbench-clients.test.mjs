/**
 * Protocol clients and coordination: JSON-RPC framing, tool servers over stdio / http / sse, diagnostics,
 * sub-agents, teams, routing, offline mode and bundles. Node built-ins only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { dist, ensureBuilt, tempDir, removeDir } from './helpers.mjs';

const data = tempDir('wbc-data-');
process.env.CORONA_DATA_DIR = data;
process.env.NEUROCLAW_MANAGED_FILE = path.join(data, 'no-managed.json');
delete process.env.NEUROCLAW_OFFLINE;
ensureBuilt();
const W = (n) => import(dist(`interface/workbench/${n}.js`));
const R = await W('jsonrpc'), M = await W('mcp'), PM = await W('permissions'), TR = await W('trust'), DG = await W('diagnostics');
const TM = await W('teams'), RT = await W('routing'), NG = await W('netguard'), AG = await W('agents'), B = await W('bundles');
const write = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };

test('json-rpc: both framings, notifications, errors, timeouts, and a closed stream fails what is waiting', async () => {
  for (const framing of ['ndjson', 'content-length']) {
    const a2b = new PassThrough(), b2a = new PassThrough();
    const a = new R.JsonRpcPeer(b2a, a2b, framing), b = new R.JsonRpcPeer(a2b, b2a, framing);
    b.onRequest('add', ({ x, y }) => x + y); b.onRequest('boom', () => { throw new Error('nope'); });
    let note; b.onNotification('ping', (p) => { note = p; });
    assert.equal(await a.request('add', { x: 2, y: 3 }), 5);
    await assert.rejects(a.request('boom'), /nope/); await assert.rejects(a.request('missing'), /not found/i);
    a.notify('ping', { n: 1 }); await new Promise((r) => setTimeout(r, 20)); assert.deepEqual(note, { n: 1 });
    b.onRequest('slow', () => new Promise(() => {}));
    await assert.rejects(a.request('slow', {}, 60), /timed out/);
    const pending = a.request('slow', {}, 5000); a.close(); await assert.rejects(pending);
  }
});

const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }, { name: 'env', description: 'Env', inputSchema: {} }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name === 'env' ? 'secret=' + (process.env.SECRET_FOR_TEST || '') + ' pass=' + (process.env.PASSED || '') : 'echo:' + JSON.stringify(m.params.arguments) }] } });
});`;

function manager(root, rules, approve, dd = tempDir('wbc-mgr-')) {
  const engine = new PM.PermissionEngine([{ name: 'user', config: rules }, { name: 'builtin', config: PM.BUILTIN_RULES }], { root });
  return new M.McpManager({ root, engine, trust: new TR.TrustStore(dd), dataDir: dd, approve });
}

test('tool servers over stdio: listed, called through the permission rules, and started with a clean environment', async () => {
  const root = tempDir('wbc-root-'); const script = write(root, 'srv.js', SERVER);
  process.env.SECRET_FOR_TEST = 'leak'; process.env.PASSED = 'yes';
  let asked = 0;
  const dd = tempDir('wbc-shared-');
  const m = manager(root, { allow: ['mcp:srv:echo'], deny: ['mcp:srv:forbidden'] }, async () => { asked++; return false; }, dd);
  assert.ok(m.add('user', 'srv', { transport: 'stdio', command: [process.execPath, script], envPass: ['PASSED'] }).ok);
  const { tools, errors } = await m.tools();
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'env']); assert.deepEqual(errors, []);
  const ok = await m.call('srv', 'echo', { a: 1 });
  assert.ok(ok.ok); assert.equal(ok.text, 'echo:{"a":1}'); assert.equal(asked, 0);
  const denied = await m.call('srv', 'forbidden', {}); assert.equal(denied.decision, 'deny'); assert.equal(denied.ok, false);
  const held = await m.call('srv', 'env', {}); assert.equal(held.decision, 'ask'); assert.equal(held.ok, false); assert.equal(asked, 1);
  const m2 = manager(root, { allow: ['mcp:srv:*'] }, undefined, dd);
  await m2.tools(); const env = await m2.call('srv', 'env', {});
  assert.equal(env.text, 'secret= pass=yes');
  m.closeAll(); m2.closeAll(); removeDir(root);
});

test('a project\'s own tool-server file does nothing until approved, and an administrator can limit servers', async () => {
  const root = tempDir('wbc-root-'); const script = write(root, 'srv.js', SERVER);
  write(root, '.neuroclaw/mcp.json', JSON.stringify({ servers: { proj: { transport: 'stdio', command: [process.execPath, script] } } }));
  const trust = new TR.TrustStore(tempDir('wbc-trust-'));
  const engine = new PM.PermissionEngine([{ name: 'user', config: { allow: ['mcp:*'] } }], { root });
  let policy = {};
  const m = new M.McpManager({ root, engine, trust, dataDir: tempDir('wbc-d-'), policy: () => policy });
  assert.match(m.configs()[0].problem, /not been approved/);
  assert.match((await m.tools()).errors[0], /not been approved/);
  assert.ok(m.trustProject());
  assert.equal(m.configs()[0].problem, undefined); assert.equal((await m.tools()).tools.length, 2);
  writeFileSync(path.join(root, '.neuroclaw/mcp.json'), JSON.stringify({ servers: { proj: { transport: 'stdio', command: ['/bin/echo', 'changed'] } } }));
  assert.match(m.configs()[0].problem, /not been approved/);
  m.trustProject(); policy = { allowedServers: ['other'] };
  assert.match(m.configs()[0].problem, /administrator/);
  policy = { disabled: true }; assert.match(m.configs()[0].problem, /turned off/);
  m.closeAll(); removeDir(root);
});

test('server definitions are validated: names, https only, commands as lists', () => {
  assert.match(M.validateServer('Bad Name', { transport: 'stdio', command: ['x'] }), /valid server name/);
  assert.match(M.validateServer('a', { transport: 'stdio', command: 'rm -rf /' }), /command/);
  assert.match(M.validateServer('a', { transport: 'http', url: 'http://example.com/mcp' }), /https/);
  assert.equal(M.validateServer('a', { transport: 'http', url: 'http://127.0.0.1:9/mcp' }), null);
  assert.equal(M.validateServer('a', { transport: 'http', url: 'https://example.com/mcp' }), null);
});

function httpMcp(kind) {
  const calls = [];
  const sseClients = [];
  const handle = (msg) => {
    if (msg.method === 'initialize') return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'h', version: '1' } };
    if (msg.method === 'tools/list') return { tools: [{ name: 'hello', description: 'Hi', inputSchema: {} }] };
    if (msg.method === 'tools/call') return { content: [{ type: 'text', text: `hello ${JSON.stringify(msg.params.arguments)}` }] };
  };
  const srv = createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    if (kind === 'sse' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: endpoint\ndata: /messages\n\n'); sseClients.push(res); return;
    }
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: handle(msg) });
      if (kind === 'sse') { res.writeHead(202).end(); sseClients[0].write(`event: message\ndata: ${reply}\n\n`); }
      else if (kind === 'http-sse-reply') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${reply}\n\n`); }
      else { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' }); res.end(reply); }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, srv, calls })));
}

for (const [kind, transport] of [['json', 'http'], ['http-sse-reply', 'http'], ['sse', 'sse']]) {
  test(`tool servers over ${transport} (${kind}): initialise, list, call, with a bearer token read from the environment`, async () => {
    const { url, srv, calls } = await httpMcp(kind);
    process.env.WB_TOKEN = 'tok123';
    const root = tempDir('wbc-root-');
    const m = manager(root, { allow: ['mcp:*'] });
    assert.ok(m.add('user', 'web', { transport, url: transport === 'sse' ? `${url}/sse` : `${url}/mcp`, bearerEnv: 'WB_TOKEN' }).ok);
    const { tools, errors } = await m.tools();
    assert.deepEqual(errors, []); assert.equal(tools[0].name, 'hello');
    assert.equal((await m.call('web', 'hello', { x: 1 })).text, 'hello {"x":1}');
    assert.ok(calls.some((c) => c.auth === 'Bearer tok123'));
    m.closeAll(); srv.close(); srv.closeAllConnections?.(); removeDir(root);
  });
}

test('offline mode: only this machine is reachable, and the message says what to do', async () => {
  const { url, srv } = await httpMcp('json');
  NG.setOffline(true);
  assert.doesNotThrow(() => NG.assertEgress(url, 'a tool server'));
  assert.throws(() => NG.assertEgress('https://example.com/x', 'a tool server'), /Offline mode is on/);
  assert.throws(() => NG.assertEgress('not a url', 'x'), NG.EgressBlocked);
  const root = tempDir('wbc-root-');
  const m = manager(root, { allow: ['mcp:*'] });
  m.add('user', 'far', { transport: 'http', url: 'https://example.com/mcp', timeoutMs: 2000 });
  assert.match((await m.tools()).errors[0], /Offline mode is on/);
  NG.setOffline(null); m.closeAll(); srv.close(); removeDir(root);
  assert.equal(NG.isOffline(), false);
});

test('diagnostics: syntax errors in JSON, JavaScript and Python come back with a line; good files give none', async () => {
  const root = tempDir('wbc-diag-');
  write(root, 'ok.json', '{"a":1}'); write(root, 'bad.json', '{"a":1,}'); write(root, 'ok.js', 'const a = 1;\n'); write(root, 'bad.js', 'const a = ;\n'); write(root, 'ok.py', 'x = 1\n'); write(root, 'bad.py', 'def f(:\n  pass\n');
  const svc = new DG.DiagnosticsService({ root, trust: new TR.TrustStore(data), dataDir: data });
  assert.deepEqual(await svc.diagnose('ok.json'), []); assert.deepEqual(await svc.diagnose('ok.js'), []); assert.deepEqual(await svc.diagnose('ok.py'), []);
  const j = await svc.diagnose('bad.json'); assert.equal(j[0].severity, 'error'); assert.equal(j[0].file, 'bad.json');
  const s = await svc.diagnose('bad.js'); assert.equal(s[0].line, 1); assert.match(s[0].message, /SyntaxError/);
  const p = await svc.diagnose('bad.py'); assert.equal(p[0].line, 1); assert.equal(p[0].source, 'python');
  assert.deepEqual(await svc.diagnose('../../etc/passwd'), []);
  assert.match(DG.renderDiagnostics(s), /bad\.js:1:1 error \[node\]/);
  assert.equal(DG.renderDiagnostics([]), '');
  removeDir(root);
});

test('language servers: a server that speaks LSP over stdio feeds diagnostics back; an unapproved project file does not start one', async () => {
  const root = tempDir('wbc-lsp-'); const dd = tempDir('wbc-lspd-');
  const fake = write(root, 'fake-lsp.js', `
let buf = Buffer.alloc(0);
const send = (m) => { const b = JSON.stringify(m); process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b); };
process.stdin.on('data', (d) => { buf = Buffer.concat([buf, d]);
  for (;;) { const e = buf.indexOf('\\r\\n\\r\\n'); if (e < 0) return; const len = +/Content-Length: (\\d+)/.exec(buf.slice(0, e).toString())[1]; if (buf.length < e + 4 + len) return;
    const m = JSON.parse(buf.slice(e + 4, e + 4 + len).toString()); buf = buf.slice(e + 4 + len);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, diagnostics: [{ range: { start: { line: 2, character: 4 } }, severity: 2, message: 'fake warning', source: 'fake' }] } }); } });`);
  write(root, 'a.zz', 'hello\n');
  writeFileSync(path.join(dd, 'lsp.json'), JSON.stringify({ servers: { fake: { command: [process.execPath, fake], extensions: ['.zz'] } } }));
  const svc = new DG.DiagnosticsService({ root, trust: new TR.TrustStore(dd), dataDir: dd });
  const d = await svc.diagnose('a.zz', { timeoutMs: 3000 });
  assert.equal(d.length, 1); assert.equal(d[0].severity, 'warning'); assert.equal(d[0].line, 3); assert.equal(d[0].column, 5); assert.equal(d[0].file, 'a.zz');
  svc.closeAll();
  const root2 = tempDir('wbc-lsp2-'); write(root2, 'a.zz', 'x'); write(root2, '.neuroclaw/lsp.json', JSON.stringify({ servers: { fake: { command: [process.execPath, fake], extensions: ['.zz'] } } }));
  const svc2 = new DG.DiagnosticsService({ root: root2, trust: new TR.TrustStore(tempDir('wbc-t-')), dataDir: tempDir('wbc-nod-') });
  assert.deepEqual(await svc2.diagnose('a.zz', { timeoutMs: 500 }), []); assert.match(svc2.notes[0], /not approved/);
  removeDir(root); removeDir(root2);
});

const agent = (name) => ({ name, description: '', mode: 'subagent', tools: null, disallowed: [], prompt: `I am ${name}`, source: 'builtin' });

test('sub-agents: run in parallel under a limit with their own context, only summaries return, depth and count are capped', async () => {
  let live = 0, peak = 0;
  const exec = async (r) => { live++; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 30)); live--; if (r.prompt === 'fail') throw new Error('broke'); return `${r.agent.name}:${r.prompt}:${r.depth}:` + 'x'.repeat(10000); };
  const jobs = ['a', 'b', 'c', 'd', 'e', 'fail'].map((p) => ({ agent: agent('w'), prompt: p }));
  const res = await TM.runSubagents(jobs, exec, 0, { concurrency: 2, summaryChars: 50 });
  assert.equal(peak, 2); assert.equal(res.length, 6); assert.ok(res[0].ok); assert.equal(res[0].summary.length, 50); assert.match(res[0].summary, /^w:a:1:/);
  assert.equal(res[5].ok, false); assert.match(res[5].summary, /broke/);
  const deep = await TM.runSubagents(jobs.slice(0, 1), exec, 2); assert.equal(deep[0].ok, false); assert.match(deep[0].summary, /levels/);
  const many = await TM.runSubagents(Array.from({ length: 15 }, () => jobs[0]), async () => 'k', 0, { maxTotal: 12 });
  assert.equal(many.filter((r) => r.ok).length, 12);
});

test('teams: a task is claimed by exactly one member, dependencies wait, results and a failure are recorded, messages are read once', async () => {
  const team = new TM.Team('t1', tempDir('wbc-team-'));
  const a = await team.addTask('first'), b = await team.addTask('second', [a.id]), c = await team.addTask('third');
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => team.claim(`m${i}`)));
  assert.equal(claims.filter(Boolean).length, 2); assert.ok(claims.filter(Boolean).every((t) => t.id !== b.id));
  const owner = claims.find((t) => t?.id === a.id); assert.ok(await team.finish(a.id, owner.owner, true, 'done a'));
  assert.equal(await team.finish(a.id, 'intruder', true, 'x'), false);
  assert.equal((await team.claim('late')).id, b.id);
  await team.send('m1', 'm2', 'hello'); await team.send('m1', '*', 'all');
  assert.equal((await team.inbox('m2')).length, 2); assert.equal((await team.inbox('m2')).length, 0); assert.equal((await team.inbox('m1')).length, 0);
  const t2 = new TM.Team('t2', tempDir('wbc-team-'));
  const x = await t2.addTask('x'); await t2.addTask('y', [x.id]); await t2.addTask('z');
  const done = await t2.run([agent('p'), agent('q')], async (t) => { if (t.title === 'x') throw new Error('x failed'); return `did ${t.title}`; });
  assert.equal(done.find((t) => t.title === 'x').status, 'failed'); assert.equal(done.find((t) => t.title === 'z').result, 'did z');
  assert.equal(done.find((t) => t.title === 'y').status, 'failed', 'a task that depends on a failed one is failed, not left waiting'); assert.match(done.find((t) => t.title === 'y').result, /depends on failed/);
  assert.throws(() => new TM.Team('../bad'), /team name/);
});

test('routing: roles map to the project\'s own engines, effort sets the dial, unknown roles fall back, offline blocks a borrowed computer', () => {
  const explore = AG.BUILTIN_AGENTS.find((a) => a.name === 'explore'), build = AG.BUILTIN_AGENTS.find((a) => a.name === 'build'), plan = AG.BUILTIN_AGENTS.find((a) => a.name === 'plan');
  const e = RT.resolveRoute(explore); assert.equal(e.engine, 'local-quantized'); assert.equal(e.effort, 'low'); assert.equal(e.dial, 20);
  assert.equal(RT.resolveRoute(build, { agents: { build: 'deep' } }).engine, 'local-full');
  assert.equal(RT.resolveRoute(plan).effort, 'high'); assert.match(RT.resolveRoute(plan).effortLine, /Effort 90\/100/);
  assert.equal(RT.resolveRoute(build, { agents: { build: 'gpt-something' } }).engine, 'auto');
  assert.equal(RT.resolveRoute(build, {}, { model: 'remote' }).engine, 'remote');
  NG.setOffline(true); const off = RT.resolveRoute(build, {}, { model: 'remote' }); NG.setOffline(null);
  assert.equal(off.engine, 'local-full'); assert.match(off.notes[0], /Offline/);
});

test('bundles: prompts install; hooks and servers are held back without approval; links, odd files and bad names are refused', () => {
  const dd = tempDir('wbc-b-'); const store = new B.BundleStore(dd);
  const src = tempDir('wbc-bsrc-');
  write(src, 'neuroclaw-bundle.json', JSON.stringify({ name: 'review-kit', version: '1.2.0', description: 'Review' }));
  write(src, 'commands/review.md', 'Review it'); write(src, 'agents/rev.md', '---\ntools: read\n---\nx'); write(src, 'hooks.json', '{}'); write(src, 'mcp.json', '{}'); write(src, 'evil.sh', 'rm -rf /');
  const r = store.install(src);
  assert.ok(r.ok); assert.deepEqual(r.held.sort(), ['hooks.json', 'mcp.json']); assert.equal(r.record.trusted, false);
  assert.deepEqual(store.enabledDirs().map((d) => d.name), ['review-kit']);
  const t = store.install(src, { trust: true }); assert.deepEqual(t.held, []); assert.equal(store.list()[0].trusted, true);
  assert.ok(store.setEnabled('review-kit', false)); assert.equal(store.enabledDirs().length, 0);
  assert.ok(store.remove('review-kit')); assert.equal(store.list().length, 0);
  write(src, 'commands/link.md', 'x'); symlinkSync('/etc/passwd', path.join(src, 'commands', 'l2.md'));
  assert.match(store.install(src).reason, /link/);
  const bad = tempDir('wbc-bad-'); write(bad, 'neuroclaw-bundle.json', JSON.stringify({ name: '../x' }));
  assert.match(store.install(bad).reason, /name/);
  assert.match(store.install(tempDir('wbc-empty-')).reason, /neuroclaw-bundle/);
  removeDir(dd); removeDir(src); removeDir(bad);
});
