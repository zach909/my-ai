/**
 * node:stream for the phone: only the classes the engine names. The phone never runs the desktop's stdin/stdout
 * transport (startEmbedded), so these are small stand-ins written for this project (no library).
 */
import { EventEmitter } from './events';

type Chunk = any;
type WriteCallback = (error?: Error | null) => void;

export class Stream extends EventEmitter {}

export class Writable extends Stream {
  private _write?: (chunk: Chunk, encoding: string, cb: WriteCallback) => void;
  constructor(options: { write?: (chunk: Chunk, encoding: string, cb: WriteCallback) => void } = {}) {
    super();
    this._write = options.write;
  }
  write(chunk: Chunk, encoding?: string | WriteCallback, cb?: WriteCallback): boolean {
    const enc = typeof encoding === 'string' ? encoding : 'utf8';
    const done = typeof encoding === 'function' ? encoding : cb ?? (() => undefined);
    if (!this._write) { done(new Error('write not implemented')); return false; }
    this._write(chunk, enc, done);
    return true;
  }
  end(chunk?: Chunk, encoding?: string | WriteCallback, cb?: WriteCallback): this {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.write(chunk, typeof encoding === 'string' ? encoding : undefined, cb);
    this.emit('finish');
    return this;
  }
}

export class Readable extends Stream {
  readable = true;
  push(chunk: Chunk): boolean {
    if (chunk === null) { this.emit('end'); return false; }
    this.emit('data', chunk);
    return true;
  }
  pipe<T>(dest: T): T { return dest; }
  destroy(): this { this.emit('close'); return this; }
}

export class Duplex extends Readable {
  writable = true;
  private _writer: Writable;
  constructor(options: { write?: (chunk: Chunk, encoding: string, cb: WriteCallback) => void } = {}) {
    super();
    this._writer = new Writable(options);
  }
  write(chunk: Chunk, encoding?: string | WriteCallback, cb?: WriteCallback): boolean {
    return this._writer.write(chunk, encoding, cb);
  }
  end(chunk?: Chunk, encoding?: string | WriteCallback, cb?: WriteCallback): this {
    this._writer.end(chunk, encoding, cb);
    return this;
  }
}

export default Stream;
