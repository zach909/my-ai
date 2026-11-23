/**
 * node:fs for the phone. The files are real and persistent: every call goes through the host (host.ts) to the app's
 * own private storage, so chats, memory, settings and everything else the engine saves survive restarts exactly as
 * they do on a computer. Written for this project; no library.
 *
 * Paths are POSIX. The app maps /phone/home and /phone/tmp (and the working directory) to private storage and
 * /phone/app to the read-only files packaged with the app.
 */
import { Buffer } from './buffer';
import { EventEmitter } from './events';
import { hostCall, makeError } from './host';
import * as pathMod from './path';

type Encoding = string | null | undefined;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const optEncoding = (o: any): Encoding => (typeof o === 'string' ? o : o?.encoding);
const abs = (p: any): string => pathMod.resolve(String(p instanceof URL ? decodeURIComponent(p.pathname) : p));
const toBytes = (data: any, encoding?: string): Uint8Array => (typeof data === 'string' ? Buffer.from(data, (encoding as any) ?? 'utf8') : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data)));

export class Stats {
  isFile() { return this.kind === 'file'; }
  isDirectory() { return this.kind === 'dir'; }
  isSymbolicLink() { return this.kind === 'link'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
  size: number; mode: number; mtimeMs: number; ctimeMs: number; atimeMs: number; birthtimeMs: number;
  mtime: Date; ctime: Date; atime: Date; birthtime: Date; uid = 0; gid = 0; nlink = 1; ino = 0; dev = 0;
  constructor(private kind: string, v: any) {
    this.size = v.size ?? 0; this.mode = v.mode ?? (kind === 'dir' ? 0o40755 : 0o100644);
    this.mtimeMs = v.mtimeMs ?? 0; this.ctimeMs = this.mtimeMs; this.atimeMs = this.mtimeMs; this.birthtimeMs = this.mtimeMs;
    this.mtime = new Date(this.mtimeMs); this.ctime = this.mtime; this.atime = this.mtime; this.birthtime = this.mtime;
  }
}

export class Dirent {
  constructor(public name: string, private kind: string, public path: string) {}
  isFile() { return this.kind === 'file'; }
  isDirectory() { return this.kind === 'dir'; }
  isSymbolicLink() { return this.kind === 'link'; }
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024 };

function stat(p: string, syscall: string, throwIfMissing: boolean): Stats | undefined {
  try { const v = hostCall('fs.stat', { path: p }); return new Stats(v.kind, v); }
  catch (e: any) { if (!throwIfMissing && e.code === 'ENOENT') return undefined; throw e; }
}

export function existsSync(p: any): boolean { try { return stat(abs(p), 'stat', false) !== undefined; } catch { return false; } }
export function statSync(p: any, o?: any): Stats | undefined { return stat(abs(p), 'stat', !(o && o.throwIfNoEntry === false)); }
export const lstatSync = statSync;
export function accessSync(p: any, _mode?: number): void { stat(abs(p), 'access', true); }

export function readFileSync(p: any, o?: any): any {
  const e = optEncoding(o);
  const data = typeof p === 'number' ? readFd(p) : Buffer.from(hostCall('fs.read', { path: abs(p) }), 'base64');
  return e ? data.toString(e) : data;
}
export function writeFileSync(p: any, data: any, o?: any): void {
  if (typeof p === 'number') { writeSync(p, data); return; }
  hostCall('fs.write', { path: abs(p), data: b64(toBytes(data, optEncoding(o) ?? undefined)), append: o && typeof o === 'object' && o.flag === 'a' });
}
export function appendFileSync(p: any, data: any, o?: any): void {
  hostCall('fs.write', { path: abs(p), data: b64(toBytes(data, optEncoding(o) ?? undefined)), append: true });
}
export function mkdirSync(p: any, o?: any): string | undefined {
  const recursive = typeof o === 'object' && o !== null && !!o.recursive;
  const path = abs(p);
  const existed = existsSync(path);
  hostCall('fs.mkdir', { path, recursive });
  return recursive && !existed ? path : undefined;
}
export function mkdtempSync(prefix: string): string { return hostCall('fs.mkdtemp', { prefix: abs(prefix) }); }
export function readdirSync(p: any, o?: any): any[] {
  const entries: Array<{ name: string; kind: string }> = hostCall('fs.readdir', { path: abs(p) });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return o && typeof o === 'object' && o.withFileTypes ? entries.map((e) => new Dirent(e.name, e.kind, abs(p))) : entries.map((e) => e.name);
}
export function unlinkSync(p: any): void { hostCall('fs.rm', { path: abs(p), recursive: false, force: false, filesOnly: true }); }
export function rmdirSync(p: any, o?: any): void { hostCall('fs.rm', { path: abs(p), recursive: !!(o && o.recursive), force: false, dirsOnly: true }); }
export function rmSync(p: any, o?: any): void { hostCall('fs.rm', { path: abs(p), recursive: !!(o && o.recursive), force: !!(o && o.force) }); }
export function renameSync(a: any, b: any): void { hostCall('fs.rename', { from: abs(a), to: abs(b) }); }
export function copyFileSync(a: any, b: any, mode?: number): void {
  if (mode === constants.COPYFILE_EXCL && existsSync(b)) throw makeError('EEXIST', undefined, 'copyfile', abs(b));
  hostCall('fs.copy', { from: abs(a), to: abs(b) });
}
export function realpathSync(p: any): string { return hostCall('fs.realpath', { path: abs(p) }); }
(realpathSync as any).native = realpathSync;
export function chmodSync(_p: any, _m: any): void { /* the app's storage has no modes to set */ }
export function utimesSync(_p: any, _a: any, _m: any): void { /* not tracked */ }
export function readlinkSync(p: any): string { throw makeError('EINVAL', undefined, 'readlink', abs(p)); }
export function symlinkSync(): void { throw makeError('EPERM', undefined, 'symlink'); }
export function truncateSync(p: any, len = 0): void { const d = readFileSync(p) as Buffer; writeFileSync(p, d.subarray(0, len)); }

// ---- file descriptors, over the same host calls ----
interface Fd { path: string; flags: string; pos: number }
const fds = new Map<number, Fd>();
let nextFd = 3;
export function openSync(p: any, flags: any = 'r'): number {
  const path = abs(p);
  const f = String(flags);
  if (f[0] === 'r') stat(path, 'open', true);
  else if (f.includes('x') && existsSync(path)) throw makeError('EEXIST', undefined, 'open', path);
  else if (f[0] === 'w' || !existsSync(path)) hostCall('fs.write', { path, data: '', append: false });
  const fd = nextFd++;
  fds.set(fd, { path, flags: f, pos: f[0] === 'a' ? (statSync(path)!.size) : 0 });
  return fd;
}
export function closeSync(fd: number): void { fds.delete(fd); }
export function fsyncSync(_fd: number): void { /* every write already went to storage */ }
function readFd(fd: number): Buffer { const d = fds.get(fd); if (!d) throw makeError('EINVAL', 'bad file descriptor', 'read'); return Buffer.from(hostCall('fs.read', { path: d.path }), 'base64'); }
export function writeSync(fd: number, data: any, a?: any, b?: any, c?: any): number {
  const d = fds.get(fd);
  if (!d) throw makeError('EINVAL', 'bad file descriptor', 'write');
  let bytes = typeof data === 'string' ? toBytes(data, typeof a === 'string' ? a : typeof c === 'string' ? c : undefined) : toBytes(data);
  if (typeof data !== 'string' && typeof a === 'number') bytes = bytes.subarray(a, typeof b === 'number' ? a + b : undefined);
  const position = typeof data !== 'string' ? c : typeof a === 'number' ? a : undefined;
  if (d.flags[0] === 'a') hostCall('fs.write', { path: d.path, data: b64(bytes), append: true });
  else hostCall('fs.writeAt', { path: d.path, data: b64(bytes), pos: typeof position === 'number' ? position : d.pos });
  if (typeof position !== 'number') d.pos += bytes.length;
  return bytes.length;
}
export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null): number {
  const d = fds.get(fd);
  if (!d) throw makeError('EINVAL', 'bad file descriptor', 'read');
  const at = position ?? d.pos;
  const chunk = Buffer.from(hostCall('fs.readRange', { path: d.path, pos: at, len: length }), 'base64');
  buffer.set(chunk, offset);
  if (position === null) d.pos += chunk.length;
  return chunk.length;
}

// ---- streams (just what the server uses: read a file out in pieces) ----
export class ReadStream extends EventEmitter {
  destroyed = false;
  constructor(private path: string, private start = 0, private end = Infinity, private chunk = 65536) {
    super();
    setTimeout(() => this._run(), 0);
  }
  private _run(): void {
    try {
      let pos = this.start;
      for (;;) {
        if (this.destroyed || pos > this.end) break;
        const len = Math.min(this.chunk, this.end - pos + 1);
        const buf = Buffer.from(hostCall('fs.readRange', { path: this.path, pos, len }), 'base64');
        if (buf.length === 0) break;
        pos += buf.length;
        this.emit('data', buf);
        if (buf.length < len) break;
      }
      this.emit('end'); this.emit('close');
    } catch (e) { this.emit('error', e); }
  }
  pipe<T extends { write(c: any): any; end(): any }>(dest: T): T {
    this.on('data', (c: any) => dest.write(c));
    this.on('end', () => dest.end());
    return dest;
  }
  destroy(): this { this.destroyed = true; return this; }
  setEncoding(): this { return this; }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    let pos = this.start;
    for (;;) {
      const len = Math.min(this.chunk, this.end - pos + 1);
      if (len <= 0) return;
      const buf = Buffer.from(hostCall('fs.readRange', { path: this.path, pos, len }), 'base64');
      if (buf.length === 0) return;
      pos += buf.length;
      yield buf;
      if (buf.length < len) return;
    }
  }
}
export function createReadStream(p: any, o?: any): ReadStream {
  const path = abs(p);
  stat(path, 'open', true);
  return new ReadStream(path, o?.start ?? 0, o?.end ?? Infinity, o?.highWaterMark ?? 65536);
}

// ---- promises and callbacks, derived from the sync forms ----
const wrap = <A extends any[], R>(fn: (...a: A) => R) => (...args: A): Promise<R> => new Promise((res, rej) => { try { res(fn(...args)); } catch (e) { rej(e); } });
export const promises = {
  readFile: wrap(readFileSync), writeFile: wrap(writeFileSync), appendFile: wrap(appendFileSync), mkdir: wrap(mkdirSync),
  readdir: wrap(readdirSync), stat: wrap(statSync), lstat: wrap(lstatSync), rm: wrap(rmSync), rmdir: wrap(rmdirSync),
  unlink: wrap(unlinkSync), rename: wrap(renameSync), copyFile: wrap(copyFileSync), access: wrap(accessSync),
  realpath: wrap(realpathSync), mkdtemp: wrap(mkdtempSync), chmod: wrap(chmodSync), truncate: wrap(truncateSync),
  constants,
};
function cb<A extends any[], R>(fn: (...a: A) => R) {
  return (...args: any[]): void => {
    const done = args.pop();
    if (typeof done !== 'function') throw new TypeError('The "cb" argument must be of type function');
    let r: R;
    try { r = fn(...(args as A)); } catch (e) { setTimeout(() => done(e), 0); return; }
    setTimeout(() => done(null, r), 0);
  };
}
export const readFile = cb(readFileSync), writeFile = cb(writeFileSync), appendFile = cb(appendFileSync), mkdir = cb(mkdirSync),
  readdir = cb(readdirSync), stat_ = cb(statSync), unlink = cb(unlinkSync), rename = cb(renameSync), rm = cb(rmSync),
  copyFile = cb(copyFileSync), access = cb(accessSync), rmdir = cb(rmdirSync);
export { stat_ as stat };
export function exists(p: any, done: (b: boolean) => void): void { setTimeout(() => done(existsSync(p)), 0); }
export function watch(): { close(): void; on(): any } { return { close() {}, on() { return this; } }; }
export function watchFile(): void {}
export function unwatchFile(): void {}

export default {
  Stats, Dirent, constants, existsSync, statSync, lstatSync, accessSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync,
  readdirSync, unlinkSync, rmdirSync, rmSync, renameSync, copyFileSync, realpathSync, chmodSync, utimesSync, readlinkSync, symlinkSync,
  truncateSync, openSync, closeSync, fsyncSync, writeSync, readSync, createReadStream, ReadStream, promises, readFile, writeFile, appendFile,
  mkdir, readdir, stat: stat_, unlink, rename, rm, copyFile, access, rmdir, exists, watch, watchFile, unwatchFile,
};
