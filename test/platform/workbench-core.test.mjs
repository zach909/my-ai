/**
 * The workbench's building blocks: text helpers, permission rules, agents, commands, hooks, checkpoints,
 * instruction files, memory, compaction and sessions. Node built-ins only (node:test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dist, ensureBuilt, tempDir, removeDir } from './helpers.mjs';

const data = tempDir('wb-data-');
process.env.CORONA_DATA_DIR = data;
process.env.NEUROCLAW_MANAGED_FILE = path.join(data, 'no-managed.json');
delete process.env.NEUROCLAW_OFFLINE;
ensureBuilt();
const W = (n) => import(dist(`interface/workbench/${n}.js`));
const T = await W('text-utils'), P = await W('permissions'), A = await W('agents'), C = await W('commands');
const H = await W('hooks'), CP = await W('checkpoints'), I = await W('instructions'), K = await W('compaction');
const S = await W('sessions'), D = await W('diff'), PA = await W('paths');
const project = () => { const d = tempDir('wb-proj-'); return d; };
const write = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };

test('frontmatter: key values, inline lists and dash lists; a file with none is all body', () => {
  const r = T.parseFrontmatter('---\nname: x\ntools: [read, search]\ndisallowed:\n  - bash\n  - edit\n---\nBody here');
  assert.equal(r.data.name, 'x'); assert.deepEqual(r.data.tools, ['read', 'search']); assert.deepEqual(r.data.disallowed, ['bash', 'edit']); assert.equal(r.body, 'Body here');
  assert.deepEqual(T.parseFrontmatter('just text'), { data: {}, body: 'just text' });
});

test('globs: path mode keeps * inside a folder, ** crosses, braces choose; a hostile pattern does not hang', () => {
  assert.ok(T.globMatch('src/*.ts', 'src/a.ts', 'path')); assert.ok(!T.globMatch('src/*.ts', 'src/x/a.ts', 'path'));
  assert.ok(T.globMatch('src/**', 'src/x/y/a.ts', 'path')); assert.ok(T.globMatch('**/.env', '.env', 'path')); assert.ok(T.globMatch('**/.env', 'a/b/.env', 'path'));
  assert.ok(T.globMatch('a.{ts,js}', 'a.js', 'path')); assert.ok(!T.globMatch('a.{ts,js}', 'a.py', 'path'));
  const t0 = Date.now(); T.globMatch('a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000), 'plain'); assert.ok(Date.now() - t0 < 1500);
});

test('splitArgs honours quotes; redactSecrets removes keys, bearer tokens and private keys', () => {
  assert.deepEqual(T.splitArgs(`a "b c" 'd e' f\\ g`), ['a', 'b c', 'd e', 'f g']);
  const r = T.redactSecrets('key sk-abcdefghijklmnopqrstuvwx and Authorization: Bearer abcdefghijklmnopqrstuv and password="hunter2hunter"');
  assert.ok(!/sk-abcdef|abcdefghijklmnopqrstuv|hunter2/.test(r));
  // Built from pieces so this file never holds a literal key header (the CI credential scan would rightly flag it).
  const pem = (edge) => `-----${edge} RSA ` + 'PRIVATE' + ' KEY-----';
  assert.ok(T.looksSecret(`${pem('BEGIN')}\nabc\n${pem('END')}`));
});

const engine = (cfgs, root = '/tmp/p') => new P.PermissionEngine(cfgs.map(([name, config]) => ({ name, config })), { root });

test('permissions: deny beats allow; compound commands need every part allowed; substitutions never match an allow', () => {
  const e = engine([['user', { allow: ['bash(git status*)', 'bash(npm test*)'] }], ['builtin', { ask: ['bash'], deny: ['bash(rm -rf*)'] }]]);
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status --short' }).decision, 'allow');
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status && npm test' }).decision, 'allow');
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status && curl evil' }).decision, 'ask');
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status; rm -rf /' }).decision, 'deny');
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status $(curl evil)' }).decision, 'ask');
  assert.equal(e.evaluate({ tool: 'bash', target: 'git status `id`' }).decision, 'ask');
  assert.equal(e.evaluate({ tool: 'bash', target: 'ls' }).decision, 'ask');
});

test('permissions: a deny in any layer is final; the highest layer with a rule decides otherwise', () => {
  const e = engine([['managed', { deny: ['edit(secrets/**)'] }], ['user', { allow: ['edit(**)'] }], ['project', { ask: ['edit(**)'] }], ['builtin', { default: 'ask' }]]);
  assert.equal(e.evaluate({ tool: 'edit', target: 'secrets/key.txt' }).decision, 'deny');
  assert.equal(e.evaluate({ tool: 'edit', target: 'src/a.ts' }).decision, 'allow');
  assert.equal(engine([['project', { allow: ['edit(**)'] }], ['builtin', { ask: ['edit'] }]]).evaluate({ tool: 'edit', target: 'a' }).decision, 'allow');
  assert.equal(engine([['builtin', {}]]).evaluate({ tool: 'anything' }).decision, 'ask');
});

test('permissions: paths outside the project never match a relative allow; domains and agents work', () => {
  const root = project();
  const e = engine([['user', { allow: ['edit(**)', 'fetch(domain:*.example.com)'], agents: { plan: { deny: ['edit'] } } }], ['builtin', { default: 'ask' }]], root);
  assert.equal(e.evaluate({ tool: 'edit', target: 'a/b.ts' }).decision, 'allow');
  assert.notEqual(e.evaluate({ tool: 'edit', target: '../outside.txt' }).decision, 'allow');
  assert.notEqual(e.evaluate({ tool: 'edit', target: '/etc/passwd' }).decision, 'allow');
  assert.equal(e.evaluate({ tool: 'fetch', target: 'https://docs.example.com/x' }).decision, 'allow');
  assert.equal(e.evaluate({ tool: 'fetch', target: 'https://evil.com/x' }).decision, 'ask');
  assert.equal(e.evaluate({ tool: 'edit', target: 'a.ts', agent: 'plan' }).decision, 'deny');
  const link = path.join(root, 'link'); symlinkSync('/etc', link);
  assert.notEqual(e.evaluate({ tool: 'edit', target: 'link/passwd' }).decision, 'allow');
  removeDir(root);
});

test('permissions: malformed config is dropped, not trusted', () => {
  const c = P.sanitizeConfig({ allow: ['read(**)', 5, '((', 'x'.repeat(500)], default: 'maybe', agents: { a: { deny: ['bash'] } } });
  assert.deepEqual(c.allow, ['read(**)']); assert.equal(c.default, undefined); assert.deepEqual(c.agents.a.deny, ['bash']);
  assert.equal(P.mostRestrictive('allow', 'deny', 'ask'), 'deny');
});

test('agents: four built-in modes; plan and explore cannot change files; custom agents only narrow', () => {
  assert.deepEqual(A.BUILTIN_AGENTS.map((a) => a.name), ['build', 'plan', 'general', 'explore']);
  const plan = A.agentRules(A.BUILTIN_AGENTS[1]);
  for (const t of ['edit', 'write', 'delete', 'bash', 'mcp:*']) assert.ok(plan.deny.includes(t), t);
  assert.ok(!plan.deny.includes('read'));
  const root = project();
  write(root, 'agents/reviewer.md', '---\ndescription: Reviews code\ntools: read, search\nmodel: fast\neffort: high\n---\nYou review.');
  write(root, 'agents/plan.md', '---\ntools: bash\n---\nHijack');
  write(root, 'agents/Bad Name.md', 'x');
  const r = A.loadAgentsFrom(path.join(root, 'agents'), 'project');
  assert.deepEqual(r.items.map((a) => a.name), ['reviewer']);
  assert.equal(r.items[0].model, 'fast'); assert.equal(r.items[0].effort, 'high');
  assert.equal(r.warnings.length, 2);
  assert.ok(A.agentRules(r.items[0]).deny.includes('bash'));
  removeDir(root);
});

test('commands: arguments, quoted words, a file include confined to the project, namespaces from folders', () => {
  const root = project();
  write(root, 'cmds/fix.md', '---\ndescription: Fix\nagent: build\n---\nFix $1 in $2.\nAll: $ARGUMENTS\n@notes.txt');
  write(root, 'cmds/git/commit.md', 'Commit it');
  write(root, 'notes.txt', 'NOTES');
  const { items } = C.loadCommandsFrom(path.join(root, 'cmds'), 'project');
  assert.deepEqual(items.map((c) => c.name).sort(), ['fix', 'git:commit']);
  const out = C.expandCommand(items.find((c) => c.name === 'fix'), 'bug "a b.ts"', { root });
  assert.match(out, /Fix bug in a b\.ts\./); assert.match(out, /NOTES/);
  const esc = { ...items[0], template: '@../../etc/passwd' };
  assert.equal(C.expandCommand(esc, '', { root }), '@../../etc/passwd');
  assert.deepEqual(C.parseSlash('/git:commit now'), { name: 'git:commit', args: 'now' }); assert.equal(C.parseSlash('hello'), null);
  removeDir(root);
});

test('hooks: exit 2 blocks with the reason, other codes warn, stdout comes back as notes, the environment is clean, timeouts kill', async () => {
  const root = project();
  process.env.SECRET_FOR_TEST = 'leak';
  const cfg = H.sanitizeHookConfig({ hooks: {
    PreToolUse: [
      { matcher: 'edit|write', hooks: [{ command: 'echo "no edits here" >&2; exit 2' }] },
      { matcher: 'bash', hooks: [{ command: 'exit 1' }] },
    ],
    PostToolUse: [{ hooks: [{ command: 'echo "env=$SECRET_FOR_TEST event=$NEUROCLAW_HOOK_EVENT"; cat >/dev/null' }] }],
    Stop: [{ hooks: [{ command: 'sleep 5', timeout: 0.3 }] }],
  } });
  const run = new H.HookRunner(cfg, root);
  const blocked = await run.run({ event: 'PreToolUse', tool: 'edit', target: 'a' });
  assert.equal(blocked.blocked, true); assert.match(blocked.reason, /no edits here/);
  const warned = await run.run({ event: 'PreToolUse', tool: 'bash' });
  assert.equal(warned.blocked, false); assert.match(warned.warnings[0], /exited 1/);
  assert.equal((await run.run({ event: 'PreToolUse', tool: 'read' })).ran, 0);
  const post = await run.run({ event: 'PostToolUse', tool: 'edit' });
  assert.equal(post.notes[0], 'env= event=PostToolUse');
  const t0 = Date.now(); const to = await run.run({ event: 'Stop' });
  assert.ok(Date.now() - t0 < 3000); assert.match(to.warnings[0], /timed out/);
  removeDir(root);
});

test('formatters run without a shell, with the file in place; a failing one warns', async () => {
  const root = project();
  const f = write(root, 'a.txt', 'x');
  const run = new H.HookRunner(H.sanitizeHookConfig({ formatters: [{ extensions: ['.txt'], command: [process.execPath, '-e', 'require("fs").appendFileSync(process.argv[1],"!")', '{file}'] }, { extensions: ['.bad'], command: [process.execPath, '-e', 'process.exit(3)'] }] }), root);
  assert.deepEqual(await run.format(f), { ran: true });
  assert.equal(readFileSync(f, 'utf8'), 'x!');
  assert.match((await run.format(path.join(root, 'z.bad'))).warning, /Formatter failed/);
  assert.deepEqual(await run.format(path.join(root, 'z.zzz')), { ran: false });
  removeDir(root);
});

test('checkpoints: undo and redo restore content and remove files the turn created', () => {
  const root = project(); const dd = tempDir('wb-cp-');
  const a = write(root, 'a.txt', 'one');
  const s = new CP.CheckpointStore(root, dd);
  s.begin('turn 1', 4);
  s.track('a.txt'); writeFileSync(a, 'two'); s.track('new.txt'); writeFileSync(path.join(root, 'new.txt'), 'fresh');
  s.end();
  const u = s.undo();
  assert.ok(u.ok); assert.equal(readFileSync(a, 'utf8'), 'one'); assert.ok(!existsSync(path.join(root, 'new.txt')));
  assert.equal(s.undo().ok, false);
  const r = s.redo();
  assert.ok(r.ok); assert.equal(readFileSync(a, 'utf8'), 'two'); assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'fresh');
  removeDir(root); removeDir(dd);
});

test('checkpoints: rewind to an earlier turn; changes made outside the agent block an undo unless forced', () => {
  const root = project(); const dd = tempDir('wb-cp-');
  const a = write(root, 'a.txt', 'v0');
  const s = new CP.CheckpointStore(root, dd);
  const ids = [];
  for (const v of ['v1', 'v2', 'v3']) { const c = s.begin(v, ids.length * 2); s.track('a.txt'); writeFileSync(a, v); s.end(); ids.push(c.id); }
  const r = s.rewind(ids[0]);
  assert.ok(r.ok); assert.equal(r.undone, 2); assert.equal(readFileSync(a, 'utf8'), 'v1'); assert.equal(r.messages, 0);
  writeFileSync(a, 'hand edit');
  const blocked = s.undo();
  assert.equal(blocked.ok, false); assert.deepEqual(blocked.drifted, ['a.txt']); assert.equal(readFileSync(a, 'utf8'), 'hand edit');
  assert.ok(s.undo({ force: true }).ok); assert.equal(readFileSync(a, 'utf8'), 'v0');
  assert.equal(s.rewind('nope').ok, false);
  removeDir(root); removeDir(dd);
});

test('checkpoints: files outside the project, links and large files are not tracked and say so; the store survives a restart', () => {
  const root = project(); const dd = tempDir('wb-cp-'); const out = tempDir('wb-out-');
  write(out, 'x.txt', 'x'); symlinkSync(path.join(out, 'x.txt'), path.join(root, 'link.txt')); write(root, 'big.bin', 'a'.repeat(5 * 1024 * 1024 + 1));
  const s = new CP.CheckpointStore(root, dd);
  s.begin('t');
  assert.equal(s.track(path.join(out, 'x.txt')), false); assert.equal(s.track('../escape'), false); assert.equal(s.track('link.txt'), false); assert.equal(s.track('big.bin'), false);
  assert.ok(s.skipped.length >= 4);
  write(root, 'ok.txt', '1'); s.track('ok.txt'); writeFileSync(path.join(root, 'ok.txt'), '2'); s.end();
  const again = new CP.CheckpointStore(root, dd);
  assert.equal(again.list().length, 1); assert.ok(again.undo().ok); assert.equal(readFileSync(path.join(root, 'ok.txt'), 'utf8'), '1');
  assert.equal(readFileSync(path.join(out, 'x.txt'), 'utf8'), 'x');
  removeDir(root); removeDir(dd); removeDir(out);
});

test('diff: marks added and removed lines and trims to context', () => {
  const d = D.renderDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nX\ne\nf\ng\nh', 1);
  assert.match(d, /-d/); assert.match(d, /\+X/); assert.ok(!d.includes(' a'));
  assert.deepEqual(D.diffStats('a\nb', 'a\nc\nd'), { added: 2, removed: 1 });
});

test('instructions: layers from the project root down; fallback names; imports stay inside; nested folders load on demand', () => {
  const root = project(); const user = tempDir('wb-user-');
  write(user, 'AGENTS.md', 'USER RULE');
  write(root, 'CLAUDE.md', 'ROOT RULE\n@docs/extra.md\n@../outside.md');
  write(root, 'docs/extra.md', 'EXTRA');
  write(path.dirname(root), 'outside.md', 'OUTSIDE-SECRET');
  write(root, 'pkg/AGENTS.md', 'PKG RULE'); write(root, 'pkg/.cursorrules', 'IGNORED, AGENTS wins');
  write(root, 'other/.cursorrules', 'OTHER RULE');
  const ins = new I.Instructions(root, { userDir: user, managed: path.join(user, 'none.md') });
  const top = ins.render(ins.load(root));
  assert.ok(top.indexOf('USER RULE') < top.indexOf('ROOT RULE')); assert.match(top, /EXTRA/); assert.ok(!top.includes('OUTSIDE-SECRET')); assert.ok(!top.includes('PKG RULE'));
  const nested = ins.forPath('pkg/a.ts');
  assert.equal(nested.length, 1); assert.match(nested[0].text, /PKG RULE/); assert.equal(ins.forPath('pkg/b.ts').length, 0);
  assert.match(ins.forPath('other/x.ts')[0].text, /OTHER RULE/);
  const deep = ins.load(path.join(root, 'pkg')); assert.match(ins.render(deep), /PKG RULE/);
  removeDir(root); removeDir(user);
});

test('auto-memory: de-duplicates, refuses secrets, recalls by words, stays bounded', () => {
  const root = project(); const dd = tempDir('wb-mem-');
  const m = new I.AutoMemory(root, dd);
  assert.ok(m.remember('fix', 'Run the build with node scripts/build-backend.mjs before the platform tests').ok);
  assert.equal(m.remember('fix', 'run the build with node scripts/build-backend.mjs before the platform tests!').ok, false);
  assert.equal(m.remember('note', 'my api key is sk-abcdefghijklmnopqrstuvwxyz123456').ok, false);
  assert.equal(m.remember('note', 'short').ok, false);
  assert.match(m.recall('how do I run the platform tests build')[0].text, /build-backend/);
  assert.equal(m.recall('unrelated gardening question').length, 0);
  assert.equal(m.forget('x'), 0);
  for (let i = 0; i < 260; i++) m.remember('note', `a distinct remembered fact number ${i} about widgets ${'z'.repeat(i % 7)}`);
  assert.ok(m.all().length <= I.MEMORY_MAX_ENTRIES);
  removeDir(root); removeDir(dd);
});

test('compaction: only past the threshold; keeps the task, pinned and recent messages and diffs; lists files touched', () => {
  const msgs = [{ role: 'user', content: 'TASK: build the thing' }];
  for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `step ${i} ` + 'lorem ipsum dolor sit amet '.repeat(30), files: i === 5 ? ['src/early.ts'] : undefined });
  msgs[10].pinned = true;
  msgs[36] = { role: 'tool', content: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new' };
  assert.equal(K.compact(msgs, { budgetChars: 10_000_000 }).compacted, false);
  const r = K.compact(msgs, { budgetChars: 8000, keepRecent: 4 });
  assert.ok(r.compacted); assert.ok(r.after < r.before / 2);
  assert.equal(r.messages[0].content, 'TASK: build the thing'); assert.ok(r.messages.includes(msgs[10])); assert.ok(r.messages.includes(msgs[36])); assert.ok(r.messages.includes(msgs[40]));
  const sum = r.messages.find((m) => m.summary); assert.match(sum.content, /src\/early\.ts/);
});

test('sessions: append, resume, rename, fork with a parent, truncate, search; ids are checked', () => {
  const dd = tempDir('wb-sess-'); const s = new S.SessionStore(dd);
  const h = s.create({ cwd: '/p', agent: 'build', title: 'first' });
  s.append(h.id, { role: 'user', content: 'tell me about zebras' }); s.append(h.id, { role: 'assistant', content: 'zebras have stripes' });
  s.rename(h.id, 'Zebra chat');
  assert.equal(s.get(h.id).header.title, 'Zebra chat'); assert.equal(s.get(h.id).messages.length, 2);
  const f = s.fork(h.id, 1); assert.equal(f.parent, h.id); assert.equal(s.get(f.id).messages.length, 1);
  s.truncate(h.id, 1); assert.equal(s.get(h.id).messages.length, 1);
  assert.equal(s.search('zebras').length, 2); assert.equal(s.search('giraffe').length, 0);
  assert.equal(s.list().length, 2);
  assert.equal(s.get('../../etc/passwd'), null);
  assert.throws(() => s.append('../x', { role: 'user', content: 'x' }));
  assert.equal(s.get('nothexnothex'), null);
  removeDir(dd);
});

test('sharing: an unguessable link to a redacted read-only page; expiry, revocation and offline mode close it', async () => {
  const dd = tempDir('wb-share-'); const s = new S.SessionStore(dd);
  const h = s.create({ cwd: '/p', agent: 'build', title: 'Deploy <script>' });
  s.append(h.id, { role: 'user', content: 'use password="hunter2hunter" and <b>bold</b>' });
  s.append(h.id, { role: 'assistant', content: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new' });
  const r = s.share(h.id); assert.ok(r.ok); assert.ok(r.token.length >= 32);
  const html = s.renderShare(r.token);
  assert.match(html, /nc-soft/); assert.ok(!html.includes('hunter2')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<b>bold')); assert.match(html, /class="add"/);
  assert.equal(s.renderShare('A'.repeat(32)), null);
  const NG = await W('netguard');
  NG.setOffline(true); assert.equal(s.renderShare(r.token), null); assert.equal(s.share(h.id).ok, false); NG.setOffline(null);
  assert.ok(s.revoke(r.token)); assert.equal(s.renderShare(r.token), null);
  const r2 = s.share(h.id); const file = path.join(dd, 'shares.json'); const all = JSON.parse(readFileSync(file, 'utf8')); all[r2.token].expires = Date.now() - 1; writeFileSync(file, JSON.stringify(all));
  assert.equal(s.renderShare(r2.token), null);
  removeDir(dd);
});

test('paths: confine refuses escapes and links that point out', () => {
  const root = project(); const out = tempDir('wb-o-');
  symlinkSync(out, path.join(root, 'l'));
  assert.ok(PA.confine(root, 'a/b.txt')); assert.equal(PA.confine(root, '../x'), null); assert.equal(PA.confine(root, '/etc/passwd'), null); assert.equal(PA.confine(root, 'l/file'), null);
  rmSync(root, { recursive: true, force: true }); removeDir(out);
});
