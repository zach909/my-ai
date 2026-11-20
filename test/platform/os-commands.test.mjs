/**
 * The OS-commands layer: a fixed table per system, nothing run through a shell, changes reported as actions
 * (so the gate holds them). Run: node --test test/platform/os-commands.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const O = await import(pathToFileURL(path.join(root, 'dist', 'interface', 'platform', 'os-commands.js')).href);
const P = await import(pathToFileURL(path.join(root, 'dist', 'plugins', 'os-commands.js')).href);

const parse = (req, platform, uid = 501) => O.parseOsCommand(req, platform, uid, 4242);

test('every command exists on all three systems and runs a real program, never a shell string', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const names = O.listOsCommands(platform).map((c) => c.name);
    assert.deepEqual(names, ['info', 'uptime', 'processes', 'services', 'service', 'network', 'disks', 'users', 'permissions', 'start', 'stop', 'restart', 'kill']);
    for (const req of ['info', 'uptime', 'processes', 'services', 'service sshd', 'network', 'disks', 'users', 'permissions /tmp', 'start sshd', 'stop sshd', 'restart sshd', 'kill 4000']) {
      const p = parse(req, platform);
      assert.equal(p.ok, true, `${platform}: ${req}`);
      const { file, args } = p.command.invocation;
      assert.ok(!/^(sh|bash|cmd|cmd\.exe|zsh)$/i.test(file), `${platform}: ${req} must not run a shell (${file})`);
      assert.ok(Array.isArray(args));
    }
  }
});

test('each system uses its own native tools', () => {
  assert.equal(parse('services', 'linux').command.invocation.file, 'systemctl');
  assert.equal(parse('services', 'darwin').command.invocation.file, 'launchctl');
  assert.equal(parse('services', 'win32').command.invocation.file, 'powershell.exe');
  assert.equal(parse('info', 'darwin').command.invocation.file, 'sw_vers');
  assert.deepEqual(parse('restart com.example.app', 'darwin', 501).command.invocation.args, ['kickstart', '-k', 'gui/501/com.example.app']);
  assert.deepEqual(parse('stop sshd', 'linux').command.invocation.args, ['--user', 'stop', 'sshd']);
});

test('on Windows a value reaches PowerShell through the environment, never inside the script text', () => {
  const evil = 'x"; Remove-Item C:\\ -Recurse #';
  const p = parse('permissions ' + evil, 'win32');
  assert.equal(p.ok, true);
  assert.equal(p.command.invocation.env.OSAI_ARG, evil);
  assert.ok(!p.command.invocation.args.join(' ').includes('Remove-Item'));
  const s = parse('service Spooler', 'win32');
  assert.equal(s.command.invocation.env.OSAI_ARG, 'Spooler');
});

test('names, ids and paths are validated; nothing odd gets through', () => {
  for (const bad of ['service ssh d', 'service $(reboot)', 'service a;b', 'service ' + 'a'.repeat(200), 'stop `id`', 'restart a|b', 'kill abc', 'kill -9', 'kill 1', 'kill 0', 'kill 4242', 'kill 12 34', 'info now', 'rm -rf /', 'format c:', '']) {
    assert.equal(parse(bad, 'linux').ok, false, bad);
  }
  assert.equal(parse('permissions -rf', 'linux').ok, false, 'a path that looks like a flag');
  assert.equal(parse('permissions /tmp/a\nb', 'linux').ok, false, 'control characters');
  assert.equal(parse('permissions ' + 'a'.repeat(2000), 'linux').ok, false);
  assert.equal(parse('permissions /home/me/my file.txt', 'linux').ok, true, 'a path may contain spaces');
  assert.deepEqual(parse('permissions /tmp', 'linux').command.invocation.args, ['-ld', '--', '/tmp']);
  assert.equal(parse('info', 'freebsd').ok, false);
});

test('commands that change something are marked control; looking is inspect', () => {
  const risk = Object.fromEntries(O.listOsCommands('linux').map((c) => [c.name, c.risk]));
  assert.deepEqual(Object.entries(risk).filter(([, r]) => r === 'control').map(([n]) => n), ['start', 'stop', 'restart', 'kill']);
});

test('running reports output, failures and a missing program honestly', async () => {
  const ok = await O.runOsCommand('os info', async () => ({ status: 0, stdout: 'Linux box\n', stderr: '' }), 'linux');
  assert.deepEqual([ok.ran, ok.text], [true, 'Linux box']);
  const failed = await O.runOsCommand('stop sshd', async () => ({ status: 5, stdout: '', stderr: 'Access denied' }), 'linux');
  assert.match(failed.text, /exited with 5.*Access denied/);
  const missing = await O.runOsCommand('network', async () => ({ status: null, stdout: '', stderr: '', error: 'ip is not on this computer.' }), 'linux');
  assert.match(missing.text, /not on this computer/);
  const refused = await O.runOsCommand('os nonsense', async () => { throw new Error('must not run'); }, 'linux');
  assert.equal(refused.ran, false);
});

test('the real runner runs a real command with no shell (this machine)', async () => {
  const out = await O.realOsRunner({ file: process.execPath, args: ['-e', 'process.stdout.write(process.env.OSAI_ARG + "|" + process.argv.length)'], env: { OSAI_ARG: 'a b;c' } });
  assert.deepEqual([out.status, out.stdout], [0, 'a b;c|1']);
  const gone = await O.realOsRunner({ file: 'definitely-not-a-program-osai', args: [] });
  assert.equal(gone.status, null);
  assert.match(gone.error, /not on this computer/);
});

test('the plugin only answers text that names it, and only reports control commands as actions', async () => {
  const calls = [];
  const plugin = new P.OsCommandsPlugin({ id: 'os-commands', name: 'OS Commands', type: 'api-connection', capabilities: [] }, async (inv) => { calls.push(inv); return { status: 0, stdout: 'fine', stderr: '' }; }, 'linux');
  assert.equal(plugin.wouldAct('os restart sshd'), true);
  assert.equal(plugin.wouldAct('os: kill 999'), true);
  assert.equal(plugin.wouldAct('os services'), false, 'looking is not held');
  assert.equal(plugin.wouldAct('restart sshd'), false, 'text that does not name the plugin');
  assert.equal(await plugin.onMessage('what is the weather'), null);
  assert.equal(await plugin.onMessage('restart sshd'), null);
  assert.equal(calls.length, 0);
  assert.match(String(await plugin.onMessage('os help')), /services: /);
  assert.match(String(await plugin.onMessage('os nonsense')), /Unknown OS command/);
});
