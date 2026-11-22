/** node:url for the phone: the WebView already has URL and URLSearchParams; add the file-URL helpers. */
export const URL = (globalThis as any).URL as typeof globalThis.URL;
export const URLSearchParams = (globalThis as any).URLSearchParams as typeof globalThis.URLSearchParams;

export function fileURLToPath(u: string | InstanceType<typeof URL>): string {
  const url = typeof u === 'string' ? new URL(u) : u;
  if (url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(p: string): InstanceType<typeof URL> {
  const abs = p.startsWith('/') ? p : `${(globalThis as any).process.cwd()}/${p}`;
  return new URL('file://' + abs.split('/').map(encodeURIComponent).join('/'));
}

export function parse(u: string): { href: string; protocol: string; host: string; hostname: string; port: string; pathname: string; search: string; hash: string; query: string } {
  const url = new URL(u, 'http://localhost');
  return { href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, query: url.search.replace(/^\?/, '') };
}

export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, parse };
