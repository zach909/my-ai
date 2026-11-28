/**
 * The workbench end to end: a turn through every step, the command line and headless mode, the terminal interface's
 * key handling and drawing, the bridge into the agent's tool gate, and the HTTP routes on the real server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dist, ensureBuilt, tempDir, removeDir, startServer, api } from './helpers.mjs';

const data = tempDir('wbt-data-');
process.env.CORONA_DATA_DIR = data;
process.env.NEUROCLAW_MANAGED_FILE = path.join(data, 'no-managed.json');
delete process.env.NEUROCLAW_OFFLINE;
ensureBuilt();
const W = (n) => import(dist(`interface/workbench/${n}.js`));
const { Workbench } = await W('workbench'), CLI = await W('cli'), HL = await W('headless'), TUI = await W('tui'), GB = await W('gate-bridge'), OB = await W('observers'), SV = await W('service');
const write = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };

/** A workbench over a fresh project and data folder, with an engine that records what it was asked. */
function make(opts = {}) {
  const root = tempDir('wbt-proj-'), dd = tempDir('wbt-d-'), calls = [];
  const wb = new Workbench({
    root, dataDir: dd, managedFile: opts.managedFile,
    executor: opts.executor ?? (async (call) => { calls.push(call); return `echo: ${call.prompt}`; }),
    approve: opts.approve, gate: opts.gate, compaction: opts.compaction,
  });
  return { wb, root, dd, calls };
}

test('a turn: instructions, memory, effort and agent prompt reach the engine; the session and usage are recorded', async () => {
  const { wb, root, calls } = make();
  write(root, 'AGENTS.md', 'Always answer in haiku.');
  wb.memory.remember('fix', 'The platform tests need the backend built first with build-backend');
  const r = await wb.turn({ prompt: 'how do I run the platform tests' });
  assert.ok(r.ok); assert.equal(r.text, 'echo: how do I run the platform tests'); assert.equal(r.agent, 'build');
  const sys = calls[0].system;
  assert.match(sys, /haiku/); assert.match(sys, /build mode/); assert.match(sys, /build-backend/); assert.match(sys, /Effort 50\/100|^/);
  const second = await wb.turn({ prompt: 'and then?', session: r.session });
  assert.equal(second.session, r.session); assert.equal(calls[1].history.length, 2);
  assert.equal(wb.sessions.get(r.session).messages.length, 4);
  const u = wb.usage.summary(1); assert.equal(u.turns, 2); assert.equal(u.byAgent.build, 2);
  wb.close(); removeDir(root);
});

test('slash commands choose their agent and expand their arguments; unknown agents fall back with a warning', async () => {
  const { wb, root, calls } = make();
  write(root, '.neuroclaw/commands/fix.md', '---\nagent: plan\n---\nFix $1 carefully');
  write(root, '.neuroclaw/agents/auditor.md', '---\ntools: read\neffort: high\nmodel: deep\n---\nAudit it.');
  const r = await wb.turn({ prompt: '/fix login' });
  assert.equal(r.agent, 'plan'); assert.equal(calls[0].prompt, 'Fix login carefully'); assert.equal(r.route.effort, 'high');
  const a = await wb.turn({ prompt: 'check', agent: 'auditor' });
  assert.equal(a.route.engine, 'local-full'); assert.equal(calls[1].agent.name, 'auditor');
  const bad = await wb.turn({ prompt: 'hi', agent: 'nonesuch' });
  assert.equal(bad.agent, 'build'); assert.match(bad.warnings.join(' '), /No agent called/);
  wb.close(); removeDir(root);
});

test('hooks: UserPromptSubmit can stop a turn; project hooks run only after the owner approves that exact file', async () => {
  const { wb, root, dd, calls } = make();
  const userHooks = { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'if grep -q forbidden; then echo "not allowed" >&2; exit 2; fi' }] }] } };
  writeFileSync(path.join(dd, 'hooks.json'), JSON.stringify(userHooks)); wb.reload();
  const blocked = await wb.turn({ prompt: 'do the forbidden thing' });
  assert.equal(blocked.blocked, true); assert.match(blocked.text, /not allowed/); assert.equal(calls.length, 0); assert.equal(wb.sessions.list().length, 0, 'a blocked prompt makes no session');
  assert.equal((await wb.turn({ prompt: 'a fine thing' })).ok, true);

  const marker = path.join(root, 'ran.txt');
  write(root, '.neuroclaw/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `echo yes > ${marker}` }] }] } }));
  wb.reload(); await wb.turn({ prompt: 'new session one' });
  assert.ok(!existsSync(marker), 'unapproved project hook must not run');
  wb.trustProject(); await wb.turn({ prompt: 'new session two' });
  assert.ok(existsSync(marker), 'approved project hook runs');
  write(root, '.neuroclaw/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `echo changed > ${marker}.2` }] }] } }));
  wb.reload(); await wb.turn({ prompt: 'new session three' });
  assert.ok(!existsSync(marker + '.2'), 'an edited hooks file needs approving again');
  wb.close(); removeDir(root);
});

test('permissions in layers: a managed deny cannot be overridden; a project cannot grant until approved; the gate can only tighten', async () => {
  const dd = tempDir('wbt-m-'); const managed = path.join(dd, 'managed.json');
  writeFileSync(managed, JSON.stringify({ permissions: { deny: ['bash(curl*)', 'read(**/.env)'] } }));
  const { wb, root, dd: data2 } = make({ managedFile: managed, gate: (r) => (r.tool === 'edit' && r.target === 'gated.txt' ? 'ask' : 'allow') });
  writeFileSync(path.join(data2, 'settings.json'), JSON.stringify({ permissions: { allow: ['bash(curl*)', 'bash(echo*)', 'read(**)', 'edit(**)'] } })); wb.reload();
  assert.equal(wb.decide({ tool: 'bash', target: 'curl evil.sh' }).decision, 'deny');
  assert.equal(wb.decide({ tool: 'read', target: 'a/.env' }).decision, 'deny');
  assert.equal(wb.decide({ tool: 'bash', target: 'echo hi' }).decision, 'allow');
  assert.equal(wb.decide({ tool: 'edit', target: 'gated.txt' }).decision, 'ask');
  assert.equal(wb.decide({ tool: 'edit', target: 'free.txt' }).decision, 'allow');
  write(root, '.neuroclaw/settings.json', JSON.stringify({ permissions: { allow: ['bash(rm*)', 'bash(make*)'], deny: ['edit(locked/**)'] } })); wb.reload();
  assert.equal(wb.decide({ tool: 'bash', target: 'make all' }).decision, 'ask', 'unapproved project allow is ignored');
  assert.equal(wb.decide({ tool: 'edit', target: 'locked/x' }).decision, 'deny', 'a project can always tighten');
  wb.trustProject(['settings']);
  assert.equal(wb.decide({ tool: 'bash', target: 'make all' }).decision, 'allow');
  assert.equal(wb.decide({ tool: 'bash', target: 'curl x' }).decision, 'deny');
  wb.close(); removeDir(root);
});

test('tool-server calls are judged by the live rules, including ones written after the workbench started', async () => {
  const { wb, root, dd } = make();
  assert.equal((await wb.mcp.call('nope', 'tool', {})).decision, 'ask');
  writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp:nope:tool'] } }));
  assert.equal((await wb.mcp.call('nope', 'tool', {})).decision, 'deny');
  assert.equal((await wb.mcp.call('nope', 'other', {})).decision, 'ask');
  wb.close(); removeDir(root);
});

test('runTool: refused calls never run; approval is asked once for an ask; hooks can stop it; a read-only agent cannot edit', async () => {
  let approvals = 0;
  const { wb, root, dd } = make({ approve: async () => { approvals++; return true; } });
  writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ permissions: { deny: ['delete'], allow: ['edit(**)'] } }));
  writeFileSync(path.join(dd, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ command: 'echo "no shell today" >&2; exit 2' }] }] } })); wb.reload();
  let ran = 0;
  const del = await wb.runTool({ tool: 'delete', target: 'a.txt' }, () => { ran++; });
  assert.equal(del.ok, false); assert.equal(ran, 0);
  const sh = await wb.runTool({ tool: 'bash', target: 'ls' }, () => { ran++; });
  assert.equal(sh.ok, false); assert.match(sh.error, /no shell today/); assert.equal(ran, 0); assert.equal(approvals, 1);
  const plan = await wb.runTool({ tool: 'edit', target: 'x.txt', agent: 'plan' }, () => { ran++; });
  assert.equal(plan.ok, false); assert.equal(ran, 0);
  const ok = await wb.runTool({ tool: 'edit', target: 'x.txt', agent: 'build' }, () => { writeFileSync(path.join(root, 'x.txt'), 'hello'); return 'written'; });
  assert.ok(ok.ok); assert.equal(ok.value, 'written');
  wb.close(); removeDir(root);
});

test('runTool on an edit: checkpoint of the old content, formatter run, and problems in the new file handed back', async () => {
  const { wb, root, dd } = make();
  write(root, 'cfg.json', '{"a":1}');
  writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ permissions: { allow: ['edit(**)'] } }));
  writeFileSync(path.join(dd, 'hooks.json'), JSON.stringify({ formatters: [{ extensions: ['.json'], command: [process.execPath, '-e', 'require("fs").appendFileSync(process.argv[1],"\\n")', '{file}'] }] })); wb.reload();
  const r = await wb.runTool({ tool: 'edit', target: 'cfg.json' }, () => { writeFileSync(path.join(root, 'cfg.json'), '{"a":1,}'); });
  assert.ok(r.ok); assert.ok(r.notes.some((n) => /Problems found in cfg\.json/.test(n)), JSON.stringify(r.notes));
  assert.ok(readFileSync(path.join(root, 'cfg.json'), 'utf8').endsWith('\n'));
  assert.ok(wb.checkpoints.undo().ok); assert.equal(readFileSync(path.join(root, 'cfg.json'), 'utf8'), '{"a":1}');
  wb.close(); removeDir(root);
});

test('writes made anywhere in the app are checkpointed through the observer, and rewind can cut the conversation too', async () => {
  const { wb, root } = make({ executor: async (call) => { OB.fileWillChange(path.join(root, 'made.txt')); writeFileSync(path.join(root, 'made.txt'), `turn ${call.history.length}`); OB.fileWillChange(path.join(path.dirname(root), 'outside.txt')); return 'wrote'; } });
  write(root, 'made.txt', 'original');
  const t1 = await wb.turn({ prompt: 'first' });
  const t2 = await wb.turn({ prompt: 'second', session: t1.session });
  assert.ok(t1.checkpoint && t2.checkpoint); assert.equal(readFileSync(path.join(root, 'made.txt'), 'utf8'), 'turn 2');
  const r = wb.rewind(t1.checkpoint, 'both', t1.session);
  assert.ok(r.ok); assert.equal(readFileSync(path.join(root, 'made.txt'), 'utf8'), 'turn 0');
  assert.equal(wb.sessions.get(t1.session).messages.length, r.messages);
  assert.equal(wb.rewind('zzzz', 'code').ok, false);
  wb.close(); removeDir(root);
});

test('long conversations are compacted and the summary is saved; sub-agents get a fresh context and only their summary returns', async () => {
  const seen = [];
  const { wb, root } = make({ compaction: { budgetChars: 3000, keepRecent: 2 }, executor: async (call) => { seen.push(call); return call.history.length === 0 && !call.session ? `sub:${call.prompt}` : 'long answer. ' + 'lorem ipsum dolor '.repeat(60); } });
  let session;
  for (let i = 0; i < 6; i++) { const r = await wb.turn({ prompt: `question ${i} ` + 'filler words '.repeat(30), session }); session = r.session; if (r.compacted) break; }
  assert.ok(wb.sessions.get(session).messages.some((m) => m.summary), 'a compaction summary was saved');
  const res = await wb.subagents([{ agent: 'explore', prompt: 'find x' }, { agent: 'plan', prompt: 'think y' }], 0);
  assert.deepEqual(res.map((r) => r.summary), ['sub:find x', 'sub:think y']);
  const last = seen.slice(-2); assert.ok(last.every((c) => c.history.length === 0)); assert.match(last[0].system, /explore mode/);
  assert.equal((await wb.subagents([{ agent: 'explore', prompt: 'x' }], 2))[0].ok, false);
  wb.close(); removeDir(root);
});

test('headless mode: text, json and stream-json outputs, stdin appended, exit codes 0, 1 and 2', async () => {
  const { wb, root, dd } = make();
  const t = await HL.runHeadless(wb, { prompt: 'hi', output: 'text', stdin: 'piped' });
  assert.equal(t.exitCode, 0); assert.equal(t.stdout, 'echo: hi\n\npiped\n');
  const j = JSON.parse((await HL.runHeadless(wb, { prompt: 'hi', output: 'json', agent: 'plan' })).stdout);
  assert.equal(j.type, 'result'); assert.equal(j.agent, 'plan'); assert.equal(j.ok, true); assert.equal(j.route.effort, 'high'); assert.ok(j.session_id);
  const lines = (await HL.runHeadless(wb, { prompt: 'hi', output: 'stream-json' })).stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.type), ['init', 'result']);
  assert.equal((await HL.runHeadless(wb, { prompt: '  ' })).exitCode, 1);
  writeFileSync(path.join(dd, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'exit 2' }] }] } })); wb.reload();
  assert.equal((await HL.runHeadless(wb, { prompt: 'x' })).exitCode, 2);
  const broken = new Workbench({ root, dataDir: tempDir('wbt-b-'), executor: async () => { throw new Error('engine down'); } });
  const f = await HL.runHeadless(broken, { prompt: 'x', output: 'json' });
  assert.equal(f.exitCode, 1); assert.equal(JSON.parse(f.stdout).ok, false);
  wb.close(); broken.close(); removeDir(root);
});

test('the command line: sessions, fork, search, share, checkpoints, rewind, mcp, bundles, memory, and usage', async () => {
  const { wb, root } = make();
  const out = []; const err = [];
  const run = async (...a) => { out.length = 0; err.length = 0; const code = await CLI.workbenchCli(a, wb, { out: (s) => out.push(s), err: (s) => err.push(s), stdin: async () => '' }); return { code, out: out.join(''), err: err.join('') }; };
  const r = await run('run', 'zebra facts', '--output', 'json'); assert.equal(r.code, 0); const sid = JSON.parse(r.out).session_id;
  assert.match((await run('wb', 'sessions')).out, new RegExp(sid));
  assert.match((await run('wb', 'search', 'zebra')).out, new RegExp(sid));
  const fork = (await run('wb', 'fork', sid)).out.trim(); assert.match(fork, /^[a-f0-9]{12}$/);
  assert.equal((await run('wb', 'rename', sid, 'Zebra work')).code, 0); assert.match((await run('wb', 'sessions')).out, /Zebra work/);
  assert.match((await run('wb', 'share', sid)).out, /^\/share\/[A-Za-z0-9_-]{32}/);
  assert.equal((await run('wb', 'fork', 'nope')).code, 1);
  assert.equal((await run('wb', 'undo')).code, 1);
  assert.equal((await run('wb', 'mcp', 'add', 'bad', 'http', 'http://example.com/x')).code, 1);
  assert.equal((await run('wb', 'mcp', 'add', 'ok', 'stdio', 'node', '-e', '1')).code, 0); assert.match((await run('wb', 'mcp', 'list')).out, /ok\s+user\s+stdio\s+ready/);
  assert.equal((await run('wb', 'memory', 'add', 'The release process needs a clean checkout first')).code, 0); assert.equal((await run('wb', 'memory', 'forget', 'ab')).code, 1);
  assert.equal(JSON.parse((await run('wb', 'usage')).out).turns, 1);
  assert.equal((await run('run', '--output', 'xml', 'x')).code, 1);
  assert.equal((await run('wb', 'nope')).code, 1); assert.equal((await run('tui')).code, 1);
  wb.close(); removeDir(root);
});

const key = (name, extra = {}) => ({ name, ...extra });
const typed = (s, text) => [...text].reduce((st, ch) => TUI.reduce(st, key('char', { ch })).state, s);

test('terminal interface: modes, sending, shell passthrough, agent cycling, scrolling, search, commands', () => {
  let s = TUI.initialState({ height: 12, width: 60 });
  s = typed(s, 'hello'); assert.equal(s.input, 'hello');
  let r = TUI.reduce(s, key('enter')); assert.deepEqual(r.effects, [{ type: 'send', text: 'hello', attachments: [] }]); assert.equal(r.state.input, '');
  r = TUI.reduce(typed(s, ' !'), key('enter')); assert.equal(r.effects[0].type, 'send');
  r = TUI.reduce(typed(TUI.initialState(), '!ls -la'), key('enter')); assert.deepEqual(r.effects, [{ type: 'shell', cmd: 'ls -la' }]);
  s = TUI.reduce(TUI.initialState(), key('tab')).state; assert.equal(s.agent, 'plan'); const four = [1, 2, 3].reduce((st) => TUI.reduce(st, key('tab')).state, s); assert.equal(four.agent, 'build', 'four agents cycle back to the first');
  s = TUI.initialState({ lines: Array.from({ length: 40 }, (_, i) => ({ kind: 'assistant', text: `line ${i} needle${i === 7 ? '!' : ''}` })), height: 10 });
  s = TUI.reduce(s, key('escape')).state; assert.equal(s.mode, 'normal');
  s = TUI.reduce(s, key('char', { ch: 'k' })).state; assert.ok(s.scroll > 0); s = TUI.reduce(s, key('char', { ch: 'G' })).state; assert.equal(s.scroll, 0);
  s = TUI.reduce(s, key('char', { ch: 'g' })).state; assert.ok(s.scroll > 10);
  s = TUI.reduce(TUI.reduce(s, key('char', { ch: '/' })).state, key('char', { ch: 'x' })).state; s = TUI.reduce(s, key('backspace')).state; s = typed(s, 'needle!'); s = TUI.reduce(s, key('enter')).state;
  assert.match(s.status, /needle!/);
  r = TUI.reduce(typed(TUI.reduce(s, key('char', { ch: ':' })).state, 'rewind abc both'), key('enter')); assert.deepEqual(r.effects, [{ type: 'command', name: 'rewind', args: ['abc', 'both'] }]);
  assert.deepEqual(TUI.reduce(typed(TUI.reduce(s, key('char', { ch: ':' })).state, 'q'), key('enter')).effects, [{ type: 'quit' }]);
  assert.deepEqual(TUI.reduce(s, key('char', { ch: 'u' })).effects, [{ type: 'command', name: 'undo', args: [] }]);
  assert.deepEqual(TUI.reduce(s, key('c', { ctrl: true })).effects, [{ type: 'quit' }]);
});

test('terminal interface: @ completes files by fuzzy match, a pasted image path attaches, approvals take y or n, busy blocks sending', () => {
  const files = ['src/app/main.ts', 'src/lib/util.ts', 'README.md', 'docs/mainpage.md'];
  assert.equal(TUI.fuzzyRank('mn', files)[0], 'src/app/main.ts'); assert.deepEqual(TUI.fuzzyRank('zzz', files), []);
  assert.ok(TUI.fuzzyScore('rdm', 'README.md') > 0);
  let s = typed(TUI.initialState({ files }), 'look at @main'); assert.equal(s.suggestions[0], 'src/app/main.ts');
  s = TUI.reduce(s, key('tab')).state; assert.equal(s.input, 'look at @src/app/main.ts ');
  let r = TUI.reduce(TUI.initialState(), key('paste', { text: "'/tmp/shot.PNG'" })); assert.deepEqual(r.effects, [{ type: 'attach', path: '/tmp/shot.PNG' }]);
  r = TUI.reduce(TUI.initialState(), key('paste', { text: 'two\nlines' })); assert.equal(r.state.input, 'two\nlines');
  const ask = TUI.initialState({ pending: { text: 'bash ls' } });
  assert.deepEqual(TUI.reduce(ask, key('char', { ch: 'y' })).effects, [{ type: 'approve', yes: true }]); assert.deepEqual(TUI.reduce(ask, key('char', { ch: 'n' })).effects, [{ type: 'approve', yes: false }]);
  assert.deepEqual(TUI.reduce(ask, key('char', { ch: 'x' })).effects, []); assert.equal(TUI.reduce(ask, key('escape')).state.pending !== null, true);
  assert.deepEqual(TUI.reduce(typed(TUI.initialState({ busy: true }), 'wait'), key('enter')).effects, []);
  assert.deepEqual(TUI.parseKeys('\x1b[A\x1b[200~a b\x1b[201~\r\x7f\x03').map((k) => k.name + (k.text ?? '')), ['up', 'pasteA b'.replace('A b', 'a b'), 'enter', 'backspace', 'c']);
});

test('terminal interface: drawing fits the screen, highlights code, colours diffs, and uses no blue', () => {
  const lines = [
    { kind: 'user', text: 'show me code' },
    { kind: 'assistant', text: 'Here:\n```ts\nconst x = "hi"; // note\nreturn 42;\n```\nA very long line of prose that must wrap because the screen is only fifty columns wide, honestly.' },
    { kind: 'diff', text: '--- a/x\n+++ b/x\n-old\n+new' },
  ];
  const small = TUI.stripAnsi(TUI.render(TUI.initialState({ width: 50, height: 14, lines })));
  assert.ok(small.split('\n').length <= 14, 'the drawing never exceeds the screen height');
  const s = TUI.initialState({ width: 50, height: 40, session: 'abc123', lines });
  const out = TUI.render(s), plain = TUI.stripAnsi(out); assert.match(plain, /NeuroClaw/); assert.match(plain, /session abc123/); assert.match(plain, /INSERT/);
  assert.match(out, /\x1b\[38;2;227;169;157mconst/); assert.match(out, /\x1b\[38;2;143;227;168m"hi"/); assert.match(out, /\x1b\[38;2;255;154;168m-old/); assert.match(out, /\x1b\[38;2;143;227;168m\+new/);
  assert.ok(!/\x1b\[(?:34|94|44|104|36)m/.test(out), 'no blue or cyan'); assert.ok(!/38;2;(?:\d{1,2}|1[0-3]\d);(?:\d{1,3});(?:2[0-9]{2})m/.test(out.replace(/38;2;(?:227;169;157|239;208;200|201;132;118|143;227;168|255;154;168|248;237;233)/g, '')), 'only palette colours');
  assert.ok(TUI.render(TUI.initialState({ pending: { text: 'bash ls' } })).includes('APPROVE'));
  assert.equal(TUI.highlight('x = 1', 'brainfuck'), 'x = 1');
  assert.match(TUI.highlight('def f(): return None  # c', 'python'), /def/);
});

test('terminal interface: a terminal that reports no size (width 0) draws and scrolls instead of hanging', () => {
  const lines = [{ kind: 'assistant', text: 'word '.repeat(200) + '\n```js\nconst a = 1;\n```' }];
  for (const width of [0, 1, 5, NaN, undefined]) {
    const s = TUI.initialState({ width, height: 0, lines });
    assert.doesNotThrow(() => TUI.render(s)); assert.doesNotThrow(() => TUI.reduce(s, { name: 'up' }));
  }
  assert.ok(TUI.renderLine({ kind: 'assistant', text: 'x'.repeat(500) }, 0).every((l) => TUI.stripAnsi(l).length <= 80));
});

test('terminal interface: a plain pipe is refused with a pointer to headless mode', async () => {
  const { wb, root } = make(); let text = '';
  const code = await TUI.runTui(wb, { stdin: { isTTY: false }, stdout: { write: (s) => { text += s; } } }, { approveRef: { fn: null } });
  assert.equal(code, 1); assert.match(text, /neuroclaw run/); wb.close(); removeDir(root);
});

test('the bridge into the agent tool gate: it can add a refusal for a tool about to act, and can never allow what the gate refused', async () => {
  const G = await import(dist('models && skills/core/tool-safety.js'));
  const gate = G.sharedToolGate();
  const { wb, root, dd } = make();
  writeFileSync(path.join(dd, 'settings.json'), JSON.stringify({ permissions: { deny: ['weather'] } }));
  writeFileSync(path.join(dd, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'calendar', hooks: [{ command: 'echo "calendar is off" >&2; exit 2' }] }] } })); wb.reload();
  assert.equal((await gate.checkAsync('weather', 'weather in Paris', 10, true)).allow, true);
  const off = GB.installGateBridge(wb, gate);
  const d1 = await gate.checkAsync('weather', 'weather in Paris', 10, true); assert.equal(d1.allow, false); assert.match(d1.message, /Refused by a rule/);
  const d2 = await gate.checkAsync('calendar', 'what is on today', 10, true); assert.match(d2.message ?? '', /calendar is off|Waiting for your permission|Not allowed|Stopped by a hook/);
  assert.equal((await gate.checkAsync('weather', 'weather in Paris', 0, false)).allow, true, 'a tool that will not act is left alone');
  const term = await gate.checkAsync('terminal', 'run rm -rf /tmp/x', 10, true); assert.equal(term.allow, false);
  off(); assert.equal((await gate.checkAsync('weather', 'weather in Paris', 10, true)).allow, true);
  assert.equal(GB.toolNameFor('terminal'), 'bash'); assert.equal(GB.toolNameFor('Email'), 'email');
  wb.close(); removeDir(root);
});

test('the service: a safe workspace is chosen, the engine message is bounded, read-only agents get the text-only path', async () => {
  const proj = tempDir('wbt-ws-'); write(proj, 'package.json', '{}');
  assert.equal(SV.defaultWorkspace({}, proj), path.resolve(proj));
  assert.notEqual(SV.defaultWorkspace({}, '/'), '/'); assert.ok(SV.defaultWorkspace({}, '/').startsWith(path.resolve(data)));
  assert.equal(SV.defaultWorkspace({ NEUROCLAW_WORKSPACE: proj }, '/'), path.resolve(proj));
  const msg = SV.composeMessage({ system: 'S'.repeat(5000), history: Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: 'h'.repeat(900) + i })), prompt: 'PROMPT' });
  assert.ok(msg.length < 2000 + 6 * 520 + 50); assert.ok(msg.endsWith('PROMPT'));
  const used = [];
  const ex = SV.engineExecutor(() => ({ act: async () => { used.push('act'); return 'a'; }, text: async () => { used.push('text'); return 't'; } }));
  const A = await W('agents');
  const call = (name) => ({ system: '', history: [], prompt: 'p', agent: A.BUILTIN_AGENTS.find((a) => a.name === name) });
  await ex(call('plan')); await ex(call('explore')); await ex(call('build')); await ex(call('general'));
  assert.deepEqual(used, ['text', 'text', 'act', 'act']);
  await assert.rejects(SV.engineExecutor(() => null)(call('build')), /not reachable/);
  removeDir(proj);
});

test('HTTP: the workbench routes answer on the real server, a share link opens without a login and a bad one does not', async () => {
  const ws = tempDir('wbt-http-ws-'); write(ws, 'AGENTS.md', 'be brief');
  const srv = await startServer({ env: { NEUROCLAW_WORKSPACE: ws } });
  try {
    const st = await api(srv.url, '/api/workbench/status');
    assert.equal(st.status, 200, st.text); assert.deepEqual(st.json.agents.map((a) => a.name).slice(0, 4), ['build', 'plan', 'general', 'explore']);
    assert.equal((await api(srv.url, '/api/workbench/run', { method: 'POST', body: {} })).status, 400);
    const run = await api(srv.url, '/api/workbench/run', { method: 'POST', body: { prompt: 'hello there', agent: 'explore' } });
    assert.equal(run.status, 200, run.text); assert.equal(run.json.agent, 'explore'); assert.equal(typeof run.json.text, 'string'); assert.match(run.json.session, /^[a-f0-9]{12}$/);
    const list = await api(srv.url, '/api/workbench/sessions'); assert.equal(list.json.sessions.length, 1);
    const detail = await api(srv.url, `/api/workbench/sessions/${run.json.session}`); assert.equal(detail.json.messages.length, 2);
    const share = await api(srv.url, `/api/workbench/sessions/${run.json.session}/share`, { method: 'POST', body: { days: 1 } });
    assert.equal(share.status, 200, share.text); assert.match(share.json.path, /^\/share\/[A-Za-z0-9_-]{32}/);
    const page = await api(srv.url, share.json.path); assert.equal(page.status, 200); assert.match(page.text, /hello there/); assert.match(page.text, /ambient\.css/); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal((await api(srv.url, '/share/' + 'x'.repeat(40))).status, 404);
    await api(srv.url, '/api/workbench/shares/revoke', { method: 'POST', body: { token: share.json.path.slice(7) } });
    assert.equal((await api(srv.url, share.json.path)).status, 404);
    assert.equal((await api(srv.url, '/api/workbench/undo', { method: 'POST', body: {} })).status, 409);
    // A form post from another site cannot say application/json without a preflight the browser refuses; the route must refuse it too.
    for (const p of ['/api/workbench/undo', '/api/workbench/run', '/api/workbench/shares/revoke', `/api/workbench/sessions/${run.json.session}/share`]) {
      const csrf = await fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(csrf.status, 415, p);
    }
    assert.equal((await api(srv.url, '/api/workbench/sessions')).json.sessions.length, 1, 'the refused posts changed nothing');
    assert.equal((await api(srv.url, '/api/workbench/nothing')).status, 404);
    assert.equal((await api(srv.url, '/api/workbench/usage?days=1')).json.turns, 1);
    assert.deepEqual((await api(srv.url, '/api/workbench/mcp')).json.servers, []);
    const hosts = await api(srv.url, '/api/plugin-host'); assert.ok(hosts.json.plugins.some((p) => p.id === 'workbench-routes' && p.state === 'running'));
  } finally { await srv.stop(); removeDir(ws); }
});
