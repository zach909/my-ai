/**
 * File-format registry: which formats exist, what they are called and which files belong to them.
 *
 * The list comes from the owner's `training_data/file-formats/languages.yml` (845 entries: name,
 * type, extensions, filenames, aliases, interpreters). It is read as data at run time by the small
 * reader below, which handles exactly the shape that file has (top-level names, `key: value` lines,
 * and `- item` lists). No YAML library.
 *
 * Binary pictures are not in that list, so a few media formats are added here by hand: PNG, PPM,
 * PGM, PBM, BMP, the project's own "Text Twin", and three ways of writing raw bytes as text.
 *
 * Pure code, Node built-ins only.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FormatType = "data" | "programming" | "markup" | "prose" | "media";

export interface FormatInfo {
  name: string;
  type: FormatType;
  extensions: string[];
  filenames: string[];
  aliases: string[];
  interpreters: string[];
  group?: string;
  languageId?: number;
  /** "languages.yml" for the owner's list, "built-in" for the ones added in this file. */
  source: "languages.yml" | "built-in";
}

// ---------- the reader for languages.yml ----------

function scalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, s.lastIndexOf('"')); }
  }
  if (s.startsWith("'")) return s.slice(1, s.lastIndexOf("'")).replace(/''/g, "'");
  return s;
}

function stripKeyQuotes(key: string): string {
  return /^["'].*["']$/.test(key) ? scalar(key) : key;
}

/** Read the languages.yml shape. Throws with a line number on anything it does not understand. */
export function parseLanguagesYaml(text: string): FormatInfo[] {
  const out: FormatInfo[] = [];
  let cur: FormatInfo | null = null;
  let listKey: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    if (!raw.trim() || raw.trimStart().startsWith("#") || raw.trim() === "---") continue;
    if (!raw.startsWith(" ")) {
      const m = /^(.*):\s*$/.exec(raw);
      if (!m) throw new Error(`languages.yml line ${n + 1}: expected a name ending in ":" but got ${JSON.stringify(raw)}`);
      cur = { name: stripKeyQuotes(m[1]), type: "data", extensions: [], filenames: [], aliases: [], interpreters: [], source: "languages.yml" };
      out.push(cur);
      listKey = null;
      continue;
    }
    if (!cur) throw new Error(`languages.yml line ${n + 1}: indented line before any name`);
    const item = /^ {2}- ?(.*)$/.exec(raw);
    if (item) {
      if (!listKey) throw new Error(`languages.yml line ${n + 1}: list item with no list`);
      const v = scalar(item[1]);
      if (listKey === "extensions") cur.extensions.push(v);
      else if (listKey === "filenames") cur.filenames.push(v);
      else if (listKey === "aliases") cur.aliases.push(v);
      else if (listKey === "interpreters") cur.interpreters.push(v);
      continue;
    }
    const kv = /^ {2}([A-Za-z_0-9]+):(?: +(.*))?$/.exec(raw);
    if (!kv) throw new Error(`languages.yml line ${n + 1}: cannot read ${JSON.stringify(raw)}`);
    const [, key, value] = kv;
    if (value === undefined || value === "") { listKey = key; continue; }
    listKey = null;
    const v = scalar(value);
    if (key === "type" && (v === "data" || v === "programming" || v === "markup" || v === "prose")) cur.type = v;
    else if (key === "group") cur.group = v;
    else if (key === "language_id") cur.languageId = Number(v);
  }
  return out;
}

// ---------- formats added by hand ----------

const media = (name: string, extensions: string[], aliases: string[] = []): FormatInfo =>
  ({ name, type: "media", extensions, filenames: [], aliases, interpreters: [], source: "built-in" });

export const BUILT_IN_FORMATS: FormatInfo[] = [
  media("PNG", [".png"], ["png image"]),
  media("PPM", [".ppm", ".pnm"], ["netpbm", "portable pixmap"]),
  media("PGM", [".pgm"], ["portable graymap"]),
  media("PBM", [".pbm"], ["portable bitmap"]),
  media("BMP", [".bmp"], ["bitmap", "windows bitmap"]),
  media("Text Twin", [".twin"], ["twin", "text art", "ascii art"]),
  media("Hex Dump", [".hex"], ["hex", "hexadecimal"]),
  media("Base64", [".b64", ".base64"], ["b64"]),
  media("Bit String", [".bits"], ["bits", "binary text"]),
  media("Binary", [".bin"], ["raw", "bytes", "raw bytes"]),
];

/**
 * When one extension belongs to several formats, these are the ones a person almost always means.
 * Everything not listed falls back to "the format that lists it first, then the oldest GitHub id".
 */
const PREFERRED: Record<string, string> = {
  ".txt": "Text", ".h": "C", ".md": "Markdown", ".markdown": "Markdown", ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
  ".xml": "XML", ".html": "HTML", ".htm": "HTML", ".csv": "CSV", ".tsv": "TSV", ".sql": "SQL", ".ini": "INI", ".toml": "TOML",
  ".svg": "SVG", ".js": "JavaScript", ".ts": "TypeScript", ".py": "Python", ".rb": "Ruby", ".cs": "C#", ".php": "PHP",
  ".pl": "Perl", ".r": "R", ".rs": "Rust", ".go": "Go", ".java": "Java", ".c": "C", ".cpp": "C++", ".sh": "Shell",
  ".m": "Objective-C", ".mm": "Objective-C++", ".v": "Verilog", ".fs": "F#", ".ml": "OCaml", ".pro": "Prolog", ".cl": "Common Lisp",
  ".bas": "BASIC", ".d": "D", ".b": "Brainfuck", ".bf": "Brainfuck", ".inc": "PHP", ".s": "Assembly", ".asm": "Assembly",
  ".l": "Lex", ".y": "Yacc", ".t": "Perl", ".mod": "Modula-2", ".cls": "Apex", ".lisp": "Common Lisp", ".el": "Emacs Lisp",
  ".cfg": "INI", ".conf": "INI", ".bin": "Binary", ".properties": "Java Properties", ".env": "Dotenv", ".diff": "Diff", ".patch": "Diff",
};

// ---------- the registry ----------

const lower = (s: string): string => s.toLowerCase();
const normExt = (e: string): string => { const x = lower(e.trim()); return x.startsWith(".") ? x : "." + x; };

export class FormatRegistry {
  private list: FormatInfo[];
  private byName = new Map<string, FormatInfo>();
  private byAlias = new Map<string, FormatInfo>();
  private byExt = new Map<string, FormatInfo[]>();
  private byFile = new Map<string, FormatInfo[]>();

  constructor(list: FormatInfo[]) {
    this.list = list;
    for (const f of list) {
      this.byName.set(lower(f.name), f);
      for (const a of f.aliases) if (!this.byAlias.has(lower(a))) this.byAlias.set(lower(a), f);
      for (const e of f.extensions) {
        const k = normExt(e);
        const arr = this.byExt.get(k) ?? [];
        arr.push(f);
        this.byExt.set(k, arr);
      }
      for (const fn of f.filenames) {
        const arr = this.byFile.get(lower(fn)) ?? [];
        arr.push(f);
        this.byFile.set(lower(fn), arr);
      }
    }
  }

  static fromYaml(yamlText: string): FormatRegistry {
    return new FormatRegistry([...parseLanguagesYaml(yamlText), ...BUILT_IN_FORMATS]);
  }

  /** Read languages.yml from `file`, or from the repo's own copy when no path is given. */
  static load(file?: string): FormatRegistry {
    return FormatRegistry.fromYaml(readFileSync(file ?? defaultListPath(), "utf8"));
  }

  all(): FormatInfo[] { return this.list; }
  get size(): number { return this.list.length; }

  /** Every format that claims this extension, best guess first. */
  candidatesForExtension(ext: string): FormatInfo[] {
    const k = normExt(ext);
    const found = [...(this.byExt.get(k) ?? [])];
    const pref = PREFERRED[k];
    const rank = (f: FormatInfo): number => {
      if (pref && f.name === pref) return -2;
      if (normExt(f.extensions[0] ?? "") === k) return -1; // listed as its main extension
      return 0;
    };
    return found.sort((a, b) => rank(a) - rank(b) || (a.languageId ?? 1e12) - (b.languageId ?? 1e12));
  }

  /**
   * One format from whatever the caller typed: a name ("Python"), an alias ("py3"),
   * an extension ("py", ".py", ".blade.php") or an exact filename ("Dockerfile").
   */
  get(query: string): FormatInfo | null {
    const q = query.trim();
    if (!q) return null;
    const hit = this.byName.get(lower(q)) ?? this.byAlias.get(lower(q));
    if (hit) return hit;
    const ext = this.candidatesForExtension(q)[0];
    if (ext) return ext;
    return this.byFile.get(lower(q))?.[0] ?? null;
  }

  /**
   * Work out the format of a file from its name and, when given, its first bytes.
   * Longest extension wins (".blade.php" before ".php"); an exact filename beats any extension;
   * PNG / BMP / PPM signatures and a "#!" line are read from the bytes.
   */
  detect(filename: string, bytes?: Uint8Array): FormatInfo | null {
    const base = path.basename(filename);
    const named = this.byFile.get(lower(base))?.[0];
    if (named) return named;
    const dots: string[] = [];
    const parts = lower(base).split(".");
    for (let i = 1; i < parts.length; i++) dots.push("." + parts.slice(i).join("."));
    for (const e of dots) { // longest first
      const c = this.candidatesForExtension(e)[0];
      if (c) return c;
    }
    if (bytes && bytes.length >= 4) {
      const sig = sniff(bytes);
      if (sig) return this.get(sig);
      if (bytes[0] === 0x23 && bytes[1] === 0x21) { // "#!"
        const line = Buffer.from(bytes.subarray(0, 200)).toString("latin1").split("\n")[0];
        const words = line.replace(/^#!\s*/, "").split(/\s+/).map((w) => path.basename(w)).filter(Boolean);
        const word = words[0] === "env" ? words.find((w, i) => i > 0 && !w.startsWith("-")) : words[0];
        if (word) for (const f of this.list) if (f.interpreters.includes(word)) return f;
      }
    }
    return null;
  }
}

/** The signature of the binary picture formats we can read. */
export function sniff(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "PNG";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "BMP";
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x36) return "PPM";
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x33) return "PPM";
  if (b.length >= 2 && (b[0] === 0x50) && (b[1] === 0x35 || b[1] === 0x32)) return "PGM";
  if (b.length >= 2 && (b[0] === 0x50) && (b[1] === 0x34 || b[1] === 0x31)) return "PBM";
  return null;
}

/** Where the owner's copy of languages.yml lives, found from this file or from the working directory. */
export function defaultListPath(): string {
  const rel = path.join("training_data", "file-formats", "languages.yml");
  const here = (() => { try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } })();
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, rel);
    if (existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), rel);
}

let shared: FormatRegistry | null = null;
/** The registry built from the repo's own list, loaded once. */
export function formats(): FormatRegistry {
  return (shared ??= FormatRegistry.load());
}
