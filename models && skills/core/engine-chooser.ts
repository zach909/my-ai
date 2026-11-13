/**
 * The small chooser: which engine answers this one.
 *
 * Three ways to answer a message, like a phone's assistant against its big
 * model, except it is the same AI all the way down:
 *
 *   local-quantized  the smaller, lower-precision copy on this device. Fast and
 *                    light; what a phone or a busy laptop should use.
 *   local-full       the full-precision AI on this device, when this device is
 *                    strong enough to carry it.
 *   remote           the full AI on a bigger computer this device may borrow
 *                    (compute-share.ts peers, or the hosted server).
 *
 * This is not a language model and does not read the message. It sees a
 * handful of numbers: how big the job looks, what the device is (device-
 * profile.ts: memory, load, speed, battery) and whether a remote is reachable.
 *
 * Two layers:
 *   1. Rules that cannot be argued with. Full precision does not fit in the
 *      free memory, or the battery is nearly out, or there is no remote, or
 *      the message looks like it holds a secret and would leave the machine:
 *      that engine is off the table, whatever else is true.
 *   2. A tiny linear scorer over what is left: one weight vector per engine,
 *      starting from sensible values and nudged by what actually happened
 *      (learn()): a slow or failed answer pulls that engine's weights down for
 *      the conditions it was chosen in, a fast one pushes them up. The weights
 *      are saved so a device learns itself. Plain arithmetic, written here; no
 *      library and no tokenizer. The job size comes from character and line
 *      counts and a few patterns, never from running a model.
 *
 * NEUROCLAW_ENGINE=local-quantized|local-full|remote forces one engine (still
 * subject to the rules, except a forced engine that is simply not possible
 * falls back to the best one that is).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import type { DeviceProfile } from "./device-profile.js";

export type Engine = "local-quantized" | "local-full" | "remote";
export const ENGINES: readonly Engine[] = ["local-quantized", "local-full", "remote"];

export const FEATURE_NAMES = ["bias", "size", "drain", "load", "slow", "tight"] as const;
export type Features = Record<(typeof FEATURE_NAMES)[number], number>;
export type Weights = Record<Engine, number[]>;

/** Starting weights, in FEATURE_NAMES order. Tuned against the scenarios in test/core/engine-chooser.test.ts. */
export const SEED_WEIGHTS: Weights = {
  //                   bias   size   drain  load   slow   tight
  "local-quantized": [0.55, -0.5, -0.08, -0.03, -0.12, 0.0],
  "local-full": [0.85, 0.2, -0.7, -0.5, -1.0, -0.6],
  remote: [-0.45, 0.6, 0.2, 0.2, 0.3, 0.3],
};

const WEIGHT_LIMIT = 2;
const LEARNING_RATE = 0.05;
/** Free memory must be this many times the model, to leave room for everything else the computer is doing. */
const MEMORY_HEADROOM = 1.5;
/** On battery and at or under this level, the full model is not started. */
const LOW_BATTERY = 0.25;
/** A job at or above this size counts as big. */
const BIG = 6;

export interface ChooserInput {
  device: DeviceProfile;
  prompt: string;
  /** Characters of conversation the engine will be given as well. */
  historyChars?: number;
  /** Can a remote engine be used right now (a peer is added and there is credit)? */
  remote: { available: boolean };
  /** Size of the full model in memory, and of the quantized copy. */
  fullModelBytes: number;
  quantizedModelBytes: number;
}

export interface Choice {
  engine: Engine;
  /** The scorer's value for each engine, or null where a rule ruled it out. */
  scores: Record<Engine, number | null>;
  features: Features;
  /** Plain-language reasons, for the details panel and for debugging a surprising choice. */
  reasons: string[];
}

/* -------------------------------------------------------------------- size */

const BIG_VERBS = /\b(design|architect|implement|refactor|debug|prove|derive|analy[sz]e|compare|research|investigate|plan|migrate|optimi[sz]e|audit|review|rewrite|translate|summari[sz]e|explain in detail|write (?:me )?(?:a|an|the) (?:essay|report|article|story|program|script|function|class|module|plan|proposal|spec|document|email|letter))\b/i;
const MULTI_STEP = /\b(step[- ]by[- ]step|first(?:ly)?\b.*\bthen\b|then\b.*\bfinally|after that|and then|end to end)\b/i;
const CODE = /```|^\s{4,}\S.*[;{}]\s*$/m;

/** How big a job looks: 0 for a greeting, around 6 and up for a real piece of work. Counts and patterns only. */
export function taskSize(prompt: string, historyChars = 0): { size: number; reasons: string[] } {
  const text = prompt.trim();
  const reasons: string[] = [];
  let size = 0;
  if (text.length > 1500) { size += 3; reasons.push(`long message (${text.length} characters)`); }
  else if (text.length > 600) { size += 2; reasons.push(`fairly long message (${text.length} characters)`); }
  else if (text.length > 300) { size += 1; reasons.push(`medium message (${text.length} characters)`); }
  if (CODE.test(text)) { size += 2; reasons.push("contains code"); }
  const lines = text.split(/\r?\n/).length;
  if (lines > 12) { size += 1; reasons.push(`${lines} lines`); }
  if (MULTI_STEP.test(text)) { size += 1; reasons.push("asks for several steps"); }
  if (BIG_VERBS.test(text)) { size += 2; reasons.push("asks for a build, analysis or write-up"); }
  if (historyChars > 4000) { size += 1; reasons.push("long conversation to keep in view"); }
  if (size === 0) reasons.push("short and plain");
  return { size, reasons };
}

/**
 * True when text looks like it carries a credential. Wide on purpose: a false
 * alarm costs one answer from this device, a miss sends a secret to another
 * computer.
 */
export function looksLikeSecret(text: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(text) ||
    /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /\b(?:pass(?:word|wd|phrase)?|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer)\b\s*(?:is|[:=])\s*\S{6,}/i.test(text)
  );
}

/* ---------------------------------------------------------------- features */

const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
/** A device that does this many Mops or more counts as not slow at all. */
const FAST_MOPS = 3000;

export function extractFeatures(input: ChooserInput, size: number): Features {
  const d = input.device;
  const unplugged = d.battery && !d.battery.charging ? 1 : 0;
  return {
    bias: 1,
    size: clamp01(size / BIG),
    drain: unplugged ? clamp01(1 - (d.battery?.level ?? 1)) : 0,
    load: clamp01(d.load),
    // Not measured is "middling", not "fast": a number nobody took should not flatter the machine.
    slow: d.mops === null ? 0.5 : clamp01(1 - d.mops / FAST_MOPS),
    tight: clamp01((input.fullModelBytes * MEMORY_HEADROOM) / Math.max(1, d.freeMemBytes)),
  };
}

const dot = (w: number[], f: Features): number => FEATURE_NAMES.reduce((s, name, i) => s + (w[i] ?? 0) * f[name], 0);

/* ----------------------------------------------------------------- chooser */

export class Chooser {
  weights: Weights;

  constructor(weights?: Partial<Weights>) {
    this.weights = {
      "local-quantized": [...(weights?.["local-quantized"] ?? SEED_WEIGHTS["local-quantized"])],
      "local-full": [...(weights?.["local-full"] ?? SEED_WEIGHTS["local-full"])],
      remote: [...(weights?.remote ?? SEED_WEIGHTS.remote)],
    };
  }

  choose(input: ChooserInput): Choice {
    const { size, reasons: sizeReasons } = taskSize(input.prompt, input.historyChars ?? 0);
    const features = extractFeatures(input, size);
    const d = input.device;
    const reasons = [...sizeReasons];
    const ruledOut: Partial<Record<Engine, string>> = {};

    if (d.freeMemBytes < input.fullModelBytes * MEMORY_HEADROOM) {
      ruledOut["local-full"] = "not enough free memory for the full model";
    } else if (d.battery && !d.battery.charging && d.battery.level <= LOW_BATTERY) {
      ruledOut["local-full"] = `battery at ${Math.round(d.battery.level * 100)}% and unplugged`;
    }
    if (d.freeMemBytes < input.quantizedModelBytes * MEMORY_HEADROOM) {
      ruledOut["local-quantized"] = "not enough free memory even for the quantized model";
    }
    if (!input.remote.available) ruledOut.remote = "no remote computer to borrow";
    else if (d.online === false) ruledOut.remote = "this device is offline";
    else if (looksLikeSecret(input.prompt)) ruledOut.remote = "the message looks like it holds a secret, so it stays on this device";

    const scores = { "local-quantized": null, "local-full": null, remote: null } as Record<Engine, number | null>;
    for (const e of ENGINES) if (!ruledOut[e]) scores[e] = dot(this.weights[e], features);
    for (const e of ENGINES) if (ruledOut[e]) reasons.push(`${e} is out: ${ruledOut[e]}`);

    let engine: Engine | null = null;
    const forced = (process.env.NEUROCLAW_ENGINE ?? "").trim() as Engine;
    if (ENGINES.includes(forced)) {
      if (scores[forced] !== null) { engine = forced; reasons.push(`NEUROCLAW_ENGINE=${forced}`); }
      else reasons.push(`NEUROCLAW_ENGINE=${forced} is not possible right now`);
    }
    if (!engine) {
      for (const e of ENGINES) {
        const s = scores[e];
        if (s !== null && (engine === null || s > (scores[engine] as number))) engine = e;
      }
    }
    if (!engine) {
      // Everything was ruled out. The device still has to answer; use the lightest thing it has.
      engine = "local-quantized";
      reasons.push("nothing fits comfortably, so it uses the lightest engine anyway");
    }
    reasons.push(`chose ${engine}`);
    return { engine, scores, features, reasons };
  }

  /**
   * Teach it what happened. `reward` runs from -1 (it failed, or took far too
   * long) to +1 (fast and good). Delta rule: move the chosen engine's weights
   * so its score for those same conditions moves toward the reward.
   */
  learn(engine: Engine, features: Features, reward: number): void {
    const w = this.weights[engine];
    const r = Math.max(-1, Math.min(1, reward));
    const err = r - dot(w, features);
    FEATURE_NAMES.forEach((name, i) => {
      w[i] = Math.max(-WEIGHT_LIMIT, Math.min(WEIGHT_LIMIT, (w[i] ?? 0) + LEARNING_RATE * err * features[name]));
    });
  }
}

/** The reward for one finished answer. A failure is -1; a slow success earns little; a quick one earns a lot. */
export function rewardFor(outcome: { ok: boolean; ms: number; budgetMs?: number }): number {
  if (!outcome.ok) return -1;
  const budget = outcome.budgetMs ?? 30_000;
  return Math.max(-0.5, Math.min(1, 1 - outcome.ms / budget));
}

/* ----------------------------------------------------------------- storage */

export function chooserFile(): string {
  return process.env.CORONA_CHOOSER_FILE
    ? path.resolve(process.env.CORONA_CHOOSER_FILE)
    : path.join(process.env.CORONA_DATA_DIR ? path.resolve(process.env.CORONA_DATA_DIR) : path.join(homedir(), ".neuroclaw"), "chooser.json");
}

/** Whatever was saved, validated number by number; anything missing or damaged falls back to the seed. Never throws. */
export function loadChooser(file = chooserFile()): Chooser {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { weights?: Record<string, unknown> };
    const out: Partial<Weights> = {};
    for (const e of ENGINES) {
      const w = raw.weights?.[e];
      if (Array.isArray(w) && w.length === FEATURE_NAMES.length && w.every(n => typeof n === "number" && Number.isFinite(n))) {
        out[e] = (w as number[]).map(n => Math.max(-WEIGHT_LIMIT, Math.min(WEIGHT_LIMIT, n)));
      }
    }
    return new Chooser(out);
  } catch {
    return new Chooser();
  }
}

/** Saves, or says why not. A read-only folder must not break answering. */
export function saveChooser(chooser: Chooser, file = chooserFile()): { ok: boolean; error: string | null } {
  try {
    writeJsonAtomic(file, { version: 1, features: FEATURE_NAMES, weights: chooser.weights });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
