/**
 * The desktop app's connection between its own window and the engine: no network port.
 *
 * The window (a native program showing the system's web view, see native/host/) cannot reach the engine
 * over a socket and does not need to. Every request the page makes (opening a page, calling /api/...)
 * is turned into one line on a pipe, the engine runs it through the very same HTTP server a browser would
 * reach (so every route, login gate, body limit and CSRF rule still applies), and the answer comes
 * back as one line.
 *
 * The lines are plain text, one per message, space separated, with every free-text field in base64 so a
 * body of any bytes survives. An empty field is written as "-". The native side needs no JSON parser.
 *
 *   window -> engine   Q <id> <METHOD> <target> <headers> <body>
 *   engine -> window   READY
 *                      R <id> <status> <headers> <body>
 *                      E <id> <message>
 *                      FAILED <message>
 *
 * `target` is the path and query (base64). `headers` is "Name: value" lines joined by \n (base64); the
 * window sends only Content-Type and Accept. Responses use the same header format.
 *
 * What the pipe is trusted as: only the program that started this engine holds its other end, so a
 * request on it counts as coming from this machine, like a connection from 127.0.0.1.
 *
 * Node built-ins only.
 */
import { Duplex } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

export interface EmbeddedRequest { method: string; target: string; headers: Record<string, string>; body: Buffer }
export interface EmbeddedResponse { status: number; headers: Array<[string, string]>; body: Buffer }

/** Largest request line the engine will buffer, in bytes (a request body is about a third smaller). */
export const MAX_LINE_BYTES = 128 * 1024 * 1024;

const b64 = (b: Buffer | string): string => { const t = Buffer.from(b).toString('base64'); return t === '' ? '-' : t; };
const unb64 = (t: string): Buffer => (t === '-' ? Buffer.alloc(0) : Buffer.from(t, 'base64'));

export function encodeHeaders(headers: Array<[string, string]> | Record<string, string>): string {
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  return pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function decodeHeaders(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

/** One request line, the way the window writes it (used by the tests and by anything that stands in for the window). */
export function encodeRequestLine(id: number, r: EmbeddedRequest): string {
  return `Q ${id} ${r.method} ${b64(r.target)} ${b64(encodeHeaders(r.headers))} ${b64(r.body)}`;
}

/** One response line, the way the engine writes it. */
export function encodeResponseLine(id: number, r: EmbeddedResponse): string {
  return `R ${id} ${r.status} ${b64(encodeHeaders(r.headers))} ${b64(r.body)}`;
}

/** Parse a response line (the window's side; used by the tests). */
export function decodeResponseLine(line: string): { kind: 'R'; id: number; response: EmbeddedResponse } | { kind: 'E'; id: number; message: string } | { kind: 'READY' } | { kind: 'FAILED'; message: string } | null {
  const t = line.trim().split(' ');
  if (t[0] === 'READY') return { kind: 'READY' };
  if (t[0] === 'FAILED') return { kind: 'FAILED', message: unb64(t[1] ?? '-').toString('utf8') };
  if (t[0] === 'E') return { kind: 'E', id: Number(t[1]), message: unb64(t[2] ?? '-').toString('utf8') };
  if (t[0] === 'R' && t.length === 5) {
    return { kind: 'R', id: Number(t[1]), response: { status: Number(t[2]), headers: decodeHeaders(unb64(t[3]).toString('utf8')), body: unb64(t[4]) } };
  }
  return null;
}

export function decodeRequestLine(line: string): { id: number; request: EmbeddedRequest } | null {
  const t = line.trim().split(' ');
  if (t[0] !== 'Q' || t.length !== 6) return null;
  const id = Number(t[1]);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of decodeHeaders(unb64(t[4]).toString('utf8'))) headers[k] = v;
  return { id, request: { method: t[2], target: unb64(t[3]).toString('utf8'), headers, body: unb64(t[5]) } };
}

/** A connection with no network behind it: bytes written by the HTTP server are collected, bytes pushed in are what it reads. */
class PipeSocket extends Duplex {
  // Reported as loopback so the server's "is this the same machine" checks treat the app's own window as local.
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 0;
  readonly localAddress = '127.0.0.1';
  readonly localPort = 0;
  readonly encrypted = false;
  readonly chunks: Buffer[] = [];
  _read(): void { /* input is pushed once, up front */ }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void { this.chunks.push(Buffer.from(chunk)); cb(); }
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

const TOKEN = /^[A-Z]{3,10}$/;
const SAFE_TARGET = /^\/[^\s\u0000-\u001f\u007f]*$/;
const SKIPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'expect', 'upgrade']);

/** Decode `Transfer-Encoding: chunked`. Returns null if the body is not complete. */
function dechunk(raw: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf('\r\n', at);
    if (eol < 0) return null;
    const size = parseInt(raw.subarray(at, eol).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    at = eol + 2;
    if (size === 0) return Buffer.concat(parts);
    if (at + size > raw.length) return null;
    parts.push(raw.subarray(at, at + size));
    at += size + 2;
  }
}

/** Split the raw HTTP/1.1 bytes the server wrote into status, headers and body. */
export function parseHttpResponse(raw: Buffer): EmbeddedResponse {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw new Error('the server sent an incomplete response');
  const head = raw.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1]);
  if (!status) throw new Error('the server sent a response with no status');
  const headers: Array<[string, string]> = [];
  for (const line of head.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  let body = raw.subarray(end + 4);
  const chunked = headers.some(([k, v]) => k.toLowerCase() === 'transfer-encoding' && /chunked/i.test(v));
  if (chunked) {
    const whole = dechunk(body);
    if (!whole) throw new Error('the server sent an incomplete chunked response');
    body = whole;
  }
  return { status, headers: headers.filter(([k]) => !/^(transfer-encoding|connection|keep-alive)$/i.test(k)), body };
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * A custom-scheme page cannot follow an HTTP redirect, so a redirect (login, for one) is answered with a page that goes there.
 * The address is the server's own, always a path on this app.
 */
function redirectAsPage(r: EmbeddedResponse): EmbeddedResponse {
  const to = r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] ?? '/';
  const safe = /^\/(?!\/)/.test(to) ? to : '/';
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(safe)}"><script>location.replace(${JSON.stringify(safe).replace(/</g, '\\u003c')})</script>`;
  const keep = r.headers.filter(([k]) => /^(set-cookie|cache-control|x-)/i.test(k));
  return { status: 200, headers: [...keep, ['Content-Type', 'text/html; charset=utf-8'], ['Cache-Control', 'no-store']], body: Buffer.from(html) };
}

/** Answer a redirect with a page that goes there (the only kind of redirect a custom-scheme page can follow); anything else is unchanged. */
export function asPageIfRedirect(r: EmbeddedResponse): EmbeddedResponse {
  return r.status >= 300 && r.status < 400 && r.status !== 304 ? redirectAsPage(r) : r;
}

/** Run one request through the HTTP server's own parser and routes, with no socket. */
export function exchange(serve: (connection: Duplex) => void, req: EmbeddedRequest): Promise<EmbeddedResponse> {
  if (!TOKEN.test(req.method)) return Promise.reject(new Error('bad request method'));
  if (!SAFE_TARGET.test(req.target)) return Promise.reject(new Error('bad request address'));
  const lines = [`${req.method} ${req.target} HTTP/1.1`, 'Host: 127.0.0.1'];
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIPPED_HEADERS.has(k.toLowerCase())) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n\u0000]/.test(v)) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push(`Content-Length: ${req.body.length}`, 'Connection: close', '', '');
  const socket = new PipeSocket();
  return new Promise<EmbeddedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        const r = parseHttpResponse(Buffer.concat(socket.chunks));
        resolve(asPageIfRedirect(r));
      } catch (e) { reject(e as Error); }
      socket.destroy();
    };
    socket.once('finish', finish);
    socket.once('close', () => { if (!settled) finish(); });
    socket.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    try {
      serve(socket);
      socket.push(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), req.body]));
    } catch (e) { settled = true; reject(e as Error); }
  });
}

/**
 * Read request lines from `input`, answer each on `output`. Answers are written as whole lines, in the order they finish.
 * `onClose` runs when the window's end of the pipe closes (the window was closed), which is the signal to shut down.
 */
export function attachEmbedded(opts: { serve: (connection: Duplex) => void; input: Readable; output: Writable; onClose?: () => void }): void {
  const { serve, input, output } = opts;
  let pending = '';
  let skipping = false;
  const send = (line: string): void => { if (!output.destroyed) output.write(`${line}\n`); };
  const handle = (line: string): void => {
    if (!line.trim()) return;
    const decoded = decodeRequestLine(line);
    if (!decoded) { send(`E 0 ${b64('unreadable request')}`); return; }
    exchange(serve, decoded.request).then(
      (r) => send(encodeResponseLine(decoded.id, r)),
      (e: Error) => send(`E ${decoded.id} ${b64(e.message)}`),
    );
  };
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    pending += chunk;
    for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (skipping) { skipping = false; continue; }
      handle(line);
    }
    if (pending.length > MAX_LINE_BYTES) { pending = ''; skipping = true; send(`E 0 ${b64('request too large')}`); }
  });
  input.on('end', () => opts.onClose?.());
  input.on('close', () => opts.onClose?.());
  send('READY');
}
