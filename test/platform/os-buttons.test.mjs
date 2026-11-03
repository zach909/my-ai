/**
 * OS buttons (models && skills/core/os-buttons.ts): a prompt button kept on the computer, in the app menu or on
 * the desktop, written only after the owner has seen the exact file and approved it.
 *
 * The store is checked directly against a throwaway home folder (never the real one); the routes and the page
 * a launcher opens run on the real compiled server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api, dist, ensureBuilt, removeDir, startServer, tempDir } from './helpers.mjs';

ensureBuilt();
const O = await import(dist('models && skills/core/os-buttons.js'));
const P = await import(dist('interface/prompt-buttons.js'));
const mkHome = () => mkdtempSync(path.join(tmpdir(), 'nc-home-'));
const sys = (platform, home) => ({ platform, home, env: {} });

test('each system gets one launcher file per place, with a marker, and nothing from the label that could run', () => {
  const home = '/home/zed';
  const b = { id: 'tidy', label: 'Tidy up' };
  const menu = O.planOsButton(b, 'menu', 'http://127.0.0.1:7861/', sys('linux', home));
  assert.equal(menu.path, '/home/zed/.local/share/applications/neuroclaw-ask-tidy.desktop');
  assert.match(menu.content, /^Exec=xdg-open http:\/\/127\.0\.0\.1:7861\/ask\/tidy$/m);
  const desk = O.planOsButton(b, 'desktop', 'http://127.0.0.1:7861', sys('linux', home));
  assert.equal(desk.path, '/home/zed/Desktop/Tidy up.desktop');
  assert.equal(O.planOsButton(b, 'desktop', 'http://x', { platform: 'linux', home, env: { XDG_DESKTOP_DIR: '/mnt/d' } }).path, '/mnt/d/Tidy up.desktop');
  assert.equal(O.planOsButton(b, 'desktop', 'http://x', sys('darwin', home)).path, '/home/zed/Desktop/Tidy up.webloc');
  assert.equal(O.planOsButton(b, 'menu', 'http://x', sys('darwin', home)).path, '/home/zed/Applications/Tidy up.webloc');
  const win = O.planOsButton(b, 'desktop', 'http://x', { platform: 'win32', home: 'C:\\Users\\zed', env: {} });
  assert.match(win.path.replaceAll('\\', '/'), /Desktop\/Tidy up\.url$/);
  for (const p of [menu, desk, win]) assert.ok(p.content.includes('neuroclaw-os-button:tidy'), `${p.platform} has no marker`);
  assert.ok(O.isUnavailable(O.planOsButton(b, 'menu', 'http://x', sys('android', home))));

  // The prompt is not in the file or the link; a hostile label cannot add a line (an extra Exec=, say).
  assert.ok(!menu.content.includes('Tidy the'), 'the prompt leaked into the launcher');
  const evil = O.cleanLabel('Tidy\nExec=rm -rf ~\r\n');
  assert.ok(!/[\n\r]/.test(evil));
  const plan = O.planOsButton({ id: 'tidy', label: evil }, 'menu', 'http://127.0.0.1:7861', sys('linux', home));
  assert.equal(plan.content.split('\n').filter((l) => l.startsWith('Exec=')).length, 1);
  assert.throws(() => O.cleanWhere('everywhere'), /menu.*desktop/);
  assert.equal(O.cleanWhere(undefined), 'menu');
});

test('saving changes nothing outside the data folder; placing needs the approval a preview returned, once, in time, for that place', () => {
  const dir = tempDir('nc-btn-'); const home = mkHome();
  let now = 1_000;
  const store = new O.OsButtonStore(dir, () => now);
  const s = sys('linux', home);
  try {
    assert.throws(() => store.save('', 'x'), /label/i);
    assert.throws(() => store.save('Tidy', '   '), /prompt/i);
    assert.throws(() => store.save('Tidy', 'x'.repeat(O.PROMPT_MAX + 1)), /characters/);
    const b = store.save('Tidy up', 'Tidy the downloads folder');
    assert.equal(b.id, 'tidy-up');
    assert.equal(store.save('Tidy up', 'Another').id, 'tidy-up-2', 'several buttons may share a label');

    const desk = path.join(home, 'Desktop', 'Tidy up.desktop');
    assert.throws(() => store.place(b.id, 'desktop', 'nope', 'http://x', s), /Not approved/);
    assert.ok(!existsSync(desk), 'placed without a preview');
    const shown = store.preview(b.id, 'desktop', 'http://127.0.0.1:7861', s);
    assert.equal(shown.plan.path, desk);
    assert.ok(!existsSync(desk), 'a preview wrote the file');

    // The approval is for the place the preview showed: it does not stretch to the menu.
    assert.throws(() => store.place(b.id, 'menu', shown.approval, 'http://127.0.0.1:7861', s), /Not approved/);
    assert.ok(!existsSync(path.join(home, '.local')), 'wrote to the menu on a desktop approval');
    // ...and it was spent by that attempt, right or wrong.
    assert.throws(() => store.place(b.id, 'desktop', shown.approval, 'http://127.0.0.1:7861', s), /Not approved/);

    const again = store.preview(b.id, 'desktop', 'http://127.0.0.1:7861', s);
    now += O.APPROVAL_TTL_MS + 1;
    assert.throws(() => store.place(b.id, 'desktop', again.approval, 'http://127.0.0.1:7861', s), /Not approved/, 'an old approval still worked');

    const fresh = store.preview(b.id, 'desktop', 'http://127.0.0.1:7861', s);
    const placed = store.place(b.id, 'desktop', fresh.approval, 'http://127.0.0.1:7861', s);
    assert.equal(readFileSync(desk, 'utf8'), fresh.plan.content);
    assert.equal(placed.launcher.path, desk);
    assert.equal(store.get(b.id).launcher.where, 'desktop');

    // Removing deletes the file this wrote, and not one that someone replaced it with.
    writeFileSync(desk, 'my own file');
    assert.deepEqual(store.remove(b.id), { removed: true, launcherRemoved: false });
    assert.equal(readFileSync(desk, 'utf8'), 'my own file');
  } finally { removeDir(dir); removeDir(home); }
});

test('a file that is already at the place and is not NeuroClaw\'s is never overwritten', () => {
  const dir = tempDir('nc-btn-'); const home = mkHome();
  const store = new O.OsButtonStore(dir);
  const s = sys('linux', home);
  try {
    const b = store.save('Tidy up', 'Tidy the downloads folder');
    mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    writeFileSync(path.join(home, 'Desktop', 'Tidy up.desktop'), 'precious');
    const shown = store.preview(b.id, 'desktop', 'http://x', s);
    assert.throws(() => store.place(b.id, 'desktop', shown.approval, 'http://x', s), /left alone/);
    assert.equal(readFileSync(path.join(home, 'Desktop', 'Tidy up.desktop'), 'utf8'), 'precious');
  } finally { removeDir(dir); removeDir(home); }
});

test('[[put: ...]] is a button that offers a place; the place must be menu or desktop, and the prompt is its own', () => {
  const [p] = P.splitPromptButtons('[[put: Tidy up | Tidy the downloads folder | desktop]]');
  assert.deepEqual(p, { kind: 'button', text: 'Tidy up', prompt: 'Tidy the downloads folder', put: 'desktop' });
  assert.equal(P.splitPromptButtons('[[put: Tidy up | Tidy it]]')[0].put, 'menu', 'the menu is the default place');
  assert.equal(P.splitPromptButtons('[[put: Tidy]]')[0].prompt, 'Tidy');
  assert.ok(!P.splitPromptButtons('[[put: Tidy | Tidy it | the moon]]').some((x) => x.kind === 'button'), 'unknown place stays text');
  assert.equal(P.splitPromptButtons('[[ask: A | do a | b]]')[0].prompt, 'do a | b', 'an ask prompt may hold a bar');
  assert.equal(P.splitPromptButtons('[[ask: A | do a]]')[0].put, undefined);
});

let srv, home, btns;
before(async () => {
  home = mkHome(); btns = tempDir('nc-btns-');
  srv = await startServer({ env: { HOME: home, XDG_DATA_HOME: '', XDG_DESKTOP_DIR: '', CORONA_OS_BUTTONS_DIR: btns } });
});
after(async () => { await srv?.stop(); removeDir(home); removeDir(btns); });

test('on the real server: save, preview, approve, open the page a launcher opens, remove', async () => {
  const launcher = path.join(home, 'Desktop', 'Tidy up.desktop');
  const made = await api(srv.url, '/api/os-buttons', { method: 'POST', body: { label: 'Tidy up', prompt: 'Tidy </script> the downloads' } });
  assert.equal(made.status, 201);
  assert.equal(made.json.button.id, 'tidy-up');

  const blind = await api(srv.url, '/api/os-buttons/tidy-up/place', { method: 'POST', body: { where: 'desktop', approval: 'x' } });
  assert.equal(blind.status, 400);
  assert.match(blind.json.error, /Not approved/);
  assert.ok(!existsSync(launcher), 'placed without a preview');

  const shown = await api(srv.url, '/api/os-buttons/tidy-up/preview', { method: 'POST', body: { where: 'desktop' } });
  assert.equal(shown.status, 200);
  assert.equal(shown.json.plan.path, launcher);
  assert.ok(!existsSync(launcher), 'a preview wrote the launcher');
  assert.equal((await api(srv.url, '/api/os-buttons/tidy-up/preview', { method: 'POST', body: { where: 'moon' } })).status, 400);

  const ok = await api(srv.url, '/api/os-buttons/tidy-up/place', { method: 'POST', body: { where: 'desktop', approval: shown.json.approval } });
  assert.equal(ok.status, 200);
  assert.equal(readFileSync(launcher, 'utf8'), shown.json.plan.content);
  assert.match(readFileSync(launcher, 'utf8'), /\/ask\/tidy-up/);

  const page = await api(srv.url, '/ask/tidy-up');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Tidy up<\/title>/);
  assert.ok(page.text.includes('Tidy \\u003c/script> the downloads'), 'the prompt closed the page\'s script or was lost');
  // Opened by a link or another site, the page waits for a click; opened by the person (a launcher), it sends.
  assert.match(page.text, /if \(false\)/);
  const nav = await fetch(`${srv.url}/ask/tidy-up`, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.match(await nav.text(), /if \(true\)/);
  const cross = await fetch(`${srv.url}/ask/tidy-up`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.match(await cross.text(), /if \(false\)/);
  assert.equal((await api(srv.url, '/ask/nope')).status, 404);
  assert.equal((await api(srv.url, '/api/os-buttons')).json.buttons.length, 1);

  const gone = await api(srv.url, '/api/os-buttons/tidy-up', { method: 'DELETE' });
  assert.deepEqual(gone.json, { removed: true, launcherRemoved: true });
  assert.ok(!existsSync(launcher));
  assert.equal((await api(srv.url, '/ask/tidy-up')).status, 404);
});
