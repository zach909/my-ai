/**
 * The phone's replacements for Node modules (mobile/server/src/shims), checked against Node's own on many inputs.
 * The shims are written for this project from the published specifications, so the way to trust them is to make
 * Node's implementation the judge: same bytes in, same bytes out.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodePath from 'node:path';
import nodeZlib from 'node:zlib';
import nodeUtil from 'node:util';
import nodeUrl from 'node:url';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { ROOT } from './helpers.mjs';
import { bundle } from '../../scripts/release/phone-bundle.mjs';

let S; // the shims, loaded in their own JavaScript world
before(async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'nc-shims-')), 'shims.js');
  bundle({ root: ROOT, entry: path.join(ROOT, 'test/platform/phone-shims-entry.ts'), outFile: out });
  // A bare world with the web platform's own APIs (what a WebView has) and nothing of Node's.
  const world = vm.createContext({
    TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, performance, queueMicrotask, setTimeout, clearTimeout, crypto: nodeCrypto.webcrypto,
    NativeHost: { call: () => JSON.stringify({ ok: true, value: null }) },
  });
  vm.runInContext(readFileSync(out, 'utf8'), world);
  S = world.__shims;
});

const rnd = (n) => nodeCrypto.randomBytes(n);
const sizes = [0, 1, 2, 3, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 200, 1000, 5000];

test('hashes: MD5, SHA-1, SHA-256 and SHA-512 give the same digests as Node for every padding boundary', () => {
  for (const alg of ['md5', 'sha1', 'sha256', 'sha512']) {
    for (const n of sizes) {
      const data = rnd(n);
      const want = nodeCrypto.createHash(alg).update(data).digest('hex');
      assert.equal(S.crypto.createHash(alg).update(new Uint8Array(data)).digest('hex'), want, `${alg} of ${n} bytes`);
    }
  }
  assert.equal(S.crypto.createHash('sha256').update('héllo wörld ✓').digest('base64'), nodeCrypto.createHash('sha256').update('héllo wörld ✓').digest('base64'));
  assert.equal(S.crypto.createHash('sha256').update('a').update('b').update('c').digest('hex'), nodeCrypto.createHash('sha256').update('abc').digest('hex'), 'update in pieces');
});

test('HMAC and PBKDF2 match Node', async () => {
  for (const alg of ['sha1', 'sha256', 'sha512']) {
    for (const n of [0, 5, 64, 65, 200]) {
      const key = rnd(n), msg = rnd(77);
      assert.equal(S.crypto.createHmac(alg, new Uint8Array(key)).update(new Uint8Array(msg)).digest('hex'), nodeCrypto.createHmac(alg, key).update(msg).digest('hex'), `hmac ${alg} key ${n}`);
    }
    assert.equal(S.crypto.pbkdf2Sync('password', 'salt', 1000, 40, alg).toString('hex'), nodeCrypto.pbkdf2Sync('password', 'salt', 1000, 40, alg).toString('hex'), `pbkdf2 ${alg}`);
  }
  const viaSubtle = await new Promise((res, rej) => S.crypto.pbkdf2('pw', 'salt', 5000, 32, 'sha512', (e, k) => (e ? rej(e) : res(k))));
  assert.equal(Buffer.from(viaSubtle).toString('hex'), nodeCrypto.pbkdf2Sync('pw', 'salt', 5000, 32, 'sha512').toString('hex'), 'the callback form (SubtleCrypto)');
});

test('crypto: random values are random-length-correct and unique; comparison is exact; the unavailable parts say so', () => {
  assert.equal(S.crypto.randomBytes(33).length, 33);
  assert.notEqual(Buffer.from(S.crypto.randomBytes(16)).toString('hex'), Buffer.from(S.crypto.randomBytes(16)).toString('hex'));
  assert.match(S.crypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(S.crypto.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(S.crypto.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.throws(() => S.crypto.timingSafeEqual(new Uint8Array(2), new Uint8Array(3)), (e) => e.name === 'RangeError'); // by name: the shim lives in another JavaScript world
  for (const f of ['createCipheriv', 'createSign', 'generateKeyPairSync']) assert.throws(() => S.crypto[f](), /not available on a phone/);
});

test('Buffer: encodings, slices, numbers and searching behave like Node\'s', () => {
  const B = S.buffer.Buffer;
  const samples = ['', 'plain', 'héllo wörld ✓ 😀', 'line\nbreak\t\0nul'];
  for (const s of samples) {
    for (const e of ['utf8', 'hex', 'base64', 'base64url', 'latin1']) {
      const want = Buffer.from(s, e === 'hex' ? 'utf8' : e);
      const got = B.from(s, e === 'hex' ? 'utf8' : e);
      assert.equal(Buffer.from(got).toString('hex'), want.toString('hex'), `${JSON.stringify(s)} as ${e}`);
      assert.equal(got.toString(e), want.toString(e), `toString ${e}`);
    }
  }
  assert.equal(B.from('48656c6c6f', 'hex').toString(), 'Hello');
  assert.equal(B.from('SGVsbG8', 'base64').toString(), 'Hello', 'base64 without padding');
  assert.equal(B.byteLength('héllo'), Buffer.byteLength('héllo'));
  const a = B.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(a.readUInt32BE(0), b.readUInt32BE(0)); assert.equal(a.readUInt32LE(2), b.readUInt32LE(2));
  assert.equal(a.readUInt16BE(1), b.readUInt16BE(1)); assert.equal(a.readDoubleBE(0), b.readDoubleBE(0));
  const w = B.alloc(8); w.writeUInt32BE(0xdeadbeef, 0); w.writeUInt16LE(0xabcd, 4);
  const w2 = Buffer.alloc(8); w2.writeUInt32BE(0xdeadbeef, 0); w2.writeUInt16LE(0xabcd, 4);
  assert.equal(Buffer.from(w).toString('hex'), w2.toString('hex'));
  const sl = a.slice(2, 5); sl[0] = 99;
  assert.equal(a[2], 99, 'slice shares memory like Node');
  assert.equal(B.concat([B.from('ab'), B.from('cd')]).toString(), 'abcd');
  assert.equal(B.from('hello world').indexOf('world'), 6);
  assert.equal(B.from('hello').includes('ell'), true);
  assert.equal(B.compare(B.from('a'), B.from('b')), -1);
  assert.equal(B.isBuffer(a), true);
  assert.equal(B.from('xyz').equals(B.from('xyz')), true);
  assert.deepEqual(JSON.parse(JSON.stringify(B.from('hi'))), { type: 'Buffer', data: [104, 105] });
});

test('path matches Node\'s POSIX path for joins, dots, relatives and parts', () => {
  const P = S.path;
  const joins = [['/a', 'b', '../c'], ['a', '..', '..', 'b'], ['/', 'x'], ['', 'a'], ['a/', '/b'], ['./a', './b'], ['/a/b/', '../..', 'c/']];
  for (const j of joins) assert.equal(P.join(...j), nodePath.posix.join(...j), `join ${JSON.stringify(j)}`);
  for (const p of ['/a/b/c', '/a/b/c/', 'a/b', 'a', '/', '', '.', '..', '/a//b', '/a/./b/../c', 'a/b/../../..']) {
    assert.equal(P.normalize(p), nodePath.posix.normalize(p), `normalize ${p}`);
    assert.equal(P.dirname(p), nodePath.posix.dirname(p), `dirname ${p}`);
    assert.equal(P.basename(p), nodePath.posix.basename(p), `basename ${p}`);
    assert.equal(P.extname(p), nodePath.posix.extname(p), `extname ${p}`);
    assert.equal(P.isAbsolute(p), nodePath.posix.isAbsolute(p), `isAbsolute ${p}`);
  }
  assert.equal(P.basename('/x/file.txt', '.txt'), 'file');
  assert.equal(P.extname('.bashrc'), nodePath.posix.extname('.bashrc'));
  assert.equal(P.relative('/a/b/c', '/a/d'), nodePath.posix.relative('/a/b/c', '/a/d'));
  assert.equal(P.resolve('/a', 'b', '../c'), nodePath.posix.resolve('/a', 'b', '../c'));
  assert.deepEqual(JSON.parse(JSON.stringify(P.parse('/home/u/file.tar.gz'))), nodePath.posix.parse('/home/u/file.tar.gz')); // as plain data: the shim lives in another JavaScript world
});

test('zlib: what the phone writes, Node reads, and what Node writes, the phone reads', () => {
  const Z = S.zlib;
  for (const n of [0, 1, 100, 70000, 200000]) {
    const data = Buffer.concat([rnd(Math.min(n, 50)), Buffer.alloc(Math.max(0, n - 50), 'abc')]);
    assert.ok(nodeZlib.gunzipSync(Buffer.from(Z.gzipSync(new Uint8Array(data)))).equals(data), `gzip ${n}`);
    assert.ok(nodeZlib.inflateSync(Buffer.from(Z.deflateSync(new Uint8Array(data)))).equals(data), `deflate ${n}`);
    assert.ok(nodeZlib.inflateRawSync(Buffer.from(Z.deflateRawSync(new Uint8Array(data)))).equals(data), `raw ${n}`);
    assert.ok(Buffer.from(Z.gunzipSync(new Uint8Array(nodeZlib.gzipSync(data)))).equals(data), `gunzip of Node's ${n}`);
    assert.ok(Buffer.from(Z.inflateSync(new Uint8Array(nodeZlib.deflateSync(data)))).equals(data), `inflate of Node's ${n}`);
    assert.ok(Buffer.from(Z.inflateRawSync(new Uint8Array(nodeZlib.deflateRawSync(data)))).equals(data), `inflateRaw of Node's ${n}`);
  }
});

test('events, util and url match Node on what the engine uses', () => {
  const E = new S.events.EventEmitter(); const seen = [];
  E.on('x', (a, b) => seen.push(['on', a, b])); E.once('x', () => seen.push(['once'])); E.prependListener('x', () => seen.push(['first']));
  assert.equal(E.emit('x', 1, 2), true); E.emit('x', 3, 4);
  assert.deepEqual(seen, [['first'], ['on', 1, 2], ['once'], ['first'], ['on', 3, 4]]);
  assert.equal(E.emit('nothing'), false);
  assert.throws(() => E.emit('error', new Error('boom')), /boom/);
  for (const [f, ...args] of [['a %s b %d', 'x', 5], ['%j', { a: 1 }], ['100%% sure'], ['no args %s'], ['plain', 'extra']]) assert.equal(S.util.format(f, ...args), nodeUtil.format(f, ...args), `format ${f}`);
  const sq = S.util.promisify((x, cb) => cb(null, x * 2));
  return sq(21).then((v) => {
    assert.equal(v, 42);
    assert.equal(S.url.fileURLToPath('file:///a/b%20c/d.txt'), nodeUrl.fileURLToPath('file:///a/b%20c/d.txt'));
    assert.equal(S.url.pathToFileURL('/a/b c/d.txt').href, nodeUrl.pathToFileURL('/a/b c/d.txt').href);
    assert.equal(S.os.platform(), 'android');
    assert.equal(S.os.homedir(), '/phone/home');
  });
});
