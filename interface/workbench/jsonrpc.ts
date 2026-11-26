/**
 * JSON-RPC 2.0 over a byte stream, with the two framings the protocols we speak use:
 *   'ndjson'          one JSON message per line (tool servers over stdio)
 *   'content-length'  `Content-Length: n` headers then n bytes (language servers)
 * Requests time out, a closed stream fails everything waiting, and a message over 8 MB is refused.
 */
import type { Readable, Writable } from 'node:stream';

export type Framing = 'ndjson' | 'content-length';
export const MAX_MESSAGE = 8 * 1024 * 1024;

export class RpcError extends Error {
  constructor(message: string, readonly code = -32000, readonly data?: unknown) { super(message); }
}

type Handler = (params: any) => unknown | Promise<unknown>;

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private requestHandlers = new Map<string, Handler>();
  private notifyHandlers = new Map<string, Handler>();
  private buf = Buffer.alloc(0);
  private closed = false;

  constructor(private input: Readable, private output: Writable, private framing: Framing) {
    input.on('data', (d: Buffer) => this.onData(d));
    input.on('end', () => this.close(new RpcError('The connection closed.')));
    input.on('error', e => this.close(e));
    output.on('error', () => undefined);
  }

  onRequest(method: string, h: Handler): void { this.requestHandlers.set(method, h); }
  onNotification(method: string, h: Handler): void { this.notifyHandlers.set(method, h); }

  request<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('The connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`${method} timed out after ${timeoutMs / 1000}s.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void { if (!this.closed) this.send({ jsonrpc: '2.0', method, params }); }

  private send(msg: object): void {
    const body = JSON.stringify(msg);
    if (this.framing === 'ndjson') this.output.write(body + '\n');
    else this.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  /** Feed bytes in (used by the stream and, for HTTP transports, directly). */
  onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_MESSAGE * 2) { this.close(new RpcError('Message too large.')); return; }
    for (;;) {
      if (this.framing === 'ndjson') {
        const nl = this.buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = this.buf.subarray(0, nl).toString('utf8').trim();
        this.buf = this.buf.subarray(nl + 1);
        if (line) this.dispatch(line);
      } else {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('ascii'));
        if (!m) { this.buf = this.buf.subarray(end + 4); continue; }
        const len = Number(m[1]);
        if (len > MAX_MESSAGE) { this.close(new RpcError('Message too large.')); return; }
        if (this.buf.length < end + 4 + len) return;
        const body = this.buf.subarray(end + 4, end + 4 + len).toString('utf8');
        this.buf = this.buf.subarray(end + 4 + len);
        this.dispatch(body);
      }
    }
  }

  dispatch(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (Array.isArray(msg)) { msg.forEach(m => this.dispatch(JSON.stringify(m))); return; }
    if (msg && msg.method !== undefined) {
      if (msg.id === undefined) { void Promise.resolve(this.notifyHandlers.get(msg.method)?.(msg.params)).catch(() => undefined); return; }
      const h = this.requestHandlers.get(msg.method);
      if (!h) { this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }); return; }
      Promise.resolve().then(() => h(msg.params)).then(
        result => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
        (e: Error) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } }));
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'Error'), msg.error.code, msg.error.data));
    else p.resolve(msg.result);
  }

  close(reason: Error = new RpcError('Closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
  }

  get isClosed(): boolean { return this.closed; }
}
