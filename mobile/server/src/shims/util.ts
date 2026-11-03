/** node:util for the phone: the parts the engine uses, written for this project. */
export function promisify<T extends (...args: any[]) => any>(fn: T): (...args: any[]) => Promise<any> {
  const custom = (fn as any)[Symbol.for('nodejs.util.promisify.custom')];
  if (typeof custom === 'function') return custom;
  return (...args: any[]) => new Promise((resolve, reject) => {
    fn(...args, (err: unknown, ...values: unknown[]) => (err ? reject(err) : resolve(values.length > 1 ? values : values[0])));
  });
}
(promisify as any).custom = Symbol.for('nodejs.util.promisify.custom');

export function inspect(value: unknown, _opts?: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Error ? `${v.name}: ${v.message}` : v), 2) ?? String(value); } catch { return String(value); }
}

export function format(fmt: unknown, ...args: unknown[]): string {
  if (typeof fmt === 'string' && args.length === 0) return fmt; // one argument is returned as written, %% and all
  if (typeof fmt !== 'string') return [fmt, ...args].map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  let i = 0;
  const out = fmt.replace(/%[sdifjoO%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s': return String(a);
      case '%d': case '%i': return String(Math.trunc(Number(a)));
      case '%f': return String(Number(a));
      case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
      default: return inspect(a);
    }
  });
  return [out, ...args.slice(i).map((a) => (typeof a === 'string' ? a : inspect(a)))].join(' ');
}

export function inherits(ctor: any, superCtor: any): void {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  Object.setPrototypeOf(ctor, superCtor);
}
export function deprecate<T extends Function>(fn: T, _msg?: string): T { return fn; }
export const TextEncoder = (globalThis as any).TextEncoder;
export const TextDecoder = (globalThis as any).TextDecoder;
export const types = {
  isPromise: (v: unknown): boolean => !!v && typeof (v as any).then === 'function',
  isDate: (v: unknown): boolean => v instanceof Date,
  isRegExp: (v: unknown): boolean => v instanceof RegExp,
  isTypedArray: (v: unknown): boolean => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown): boolean => v instanceof Uint8Array,
};
export function isDeepStrictEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export default { promisify, inspect, format, inherits, deprecate, TextEncoder, TextDecoder, types, isDeepStrictEqual };
