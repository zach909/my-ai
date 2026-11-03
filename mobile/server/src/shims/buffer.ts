/**
 * node:buffer for the phone: a Buffer that behaves like Node's for everything the engine does with one
 * (files, hashes, zip, base64, the Zip Loop's raw bits). Written for this project; no library.
 */
type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function norm(e?: string): Encoding {
  const k = (e ?? 'utf8').toLowerCase() as Encoding;
  if (!['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'latin1', 'binary', 'ascii', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(k)) throw new TypeError(`Unknown encoding: ${e}`);
  return k;
}

function bytesToBinaryString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return s;
}

function fromBase64(s: string): Uint8Array {
  // Node ignores characters outside the alphabet, accepts missing padding, and drops a single dangling character.
  let clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+]|\//g, (c) => (c === '/' ? '/' : ''));
  const stop = clean.indexOf('=');
  if (stop >= 0) clean = clean.slice(0, stop);
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeString(s: string, e: Encoding): Uint8Array {
  switch (e) {
    case 'utf8': case 'utf-8': return enc.encode(s);
    case 'hex': {
      const n = s.length >> 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = parseInt(s.substr(i * 2, 2), 16);
        if (Number.isNaN(v)) return out.subarray(0, i);
        out[i] = v;
      }
      return out;
    }
    case 'base64': case 'base64url': return fromBase64(s);
    case 'latin1': case 'binary': case 'ascii': { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; }
    default: { const out = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; } return out; }
  }
}

export class Buffer extends Uint8Array {
  static poolSize = 8192;

  static from(input: any, a?: any, b?: any): Buffer {
    if (typeof input === 'string') { const u = encodeString(input, norm(a)); return Buffer._wrap(u); }
    if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)) return new Buffer(input as ArrayBuffer, a ?? 0, b ?? (input as ArrayBuffer).byteLength - (a ?? 0));
    if (ArrayBuffer.isView(input)) { const u = new Uint8Array(input.byteLength); u.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)); return Buffer._wrap(u); }
    if (input && input.type === 'Buffer' && Array.isArray(input.data)) return Buffer._wrap(Uint8Array.from(input.data));
    if (Array.isArray(input) || (input && typeof input.length === 'number')) return Buffer._wrap(Uint8Array.from(input as ArrayLike<number>, (x) => x & 0xff));
    throw new TypeError('The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object');
  }
  /** Own the given bytes without copying. */
  private static _wrap(u: Uint8Array): Buffer { return new Buffer(u.buffer as ArrayBuffer, u.byteOffset, u.byteLength); }

  static alloc(size: number, fill?: number | string | Uint8Array, encoding?: string): Buffer {
    const b = new Buffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill as any, 0, size, encoding);
    return b;
  }
  static allocUnsafe(size: number): Buffer { return new Buffer(size); }
  static allocUnsafeSlow(size: number): Buffer { return new Buffer(size); }
  static isBuffer(x: unknown): x is Buffer { return x instanceof Buffer; }
  static isEncoding(e: unknown): boolean { try { norm(e as string); return typeof e === 'string'; } catch { return false; } }
  static byteLength(v: string | ArrayBufferView | ArrayBuffer, e?: string): number {
    if (typeof v === 'string') return encodeString(v, norm(e)).length;
    return (v as ArrayBufferView).byteLength;
  }
  static concat(list: Uint8Array[], total?: number): Buffer {
    const n = total ?? list.reduce((s, b) => s + b.length, 0);
    const out = new Buffer(n);
    let o = 0;
    for (const b of list) { if (o >= n) break; const take = Math.min(b.length, n - o); out.set(b.subarray(0, take), o); o += take; }
    return out;
  }
  static compare(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  toString(encoding?: string, start = 0, end = this.length): string {
    const e = norm(encoding);
    const view = this.subarray(Math.max(0, start), Math.min(this.length, end));
    switch (e) {
      case 'utf8': case 'utf-8': return dec.decode(view);
      case 'hex': { let s = ''; for (let i = 0; i < view.length; i++) s += (view[i] < 16 ? '0' : '') + view[i].toString(16); return s; }
      case 'base64': return btoa(bytesToBinaryString(view));
      case 'base64url': return btoa(bytesToBinaryString(view)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      case 'latin1': case 'binary': return bytesToBinaryString(view);
      case 'ascii': { let s = ''; for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i] & 0x7f); return s; }
      default: { let s = ''; for (let i = 0; i + 1 < view.length; i += 2) s += String.fromCharCode(view[i] | (view[i + 1] << 8)); return s; }
    }
  }
  toJSON(): { type: 'Buffer'; data: number[] } { return { type: 'Buffer', data: Array.from(this) }; }
  equals(o: Uint8Array): boolean { return Buffer.compare(this, o) === 0; }
  compare(o: Uint8Array): number { return Buffer.compare(this, o); }
  slice(start?: number, end?: number): Buffer { return this.subarray(start, end); }
  subarray(start?: number, end?: number): Buffer {
    const u = Uint8Array.prototype.subarray.call(this, start, end);
    return new Buffer(u.buffer as ArrayBuffer, u.byteOffset, u.byteLength);
  }
  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const src = this.subarray(sourceStart, sourceEnd);
    const n = Math.max(0, Math.min(src.length, target.length - targetStart));
    target.set(src.subarray(0, n), targetStart);
    return n;
  }
  fill(value: any, start = 0, end = this.length, encoding?: string): this {
    if (typeof value === 'string') {
      const bytes = encodeString(value, norm(encoding));
      if (bytes.length === 0) return super.fill(0, start, end) as this;
      for (let i = start, j = 0; i < end; i++, j = (j + 1) % bytes.length) this[i] = bytes[j];
      return this;
    }
    if (value instanceof Uint8Array) { for (let i = start, j = 0; i < end; i++, j = (j + 1) % value.length) this[i] = value[j]; return this; }
    return super.fill(value & 0xff, start, end) as this;
  }
  indexOf(value: any, byteOffset = 0, encoding?: string): number {
    const needle = typeof value === 'number' ? Uint8Array.of(value) : typeof value === 'string' ? encodeString(value, norm(encoding)) : value;
    if (needle.length === 0) return Math.min(byteOffset, this.length);
    outer: for (let i = Math.max(0, byteOffset); i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  includes(value: any, byteOffset = 0, encoding?: string): boolean { return this.indexOf(value, byteOffset, encoding) !== -1; }
  write(str: string, a?: any, b?: any, c?: any): number {
    let offset = 0, length = this.length, e: string | undefined;
    if (typeof a === 'string') e = a; else { offset = a ?? 0; if (typeof b === 'string') e = b; else { length = b ?? this.length - offset; e = c; } }
    const bytes = encodeString(str, norm(e));
    const n = Math.min(bytes.length, length, this.length - offset);
    this.set(bytes.subarray(0, n), offset);
    return n;
  }

  private _dv(): DataView { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUInt8(o = 0): number { return this[o]; }
  readInt8(o = 0): number { return this._dv().getInt8(o); }
  readUInt16LE(o = 0): number { return this._dv().getUint16(o, true); }
  readUInt16BE(o = 0): number { return this._dv().getUint16(o, false); }
  readInt16LE(o = 0): number { return this._dv().getInt16(o, true); }
  readInt16BE(o = 0): number { return this._dv().getInt16(o, false); }
  readUInt32LE(o = 0): number { return this._dv().getUint32(o, true); }
  readUInt32BE(o = 0): number { return this._dv().getUint32(o, false); }
  readInt32LE(o = 0): number { return this._dv().getInt32(o, true); }
  readInt32BE(o = 0): number { return this._dv().getInt32(o, false); }
  readFloatLE(o = 0): number { return this._dv().getFloat32(o, true); }
  readFloatBE(o = 0): number { return this._dv().getFloat32(o, false); }
  readDoubleLE(o = 0): number { return this._dv().getFloat64(o, true); }
  readDoubleBE(o = 0): number { return this._dv().getFloat64(o, false); }
  readBigUInt64LE(o = 0): bigint { return this._dv().getBigUint64(o, true); }
  readBigUInt64BE(o = 0): bigint { return this._dv().getBigUint64(o, false); }
  writeUInt8(v: number, o = 0): number { this[o] = v; return o + 1; }
  writeInt8(v: number, o = 0): number { this._dv().setInt8(o, v); return o + 1; }
  writeUInt16LE(v: number, o = 0): number { this._dv().setUint16(o, v, true); return o + 2; }
  writeUInt16BE(v: number, o = 0): number { this._dv().setUint16(o, v, false); return o + 2; }
  writeInt16LE(v: number, o = 0): number { this._dv().setInt16(o, v, true); return o + 2; }
  writeInt16BE(v: number, o = 0): number { this._dv().setInt16(o, v, false); return o + 2; }
  writeUInt32LE(v: number, o = 0): number { this._dv().setUint32(o, v, true); return o + 4; }
  writeUInt32BE(v: number, o = 0): number { this._dv().setUint32(o, v, false); return o + 4; }
  writeInt32LE(v: number, o = 0): number { this._dv().setInt32(o, v, true); return o + 4; }
  writeInt32BE(v: number, o = 0): number { this._dv().setInt32(o, v, false); return o + 4; }
  writeFloatLE(v: number, o = 0): number { this._dv().setFloat32(o, v, true); return o + 4; }
  writeFloatBE(v: number, o = 0): number { this._dv().setFloat32(o, v, false); return o + 4; }
  writeDoubleLE(v: number, o = 0): number { this._dv().setFloat64(o, v, true); return o + 8; }
  writeDoubleBE(v: number, o = 0): number { this._dv().setFloat64(o, v, false); return o + 8; }
  writeBigUInt64LE(v: bigint, o = 0): number { this._dv().setBigUint64(o, v, true); return o + 8; }
  writeBigUInt64BE(v: bigint, o = 0): number { this._dv().setBigUint64(o, v, false); return o + 8; }
}
// Node's aliases for the unsigned readers/writers.
for (const bits of ['8', '16LE', '16BE', '32LE', '32BE']) {
  (Buffer.prototype as any)[`readUint${bits}`] = (Buffer.prototype as any)[`readUInt${bits}`];
  (Buffer.prototype as any)[`writeUint${bits}`] = (Buffer.prototype as any)[`writeUInt${bits}`];
}

export const constants = { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 };
export const kMaxLength = constants.MAX_LENGTH;
export const SlowBuffer = Buffer;
export default { Buffer, constants, kMaxLength, SlowBuffer };
