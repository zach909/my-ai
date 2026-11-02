/**
 * node:crypto for the phone. Hashes (MD5, SHA-1, SHA-256, SHA-512), HMAC, PBKDF2, random bytes and constant-time
 * comparison are implemented here from their published specifications (FIPS 180-4, RFC 1321, RFC 2104, RFC 8018),
 * with no library. PBKDF2 uses the WebView's own SubtleCrypto where it has it. AES and signing/key generation are
 * not provided: they back optional features (encrypted exports, passkeys) that report "not available on a phone".
 */
import { Buffer } from './buffer';
import { notOnPhone } from './host';

type Input = string | Uint8Array;
const bytes = (d: Input, e?: string): Uint8Array => (typeof d === 'string' ? Buffer.from(d, (e as any) ?? 'utf8') : d);
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function pad(data: Uint8Array, block: number, lenBytes: number, bigEndian: boolean): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  let total = data.length + 1 + lenBytes;
  total += (block - (total % block)) % block;
  const out = new Uint8Array(total);
  out.set(data);
  out[data.length] = 0x80;
  for (let i = 0; i < lenBytes; i++) {
    const shift = BigInt(8 * (bigEndian ? lenBytes - 1 - i : i));
    out[total - lenBytes + i] = Number((bitLen >> shift) & 0xffn);
  }
  return out;
}

function sha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array(64);
  for (let i = 0, n = 2, found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (prime) { K[found++] = Math.floor((Math.cbrt(n) % 1) * 2 ** 32); i++; }
  }
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const m = pad(data, 64, 8, true);
  const w = new Uint32Array(64);
  const dv = new DataView(m.buffer);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

function sha1(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const m = pad(data, 64, 8, true);
  const w = new Uint32Array(80);
  const dv = new DataView(m.buffer);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

function md5(data: Uint8Array): Uint8Array {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = pad(data, 64, 8, false);
  const dv = new DataView(m.buffer);
  for (let off = 0; off < m.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => odv.setUint32(i * 4, v >>> 0, true));
  return out;
}

const M64 = (1n << 64n) - 1n;
const R64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;
let K512: bigint[] | null = null;
function sha512(data: Uint8Array): Uint8Array {
  if (!K512) {
    K512 = [];
    // First 64 bits of the fractional parts of the cube roots of the first 80 primes, by exact integer root.
    for (let n = 2n; K512.length < 80; n++) {
      let prime = true;
      for (let d = 2n; d * d <= n; d++) if (n % d === 0n) { prime = false; break; }
      if (!prime) continue;
      const scaled = n << 192n; // n * 2^192, so the cube root is n^(1/3) * 2^64
      let lo = 0n, hi = 1n << 70n;
      while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid * mid * mid <= scaled) lo = mid; else hi = mid - 1n; }
      K512.push(lo & M64);
    }
  }
  const H = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
  const m = pad(data, 128, 16, true);
  const dv = new DataView(m.buffer);
  const w = new Array<bigint>(80);
  for (let off = 0; off < m.length; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(off + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = R64(w[i - 15], 1n) ^ R64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = R64(w[i - 2], 19n) ^ R64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const S1 = R64(e, 14n) ^ R64(e, 18n) ^ R64(e, 41n);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (h + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = R64(a, 28n) ^ R64(a, 34n) ^ R64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) & M64; });
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setBigUint64(i * 8, v));
  return out;
}

const ALGOS: Record<string, { fn: (d: Uint8Array) => Uint8Array; block: number }> = {
  md5: { fn: md5, block: 64 }, sha1: { fn: sha1, block: 64 }, sha256: { fn: sha256, block: 64 }, sha512: { fn: sha512, block: 128 },
};
function algo(name: string) {
  const a = ALGOS[name.toLowerCase().replace('-', '')];
  if (!a) throw notOnPhone(`The hash "${name}"`);
  return a;
}

function out(b: Uint8Array, encoding?: string): string | Buffer {
  const buf = Buffer.from(b);
  return encoding ? buf.toString(encoding) : buf;
}

class Hash {
  private chunks: Uint8Array[] = [];
  constructor(private name: string) { algo(name); }
  update(data: Input, encoding?: string): this { this.chunks.push(Uint8Array.from(bytes(data, encoding))); return this; }
  digest(encoding?: string): string | Buffer { return out(algo(this.name).fn(Buffer.concat(this.chunks)), encoding); }
  copy(): Hash { const h = new Hash(this.name); h.chunks = [...this.chunks]; return h; }
}
export function createHash(name: string): Hash { return new Hash(name); }

class Hmac {
  private chunks: Uint8Array[] = [];
  private key: Uint8Array;
  constructor(private name: string, key: Input) {
    const a = algo(name);
    let k: Uint8Array = Uint8Array.from(bytes(key));
    if (k.length > a.block) k = a.fn(k);
    this.key = new Uint8Array(a.block); this.key.set(k);
  }
  update(data: Input, encoding?: string): this { this.chunks.push(Uint8Array.from(bytes(data, encoding))); return this; }
  digest(encoding?: string): string | Buffer {
    const a = algo(this.name);
    const ipad = this.key.map((x) => x ^ 0x36), opad = this.key.map((x) => x ^ 0x5c);
    const inner = a.fn(Buffer.concat([ipad, ...this.chunks]));
    return out(a.fn(Buffer.concat([opad, inner])), encoding);
  }
}
export function createHmac(name: string, key: Input): Hmac { return new Hmac(name, key); }

export function randomBytes(n: number, cb?: (err: Error | null, b: Buffer) => void): Buffer | void {
  const b = Buffer.alloc(n);
  for (let off = 0; off < n; off += 65536) (globalThis as any).crypto.getRandomValues(b.subarray(off, Math.min(n, off + 65536)));
  if (cb) { setTimeout(() => cb(null, b), 0); return; }
  return b;
}
export function randomUUID(): string { return (globalThis as any).crypto.randomUUID(); }
export function randomInt(min: number, max?: number): number {
  const lo = max === undefined ? 0 : min, hi = max === undefined ? min : max;
  const r = new Uint32Array(1); (globalThis as any).crypto.getRandomValues(r);
  return lo + (r[0] % (hi - lo));
}
export function getRandomValues<T extends ArrayBufferView>(a: T): T { return (globalThis as any).crypto.getRandomValues(a); }

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function pbkdf2Core(password: Input, salt: Input, iterations: number, keylen: number, digest: string): Uint8Array {
  const a = algo(digest);
  const hLen = a.fn(new Uint8Array(0)).length;
  const blocks = Math.ceil(keylen / hLen);
  const dk = new Uint8Array(blocks * hLen);
  const pw = Uint8Array.from(bytes(password)), sl = Uint8Array.from(bytes(salt));
  for (let i = 1; i <= blocks; i++) {
    const idx = Uint8Array.of(i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255);
    let u = new Hmac(digest, pw).update(Buffer.concat([sl, idx])).digest() as Uint8Array;
    const t = Uint8Array.from(u);
    for (let j = 1; j < iterations; j++) {
      u = new Hmac(digest, pw).update(u).digest() as Uint8Array;
      for (let k = 0; k < t.length; k++) t[k] ^= u[k];
    }
    dk.set(t, (i - 1) * hLen);
  }
  return dk.subarray(0, keylen);
}
export function pbkdf2Sync(password: Input, salt: Input, iterations: number, keylen: number, digest: string): Buffer {
  return Buffer.from(pbkdf2Core(password, salt, iterations, keylen, digest));
}
/** Asynchronous PBKDF2: the WebView's native SubtleCrypto does the work when it can (it is far faster than JavaScript). */
export function pbkdf2(password: Input, salt: Input, iterations: number, keylen: number, digest: string, cb: (err: Error | null, key?: Buffer) => void): void {
  const subtle = (globalThis as any).crypto?.subtle;
  const hash = ({ sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' } as Record<string, string>)[digest.toLowerCase().replace('-', '')];
  if (subtle && hash) {
    subtle.importKey('raw', Uint8Array.from(bytes(password)), 'PBKDF2', false, ['deriveBits'])
      .then((k: unknown) => subtle.deriveBits({ name: 'PBKDF2', hash, salt: Uint8Array.from(bytes(salt)), iterations }, k, keylen * 8))
      .then((bits: ArrayBuffer) => cb(null, Buffer.from(new Uint8Array(bits))), (e: Error) => cb(e));
    return;
  }
  setTimeout(() => { try { cb(null, pbkdf2Sync(password, salt, iterations, keylen, digest)); } catch (e) { cb(e as Error); } }, 0);
}

export function createCipheriv(): never { throw notOnPhone('Encryption with a cipher'); }
export function createDecipheriv(): never { throw notOnPhone('Decryption with a cipher'); }
export function createSign(): never { throw notOnPhone('Signing'); }
export function createVerify(): never { throw notOnPhone('Signature checking'); }
export function generateKeyPairSync(): never { throw notOnPhone('Key generation'); }
export const webcrypto = (globalThis as any).crypto;
export const subtle = (globalThis as any).crypto?.subtle;

export default { createHash, createHmac, randomBytes, randomUUID, randomInt, getRandomValues, timingSafeEqual, pbkdf2, pbkdf2Sync, createCipheriv, createDecipheriv, createSign, createVerify, generateKeyPairSync, webcrypto, subtle };
