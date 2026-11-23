// Shared helpers for the knowledge pipeline. Node built-ins only (repo rule: no packages, no third-party code).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
/** Everything downloaded or derived lives here; raw/ processed/ checkpoints/ are git-ignored. */
export const dataRoot = () => process.env.MYAI_KNOWLEDGE_DIR || path.join(REPO, 'training_data', 'knowledge');
export const dir = (...p) => { const d = path.join(dataRoot(), ...p); mkdirSync(d, { recursive: true }); return d; };

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const today = () => new Date().toISOString().slice(0, 10);

export function writeJson(file, obj) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export function writeJsonl(file, rows) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
export function readJsonl(file) { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }

/** RFC-4180-ish CSV parser (quotes, escaped quotes, newlines in fields). Returns array of rows. */
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}
export function csvObjects(text) { const [h, ...rest] = parseCsv(text); return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']))); }

/** Minimal tar reader (ustar) over a gunzipped buffer -> [{name, data}]. */
export function untar(buf) {
  const out = []; let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    if (type === '0' || type === '\0') out.push({ name, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}
export const untgz = (buf) => untar(zlib.gunzipSync(buf));

/** Minimal zip reader (central directory; stored + deflate) -> [{name, data}]. */
export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(lo + 26), lxl = buf.readUInt16LE(lo + 28), start = lo + 30 + lnl + lxl;
    const raw = buf.subarray(start, start + csize);
    if (!name.endsWith('/')) out.push({ name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const UA = 'my-ai-training-pipeline/1.0 (research; polite; contact: none)';

/** Fetch with retries and a hard timeout. Uses the environment proxy settings Node already honours via fetch. */
export async function fetchBuf(url, { tries = 3, timeoutMs = 120000, headers = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status} for ${url}`); e.status = r.status; e.fatal = true; throw e; }
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; if (e.fatal) break; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

export function stableId(...parts) { return sha256(parts.join('\u0001')).slice(0, 12); }
export { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, path };
