/**
 * The osai command: loopback only, one request to the engine, honest exit codes, and the installers
 * put it on every system. Run: node --test test/platform/osai.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const osai = await import(pathToFileURL(path.join(root, 'scripts', 'osai.mjs')).href);

const sink = () => { const lines = []; return { lines, log: (x) => lines.push(['out', x]), error: (x) => lines.push(['err', x]) }; };
const reply = (status, body) => async () => ({ ok: status < 400, status, statusText: 'x', json: async () => body });

test('the engine address must be this computer', () => {
  assert.equal(osai.engineUrl({}), 'http://127.0.0.1:7861');
  assert.equal(osai.engineUrl({ NEUROCLAW_WEB_PORT: '9000' }), 'http://127.0.0.1:9000');
  assert.equal(osai.engineUrl({ OSAI_URL: 'http://localhost:1234/' }), 'http://localhost:1234');
  assert.equal(osai.engineUrl({ OSAI_URL: 'http://[::1]:5' }), 'http://[::1]:5');
  for (const bad of ['http://example.com:7861', 'https://127.0.0.1:7861', 'http://192.168.1.5:7861', 'http://127.0.0.1.evil.com', 'nonsense']) {
    assert.throws(() => osai.engineUrl({ OSAI_URL: bad }), /must be on this computer|not a URL/, bad);
  }
});

test('requests are cleaned and bounded', () => {
  assert.equal(osai.cleanRequest(['os', 'services\x1b[2J']), 'os services  [2J'.replace('  ', ' '));
  assert.throws(() => osai.cleanRequest([]), /say what you want/);
  assert.throws(() => osai.cleanRequest(['x'.repeat(601)]), /too long/);
});

test('a layer request is posted to the engine and the exit code says what happened', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push([url, init.method, JSON.parse(init.body ?? 'null')]); return { ok: true, status: 200, json: async () => ({ status: 'ran', text: 'fine' }) }; };
  const o = sink();
  assert.equal(await osai.main(['os', 'services'], {}, f, o), 0);
  assert.deepEqual(seen[0], ['http://127.0.0.1:7861/api/ai-os/layer', 'POST', { layer: 'os', request: 'services' }]);
  assert.deepEqual(o.lines, [['out', 'fine']]);
  await osai.main(['kernel', 'disks'], {}, f, sink());
  assert.equal(seen[1][2].layer, 'os', 'kernel is the old name for os');
  assert.equal(await osai.main(['os', 'restart', 'x'], {}, reply(200, { status: 'held', text: 'waiting' }), sink()), 3);
  assert.equal(await osai.main(['gui', 'click'], {}, reply(200, { status: 'refused', text: 'no' }), sink()), 1);
  assert.equal(await osai.main(['gui', 'windows'], {}, reply(200, { status: 'unavailable', text: 'no' }), sink()), 1);
});

test('unknown layers, empty requests and a missing engine are reported, not hidden', async () => {
  const o = sink();
  assert.equal(await osai.main(['email', 'hi'], {}, reply(200, {}), o), 1);
  assert.match(o.lines[0][1], /unknown layer "email"/);
  assert.equal(await osai.main(['os'], {}, reply(200, {}), sink()), 1);
  const down = sink();
  assert.equal(await osai.main(['app', 'ls'], {}, async () => { throw new TypeError('fetch failed'); }, down), 2);
  assert.match(down.lines[0][1], /cannot reach the NeuroClaw engine/);
  assert.equal(await osai.main(['app', 'ls'], { OSAI_URL: 'http://example.com' }, reply(200, {}), sink()), 1);
});

test('status lists the layers with what each uses here', async () => {
  const o = sink();
  const body = { layers: [{ id: 'os', label: 'OS commands (native)', available: true, native: 'PowerShell' }, { id: 'gui', label: 'Graphical button clicker', available: false, reason: 'no' }] };
  assert.equal(await osai.main(['status'], {}, reply(200, body), o), 0);
  assert.match(o.lines[0][1], /ok\s+os\s+OS commands \(native\) \(PowerShell\)/);
  assert.match(o.lines[1][1], /no\s+gui/);
});

test('end to end: the command talks to a real HTTP server on loopback', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push([req.method, req.url, b, req.headers.authorization]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ran', text: 'hello from the engine' })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // Asynchronous on purpose: a synchronous spawn would block this process, which is also running the server.
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'osai.mjs'), 'app', 'echo', 'hi'], { env: { ...process.env, NEUROCLAW_WEB_PORT: String(port), NEUROCLAW_WEB_PASSWORD: 'pw' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  srv.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'hello from the engine');
  assert.deepEqual([got[0][0], got[0][1], JSON.parse(got[0][2])], ['POST', '/api/ai-os/layer', { layer: 'app', request: 'echo hi' }]);
  assert.equal(got[0][3], 'Basic ' + Buffer.from(':pw').toString('base64'));
});

test('every installer puts osai on the system natively', async () => {
  const W = await import(pathToFileURL(path.join(root, 'scripts', 'release', 'package-windows.mjs')).href);
  // Windows: a batch file next to the bundled Node, on the user's PATH (not the machine's), removed on uninstall.
  assert.match(W.OSAI_CMD, /runtime\\node\.exe/); assert.match(W.OSAI_CMD, /app\\scripts\\osai\.mjs/); assert.match(W.OSAI_CMD, /\r\n/);
  assert.match(W.INSTALL_PS1, /GetEnvironmentVariable\('Path', 'User'\)/); assert.match(W.INSTALL_PS1, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/);
  assert.match(W.UNINSTALL_PS1, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/);
  assert.doesNotMatch(W.INSTALL_PS1 + W.UNINSTALL_PS1, /'Machine'/);
  // Linux and macOS packages and the source installer.
  const lin = readFileSync(path.join(root, 'scripts', 'release', 'package-linux.mjs'), 'utf8');
  assert.match(lin, /'usr', 'bin', 'osai'/); assert.match(lin, /app\/scripts\/osai\.mjs/);
  const mac = readFileSync(path.join(root, 'scripts', 'release', 'package-macos.mjs'), 'utf8');
  assert.match(mac, /'bin', 'osai'/); assert.match(mac, /app\/scripts\/osai\.mjs/);
  const sh = readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  assert.match(sh, /install_osai\n\s+install_kos/);
});
