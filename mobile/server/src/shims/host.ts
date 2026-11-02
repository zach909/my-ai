/**
 * The one door from the engine's JavaScript to the phone itself.
 *
 * `NativeHost.call(op, argsJson)` is a synchronous call into the app (Android: a @JavascriptInterface on the
 * WebView, see PhoneServer.kt; in the Node tests: a stand-in backed by a temporary folder, test/platform/phone-host.mjs).
 * It returns a JSON string `{ok:true,value}` or `{ok:false,code,message}`. Every shim that needs the phone's storage
 * or radio goes through here, so there is exactly one thing to implement on each side.
 */
export interface HostResult { ok: boolean; value?: any; code?: string; message?: string }

export function hostCall(op: string, args: Record<string, unknown> = {}): any {
  const host = (globalThis as any).NativeHost;
  if (!host || typeof host.call !== 'function') throw makeError('ENOSYS', 'function not implemented: the phone host is not connected', op);
  const result = JSON.parse(host.call(op, JSON.stringify(args))) as HostResult;
  if (!result.ok) throw makeError(result.code || 'EIO', result.message || 'host error', op, (args as any).path);
  return result.value;
}

const ERRNO: Record<string, number> = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EACCES: -13, ENOTEMPTY: -39, EINVAL: -22, EIO: -5, ENOSYS: -38, EPERM: -1 };
const TEXT: Record<string, string> = {
  ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory',
  EACCES: 'permission denied', ENOTEMPTY: 'directory not empty', EINVAL: 'invalid argument', EIO: 'i/o error', ENOSYS: 'function not implemented', EPERM: 'operation not permitted',
};

/** An error shaped like Node's (`code`, `errno`, `syscall`, `path`), because callers branch on `err.code`. */
export function makeError(code: string, message: string | undefined, syscall: string, path?: string): Error & { code: string; errno: number; syscall: string; path?: string } {
  const e = new Error(`${code}: ${TEXT[code] ?? message ?? 'error'}, ${syscall.replace(/^fs\./, '')}${path ? ` '${path}'` : ''}`) as any;
  e.code = code; e.errno = ERRNO[code] ?? -1; e.syscall = syscall.replace(/^fs\./, '');
  if (path) e.path = path;
  return e;
}

/** An error for something a phone cannot do (a terminal, a child process, a sandbox): says so in plain words. */
export function notOnPhone(what: string): Error & { code: string } {
  const e = new Error(`${what} is not available on a phone`) as any;
  e.code = 'ENOTSUP';
  return e;
}
