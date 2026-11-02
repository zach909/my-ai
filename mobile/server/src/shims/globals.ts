/**
 * The globals the engine expects from Node, provided for the phone: `process`, `Buffer`, `global`, `setImmediate`.
 * Imported first by the bundle entry, so every module sees them. (The WebView already has timers, fetch, URL,
 * TextEncoder/TextDecoder, crypto.getRandomValues, structuredClone and performance.)
 */
import { Buffer } from './buffer';
import { EventEmitter } from './events';
import { hostCall } from './host';

const g = globalThis as any;
g.global = g;
g.Buffer = Buffer;

const startedAt = Date.now();
const log = (level: string) => (chunk: unknown): boolean => { try { hostCall('log', { level, message: String(chunk) }); } catch { /* logging must never break the engine */ } return true; };

const proc: any = new EventEmitter();
Object.assign(proc, {
  env: { NEUROCLAW_PHONE: '1', HOME: '/phone/home', NEUROCLAW_AUTO_UPDATE: '0', NEUROCLAW_WEB_HOST: '127.0.0.1', ...(g.NEUROCLAW_ENV || {}) },
  argv: ['phone'], argv0: 'phone', execArgv: [], execPath: '/phone/engine',
  platform: 'android', arch: 'arm64', pid: 1, ppid: 0, title: 'neuroclaw', version: 'v22.0.0',
  versions: { node: '22.0.0', v8: 'webview' }, release: { name: 'node' }, exitCode: undefined,
  cwd: () => '/phone/home', chdir: () => {}, umask: () => 0o22, getuid: () => 0, getgid: () => 0, geteuid: () => 0,
  uptime: () => (Date.now() - startedAt) / 1000,
  nextTick: (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign((prev?: [number, number]) => {
    const t = performance.now(); const s = Math.floor(t / 1000); const n = Math.floor((t % 1000) * 1e6);
    return prev ? [s - prev[0], n - prev[1]] : [s, n];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  emitWarning: () => {}, kill: () => true, abort: () => { throw new Error('process.abort'); },
  exit: (code?: number) => { throw new Error(`process.exit(${code ?? 0}) was called`); },
  stdout: { write: log('info'), isTTY: false, columns: 80 }, stderr: { write: log('error'), isTTY: false },
  stdin: { isTTY: false, on() {}, setEncoding() {}, resume() {}, pause() {} },
});
g.process = proc;

// The console goes to the app's log, so a failure on the phone can be read with the phone's own tools.
const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
g.console = { log: (...a: unknown[]) => log('info')(fmt(a)), info: (...a: unknown[]) => log('info')(fmt(a)), debug: () => {}, warn: (...a: unknown[]) => log('warn')(fmt(a)), error: (...a: unknown[]) => log('error')(fmt(a)), trace: () => {}, dir: () => {}, time: () => {}, timeEnd: () => {} };

if (typeof g.setImmediate === 'undefined') {
  g.setImmediate = (fn: (...a: any[]) => void, ...args: any[]) => setTimeout(() => fn(...args), 0);
  g.clearImmediate = (id: number) => clearTimeout(id);
}
