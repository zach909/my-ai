/**
 * Instruction files and auto-memory.
 *
 * Instruction files tell the agent how a project works. They are read in layers, lowest priority first, so the
 * closest and most specific text comes last and wins a conflict:
 *
 *   managed (administrator)  ->  user (data folder)  ->  project root  ->  each folder down to the working one
 *
 * In every folder the first of these that exists is used, so a project written for another tool still works:
 * AGENTS.md, NEUROCLAW.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md.
 * A line `@relative/path.md` pulls in another file (inside the project, four levels deep, no loops).
 * Folders below the working one load when a file in them is touched (`forPath`), not all up front.
 *
 * Auto-memory is a small file of things worth keeping between sessions: how this project builds, a fix that
 * took a while to find, a preference the owner stated. Entries are short, de-duplicated, never contain
 * anything that looks like a secret, and the whole file is bounded.
 */
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { writeFileAtomic } from '../../models && skills/core/atomic-write.js';
import { confine, isInside, managedFile, projectId, workbenchRoot } from './paths.js';
import { looksSecret } from './text-utils.js';

export const INSTRUCTION_NAMES = ['AGENTS.md', 'NEUROCLAW.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'];
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 160 * 1024;
const MAX_IMPORT_DEPTH = 4;

export interface InstructionBlock { source: 'managed' | 'user' | 'project'; file: string; text: string }

function readCapped(file: string): string | null {
  try { const st = statSync(file); if (!st.isFile()) return null; const t = readFileSync(file, 'utf8'); return t.length > MAX_FILE ? t.slice(0, MAX_FILE) + '\n…(truncated)' : t; } catch { return null; }
}

function firstIn(dir: string): { file: string; text: string } | null {
  for (const n of INSTRUCTION_NAMES) {
    const f = path.join(dir, n);
    const t = readCapped(f);
    if (t !== null) return { file: f, text: t };
  }
  return null;
}

function expandImports(text: string, from: string, root: string, depth: number, seen: Set<string>): string {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  return text.split('\n').map(line => {
    const m = /^@([^\s@][^\s]*\.(?:md|txt))\s*$/.exec(line.trim());
    if (!m) return line;
    const abs = confine(root, path.resolve(path.dirname(from), m[1]));
    if (!abs || seen.has(abs)) return line;
    const t = readCapped(abs);
    if (t === null) return line;
    seen.add(abs);
    return expandImports(t, abs, root, depth + 1, seen);
  }).join('\n');
}

export class Instructions {
  private loaded = new Set<string>();
  constructor(private root: string, private opts: { userDir?: string; managed?: string } = {}) { this.root = path.resolve(root); }

  /** Everything that applies from the project root down to `cwd`, lowest priority first. */
  load(cwd: string = this.root): InstructionBlock[] {
    const blocks: InstructionBlock[] = [];
    const managed = this.opts.managed ?? path.join(path.dirname(managedFile()), 'INSTRUCTIONS.md');
    const m = readCapped(managed);
    if (m !== null) blocks.push({ source: 'managed', file: managed, text: m });
    const userDir = this.opts.userDir ?? workbenchRoot();
    const u = firstIn(userDir);
    if (u) blocks.push({ source: 'user', file: u.file, text: expandImports(u.text, u.file, path.dirname(u.file), 0, new Set([u.file])) });
    const abs = path.resolve(cwd);
    const chain: string[] = [];
    for (let d = isInside(this.root, abs) ? abs : this.root; ; d = path.dirname(d)) {
      chain.unshift(d);
      if (d === this.root || d === path.dirname(d)) break;
    }
    for (const dir of chain) {
      const f = firstIn(dir);
      if (!f) continue;
      this.loaded.add(dir);
      blocks.push({ source: 'project', file: f.file, text: expandImports(f.text, f.file, this.root, 0, new Set([f.file])) });
    }
    return blocks;
  }

  /** Instruction files in folders not loaded yet that lie between the project root and `file`. Call when a file is touched. */
  forPath(file: string): InstructionBlock[] {
    const abs = confine(this.root, file);
    if (!abs) return [];
    const out: InstructionBlock[] = [];
    const rel = path.relative(this.root, path.dirname(abs)).split(path.sep).filter(Boolean);
    let dir = this.root;
    for (const part of rel) {
      dir = path.join(dir, part);
      if (this.loaded.has(dir)) continue;
      this.loaded.add(dir);
      const f = firstIn(dir);
      if (f) out.push({ source: 'project', file: f.file, text: expandImports(f.text, f.file, this.root, 0, new Set([f.file])) });
    }
    return out;
  }

  /** The text to put in front of the agent, with each file named so a conflict can be traced. */
  render(blocks: InstructionBlock[]): string {
    let out = '';
    for (const b of blocks) {
      const piece = `# From ${b.source} instructions (${path.basename(b.file)})\n${b.text.trim()}\n\n`;
      if (out.length + piece.length > MAX_TOTAL) { out += '# (further instructions left out: over the size limit)\n'; break; }
      out += piece;
    }
    return out.trim();
  }
}

// ── Auto-memory ──────────────────────────────────────────────────────

export type MemoryKind = 'pattern' | 'fix' | 'preference' | 'note';
export interface MemoryEntry { kind: MemoryKind; text: string; at: string; hits: number }

export const MEMORY_MAX_ENTRIES = 200;
export const MEMORY_MAX_TEXT = 400;
export const MEMORY_MAX_BYTES = 48 * 1024;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string): Set<string> => new Set(norm(s).split(' ').filter(w => w.length > 2));

export class AutoMemory {
  private file: string;
  constructor(root: string, dataDir?: string) {
    this.file = path.join(workbenchRoot(dataDir), 'memory', `${projectId(path.resolve(root))}.jsonl`);
  }

  all(): MemoryEntry[] {
    try {
      return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as MemoryEntry; } catch { return null; } }).filter((e): e is MemoryEntry => !!e && typeof e.text === 'string');
    } catch { return []; }
  }

  /** Remember something. Returns why not when it was refused or a duplicate. */
  remember(kind: MemoryKind, text: string): { ok: boolean; reason?: string } {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_MAX_TEXT);
    if (t.length < 8) return { ok: false, reason: 'Too short to be worth keeping.' };
    if (looksSecret(t)) return { ok: false, reason: 'It looks like it contains a secret, so it was not saved.' };
    const entries = this.all();
    const key = norm(t);
    const dup = entries.find(e => norm(e.text) === key);
    if (dup) { dup.hits++; this.write(entries); return { ok: false, reason: 'Already remembered.' }; }
    entries.push({ kind, text: t, at: new Date().toISOString(), hits: 1 });
    this.write(entries);
    return { ok: true };
  }

  forget(match: string): number {
    if (norm(match).length < 3) return 0;
    const entries = this.all();
    const keep = entries.filter(e => !norm(e.text).includes(norm(match)));
    if (keep.length !== entries.length) this.write(keep);
    return entries.length - keep.length;
  }

  /** The entries that share the most words with a query, best first. */
  recall(query: string, limit = 8): MemoryEntry[] {
    const q = words(query);
    return this.all().map(e => { const w = words(e.text); let n = 0; for (const x of w) if (q.has(x)) n++; return { e, score: n * 2 + Math.min(e.hits, 5) * 0.1 }; })
      .filter(x => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.e);
  }

  render(entries: MemoryEntry[] = this.all().slice(-12)): string {
    return entries.length ? `# Remembered from earlier sessions\n${entries.map(e => `- (${e.kind}) ${e.text}`).join('\n')}` : '';
  }

  private write(entries: MemoryEntry[]): void {
    let list = entries;
    // Oldest, least-used first to go when over a bound.
    const size = (l: MemoryEntry[]) => l.reduce((n, e) => n + e.text.length + 60, 0);
    while (list.length > MEMORY_MAX_ENTRIES || size(list) > MEMORY_MAX_BYTES) {
      let worst = 0;
      list.forEach((e, i) => { if (e.hits < list[worst].hits || (e.hits === list[worst].hits && e.at < list[worst].at)) worst = i; });
      list = list.filter((_, i) => i !== worst);
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : ''));
  }
}
void appendFileSync; void existsSync;
