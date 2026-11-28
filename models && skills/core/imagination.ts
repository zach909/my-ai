/**
 * Imagination and reconstructive recall.
 *
 * Two facts about how a brain works, built into the one mesh:
 *
 *  1. Recalling a memory is not replaying a recording. It is rebuilding the
 *     memory from pieces, and each rebuild is carried by different neurons.
 *  2. Imagination is the same machinery pointed at things that never happened
 *     together: take pieces of memories chosen at random and put them together.
 *
 * How it is built here.
 *
 * A memory is spread over a pool of the mesh's neurons. No neuron holds the
 * whole thing: each holds a noisy partial view of it (a random fraction of its
 * dimensions, each with a little error). To recall, a fresh random subset of
 * the pool is driven (`setNeuronState`), the memory is read back off those
 * neurons, and the views are averaged. The subset is different every time, and
 * a recall never uses the same set as the one before it, so every rebuild comes
 * from different neurons and lands a little differently. How different is
 * reported with each recall (`error`, `gaps`), not hidden.
 *
 * Imagining recalls a few real memories chosen at random, each through its own
 * random neurons, and cuts them together dimension by dimension. The result is
 * scored for how new it is (distance from the nearest memory held) and carries
 * the memories it came from.
 *
 * Rules this keeps, because they are the ways this goes wrong:
 *  - An imagined thing is tagged `imagined` and is only kept if the caller says
 *    so (`keep`). Even then it stays tagged, so it is never mistaken for
 *    something that happened.
 *  - Imagination draws only from real memories unless told otherwise, so
 *    imagined things do not feed on each other and drift.
 *  - Recalling and imagining leave the mesh as they found it: the pool neurons
 *    are put back exactly. Nothing here changes any weight or any connection.
 *  - Bounded: at most `capacity` memories (imagined ones are dropped first).
 *    Held in memory only; nothing is written to disk.
 *
 * What this is not. It does not run the mesh's own dynamics on the result
 * (the live mesh forgets a neuron's state within a few ticks, so the trace
 * lives here and the mesh carries it only while it is read). It does not turn a
 * pattern back into words: the mesh has not been taught to write, so an
 * imagination is a pattern plus the labels of its parents. And it is a model of
 * the two facts above, not of the brain.
 *
 * No tokenizer and nothing outside the repo: text goes through the project's
 * own `embedText` (hashed byte n-grams), randomness through its own `makeRng`.
 */

import type { HyperDimensionalEngine } from "./onebrain.js";
import { embedText } from "./neuro-lang.js";
import { makeRng } from "./stroke-glyphs.js";

/** The first pool neuron. Ids below this belong to the Zip Loop doorway (0 to 5) and its neighbours. */
const POOL_START = 8;

export interface ImaginationOptions {
  /** Neurons that carry memories. Default: every neuron from id 8 up. */
  neurons?: number[];
  /** Fraction of a memory's dimensions that each neuron holds. Default 0.25. */
  coverage?: number;
  /** Fraction of the pool one recall drives. Default 0.5. */
  recallFraction?: number;
  /** Error in each neuron's view of a memory (standard deviation). Default 0.1. */
  viewNoise?: number;
  /** Most memories held. Default 256. */
  capacity?: number;
  /** A fixed seed makes every choice repeatable. Default: a fresh seed each run. */
  seed?: number;
}

export type MemorySource = "real" | "imagined";

/** What one neuron holds of one memory. */
interface View {
  dims: Int32Array;
  values: Float32Array;
}

interface Trace {
  id: string;
  label: string;
  source: MemorySource;
  /** The clean pattern. Used to find a memory from a cue and to score novelty, never to produce a recall. */
  index: Float32Array;
  views: Map<number, View>;
  parents: string[];
  seq: number;
}

export interface Recall {
  id: string;
  label: string;
  source: MemorySource;
  /** The memory as rebuilt this time, in [-1, 1]. Dimensions no driven neuron covered are 0. */
  pattern: Float32Array;
  /** The neurons that carried this recall, ascending. */
  neurons: number[];
  /** Dimensions that none of the driven neurons covered (left at 0, not guessed). */
  gaps: number;
  /** How far the rebuild is from the clean memory: 1 - cosine. 0 is exact. */
  error: number;
}

export interface Imagined {
  /** The new pattern, in [-1, 1]. */
  pattern: Float32Array;
  /** The real memories it was cut from, and the share of the dimensions each gave. */
  parents: Array<{ id: string; label: string; share: number }>;
  /** 1 - cosine to the nearest memory held. 0 is a copy of one; near 1 is unlike anything held. */
  novelty: number;
  /** Every neuron that carried any part of it, ascending. */
  neurons: number[];
  /** Always true: this never happened. */
  imagined: true;
}

export interface ImagineOptions {
  /** How many memories to put together (2 to 6). Default 3. */
  parents?: number;
  /** Also draw from imagined memories that were kept. Default false. */
  includeImagined?: boolean;
  /** Try again if the result is closer than this to a memory held. Default 0.05. */
  minNovelty?: number;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Scale into [-1, 1] by the largest magnitude (the mesh clamps neuron content to that range). */
function toUnit(v: ArrayLike<number>, dims: number): Float32Array {
  const out = new Float32Array(dims);
  let peak = 0;
  for (let i = 0; i < dims; i++) {
    const x = Number.isFinite(v[i]) ? v[i] : 0;
    out[i] = x;
    if (Math.abs(x) > peak) peak = Math.abs(x);
  }
  if (peak > 0) for (let i = 0; i < dims; i++) out[i] /= peak;
  return out;
}

export class Imagination {
  private readonly pool: number[];
  private readonly dims: number;
  private readonly coverage: number;
  private readonly recallFraction: number;
  private readonly viewNoise: number;
  private readonly capacity: number;
  private readonly rand: () => number;
  private readonly traces = new Map<string, Trace>();
  /** The neurons each memory's last recall used, so the next one differs. */
  private readonly lastUsed = new Map<string, string>();
  private seq = 0;

  constructor(private readonly engine: HyperDimensionalEngine, opts: ImaginationOptions = {}) {
    this.dims = engine.getDimensions();
    const count = engine.getNeuronCount();
    const wanted = opts.neurons ?? Array.from({ length: Math.max(0, count - POOL_START) }, (_, i) => POOL_START + i);
    this.pool = [...new Set(wanted)].filter(id => Number.isInteger(id) && id >= 0 && id < count).sort((a, b) => a - b);
    if (this.pool.length < 4) throw new Error("imagination needs at least 4 neurons to spread a memory over");
    this.coverage = Math.min(1, Math.max(0.05, opts.coverage ?? 0.25));
    this.recallFraction = Math.min(1, Math.max(0.1, opts.recallFraction ?? 0.5));
    this.viewNoise = Math.max(0, opts.viewNoise ?? 0.1);
    this.capacity = Math.max(2, Math.floor(opts.capacity ?? 256));
    this.rand = makeRng(opts.seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0 || 1));
  }

  size(): number {
    return this.traces.size;
  }

  /** The neurons that carry memories. */
  neurons(): number[] {
    return [...this.pool];
  }

  /** Remember something that happened. A string goes through `embedText`; a vector is used as it is. */
  remember(label: string, content: string | ArrayLike<number>, id?: string): string {
    const raw = typeof content === "string" ? embedText(content, this.dims) : content;
    return this.insert({
      id: id ?? `m${++this.seq}`,
      label,
      source: "real",
      index: toUnit(raw, this.dims),
      parents: [],
    });
  }

  /** Find memories for a cue, best first. Real memories and kept imaginations are both listed, each with its source. */
  find(cue: string | ArrayLike<number>, topK = 3): Array<{ id: string; label: string; source: MemorySource; similarity: number }> {
    const q = typeof cue === "string" ? embedText(cue, this.dims) : cue;
    const hits: Array<{ id: string; label: string; source: MemorySource; similarity: number }> = [];
    for (const t of this.traces.values()) hits.push({ id: t.id, label: t.label, source: t.source, similarity: cosine(q, t.index) });
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, Math.max(0, topK));
  }

  /**
   * Rebuild a memory. A fresh random subset of the pool carries it, never the
   * same subset as this memory's previous recall. Returns null for an unknown id.
   */
  recall(id: string): Recall | null {
    const trace = this.traces.get(id);
    if (!trace) return null;
    const k = Math.max(2, Math.round(this.pool.length * this.recallFraction));
    let chosen = this.sample(k);
    const key = (ids: number[]) => ids.join(",");
    // A subset equal to the last one would be the same recall twice. With a pool of any size this almost never
    // happens; the loop makes "different neurons each time" a rule rather than a likelihood.
    for (let tries = 0; tries < 8 && this.lastUsed.get(id) === key(chosen); tries++) chosen = this.sample(k);
    this.lastUsed.set(id, key(chosen));
    return this.rebuild(trace, chosen);
  }

  /**
   * Put memories together that never happened together. Returns null when
   * there are fewer than two memories to draw from.
   */
  imagine(opts: ImagineOptions = {}): Imagined | null {
    const sources = [...this.traces.values()].filter(t => opts.includeImagined || t.source === "real");
    const want = Math.min(6, Math.max(2, Math.floor(opts.parents ?? 3)));
    if (sources.length < 2) return null;
    const take = Math.min(want, sources.length);
    const minNovelty = opts.minNovelty ?? 0.05;

    let best: Imagined | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const picked = this.drawDistinct(sources, take);
      const parts = picked.map(t => this.rebuild(t, this.sample(Math.max(2, Math.round(this.pool.length * this.recallFraction)))));
      const pattern = new Float32Array(this.dims);
      const gave = new Array<number>(parts.length).fill(0);
      for (let d = 0; d < this.dims; d++) {
        // Take each dimension from one parent, chosen at random: pieces of each stay sharp,
        // where averaging them would wash every one of them out.
        const who = Math.min(parts.length - 1, Math.floor(this.rand() * parts.length));
        pattern[d] = parts[who].pattern[d];
        gave[who]++;
      }
      let nearest = 0;
      for (const t of this.traces.values()) nearest = Math.max(nearest, cosine(pattern, t.index));
      const neurons = [...new Set(parts.flatMap(p => p.neurons))].sort((a, b) => a - b);
      const candidate: Imagined = {
        pattern,
        parents: picked.map((t, i) => ({ id: t.id, label: t.label, share: gave[i] / this.dims })),
        novelty: Math.max(0, 1 - nearest),
        neurons,
        imagined: true,
      };
      if (!best || candidate.novelty > best.novelty) best = candidate;
      if (candidate.novelty >= minNovelty) return candidate;
    }
    return best;
  }

  /**
   * Keep an imagination as a memory. It stays tagged `imagined` and lists the
   * memories it came from. Nothing is kept unless this is called. An
   * imagination never pushes a real memory out: if the store is full of real
   * ones, nothing is kept and this returns null.
   */
  keep(imagined: Imagined, label: string): string | null {
    if (this.traces.size >= this.capacity && ![...this.traces.values()].some(t => t.source === "imagined")) return null;
    return this.insert({
      id: `i${++this.seq}`,
      label,
      source: "imagined",
      index: toUnit(imagined.pattern, this.dims),
      parents: imagined.parents.map(p => p.id),
    });
  }

  /** Forget one memory. */
  forget(id: string): boolean {
    const t = this.traces.get(id);
    if (!t) return false;
    this.drop(t);
    return true;
  }

  /** The memories an imagined one was cut from (empty for a real memory or an unknown id). */
  parentsOf(id: string): string[] {
    return [...(this.traces.get(id)?.parents ?? [])];
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  private insert(base: Omit<Trace, "views" | "seq">): string {
    if (this.traces.has(base.id)) this.drop(this.traces.get(base.id)!);
    const views = new Map<number, View>();
    const perNeuron = Math.max(1, Math.round(this.dims * this.coverage));
    for (const neuron of this.pool) {
      const dims = this.drawDims(perNeuron);
      const values = new Float32Array(dims.length);
      for (let i = 0; i < dims.length; i++) {
        const v = base.index[dims[i]] + this.gauss() * this.viewNoise;
        values[i] = v < -1 ? -1 : v > 1 ? 1 : v;
      }
      views.set(neuron, { dims, values });
    }
    this.traces.set(base.id, { ...base, views, seq: ++this.seq });
    while (this.traces.size > this.capacity) this.evictOne(base.id);
    return base.id;
  }

  private evictOne(protect: string): void {
    let victim: Trace | undefined;
    for (const t of this.traces.values()) {
      if (t.id === protect) continue;
      // Imagined memories go first, then the oldest of whatever is left.
      const better = !victim
        || (t.source === "imagined" && victim.source !== "imagined")
        || (t.source === victim.source && t.seq < victim.seq);
      if (better) victim = t;
    }
    if (victim) this.drop(victim);
  }

  private drop(t: Trace): void {
    this.traces.delete(t.id);
    this.lastUsed.delete(t.id);
  }

  /**
   * Drive `chosen` with their views of the memory, read the memory back off
   * them, and put every neuron back as it was.
   */
  private rebuild(trace: Trace, chosen: number[]): Recall {
    const buf = new Float32Array(this.dims);
    const saved = new Map<number, Float32Array>();
    const sum = new Float64Array(this.dims);
    const votes = new Int32Array(this.dims);
    try {
      for (const id of chosen) {
        const before = new Float32Array(this.dims);
        this.engine.readNeuronContent(id, before);
        saved.set(id, before);
        const view = trace.views.get(id);
        if (!view) continue;
        const drive = new Float32Array(this.dims);
        for (let i = 0; i < view.dims.length; i++) drive[view.dims[i]] = view.values[i];
        this.engine.setNeuronState(id, drive);
        // What the neuron now carries is what is read, not what was written: the mesh is the one holding it.
        buf.fill(0);
        this.engine.readNeuronContent(id, buf);
        for (let i = 0; i < view.dims.length; i++) {
          sum[view.dims[i]] += buf[view.dims[i]];
          votes[view.dims[i]]++;
        }
      }
    } finally {
      for (const [id, before] of saved) this.engine.setNeuronState(id, before);
    }
    const pattern = new Float32Array(this.dims);
    let gaps = 0;
    for (let d = 0; d < this.dims; d++) {
      if (votes[d] === 0) gaps++;
      else pattern[d] = sum[d] / votes[d];
    }
    return {
      id: trace.id,
      label: trace.label,
      source: trace.source,
      pattern,
      neurons: [...chosen].sort((a, b) => a - b),
      gaps,
      error: 1 - cosine(pattern, trace.index),
    };
  }

  /** `k` distinct pool neurons, chosen uniformly (partial Fisher-Yates). */
  private sample(k: number): number[] {
    const a = [...this.pool];
    const n = Math.min(k, a.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.rand() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  }

  private drawDims(k: number): Int32Array {
    const a = Array.from({ length: this.dims }, (_, i) => i);
    const n = Math.min(k, a.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.rand() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return Int32Array.from(a.slice(0, n).sort((x, y) => x - y));
  }

  private drawDistinct<T>(items: T[], k: number): T[] {
    const a = [...items];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.rand() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, k);
  }

  /** A standard normal from two uniform draws (Box-Muller). */
  private gauss(): number {
    const u = Math.max(1e-12, this.rand());
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
