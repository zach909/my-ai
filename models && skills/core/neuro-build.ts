/**
 * Net maker and net skill maker: turn a NeuroLang program into a working net.
 *
 *   kind="network"  -> NET MAKER. A network of its own, in its own engine. It
 *                      builds itself and does everything the program asks.
 *   kind="skill"    -> NET SKILL MAKER. The same program, but its neurons are
 *                      grafted into the base AI (net-skill-graft.ts), so it
 *                      changes the AI it joins. The base AI's own weights are
 *                      never trained: only the skill's neurons are.
 *
 * What a program can say (the statements are parsed in neuro-lang.ts):
 *
 *   neurons="64"                  make 64 neurons, connected to each other
 *   "n3"@value="0.5"              where it starts
 *   "n3"@frozen="now"|"after"     never trained, or frozen once training is done
 *   "n1"@input="hello"            typing this drives n1 as hard as a neuron can be driven
 *   "n1"@response="hi there"      with ONLY n1 driven, the output neuron must say this
 *   train="responses"             set up every declared response, over and over until met
 *   train="predict"               learn to predict the next byte of train@text
 *   train="random"                learn to predict the next byte of generated content
 *
 * Honest limits, so nobody has to find them out:
 *  - Connections between neurons the program did not wire keep the engine's
 *    own seeded small random weights. They are NOT set to one shared value:
 *    identical weights everywhere would make every undriven neuron compute
 *    the same thing, and a net like that cannot learn to tell inputs apart.
 *  - "Frozen" means the neuron's incoming weights are never trained or edited.
 *    Its state still moves when the net runs: a neuron that could not respond
 *    would not be worth keeping.
 *  - Predict and random modes drive raw bits (eight per byte, +1/-1) onto the
 *    input neuron. There is no tokenizer. They do not stream the bits through
 *    ZipLoopInterface one tick at a time.
 *  - Random mode makes random-but-patterned content (a few random motifs,
 *    repeated, with noise). Uniformly random bytes cannot be predicted better
 *    than chance, so a net trained on those would learn nothing.
 *  - How well predict mode works is measured on text held back from training
 *    and reported next to a "always guess the commonest byte" baseline. It is
 *    not assumed.
 */

import { HyperDimensionalEngine } from "./onebrain.js";
import {
  NeuroLangInterpreter,
  embedText,
  type NeuriNeuron,
  type NeuriProgram,
  type NeuriKind,
  type NeuriTrainMode,
} from "./neuro-lang.js";
import { ZipSpeaker } from "./zip-speech.js";
import { graftNetSkill, MAX_MESH_NEURONS, type SkillNeuron } from "./net-skill-graft.js";

// ── Options and results ──────────────────────────────────────────────────────

export interface MakerOptions {
  /** Name of the net or skill. Default "net" / "skill". */
  name?: string;
  /** Skill only: the base AI the skill joins. Required for a skill. */
  base?: HyperDimensionalEngine;
  /** Network only: content dimensions per neuron. Default 32. */
  dimensions?: number;
  /** Seed for the network's starting weights and for random mode. Default 1. */
  seed?: number;
  /**
   * Most neurons a program may make and a network may have. Default 1024: the
   * mesh is all-to-all, so cost grows with the square. Pass Infinity to lift it
   * (a caller that trusts its own source and accepts the cost).
   */
  maxNeurons?: number;
  /** A response counts as met when its mean squared error is under this. Default 0.2. */
  tolerance?: number;
  /** Overrides for the program's own train statements. */
  train?: { mode?: NeuriTrainMode; epochs?: number; rounds?: number; text?: string };
}

export interface PredictReport {
  /** Bytes of context the input neuron sees. */
  contextBytes: number;
  /** Distinct (context -> next byte) pairs trained on. */
  trainedPairs: number;
  /** Pairs held back from training and used to measure. */
  heldOutPairs: number;
  /** Exact next-byte hits on the held-out pairs (the training pairs if nothing could be held out). */
  accuracy: number;
  /** Hit rate of always guessing the commonest byte. A real result has to beat this. */
  baseline: number;
  /**
   * Fraction of the held-out contexts that also appear in the training pairs.
   * High means the score is mostly recall of what it was shown; low means it
   * is guessing contexts it has never heard. Read accuracy with this beside it.
   */
  heldOutSeen: number;
  /** True when the held-out pairs were also trained on (too little text to hold any back). */
  measuredOnTraining: boolean;
  /** Same context, different next byte: cannot all be met. */
  conflicts: number;
}

export interface TrainReport {
  mode: NeuriTrainMode;
  rounds: number;
  /** True when every response (or prediction contract) was met. */
  converged: boolean;
  /** Neurons whose response was met / not met. */
  satisfied: string[];
  unsatisfied: string[];
  /** Responses skipped because the neuron that should say them is frozen. */
  skipped: string[];
  /** Responses that contradict each other: the same neuron driven, the same output, different things to say. */
  conflicts: Array<{ a: string; b: string }>;
  /**
   * Of the responses trained, how many the net really gives: driving the
   * neuron lands closer to its own response than to any other declared one.
   * This is the test that matters; the error below the tolerance is only how
   * exactly the response vector is matched.
   */
  recall?: { correct: number; total: number };
  predict?: PredictReport;
  notes: string[];
}

export interface MakerResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  kind: NeuriKind;
  net?: BuiltNet;
  training?: TrainReport;
}

// ── Vectors ──────────────────────────────────────────────────────────────────

/**
 * The text as the biggest input a neuron can be given: its embedding scaled
 * so the strongest component sits at 1, the engine's ceiling. This is the
 * "highlight": the neuron is driven as hard as it can be.
 */
export function highlightVector(text: string, dims: number): number[] {
  const v = embedText(text, dims);
  let peak = 0;
  for (const x of v) peak = Math.max(peak, Math.abs(x));
  if (!(peak > 0)) return v.map(() => 0);
  return v.map(x => Math.max(-1, Math.min(1, x / peak)));
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random-but-patterned content for random mode: a few random motifs picked
 * over and over, with the odd noise byte. Deterministic for a given seed.
 */
export function randomContent(seed: number, length = 320): string {
  const rand = seededRandom(seed);
  const printable = () => String.fromCharCode(32 + Math.floor(rand() * 95));
  const motifs: string[] = [];
  const motifCount = 3 + Math.floor(rand() * 3);
  for (let m = 0; m < motifCount; m++) {
    const len = 2 + Math.floor(rand() * 3);
    let motif = "";
    for (let i = 0; i < len; i++) motif += printable();
    motifs.push(motif);
  }
  let text = "";
  while (text.length < length) {
    text += rand() < 0.05 ? printable() : motifs[Math.floor(rand() * motifs.length)];
  }
  return text.slice(0, length);
}

// ── The built net ────────────────────────────────────────────────────────────

interface Contract {
  neuron: string;
  drive: number;
  readout: number;
  readoutName: string;
  input: number[];
  target: number[];
  response: string;
}

/** Most (context -> next byte) pairs one predict run trains on. */
const MAX_PREDICT_PAIRS = 192;
/** Bytes of context the mesh hears before it is asked for the next one. */
const PREDICT_CONTEXT_BYTES = 6;

export class BuiltNet {
  readonly neurons: Map<string, NeuriNeuron>;
  /** Neuron name -> its id in the engine. */
  readonly ids: Map<string, number>;
  /** Neurons whose incoming weights may not be trained or edited. */
  readonly frozen = new Set<string>();
  readonly inputName: string;
  readonly outputName: string;
  /** Each neuron's own @vale, recorded for callers that want elastic running; run() does not apply it. */
  readonly vale = new Map<string, number>();
  /** The readout head predict / random mode fitted, once it has. */
  private speaker: ZipSpeaker | null = null;

  constructor(
    readonly kind: NeuriKind,
    readonly name: string,
    readonly engine: HyperDimensionalEngine,
    neurons: Map<string, NeuriNeuron>,
    ids: Map<string, number>,
  ) {
    this.neurons = neurons;
    this.ids = ids;
    const all = Array.from(neurons.values());
    this.inputName = (all.find(n => n.role === "input") ?? all[0]).name;
    this.outputName = (all.find(n => n.role === "output") ?? all[all.length - 1]).name;
    for (const n of all) {
      if (n.frozen === "now") this.frozen.add(n.name);
      if (n.vale !== undefined) this.vale.set(n.name, n.vale);
    }
  }

  get dims(): number { return this.engine.getDimensions(); }

  idOf(name: string): number {
    const id = this.ids.get(name);
    if (id === undefined) throw new Error(`No neuron named "${name}" in ${this.name}`);
    return id;
  }

  isFrozen(name: string): boolean { return this.frozen.has(name); }
  freeze(name: string): void { this.idOf(name); this.frozen.add(name); }
  unfreeze(name: string): void { this.frozen.delete(name); }

  // ── Running ────────────────────────────────────────────────────────────

  /**
   * Drive one neuron as hard as it can be driven and nothing else, let the
   * net settle, and read a neuron. Reading does not train.
   */
  run(driveName: string, text: string, readName: string = this.outputName): Float32Array {
    return this.runVector(driveName, highlightVector(text, this.dims), readName);
  }

  runVector(driveName: string, vector: number[], readName: string = this.outputName): Float32Array {
    const drive = this.idOf(driveName);
    const read = this.idOf(readName);
    this.engine.process(vector, undefined, new Set([drive]), undefined, { learn: false });
    const check = this.engine.checkDefinition(read);
    return check ? check.readout : new Float32Array(this.dims);
  }

  /** The neuron a typed text highlights: the one whose @input is closest to it, else the input neuron. */
  routeInput(text: string): string {
    const withInput = Array.from(this.neurons.values()).filter(n => n.input !== undefined);
    if (withInput.length === 0) return this.inputName;
    const here = embedText(text, this.dims);
    let best = withInput[0].name, bestScore = -Infinity;
    for (const n of withInput) {
      const score = cosine(here, embedText(n.input!, this.dims));
      if (score > bestScore) { bestScore = score; best = n.name; }
    }
    return best;
  }

  /**
   * Type something: highlight the neuron it belongs to, settle, and say which
   * declared response the output is closest to.
   */
  respond(text: string): { drove: string; response: string | null; similarity: number; output: Float32Array } {
    const drove = this.routeInput(text);
    const output = this.run(drove, text);
    let response: string | null = null, similarity = -Infinity;
    for (const c of this.contracts()) {
      const s = cosine(output, c.target);
      if (s > similarity) { similarity = s; response = c.response; }
    }
    return { drove, response, similarity: response === null ? 0 : similarity, output };
  }

  // ── Responses ──────────────────────────────────────────────────────────

  /** Every declared "with only this neuron driven, the output says this". */
  contracts(): Contract[] {
    const out: Contract[] = [];
    for (const n of this.neurons.values()) {
      if (n.response === undefined) continue;
      const readoutName = n.reads ?? this.outputName;
      const drive = this.ids.get(n.name), readout = this.ids.get(readoutName);
      if (drive === undefined || readout === undefined || drive === readout) continue;
      out.push({
        neuron: n.name,
        drive,
        readout,
        readoutName,
        input: highlightVector(n.input ?? n.name, this.dims),
        target: embedText(n.response, this.dims),
        response: n.response,
      });
    }
    return out;
  }

  // ── Training ───────────────────────────────────────────────────────────

  /**
   * Set up every declared response: highlight the neuron, require the output
   * to say its response, adjust, and go around again until they are all met
   * or the rounds run out. A response whose output neuron is frozen is
   * skipped, not forced.
   */
  trainResponses(opts: { epochs?: number; rounds?: number; tolerance?: number } = {}): TrainReport {
    const tolerance = opts.tolerance ?? 0.2;
    const epochs = opts.epochs ?? 200;
    const rounds = Math.max(1, opts.rounds ?? 5);
    const notes: string[] = [];
    const report: TrainReport = {
      mode: "responses", rounds: 0, converged: false,
      satisfied: [], unsatisfied: [], skipped: [], conflicts: [], notes,
    };

    const all = this.contracts();
    const declared = Array.from(this.neurons.values()).filter(n => n.response !== undefined).length;
    if (declared > all.length) notes.push(`${declared - all.length} response(s) ignored: the neuron that should say it is missing, or is the same neuron that is driven`);
    const active = all.filter(c => !this.frozen.has(c.readoutName));
    for (const c of all) if (this.frozen.has(c.readoutName)) report.skipped.push(c.neuron);
    if (active.length === 0) {
      report.converged = all.length === 0;
      notes.push(all.length === 0 ? "no responses declared" : "every response's output neuron is frozen");
      this.applyAfterFreezes();
      return report;
    }

    const defs = active.map(c => ({ driveNeuronId: c.drive, input: c.input, readoutNeuronId: c.readout, target: c.target }));
    let last: ReturnType<HyperDimensionalEngine["trainDefinitions"]> | null = null;
    for (let r = 0; r < rounds; r++) {
      last = this.engine.trainDefinitions(defs, { epochs, tolerance });
      report.rounds = r + 1;
      if (last.converged) break;
    }
    if (last) {
      active.forEach((c, i) => (last!.losses[i] < tolerance ? report.satisfied : report.unsatisfied).push(c.neuron));
      report.converged = last.converged;
      // The engine flags any two responses sharing an output neuron. That is
      // only a real contradiction when the same neuron is the one driven.
      for (const k of last.conflicts) {
        const a = active[k.a], b = active[k.b];
        if (a.drive === b.drive && a.readout === b.readout) report.conflicts.push({ a: a.neuron, b: b.neuron });
      }
      let correct = 0;
      for (const c of active) {
        const out = this.runVector(c.neuron, c.input, c.readoutName);
        let nearest = c, best = -Infinity;
        for (const other of all) {
          if (other.readout !== c.readout) continue;
          const sim = cosine(out, other.target);
          if (sim > best) { best = sim; nearest = other; }
        }
        if (nearest.target === c.target) correct++;
      }
      report.recall = { correct, total: active.length };
    }
    this.applyAfterFreezes();
    return report;
  }

  /**
   * Learn to predict the next byte of `text`.
   *
   * The context (the last few bytes) goes through the Zip Loop as raw bits and
   * leaves a trace in the mesh; a closed-form ridge regression is fitted from
   * the whole mesh state to the next byte (ZipSpeaker, zip-speech.ts). The mesh
   * is the fixed reservoir and the readout is the only thing trained.
   *
   * This replaced a first version that trained one neuron's incoming weights
   * by the delta rule. That version could not work, and measured: it stalled
   * at 16-19% against a 26% baseline however many epochs, neurons or however
   * high the learning rate. The mesh couples each content dimension only to the
   * same dimension of the other neurons (plus a one-step shift), so output bit
   * b could only ever see context bit b, never the rest of the context.
   *
   * Because only the readout head is fitted, NO neuron's weights change: frozen
   * neurons are untouched by construction, and so is the rest of the net.
   * Needs at least 8 neurons (the Zip Loop's doorway uses the first 6).
   * Measured on text held back from training.
   */
  trainPredict(text: string, opts: { memoryVale?: number; standardize?: boolean } = {}): TrainReport {
    const notes: string[] = [];
    const report: TrainReport = {
      mode: "predict", rounds: 1, converged: false,
      satisfied: [], unsatisfied: [], skipped: [], conflicts: [], notes,
    };
    if (this.engine.getNeuronCount() < 8) {
      notes.push("predict needs at least 8 neurons: the Zip Loop's doorway uses the first 6 and the readout needs some outside it");
      return report;
    }
    const bytes: number[] = Array.from(Buffer.from(text, "utf8")) as number[];
    if (bytes.length < 3) {
      notes.push("need at least 3 bytes of text to predict anything");
      return report;
    }
    const K = PREDICT_CONTEXT_BYTES;

    // Every position is one pair: the bytes before it -> the byte at it.
    const holdFrom = bytes.length >= 20 ? Math.floor(bytes.length * 0.8) : bytes.length;
    const train = new Map<string, { ctx: number[]; counts: Map<number, number> }>();
    const heldOut: Array<{ ctx: number[]; next: number }> = [];
    for (let i = 1; i < bytes.length; i++) {
      const ctx = bytes.slice(Math.max(0, i - K), i);
      if (i >= holdFrom) { heldOut.push({ ctx, next: bytes[i] }); continue; }
      const key = ctx.join(",");
      const slot = train.get(key) ?? { ctx, counts: new Map() };
      slot.counts.set(bytes[i], (slot.counts.get(bytes[i]) ?? 0) + 1);
      train.set(key, slot);
    }

    let conflicts = 0;
    const pairs: Array<{ ctx: number[]; next: number }> = [];
    for (const slot of train.values()) {
      if (slot.counts.size > 1) conflicts++;
      let best = -1, bestCount = -1;
      for (const [b, c] of slot.counts) if (c > bestCount) { best = b; bestCount = c; }
      pairs.push({ ctx: slot.ctx, next: best }); // the commonest answer for that context
    }
    const used = pairs.slice(0, MAX_PREDICT_PAIRS);
    if (pairs.length > used.length) notes.push(`trained on the first ${used.length} of ${pairs.length} distinct contexts`);

    const speaker = new ZipSpeaker(this.engine, {
      maxAnswerBytes: 1,
      memoryVale: opts.memoryVale ?? 0.97,
      standardize: opts.standardize ?? true,
      pooling: "mean",
    });
    const taught = speaker.teach(used.map(p => ({ question: Uint8Array.from(p.ctx), answer: Uint8Array.from([p.next]) })));
    this.speaker = speaker;
    report.converged = taught.bitAccuracy > 0.99;
    (report.converged ? report.satisfied : report.unsatisfied).push(this.outputName);

    const guess = (ctx: number[]): number => {
      const out = speaker.speak(Uint8Array.from(ctx));
      return out.length > 0 ? out[0] : -1;
    };
    const measuredOnTraining = heldOut.length === 0;
    const evalSet = measuredOnTraining ? used : heldOut;
    let hits = 0;
    for (const p of evalSet) if (guess(p.ctx) === p.next) hits++;
    const freq = new Map<number, number>();
    for (const p of used) freq.set(p.next, (freq.get(p.next) ?? 0) + 1);
    let common = -1, commonCount = -1;
    for (const [b, c] of freq) if (c > commonCount) { common = b; commonCount = c; }
    let baselineHits = 0;
    for (const p of evalSet) if (p.next === common) baselineHits++;

    report.predict = {
      contextBytes: K,
      trainedPairs: used.length,
      heldOutPairs: heldOut.length,
      accuracy: evalSet.length ? hits / evalSet.length : 0,
      baseline: evalSet.length ? baselineHits / evalSet.length : 0,
      heldOutSeen: heldOut.length ? heldOut.filter(h => train.has(h.ctx.join(","))).length / heldOut.length : 1,
      measuredOnTraining,
      conflicts,
    };
    if (measuredOnTraining) notes.push("too little text to hold any back: accuracy is measured on the training pairs");
    this.applyAfterFreezes();
    return report;
  }

  /** What the net predicts comes next after `context`, as a byte, or null if it has not learned to predict. */
  predictNextByte(context: string): number | null {
    if (!this.speaker) return null;
    const ctx: number[] = (Array.from(Buffer.from(context, "utf8")) as number[]).slice(-PREDICT_CONTEXT_BYTES);
    const out = this.speaker.speak(Uint8Array.from(ctx));
    return out.length > 0 ? out[0] : null;
  }

  /** Learn from something the user just said: predict mode on live text. */
  learnFromText(text: string): TrainReport {
    return this.trainPredict(text);
  }

  /** Random mode: make random-but-patterned content and learn to predict it. */
  trainRandom(seed: number, opts: { length?: number } = {}): TrainReport {
    const report = this.trainPredict(randomContent(seed, opts.length ?? 320));
    report.mode = "random";
    return report;
  }

  /** Neurons marked frozen "after" are frozen once training is done. */
  private applyAfterFreezes(): void {
    for (const n of this.neurons.values()) if (n.frozen === "after") this.frozen.add(n.name);
  }
}

// ── The makers ───────────────────────────────────────────────────────────────

function fail(kind: NeuriKind, errors: string[], warnings: string[] = []): MakerResult {
  return { ok: false, errors, warnings, kind };
}

/** Reads the program's own kind, then builds a net or a net skill. */
export async function makeFromSource(source: string, opts: MakerOptions = {}): Promise<MakerResult> {
  const interpreter = new NeuroLangInterpreter({ maxNeurons: opts.maxNeurons });
  const parsed = await interpreter.parse(source);
  const kind: NeuriKind = parsed.program?.kind ?? "network";
  return build(parsed.neurons, parsed.errors, parsed.program, kind, opts);
}

/** NET MAKER: a network of its own, whatever the program says its kind is. */
export async function netMaker(source: string, opts: MakerOptions = {}): Promise<MakerResult> {
  const interpreter = new NeuroLangInterpreter({ maxNeurons: opts.maxNeurons });
  const parsed = await interpreter.parse(source);
  const result = await build(parsed.neurons, parsed.errors, parsed.program, "network", opts);
  if (parsed.program?.kind === "skill") result.warnings.push('the program says kind="skill" but this is the net maker, so it was made as a network of its own');
  return result;
}

/** NET SKILL MAKER: the program's neurons joined into `base`, the AI they change. */
export async function netSkillMaker(source: string, base: HyperDimensionalEngine, opts: MakerOptions = {}): Promise<MakerResult> {
  const interpreter = new NeuroLangInterpreter({ maxNeurons: opts.maxNeurons });
  const parsed = await interpreter.parse(source);
  const result = await build(parsed.neurons, parsed.errors, parsed.program, "skill", { ...opts, base });
  if (parsed.program?.kind === "network") result.warnings.push('the program says kind="network" but this is the net skill maker, so it was grafted into the base AI as a skill');
  return result;
}

async function build(
  neurons: Map<string, NeuriNeuron>,
  parseErrors: string[],
  program: NeuriProgram | undefined,
  kind: NeuriKind,
  opts: MakerOptions,
): Promise<MakerResult> {
  const warnings: string[] = [];
  if (parseErrors.length > 0) return fail(kind, parseErrors);
  const names = Array.from(neurons.keys());
  if (names.length < 2) return fail(kind, ["need at least two neurons: one to be driven and one to answer"]);
  const name = opts.name ?? (kind === "skill" ? "skill" : "net");

  // Every named reference has to exist, or a typo silently trains nothing.
  for (const n of neurons.values()) {
    if (n.reads !== undefined && !neurons.has(n.reads)) {
      return fail(kind, [`"${n.name}"@reads="${n.reads}": there is no neuron called "${n.reads}"`]);
    }
  }

  let engine: HyperDimensionalEngine;
  const ids = new Map<string, number>();

  if (kind === "skill") {
    if (!opts.base) return fail(kind, ["a skill needs the base AI to join: pass it as `base`"]);
    engine = opts.base;
    const skillNeurons: SkillNeuron[] = names.map(n => {
      const neuron = neurons.get(n)!;
      return {
        name: n,
        definition: neuron.definition || neuron.response || "",
        wave: neuron.wave ?? null,
        connections: Object.fromEntries(neuron.connections),
      };
    });
    const grafted = graftNetSkill(engine, name, skillNeurons);
    if (grafted.added === 0) return fail(kind, [grafted.skipped ?? "nothing was grafted"]);
    if (grafted.skipped) warnings.push(grafted.skipped);
    if (grafted.added < names.length) {
      return fail(kind, [`only ${grafted.added} of ${names.length} neurons fit in the base AI (${grafted.skipped ?? "no room"}); a partial skill would not do what the program asks`]);
    }
    for (const n of names) ids.set(n, grafted.ids[n]);
  } else {
    const cap = opts.maxNeurons ?? MAX_MESH_NEURONS;
    if (names.length > cap) return fail(kind, [`${names.length} neurons is more than the ${cap} one network may have`]);
    engine = new HyperDimensionalEngine({
      neuronCount: names.length,
      dimensions: opts.dimensions ?? 32,
      seed: opts.seed ?? 1,
      propagationSteps: 8,
    });
    names.forEach((n, i) => ids.set(n, i));

    // What each neuron feeds, as the program wired it. Everything else keeps
    // the engine's own seeded weights (see the note at the top of this file).
    for (const n of neurons.values()) {
      const from = ids.get(n.name)!;
      for (const [target, weight] of n.connections) {
        const to = ids.get(target);
        if (to !== undefined) engine.setConnection(to, from, weight);
      }
      if (n.wave) engine.setWaveSignature(from, n.wave.frequency, n.wave.phase);
      if (n.definition) {
        const meaning = embedText(n.definition, engine.getDimensions());
        engine.setNeuronState(from, meaning);
        engine.setDefinitionTarget(from, meaning);
      }
    }
  }

  // Where each neuron starts. Only a value the program actually gave.
  for (const n of neurons.values()) {
    if (n.value === 0) continue;
    const start = Math.max(-1, Math.min(1, n.value));
    engine.setNeuronState(ids.get(n.name)!, new Array(engine.getDimensions()).fill(start));
  }

  const net = new BuiltNet(kind, name, engine, neurons, ids);

  const train = { ...(program?.train ?? {}), ...(opts.train ?? {}) } as NonNullable<NeuriProgram["train"]>;
  const hasResponses = net.contracts().length > 0;
  const mode: NeuriTrainMode | undefined = train.mode ?? (hasResponses ? "responses" : undefined);
  let training: TrainReport | undefined;
  if (mode === "responses") {
    training = net.trainResponses({ epochs: train.epochs, rounds: train.rounds, tolerance: opts.tolerance });
  } else if (mode === "predict") {
    if (!train.text) {
      warnings.push('train="predict" needs text to predict: add train@text="..." or call learnFromText()');
    } else {
      training = net.trainPredict(train.text);
    }
  } else if (mode === "random") {
    training = net.trainRandom(train.seed ?? opts.seed ?? 1);
  }
  if (!training) {
    // Nothing to train, but "after" still means frozen once setup is done.
    for (const n of neurons.values()) if (n.frozen === "after") net.freeze(n.name);
  }

  return { ok: true, errors: [], warnings, kind, net, training };
}
