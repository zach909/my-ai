/**
 * The weight editor, and the compiler beside it.
 *
 * A way to see what each weight in a made net does, run the net on a
 * highlighted input, read the output, change one weight a little, and go
 * again. A person can do that from the page; the AI can do the same through
 * the same calls, because everything here returns plain text and numbers it
 * can read.
 *
 *   view()      highlight a neuron with typed text, run, and explain the
 *               weights that decide a neuron's output: what each one is, how
 *               much of what the neuron hears it carries, which way it pushes,
 *               and (given a goal) which way it should move
 *   nudge()     change one weight by at most MAX_NUDGE. Logged, undoable.
 *   step()      make a few small changes toward a goal, run again, and keep
 *               them ONLY if the output got closer. Otherwise undo them.
 *   improve()   step() again and again until it stops helping
 *   compile()   the compiler: write code, see the weights it becomes, and
 *               check the net against the code (code-to-net.ts)
 *
 * The rules that make it safe to hand to the AI:
 *  - A frozen neuron's incoming weights cannot be edited. The call is refused.
 *  - One edit moves one weight by at most MAX_NUDGE, and one step makes at most
 *    MAX_EDITS_PER_STEP edits. "Slightly" is enforced, not hoped for.
 *  - Every edit is recorded with the weight before and after, and can be undone.
 *  - Only the diagonal weights can be set (that is all the engine exposes for
 *    writing). The one-step "shift" terms are shown, marked read-only.
 *  - It edits a net the net maker made. It never touches the base AI's own
 *    neurons unless it is handed a skill's neurons.
 */

import { BuiltNet, highlightVector } from "./neuro-build.js";
import { embedText } from "./neuro-lang.js";
import { CodeToNetCompiler, type CodeNetTier, type TestReport } from "./code-to-net.js";

/** Largest change to one weight in one edit. */
export const MAX_NUDGE = 0.1;
/** Most edits one step() may make. */
export const MAX_EDITS_PER_STEP = 8;
/** Most edits kept in the history. */
export const MAX_HISTORY = 500;

export class EditRefused extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface WeightEdit {
  id: number;
  target: string;
  source: string;
  dim: number;
  before: number;
  after: number;
  reason: string;
  at: number;
}

export interface WeightLine {
  target: string;
  source: string;
  /** Which content dimension of the target this weight acts on. */
  dim: number;
  /** "own": acts on the same dimension (editable). "shift": the one-step neighbour term (read-only). */
  kind: "own" | "shift";
  weight: number;
  sourceValue: number;
  /** weight x source value: what it adds to the target's input on this dimension. */
  contribution: number;
  /** Its share of everything the target hears on this dimension, by size, 0..1. */
  share: number;
  editable: boolean;
  frozen: boolean;
  /** Plain words: what this weight does, and what to do with it for the goal, if there is one. */
  suggestion: string;
}

export interface WeightView {
  drive: string;
  read: string;
  text: string;
  /** What the read neuron says after the run, per dimension. */
  output: number[];
  /** Which declared response the output is closest to, if any are declared. */
  closest: { response: string; similarity: number } | null;
  /** Mean squared error against the goal, when one was given. */
  loss: number | null;
  dims: number[];
  lines: WeightLine[];
  /** The same view as plain text, for the AI to read. */
  text_summary: string;
}

export interface ViewOptions {
  drive?: string;
  read?: string;
  text: string;
  /** What the output should say: the editor then says which way each weight should move. */
  goal?: string;
  /** Content dimensions to explain (1-based). Default: the three that matter most. */
  dims?: number[];
  /** Weights listed per dimension. Default 6. */
  top?: number;
}

export interface StepResult {
  before: number;
  after: number;
  /** True when the edits were kept because the output got closer to the goal. */
  kept: boolean;
  edits: WeightEdit[];
  note: string;
}

function mse(output: ArrayLike<number>, target: ArrayLike<number>): number {
  const n = Math.min(output.length, target.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const e = target[i] - output[i]; s += e * e; }
  return n ? s / n : 0;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(3);

export class WeightEditor {
  private history: WeightEdit[] = [];
  private nextId = 1;

  constructor(readonly net: BuiltNet) {}

  getHistory(): WeightEdit[] { return this.history.slice(); }

  private nameOf(id: number): string {
    for (const [name, i] of this.net.ids) if (i === id) return name;
    return `n${id}`;
  }

  private run(drive: string, text: string, read: string): Float32Array {
    return this.net.run(drive, text, read);
  }

  // ── Seeing ───────────────────────────────────────────────────────────

  view(opts: ViewOptions): WeightView {
    const net = this.net;
    const drive = opts.drive ?? net.routeInput(opts.text);
    const read = opts.read ?? net.outputName;
    const readId = net.idOf(read);
    net.idOf(drive);
    const output = this.run(drive, opts.text, read);
    const goal = opts.goal !== undefined ? embedText(opts.goal, net.dims) : null;
    const loss = goal ? mse(output, goal) : null;

    // Which dimensions to explain: where the goal is furthest off, else where the output is loudest.
    let dims = (opts.dims ?? []).filter(d => Number.isInteger(d) && d >= 1 && d <= net.dims);
    if (dims.length === 0) {
      dims = Array.from({ length: net.dims }, (_, k) => k + 1)
        .sort((a, b) => {
          const sa = goal ? Math.abs(goal[a - 1] - output[a - 1]) : Math.abs(output[a - 1]);
          const sb = goal ? Math.abs(goal[b - 1] - output[b - 1]) : Math.abs(output[b - 1]);
          return sb - sa;
        })
        .slice(0, 3)
        .sort((a, b) => a - b);
    }

    const top = Math.max(1, Math.min(opts.top ?? 6, 24));
    const lines: WeightLine[] = [];
    for (const dim of dims) {
      const trace = net.engine.traceNeuron(readId, dim, top * 4);
      if (!trace) continue;
      const total = trace.terms.reduce((s, t) => s + Math.abs(t.contribution), 0) || 1;
      const err = goal ? goal[dim - 1] - output[dim - 1] : 0;
      for (const t of trace.terms) {
        const m = /^n(\d+)\.d(\d+)$/.exec(t.source);
        if (!m) continue;
        const srcId = Number(m[1]);
        const srcDim = Number(m[2]);
        const kind: "own" | "shift" = srcDim === dim ? "own" : "shift";
        const source = this.nameOf(srcId);
        const frozen = net.isFrozen(read);
        const editable = kind === "own" && !frozen;
        const share = Math.abs(t.contribution) / total;
        const pushes = t.contribution >= 0 ? "up" : "down";
        let suggestion = `${source} → ${read} on dimension ${dim}: weight ${signed(t.weight)} × ${source}'s ${t.sourceValue.toFixed(2)} adds ${signed(t.contribution)}, ${pct(share)} of what ${read} hears there. It pushes ${read} ${pushes}.`;
        if (kind === "shift") suggestion += " (the one-step neighbour term: shown, not editable)";
        else if (frozen) suggestion += ` ${read} is frozen: read only.`;
        else if (goal) {
          // The delta rule's direction: error x source value (x the slope, which is positive).
          const want = err * t.sourceValue;
          if (Math.abs(want) < 1e-3) suggestion += " Leave it: it cannot help the goal here.";
          else suggestion += ` To move toward the goal, ${want > 0 ? "raise" : "lower"} it a little.`;
        }
        lines.push({ target: read, source, dim, kind, weight: t.weight, sourceValue: t.sourceValue, contribution: t.contribution, share, editable, frozen, suggestion });
      }
    }
    // The heaviest few per dimension: the editable ones first, then a couple of
    // read-only neighbour terms so what else the neuron hears is not hidden.
    const kept: WeightLine[] = [];
    for (const dim of dims) {
      const here = lines.filter(l => l.dim === dim).sort((a, b) => b.share - a.share);
      kept.push(...here.filter(l => l.kind === "own").slice(0, top), ...here.filter(l => l.kind === "shift").slice(0, 2));
    }

    let closest: WeightView["closest"] = null;
    for (const c of net.contracts()) {
      const s = cosine(output, c.target);
      if (!closest || s > closest.similarity) closest = { response: c.response, similarity: s };
    }

    const summary = [
      `Typed "${opts.text}": that drives ${drive} as hard as it can be driven, and ${read} settles to:`,
      `  ${Array.from(output).slice(0, 8).map(v => v.toFixed(2)).join(" ")} ...`,
      closest ? `  closest declared response: "${closest.response}" (similarity ${closest.similarity.toFixed(2)})` : "  no responses declared to compare with",
      loss !== null ? `  distance from the goal "${opts.goal}": ${loss.toFixed(4)} (0 is exact)` : "",
      `Weights that decide it (dimensions ${dims.join(", ")}):`,
      ...kept.map(l => "  " + l.suggestion),
    ].filter(Boolean).join("\n");

    return { drive, read, text: opts.text, output: Array.from(output), closest, loss, dims, lines: kept, text_summary: summary };
  }

  // ── Changing ─────────────────────────────────────────────────────────

  /** Change one weight by `delta`, at most MAX_NUDGE either way. Refused for a frozen neuron. */
  nudge(target: string, source: string, dim: number, delta: number, reason = ""): WeightEdit {
    const net = this.net;
    const t = net.idOf(target);
    const s = net.idOf(source);
    if (t === s) throw new EditRefused("a neuron has no weight to itself");
    if (!Number.isInteger(dim) || dim < 1 || dim > net.dims) throw new EditRefused(`dimension must be 1 to ${net.dims}`);
    if (!Number.isFinite(delta)) throw new EditRefused("delta must be a number");
    if (net.isFrozen(target)) throw new EditRefused(`"${target}" is frozen: its weights cannot be edited`);
    const step = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, delta));
    const before = net.engine.getConnectionWeight(t, s, dim);
    net.engine.setConnectionWeight(t, s, dim, before + step);
    const after = net.engine.getConnectionWeight(t, s, dim);
    const edit: WeightEdit = { id: this.nextId++, target, source, dim, before, after, reason, at: Date.now() };
    this.history.push(edit);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    return edit;
  }

  /** Undo the last `count` edits, newest first. */
  undo(count = 1): WeightEdit[] {
    const undone: WeightEdit[] = [];
    for (let i = 0; i < Math.max(1, count) && this.history.length > 0; i++) {
      const e = this.history.pop()!;
      this.net.engine.setConnectionWeight(this.net.idOf(e.target), this.net.idOf(e.source), e.dim, e.before);
      undone.push(e);
    }
    return undone;
  }

  /**
   * A few small changes toward a goal, kept only if the output got closer.
   * The changes are the ones the view suggests: the weights that carry the
   * most, nudged the way the error says.
   */
  step(opts: { text: string; goal: string; drive?: string; read?: string; edits?: number; size?: number }): StepResult {
    const net = this.net;
    const read = opts.read ?? net.outputName;
    const drive = opts.drive ?? net.routeInput(opts.text);
    if (net.isFrozen(read)) throw new EditRefused(`"${read}" is frozen: its weights cannot be edited`);
    const size = Math.max(0.001, Math.min(opts.size ?? 0.05, MAX_NUDGE));
    const count = Math.max(1, Math.min(opts.edits ?? 3, MAX_EDITS_PER_STEP));
    const v = this.view({ drive, read, text: opts.text, goal: opts.goal, top: count });
    const before = v.loss ?? 0;

    const candidates = v.lines
      .filter(l => l.editable && l.kind === "own")
      .map(l => {
        const goal = embedText(opts.goal, net.dims);
        const err = goal[l.dim - 1] - v.output[l.dim - 1];
        return { line: l, want: err * l.sourceValue };
      })
      .filter(c => Math.abs(c.want) >= 1e-3)
      .sort((a, b) => Math.abs(b.want) - Math.abs(a.want))
      .slice(0, count);

    if (candidates.length === 0) {
      return { before, after: before, kept: false, edits: [], note: "no weight can usefully move toward this goal from here" };
    }
    const made = candidates.map(c =>
      this.nudge(read, c.line.source, c.line.dim, c.want > 0 ? size : -size, `toward "${opts.goal}"`));
    const after = mse(this.run(drive, opts.text, read), embedText(opts.goal, net.dims));
    if (after < before) {
      return { before, after, kept: true, edits: made, note: `closer to the goal: ${before.toFixed(4)} → ${after.toFixed(4)}` };
    }
    this.undo(made.length);
    return { before, after, kept: false, edits: made, note: `not closer (${before.toFixed(4)} → ${after.toFixed(4)}): undone` };
  }

  /** step() again and again, stopping after two steps in a row that did not help. */
  improve(opts: { text: string; goal: string; drive?: string; read?: string; steps?: number; size?: number; edits?: number }): { steps: StepResult[]; before: number; after: number } {
    const total = Math.max(1, Math.min(opts.steps ?? 10, 50));
    const results: StepResult[] = [];
    let misses = 0;
    for (let i = 0; i < total && misses < 2; i++) {
      const r = this.step(opts);
      results.push(r);
      misses = r.kept ? 0 : misses + 1;
    }
    return { steps: results, before: results[0]?.before ?? 0, after: results[results.length - 1]?.after ?? 0 };
  }

  /** Freeze or unfreeze a neuron's weights. */
  setFrozen(neuron: string, frozen: boolean): void {
    if (frozen) this.net.freeze(neuron);
    else this.net.unfreeze(neuron);
  }
}

// ── The compiler ───────────────────────────────────────────────────────────

export interface CompileView {
  name: string;
  tier: CodeNetTier;
  /** How well the compiled net matches the code, measured by sampling. */
  test: TestReport;
  /** The weights the code became, in plain words. */
  weights: string[];
  /** The net's answer on the given inputs, beside the code's own. */
  outputs?: { inputs: number[]; net: number[] };
  summary: string;
}

/**
 * Write code, see the weights it becomes. Only numeric functions compile to
 * weights that reproduce them; anything else is an identity-only embedding and
 * the summary says so (see code-to-net.ts for the tiers).
 */
export function compileView(code: string, inputs?: number[], name = "fn"): CompileView {
  const compiler = new CodeToNetCompiler();
  const net = compiler.compile(name, code);
  const test = compiler.testAgainst(net, code);
  const json = net.toJSON();
  const weights: string[] = [];
  if (json.fn?.affine) {
    json.fn.affine.weights.forEach((w, i) => weights.push(`input ${i + 1}: weight ${signed(w)}`));
    weights.push(`bias ${signed(json.fn.affine.bias)}`);
  } else if (json.fn?.polynomial) {
    for (const t of json.fn.polynomial.terms) weights.push(`term ${t.exponents.map((e, i) => (e ? `x${i + 1}^${e}` : "")).filter(Boolean).join("·") || "1"}: coefficient ${signed(t.coefficient)}`);
  } else if (json.fn) {
    weights.push(`a fitted network: ${json.fn.hidden} hidden neurons, ${json.fn.arity} input(s), ${json.fn.hidden * json.fn.arity + json.fn.hidden * 2 + 1} weights in all (an approximation, not exact)`);
  } else {
    weights.push("an identity-only signature: it can be recognised and referenced, it does not reproduce what the code does");
  }
  const outputs = inputs && net.mode === "function" ? { inputs, net: net.evaluate(inputs) } : undefined;
  const summary = [
    `"${code}" compiled as: ${net.tier}${net.tier === "affine" || net.tier === "polynomial" ? " (exact, no training)" : net.tier === "fitted" ? " (trained by sampling)" : ""}`,
    ...weights.map(w => "  " + w),
    `Checked against the code on ${test.samples} samples: mean error ${test.meanAbsError.toExponential(2)}, ${test.passed ? "passed" : "FAILED"}`,
    outputs ? `On ${JSON.stringify(outputs.inputs)} the net says ${JSON.stringify(outputs.net)}` : "",
  ].filter(Boolean).join("\n");
  return { name, tier: net.tier, test, weights, outputs, summary };
}

export { highlightVector };
