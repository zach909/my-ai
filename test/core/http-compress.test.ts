import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { contentEtag, MIN_COMPRESS_BYTES, sendBody } from '../../interface/http-compress.js';

const BIG = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'skill-' + i })) });
const SMALL = JSON.stringify({ ok: true });

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/big') return sendBody(res, 200, 'application/json', BIG, { etag: true });
    if (url === '/small') return sendBody(res, 200, 'application/json', SMALL, { etag: true });
    if (url === '/cookie') { res.setHeader('Set-Cookie', 'sid=1'); return sendBody(res, 200, 'application/json', BIG, { etag: true }); }
    if (url === '/policy') { res.setHeader('Cache-Control', 'private, max-age=5'); return sendBody(res, 200, 'application/json', BIG, { etag: true }); }
    if (url === '/err') return sendBody(res, 500, 'application/json', BIG, { etag: true });
    if (url === '/fixed') return sendBody(res, 200, 'text/css', BIG, { etag: contentEtag(BIG), cacheCompressed: true, headers: { 'Cache-Control': 'no-cache' } });
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

interface Got { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    // Node's client does not decompress, so what arrives is exactly what was sent.
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('sendBody', () => {
  it('gzips a large body for a client that accepts it, and the bytes round-trip', async () => {
    const r = await get('/big', { 'accept-encoding': 'gzip, deflate' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['vary']).toBe('Accept-Encoding');
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(BIG.length / 3);
    expect(gunzipSync(r.body).toString('utf8')).toBe(BIG);
  });

  it('sends plain bytes to a client that does not ask for gzip, or refuses it with q=0', async () => {
    for (const ae of [undefined, 'identity', 'gzip;q=0', 'br']) {
      const r = await get('/big', ae ? { 'accept-encoding': ae } : {});
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.body.toString('utf8')).toBe(BIG);
    }
  });

  it(`leaves a body under ${MIN_COMPRESS_BYTES} bytes alone`, async () => {
    const r = await get('/small', { 'accept-encoding': 'gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body.toString('utf8')).toBe(SMALL);
  });

  it('answers a matching If-None-Match with a 304 and no body, and a stale one with the body', async () => {
    const first = await get('/big', { 'accept-encoding': 'gzip' });
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers['cache-control']).toBe('no-cache');
    const again = await get('/big', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    // The tag is the same whether or not the answer was gzipped.
    const plain = await get('/big', { 'if-none-match': etag });
    expect(plain.status).toBe(304);
    const stale = await get('/big', { 'accept-encoding': 'gzip', 'if-none-match': 'W/"something-else"' });
    expect(stale.status).toBe(200);
  });

  it('never compresses a response that sets a cookie', async () => {
    const r = await get('/cookie', { 'accept-encoding': 'gzip' });
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['etag']).toBeUndefined();
    expect(r.body.toString('utf8')).toBe(BIG);
  });

  it('keeps a Cache-Control the handler already chose', async () => {
    const r = await get('/policy');
    expect(r.headers['cache-control']).toBe('private, max-age=5');
  });

  it('does not compress or tag an error, and leaves HEAD without a body', async () => {
    const err = await get('/err', { 'accept-encoding': 'gzip' });
    expect(err.status).toBe(500);
    expect(err.headers['content-encoding']).toBeUndefined();
    expect(err.headers['etag']).toBeUndefined();
    const head = await get('/big', { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-encoding']).toBeUndefined();
    expect(head.body.length).toBe(0);
  });

  it('serves fixed content from a kept gzipped copy, identically each time', async () => {
    const a = await get('/fixed', { 'accept-encoding': 'gzip' });
    const b = await get('/fixed', { 'accept-encoding': 'gzip' });
    expect(a.headers['content-encoding']).toBe('gzip');
    expect(b.body.equals(a.body)).toBe(true);
    expect(gunzipSync(a.body).toString('utf8')).toBe(BIG);
  });
});
