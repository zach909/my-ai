/**
 * KOS apps: open by address, two versions of the system, everything through the layers.
 * Run: node --test test/platform/kos-apps.test.mjs   (needs: node scripts/build-backend.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const K = await import(pathToFileURL(path.join(root, 'dist', 'interface', 'platform', 'kos-apps.js')).href);

const recorder = (status = 'ran') => { const calls = []; return { calls, run: async (tool, request) => { calls.push([tool, request]); return { status, text: `did: ${request}` }; } }; };
const tmpStore = () => { const d = mkdtempSync(path.join(tmpdir(), 'kos-apps-')); return { dir: d, store: new K.KosAppStore(path.join(d, 'kos-apps.json')), done: () => rmSync(d, { recursive: true, force: true }) }; };

test('an address opens like a web address: kos://name, kos:name or name', () => {
  for (const a of ['kos://firefox', 'KOS://firefox/', 'kos:firefox', ' firefox ']) assert.deepEqual(K.parseAddress(a), { ok: true, name: 'firefox' });
  for (const a of ['', 'kos://', 'two words', 'a/b', 'kos://x?y=1', '../etc', 'x;rm', 7, null, 'a'.repeat(65)]) assert.equal(K.parseAddress(a).ok, false, String(a));
});

test('a name nobody registered is an app on the computer, opened with the button clicker only', async () => {
  const r = recorder();
  const out = await K.openApp('kos://Firefox', { apps: K.BUILTIN_APPS, edition: 'extension', run: r.run, platform: 'linux' });
  assert.equal(out.status, 'ran');
  assert.equal(out.app.discovered, true);
  assert.deepEqual(r.calls, [['desktop', 'launch the app Firefox']]);
});

test('everything is an app: the layers have front ends in the same list', () => {
  assert.deepEqual(K.BUILTIN_APPS.map((a) => a.id), ['buttons', 'commands', 'kernel', 'skills']);
  assert.deepEqual([...new Set(K.BUILTIN_APPS.flatMap((a) => a.open.map((x) => x.layer)))].sort(), ['app', 'gui', 'kernel', 'skill']);
});

test('every request goes through a layer, to that layer\'s tool and no other', async () => {
  const r = recorder();
  const apps = [...K.BUILTIN_APPS, K.validateApp({ id: 'notes', name: 'Notes', scope: 'extension', open: [{ layer: 'app', request: 'run notes --sync' }, { layer: 'gui', request: 'launch the app notes' }] })];
  await K.openApp('kos://notes', { apps, edition: 'extension', run: r.run, platform: 'linux' });
  assert.deepEqual(r.calls, [['terminal', 'run notes --sync'], ['desktop', 'launch the app notes']]);
});

test('extension version: system apps and the kernel layer are closed', async () => {
  const r = recorder();
  for (const addr of ['kos://kernel']) {
    const out = await K.openApp(addr, { apps: K.BUILTIN_APPS, edition: 'extension', run: r.run, platform: 'linux' });
    assert.equal(out.status, 'refused');
    assert.match(out.text, /system version/);
  }
  assert.equal(r.calls.length, 0);
  // an app that does not claim system scope still cannot reach the kernel layer through a hand-built manifest
  const sneaky = { id: 'x', name: 'x', scope: 'extension', open: [{ layer: 'kernel', request: 'list the system services' }] };
  assert.equal((await K.openApp('x', { apps: [sneaky], edition: 'extension', run: r.run, platform: 'linux' })).status, 'refused');
  assert.equal(r.calls.length, 0);
});

test('system version: system apps open on Linux through the kernel layer, and only on Linux', async () => {
  const r = recorder();
  const ok = await K.openApp('kos://kernel', { apps: K.BUILTIN_APPS, edition: 'system', run: r.run, platform: 'linux' });
  assert.equal(ok.status, 'ran');
  assert.deepEqual(r.calls, [['linux-permission-tools', 'list the system services']]);
  const mac = await K.openApp('kos://kernel', { apps: K.BUILTIN_APPS, edition: 'system', run: r.run, platform: 'darwin' });
  assert.equal(mac.status, 'unavailable');
  assert.equal(r.calls.length, 1);
});

test('a held or refused step stops the rest and is passed up unchanged', async () => {
  const calls = [];
  const apps = [K.validateApp({ id: 'two', name: 'Two', scope: 'extension', open: [{ layer: 'app', request: 'first' }, { layer: 'gui', request: 'second' }] })];
  const out = await K.openApp('two', { apps, edition: 'extension', platform: 'linux', run: async (t, q) => { calls.push(t); return { status: 'held', text: 'waiting for approval' }; } });
  assert.equal(out.status, 'held');
  assert.equal(out.text, 'waiting for approval');
  assert.deepEqual(calls, ['terminal']);
  assert.equal(out.steps.length, 1);
});

test('manifests are checked: kernel needs system scope, layers must exist, requests are bounded, built-ins cannot be replaced', () => {
  const base = { id: 'a', name: 'A', scope: 'extension', open: [{ layer: 'gui', request: 'x' }] };
  assert.equal(K.validateApp(base).id, 'a');
  const bad = [
    { ...base, id: 'Bad Id' }, { ...base, scope: 'root' }, { ...base, open: [] }, { ...base, open: Array(9).fill(base.open[0]) },
    { ...base, open: [{ layer: 'email', request: 'x' }] }, { ...base, open: [{ layer: 'gui', request: '' }] },
    { ...base, open: [{ layer: 'gui', request: 'x'.repeat(601) }] }, { ...base, open: [{ layer: 'kernel', request: 'x' }] },
    { ...base, id: 'kernel' }, null, [], 'a',
  ];
  for (const b of bad) assert.throws(() => K.validateApp(b), K.KosAppError, JSON.stringify(b)?.slice(0, 60));
});

test('the store: extension is the default; apps and the version persist; bad entries on disk are ignored; failures change nothing', () => {
  const { dir, store, done } = tmpStore();
  try {
    assert.equal(store.edition(), 'extension');
    assert.equal(store.list().length, K.BUILTIN_APPS.length);
    store.install({ id: 'notes', name: 'Notes', scope: 'extension', open: [{ layer: 'gui', request: 'launch the app notes' }] });
    store.setEdition('system');
    const again = new K.KosAppStore(path.join(dir, 'kos-apps.json'));
    assert.equal(again.edition(), 'system');
    assert.deepEqual(again.installed().map((a) => a.id), ['notes']);
    assert.throws(() => store.setEdition('root'), K.KosAppError);
    assert.throws(() => store.remove('kernel'), K.KosAppError);
    assert.equal(store.remove('nope'), false);
    assert.equal(store.remove('notes'), true);

    writeFileSync(path.join(dir, 'kos-apps.json'), JSON.stringify({ edition: 'wat', apps: [{ id: 'ok', name: 'Ok', scope: 'extension', open: [{ layer: 'gui', request: 'x' }] }, { id: 'evil', scope: 'extension', open: [{ layer: 'kernel', request: 'x' }] }] }));
    assert.equal(store.edition(), 'extension');
    assert.deepEqual(store.installed().map((a) => a.id), ['ok']);
    writeFileSync(path.join(dir, 'kos-apps.json'), '{ not json');
    assert.equal(store.edition(), 'extension');
  } finally { done(); }
});

test('a save that fails says so and the file is unchanged', { skip: process.getuid?.() === 0 }, () => {
  const { dir, store, done } = tmpStore();
  try {
    store.setEdition('system');
    const before = readFileSync(path.join(dir, 'kos-apps.json'), 'utf8');
    chmodSync(dir, 0o500);
    assert.throws(() => store.setEdition('extension'), /Nothing was changed/);
    chmodSync(dir, 0o700);
    assert.equal(readFileSync(path.join(dir, 'kos-apps.json'), 'utf8'), before);
  } finally { try { chmodSync(dir, 0o700); } catch { /* */ } done(); }
});

test('the module can reach the computer only through runLayer: no process, network or direct tool imports', () => {
  const src = readFileSync(path.join(root, 'interface', 'platform', 'kos-apps.ts'), 'utf8');
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['../../models && skills/core/atomic-write.js', './ai-os-layers.js', './app-paths.js', 'node:fs'].sort());
  assert.doesNotMatch(src, /child_process|node:net|node:http|fetch\(|spawn|exec\(|process\.kill|runTool|pluginRegistry/);
  assert.match(src, /runLayer\(/);
});
