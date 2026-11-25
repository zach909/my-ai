/**
 * Self-debug: the AI finds what goes wrong in a net, looks at the weights
 * behind it, edits them a little, checks whether it got better or worse, and
 * keeps going. When weights alone cannot fix something it can make a skill,
 * and propose a plugin.
 *
 * The loop, in the owner's words, and where each step lives:
 *
 *   has problems, sees what goes wrong   casesFromNet() / casesFromMistakes() give the test
 *                                        cases; scoreSuite() runs them and names the failing ones
 *   sees what the weights are            WeightEditor.view() says which weights decide the
 *                                        output and how much of the input each one carries
 *   which weights had a big input        WeightLedger counts, per weight, how often it was a
 *                                        big share of what a neuron heard
 *   looks at the history                 the same ledger remembers which edits to which weights
 *                                        were kept and which were undone, and ranks by that
 *   edits the new weights                WeightEditor.nudge(): bounded, logged, undoable, refuses
 *                                        frozen neurons. Nothing here writes a weight any other way.
 *   talks to itself                      two voices: the debugger says what it sees and proposes,
 *                                        the critic re-measures with its own run and answers
 *   sees what is better or worse         the critic lists which cases got better, which got
 *                                        worse, and which flipped from right to wrong
 *   continues                            keep the edit and go again, or undo it and try smaller;
 *                                        stop after `patience` misses or when the budget is spent
 *   makes skills and plugins             a case that weights cannot fix becomes a trained skill
 *                                        (through an injected maker, normally the Extension
 *                                        Builder). Three or more become a plugin PROPOSAL.
 *
 * What it is not: the "talking to itself" is a structured review computed from
 * the measurements, not a language model. It does not read or write code to fix
 * a thrown exception; those are listed as observations. It never touches the
 * live base AI's own neurons: it edits a net it is handed (a net maker net, or
 * a skill's neurons when the owner confirms).
 *
 * Safety, all of it enforced here and not just hoped for:
 *  - Every weight change goes through WeightEditor.nudge(): at most MAX_NUDGE
 *    per edit, refused for a frozen neuron, recorded with before and after.
 *  - A round is kept only if the case it targets improved AND no other case
 *    flipped from right to wrong AND no other case got meaningfully worse.
 *    Otherwise it is undone, and the undo is checked weight by weight.
 *  - The whole network state is captured before the run and put back if
 *    anything throws or the run ends worse than it began.
 *  - A skill is data (trained scripts), installed and logged. A plugin is code:
 *    its source is generated only from a fixed template, vetted, installed
 *    INERT, and does nothing until the owner approves its activation.
 *  - No third-party code, no tokenizer, no outside model: only this repo.
 */

import { embedText } from "./neuro-lang.js";
import type { BuiltNet } from "./neuro-build.js";
import { WeightEditor, EditRefused, MAX_NUDGE, type WeightLine } from "./weight-editor.js";
import { ActionLog, type ActionRecord } from "./action-log.js";
import type { Mistake } from "./mistake-tracker.js";

// ── Limits ───────────────────────────────────────────────────────────────

/** Most test cases one run looks at. */
export const MAX_CASES = 64;
/** Smallest nudge the loop shrinks to. */
export const MIN_SIZE = 0.005;
/** Where a nudge starts. */
export const START_SIZE = 0.05;
/** A weight is "big input" when it is at least this share of what a neuron hears on a dimension. */
export const BIG_SHARE = 0.25;
/** An answer is "confident" when its output is at least this close (cosine) to the goal, not only the nearest of the answers. */
export const MIN_COSINE = 0.5;
/** A target case must improve by at least this much (mean squared error) for a round to be kept. */
export const MIN_GAIN = 1e-6;
/** Another case may get worse by at most this fraction of its loss (plus REGRESS_FLOOR) before a round is rejected. */
export const REGRESS_FRACTION = 0.05;
export const REGRESS_FLOOR = 1e-3;
/** Most weights tracked in the ledger. */
export const MAX_LEDGER = 2000;
/** Most dialogue lines kept per session. */
export const MAX_DIALOGUE = 240;
/** Most sessions kept in memory. */
export const MAX_SESSIONS = 100;
/** Epoch budgets for the retrain rung, one per attempt on a problem. */
export const RETRAIN_EPOCHS = [60, 240];
/** Scripts needed before a plugin is proposed. */
export const PLUGIN_THRESHOLD = 3;

// ── Cases and scoring ────────────────────────────────────────────────────

export type ProblemSource = "declared" | "mistake" | "user";

export interface DebugCase {
  id: string;
  /** What is typed into the net. */
  text: string;
  /** What the net should say. */
  expect: string;
  /** Neuron to highlight (default: the one the text belongs to). */
  drive?: string;
  /** Neuron to read (default: the net's output neuron). */
  read?: string;
  source: ProblemSource;
  note?: string;
}

export interface CaseScore {
  id: string;
  /** Mean squared error of the output against the expected response's embedding. */
  loss: number;
  cosine: number;
  /** The answer, of everything the suite knows, that the output is closest to. */
  nearest: string | null;
  /** The nearest answer is the expected one: the same test NeuroNet.respond() uses. */
  correct: boolean;
  /** Correct, and also a clear match (cosine at least MIN_COSINE), not just the least wrong. */
  confident: boolean;
}

function mse(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const e = b[i] - a[i]; s += e * e; }
  return n ? s / n : 0;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** The net's own declared (input -> response) pairs, as test cases. */
export function casesFromNet(net: BuiltNet): DebugCase[] {
  const out: DebugCase[] = [];
  for (const c of net.contracts()) {
    const n = net.neurons.get(c.neuron);
    out.push({
      id: `declared:${c.neuron}`,
      text: n?.input ?? c.neuron,
      expect: c.response,
      drive: c.neuron,
      read: c.readoutName,
      source: "declared",
    });
  }
  return out.slice(0, MAX_CASES);
}

/**
 * Repeated mistakes that say what the right answer was. A mistake without an
 * `expected` answer has nothing to test against, so it is left out rather than
 * guessed at.
 */
export function casesFromMistakes(mistakes: Mistake[], minOccurrences = 2): DebugCase[] {
  const out: DebugCase[] = [];
  for (const m of mistakes) {
    if (m.resolved || m.occurrences < minOccurrences || !m.expected?.trim()) continue;
    out.push({ id: `mistake:${m.id}`, text: m.task, expect: m.expected.trim(), source: "mistake", note: m.description });
  }
  return out.slice(0, MAX_CASES);
}

/** Cases ready to run: unique ids, bounded, empty ones dropped. */
export function normalizeCases(cases: DebugCase[]): DebugCase[] {
  const seen = new Set<string>();
  const out: DebugCase[] = [];
  for (const c of cases) {
    if (!c || typeof c.text !== "string" || typeof c.expect !== "string" || !c.text.trim() || !c.expect.trim()) continue;
    let id = c.id || `case:${out.length + 1}`;
    while (seen.has(id)) id += "'";
    seen.add(id);
    out.push({ ...c, id, text: c.text.trim(), expect: c.expect.trim() });
    if (out.length >= MAX_CASES) break;
  }
  return out;
}

/** Run every case through the net (reading does not train) and say how each did. */
export function scoreSuite(net: BuiltNet, cases: DebugCase[], minCosine = MIN_COSINE): CaseScore[] {
  const answers = new Map<string, Float32Array | number[]>();
  for (const c of cases) if (!answers.has(c.expect)) answers.set(c.expect, embedText(c.expect, net.dims));
  for (const c of net.contracts()) if (!answers.has(c.response)) answers.set(c.response, c.target);
  return cases.map(c => {
    const drive = c.drive ?? net.routeInput(c.text);
    const output = net.run(drive, c.text, c.read ?? net.outputName);
    const goal = answers.get(c.expect)!;
    let nearest: string | null = null, best = -Infinity;
    for (const [answer, vec] of answers) {
      const s = cosine(output, vec);
      if (s > best) { best = s; nearest = answer; }
    }
    const cos = cosine(output, goal);
    const correct = nearest === c.expect;
    return { id: c.id, loss: mse(output, goal), cosine: cos, nearest, correct, confident: correct && cos >= minCosine };
  });
}

export interface SuiteSummary {
  cases: number;
  correct: number;
  confident: number;
  /** Sum of every case's loss: one number for "how wrong is it overall". */
  totalLoss: number;
}

export function summarize(scores: CaseScore[]): SuiteSummary {
  return { cases: scores.length, correct: scores.filter(s => s.correct).length, confident: scores.filter(s => s.confident).length, totalLoss: scores.reduce((t, s) => t + s.loss, 0) };
}

// ── The weight ledger: what had big input, and what the history says ─────

export interface WeightRecord {
  key: string;
  /** Times this weight showed up in a diagnosis. */
  examined: number;
  /** Times it was at least BIG_SHARE of what its neuron heard on a dimension. */
  bigInput: number;
  edits: number;
  kept: number;
  undone: number;
  /** Loss removed from the cases it was edited for, summed over kept edits. */
  lossGain: number;
  lastAt: number;
}

export const weightKey = (net: string, target: string, source: string, dim: number): string => `${net}:${target}<-${source}@${dim}`;

export class WeightLedger {
  private readonly records = new Map<string, WeightRecord>();

  private touch(key: string, now: number): WeightRecord {
    let r = this.records.get(key);
    if (!r) {
      r = { key, examined: 0, bigInput: 0, edits: 0, kept: 0, undone: 0, lossGain: 0, lastAt: now };
      this.records.set(key, r);
    }
    r.lastAt = now;
    return r;
  }

  /** A diagnosis looked at this weight and it carried `share` of what its neuron hears. */
  examine(key: string, share: number, now = Date.now()): void {
    const r = this.touch(key, now);
    r.examined++;
    if (share >= BIG_SHARE) r.bigInput++;
    this.trim();
  }

  /** An edit to this weight was kept (with the loss it removed) or undone. */
  edited(key: string, kept: boolean, lossGain: number, now = Date.now()): void {
    const r = this.touch(key, now);
    r.edits++;
    if (kept) { r.kept++; r.lossGain += Math.max(0, lossGain); } else r.undone++;
    this.trim();
  }

  /**
   * How much to trust editing this weight, 0..1, from what happened last time.
   * A weight never edited is 0.5 (no opinion); each kept edit raises it, each
   * undone edit lowers it.
   */
  trust(key: string): number {
    const r = this.records.get(key);
    if (!r) return 0.5;
    return (r.kept + 1) / (r.kept + r.undone + 2);
  }

  get(key: string): WeightRecord | undefined { return this.records.get(key); }
  size(): number { return this.records.size; }

  /** The weights that most often carried a big share, then the most edited. */
  top(n = 10): WeightRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => (b.bigInput - a.bigInput) || (b.edits - a.edits) || (b.lastAt - a.lastAt))
      .slice(0, n)
      .map(r => ({ ...r }));
  }

  private trim(): void {
    if (this.records.size <= MAX_LEDGER) return;
    // Drop the least informative: fewest looks and edits, oldest first.
    const worst = Array.from(this.records.values())
      .sort((a, b) => (a.examined + 3 * a.edits) - (b.examined + 3 * b.edits) || a.lastAt - b.lastAt)
      .slice(0, this.records.size - MAX_LEDGER);
    for (const r of worst) this.records.delete(r.key);
  }

  toJSON(): WeightRecord[] { return Array.from(this.records.values()); }

  static fromJSON(raw: unknown): WeightLedger {
    const ledger = new WeightLedger();
    if (!Array.isArray(raw)) return ledger;
    for (const r of raw.slice(0, MAX_LEDGER)) {
      if (!r || typeof r !== "object" || typeof (r as WeightRecord).key !== "string") continue;
      const x = r as WeightRecord;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      ledger.records.set(x.key, { key: x.key, examined: n(x.examined), bigInput: n(x.bigInput), edits: n(x.edits), kept: n(x.kept), undone: n(x.undone), lossGain: n(x.lossGain), lastAt: n(x.lastAt) });
    }
    return ledger;
  }
}

// ── Skills and plugins it can make ───────────────────────────────────────

export interface ScriptPair { userSays: string; response: string }

export interface SkillSpec {
  name: string;
  description: string;
  scripts: ScriptPair[];
  sources: string[];
}

export interface SkillResult {
  ok: boolean;
  /** Where the skill was installed, when it was. */
  id?: string;
  /** Whether the Extension Builder's training reproduced every script. Reported, not required: a skill answers by matching what was typed to a stored script either way. */
  converged: boolean;
  detail: string;
}

/** Makes and installs a trained skill. Normally built on the Extension Builder; see interface/self-debug-wiring.ts. */
export type SkillMaker = (spec: SkillSpec) => Promise<SkillResult>;

export interface PluginSpec {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  table: ScriptPair[];
}

export interface PluginResult {
  ok: boolean;
  id?: string;
  detail: string;
}

/** Installs a plugin's source INERT. It must not activate it. */
export type PluginProposer = (source: string, spec: PluginSpec) => Promise<PluginResult>;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

/**
 * The plugin's source, from a fixed template. The only variable parts are the id,
 * the name and the (input -> response) table, all inserted as JSON data, never as
 * code. The plugin answers a message when it is close to one of its inputs and
 * otherwise declines; it reads nothing, writes nothing and reaches nothing.
 */
export function makePluginSource(spec: PluginSpec): string {
  const id = slug(spec.id);
  const cls = id.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase()) + "Plugin";
  const table = spec.table.slice(0, 64).map(p => ({ userSays: p.userSays.slice(0, 400), response: p.response.slice(0, 1200) }));
  const caps = spec.capabilities.slice(0, 8).map(c => slug(c));
  return [
    `// Written by the self-debug loop from skills it trained. Installed inactive: it does nothing until the owner approves it.`,
    `import type { PluginDefinition } from "../plugin_manager/types.js";`,
    `import { BasePlugin } from "../plugin_manager/sdk.js";`,
    ``,
    `const TABLE: { userSays: string; response: string }[] = ${JSON.stringify(table)};`,
    `const THRESHOLD = 0.6;`,
    ``,
    `function words(text: string): string[] {`,
    `  return text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);`,
    `}`,
    ``,
    `function closeness(a: string[], b: string[]): number {`,
    `  if (a.length === 0 || b.length === 0) return 0;`,
    `  const set = new Set(b);`,
    `  let hit = 0;`,
    `  for (const w of new Set(a)) if (set.has(w)) hit++;`,
    `  return hit / Math.sqrt(new Set(a).size * set.size);`,
    `}`,
    ``,
    `function best(message: unknown): { response: string; similarity: number } | null {`,
    `  const heard = words(String(message ?? ""));`,
    `  let found: { response: string; similarity: number } | null = null;`,
    `  for (const row of TABLE) {`,
    `    const similarity = closeness(heard, words(row.userSays));`,
    `    if (similarity >= THRESHOLD && (!found || similarity > found.similarity)) found = { response: row.response, similarity };`,
    `  }`,
    `  return found;`,
    `}`,
    ``,
    `export class ${cls} extends BasePlugin {`,
    `  wouldAct(message: unknown): boolean { return best(message) !== null; }`,
    ``,
    `  async onMessage(message: unknown): Promise<unknown> {`,
    `    const hit = best(message);`,
    `    return hit ? { type: ${JSON.stringify(id)}, matched: true, response: hit.response, similarity: hit.similarity } : { type: ${JSON.stringify(id)}, matched: false };`,
    `  }`,
    ``,
    `  async onHealthCheck(): Promise<boolean> { return TABLE.length > 0; }`,
    `}`,
    ``,
    `export const pluginDefinition: PluginDefinition = {`,
    `  id: ${JSON.stringify(id)},`,
    `  name: ${JSON.stringify(spec.name.slice(0, 80))},`,
    `  type: "skill-expert",`,
    `  capabilities: ${JSON.stringify(caps)},`,
    `};`,
    ``,
  ].join("\n");
}

/** Imports a generated plugin may have, and nothing else. */
const ALLOWED_IMPORTS = new Set(["../plugin_manager/types.js", "../plugin_manager/sdk.js"]);
const FORBIDDEN = /\b(require|eval|Function|process|child_process|import|fetch|XMLHttpRequest|WebSocket|globalThis|window|document|fs|net|http|https|dgram|vm|worker_threads|constructor|prototype|__proto__|Buffer|setTimeout|setInterval|setImmediate)\b/;

export interface VetResult { ok: boolean; problems: string[] }

/**
 * A tripwire, not a sandbox: the proposer only ever writes the template above,
 * so this catches a template that drifted or a file that was changed after it
 * was written. Strings and comments are blanked first so a response that
 * happens to say "process" is not a false alarm.
 */
export function vetPluginSource(source: string): VetResult {
  const problems: string[] = [];
  const imports = Array.from(source.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)";?\s*$/gm));
  for (const m of imports) if (!ALLOWED_IMPORTS.has(m[1])) problems.push(`import of "${m[1]}" is not allowed`);
  // Blank comments, then strings, then the (checked) import lines themselves.
  let code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ")
    .replace(/^\s*import\s+(?:type\s+)?[^;]*?from\s+"[^"]+";?\s*$/gm, " ");
  if (/`/.test(code)) problems.push("template literals are not allowed");
  code = code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const bad = code.match(FORBIDDEN);
  if (bad) problems.push(`"${bad[1]}" is not allowed in a generated plugin`);
  if (source.length > 200_000) problems.push("source is too large");
  return { ok: problems.length === 0, problems };
}

// ── The record of a run ──────────────────────────────────────────────────

export interface DialogueLine {
  speaker: "debugger" | "critic";
  text: string;
  round?: number;
}

export interface EditView {
  target: string;
  source: string;
  dim: number;
  before: number;
  after: number;
}

export interface RoundRecord {
  n: number;
  caseId: string;
  /** "nudge": a few bounded weight edits. "retrain": the whole case set trained together; too many weights to list, so `edits` is empty. */
  kind: "nudge" | "retrain";
  size: number;
  /** The heaviest weights the diagnosis saw, as plain text. */
  heavy: string[];
  edits: EditView[];
  caseLossBefore: number;
  caseLossAfter: number;
  /** Cases other than the target that got better, worse, or went from right to wrong. */
  better: string[];
  worse: string[];
  flipped: string[];
  verdict: "kept" | "undone";
  reason: string;
}

export interface ProblemRecord {
  id: string;
  source: ProblemSource;
  text: string;
  expect: string;
  lossBefore: number;
  lossAfter: number;
  /** "fixed" in weights, "skill" covered by a made skill, "weak" right but not yet a clear match, "stalled" still wrong, "refused" a frozen neuron stood in the way, "untried" the run ended before it got there. */
  outcome: "fixed" | "skill" | "weak" | "stalled" | "refused" | "untried";
  rounds: number;
}

export interface SkillOutcome {
  name: string;
  scripts: number;
  /** Made and installed. */
  ok: boolean;
  /** The Extension Builder's training reproduced every script. */
  trained: boolean;
  id?: string;
  detail: string;
}

export interface PluginOutcome {
  id: string;
  ok: boolean;
  /** True when it was installed and is waiting for the owner. */
  pendingApproval: boolean;
  detail: string;
}

export type StopReason = "all-correct" | "nothing-to-fix" | "patience" | "budget" | "time" | "undo-mismatch" | "error";

export interface DebugSession {
  id: string;
  net: string;
  startedAt: number;
  endedAt: number;
  before: SuiteSummary;
  after: SuiteSummary;
  problems: ProblemRecord[];
  rounds: RoundRecord[];
  dialogue: DialogueLine[];
  skills: SkillOutcome[];
  plugins: PluginOutcome[];
  /** Things seen that no weight can fix (errors in the log, say). Reported, not hidden. */
  observations: string[];
  stopReason: StopReason;
  /** True when the run was rolled back to where it started. */
  restored: boolean;
}

export interface DebugOptions {
  /** Most edit rounds in total. Default 60. */
  maxRounds?: number;
  /** Misses in a row on one case before giving up on it. Default 3. */
  patience?: number;
  /** Weights changed per round. Default 3. */
  edits?: number;
  /** How close a right answer must be to count as a clear match, 0..1. Default MIN_COSINE. */
  minCosine?: number;
  /** Time budget in ms. Default 15000. */
  maxMs?: number;
  /** Make a skill for cases the weights cannot fix. Default true when a maker is set. */
  makeSkills?: boolean;
  /** Propose a plugin when enough skills were made. Default true when a proposer is set. */
  makePlugins?: boolean;
  /** Things seen that weights cannot fix, copied into the report (e.g. recent errors). */
  observations?: string[];
}

export interface SelfDebuggerOptions {
  ledger?: WeightLedger;
  makeSkill?: SkillMaker;
  proposePlugin?: PluginProposer;
  /** Activates an installed plugin once the owner approves. */
  activatePlugin?: (id: string) => Promise<void>;
  actions?: ActionLog;
  now?: () => number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fix = (x: number) => x.toFixed(4);
const yieldLoop = () => new Promise<void>(resolve => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

function describeLine(l: WeightLine): string {
  return `${l.source} → ${l.target} on dimension ${l.dim} (${pct(l.share)} of what ${l.target} hears there, pushing ${l.contribution >= 0 ? "up" : "down"})`;
}

export class SelfDebugger {
  readonly ledger: WeightLedger;
  readonly actions: ActionLog;
  private readonly sessions: DebugSession[] = [];
  private readonly pending = new Map<string, ActionRecord>();
  private seq = 0;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly opts: SelfDebuggerOptions = {}) {
    this.ledger = opts.ledger ?? new WeightLedger();
    this.actions = opts.actions ?? new ActionLog();
    this.now = opts.now ?? Date.now;
    // A plugin is code. Making a skill is data and needs no approval; waking a plugin does.
    this.actions.requireApprovalFor(a => a.startsWith("plugin:activate:"));
  }

  isRunning(): boolean { return this.running; }
  history(): DebugSession[] { return this.sessions.slice(); }
  last(): DebugSession | undefined { return this.sessions[this.sessions.length - 1]; }

  /** Plugins installed and waiting for the owner. */
  pendingPlugins(): { id: string; why: string }[] {
    return Array.from(this.pending.entries()).map(([id, r]) => ({ id, why: r.why }));
  }

  /** The owner approves: the plugin is activated and the action is logged either way. */
  async approvePlugin(id: string): Promise<{ ok: boolean; detail: string }> {
    const record = this.pending.get(id);
    if (!record) return { ok: false, detail: `no plugin "${id}" is waiting for approval` };
    this.actions.approve(record);
    this.pending.delete(id);
    try {
      if (!this.opts.activatePlugin) throw new Error("no way to activate plugins is connected");
      await this.opts.activatePlugin(id);
      record.result = "success";
      return { ok: true, detail: `plugin "${id}" approved and activated` };
    } catch (err) {
      record.result = `error: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, detail: record.result };
    }
  }

  /** The owner refuses: the plugin stays installed, inactive. */
  denyPlugin(id: string): { ok: boolean; detail: string } {
    const record = this.pending.get(id);
    if (!record) return { ok: false, detail: `no plugin "${id}" is waiting for approval` };
    this.actions.deny(record);
    this.pending.delete(id);
    return { ok: true, detail: `plugin "${id}" denied; it stays inactive` };
  }

  /**
   * Debug one net against its test cases. Never throws for a normal failure:
   * the report says what happened. One run at a time.
   */
  async debug(netName: string, net: BuiltNet, rawCases: DebugCase[], options: DebugOptions = {}, editor: WeightEditor = new WeightEditor(net)): Promise<DebugSession> {
    if (this.running) throw new Error("a self-debug run is already in progress");
    this.running = true;
    const startedAt = this.now();
    const cases = normalizeCases(rawCases);
    const dialogue: DialogueLine[] = [];
    const say = (speaker: DialogueLine["speaker"], text: string, round?: number) => {
      if (dialogue.length < MAX_DIALOGUE) dialogue.push({ speaker, text, round });
    };
    const rounds: RoundRecord[] = [];
    const problemRecords: ProblemRecord[] = [];
    const skills: SkillOutcome[] = [];
    const plugins: PluginOutcome[] = [];
    const maxRounds = Math.max(1, Math.min(options.maxRounds ?? 60, 500));
    const patience = Math.max(1, Math.min(options.patience ?? 3, 10));
    const perRound = Math.max(1, Math.min(options.edits ?? 3, 8));
    const maxMs = Math.max(500, Math.min(options.maxMs ?? 15_000, 120_000));
    const deadline = startedAt + maxMs;
    let stopReason: StopReason = "all-correct";
    let restored = false;

    // The whole state, so any failure can put everything back exactly.
    const checkpoint = net.engine.captureNetworkState();
    const minCos = Math.max(0, Math.min(options.minCosine ?? MIN_COSINE, 0.99));
    const score = () => scoreSuite(net, cases, minCos);
    const before = score();
    const beforeSummary = summarize(before);

    try {
      if (cases.length === 0) {
        stopReason = "nothing-to-fix";
        say("debugger", "I have no test cases for this net, so there is nothing to check it against.");
      } else {
        say("debugger", `I ran ${cases.length} case${cases.length === 1 ? "" : "s"}: ${beforeSummary.correct} right (${beforeSummary.confident} clearly), ${cases.length - beforeSummary.correct} wrong. Overall error ${fix(beforeSummary.totalLoss)}.`);
      }

      const failing = cases
        .map((c, i) => ({ c, s: before[i] }))
        .filter(x => !x.s.confident)
        .sort((a, b) => b.s.loss - a.s.loss);

      if (cases.length > 0 && failing.length === 0) {
        say("critic", "Everything passes. I will not change a weight that is not causing a problem.");
      }

      let roundNo = 0;
      let current = before;
      const stalled: DebugCase[] = [];

      // The critic. It re-measures with its own run and judges a change two ways:
      // against where this round began, and against where the whole run began, so
      // many small harmless-looking changes cannot add up to a regression.
      const judge = (idx: number, now: CaseScore[], after: CaseScore[]) => {
        const better: string[] = [], worse: string[] = [], flipped: string[] = [];
        for (let i = 0; i < cases.length; i++) {
          if (i === idx) continue;
          const b = now[i], a = after[i], s0 = before[i];
          if (b.correct && !a.correct) flipped.push(cases[i].id);
          if (a.loss > b.loss * (1 + REGRESS_FRACTION) + REGRESS_FLOOR || a.loss > s0.loss * (1 + REGRESS_FRACTION) + REGRESS_FLOOR) worse.push(cases[i].id);
          else if (a.loss < b.loss - MIN_GAIN) better.push(cases[i].id);
        }
        const gain = now[idx].loss - after[idx].loss;
        let verdict: RoundRecord["verdict"] = "kept";
        let reason = `${cases[idx].id} improved ${fix(now[idx].loss)} → ${fix(after[idx].loss)}${better.length ? `; also better: ${better.join(", ")}` : ""}.`;
        if (gain < MIN_GAIN) { verdict = "undone"; reason = `${cases[idx].id} did not improve (${fix(now[idx].loss)} → ${fix(after[idx].loss)}).`; }
        else if (flipped.length) { verdict = "undone"; reason = `it fixed ${cases[idx].id} but broke ${flipped.join(", ")}, which were right.`; }
        else if (worse.length) { verdict = "undone"; reason = `it helped ${cases[idx].id} but made ${worse.join(", ")} worse.`; }
        return { better, worse, flipped, gain, verdict, reason };
      };

      for (const { c } of failing) {
        const idx = cases.indexOf(c);
        const startScore = current[idx];
        let size = START_SIZE;
        let misses = 0;
        let tiny = 0;
        let retrains = 0;
        let roundsHere = 0;
        let refused = false;
        const drive = c.drive ?? net.routeInput(c.text);
        const read = c.read ?? net.outputName;
        say("debugger", `Problem "${c.id}": typed "${c.text}", wanted "${c.expect}". ${startScore.correct ? `The nearest answer is right but only a weak match (cosine ${startScore.cosine.toFixed(2)}).` : `The net is nearest to ${startScore.nearest !== null ? `"${startScore.nearest}"` : "nothing"} instead.`} Error ${fix(startScore.loss)}.`);

        while (true) {
          const here = current[idx];
          if (here.confident) break;
          if (roundNo >= maxRounds) { stopReason = "budget"; break; }
          if (this.now() >= deadline) { stopReason = "time"; break; }
          await yieldLoop();

          // Second rung. Nudging has stopped helping (edits keep being undone, or the gains are
          // tiny), so retrain on every case at once, the way the Extension Builder trains. The
          // other cases are in the training set, so they are held in place while this one moves.
          if (misses >= patience || tiny >= patience) {
            if (retrains < RETRAIN_EPOCHS.length && !net.isFrozen(read)) {
              roundNo++; roundsHere++;
              const epochs = RETRAIN_EPOCHS[retrains++];
              say("debugger", `Nudging has stopped helping (${tiny >= patience ? "the gains are tiny" : "edits keep getting undone"}). Next: retrain on all ${cases.length} cases for up to ${epochs} epochs, so the other answers are held in place while this one moves.`, roundNo);
              const snap = net.engine.captureNetworkState();
              const t = net.trainCases(cases.map(x => ({ drive: x.drive, read: x.read, text: x.text, expect: x.expect })), { epochs });
              const after = score();
              const j = t.trained === 0 ? { ...judge(idx, current, after), verdict: "undone" as const, reason: "no case could be trained (their output neurons are frozen)." } : judge(idx, current, after);
              if (j.verdict === "kept") {
                current = after; misses = 0; tiny = 0;
                say("critic", `Keep the retrain (${t.epochs} epochs, ${t.trained} cases). ${j.reason}${after[idx].confident ? " It is right now." : ""}`, roundNo);
              } else {
                net.engine.restoreNetworkState(snap);
                const back = summarize(score()).totalLoss, was = summarize(current).totalLoss;
                say("critic", `Undo the retrain. ${j.reason} The whole network is put back as it was.`, roundNo);
                if (Math.abs(back - was) > 1e-5) {
                  stopReason = "undo-mismatch";
                  say("critic", "The restore did not match what it was before. Restoring the network from before the run.", roundNo);
                  throw new Error("undo mismatch");
                }
                misses = patience; // the next time round, with no retrains left, this problem is done
              }
              rounds.push({
                n: roundNo, caseId: c.id, kind: "retrain", size: 0, heavy: [], edits: [],
                caseLossBefore: here.loss, caseLossAfter: j.verdict === "kept" ? after[idx].loss : here.loss,
                better: j.better, worse: j.worse, flipped: j.flipped, verdict: j.verdict, reason: j.reason,
              });
              continue;
            }
            if (stopReason === "all-correct") stopReason = "patience";
            break;
          }

          // See: which weights decide this output, and how much each carries.
          const view = editor.view({ drive, read, text: c.text, goal: c.expect, top: 12 });
          const goal = embedText(c.expect, net.dims);
          for (const l of view.lines) if (l.kind === "own") this.ledger.examine(weightKey(netName, l.target, l.source, l.dim), l.share, this.now());

          // Choose: the biggest share, pushed the way the error says, weighted by what history says about it.
          const ranked = view.lines
            .filter(l => l.editable && l.kind === "own")
            .map(l => {
              const want = (goal[l.dim - 1] - view.output[l.dim - 1]) * l.sourceValue;
              const trust = this.ledger.trust(weightKey(netName, l.target, l.source, l.dim));
              return { l, want, rank: l.share * Math.abs(want) * (0.25 + trust) };
            })
            .filter(x => Math.abs(x.want) >= 1e-3)
            .sort((a, b) => b.rank - a.rank);
          if (ranked.length === 0) {
            refused = net.isFrozen(read);
            say("debugger", refused ? `"${read}" is frozen, so I may not edit what it hears. Leaving it.` : "No weight can usefully move toward this answer from here.");
            break;
          }
          const picks = ranked.slice(0, perRound);
          const heavy = view.lines.filter(l => l.kind === "own").slice(0, 4).map(describeLine);
          roundNo++; roundsHere++;
          say("debugger", `Round ${roundNo}: heaviest weights — ${heavy.slice(0, 2).join("; ")}. History trusts ${picks.map(p => `${p.l.source}→${p.l.target}@${p.l.dim} at ${pct(this.ledger.trust(weightKey(netName, p.l.target, p.l.source, p.l.dim)))}`).join(", ")}. I will nudge ${picks.length} by ${size.toFixed(3)}.`, roundNo);

          // Edit: only through the weight editor.
          const made: EditView[] = [];
          for (const p of picks) {
            try {
              const e = editor.nudge(p.l.target, p.l.source, p.l.dim, p.want > 0 ? size : -size, `self-debug: toward "${c.expect}"`);
              made.push({ target: e.target, source: e.source, dim: e.dim, before: e.before, after: e.after });
            } catch (err) {
              if (err instanceof EditRefused) { refused = true; continue; }
              throw err;
            }
          }
          if (made.length === 0) { say("debugger", "Every edit I wanted was refused.", roundNo); break; }

          const after = score();
          const j = judge(idx, current, after);
          if (j.verdict === "kept") {
            for (const e of made) this.ledger.edited(weightKey(netName, e.target, e.source, e.dim), true, j.gain / made.length, this.now());
            tiny = j.gain / Math.max(here.loss, 1e-9) < 1e-3 ? tiny + 1 : 0;
            current = after; misses = 0; size = Math.min(size * 1.5, MAX_NUDGE);
            say("critic", `Keep. ${j.reason}${after[idx].confident ? " It is right now." : ""}`, roundNo);
          } else {
            editor.undo(made.length);
            // Check the undo put every weight back exactly; if not, stop and restore everything.
            const mismatch = made.find(e => Math.abs(net.engine.getConnectionWeight(net.idOf(e.target), net.idOf(e.source), e.dim) - e.before) > 1e-9);
            for (const e of made) this.ledger.edited(weightKey(netName, e.target, e.source, e.dim), false, 0, this.now());
            misses++; size = Math.max(size / 2, MIN_SIZE);
            say("critic", `Undo. ${j.reason} Next time smaller (${size.toFixed(3)}), and I will remember these weights did not help.`, roundNo);
            if (mismatch) {
              stopReason = "undo-mismatch";
              say("critic", "An undo did not put a weight back exactly. Restoring the whole network from before the run.", roundNo);
              throw new Error("undo mismatch");
            }
          }
          rounds.push({
            n: roundNo, caseId: c.id, kind: "nudge", size: Math.abs(made[0].after - made[0].before), heavy, edits: made,
            caseLossBefore: here.loss, caseLossAfter: j.verdict === "kept" ? after[idx].loss : here.loss,
            better: j.better, worse: j.worse, flipped: j.flipped, verdict: j.verdict, reason: j.reason,
          });
        }

        const fin = current[idx];
        problemRecords.push({
          id: c.id, source: c.source, text: c.text, expect: c.expect,
          lossBefore: startScore.loss, lossAfter: fin.loss,
          outcome: fin.confident ? "fixed" : refused ? "refused" : fin.correct ? "weak" : "stalled", rounds: roundsHere,
        });
        const outOfBudget = stopReason === "budget" || stopReason === "time";
        // Only a WRONG answer is a missing skill; a right but weak one is just tuned as far as it goes.
        // And a problem that only ran out of budget has not shown that weights cannot fix it.
        if (!fin.correct && !refused && !outOfBudget) stalled.push(c);
        if (fin.confident) say("critic", `"${c.id}" is right now (error ${fix(startScore.loss)} → ${fix(fin.loss)}) after ${roundsHere} round${roundsHere === 1 ? "" : "s"}.`);
        if (outOfBudget) {
          say("critic", stopReason === "time" ? "Out of time. Stopping here; the rest can wait for the next run." : "Out of rounds. Stopping here; the rest can wait for the next run.");
          break;
        }
      }

      // Problems the run never got to are still part of the report.
      for (const { c } of failing) {
        if (problemRecords.some(p => p.id === c.id)) continue;
        const sc = current[cases.indexOf(c)];
        problemRecords.push({ id: c.id, source: c.source, text: c.text, expect: c.expect, lossBefore: sc.loss, lossAfter: sc.loss, outcome: "untried", rounds: 0 });
      }

      // Weights could not fix these: make a skill from what they should say.
      const wantSkills = options.makeSkills ?? !!this.opts.makeSkill;
      if (stalled.length > 0 && wantSkills && this.opts.makeSkill) {
        const spec: SkillSpec = {
          name: `self-debug-${slug(netName)}-${++this.seq}`,
          description: `Learned by the self-debug loop: ${stalled.length} answer${stalled.length === 1 ? "" : "s"} the weights of "${netName}" could not be nudged into.`,
          scripts: stalled.map(c => ({ userSays: c.text, response: c.expect })),
          sources: ["self-debug", netName],
        };
        say("debugger", `The weights stalled on ${stalled.length} case${stalled.length === 1 ? "" : "s"}. That looks like a missing skill, not a tuning problem, so I will make a skill for them with the Extension Builder: ${spec.name}.`);
        const record = this.actions.request(`skill:create:${spec.name}`, spec.description, "self-debug");
        let outcome: SkillOutcome;
        try {
          const r = await this.opts.makeSkill(spec);
          outcome = { name: spec.name, scripts: spec.scripts.length, ok: r.ok, trained: r.ok && r.converged, id: r.id, detail: r.detail };
          record.result = outcome.ok ? "success" : `not kept: ${r.detail}`;
        } catch (err) {
          outcome = { name: spec.name, scripts: spec.scripts.length, ok: false, trained: false, detail: err instanceof Error ? err.message : String(err) };
          record.result = `error: ${outcome.detail}`;
        }
        skills.push(outcome);
        say("critic", outcome.ok ? `Skill ${spec.name} installed: ${outcome.detail}.` : `Skill ${spec.name} was NOT kept: ${outcome.detail}.`);
        if (outcome.ok) for (const p of problemRecords) if (p.outcome === "stalled" && stalled.some(s => s.id === p.id)) p.outcome = "skill";
      }

      // Enough skills: propose a plugin. It is installed inactive and waits for the owner.
      const made = skills.filter(s => s.ok).reduce((t, s) => t + s.scripts, 0);
      const wantPlugins = options.makePlugins ?? !!this.opts.proposePlugin;
      if (wantPlugins && this.opts.proposePlugin && made >= PLUGIN_THRESHOLD) {
        const table = stalled.map(c => ({ userSays: c.text, response: c.expect }));
        const spec: PluginSpec = {
          id: `self-debug-${slug(netName)}-plugin`,
          name: `Answers learned while debugging ${netName}`,
          description: `Answers ${table.length} questions the self-debug loop learned for "${netName}".`,
          capabilities: ["answer"],
          table,
        };
        const source = makePluginSource(spec);
        const vet = vetPluginSource(source);
        if (!vet.ok) {
          plugins.push({ id: spec.id, ok: false, pendingApproval: false, detail: `vetting refused it: ${vet.problems.join("; ")}` });
          say("critic", `I wrote a plugin but vetting refused it (${vet.problems.join("; ")}), so it was not installed.`);
        } else {
          const record = this.actions.request(`plugin:propose:${spec.id}`, spec.description, "self-debug");
          try {
            const r = await this.opts.proposePlugin(source, spec);
            record.result = r.ok ? "success" : `not installed: ${r.detail}`;
            if (r.ok) {
              const activation = this.actions.request(`plugin:activate:${r.id ?? spec.id}`, `Turn on ${spec.name}`, "self-debug");
              this.pending.set(r.id ?? spec.id, activation);
            }
            plugins.push({ id: r.id ?? spec.id, ok: r.ok, pendingApproval: r.ok, detail: r.detail });
            say("critic", r.ok ? `Plugin ${r.id ?? spec.id} is installed but OFF. It needs the owner's approval before it does anything.` : `Plugin was not installed: ${r.detail}.`);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            record.result = `error: ${detail}`;
            plugins.push({ id: spec.id, ok: false, pendingApproval: false, detail });
          }
        }
      }
    } catch (err) {
      if (stopReason === "all-correct") stopReason = "error";
      say("critic", `Something went wrong (${err instanceof Error ? err.message : String(err)}). Putting the network back as it was.`);
      net.engine.restoreNetworkState(checkpoint);
      restored = true;
    } finally {
      this.running = false;
    }

    let after = score();
    let afterSummary = summarize(after);
    // Never leave a run worse than it began.
    if (!restored && afterSummary.correct < beforeSummary.correct) {
      net.engine.restoreNetworkState(checkpoint);
      restored = true;
      after = score();
      afterSummary = summarize(after);
      say("critic", "The run ended with fewer right answers than it began with, so I restored the network from before it.");
    }
    if (stopReason === "all-correct" && afterSummary.confident < afterSummary.cases) stopReason = "patience";
    say("critic", `Finished: ${beforeSummary.correct}/${beforeSummary.cases} right (${beforeSummary.confident} clearly) → ${afterSummary.correct}/${afterSummary.cases} (${afterSummary.confident} clearly); overall error ${fix(beforeSummary.totalLoss)} → ${fix(afterSummary.totalLoss)}.`);

    const session: DebugSession = {
      id: `sd_${startedAt.toString(36)}_${(++this.seq).toString(36)}`,
      net: netName, startedAt, endedAt: this.now(),
      before: beforeSummary, after: afterSummary,
      problems: problemRecords, rounds, dialogue, skills, plugins,
      observations: (options.observations ?? []).slice(0, 20), stopReason, restored,
    };
    this.sessions.push(session);
    while (this.sessions.length > MAX_SESSIONS) this.sessions.shift();
    return session;
  }
}

