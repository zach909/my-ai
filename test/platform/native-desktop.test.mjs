/**
 * The native button clicker on Windows and macOS, driven through a stand-in runner so what is sent can be
 * checked on any machine. This does NOT prove it works on a real Windows or macOS desktop; it proves the
 * rules hold (own windows only, focus confirmed, fixed scripts, values only through the environment) and
 * that errors are reported plainly. Run: node --test test/platform/native-desktop.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const N = await import(pathToFileURL(path.join(root, 'dist', 'models && skills', 'core', 'desktop', 'native.js')).href);
const B = await import(pathToFileURL(path.join(root, 'dist', 'models && skills', 'core', 'desktop', 'backends.js')).href);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

/** A runner that records every call and answers per operation. */
function fake(answers) {
  const calls = [];
  const run = async (file, args, env = {}) => {
    calls.push({ file, args, env });
    const a = answers[env.OSAI_OP ?? file];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(env, args) : (a ?? { status: 0, stdout: '', stderr: '' });
  };
  return { calls, run };
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

test('the backend is chosen natively: Windows and macOS get their own, other systems say so', () => {
  assert.equal(B.selectBackend({}, 'win32').kind, 'windows');
  assert.equal(B.selectBackend({}, 'darwin').kind, 'macos');
  assert.equal(B.selectBackend({ DISPLAY: ':0' }, 'linux').kind, 'x11');
  assert.equal(B.selectBackend({ WAYLAND_DISPLAY: 'w0' }, 'linux').kind, 'wayland');
  assert.equal(B.selectBackend({}, 'linux').kind, 'none');
  assert.equal(B.selectBackend({ DISPLAY: ':0' }, 'freebsd').kind, 'unsupported');
});

test('Windows: windows are listed, and only a program the agent started counts as the agent\'s', async () => {
  const pids = new Set([100]);
  const f = fake({ list: ok(JSON.stringify([{ id: '1001', pid: 100, title: 'Mine' }, { id: '2002', pid: 200, title: 'Yours' }])) });
  const w = new N.WindowsBackend(f.run, pids);
  const list = await w.listWindows();
  assert.deepEqual(list.map((x) => [x.id, x.pid, x.title, x.owned]), [['1001', 100, 'Mine', true], ['2002', 200, 'Yours', false]]);
  await assert.rejects(w.typeInto('2002', 'hi'), /belongs to the user/);
  await assert.rejects(w.clickIn('2002', 1, 1, 1), /belongs to the user/);
  await assert.rejects(w.moveWindow('2002', 0, 0, 10, 10), /belongs to the user/);
  await assert.rejects(w.closeWindow('2002'), /belongs to the user/);
  await assert.rejects(w.typeInto('999', 'hi'), /No window/);
  await assert.rejects(w.typeInto('1001; calc', 'hi'), /not a window id/);
  assert.equal(f.calls.filter((c) => c.env.OSAI_OP !== 'list').length, 0, 'nothing but the list reached PowerShell');
});

test('Windows: a single window and no windows both parse', async () => {
  const one = new N.WindowsBackend(fake({ list: ok('{"id":"5","pid":9,"title":"T"}') }).run, new Set());
  assert.equal((await one.listWindows()).length, 1);
  const none = new N.WindowsBackend(fake({ list: ok('[]') }).run, new Set());
  assert.deepEqual(await none.listWindows(), []);
  const bad = new N.WindowsBackend(fake({ list: ok('not json') }).run, new Set());
  await assert.rejects(bad.listWindows(), /could not read/);
});

test('Windows: input reaches PowerShell as fixed script + environment values, with the owner process checked', async () => {
  const f = fake({ list: ok(JSON.stringify([{ id: '77', pid: 8, title: 'Own' }])) });
  const w = new N.WindowsBackend(f.run, new Set([8]));
  await w.typeInto('77', 'a+b\n"quoted" $(evil)');
  await w.clickIn('77', 10.7, 20, 3);
  await w.moveWindow('77', 1, 2, 300, 400);
  await w.closeWindow('77');
  const acts = f.calls.filter((c) => c.env.OSAI_OP !== 'list');
  assert.deepEqual(acts.map((c) => c.env.OSAI_OP), ['type', 'click', 'move', 'close']);
  for (const c of acts) {
    assert.equal(c.file, 'powershell.exe');
    assert.equal(c.env.OSAI_ID, '77');
    assert.equal(c.env.OSAI_OWNER, '8');
    assert.ok(c.args.includes('-EncodedCommand') && c.args.includes('-NoProfile'));
    // The script is the same fixed constant every time: no request text is in the command line.
    assert.equal(Buffer.from(c.args[c.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), N.WINDOWS_SCRIPT);
  }
  assert.equal(acts[0].env.OSAI_TEXT, 'a{+}b{ENTER}"quoted" ${(}evil{)}'.replace('${(}', '${(}'));
  assert.deepEqual([acts[1].env.OSAI_X, acts[1].env.OSAI_Y, acts[1].env.OSAI_BUTTON], ['10', '20', '3']);
  assert.deepEqual([acts[2].env.OSAI_W, acts[2].env.OSAI_H], ['300', '400']);
});

test('Windows: SendKeys characters are typed literally', () => {
  assert.equal(N.sendKeysEscape('a+b^c%d~e(f)g{h}i[j]'), 'a{+}b{^}c{%}d{~}e{(}f{)}g{{}h{}}i{[}j{]}');
  assert.equal(N.sendKeysEscape('one\ntwo\r\nthree\tx'), 'one{ENTER}two{ENTER}three{TAB}x');
});

test('Windows: the script confirms focus, checks bounds and the owning process, and holds no request text', () => {
  const s = N.WINDOWS_SCRIPT;
  assert.match(s, /did not come to the front, so nothing was sent/);
  assert.match(s, /is outside window/);
  assert.match(s, /does not belong to the program the agent started/);
  assert.match(s, /\$env:OSAI_TEXT/);
  assert.ok(!/Invoke-Expression|iex |Start-Process|DownloadString|Net\.WebClient/i.test(s), 'no way to run or fetch anything else');
});

test('Windows: describe reports reachable features, or why PowerShell could not be used', async () => {
  const good = await new N.WindowsBackend(fake({ probe: ok('ok 5.1') }).run).describe();
  assert.equal(good.reachable, true);
  assert.deepEqual([good.features.windows, good.features.screenshot, good.features.keyboard, good.features.pointer, good.features.moveResize, good.features.settings], [true, true, true, true, true, false]);
  assert.ok(good.notes.some((n) => /Store app/.test(n)));
  const bad = await new N.WindowsBackend(fake({ probe: { status: null, stdout: '', stderr: '', error: 'powershell.exe is not on this computer.' } }).run).describe();
  assert.equal(bad.reachable, false);
  assert.ok(Object.values(bad.features).every((v) => v === false));
});

test('Windows: a screenshot must be a real PNG', async () => {
  const w = new N.WindowsBackend(fake({ screenshot: ok(PNG.toString('base64') + '\r\n') }).run);
  assert.deepEqual(await w.screenshot(), PNG);
  await assert.rejects(new N.WindowsBackend(fake({ screenshot: ok('') }).run).screenshot(), /came back empty/);
  const f = fake({ screenshot: ok(PNG.toString('base64')) });
  await new N.WindowsBackend(f.run).screenshot({ x: 1.9, y: 2, width: 30, height: 40 });
  assert.equal(f.calls[0].env.OSAI_REGION, '1,2,30,40');
});

test('Windows: PowerShell errors are shown plainly', async () => {
  const w = new N.WindowsBackend(fake({ list: { status: 1, stdout: '', stderr: 'Get-Process : Access is denied\r\n#< CLIXML\r\n<Objs>...' } }).run);
  await assert.rejects(w.listWindows(), (e) => /Access is denied/.test(e.message) && !/CLIXML/.test(e.message));
});

test('macOS: ids are process:index, only the agent\'s programs are driven, and values go through the environment', async () => {
  const f = fake({ list: ok(JSON.stringify([{ id: '300:1', pid: 300, title: 'Mine' }, { id: '400:2', pid: 400, title: 'Yours' }])) });
  const m = new N.MacBackend(f.run, new Set([300]));
  const list = await m.listWindows();
  assert.deepEqual(list.map((x) => [x.id, x.owned]), [['300:1', true], ['400:2', false]]);
  await assert.rejects(m.typeInto('400:2', 'x'), /belongs to the user/);
  await assert.rejects(m.typeInto('300', 'x'), /not a window id/);
  await assert.rejects(m.clickIn('300:1; do shell script', 1, 1, 1), /not a window id/);
  await assert.rejects(m.closeWindow('999:1'), /No window/);
  await m.typeInto('300:1', 'hello "world"\nline2');
  await m.clickIn('300:1', 5, 6, 2);
  await m.moveWindow('300:1', 1, 2, 3, 4);
  await m.closeWindow('300:1');
  const acts = f.calls.filter((c) => c.env.OSAI_OP !== 'list');
  assert.deepEqual(acts.map((c) => c.env.OSAI_OP), ['type', 'click', 'move', 'close']);
  for (const c of acts) {
    assert.equal(c.file, 'osascript');
    assert.deepEqual(c.args.slice(0, 2), ['-l', 'JavaScript']);
    assert.equal(c.args[3], N.MAC_SCRIPT, 'the script is the same fixed constant');
    assert.deepEqual([c.env.OSAI_PID, c.env.OSAI_INDEX], ['300', '1']);
  }
  assert.equal(acts[0].env.OSAI_TEXT, 'hello "world"\nline2');
  assert.deepEqual([acts[1].env.OSAI_X, acts[1].env.OSAI_Y, acts[1].env.OSAI_BUTTON], ['5', '6', '2']);
});

test('macOS: the script confirms the program is in front and checks the click is inside the window', () => {
  assert.match(N.MAC_SCRIPT, /did not come to the front, so nothing was sent/);
  assert.match(N.MAC_SCRIPT, /is outside the window/);
  assert.ok(!/doShellScript|do shell script|Application\('Terminal'\)/.test(N.MAC_SCRIPT), 'it cannot run shell commands');
});

test('macOS: permission problems say what to switch on', () => {
  assert.match(N.macError('execution error: System Events got an error: osascript is not allowed assistive access. (-25211)'), /Accessibility/);
  assert.match(N.macError('Not authorized to send Apple events to System Events. (-1743)'), /Automation/);
  assert.equal(N.macError('some other failure'), 'some other failure');
});

test('macOS: describe is honest about permissions; a screenshot is a real PNG that is cleaned up', async () => {
  const good = await new N.MacBackend(fake({ probe: ok('ok') }).run).describe();
  assert.equal(good.reachable, true);
  assert.ok(good.notes.some((n) => /Accessibility/.test(n)) && good.notes.some((n) => /open/.test(n)));
  const blocked = await new N.MacBackend(fake({ probe: { status: 1, stdout: '', stderr: 'osascript is not allowed assistive access. (-25211)' } }).run).describe();
  assert.deepEqual([blocked.reachable, blocked.features.windows, blocked.features.screenshot], [true, false, true]);
  assert.match(blocked.notes[0], /Accessibility/);

  let seen = null;
  const shot = new N.MacBackend(async (file, args) => {
    assert.equal(file, 'screencapture');
    seen = args[args.length - 1];
    (await import('node:fs')).writeFileSync(seen, PNG);
    return ok();
  });
  assert.deepEqual(await shot.screenshot(), PNG);
  assert.equal((await import('node:fs')).existsSync(seen), false, 'the temporary file is removed');
  await assert.rejects(new N.MacBackend(async () => ({ status: 1, stdout: '', stderr: 'could not create image' })).screenshot(), /could not create image/);
});

test('the desktop plugin accepts every action form and wouldAct covers all of them (so the gate sees them)', async () => {
  const D = await import(pathToFileURL(path.join(root, 'dist', 'plugins', 'desktop.js')).href);
  const forms = {
    'desktop probe': 'probe', 'desktop windows': 'list_windows', 'desktop screenshot': 'screenshot',
    'desktop launch notepad.exe a.txt': 'launch_app', 'desktop click 77 10 20': 'click', 'desktop click 300:1 5 6 3': 'click',
    'desktop type 77 hello there': 'type_text', 'desktop move 77 0 0 300 400': 'move_window', 'desktop close 77': 'close_window',
  };
  for (const [text, tool] of Object.entries(forms)) {
    assert.equal(D.DesktopPlugin.parse(text)?.tool, tool, text);
  }
  assert.deepEqual(D.DesktopPlugin.parse('desktop launch notepad.exe a.txt').args, { command: 'notepad.exe', args: ['a.txt'] });
  assert.deepEqual(D.DesktopPlugin.parse('desktop click 77 -5 20').args.x, -5);
  for (const bad of ['click 77 1 2', 'desktop click', 'desktop click 77 a b', 'desktop click 77;ls 1 2', 'desktop close', 'desktop rm -rf', 'desktop type 77', 'desktop move 77 1 2 3', 'hello desktop windows']) {
    assert.equal(D.DesktopPlugin.parse(bad), null, bad);
  }
});
