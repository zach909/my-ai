/**
 * Checkpoints: undo, redo and rewind for what the agent does to files.
 *
 * One checkpoint per turn. Before the agent changes a file, `track(path)` saves what the file was (or that it did
 * not exist). Content goes in a content-addressed store (sha256, gzip), the way git keeps blobs, so an unchanged
 * file costs nothing twice. This is its own store, not a git repository, so it works in a folder that is not under
 * git and never touches the project's own history or index.
 *
 *   undo()      put back the files of the newest applied checkpoint (and remember how they were, for redo)
 *   redo()      apply the last undone checkpoint again
 *   rewind(id)  undo every checkpoint after `id` (code), optionally also say where the conversation should be cut
 *
 * Bounds: a file over 5 MB is not tracked (reported, not silently skipped), at most 200 checkpoints are kept, and the
 * store is trimmed to 300 MB oldest-first. Paths are confined to the project folder, symlinks are never followed
 * or restored, and restores are atomic writes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { confine, projectId, relPosix, workbenchRoot } from './paths.js';
import { renderDiff } from './diff.js';

export const MAX_TRACKED_FILE = 5 * 1024 * 1024;
export const MAX_CHECKPOINTS = 200;
export const MAX_STORE_BYTES = 300 * 1024 * 1024;

/** sha of the content, null when the file did not exist, 'symlink'/'toolarge' for what is not tracked. */
type Blob = string | null;

export interface Checkpoint {
  id: string;
  turn: number;
  label: string;
  at: string;
  /** How many messages the conversation held when the checkpoint began (for rewinding the conversation too). */
  messages: number;
  /** Each tracked file, as it was before the turn changed it. */
  before: Record<string, Blob>;
  /** Each tracked file, as it was after the turn: filled in when the turn ends. */
  after?: Record<string, Blob>;
  /** Set while the checkpoint is undone. */
  undone?: boolean;
}

interface Index { checkpoints: Checkpoint[]; turn: number }

export class CheckpointStore {
  private dir: string;
  private index: Index;
  private current: Checkpoint | null = null;
  readonly skipped: string[] = [];

  constructor(private root: string, dataDir?: string) {
    this.root = path.resolve(root);
    this.dir = path.join(workbenchRoot(dataDir), 'checkpoints', projectId(this.root));
    this.index = this.load();
  }

  private get indexFile(): string { return path.join(this.dir, 'index.json'); }

  private load(): Index {
    try { const v = JSON.parse(readFileSync(this.indexFile, 'utf8')); if (Array.isArray(v?.checkpoints)) return { checkpoints: v.checkpoints, turn: Number(v.turn) || 0 }; } catch { /* new */ }
    return { checkpoints: [], turn: 0 };
  }

  private save(): void { mkdirSync(this.dir, { recursive: true }); writeJsonAtomic(this.indexFile, this.index); }

  // ── blobs ──
  private blobPath(sha: string): string { return path.join(this.dir, 'objects', sha.slice(0, 2), sha.slice(2)); }

  private putBlob(data: Buffer): string {
    const sha = createHash('sha256').update(data).digest('hex');
    const p = this.blobPath(sha);
    if (!existsSync(p)) { mkdirSync(path.dirname(p), { recursive: true }); writeFileAtomic(p, gzipSync(data)); }
    return sha;
  }

  private getBlob(sha: string): Buffer {
    return gunzipSync(readFileSync(this.blobPath(sha)));
  }

  /** Read a file's current state as a blob id, without throwing. */
  private snapshotFile(abs: string): Blob | 'symlink' | 'toolarge' {
    let st;
    try { st = lstatSync(abs); } catch { return null; }
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isFile()) return 'symlink';
    if (st.size > MAX_TRACKED_FILE) return 'toolarge';
    return this.putBlob(readFileSync(abs));
  }

  // ── turns ──
  /** Start a checkpoint for a turn. Ends any turn still open. */
  begin(label: string, messages = 0): Checkpoint {
    this.end();
    // Starting a new turn after an undo discards what could have been redone.
    this.index.checkpoints = this.index.checkpoints.filter(c => !c.undone);
    this.index.turn++;
    const cp: Checkpoint = { id: randomBytes(5).toString('hex'), turn: this.index.turn, label: label.slice(0, 200), at: new Date().toISOString(), messages, before: {} };
    this.current = cp;
    return cp;
  }

  /** Call before changing a file. Safe to call many times; only the first call per turn records. */
  track(file: string): boolean {
    if (!this.current) this.begin('(untracked turn)');
    const abs = confine(this.root, file);
    if (!abs) { this.skipped.push(`${file}: outside the project, not tracked`); return false; }
    const rel = relPosix(this.root, abs);
    if (rel in this.current.before) return true;
    const snap = this.snapshotFile(abs);
    if (snap === 'symlink' || snap === 'toolarge') { this.skipped.push(`${rel}: ${snap === 'symlink' ? 'a link or special file' : 'over 5 MB'}, not tracked`); return false; }
    this.current.before[rel] = snap;
    return true;
  }

  /** Close the open turn: record how each tracked file ended up, and keep it if anything was tracked. */
  end(): Checkpoint | null {
    const cp = this.current;
    this.current = null;
    if (!cp) return null;
    if (Object.keys(cp.before).length === 0) return null;
    cp.after = {};
    for (const rel of Object.keys(cp.before)) {
      const snap = this.snapshotFile(path.join(this.root, rel));
      cp.after[rel] = snap === 'symlink' || snap === 'toolarge' ? null : snap;
    }
    this.index.checkpoints.push(cp);
    this.trim();
    this.save();
    return cp;
  }

  list(): Checkpoint[] { return this.index.checkpoints.map(c => ({ ...c })); }
  get open(): Checkpoint | null { return this.current; }

  private restore(files: Record<string, Blob>): string[] {
    const done: string[] = [];
    for (const [rel, sha] of Object.entries(files)) {
      const abs = confine(this.root, rel);
      if (!abs) continue;
      try {
        const st = (() => { try { return lstatSync(abs); } catch { return null; } })();
        if (st?.isSymbolicLink()) continue; // never write through a link that appeared since
        if (sha === null) { if (st) unlinkSync(abs); }
        else {
          mkdirSync(path.dirname(abs), { recursive: true });
          const mode = st?.mode;
          writeFileAtomic(abs, this.getBlob(sha));
          if (mode !== undefined) { try { chmodSync(abs, mode & 0o7777); } catch { /* best effort */ } }
        }
        done.push(rel);
      } catch { /* one file failing must not stop the rest; it is simply not listed */ }
    }
    return done;
  }

  /** Files changed outside the agent since the checkpoint ended: undoing would overwrite them. */
  private driftOf(cp: Checkpoint): string[] {
    if (!cp.after) return [];
    return Object.keys(cp.after).filter(rel => {
      const snap = this.snapshotFile(path.join(this.root, rel));
      return snap !== cp.after![rel] && snap !== 'symlink' && snap !== 'toolarge';
    });
  }

  undo(opts: { force?: boolean } = {}): { ok: boolean; checkpoint?: Checkpoint; files: string[]; drifted: string[]; reason?: string } {
    this.end();
    const applied = this.index.checkpoints.filter(c => !c.undone);
    const cp = applied[applied.length - 1];
    if (!cp) return { ok: false, files: [], drifted: [], reason: 'Nothing to undo.' };
    const drifted = this.driftOf(cp);
    if (drifted.length && !opts.force) return { ok: false, checkpoint: cp, files: [], drifted, reason: 'Some files changed since this checkpoint, so undoing would overwrite those changes. Undo again with force to do it anyway.' };
    const files = this.restore(cp.before);
    cp.undone = true;
    this.save();
    return { ok: true, checkpoint: cp, files, drifted };
  }

  redo(opts: { force?: boolean } = {}): { ok: boolean; checkpoint?: Checkpoint; files: string[]; reason?: string } {
    const undone = this.index.checkpoints.filter(c => c.undone);
    const cp = undone[0];
    if (!cp?.after) return { ok: false, files: [], reason: 'Nothing to redo.' };
    // Redo applies the oldest undone checkpoint; every file must still be as the undo left it.
    const drift = Object.keys(cp.before).filter(rel => {
      const snap = this.snapshotFile(path.join(this.root, rel));
      return snap !== cp.before[rel] && snap !== 'symlink' && snap !== 'toolarge';
    });
    if (drift.length && !opts.force) return { ok: false, checkpoint: cp, files: [], reason: `These files changed since the undo: ${drift.slice(0, 5).join(', ')}. Redo again with force to overwrite them.` };
    const files = this.restore(cp.after);
    cp.undone = false;
    this.save();
    return { ok: true, checkpoint: cp, files };
  }

  /** Undo every applied checkpoint newer than `id`. `id` itself stays applied. */
  rewind(id: string, opts: { force?: boolean } = {}): { ok: boolean; undone: number; messages?: number; files: string[]; reason?: string } {
    this.end();
    const target = this.index.checkpoints.find(c => c.id === id);
    if (!target) return { ok: false, undone: 0, files: [], reason: `No checkpoint ${id}.` };
    const files = new Set<string>();
    let undone = 0;
    for (;;) {
      const applied = this.index.checkpoints.filter(c => !c.undone);
      const last = applied[applied.length - 1];
      if (!last || last.id === id) break;
      const r = this.undo(opts);
      if (!r.ok) return { ok: false, undone, files: [...files], reason: r.reason };
      r.files.forEach(f => files.add(f));
      undone++;
    }
    return { ok: true, undone, messages: target.messages, files: [...files] };
  }

  /** What a checkpoint changed, as a text diff per file (bounded). */
  diff(id: string, maxFiles = 20): string {
    const cp = this.index.checkpoints.find(c => c.id === id);
    if (!cp) return '';
    const parts: string[] = [];
    for (const rel of Object.keys(cp.before).slice(0, maxFiles)) {
      const b = cp.before[rel], a = cp.after?.[rel] ?? null;
      const text = (sha: Blob) => sha === null ? '' : this.getBlob(sha).toString('utf8');
      parts.push(`--- ${rel}\n${renderDiff(text(b), text(a))}`);
    }
    return parts.join('\n');
  }

  private trim(): void {
    while (this.index.checkpoints.length > MAX_CHECKPOINTS) this.index.checkpoints.shift();
    const live = new Set<string>();
    for (const c of this.index.checkpoints) for (const m of [c.before, c.after ?? {}]) for (const v of Object.values(m)) if (v) live.add(v);
    // Remove blobs nothing refers to, then, if still over budget, drop the oldest checkpoints.
    const sizeOf = () => this.sweep(live);
    let size = sizeOf();
    while (size > MAX_STORE_BYTES && this.index.checkpoints.length > 1) {
      const dropped = this.index.checkpoints.shift()!;
      live.clear();
      for (const c of this.index.checkpoints) for (const m of [c.before, c.after ?? {}]) for (const v of Object.values(m)) if (v) live.add(v);
      void dropped;
      size = sizeOf();
    }
  }

  /** Delete unreferenced blobs; return the bytes that remain. */
  private sweep(live: Set<string>): number {
    let total = 0;
    const base = path.join(this.dir, 'objects');
    let shards: string[] = [];
    try { shards = readdirSync(base); } catch { return 0; }
    for (const s of shards) {
      const sd = path.join(base, s);
      let files: string[] = [];
      try { files = readdirSync(sd); } catch { continue; }
      for (const f of files) {
        const p = path.join(sd, f);
        if (!live.has(s + f)) { try { rmSync(p); } catch { /* ignore */ } continue; }
        try { total += statSync(p).size; } catch { /* ignore */ }
      }
    }
    return total;
  }
}
