/**
 * node:http for the phone. There is no network port on a phone to listen on, so `createServer(listener)` does not
 * open one: it keeps the listener, and the app hands every request that arrives at its local address
 * (127.0.0.1, see PhoneServer.kt) to `dispatch()` below, which calls the very same listener with a request and
 * response shaped like Node's. The engine's web server therefore runs unchanged: its routes, pages and checks
 * are the ones the computer runs.
 */
import { Buffer } from './buffer';
import { EventEmitter } from './events';
import { notOnPhone } from './host';

export const STATUS_CODES: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

export class IncomingMessage extends EventEmitter {
  method = 'GET'; url = '/'; headers: Record<string, string | string[]> = {}; httpVersion = '1.1'; statusCode?: number;
  socket: { remoteAddress: string; remotePort: number; encrypted?: boolean; destroy(): void; setTimeout(): void };
  connection: IncomingMessage['socket'];
  complete = false; aborted = false; destroyed = false;
  private _body: Buffer;
  constructor(init: { method: string; url: string; headers: Record<string, string>; body: Uint8Array; remoteAddress: string }) {
    super();
    this.method = init.method; this.url = init.url;
    for (const [k, v] of Object.entries(init.headers)) this.headers[k.toLowerCase()] = v;
    this._body = Buffer.from(init.body);
    this.socket = { remoteAddress: init.remoteAddress, remotePort: 0, destroy: () => { this.destroyed = true; }, setTimeout: () => {} };
    this.connection = this.socket;
    // The body arrives once a reader has had a chance to attach, as it would from a network.
    setTimeout(() => this._flow(), 0);
  }
  private _flow(): void {
    if (this._body.length) this.emit('data', this._body);
    this.complete = true;
    this.emit('end'); this.emit('close');
  }
  setEncoding(): this { return this; }
  setTimeout(): this { return this; }
  destroy(): this { this.destroyed = true; return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    // Used instead of events when a route reads with `for await`.
    this.removeAllListeners('data'); this.removeAllListeners('end');
    if (this._body.length) yield this._body;
  }
}

export class ServerResponse extends EventEmitter {
  statusCode = 200; statusMessage = ''; headersSent = false; writableEnded = false; finished = false; destroyed = false;
  private _headers = new Map<string, string | string[]>();
  private _chunks: Uint8Array[] = [];
  socket = { remoteAddress: '127.0.0.1', destroy: () => {}, setTimeout: () => {}, writable: true };
  constructor(private sink: { head(status: number, message: string, headers: Record<string, string | string[]>): void; chunk(b: Uint8Array): void; end(): void }) { super(); }
  setHeader(name: string, value: string | number | string[]): this { this._headers.set(name.toLowerCase(), Array.isArray(value) ? value.map(String) : String(value)); return this; }
  getHeader(name: string): string | string[] | undefined { return this._headers.get(name.toLowerCase()); }
  getHeaders(): Record<string, string | string[]> { return Object.fromEntries(this._headers); }
  getHeaderNames(): string[] { return [...this._headers.keys()]; }
  hasHeader(name: string): boolean { return this._headers.has(name.toLowerCase()); }
  removeHeader(name: string): void { this._headers.delete(name.toLowerCase()); }
  writeHead(status: number, a?: any, b?: any): this {
    this.statusCode = status;
    const headers = typeof a === 'object' && a !== null ? a : b;
    if (typeof a === 'string') this.statusMessage = a;
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v as any);
    return this;
  }
  flushHeaders(): void { this._sendHead(); }
  private _sendHead(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.sink.head(this.statusCode, this.statusMessage || STATUS_CODES[this.statusCode] || '', this.getHeaders());
  }
  write(chunk: any, enc?: any, cb?: () => void): boolean {
    if (this.writableEnded) return false;
    this._sendHead();
    const b = typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk;
    this.sink.chunk(b);
    const done = typeof enc === 'function' ? enc : cb;
    if (done) setTimeout(done, 0);
    return true;
  }
  end(chunk?: any, enc?: any, cb?: () => void): this {
    if (this.writableEnded) return this;
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (chunk !== undefined && chunk !== null && chunk !== '') this.write(chunk, enc);
    this._sendHead();
    this.writableEnded = true; this.finished = true;
    this.sink.end();
    this.emit('finish'); this.emit('close');
    if (typeof cb === 'function') setTimeout(cb, 0);
    return this;
  }
  setTimeout(): this { return this; }
  destroy(): this { this.destroyed = true; return this; }
  on(name: string, fn: (...a: any[]) => void): this { return super.on(name, fn); }
}

export class Server extends EventEmitter {
  listening = false;
  constructor(listener?: (req: IncomingMessage, res: ServerResponse) => void) { super(); if (listener) this.on('request', listener); }
  listen(...args: any[]): this {
    const cb = args.find((a) => typeof a === 'function');
    this.listening = true;
    active = this;
    setTimeout(() => { this.emit('listening'); if (cb) cb(); }, 0);
    return this;
  }
  close(cb?: (e?: Error) => void): this { this.listening = false; if (active === this) active = null; setTimeout(() => { this.emit('close'); if (cb) cb(); }, 0); return this; }
  address(): { port: number; address: string; family: string } { return { port: 0, address: '127.0.0.1', family: 'IPv4' }; }
  setTimeout(): this { return this; }
  closeAllConnections(): void {}
  closeIdleConnections(): void {}
  keepAliveTimeout = 5000; headersTimeout = 60000; requestTimeout = 0;
}

let active: Server | null = null;
export function createServer(a?: any, b?: any): Server { return new Server(typeof a === 'function' ? a : b); }

export interface PhoneRequest { method: string; url: string; headers: Record<string, string>; body: Uint8Array; remoteAddress?: string }
export interface PhoneSink { head(status: number, message: string, headers: Record<string, string | string[]>): void; chunk(b: Uint8Array): void; end(): void }

/** Hand one request to the server the engine "started". Returns once the listener has been called. */
export function dispatch(request: PhoneRequest, sink: PhoneSink): void {
  if (!active) throw new Error('the server has not been started');
  const req = new IncomingMessage({ ...request, remoteAddress: request.remoteAddress ?? '127.0.0.1' });
  const res = new ServerResponse(sink);
  active.emit('request', req, res);
}

export function request(): never { throw notOnPhone('Making a request with node:http'); }
export function get(): never { throw notOnPhone('Making a request with node:http'); }
export class Agent { constructor(_o?: unknown) {} destroy(): void {} }
export const globalAgent = new Agent();
export default { STATUS_CODES, METHODS, IncomingMessage, ServerResponse, Server, createServer, request, get, Agent, globalAgent };
