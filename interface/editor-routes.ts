/**
 * HTTP routes for the editor (/editor): see, change and double-check the text
 * files the agent can edit.
 *
 * Owner or admin only, behind the server's normal gate. Every change comes with
 * a line diff, and a save is read back from disk and compared, so a person (or
 * the agent) can see exactly what happened to the text and that it landed.
 *
 *   GET  /api/editor/files            editable files under the project, with their kind
 *   GET  /api/editor/file?path=       {path, kind, content, hash, readOnly}
 *   POST /api/editor/diff             {path, content}                     what a save would change
 *   POST /api/editor/edit             {path, old, new, apply?, baseHash?} exact replacement, previewed unless apply
 *   POST /api/editor/save             {path, content, baseHash}           write, read back, verify
 *
 * Guard files (the no-third-party check, hooks, allow-list), secrets, other
 * people's folders (.git, node_modules), binaries and anything over 512 KB are
 * never listed for writing. Paths are resolved inside the project root only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { codeRoot } from './platform/app-paths.js';
import { writeFileAtomic } from '../models && skills/core/atomic-write.js';
import { isOwnerOrAdmin } from '../models && skills/core/user-context.js';
import type { RouteContext } from './corona-routes.js';

export const MAX_EDIT_BYTES = 512 * 1024;
const MAX_LISTED = 3000;

/** Kept in step with GUARD_FILES in scripts/check-no-third-party.mjs; the owner alone changes these. */
const GUARD = new Set([
  'scripts/check-no-third-party.mjs', '.third-party-allowlist.json', '.claude/hooks/block-third-party.mjs',
  '.claude/settings.json', '.githooks/pre-commit', '.githooks/pre-push', '.github/workflows/no-third-party.yml',
  '.github/CODEOWNERS', 'test/core/no-third-party.test.ts', 'scripts/install-hooks.mjs',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'generated', 'training_data', '.venv', '__pycache__']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.jar', '.apk',
  '.bin', '.onnx', '.pt', '.safetensors', '.mp3', '.mp4', '.wav', '.woff', '.woff2', '.ttf', '.obj', '.so', '.dll', '.exe']);

export type EditorKind = 'json' | 'markdown' | 'code' | 'text';

export function kindOf(file: string): EditorKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.kt', '.java', '.swift', '.sh', '.css', '.html', '.yml', '.yaml', '.xml', '.svg'].includes(ext)) return 'code';
  return 'text';
}

const isSecret = (rel: string): boolean => {
  const name = path.basename(rel).toLowerCase();
  return name.startsWith('.env') || /\.(pem|key|p12|pfx)$/.test(name) || /(^|[-_.])(secret|credentials|token)s?\./.test(name);
};

export const isReadOnly = (rel: string): boolean => GUARD.has(rel);

/** Resolve a project-relative path to a real file inside the root, or say why not. */
export function resolveEditable(root: string, rel: unknown): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return { ok: false, reason: 'Give a file path.' };
  const clean = rel.split(path.sep).join('/').replace(/^\/+/, '');
  const parts = clean.split('/');
  if (parts.some(p => p === '..' || SKIP_DIRS.has(p))) return { ok: false, reason: 'That folder is not editable here.' };
  if (isSecret(clean)) return { ok: false, reason: 'Secrets are not shown or edited here.' };
  if (BINARY_EXT.has(path.extname(clean).toLowerCase())) return { ok: false, reason: 'That is a binary file, not text.' };
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false, reason: 'That path is outside the project.' };
  if (existsSync(abs)) {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, reason: 'That path leaves the project.' };
    if (!statSync(abs).isFile()) return { ok: false, reason: 'That is not a file.' };
  }
  return { ok: true, abs, rel: clean };
}

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface DiffLine { t: ' ' | '+' | '-'; a?: number; b?: number; s: string }
export interface DiffResult { lines: DiffLine[]; added: number; removed: number; same: boolean }

/** A line diff: common start and end trimmed, then a longest-common-subsequence on the middle (coarse above 4M cells). */
export function diffLines(before: string, after: string): DiffResult {
  const A = before.split('\n');
  const B = after.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const out: DiffLine[] = [];
  for (let i = 0; i < s; i++) out.push({ t: ' ', a: i + 1, b: i + 1, s: A[i] });
  const n = ea - s, m = eb - s;
  if (n * m > 4_000_000) {
    for (let i = s; i < ea; i++) out.push({ t: '-', a: i + 1, s: A[i] });
    for (let j = s; j < eb; j++) out.push({ t: '+', b: j + 1, s: B[j] });
  } else if (n || m) {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = A[s + i] === B[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[s + i] === B[s + j]) { out.push({ t: ' ', a: s + i + 1, b: s + j + 1, s: A[s + i] }); i++; j++; }
      else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { out.push({ t: '+', b: s + j + 1, s: B[s + j] }); j++; }
      else { out.push({ t: '-', a: s + i + 1, s: A[s + i] }); i++; }
    }
  }
  for (let k = 0; ea + k < A.length; k++) out.push({ t: ' ', a: ea + k + 1, b: eb + k + 1, s: A[ea + k] });
  const added = out.filter(l => l.t === '+').length;
  const removed = out.filter(l => l.t === '-').length;
  return { lines: out, added, removed, same: added === 0 && removed === 0 };
}

function listFiles(root: string): { path: string; size: number; kind: EditorKind; readOnly: boolean }[] {
  const found: { path: string; size: number; kind: EditorKind; readOnly: boolean }[] = [];
  const walk = (dir: string, rel: string): void => {
    if (found.length >= MAX_LISTED) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      if (found.length >= MAX_LISTED) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || isSecret(r) || BINARY_EXT.has(path.extname(r).toLowerCase())) continue;
      let size = 0;
      try { size = statSync(path.join(dir, e.name)).size; } catch { continue; }
      if (size > MAX_EDIT_BYTES) continue;
      found.push({ path: r, size, kind: kindOf(r), readOnly: isReadOnly(r) });
    }
  };
  walk(root, '');
  return found;
}

function readText(abs: string): { ok: true; text: string } | { ok: false; reason: string } {
  const st = statSync(abs);
  if (st.size > MAX_EDIT_BYTES) return { ok: false, reason: 'That file is over 512 KB.' };
  const buf = readFileSync(abs);
  if (buf.includes(0)) return { ok: false, reason: 'That file is binary, not text.' };
  return { ok: true, text: buf.toString('utf8') };
}

export const isEditorRoute = (p: string): boolean => p === '/api/editor' || p.startsWith('/api/editor/');

export interface EditorContext extends RouteContext {
  /** The project folder; defaults to the app's own. Tests pass a temp folder. */
  root?: string;
}

export async function handleEditorRoutes(ctx: EditorContext): Promise<boolean> {
  const { pathname, method, req, res } = ctx;
  if (!isEditorRoute(pathname)) return false;
  const json = (data: unknown, status = 200): true => { ctx.sendJson(res, data, status); return true; };
  try {
    if (!isOwnerOrAdmin()) return json({ error: 'Only the owner or an admin can use the editor.' }, 403);
    const root = path.resolve(ctx.root ?? codeRoot());
    const url = new URL(req.url ?? pathname, 'http://x');

    if (pathname === '/api/editor/files' && method === 'GET') return json({ files: listFiles(root), limit: MAX_LISTED });

    if (pathname === '/api/editor/file' && method === 'GET') {
      const r = resolveEditable(root, url.searchParams.get('path'));
      if (!r.ok) return json({ error: r.reason }, 400);
      if (!existsSync(r.abs)) return json({ error: 'No such file.' }, 404);
      const t = readText(r.abs);
      if (!t.ok) return json({ error: t.reason }, 400);
      return json({ path: r.rel, kind: kindOf(r.rel), content: t.text, hash: hashOf(t.text), readOnly: isReadOnly(r.rel) });
    }

    if (method !== 'POST') return json({ error: 'No such editor route.' }, 404);
    const b = await ctx.parseBody(req, MAX_EDIT_BYTES * 2 + 4096);
    const body = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    const r = resolveEditable(root, body.path);
    if (!r.ok) return json({ error: r.reason }, 400);
    const current = existsSync(r.abs) ? readText(r.abs) : { ok: true as const, text: '' };
    if (!current.ok) return json({ error: current.reason }, 400);

    if (pathname === '/api/editor/diff') {
      if (typeof body.content !== 'string') return json({ error: 'Give the new content.' }, 400);
      return json({ path: r.rel, hash: hashOf(current.text), diff: diffLines(current.text, body.content) });
    }

    // Shared write path: guard, size, stale-copy check, atomic write, read back.
    const write = (next: string, baseHash: unknown): true => {
      if (isReadOnly(r.rel)) return json({ ok: false, error: 'This file guards the no-third-party rule; only the owner edits it.' }, 403);
      if (Buffer.byteLength(next) > MAX_EDIT_BYTES) return json({ ok: false, error: 'That is over 512 KB.' }, 413);
      if (typeof baseHash === 'string' && existsSync(r.abs) && baseHash !== hashOf(current.text)) {
        return json({ ok: false, error: 'The file changed since you opened it. Reload it and redo the edit.', hash: hashOf(current.text) }, 409);
      }
      const diff = diffLines(current.text, next);
      try { writeFileAtomic(r.abs, next); } catch (err) {
        return json({ ok: false, error: `Could not save: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }
      const back = readText(r.abs);
      const verified = back.ok && back.text === next;
      return json({ ok: verified, verified, hash: back.ok ? hashOf(back.text) : null, diff, ...(verified ? {} : { error: 'Saved, but reading it back did not match.' }) }, verified ? 200 : 500);
    };

    if (pathname === '/api/editor/save') {
      if (typeof body.content !== 'string') return json({ error: 'Give the new content.' }, 400);
      return write(body.content, body.baseHash);
    }

    if (pathname === '/api/editor/edit') {
      if (typeof body.old !== 'string' || typeof body.new !== 'string' || !body.old) return json({ error: 'Give the exact text to replace (old) and what replaces it (new).' }, 400);
      const parts = current.text.split(body.old);
      if (parts.length === 1) return json({ ok: false, error: 'That text is not in the file.' }, 404);
      if (parts.length > 2) return json({ ok: false, error: `That text appears ${parts.length - 1} times; make it longer so it matches once.` }, 409);
      const next = parts[0] + body.new + parts[1];
      if (body.apply !== true) return json({ ok: true, applied: false, hash: hashOf(current.text), diff: diffLines(current.text, next) });
      return write(next, body.baseHash);
    }
    return json({ error: 'No such editor route.' }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
