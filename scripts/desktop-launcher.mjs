#!/usr/bin/env node
/**
 * The desktop launcher: what runs when someone opens NeuroClaw from the Start
 * menu, the application menu or the Dock. No terminal involved, no browser needed,
 * no network port opened.
 *
 *   1. Make the per-user writable copy of the app current (scripts/release/app-home.mjs).
 *   2. Start the engine in "embedded" mode (dist/interface/main.js embedded): it
 *      serves the app's pages and API through a pipe instead of a port.
 *   3. Open the app's own window: the native window program next to this runtime
 *      (native/host: it shows the system's WebKitGTK on Linux; the macOS app is its own
 *      window and runs this with --embedded). Windows has no native window yet and still
 *      uses Edge's or Chrome's app window over a loopback server (docs/PLATFORMS.md). The
 *      window and the engine talk through this launcher, one line per message
 *      (interface/platform/embedded-transport.ts).
 *   4. When the window is closed the engine is stopped.
 *
 * It asks for no privileges, installs no service and touches nothing outside the
 * app's own folders (~/.neuroclaw and the per-user app copy). Starting the engine at
 * every sign-in is a separate opt-in, AI OS mode (scripts/ai-os.mjs), which runs this
 * with --no-window and keeps a loopback web server for phones and other devices; if that
 * server is already running the window uses it instead of starting a second engine.
 *
 * Browsers are optional, never required: `--browser` (or NEUROCLAW_WINDOW=browser) shows
 * the same pages in a Chromium-based browser's app window over the loopback server, as
 * earlier versions always did.
 *
 * Flags: --embedded (no window of its own: the parent process is the window and speaks
 *        the line protocol on this process's stdin/stdout, used by the macOS app),
 *        --no-window (start/attach the web server and print "READY <url>"),
 *        --browser, --stop (stop what this launcher started), --port <n>, --help.
 * Node built-ins only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 7861;

/** Where the per-user app copy lives. */
export function appHomeDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'NeuroClaw', 'app');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'NeuroClaw', 'app');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'neuroclaw', 'app');
}

/** Browsers that can show a page as an app window (no tabs, no address bar), in order of preference. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    return pf.flatMap((root) => [
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]);
  }
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
}

function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

export function findBrowser(platform = process.platform, env = process.env, exists = existsSync, which = (n) => onPath(n, env)) {
  // NEUROCLAW_BROWSER names a Chromium-based browser to use instead of searching.
  if (env.NEUROCLAW_BROWSER && exists(env.NEUROCLAW_BROWSER)) return env.NEUROCLAW_BROWSER;
  for (const c of browserCandidates(platform, env)) {
    if (path.isAbsolute(c)) { if (exists(c)) return c; }
    else { const p = which(c); if (p) return p; }
  }
  return null;
}

/** The command line that opens `url` as an app window with its own profile, so closing it ends the process. */
export function windowCommand(browser, url, profileDir) {
  return { cmd: browser, args: [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,800'] };
}

async function probe(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return 'other';
    const j = await r.json().catch(() => null);
    return j && j.running === true && j.subsystems ? 'neuroclaw' : 'other';
  } catch { return 'none'; }
}

async function freePort(start) {
  const { createServer } = await import('node:net');
  for (let p = start; p < start + 50; p++) {
    const ok = await new Promise((res) => { const s = createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error(`no free port from ${start}`);
}

function log(...a) { console.error('[neuroclaw]', ...a); }

function failurePage(reason, logFile) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NeuroClaw could not start</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#110c0e;color:#f8ede9;font-family:ui-rounded,system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:34rem;padding:28px;border:1px solid rgba(255,228,218,.2);border-radius:32px;background:rgba(255,240,232,.08)}code{overflow-wrap:anywhere;color:#efd0c8}</style><main><h1 style="font-size:1.3rem">NeuroClaw could not start</h1><p>${esc(reason)}</p><p>The details are in <code>${esc(logFile)}</code>. Close this window and open NeuroClaw again; if it keeps happening, send that file with your report.</p></main>`;
}

/** Where the native window program lives: next to the bundled Node runtime (and NEUROCLAW_WINDOW_HOST overrides it). */
export function windowHostPath(platform = process.platform, execPath = process.execPath, env = process.env, exists = existsSync) {
  if (env.NEUROCLAW_WINDOW_HOST) return exists(env.NEUROCLAW_WINDOW_HOST) ? env.NEUROCLAW_WINDOW_HOST : null;
  const exe = platform === 'win32' ? 'neuroclaw-window.exe' : 'neuroclaw-window';
  for (const dir of [path.dirname(execPath), path.join(HERE, '..', '..', 'runtime'), path.join(HERE, '..', 'native', 'target')]) {
    const p = path.join(dir, exe);
    if (exists(p)) return p;
  }
  return null;
}

/** Call `onLine` for every complete line of `stream`. */
function eachLine(stream, onLine) {
  stream.setEncoding('utf8');
  let rest = '';
  stream.on('data', (chunk) => {
    rest += chunk;
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) { onLine(rest.slice(0, i)); rest = rest.slice(i + 1); }
  });
}

const b64 = (t) => Buffer.from(String(t)).toString('base64') || '-';
const TO_ENGINE = /^Q \d+ /;
const TO_WINDOW = /^(R \d+ |E \d+ |READY$|FAILED )/;

/** Best-effort native message for the one case with no window to show it in (no web view on this computer). */
function tellUser(title, text) {
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:NC_TEXT, $env:NC_TITLE)`;
    spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { env: { ...process.env, NC_TEXT: text, NC_TITLE: title }, stdio: 'ignore', windowsHide: true, timeout: 120000 });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'display dialog (system attribute "NC_TEXT") with title (system attribute "NC_TITLE") buttons {"OK"} default button 1'], { env: { ...process.env, NC_TEXT: text, NC_TITLE: title }, stdio: 'ignore', timeout: 120000 });
    return;
  }
  for (const [cmd, args] of [['zenity', ['--error', `--title=${title}`, `--text=${text}`]], ['kdialog', ['--error', text, '--title', title]], ['xmessage', ['-center', `${title}: ${text}`]]]) {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 });
    if (!r.error) return;
  }
}

/**
 * Serve the window's request lines from an already running NeuroClaw web server (AI OS mode keeps one) instead of
 * starting a second engine on the same data folder.
 */
function attachBackend(port, T) {
  return async (line) => {
    const q = T.decodeRequestLine(line);
    if (!q) return `E 0 ${b64('unreadable request')}`;
    try {
      const init = { method: q.request.method, headers: q.request.headers, redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000) };
      if (!['GET', 'HEAD'].includes(q.request.method)) init.body = q.request.body;
      const r = await fetch(`http://127.0.0.1:${port}${q.request.target}`, init);
      const headers = [...r.headers].filter(([k]) => !/^(set-cookie|content-encoding|content-length|transfer-encoding|connection)$/i.test(k));
      for (const c of r.headers.getSetCookie?.() ?? []) headers.push(['Set-Cookie', c]);
      const response = T.asPageIfRedirect({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
      return T.encodeResponseLine(q.id, response);
    } catch (e) { return `E ${q.id} ${b64(e.message)}`; }
  };
}

/** The app window: the engine on a pipe, the window as a native program, this process in between. */
async function runWindow({ home, dataDir, logFile, port, hostIsParent }) {
  const T = await import(pathToFileURL(path.join(home, 'dist', 'interface', 'platform', 'embedded-transport.js')).href);
  const pidFile = path.join(dataDir, 'launcher.json');
  try {
    const old = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (old.launcherPid && old.launcherPid !== process.pid) { try { process.kill(old.launcherPid, 0); log('NeuroClaw is already open.'); return; } catch { /* stale */ } }
  } catch { /* none */ }

  let host = null;
  let hostIn; let hostOut; // where lines for the window go / where the window's lines come from
  if (hostIsParent) { hostIn = process.stdout; hostOut = process.stdin; }
  else {
    const exe = windowHostPath();
    // Windows has no native window program yet (docs/PLATFORMS.md), so it keeps showing the app in Edge's or Chrome's
    // app window over the loopback server, exactly as before. It says so.
    if (!exe && process.platform === 'win32') { log('No native window for Windows yet: opening the app in Edge or Chrome\'s app window over the loopback server.'); return 'legacy'; }
    if (!exe) return fatalWindow('This copy of NeuroClaw has no window program for this system, so it cannot open its window.', logFile);
    host = spawn(exe, ['--title', 'NeuroClaw'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
    host.on('error', (e) => fatalWindow(`The window could not be started: ${e.message}`, logFile));
    hostIn = host.stdin; hostOut = host.stdout;
    hostIn.on('error', () => { /* the window closed */ });
    host.stderr.on('data', (d) => { try { writeFileSync(logFile, d, { flag: 'a' }); } catch { /* the log is best effort */ } });
  }
  const toWindow = (line) => { if (!hostIn.destroyed) hostIn.write(`${line}\n`); };

  // An engine of our own, or the web server AI OS mode already keeps.
  let engine = null; let serveAttached = null; let stopping = false;
  if ((await probe(port)) === 'neuroclaw') { log(`using the NeuroClaw already running on port ${port}`); serveAttached = attachBackend(port, T); toWindow('READY'); }
  else {
    try { if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) rmSync(logFile); } catch { /* keep appending */ }
    const out = openSync(logFile, 'a');
    engine = spawn(process.execPath, ['dist/interface/main.js', 'embedded'], {
      cwd: home, stdio: ['pipe', 'pipe', out], windowsHide: true, env: { ...process.env, NEUROCLAW_AUTO_UPDATE: '0' },
    });
    closeSync(out);
    engine.stdin.on('error', () => { /* the engine ended */ });
    eachLine(engine.stdout, (line) => { if (TO_WINDOW.test(line)) toWindow(line); });
    engine.on('exit', (code) => { if (!stopping) { toWindow(`FAILED ${b64(`The engine stopped (exit code ${code}). Details are in ${logFile}`)}`); } });
    log(`engine started (pid ${engine.pid}), no network port`);
  }
  writeFileSync(pidFile, JSON.stringify({ launcherPid: process.pid, enginePid: engine?.pid ?? null, at: new Date().toISOString() }));

  eachLine(hostOut, (line) => {
    if (!TO_ENGINE.test(line)) return;
    if (serveAttached) serveAttached(line).then(toWindow);
    else if (engine && !engine.stdin.destroyed) engine.stdin.write(`${line}\n`);
  });

  const stopEngine = () => {
    stopping = true;
    rmSync(pidFile, { force: true });
    if (!engine || engine.exitCode !== null) return;
    try { engine.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { engine.kill(); } catch { /* gone */ } }, 8000).unref();
  };
  process.on('SIGTERM', () => { stopEngine(); setTimeout(() => process.exit(0), 300); });
  process.on('SIGINT', () => { stopEngine(); setTimeout(() => process.exit(0), 300); });
  process.on('exit', () => { rmSync(pidFile, { force: true }); try { engine?.kill(); } catch { /* gone */ } });

  // The window closing ends the session.
  const windowClosed = host ? new Promise((r) => host.on('exit', (code) => r(code))) : new Promise((r) => { hostOut.on('end', () => r(0)); hostOut.on('close', () => r(0)); });
  const code = await windowClosed;
  if (code === 3 && host) { stopEngine(); return fatalWindow('NeuroClaw needs the system web view to draw its window, and it was not found. On Linux that is WebKitGTK (package libwebkit2gtk-4.1-0 on Debian and Ubuntu). Install it from your system, then open NeuroClaw again.', logFile); }
  stopEngine();
  await new Promise((r) => (engine && engine.exitCode === null ? engine.once('exit', r) : r()));
}

function fatalWindow(reason, logFile) {
  console.error(`[neuroclaw] ${reason}`);
  try { writeFileSync(logFile, `${new Date().toISOString()} ${reason}\n`, { flag: 'a' }); } catch { /* best effort */ }
  tellUser('NeuroClaw could not open', `${reason}\n\nDetails: ${logFile}`);
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('neuroclaw [--embedded] [--no-window] [--browser] [--stop] [--port <n>]'); return; }
  const dataDir = process.env.CORONA_DATA_DIR || path.join(homedir(), '.neuroclaw');
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const pidFile = path.join(dataDir, 'launcher.json');
  if (args.includes('--stop')) {
    try { const j = JSON.parse(readFileSync(pidFile, 'utf8')); process.kill(j.launcherPid ?? j.serverPid); log('stopped', j.launcherPid ?? j.serverPid); } catch { log('nothing started by the launcher is running'); }
    rmSync(pidFile, { force: true });
    return;
  }
  const noWindow = args.includes('--no-window');
  const portArg = args.indexOf('--port');
  let port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT) || DEFAULT_PORT;

  // 1. The app copy.
  const payload = path.resolve(HERE, '..');
  const home = process.env.NEUROCLAW_APP_HOME || appHomeDir();
  const { syncAppHome } = await import(pathToFileURL(path.join(HERE, 'release', 'app-home.mjs')).href);
  const logFile = path.join(dataDir, 'logs', 'server.log');
  // Running straight from the source tree (`npm run app`: NEUROCLAW_APP_HOME is the repo itself) there is nothing to
  // copy, and copying a folder onto itself would only delete and recreate dist/.
  if (path.resolve(home) === path.resolve(payload)) log(`running from the source tree in ${home}`);
  else {
    let sync;
    try { sync = syncAppHome({ payloadDir: payload, homeDir: home }); }
    catch (e) { return fatal(`Could not prepare the app's folder (${home}): ${e.message}`, logFile, noWindow); }
    log(`app ${sync.version} ${sync.action} in ${home}`);
  }

  // The macOS app is the window: it speaks the line protocol on this process's stdin and stdout.
  if (args.includes('--embedded')) { await runWindow({ home, dataDir, logFile, port, hostIsParent: true }); return; }
  // The app's own window (the default): the engine on a pipe, no port, no browser.
  const wantsBrowser = args.includes('--browser') || process.env.NEUROCLAW_WINDOW === 'browser';
  if (!noWindow && !wantsBrowser) {
    if ((await runWindow({ home, dataDir, logFile, port, hostIsParent: false })) !== 'legacy') return;
  }

  // 2. Attach to a running server, or start one.
  let child = null;
  const state = await probe(port);
  if (state === 'other') port = await freePort(port + 1);
  if (state !== 'neuroclaw') {
    try { if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) rmSync(logFile); } catch { /* keep appending */ }
    const out = openSync(logFile, 'a');
    child = spawn(process.execPath, ['dist/interface/main.js', 'web', String(port)], {
      cwd: home, stdio: ['ignore', out, out], windowsHide: true,
      env: { ...process.env, NEUROCLAW_AUTO_UPDATE: '0', PORT: String(port) },
    });
    closeSync(out);
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    writeFileSync(pidFile, JSON.stringify({ serverPid: child.pid, port, at: new Date().toISOString() }));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && exited === null && (await probe(port)) !== 'neuroclaw') await new Promise((r) => setTimeout(r, 400));
    if ((await probe(port)) !== 'neuroclaw') {
      return fatal(exited !== null ? `The engine stopped right after starting (exit code ${exited}).` : 'The engine did not answer within 90 seconds.', logFile, noWindow);
    }
    log(`engine started on port ${port} (pid ${child.pid})`);
  } else {
    log(`using the NeuroClaw already running on port ${port}`);
  }
  const url = `http://127.0.0.1:${port}/`;
  const stopServer = () => { if (child && !process.env.NEUROCLAW_KEEP_RUNNING) { try { child.kill(); } catch { /* gone */ } rmSync(pidFile, { force: true }); } };
  process.on('SIGTERM', () => { stopServer(); process.exit(0); });
  process.on('SIGINT', () => { stopServer(); process.exit(0); });
  process.on('exit', stopServer);

  // 3. The window (browser mode: a Chromium-based browser's app window, or your default browser).
  if (noWindow) { console.log(`READY ${url}`); await new Promise(() => {}); return; }
  const browser = findBrowser();
  if (!browser) {
    openDefault(url);
    log('no Chromium-based browser found for an app window; opened your default browser. The engine keeps running; run "neuroclaw --stop" to stop it.');
    if (child) child.unref();
    process.removeAllListeners('exit');
    return;
  }
  const profile = path.join(dataDir, 'browser-profile');
  mkdirSync(profile, { recursive: true });
  const { cmd, args: cargs } = windowCommand(browser, url, profile);
  const win = spawn(cmd, cargs, { stdio: 'ignore' });
  win.on('error', (e) => log('could not open a window:', e.message));
  // 4. The window closing ends the session.
  await new Promise((r) => win.on('exit', r));
  stopServer();
}

function openDefault(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

function fatal(reason, logFile, noWindow) {
  console.error(`[neuroclaw] ${reason}`);
  if (noWindow) { console.log(`FAILED ${reason}`); process.exitCode = 1; return; }
  try {
    const page = path.join(path.dirname(logFile), 'start-failed.html');
    writeFileSync(page, failurePage(reason, logFile));
    openDefault(pathToFileURL(page).href);
  } catch { /* the console message above is all there is */ }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[neuroclaw] failed:', e); process.exit(1); });
}
