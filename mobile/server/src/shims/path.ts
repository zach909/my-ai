/** node:path (POSIX rules) for the phone, written for this project. The phone's paths are all POSIX. */
export const sep = '/';
export const delimiter = ':';

function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(p);
  }
  return out;
}

export function normalize(p: string): string {
  if (p === '') return '.';
  const absolute = p.startsWith('/');
  const trailing = p.endsWith('/');
  let out = normalizeParts(p.split('/'), absolute).join('/');
  if (!out && !absolute) out = '.';
  if (out && trailing) out += '/';
  return (absolute ? '/' : '') + out;
}

export function isAbsolute(p: string): boolean { return p.startsWith('/'); }

export function join(...parts: string[]): string {
  const joined = parts.filter((x) => x !== '').join('/');
  return joined === '' ? '.' : normalize(joined);
}

export function resolve(...parts: string[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= -1 && !resolved.startsWith('/'); i--) {
    const seg = i >= 0 ? parts[i] : (globalThis as any).process.cwd();
    if (!seg) continue;
    resolved = resolved ? `${seg}/${resolved}` : seg;
  }
  const out = normalizeParts(resolved.split('/'), true).join('/');
  return '/' + out;
}

/** Node's own algorithm, so odd inputs such as '/a//b' give the same answer. */
export function dirname(p: string): string {
  if (p.length === 0) return '.';
  const hasRoot = p.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === 47) {
      if (!matchedSlash) { end = i; break; }
    } else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return p.slice(0, end);
}

export function basename(p: string, ext?: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === '/') end--;
  const trimmed = p.slice(0, end);
  let base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  if (base === '..') return '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export function parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const root = p.startsWith('/') ? '/' : '';
  const base = basename(p);
  const ext = extname(p);
  const d = dirname(p);
  return { root, dir: d === '.' && !p.includes('/') ? '' : d, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(o: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
  const dir = o.dir || o.root || '';
  const base = o.base || `${o.name ?? ''}${o.ext ?? ''}`;
  return dir ? (dir === o.root ? dir + base : `${dir}/${base}`) : base;
}

export function toNamespacedPath(p: string): string { return p; }

const posix = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath } as any;
posix.posix = posix;
posix.win32 = posix; // the phone has no Windows paths; code that branches on win32 only reads these

export { posix };
export const win32 = posix;
export default posix;
