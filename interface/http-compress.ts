/**
 * Smaller responses for the pages and JSON the server sends most: gzip when the
 * browser asks for it, and a content-hash ETag so an unchanged answer is a 304
 * with no body at all.
 *
 * Node built-ins only (node:zlib, node:crypto). Nothing about what a response
 * says changes; only how many bytes carry it.
 *
 *  - Only 200 answers to GET are compressed or tagged. HEAD, errors and 304s pass through.
 *  - Under 1 KB gzip costs more than it saves, so small bodies are sent as they are.
 *  - Anything that sets a cookie (login, sessions) is never compressed: secrets and
 *    attacker-influenced text in one compressed body is how BREACH-style attacks work.
 *  - The ETag is a hash of the exact bytes, so a 304 is correct for every viewer.
 *  - `Cache-Control: no-cache` is added when the caller did not choose a policy, so the
 *    browser keeps asking and gets the 304; it never reuses a body unasked.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type http from 'node:http';

/** Below this, gzip costs more than it saves. */
export const MIN_COMPRESS_BYTES = 1024;

/** Level 4: about 90% of level 6's saving for roughly half its CPU, which matters when a phone's server does it. */
const GZIP_LEVEL = 4;

/** Compressed copies of fixed content (the ambient assets), keyed by ETag. Bounded: it can never hold more than a handful. */
const STATIC_GZIP_MAX = 8;
const staticGzip = new Map<string, Buffer>();

/** A weak ETag for these exact bytes. Weak because the same bytes may go out gzipped or plain. */
export function contentEtag(body: string | Buffer): string {
  return 'W/"' + createHash('sha1').update(body).digest('base64url').slice(0, 22) + '"';
}

function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  for (const part of value.split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== 'x-gzip') continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  if (value.trim() === '*') return true;
  const weak = (t: string): string => t.trim().replace(/^W\//, '');
  return value.split(',').some(t => weak(t) === weak(etag));
}

export interface SendBodyOptions {
  /** Extra response headers (Cache-Control, ...). */
  headers?: Record<string, string>;
  /** Tag the body with its content hash and answer a matching If-None-Match with 304. */
  etag?: boolean | string;
  /** Remember the gzipped copy under the ETag (fixed content only). */
  cacheCompressed?: boolean;
}

/** Write one complete response, compressed and/or revalidated when that is safe. Never throws for a closed socket. */
export function sendBody(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  options: SendBodyOptions = {},
): void {
  const req = res.req as http.IncomingMessage | undefined;
  const method = req?.method?.toUpperCase() ?? 'GET';
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const headers: Record<string, string | number> = { 'Content-Type': contentType, ...options.headers };

  const eligible = status === 200 && method === 'GET' && !res.hasHeader('set-cookie');
  let tag: string | undefined;
  if (eligible && options.etag) {
    tag = typeof options.etag === 'string' ? options.etag : contentEtag(raw);
    headers['ETag'] = tag;
    // A policy the handler already chose (setHeader, or in `options.headers`) wins; writeHead would override it.
    if (!res.hasHeader('cache-control') && !Object.keys(headers).some(k => k.toLowerCase() === 'cache-control')) headers['Cache-Control'] = 'no-cache';
    if (etagMatches(req?.headers['if-none-match'], tag)) {
      const notModified: Record<string, string | number> = { ETag: tag, Vary: 'Accept-Encoding' };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cache-control') notModified[k] = headers[k];
      res.writeHead(304, notModified);
      res.end();
      return;
    }
  }

  let out = raw;
  if (eligible && raw.length >= MIN_COMPRESS_BYTES) {
    headers['Vary'] = 'Accept-Encoding';
    if (acceptsGzip(req?.headers['accept-encoding'])) {
      let zipped = options.cacheCompressed && tag ? staticGzip.get(tag) : undefined;
      if (!zipped) {
        zipped = gzipSync(raw, { level: GZIP_LEVEL });
        if (options.cacheCompressed && tag) {
          if (staticGzip.size >= STATIC_GZIP_MAX) staticGzip.delete(staticGzip.keys().next().value as string);
          staticGzip.set(tag, zipped);
        }
      }
      if (zipped.length < raw.length) {
        out = zipped;
        headers['Content-Encoding'] = 'gzip';
      }
    }
  }
  headers['Content-Length'] = out.length;
  res.writeHead(status, headers);
  res.end(out);
}
