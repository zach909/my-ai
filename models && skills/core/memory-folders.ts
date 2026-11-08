/**
 * Topic memory: a folder tree of notes instead of one giant list.
 *
 * Long-term memory (long-term-memory.ts) is a single flat pile that is ranked
 * by similarity. That is right for "what do I know that resembles this", and
 * wrong for "what do I know about the user's garden project": the answer is
 * spread across dozens of unrelated-looking items and nothing says which ones
 * belong together. This is the other shape. Memory is a tree of folders, one
 * per topic, with small notes inside, and the folder names are the index:
 *
 *   people/
 *     alex.md
 *     mum/health.md
 *   projects/
 *     garden/plan.md
 *     garden/shopping.md
 *   preferences/coding.md
 *
 * The agent keeps it itself. It saves a note (replacing it), adds a dated line
 * to a note (the usual way to "update" something it learned today), moves a
 * note when a topic outgrows its folder, and forgets. It also searches it, by
 * topic words first (a match in a folder or note NAME counts for more than a
 * match in the body, because naming a thing is the strongest statement of what
 * it is about) and then by what the notes say.
 *
 * Plain markdown files on disk, one per note, so the owner can read them,
 * edit them in any editor, back them up or delete a folder by hand. Nothing is
 * kept only in RAM, so a restart loses nothing. Per person: the default root
 * is inside dataDir(), the same place the rest of a person's data lives.
 *
 * Safety. Every path the agent supplies is rewritten into plain lowercase
 * segments (letters, digits, dots and hyphens) before it touches the disk, a
 * segment can never be empty or "..", depth and size are capped, and a symlink
 * anywhere on the way is refused. A model that is confused or being steered by
 * text it read cannot write outside the tree, cannot fill the disk with one
 * call, and cannot read a file that is not a note.
 *
 * No libraries, no embeddings service: word overlap over what is on disk.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./user-context.js";
import { writeFileAtomic } from "./atomic-write.js";

export class MemoryFolderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface NoteInfo {
  /** Slash path without the .md, e.g. "projects/garden/plan". */
  path: string;
  title: string;
  /** Last change, ms since epoch. */
  updated: number;
  chars: number;
}

export interface TopicFolder {
  /** "" for the root. */
  path: string;
  name: string;
  notes: NoteInfo[];
  folders: TopicFolder[];
}

export interface Note extends NoteInfo {
  content: string;
}

export interface SearchHit extends NoteInfo {
  score: number;
  /** The line that matched best, trimmed. */
  snippet: string;
}

/** Folders deeper than this are a sign the agent is filing instead of thinking. */
export const MAX_DEPTH = 6;
export const MAX_SEGMENT = 60;
export const MAX_NOTE_CHARS = 50_000;
export const MAX_NOTES = 5_000;
const MAX_WRITE_CHARS = 20_000;
const SNIPPET = 160;

/**
 * Turns one name into a safe path segment, or null when nothing usable is left.
 * "My Garden Plan!" -> "my-garden-plan". ".." and "." come out empty.
 */
function slug(raw: string): string | null {
  const s = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_SEGMENT)
    .replace(/[-.]+$/g, "");
  return s.length > 0 ? s : null;
}

/** "Projects//Garden/Plan.md" -> ["projects", "garden", "plan"]. Throws on anything that cannot be a path. */
export function parsePath(raw: unknown, opts: { allowRoot?: boolean; note?: boolean } = {}): string[] {
  if (typeof raw !== "string") throw new MemoryFolderError("A path must be text.");
  const parts = raw.split(/[\\/]+/).map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length === 0) {
    if (opts.allowRoot) return [];
    throw new MemoryFolderError("A path is needed, like projects/garden/plan.");
  }
  if (parts.length > MAX_DEPTH) throw new MemoryFolderError(`Paths can be at most ${MAX_DEPTH} levels deep; keep topics broader.`);
  if (parts.some(p => p === ".." || p === ".")) throw new MemoryFolderError("Paths cannot contain . or ..");
  if (opts.note) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.md$/i, "");
  const out: string[] = [];
  for (const p of parts) {
    const s = slug(p);
    if (!s) throw new MemoryFolderError(`"${p}" has no usable letters or digits for a folder or note name.`);
    out.push(s);
  }
  return out;
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const titleFromName = (name: string): string => {
  const t = name.replace(/-/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function titleOf(content: string, name: string): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return m ? m[1].trim().slice(0, 120) : titleFromName(name);
}

export class MemoryFolders {
  /** `root` is a function so each call follows the current person (dataDir() changes per request). */
  constructor(private readonly root: () => string = () => path.join(dataDir(), "memory-topics")) {}

  // ── Paths ───────────────────────────────────────────────────────────

  /** Refuses a path whose existing parts include a symlink. */
  private guard(abs: string): string {
    const base = this.root();
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new MemoryFolderError("That path is outside memory.");
    let cur = base;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        return abs; // does not exist yet; nothing further down can be a link
      }
      if (st.isSymbolicLink()) throw new MemoryFolderError("Links are not followed inside memory.");
    }
    return abs;
  }

  private noteFile(parts: string[]): string {
    const dir = path.join(this.root(), ...parts.slice(0, -1));
    return this.guard(path.join(dir, `${parts[parts.length - 1]}.md`));
  }

  private folderDir(parts: string[]): string {
    return this.guard(path.join(this.root(), ...parts));
  }

  private isNote(parts: string[]): boolean {
    try {
      return statSync(this.noteFile(parts)).isFile();
    } catch {
      return false;
    }
  }

  private isFolder(parts: string[]): boolean {
    try {
      return statSync(this.folderDir(parts)).isDirectory();
    } catch {
      return false;
    }
  }

  // ── Reading ─────────────────────────────────────────────────────────

  private info(parts: string[], content: string, updated: number): NoteInfo {
    return { path: parts.join("/"), title: titleOf(content, parts[parts.length - 1]), updated, chars: content.length };
  }

  /** Every note under a folder, depth first, in name order. Skips links, dotfiles and anything that is not a .md file. */
  private walk(parts: string[] = []): Array<{ parts: string[]; content: string; updated: number }> {
    const out: Array<{ parts: string[]; content: string; updated: number }> = [];
    const visit = (dirParts: string[]): void => {
      let names: string[];
      try {
        names = readdirSync(path.join(this.root(), ...dirParts)).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const abs = path.join(this.root(), ...dirParts, name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (dirParts.length + 1 < MAX_DEPTH) visit([...dirParts, name]);
        } else if (st.isFile() && name.endsWith(".md") && st.size <= MAX_NOTE_CHARS * 4) {
          try {
            out.push({ parts: [...dirParts, name.slice(0, -3)], content: readFileSync(abs, "utf-8"), updated: st.mtimeMs });
          } catch {
            /* unreadable: not a note this run */
          }
        }
      }
    };
    visit(parts);
    return out;
  }

  /** The whole tree, or the subtree under `folder`. */
  tree(folder = ""): TopicFolder {
    const base = parsePath(folder, { allowRoot: true });
    if (base.length > 0 && !this.isFolder(base)) throw new MemoryFolderError(`There is no folder "${base.join("/")}".`, 404);
    const root: TopicFolder = { path: base.join("/"), name: base[base.length - 1] ?? "", notes: [], folders: [] };
    const index = new Map<string, TopicFolder>([[root.path, root]]);
    const ensure = (parts: string[]): TopicFolder => {
      const key = parts.join("/");
      let f = index.get(key);
      if (f) return f;
      f = { path: key, name: parts[parts.length - 1], notes: [], folders: [] };
      index.set(key, f);
      ensure(parts.slice(0, -1)).folders.push(f);
      return f;
    };
    for (const n of this.walk(base)) ensure(n.parts.slice(0, -1)).notes.push(this.info(n.parts, n.content, n.updated));
    // Empty folders still show: the agent may have just made one for a topic it is about to fill.
    const addEmpty = (dirParts: string[]): void => {
      let names: string[] = [];
      try {
        names = readdirSync(path.join(this.root(), ...dirParts));
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (name.startsWith(".") || dirParts.length + 1 >= MAX_DEPTH) continue;
        try {
          const abs = path.join(this.root(), ...dirParts, name);
          const st = lstatSync(abs);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            ensure([...dirParts, name]);
            addEmpty([...dirParts, name]);
          }
        } catch {
          /* gone */
        }
      }
    };
    addEmpty(base);
    const sortDeep = (f: TopicFolder): void => {
      f.folders.sort((a, b) => a.name.localeCompare(b.name));
      f.notes.sort((a, b) => a.path.localeCompare(b.path));
      f.folders.forEach(sortDeep);
    };
    sortDeep(root);
    return root;
  }

  read(notePath: string): Note {
    const parts = parsePath(notePath, { note: true });
    const file = this.noteFile(parts);
    let content: string;
    let updated: number;
    try {
      content = readFileSync(file, "utf-8");
      updated = statSync(file).mtimeMs;
    } catch {
      throw new MemoryFolderError(`There is no note "${parts.join("/")}".`, 404);
    }
    return { ...this.info(parts, content, updated), content };
  }

  count(): number {
    return this.walk().length;
  }

  // ── Searching ───────────────────────────────────────────────────────

  /**
   * Notes ranked by how well they answer a few words. A word found in a folder
   * or note NAME counts most, then the note's title, then the body (a few
   * repeats help, more do not, so a long note is not favoured for being long).
   */
  search(query: string, topK = 5): SearchHit[] {
    const q = [...new Set(words(query))].filter(w => w.length > 1 || /\d/.test(w));
    if (q.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const n of this.walk()) {
      const nameWords = new Set(words(n.parts.join(" ")));
      const title = titleOf(n.content, n.parts[n.parts.length - 1]);
      const titleWords = new Set(words(title));
      const bodyWords = words(n.content);
      const body = new Map<string, number>();
      for (const w of bodyWords) body.set(w, (body.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        if (nameWords.has(w)) score += 3;
        if (titleWords.has(w)) score += 2;
        score += Math.min(body.get(w) ?? 0, 3) / 3;
      }
      if (score <= 0) continue;
      hits.push({ ...this.info(n.parts, n.content, n.updated), score: Math.round((score / (q.length * 6)) * 1000) / 1000, snippet: snippetFor(n.content, q) });
    }
    return hits.sort((a, b) => b.score - a.score || b.updated - a.updated).slice(0, Math.max(1, Math.min(topK, 50)));
  }

  /** Lines for the agent's perception step: where a note lives and the part that matched. */
  digest(query: string, limit = 5): string[] {
    return this.search(query, limit).map(h => `memory/${h.path}: ${h.title} — ${h.snippet}`);
  }

  // ── Writing ─────────────────────────────────────────────────────────

  private ensureRoom(isNew: boolean): void {
    if (isNew && this.count() >= MAX_NOTES) throw new MemoryFolderError(`Memory holds ${MAX_NOTES} notes already; merge or forget some first.`, 507);
  }

  /** Create a note, or replace it. A heading is added when the text does not start with one. */
  write(notePath: string, content: string): Note {
    const parts = parsePath(notePath, { note: true });
    if (typeof content !== "string" || content.trim().length === 0) throw new MemoryFolderError("A note needs some text.");
    if (content.length > MAX_WRITE_CHARS) throw new MemoryFolderError(`A note can be at most ${MAX_WRITE_CHARS} characters; split it into subtopics.`);
    if (this.isFolder(parts)) throw new MemoryFolderError(`"${parts.join("/")}" is a folder; pick a note name inside it.`);
    for (let i = 1; i < parts.length; i++) {
      if (this.isNote(parts.slice(0, i))) throw new MemoryFolderError(`"${parts.slice(0, i).join("/")}" is a note, so it cannot also hold other notes.`);
    }
    this.ensureRoom(!this.isNote(parts));
    const body = content.trim();
    const text = (/^#\s/.test(body) ? body : `# ${titleFromName(parts[parts.length - 1])}\n\n${body}`) + "\n";
    const file = this.noteFile(parts);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text);
    return this.read(parts.join("/"));
  }

  /** Add one dated line to a note, making the note if needed. The everyday way to "update". */
  append(notePath: string, line: string, now: Date = new Date()): Note {
    const parts = parsePath(notePath, { note: true });
    if (typeof line !== "string" || line.trim().length === 0) throw new MemoryFolderError("There is nothing to add.");
    const clean = line.trim().replace(/\s*\n\s*/g, " ").slice(0, 2000);
    const entry = `- ${now.toISOString().slice(0, 10)}: ${clean}`;
    if (!this.isNote(parts)) return this.write(parts.join("/"), entry);
    const existing = this.read(parts.join("/")).content.replace(/\s+$/, "");
    if (existing.length + entry.length + 1 > MAX_NOTE_CHARS) {
      throw new MemoryFolderError(`"${parts.join("/")}" is full (${MAX_NOTE_CHARS} characters). Move older lines into a subtopic and trim it.`);
    }
    writeFileAtomic(this.noteFile(parts), `${existing}\n${entry}\n`);
    return this.read(parts.join("/"));
  }

  /** Rename or re-file a note or a whole folder. Never overwrites. */
  move(from: string, to: string): { from: string; to: string; kind: "note" | "folder" } {
    const a = parsePath(from, { note: true });
    const b = parsePath(to, { note: true });
    const kind = this.isNote(a) ? "note" : this.isFolder(a) ? "folder" : null;
    if (!kind) throw new MemoryFolderError(`There is nothing at "${a.join("/")}".`, 404);
    if (a.join("/") === b.join("/")) throw new MemoryFolderError("That is already where it is.");
    if (kind === "folder" && b.join("/").startsWith(`${a.join("/")}/`)) throw new MemoryFolderError("A folder cannot move into itself.");
    if (this.isNote(b) || this.isFolder(b)) throw new MemoryFolderError(`"${b.join("/")}" already exists; pick another name.`, 409);
    for (let i = 1; i < b.length; i++) {
      if (this.isNote(b.slice(0, i))) throw new MemoryFolderError(`"${b.slice(0, i).join("/")}" is a note, so it cannot also hold other notes.`);
    }
    const src = kind === "note" ? this.noteFile(a) : this.folderDir(a);
    const dst = kind === "note" ? this.noteFile(b) : this.folderDir(b);
    mkdirSync(path.dirname(dst), { recursive: true });
    renameSync(src, dst);
    this.prune(a.slice(0, -1));
    return { from: a.join("/"), to: b.join("/"), kind };
  }

  /** Forget a note, or a folder. A folder with notes in it needs `recursive`. Returns how many notes went. */
  remove(target: string, opts: { recursive?: boolean } = {}): number {
    const parts = parsePath(target, { note: true });
    if (this.isNote(parts)) {
      rmSync(this.noteFile(parts), { force: true });
      this.prune(parts.slice(0, -1));
      return 1;
    }
    if (this.isFolder(parts)) {
      const n = this.walk(parts).length;
      if (n > 0 && !opts.recursive) {
        throw new MemoryFolderError(`"${parts.join("/")}" holds ${n} note${n === 1 ? "" : "s"}; forgetting a whole folder needs recursive.`, 409);
      }
      rmSync(this.folderDir(parts), { recursive: true, force: true });
      this.prune(parts.slice(0, -1));
      return n;
    }
    throw new MemoryFolderError(`There is nothing at "${parts.join("/")}".`, 404);
  }

  /** Everything. Used by "delete all memory"; returns how many notes there were. */
  forgetAll(): number {
    const n = this.count();
    rmSync(this.root(), { recursive: true, force: true });
    return n;
  }

  /** Remove folders left empty by a move or a forget, up to but not including the root. */
  private prune(dirParts: string[]): void {
    for (let i = dirParts.length; i > 0; i--) {
      const dir = path.join(this.root(), ...dirParts.slice(0, i));
      try {
        if (!existsSync(dir) || readdirSync(dir).length > 0) return;
        rmdirSync(dir);
      } catch {
        return;
      }
    }
  }

  // ── For the agent ───────────────────────────────────────────────────

  /** A compact outline the agent can read before choosing where to file something. */
  outline(): string {
    const t = this.tree();
    if (t.folders.length === 0 && t.notes.length === 0) return "Memory is empty.";
    const lines: string[] = [];
    const show = (f: TopicFolder, depth: number): void => {
      const pad = "  ".repeat(depth);
      for (const n of f.notes) lines.push(`${pad}${n.path.split("/").pop()}  (${n.title})`);
      for (const sub of f.folders) {
        lines.push(`${pad}${sub.name}/`);
        show(sub, depth + 1);
      }
    };
    show(t, 0);
    return lines.join("\n");
  }
}

function snippetFor(content: string, q: string[]): string {
  const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !/^#\s/.test(l));
  let best = lines[0] ?? "";
  let bestN = -1;
  for (const l of lines) {
    const set = new Set(words(l));
    const n = q.filter(w => set.has(w)).length;
    if (n > bestN) {
      best = l;
      bestN = n;
    }
  }
  return best.length > SNIPPET ? `${best.slice(0, SNIPPET - 1)}…` : best;
}
