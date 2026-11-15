/**
 * Prompt memory: a small stand-in for a big input to the Zip Loop.
 *
 * Feeding the mesh is slow (about 1.2 s per input byte on the live mesh), so a
 * large archive that is fed again and again, such as a long chat history, a
 * pile of notes or a project, costs the same minutes every time. This keeps, for
 * each such archive, a much smaller archive that makes the mesh give the same
 * output, and hands that one out instead.
 *
 *   big archive  --Zip Loop-->  output
 *   stand-in     --Zip Loop-->  the same output, or as close as was asked for
 *
 * The stand-in is an ordinary archive (a `ZipTree`, packed by `packZip` into the
 * same gzip the doorway always takes), so it looks like a zip to the loop and
 * nothing downstream has to know. It is made only by REMOVING things from the
 * big archive, never by writing new text, so everything in it was in the
 * original.
 *
 * It is found by trying. A candidate counts only if the real mesh, run on it,
 * gives the output the big archive gave. The search is delta debugging (drop
 * whole files, cut each file back to its tail, then drop runs of lines), which
 * needs few trials when most of the input is irrelevant, and a trial is
 * expensive, so it is capped (`maxTrials`, `maxMs`) and keeps the best stand-in
 * found so far whenever it stops.
 *
 * Three ways it can fool itself, each handled:
 *
 *   - The mesh gives a different output each time it is asked the same thing.
 *     The big archive is run twice; if the two disagree the stand-in only has to
 *     match as well as the big archive matches itself, and if they disagree a
 *     lot the search refuses ("unrepeatable").
 *   - The mesh ignores the input. If a scrambled copy of the archive (same size,
 *     every file reversed) gives output just as close, then ANY stand-in would
 *     match and a match proves nothing, so nothing is stored ("blind"). This is
 *     the same trap context-replay.ts guards against: with the Zip Loop's memory
 *     off, the mesh forgets everything but the last few bits within about 6
 *     ticks, and every long input looks alike.
 *   - The mesh changes. Weights move as it learns, so a stand-in is only known to
 *     match the mesh it was checked against. Each one carries that mesh's
 *     fingerprint and reports `stale` when the mesh is no longer the same.
 *
 * What a match does NOT prove: the stand-in is checked on the archive alone, and
 * on any `probes` the caller supplies (extra files appended, such as a question).
 * Anything else you add later was not checked. And it matches from the starting
 * state the runner uses for every trial.
 *
 * "Add extra talking to it, but it never changed": `use()` returns a fresh copy
 * with the extra files added. It refuses to overwrite a file the stand-in
 * already has, and the stored stand-in is never touched.
 *
 * Plain files on disk (one JSON per stand-in), per person, like memory-folders.
 * No libraries; the mesh is reached through the small `PromptRunner` seam so the
 * search can be tested against a toy.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./user-context.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write.js";
import { DEFAULT_HALT, packZip, runUntilStoppedAsync, unpackZip, type BitDoorway, type HaltConfig, type ZipTree } from "./zip-halt.js";

// ── Limits ────────────────────────────────────────────────────────────────

export const MAX_ENTRIES = 500;
/** Output bytes kept per stand-in for later comparison, and the most compared. */
export const OUTPUT_KEEP = 4096;
/** The biggest original that may be kept beside its stand-in. */
export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
/** Extra files sets a stand-in may be checked with. */
export const MAX_PROBES = 5;
const MAX_NAME = 60;

export class PromptMemoryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ── The seam to the mesh ──────────────────────────────────────────────────

export interface PromptRunner {
  /**
   * Feed one archive through the Zip Loop and return the bytes that came out.
   * Every call must start from the same state and leave the mesh as it found
   * it (no learning, no leftovers), or trials are not comparable.
   */
  run(tree: ZipTree): Promise<Uint8Array>;
  /** Names the mesh as it is now. Changes when its learned weights do. */
  fingerprint(): string;
}

/** What the live mesh gives the runner: the doorway, and a way to save and restore every neuron and connection. */
export interface MeshHandle {
  doorway: BitDoorway;
  capture(): unknown;
  /** True when it was put back whole. */
  restore(snapshot: unknown): boolean;
}

/** Parts of a snapshot that move on every tick and say nothing about what the mesh has learned. */
const TRANSIENT_STATE = new Set(["states", "energies", "emaEnergy", "hasEma", "sustainedDivergence"]);

/** A short name for what a mesh has learned: a digest of its snapshot without the parts that move every tick. */
export function meshFingerprint(snapshot: unknown): string {
  const hash = createHash("sha256");
  if (snapshot && typeof snapshot === "object") {
    for (const key of Object.keys(snapshot as Record<string, unknown>).sort()) {
      if (TRANSIENT_STATE.has(key)) continue;
      hash.update(key).update("\0").update(JSON.stringify((snapshot as Record<string, unknown>)[key]) ?? "").update("\0");
    }
  } else {
    hash.update(String(snapshot));
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * The live mesh as a runner. Every trial starts from the state the mesh was in
 * when this was made, and puts it back afterwards, because a run learns from
 * what it is given.
 *
 * `outputBytes` is the room the answer gets, the same for every trial. The halt
 * ceiling counts the input too, so a fixed ceiling would give a smaller
 * archive more room to talk and make its output longer for no good reason.
 */
export function doorwayRunner(mesh: MeshHandle, config: Partial<HaltConfig> & { outputBytes?: number } = {}): PromptRunner {
  const baseline = mesh.capture();
  const fingerprint = meshFingerprint(baseline);
  const { outputBytes = 64, ...halt } = config;
  return {
    fingerprint: () => fingerprint,
    async run(tree) {
      if (!mesh.restore(baseline)) throw new PromptMemoryError("The mesh would not go back to its starting state, so this trial cannot be compared.", 500);
      try {
        const maxTicks = halt.maxTicks ?? packZip(tree).length + Math.max(8, outputBytes);
        const result = await runUntilStoppedAsync(mesh.doorway, tree, { ...DEFAULT_HALT, ...halt, maxTicks });
        return result.raw;
      } finally {
        mesh.restore(baseline);
      }
    },
  };
}

// ── Trees ─────────────────────────────────────────────────────────────────

const cloneTree = (t: ZipTree): ZipTree => ({
  files: { ...t.files },
  ...(t.binary && Object.keys(t.binary).length > 0 ? { binary: { ...t.binary } } : {}),
});

/** What actually goes through the doorway. */
export const packedSize = (t: ZipTree): number => packZip(t).length;

const digestBytes = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const treeDigest = (t: ZipTree): string => digestBytes(packZip(t)).slice(0, 32);

function fileKeys(t: ZipTree): string[] {
  return [...Object.keys(t.files), ...Object.keys(t.binary ?? {})];
}

/** The tree with only these files. */
function keeping(t: ZipTree, keys: ReadonlySet<string>): ZipTree {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.files)) if (keys.has(k)) files[k] = v;
  const binary: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.binary ?? {})) if (keys.has(k)) binary[k] = v;
  return { files, ...(Object.keys(binary).length > 0 ? { binary } : {}) };
}

const withText = (t: ZipTree, key: string, text: string): ZipTree => ({ ...cloneTree(t), files: { ...t.files, [key]: text } });

const reversed = (s: string): string => Array.from(s).reverse().join("");

/** Same shape and size, nothing alike: every file written backwards. */
function scrambled(t: ZipTree): ZipTree {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.files)) files[k] = reversed(v);
  const binary: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.binary ?? {})) binary[k] = reversed(v);
  return { files, ...(Object.keys(binary).length > 0 ? { binary } : {}) };
}

/** The tree plus extra files. Never replaces a file the tree already has. */
export function addFiles(t: ZipTree, extra: Record<string, string>): ZipTree {
  const out = cloneTree(t);
  for (const [k, v] of Object.entries(extra)) {
    if (typeof k !== "string" || k.length === 0 || typeof v !== "string") throw new PromptMemoryError("Extra files must be names with text.");
    if (k in out.files || k in (out.binary ?? {})) throw new PromptMemoryError(`The stand-in already has ${k} and never changes it. Use another file name.`);
    out.files[k] = v;
  }
  return out;
}

// ── Comparing outputs ─────────────────────────────────────────────────────

const COMPARE_CAP = OUTPUT_KEEP;

function editDistance(a: Uint8Array, b: Uint8Array): number {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * How alike two outputs are, 0..1. 1 means the same bytes. Otherwise it is the
 * edit distance over the first OUTPUT_KEEP bytes (as a share of the longer),
 * scaled by how close the two lengths are, so an answer cut short does not
 * score as a near-match.
 */
export function outputSimilarity(a: Uint8Array, b: Uint8Array): number {
  if (a.length === b.length && Buffer.compare(a, b) === 0) return 1;
  const longest = Math.max(a.length, b.length);
  const shortest = Math.min(a.length, b.length);
  if (longest === 0) return 1;
  if (shortest === 0) return 0;
  const x = a.length > COMPARE_CAP ? a.subarray(0, COMPARE_CAP) : a;
  const y = b.length > COMPARE_CAP ? b.subarray(0, COMPARE_CAP) : b;
  const body = 1 - editDistance(x, y) / Math.max(x.length, y.length);
  return Math.max(0, body) * (shortest / longest);
}

// ── Delta debugging ───────────────────────────────────────────────────────

/**
 * The smallest subset of `items` that `test` still accepts, by delta debugging:
 * split into parts, keep a part alone if it passes, else drop a part if the
 * rest passes, else split finer. `test` is only ever called with a strict
 * subset of the current set, and stopping at any moment (`stop`) leaves the last
 * subset that passed. Assumes (like all of it) that removing things which
 * mattered fails and removing things which did not matter passes.
 */
async function ddmin<T>(items: T[], test: (subset: T[]) => Promise<boolean>, stop: () => boolean): Promise<T[]> {
  let current = items.slice();
  if (current.length === 0 || stop()) return current;
  // The biggest win and the cheapest question: does it need any of it?
  if (await test([])) return [];
  let parts = 2;
  while (current.length >= 2 && !stop()) {
    const size = Math.ceil(current.length / parts);
    const chunks: T[][] = [];
    for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (stop()) break;
      if (chunk.length < current.length && (await test(chunk))) {
        current = chunk;
        parts = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      for (let i = 0; i < chunks.length && !stop(); i++) {
        const rest = chunks.filter((_, j) => j !== i).flat();
        if (rest.length > 0 && rest.length < current.length && (await test(rest))) {
          current = rest;
          parts = Math.max(parts - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (parts >= current.length) break;
      parts = Math.min(current.length, parts * 2);
    }
  }
  return current;
}

/** A text as at most `max` pieces made of whole lines, in order, that join back to it. */
function linePieces(text: string, max: number): string[] {
  const lines = text.split(/(?<=\n)/);
  if (lines.length <= max) return lines;
  const per = Math.ceil(lines.length / max);
  const pieces: string[] = [];
  for (let i = 0; i < lines.length; i += per) pieces.push(lines.slice(i, i + per).join(""));
  return pieces;
}

/** The last `chars` characters of a text, starting on a line when there is one close by, never inside a surrogate pair. */
function tailOf(text: string, chars: number): string {
  if (chars >= text.length) return text;
  let cut = text.length - chars;
  const nl = text.indexOf("\n", cut);
  if (nl !== -1 && nl - cut < Math.max(80, chars / 8) && nl + 1 < text.length) cut = nl + 1;
  const code = text.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut++;
  return text.slice(cut);
}

// ── The search ────────────────────────────────────────────────────────────

export interface ShrinkOptions {
  /** How alike the outputs must be, 0..1. Default 1: the same bytes. Never asked for more than the mesh gives itself. */
  threshold?: number;
  /** The mesh disagreeing with itself more than this (by similarity) means nothing can be shown. Default 0.85. */
  minimum?: number;
  /** Most trial runs the search may spend, beyond the first few that set the target. Default 120. */
  maxTrials?: number;
  /** Longest the search may take. Default 30 minutes. */
  maxMs?: number;
  /** Extra files sets (a question, say) the stand-in must also match with. At most MAX_PROBES. */
  probes?: Array<Record<string, string>>;
  /** Test hook: the clock. */
  now?: () => number;
  /** Gives the event loop a turn between runs, so the server stays responsive. */
  yieldTo?: () => Promise<void>;
  /** Told after every run. */
  onProgress?: (p: ShrinkProgress) => void;
}

export interface ShrinkProgress {
  stage: "target" | "control" | "files" | "tails" | "lines";
  /** Mesh runs so far, all of them. */
  runs: number;
  /** Packed bytes of the smallest stand-in so far. */
  bestBytes: number;
}

export type ShrinkRefusal = "empty" | "unrepeatable" | "blind" | "no-shorter";

export type ShrinkOutcome =
  | {
      ok: true;
      tree: ZipTree;
      bigBytes: number;
      standInBytes: number;
      /** The weakest match over the archive and every probe. */
      similarity: number;
      /** What was asked for after allowing for the mesh not repeating itself. */
      threshold: number;
      /** How well the big archive matched itself on a second run. */
      noise: number;
      probes: number;
      /** Mesh runs, all of them. */
      runs: number;
      /** True when it stopped on the trial or time cap, so a smaller one may exist. */
      exhausted: boolean;
      /** What the stand-in makes the mesh say. */
      output: Uint8Array;
    }
  | { ok: false; reason: ShrinkRefusal; message: string; runs: number };

/**
 * Find a smaller archive that makes the mesh say the same thing as `big`.
 * Never changes `big` and never adds anything to it.
 */
export async function shrinkPrompt(runner: PromptRunner, big: ZipTree, opts: ShrinkOptions = {}): Promise<ShrinkOutcome> {
  const asked = Math.min(1, Math.max(0, opts.threshold ?? 1));
  const minimum = opts.minimum ?? 0.85;
  const maxTrials = Math.max(0, Math.floor(opts.maxTrials ?? 120));
  const maxMs = opts.maxMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;
  const yieldTo = opts.yieldTo ?? (() => new Promise<void>(r => setImmediate(r)));
  const probeSets = (opts.probes ?? []).slice(0, MAX_PROBES);

  const original = cloneTree(big);
  const bigBytes = packedSize(original);
  let runs = 0;
  const refuse = (reason: ShrinkRefusal, message: string): ShrinkOutcome => ({ ok: false, reason, message, runs });
  if (fileKeys(original).length === 0 || fileKeys(original).every(k => (original.files[k] ?? original.binary?.[k] ?? "") === "")) {
    return refuse("empty", "There is nothing in this archive to shrink.");
  }

  let best: { tree: ZipTree; bytes: number; similarity: number; output: Uint8Array } = { tree: original, bytes: bigBytes, similarity: 1, output: new Uint8Array(0) };
  let stage: ShrinkProgress["stage"] = "target";
  const run = async (tree: ZipTree): Promise<Uint8Array> => {
    runs++;
    const out = await runner.run(cloneTree(tree));
    opts.onProgress?.({ stage, runs, bestBytes: best.bytes });
    await yieldTo();
    return out;
  };

  // 1. What the big archive says, and whether it says it twice.
  const target = await run(original);
  const again = await run(original);
  const noise = outputSimilarity(target, again);
  if (noise < minimum) {
    return refuse("unrepeatable", `The mesh gave different answers to the same archive (${noise.toFixed(2)} alike), so a stand-in cannot be shown to match.`);
  }
  const need = Math.min(asked, noise);
  best = { ...best, output: target };

  const probeTargets: Uint8Array[] = [];
  for (const extra of probeSets) probeTargets.push(await run(addFiles(original, extra)));

  // 2. Does the input matter at all? A scrambled copy that scores as well as a stand-in would proves nothing.
  stage = "control";
  const control = scrambled(original);
  if (treeDigest(control) !== treeDigest(original)) {
    const controlOut = await run(control);
    if (outputSimilarity(controlOut, target) >= need) {
      return refuse("blind", "The mesh answered a scrambled copy of this archive just as it answered the real one, so it is not reacting to what is in it and any stand-in would match. Nothing stored. (With the Zip Loop's memory off, the mesh forgets all but the last few bits.)");
    }
  }

  // 3. The search. Only ever adopts something strictly smaller that still matches.
  const searchRuns = runs;
  const spent = (): number => runs - searchRuns;
  const started = now();
  const out = (): boolean => spent() >= maxTrials || now() - started > maxMs;
  const seen = new Map<string, boolean>();

  const attempt = async (tree: ZipTree): Promise<boolean> => {
    if (out()) return false;
    const bytes = packedSize(tree);
    if (bytes >= best.bytes) return false;
    const key = treeDigest(tree);
    const known = seen.get(key);
    if (known !== undefined) return false; // adopted or failed already; adopting it again is not smaller
    seen.set(key, false);
    const got = await run(tree);
    let similarity = outputSimilarity(got, target);
    if (similarity < need) return false;
    for (let i = 0; i < probeSets.length; i++) {
      if (out()) return false;
      similarity = Math.min(similarity, outputSimilarity(await run(addFiles(tree, probeSets[i])), probeTargets[i]));
      if (similarity < need) return false;
    }
    seen.set(key, true);
    best = { tree, bytes, similarity, output: got };
    return true;
  };

  // 3a. Whole files, biggest first so a big irrelevant one goes in the first cut.
  stage = "files";
  {
    const base = best.tree;
    const order = fileKeys(base).sort((a, b) => (base.files[b] ?? base.binary?.[b] ?? "").length - (base.files[a] ?? base.binary?.[a] ?? "").length || (a < b ? -1 : 1));
    await ddmin(order, subset => attempt(keeping(base, new Set(subset))), out);
  }

  // 3b. Each remaining text file back to its tail: the mesh hears the end of a message best.
  stage = "tails";
  for (const key of Object.keys(best.tree.files).sort((a, b) => best.tree.files[b].length - best.tree.files[a].length || (a < b ? -1 : 1))) {
    if (out()) break;
    const text = best.tree.files[key];
    if (text === undefined || text.length < 2) continue;
    let low = 0; // a tail this long failed (0: none has yet)
    let high = text.length; // the shortest tail that passed so far
    // Halve until it fails.
    while (!out() && Math.floor(high / 2) >= 1) {
      const len = Math.floor(high / 2);
      if (await attempt(withText(best.tree, key, tailOf(text, len)))) high = best.tree.files[key].length;
      else { low = len; break; }
    }
    // Then a few bisections between the last failure and the last pass.
    for (let step = 0; step < 4 && low > 0 && high - low > 1 && !out(); step++) {
      const mid = Math.floor((low + high) / 2);
      if (await attempt(withText(best.tree, key, tailOf(text, mid)))) high = best.tree.files[key].length;
      else low = mid;
    }
  }

  // 3c. Runs of lines inside what is left.
  stage = "lines";
  for (const key of Object.keys(best.tree.files).sort((a, b) => best.tree.files[b].length - best.tree.files[a].length || (a < b ? -1 : 1))) {
    if (out()) break;
    const base = best.tree;
    const pieces = linePieces(base.files[key], 256);
    if (pieces.length < 2) continue;
    await ddmin(pieces, subset => attempt(withText(base, key, subset.join(""))), out);
  }

  if (best.bytes >= bigBytes) {
    return refuse("no-shorter", `Nothing could be taken out without changing what the mesh says (${spent()} trials${out() ? ", and the search ran out of budget" : ""}).`);
  }
  return {
    ok: true,
    tree: cloneTree(best.tree),
    bigBytes,
    standInBytes: best.bytes,
    similarity: best.similarity,
    threshold: need,
    noise,
    probes: probeSets.length,
    runs,
    exhausted: out(),
    output: best.output,
  };
}

// ── Keeping stand-ins ─────────────────────────────────────────────────────

export interface PromptMemoryEntry {
  /** First 16 hex characters of the digest of the big archive as packed. Recording the same archive again replaces this. */
  id: string;
  name: string;
  createdAt: number;
  /** Last time this was shown to match the mesh. */
  verifiedAt: number;
  /** The mesh it was shown to match. */
  fingerprint: string;
  bigBytes: number;
  standInBytes: number;
  similarity: number;
  threshold: number;
  noise: number;
  probes: number;
  runs: number;
  exhausted: boolean;
  /** The first OUTPUT_KEEP bytes of what the stand-in made the mesh say, base64. */
  output: string;
  outputBytes: number;
  outputDigest: string;
  hasOriginal: boolean;
  tree: ZipTree;
}

export type PromptMemorySummary = Omit<PromptMemoryEntry, "tree" | "output"> & { stale: boolean | null };

export type RecordOutcome =
  | { ok: true; entry: PromptMemoryEntry; keptOriginal: boolean }
  | { ok: false; reason: ShrinkRefusal; message: string; runs: number };

/** "My Garden Chat!" -> "my-garden-chat". */
export function slugName(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/[-.]+$/g, "");
}

const ID = /^[a-f0-9]{16}$/;

export class PromptMemory {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(dataDir(), "prompt-memory");
  }

  /** The folder this person's stand-ins live in. */
  get location(): string {
    return this.root;
  }

  private file(id: string, ext: "json" | "big"): string {
    if (!ID.test(id)) throw new PromptMemoryError("That is not a stand-in id.");
    return path.join(this.root, `${id}.${ext}`);
  }

  private load(id: string): PromptMemoryEntry | null {
    try {
      const file = this.file(id, "json");
      if (!existsSync(file)) return null;
      const entry = JSON.parse(readFileSync(file, "utf8")) as PromptMemoryEntry;
      return entry && entry.id === id && entry.tree && typeof entry.tree.files === "object" ? entry : null;
    } catch (err) {
      if (err instanceof PromptMemoryError) throw err;
      return null; // a damaged file is a missing stand-in; record it again
    }
  }

  private ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).filter(id => ID.test(id));
  }

  count(): number {
    return this.ids().length;
  }

  /** Every stand-in, newest first, without their text. `runner` lets each say whether the mesh has changed since. */
  list(runner?: Pick<PromptRunner, "fingerprint">): PromptMemorySummary[] {
    const out: PromptMemorySummary[] = [];
    for (const id of this.ids()) {
      const entry = this.load(id);
      if (!entry) continue;
      const { tree: _tree, output: _output, ...rest } = entry;
      out.push({ ...rest, stale: runner ? runner.fingerprint() !== entry.fingerprint : null });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** By id, or by name. */
  get(idOrName: string): PromptMemoryEntry | null {
    const wanted = idOrName.trim();
    if (ID.test(wanted)) {
      const byId = this.load(wanted);
      if (byId) return byId;
    }
    const slug = slugName(wanted);
    if (!slug) return null;
    for (const id of this.ids()) {
      const entry = this.load(id);
      if (entry && entry.name === slug) return entry;
    }
    return null;
  }

  /**
   * Find a stand-in for `big` and keep it. Costs real mesh runs (see
   * shrinkPrompt), so the caller holds the doorway while this goes.
   */
  async record(
    runner: PromptRunner,
    big: ZipTree,
    opts: ShrinkOptions & { name?: string; keepOriginal?: boolean } = {},
  ): Promise<RecordOutcome> {
    const packed = packZip(big);
    const id = digestBytes(packed).slice(0, 16);
    const name = slugName(opts.name ?? "") || id;
    const existing = this.get(name);
    if (existing && existing.id !== id) throw new PromptMemoryError(`There is already a stand-in called ${name}.`, 409);
    if (!this.load(id) && this.count() >= MAX_ENTRIES) throw new PromptMemoryError(`Prompt memory is full (${MAX_ENTRIES}). Forget some first.`, 409);

    const outcome = await shrinkPrompt(runner, big, opts);
    if (outcome.ok === false) return outcome;

    const now = Date.now();
    const previous = this.load(id);
    const keepOriginal = opts.keepOriginal === true && packed.length <= MAX_ORIGINAL_BYTES;
    const entry: PromptMemoryEntry = {
      id,
      name,
      createdAt: previous?.createdAt ?? now,
      verifiedAt: now,
      fingerprint: runner.fingerprint(),
      bigBytes: outcome.bigBytes,
      standInBytes: outcome.standInBytes,
      similarity: outcome.similarity,
      threshold: outcome.threshold,
      noise: outcome.noise,
      probes: outcome.probes,
      runs: outcome.runs,
      exhausted: outcome.exhausted,
      output: Buffer.from(outcome.output.subarray(0, OUTPUT_KEEP)).toString("base64"),
      outputBytes: outcome.output.length,
      outputDigest: digestBytes(outcome.output),
      hasOriginal: keepOriginal,
      tree: outcome.tree,
    };
    mkdirSync(this.root, { recursive: true });
    if (keepOriginal) writeFileAtomic(this.file(id, "big"), Buffer.from(packed));
    else rmSync(this.file(id, "big"), { force: true });
    writeJsonAtomic(this.file(id, "json"), entry);
    return { ok: true, entry, keptOriginal: keepOriginal };
  }

  /**
   * The stand-in as it is to be fed, with extra files added. Always a fresh
   * copy; the stored one is never touched, and a file it already has is never
   * replaced. `stale` is true when the mesh is no longer the one it was checked
   * against (null when no runner was given to ask).
   */
  use(idOrName: string, extra: Record<string, string> = {}, runner?: Pick<PromptRunner, "fingerprint">): { id: string; tree: ZipTree; packedBytes: number; stale: boolean | null } {
    const entry = this.get(idOrName);
    if (!entry) throw new PromptMemoryError(`No stand-in called ${idOrName}.`, 404);
    const tree = addFiles(entry.tree, extra);
    return { id: entry.id, tree, packedBytes: packedSize(tree), stale: runner ? runner.fingerprint() !== entry.fingerprint : null };
  }

  /** Make the stand-in again from the original, on the mesh as it is now. Needs the original to have been kept. */
  async refresh(runner: PromptRunner, idOrName: string, opts: ShrinkOptions = {}): Promise<RecordOutcome> {
    const entry = this.get(idOrName);
    if (!entry) throw new PromptMemoryError(`No stand-in called ${idOrName}.`, 404);
    if (!entry.hasOriginal || !existsSync(this.file(entry.id, "big"))) {
      throw new PromptMemoryError("The original was not kept, so it cannot be checked again. Record it again from the original archive (keepOriginal keeps it).", 409);
    }
    if (statSync(this.file(entry.id, "big")).size > MAX_ORIGINAL_BYTES) throw new PromptMemoryError("The kept original is too large.", 409);
    const tree = unpackZip(new Uint8Array(readFileSync(this.file(entry.id, "big"))));
    if (!tree) throw new PromptMemoryError("The kept original could not be read.", 500);
    return this.record(runner, tree, { ...opts, name: entry.name, keepOriginal: true });
  }

  /** Forget one. True when there was one. */
  forget(idOrName: string): boolean {
    const entry = this.get(idOrName);
    if (!entry) return false;
    rmSync(this.file(entry.id, "json"), { force: true });
    rmSync(this.file(entry.id, "big"), { force: true });
    return true;
  }

  /** Forget everything (Delete all memory). Returns how many. */
  forgetAll(): number {
    const ids = this.ids();
    for (const id of ids) {
      rmSync(this.file(id, "json"), { force: true });
      rmSync(this.file(id, "big"), { force: true });
    }
    return ids.length;
  }
}
