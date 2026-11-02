/**
 * node:child_process for the phone. A phone app cannot start other programs, so every call fails the way "command
 * not found" fails (ENOENT) and the engine's own fallbacks run. Nothing is ever started.
 */
import { Buffer } from './buffer';
import { EventEmitter } from './events';
import { hostCall } from './host';

/** Say, in the app's log, which feature asked to start a program, so a missing fallback is easy to find. */
function note(cmd: string): void {
  try { hostCall('log', { level: 'warn', message: `a program was asked to start and cannot be on a phone: ${cmd}\n${(new Error().stack || '').split('\n').slice(3, 7).join('\n')}` }); } catch { /* never break the caller */ }
}

function missing(cmd: string): Error & { code: string } {
  const e = new Error(`spawn ${cmd} ENOENT: programs cannot be started on a phone`) as any;
  e.code = 'ENOENT'; e.errno = -2; e.syscall = `spawn ${cmd}`; e.path = cmd;
  return e;
}
class Child extends EventEmitter {
  /**
   * A program that is not there fails with an 'error' event. Node would throw if nobody listens for it; on a phone a
   * missing program is the normal case, so with no listener it ends like a shell's "command not found" (exit 127).
   */
  fail(e: Error): void {
    if (this.listenerCount('error') > 0) { this.emit('error', e); return; }
    this.exitCode = 127;
    this.emit('exit', 127, null);
    this.emit('close', 127, null);
  }
  pid: number | undefined = undefined; killed = false; exitCode: number | null = null;
  stdout = new EventEmitter(); stderr = new EventEmitter();
  stdin = { write: () => false, end: () => {}, on: () => {} };
  kill(): boolean { return false; }
  unref(): void {}
  ref(): void {}
}
export function spawn(cmd: string, _args?: unknown, _opts?: unknown): Child {
  note(cmd);
  const c = new Child();
  setTimeout(() => { c.fail(missing(cmd)); }, 0);
  return c;
}
export function fork(cmd: string): Child { return spawn(cmd); }
export function exec(cmd: string, a?: any, b?: any): Child {
  note(cmd);
  const cb = typeof a === 'function' ? a : b;
  const c = new Child();
  setTimeout(() => { const e = missing(cmd.split(' ')[0]); if (cb) cb(e, '', ''); else c.fail(e); }, 0);
  return c;
}
export function execFile(file: string, a?: any, b?: any, d?: any): Child {
  note(file);
  const cb = [a, b, d].find((x) => typeof x === 'function');
  const c = new Child();
  setTimeout(() => { const e = missing(file); if (cb) cb(e, '', ''); else c.fail(e); }, 0);
  return c;
}
export function spawnSync(cmd: string): { error: Error; status: null; signal: null; stdout: Buffer; stderr: Buffer; output: null; pid: 0 } {
  return { error: missing(cmd), status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: null, pid: 0 };
}
export function execSync(cmd: string): never { throw missing(cmd.split(' ')[0]); }
export function execFileSync(file: string): never { throw missing(file); }
export default { spawn, fork, exec, execFile, spawnSync, execSync, execFileSync };
