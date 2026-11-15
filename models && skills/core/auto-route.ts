/**
 * Auto route: for one message, decide how much to spend, and where.
 *
 * Until now "local or cloud" was a yes or no, and effort was a dial somebody had to turn. This makes three
 * decisions together, from the message and from this device, and shows its working:
 *
 *   1. EFFORT (0-100)     how hard to try: from how big and how careful the job looks. The same dial as
 *                         core/effort.ts, so what it picks rides the Zip Loop exactly as a hand-set dial does.
 *   2. WHERE              local-quantized, local-full, or remote (a bigger computer this device may borrow:
 *                         compute-share peers or the hosted server, engine-chooser.ts). "Cloud" here means
 *                         that remote engine; there is no outside service in this file.
 *   3. HOW MUCH PROCESSOR how many of the network's islands run (weight-islands.ts): more effort and a more
 *                         relaxed device run more of them; a busy or low-battery device runs fewer; a
 *                         message that needs a particular chunk always gets it.
 *
 * Two switches the person can set:
 *   instant   answer fast: lowest effort, the lightest engine that can, and only the single most relevant island.
 *   optimize  tidy the prompt first (prompt-optimizer.ts): filler and repeats out, nothing added.
 * A dial the person set by hand always wins over the estimate.
 *
 * Not a language model and does not read the message for meaning: counts, patterns and the same plain arithmetic
 * as the chooser. Nothing throws on its own account; a probe or a peer that fails degrades to "answer here".
 *
 * Be plain about what is real today. WHERE and EFFORT take effect: a remote answer really runs on the other
 * computer, and the effort line reaches the mesh. The island plan is computed and returned, and when a partition is
 * supplied it names the groups that should compute (`activeGroups`); the live generate path does not take them yet.
 */

import type { DeviceProfile } from "./device-profile.js";
import { Chooser, looksLikeSecret, rewardFor, taskSize, type Choice, type Engine } from "./engine-chooser.js";
import { chooserEnabled, defaultDeps, type RouterDeps } from "./engine-router.js";
import { parseEffort, planEffort, type EffortPlan } from "./effort.js";
import { planIslands, scoreIslands, type IslandInfo, type IslandPlan } from "./weight-islands.js";
import { optimizePrompt, type OptimizedPrompt } from "./prompt-optimizer.js";

/* ---------------------------------------------------------------- request */

export interface AutoRouteRequest {
  /** Pick effort, engine and processor automatically. Off unless the caller says so. */
  auto: boolean;
  instant: boolean;
  optimize: boolean;
  /** A dial set by hand, 0-100. Null when nobody set one. */
  effort: number | null;
}

/** Read the switches from a request body. Only a real `true` turns a switch on; anything else is off. */
export function parseAutoRoute(body: unknown): AutoRouteRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const instant = b.instant === true;
  const optimize = b.optimize === true;
  return { auto: b.auto === true || instant, instant, optimize, effort: parseEffort(b.effort) };
}

/* ----------------------------------------------------------------- effort */

const CAREFUL = /\b(carefully|thorough(?:ly)?|double[- ]check|make sure|be sure|exact(?:ly)?|precise(?:ly)?|rigorous(?:ly)?|in[- ]depth|prove|proof|edge cases?|correctness|no mistakes)\b/i;
const QUICK = /\b(quick(?:ly)?|briefly|short answer|tl;?dr|one word|just tell me|real quick|in a nutshell|rough(?:ly)?|ballpark)\b/i;
const MATH = /(?:\d\s*[-+*/^=]\s*\d|\b(?:integral|derivative|equation|theorem|lemma|prove|proof|derive|probability|matrix|algorithm)\b)/i;
const SMALL_TALK = /^\s*(?:hi|hello|hey|thanks?|thank you|ok(?:ay)?|cool|nice|yes|no|yep|nope|lol|good (?:morning|night|evening)|bye)\b[\s!.?,]*$/i;
const ACTIONS = /\b(design|implement|write|explain|compare|analy[sz]e|debug|refactor|test|prove|derive|plan|review|summari[sz]e|translate|optimi[sz]e|build|fix|migrate|audit)\b/gi;

export interface EffortEstimate {
  level: number;
  reasons: string[];
}

/** How hard to try, 0-100, from the message. Small talk is near 0, a plain question is light, a big careful job is near the top. */
export function estimateEffort(prompt: string, historyChars = 0): EffortEstimate {
  const text = prompt.trim();
  if (SMALL_TALK.test(text)) return { level: 5, reasons: ["small talk"] };
  const { size, reasons } = taskSize(text, historyChars);
  // A plain question still gets a little care; a long or multi-part job climbs from there.
  let level = 25 + size * 10;
  const why = reasons.filter(r => r !== "short and plain");

  const actions = new Set((text.match(ACTIONS) ?? []).map(a => a.toLowerCase()));
  if (actions.size > 1) { level += Math.min(3, actions.size - 1) * 8; why.push(`${actions.size} separate things to do`); }
  if (CAREFUL.test(text)) { level += 20; why.push("asks for care"); }
  if (MATH.test(text)) { level += 10; why.push("maths, a proof or an algorithm"); }
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > 2) { level += 5; why.push(`${questions} questions`); }
  if (QUICK.test(text)) { level -= 25; why.push("asks for it quick or short"); }
  if (why.length === 0) why.push("short and plain");
  return { level: Math.round(Math.min(100, Math.max(0, level))), reasons: why };
}

/* ------------------------------------------------------------------ share */

export interface ComputeShare {
  /** 0-1: the share of islands that may run. */
  share: number;
  reasons: string[];
}

/**
 * How much of the processor to spend. Effort sets the wish (a tenth of the islands at the bottom, all of them at the
 * top), and what the device can spare trims it: a busy processor or a low unplugged battery runs fewer. A tired
 * device never runs everything, whatever the effort.
 */
export function computeShare(effort: number, device: DeviceProfile, instant: boolean): ComputeShare {
  const reasons: string[] = [];
  const load = Math.min(1, Math.max(0, Number.isFinite(device.load) ? device.load : 0));
  const unplugged = device.battery && !device.battery.charging ? 1 : 0;
  const drain = unplugged ? Math.min(1, Math.max(0, 1 - (device.battery?.level ?? 1))) : 0;
  const headroom = Math.min(1, Math.max(0.3, 1 - 0.4 * load - 0.4 * drain));
  if (headroom < 0.7) reasons.push(load > 0.5 ? "the processor is busy" : "the battery is low and unplugged");

  let share: number;
  if (effort >= 90 && headroom >= 0.7) { share = 1; reasons.push("top effort on a device with room: everything runs"); }
  else share = Math.min(1, Math.max(0.1, (0.1 + 0.9 * (effort / 100)) * headroom));
  if (instant) { share = Math.min(share, 0.25); reasons.push("instant: capped at a quarter"); }
  return { share, reasons };
}

/* ------------------------------------------------------------------- plan */

export interface RouteInput {
  prompt: string;
  history?: string[];
  device: DeviceProfile;
  remote: { available: boolean };
  fullModelBytes: number;
  quantizedModelBytes: number;
  request: AutoRouteRequest;
  /** The islands of a clean partition (weight-islands.ts), and how much each skill region is about this message. Both optional. */
  islands?: IslandInfo[];
  regionScore?: (group: string) => number;
}

export interface RoutePlan {
  /** What was in force: the person set a dial, picked instant, or it was all automatic. */
  mode: "auto" | "manual-effort" | "instant";
  prompt: OptimizedPrompt;
  effort: EffortPlan & { estimated: number; source: "auto" | "manual" | "instant" };
  engine: Engine;
  /** local-* answers here; remote is the bigger computer. */
  where: "local" | "cloud";
  choice: Choice;
  compute: ComputeShare & {
    /** Null when the whole answer runs somewhere else, or there is no clean partition to gate on. */
    islands: IslandPlan | null;
    /** The groups that should compute this tick; undefined means ungated (everything runs). */
    activeGroups: Set<string> | undefined;
  };
  reasons: string[];
}

export function planRoute(input: RouteInput, chooser: Chooser = new Chooser()): RoutePlan {
  const req = input.request;
  const reasons: string[] = [];
  const history = input.history ?? [];
  const historyChars = history.reduce((n, h) => n + h.length, 0);

  // 1. The prompt. Instant does not spend even a clean-up.
  const prompt = req.optimize && !req.instant ? optimizePrompt(input.prompt) : optimizePrompt("");
  const used = prompt.changed ? prompt.text : input.prompt;
  if (req.optimize && !req.instant) reasons.push(prompt.changed ? `prompt tidied: ${prompt.changes.join(", ")}` : "prompt already tidy");

  // 2. Effort: instant, then a dial set by hand, then the estimate.
  const estimate = estimateEffort(used, historyChars);
  let level = estimate.level;
  let source: "auto" | "manual" | "instant" = "auto";
  if (req.instant) { level = 5; source = "instant"; reasons.push("instant: lowest effort"); }
  else if (req.effort !== null) { level = req.effort; source = "manual"; reasons.push(`effort ${level} was set by hand`); }
  else reasons.push(`effort ${level}: ${estimate.reasons.join(", ")}`);
  const effort = { ...planEffort(level), estimated: estimate.level, source };

  // 3. Where. The chooser sees the message as it was typed, so a secret is never missed by a tidy-up.
  let choice = chooser.choose({
    device: input.device, prompt: input.prompt, historyChars, remote: input.remote,
    fullModelBytes: input.fullModelBytes, quantizedModelBytes: input.quantizedModelBytes,
  });
  let engine = choice.engine;
  if (req.instant && engine !== "local-quantized" && choice.scores["local-quantized"] !== null) {
    reasons.push(`instant: ${engine} is slower, so the lightest local engine answers`);
    engine = "local-quantized";
  }
  if (looksLikeSecret(input.prompt) && engine === "remote") engine = "local-quantized"; // the chooser rules this out; belt and braces
  reasons.push(...choice.reasons.filter(r => /^chose |is out:|NEUROCLAW_ENGINE/.test(r)).map(r => `engine: ${r}`));
  const where = engine === "remote" ? "cloud" : "local";

  // 4. How much processor, and which islands. Only matters when this device does the answering.
  const cs = computeShare(level, input.device, req.instant);
  let islands: IslandPlan | null = null;
  let activeGroups: Set<string> | undefined;
  if (where === "cloud") {
    reasons.push("the bigger computer runs the whole network; no islands are switched off here");
  } else if (!input.islands || input.islands.length === 0) {
    reasons.push("no clear islands known yet: the whole network runs");
  } else {
    const score = input.regionScore ?? (() => 0);
    islands = planIslands(input.islands, scoreIslands(input.islands, score), { share: cs.share, instant: req.instant });
    if (!islands.ranAll) activeGroups = new Set(islands.run);
    reasons.push(`islands: ${islands.reason}`);
  }
  reasons.push(...cs.reasons);

  const mode = req.instant ? "instant" : source === "manual" ? "manual-effort" : "auto";
  return { mode, prompt, effort, engine, where, choice, compute: { ...cs, islands, activeGroups }, reasons };
}

/** What the page and the details panel get: the decisions and the reasons, small and safe to send as JSON. */
export interface RouteSummary {
  mode: RoutePlan["mode"];
  effort: { level: number; mode: string; checks: number; tryAnother: boolean; source: string; estimated: number };
  where: RoutePlan["where"];
  engine: Engine;
  prompt: { optimized: boolean; changes: string[]; savedChars: number; used: string; original: string };
  compute: { share: number; islandsTotal: number; islandsRun: string[]; islandsOff: string[]; ranAll: boolean };
  reasons: string[];
}

export function routeSummary(plan: RoutePlan, sent: string): RouteSummary {
  const isl = plan.compute.islands;
  return {
    mode: plan.mode,
    effort: { level: plan.effort.level, mode: plan.effort.mode, checks: plan.effort.checks, tryAnother: plan.effort.tryAnother, source: plan.effort.source, estimated: plan.effort.estimated },
    where: plan.where,
    engine: plan.engine,
    prompt: { optimized: plan.prompt.changed, changes: plan.prompt.changes, savedChars: plan.prompt.savedChars, used: sent, original: plan.prompt.changed ? plan.prompt.original : sent },
    compute: { share: Math.round(plan.compute.share * 100) / 100, islandsTotal: isl?.total ?? 0, islandsRun: isl?.run ?? [], islandsOff: isl?.off ?? [], ranAll: isl ? isl.ranAll : true },
    reasons: plan.reasons,
  };
}

/* ------------------------------------------------------------------- run */

export interface AutoRoute {
  plan: RoutePlan;
  /** What to send to the engine: the tidied prompt when optimize is on and changed something, else the original. */
  prompt: string;
  /** Set only when a remote computer answered. Null means: answer on this device. */
  answer: string | null;
  notes: string[];
  /** Report how the local answer went so the chooser can learn from it. A no-op after a remote answer. */
  finish(ok: boolean, ms: number): void;
}

const note = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const UNKNOWN_DEVICE: DeviceProfile = {
  kind: "unknown", platform: "unknown", cores: 1, totalMemBytes: 0, freeMemBytes: 0, load: 0, mops: null, battery: null, online: null,
};

export interface AutoRouteContext {
  islands?: IslandInfo[];
  regionScore?: (group: string) => number;
}

/**
 * Plan the message and, if the plan says remote, run it there. The caller answers locally whenever `answer` is
 * null, exactly as with routeMessage in engine-router.ts: a remote that fails is a note, never an error.
 *
 * Sending a message to another computer is what PRIVACY says it is: off unless the owner turned it on with
 * NEUROCLAW_CHOOSER=1 (`allowRemote`). Auto being switched on in the page does not change that, so Auto picks
 * effort and processor on its own but never borrows a computer the owner has not allowed it to.
 */
export async function runAutoRoute(
  prompt: string,
  history: string[],
  request: AutoRouteRequest,
  context: AutoRouteContext = {},
  deps: RouterDeps = defaultDeps(),
  allowRemote: boolean = chooserEnabled(),
): Promise<AutoRoute> {
  const notes: string[] = [];
  let device: DeviceProfile;
  try {
    device = await deps.probe();
  } catch (e) {
    notes.push(`could not read this device (${note(e)}); answering locally`);
    device = UNKNOWN_DEVICE;
  }
  const remote = device === UNKNOWN_DEVICE || !allowRemote ? { available: false, peerId: null } : deps.remote();
  const bytes = deps.modelBytes();
  const plan = planRoute({
    prompt, history, device, remote: { available: remote.available && !!remote.peerId },
    fullModelBytes: bytes.full, quantizedModelBytes: bytes.quantized, request,
    islands: context.islands, regionScore: context.regionScore,
  }, deps.chooser);
  const used = plan.prompt.changed ? plan.prompt.text : prompt;
  if (!allowRemote) plan.reasons.push("another computer is not used: borrowing is off (NEUROCLAW_CHOOSER=1 turns it on)");

  const learn = (engine: Engine, ok: boolean, ms: number): void => {
    try {
      deps.chooser.learn(engine, plan.choice.features, rewardFor({ ok, ms }));
      deps.save(deps.chooser);
    } catch { /* learning is a bonus; never let it break an answer */ }
  };

  if (plan.engine === "remote" && remote.peerId) {
    const t0 = deps.now();
    try {
      const r = await deps.borrow(remote.peerId, used);
      learn("remote", true, deps.now() - t0);
      notes.push("answered by a remote computer");
      return { plan, prompt: used, answer: r.result, notes, finish: () => undefined };
    } catch (e) {
      learn("remote", false, deps.now() - t0);
      notes.push(`the remote computer failed (${note(e)}); answering locally`);
      return { plan, prompt: used, answer: null, notes, finish: () => undefined };
    }
  }
  const engine = plan.engine;
  return { plan, prompt: used, answer: null, notes, finish: (ok, ms) => learn(engine, ok, ms) };
}

/** True when the owner switched auto routing on for the whole install, whatever a page sends. */
export function autoRouteForced(): boolean {
  return (process.env.NEUROCLAW_AUTO_ROUTE ?? "").trim() === "1";
}
