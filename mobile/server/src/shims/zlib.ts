/**
 * node:zlib for the phone. Decoding is a complete RFC 1951 inflate (so any real gzip, zip or zlib data reads);
 * encoding writes valid streams made of stored blocks (RFC 1951 3.2.4), which every standard decoder reads back but
 * which are not shrunk. That is the same trade the phone brain already makes (mobile/brain/src/zlib-shim.ts, whose
 * inflate and block writer this reuses), and it is what a zip written on the phone needs to be readable anywhere.
 */
import { Buffer } from './buffer';
import { EventEmitter } from './events';
import { crc32, deflateStore, inflateRaw } from '../../../brain/src/zlib-shim';

const u8 = (d: any): Uint8Array => (typeof d === 'string' ? Buffer.from(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
const be32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);

export function deflateRawSync(d: any): Buffer { return Buffer.from(deflateStore(u8(d))); }
export function inflateRawSync(d: any): Buffer { return Buffer.from(inflateRaw(u8(d))); }
export function deflateSync(d: any): Buffer {
  const data = u8(d);
  return Buffer.concat([Buffer.from([0x78, 0x01]), deflateStore(data), be32(adler32(data))]);
}
export function inflateSync(d: any): Buffer {
  const data = u8(d);
  if (data.length < 6 || (data[0] & 0x0f) !== 8) throw new Error('incorrect header check');
  return Buffer.from(inflateRaw(data.subarray(2, data.length - 4)));
}
export function gzipSync(d: any): Buffer {
  const data = u8(d);
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]), deflateStore(data), le32(crc32(data)), le32(data.length >>> 0)]);
}
export function gunzipSync(d: any): Buffer {
  const data = u8(d);
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('incorrect header check');
  const flg = data[3];
  let off = 10;
  if (flg & 4) off += 2 + (data[off] | (data[off + 1] << 8));
  if (flg & 8) { while (data[off] !== 0) off++; off++; }
  if (flg & 16) { while (data[off] !== 0) off++; off++; }
  if (flg & 2) off += 2;
  return Buffer.from(inflateRaw(data.subarray(off, data.length - 8)));
}
export function unzipSync(d: any): Buffer { const x = u8(d); return x[0] === 0x1f ? gunzipSync(x) : inflateSync(x); }

/** A stream that collects what is written, then transforms it all when the end arrives. */
class Collect extends EventEmitter {
  private chunks: Uint8Array[] = [];
  constructor(private f: (b: Uint8Array) => Uint8Array) { super(); }
  write(c: any): boolean { this.chunks.push(Uint8Array.from(u8(c))); return true; }
  end(c?: any): this {
    if (c !== undefined) this.write(c);
    setTimeout(() => {
      try { this.emit('data', Buffer.from(this.f(Buffer.concat(this.chunks)))); this.emit('end'); this.emit('close'); }
      catch (e) { this.emit('error', e); }
    }, 0);
    return this;
  }
  pipe<T extends { write(c: any): any; end(): any }>(dest: T): T { this.on('data', (c: any) => dest.write(c)); this.on('end', () => dest.end()); return dest; }
  destroy(): this { return this; }
}
export const createGzip = () => new Collect(gzipSync);
export const createGunzip = () => new Collect(gunzipSync);
export const createDeflate = () => new Collect(deflateSync);
export const createInflate = () => new Collect(inflateSync);

const callbackForm = (f: (d: any) => Buffer) => (d: any, cb: (e: Error | null, r?: Buffer) => void) => { setTimeout(() => { try { cb(null, f(d)); } catch (e) { cb(e as Error); } }, 0); };
export const gzip = callbackForm(gzipSync), gunzip = callbackForm(gunzipSync), deflate = callbackForm(deflateSync), inflate = callbackForm(inflateSync);
export const constants = { Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 };
export default { deflateRawSync, inflateRawSync, deflateSync, inflateSync, gzipSync, gunzipSync, unzipSync, createGzip, createGunzip, createDeflate, createInflate, gzip, gunzip, deflate, inflate, constants };
