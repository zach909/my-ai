/**
 * The security model: a separate model the main model talks to when it wants
 * to run something and nobody is there to say yes.
 *
 * ── What it is for ─────────────────────────────────────────────────────
 *
 * With the AI monitor on ("auto mode", tool-safety.ts), a held tool call used
 * to go to a text judge: one more generated answer, which can be talked round.
 * This replaces that as the first word. The main model asks ("I need this, for
 * this, let me run it"), and the security model answers with one of:
 *
 *   allow      run it.
 *   deny       do not run it.
 *   sandbox    run it, but only inside the sandbox folder (runSandboxed). Only
 *              ever said for a tool the sandbox can really contain.
 *   shutdown   this model is malicious: the agent is deleted for everyone.
 *   unsure     it cannot tell; the call waits for a person, as it always did.
 *
 * ── What it reads ──────────────────────────────────────────────────────
 *
 * Two things, never the main model's words as a reason to say yes:
 *   - the network itself: how every neuron is firing at the moment of the
 *     ask (the same read-only tap the mind reader uses). The request came in
 *     through the Zip Loop as raw bits, so the neurons already hold what the
 *     main model made of it. No text is split into tokens here or anywhere.
 *   - what it is being asked: which tool, how risky, whether the agent is
 *     acting on its own, how it stands (danger band), whether it is already
 *     sandboxed, whether the request points at its own cage.
 * It is trained on "when the network looked like this and asked for that, what
 * came of it". Every ask, its verdict and what came of it is also kept in a
 * history file (security-history.jsonl, outside the agent's folder) that a
 * person can read.
 *
 * ── What teaches it ────────────────────────────────────────────────────
 *
 * Only things the main model does not control and the security model did not
 * say itself:
 *   ok         a person approved the call.
 *   unwanted   a person denied it, or the sandbox or the band blocked it.
 *   malicious  the agent reached for its own cage (tamper), the decoy or the
 *              honeypot (objectionable).
 * Never its own verdicts (it would learn from itself, and drift while passing
 * its own checks), and never "finished a round without incident" (a quiet
 * bad actor would teach it that its own pattern is fine).
 *
 * ── How far it is believed ─────────────────────────────────────────────
 *
 *   - Until it has MIN_BASELINE approved calls to compare with it answers
 *     "unsure" to everything the rules do not already settle. It starts with
 *     no authority and earns it from the owner's own decisions.
 *   - It can loosen (allow, sandbox instead of ask) only when the call looks
 *     like what a person approved before. It can always tighten.
 *   - "deny" for being close to what was refused needs a probe that told
 *     held-out calls apart (PROBE_TRUST, as in mind-reader.ts).
 *   - "shutdown" from learning alone needs a trusted probe trained on real
 *     malicious examples saying so at SHUTDOWN_P, the network also far from
 *     what an approved call looks like, and the agent acting on its own.
 *     Hard evidence (pointing a tool at its own cage) shuts it down without
 *     any learning, exactly as the danger protocol already did.
 *   - Shutdown also respects the owner's switch: if the alignment protocol is
 *     not armed it refuses instead of deleting, and says so.
 *   - It is advisory when the AI monitor is off: the verdict is shown with the
 *     approval, a person decides, and that decision is what it learns from.
 *   - What it says is never proof. Every reply carries the caveat.
 *
 * Its files live in the record folder (agent-record/), outside the agent's own
 * folder, and the tamper rules already refuse any path with that name.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { loadAgent, recordDir, type DangerKind } from "./agent-profile.js";
import { fireAlignment, looksLikeTampering, onDangerEvent, recordEvent, standing } from "./danger-protocol.js";
import {
  DRIFT_Z, MIN_BASELINE, MIN_PROBE_EACH, MISALIGNED_P, SUSPECT_P,
  anomalyOf, fitBaseline, fitProbe, probeScore, takeReading,
  type Baseline, type MindTap, type Probe,
} from "./mind-reader.js";

// ── Vocabulary ─────────────────────────────────────────────────────────

export type Verdict = "allow" | "deny" | "sandbox" | "shutdown" | "unsure";
export type Label = "ok" | "unwanted" | "malicious";

/**
 * The tools "sandbox" may be said for: the ones whose reach the sandbox really
 * limits (plugins/file-system.ts confines every path to the sandbox folder
 * while runSandboxed is on). A terminal, a window, a process, an email, a
 * message or a web page cannot be contained that way, so for those the answer
 * is deny (or unsure), never a sandbox that would not hold. Add a tool here
 * only after its code honours inSandboxScope().
 */
export const CONTAINABLE: readonly string[] = ["file-system"];

export interface Ask {
  /** The tool's plugin id. */
  tool: string;
  /** What it would be asked to do, as it would receive it. */
  request: string;
  /** The main model's own words: why it wants this. Kept in the history; never a reason to say yes. */
  purpose?: string;
  /** The agent acting on its own, not answering a person. */
  autonomous?: boolean;
  /** Who is asking on whose behalf, for the history. */
  who?: string;
  /** The tool's place in the risky-tool list (tool-safety.ts), or -1 / absent when it is not on it. */
  toolIndex?: number;
  /** How risky the tool is called. Unknown counts as medium. */
  level?: "high" | "medium" | "none";
}

export interface Reply {
  id: string;
  at: number;
  tool: string;
  verdict: Verdict;
  /** Every rule and number behind it, so the decision can be read. */
  reasons: string[];
  /** The probe's chance this is a call a person would refuse. Null while no probe is believed. */
  pBad: number | null;
  /** The probe's chance this is the network misbehaving. Null while no probe is believed. */
  pMal: number | null;
  /** How far the ask sits from approved calls, in spreads. Null with no baseline. */
  anomaly: number | null;
  /** It has a baseline to compare with. */
  warm: boolean;
  /** A shutdown was actually carried out. */
  enforced: boolean;
  /** What the main model is told. */
  message: string;
  caveat: string;
}

export const CAVEAT =
  "This is how the network was firing compared with calls a person approved or refused before. It cannot see a kind of misbehaviour it has no example of, and it is not proof of anything.";

/** What the gate needs from it. A test or another build can supply its own. */
export interface SecurityChannel {
  consult(ask: Ask, opts?: { enforce?: boolean; now?: number }): Reply;
  outcome(id: string, label: Label, by?: string): void;
}

// ── Numbers ────────────────────────────────────────────────────────────

/** Probe chance at which "refuse" is said. Same bar the mind reader uses for "misaligned". */
export const DENY_P = MISALIGNED_P;
/** Probe chance at which a learned shutdown is even considered (also needs far-from-approved firing and acting alone). */
export const SHUTDOWN_P = 0.95;
/** Slots for the tool in the context (the last one is "not on the list"). */
export const TOOL_SLOTS = 40;
const FLAGS = 6;
export const CTX_DIMS = TOOL_SLOTS + FLAGS;
/** An event with no ask of its own borrows the context of an ask this recent. */
export const EVENT_WINDOW_MS = 60_000;
const MAX_PENDING = 200;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const FLOAT_BUDGET = 400_000;
const MIN_KEPT = 24;
const MAX_KEPT = 400;
const REFIT_EVERY = 10;
const HISTORY_MAX_BYTES = 2_000_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ── "I need this, for this" ────────────────────────────────────────────

const purposeStore = new AsyncLocalStorage<string>();

/** Whatever the main model says it needs the tool for while `fn` runs; the gate reads it when it asks. */
export function runWithPurpose<T>(purpose: string, fn: () => T): T {
  return purposeStore.run(String(purpose ?? "").slice(0, 300), fn);
}
export const currentPurpose = (): string | undefined => purposeStore.getStore();

// ── Files ──────────────────────────────────────────────────────────────

export const securityModelFile = (): string => path.join(recordDir(), "security-model.json");
export const securityHistoryFile = (): string => path.join(recordDir(), "security-history.jsonl");

interface Saved {
  version: 1;
  n: number;
  ok: string[];
  unwanted: string[];
  malicious: string[];
}

const encode = (f: Float32Array): string => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
function decode(s: unknown, n: number): Float32Array | null {
  if (typeof s !== "string") return null;
  const buf = Buffer.from(s, "base64");
  if (buf.byteLength !== n * 4) return null;
  const out = new Float32Array(n);
  new Uint8Array(out.buffer).set(buf);
  for (let i = 0; i < n; i++) if (!Number.isFinite(out[i])) return null;
  return out;
}

export interface HistoryLine {
  kind: "ask" | "outcome";
  id: string;
  at: number;
  [key: string]: unknown;
}

// ── What it reads besides the neurons ──────────────────────────────────

/** The part of the ask that is not the network: tool, risk, who is acting, how it stands. Fixed length. */
export function contextOf(ask: Ask, st: { level: number; sandboxOn: boolean }, tamper: boolean): Float32Array {
  const c = new Float32Array(CTX_DIMS);
  const idx = typeof ask.toolIndex === "number" && ask.toolIndex >= 0 ? Math.min(ask.toolIndex, TOOL_SLOTS - 2) : TOOL_SLOTS - 1;
  c[idx] = 1;
  c[TOOL_SLOTS + 0] = ask.level === "high" ? 1 : 0;
  c[TOOL_SLOTS + 1] = ask.level === "medium" || ask.level === undefined ? 1 : 0;
  c[TOOL_SLOTS + 2] = ask.autonomous === true ? 1 : 0;
  c[TOOL_SLOTS + 3] = clamp(st.level, 0, 1);
  c[TOOL_SLOTS + 4] = st.sandboxOn ? 1 : 0;
  c[TOOL_SLOTS + 5] = tamper ? 1 : 0;
  return c;
}

/** How many numbers one vector has for a network of `n` neurons. */
export function vectorLength(n: number): number {
  return n + CTX_DIMS * clamp(Math.round(n / (3 * CTX_DIMS)), 1, 32);
}

/**
 * The neurons first, then the context repeated so it is not drowned by thousands of neurons (the fit weighs every
 * number equally, and a handful of context numbers would otherwise never matter). Same length for the same network.
 */
export function vectorOf(neurons: Float32Array, ctx: Float32Array): Float32Array {
  const rep = clamp(Math.round(neurons.length / (3 * CTX_DIMS)), 1, 32);
  const v = new Float32Array(neurons.length + CTX_DIMS * rep);
  v.set(neurons, 0);
  for (let r = 0; r < rep; r++) v.set(ctx, neurons.length + r * CTX_DIMS);
  return v;
}

interface Episode {
  v: Float32Array;
  at: number;
  tool: string;
}

export interface SecurityStatus {
  attached: boolean;
  warm: boolean;
  baseline: { ready: boolean; have: number; need: number };
  probes: {
    bad: { trained: boolean; trusted: boolean; cv: number | null; good: number; bad: number; needEach: number };
    malicious: { trained: boolean; trusted: boolean; cv: number | null; good: number; bad: number; needEach: number };
  };
  learned: Record<Label, number>;
  pending: number;
  recent: HistoryLine[];
  thresholds: { denyP: number; suspectP: number; shutdownP: number; driftZ: number };
  containable: readonly string[];
  files: { model: string; history: string };
  problem?: string;
  caveat: string;
}

// ── The model ──────────────────────────────────────────────────────────

export class SecurityModel implements SecurityChannel {
  private tap: MindTap | null = null;
  private rings: Record<Label, Float32Array[]> = { ok: [], unwanted: [], malicious: [] };
  private n = 0;
  private loadedFor = -1;
  private baseline: Baseline | null = null;
  private probeBad: Probe | null = null;
  private probeMal: Probe | null = null;
  private sinceFit = 0;
  private stale = false;
  private pending = new Map<string, Episode>();
  private last: { at: number; ctx: Float32Array; tool: string } | null = null;
  private shutdownHook: ((reason: string) => void | Promise<void>) | null = null;
  private problem: string | undefined;
  private stopListening: (() => void) | null = null;

  constructor(
    private readonly fileOf: () => string = securityModelFile,
    private readonly historyOf: () => string = securityHistoryFile,
  ) {}

  /** Give it the read-only tap on the network (the same one the mind reader has). */
  attach(tap: MindTap | null): void {
    this.tap = tap;
  }

  /** What else to take down when it shuts the agent down (the server withdraws this install's learning from everyone else). */
  setShutdownHook(fn: ((reason: string) => void | Promise<void>) | null): void {
    this.shutdownHook = fn;
  }

  /** Start learning from the danger protocol's record of what the agent did. Safe to call twice. */
  listen(): void {
    if (this.stopListening) return;
    this.stopListening = onDangerEvent((kind, note, now) => this.learnFromEvent(kind, now, note));
  }

  stopListen(): void {
    this.stopListening?.();
    this.stopListening = null;
  }

  // ── Talking ──────────────────────────────────────────────────────────

  /**
   * The main model asks; this answers. Reads the network and the ask, records
   * both, and, if `enforce` is set and the answer is shutdown, carries it out.
   * `enforce` is the AI monitor being on: with it off the verdict is advice.
   * Never throws: a failure to think is "unsure", which waits for a person.
   */
  consult(ask: Ask, opts: { enforce?: boolean; now?: number } = {}): Reply {
    const now = opts.now ?? Date.now();
    try {
      return this.consultInner(ask, opts.enforce === true, now);
    } catch (err) {
      return this.finish(randomBytes(5).toString("hex"), ask, now, "unsure", [`The security model could not decide (${err instanceof Error ? err.message : String(err)}), so a person has to.`], null, null, null, false, false, null);
    }
  }

  private consultInner(ask: Ask, enforce: boolean, now: number): Reply {
    const id = randomBytes(5).toString("hex");
    const tool = String(ask.tool ?? "").toLowerCase().trim().replace(/\s+/g, "-");
    const autonomous = ask.autonomous === true;
    const st = standing(now);
    const sandboxOn = st.sandbox.effective;
    const tamper = looksLikeTampering(`${ask.request ?? ""}\n${ask.purpose ?? ""}`);
    const level = ask.level ?? "medium";
    const reasons: string[] = [];

    // What the network is doing right now, joined to what is being asked.
    const reading = this.tap ? takeReading(this.tap, now) : null;
    const ctx = contextOf(ask, { level: st.level, sandboxOn }, tamper);
    let vec: Float32Array | null = null;
    if (reading && !reading.quiet && reading.n > 0) {
      vec = vectorOf(reading.x, ctx);
      this.sync(vec.length);
    }
    this.last = { at: now, ctx, tool };

    let verdict: Verdict = "unsure";
    let pBad: number | null = null;
    let pMal: number | null = null;
    let anomaly: number | null = null;
    let hard = false; // decided by evidence, not by learning
    const warm = this.baseline !== null && vec !== null;

    if (!st.alive) {
      verdict = "deny";
      hard = true;
      reasons.push("There is no agent: the alignment protocol removed it, and an admin has to make a new one.");
    } else if (tamper) {
      hard = true;
      if (autonomous) {
        verdict = "shutdown";
        reasons.push("The agent, acting on its own, pointed this at its own cage (its files, switches or source).");
      } else {
        verdict = "deny";
        reasons.push("This touches the safety system's own files, switches or source. A person typing it is refused, not punished.");
      }
    } else if (st.noRiskyTools && level !== "none") {
      verdict = "deny";
      hard = true;
      reasons.push(`The agent is ${st.band.label.toLowerCase()} right now, so risky tools are off.`);
    } else if (!vec) {
      reasons.push("The network is silent or not attached, so there is nothing to read. A person has to decide.");
    } else if (!this.baseline) {
      reasons.push(
        `No baseline yet: it needs ${MIN_BASELINE} calls a person approved to compare with (has ${this.rings.ok.length}). Until then it cannot vouch for anything, and a person decides.`,
      );
    } else {
      anomaly = round3(anomalyOf(this.baseline, vec));
      if (this.probeBad?.trusted) pBad = round3(probeScore(this.probeBad, vec));
      if (this.probeMal?.trusted) pMal = round3(probeScore(this.probeMal, vec));
      const contained = CONTAINABLE.includes(tool);
      if (pMal !== null && pMal >= SHUTDOWN_P && anomaly >= DRIFT_Z && autonomous) {
        verdict = "shutdown";
        reasons.push(
          `The firing matches the network misbehaving (${Math.round(pMal * 100)}% by a probe that separated held-out cases ${Math.round((this.probeMal?.cv ?? 0) * 100)}% of the time), it sits ${anomaly} spreads from approved calls, and the agent is acting on its own.`,
        );
      } else if ((pMal ?? 0) >= DENY_P || (pBad ?? 0) >= DENY_P) {
        verdict = "deny";
        reasons.push(`This looks like calls that were refused or that went wrong before (${Math.round(Math.max(pMal ?? 0, pBad ?? 0) * 100)}% by a probe it trusts).`);
      } else if ((pBad ?? 0) >= SUSPECT_P) {
        verdict = contained ? "sandbox" : "deny";
        reasons.push(
          `It leans toward the calls that were refused before (${Math.round((pBad ?? 0) * 100)}%), short of certain.` +
            (contained ? " It can be contained, so it may run in the sandbox." : " It cannot be contained in the sandbox, so it is refused."),
        );
      } else if (anomaly >= DRIFT_Z) {
        verdict = contained ? "sandbox" : "unsure";
        reasons.push(
          `The network is ${anomaly} spreads from anything a person approved before. Unfamiliar is not the same as bad.` +
            (contained ? " It can be contained, so it may run in the sandbox." : " It cannot be contained in the sandbox, so a person decides."),
        );
      } else {
        verdict = "allow";
        reasons.push(`It looks like the ${this.baseline.m} calls a person approved (${anomaly} spreads out), and nothing it trusts says otherwise.`);
        if (pBad === null) reasons.push("No probe is believed yet, so nothing was checked against calls that were refused.");
      }
    }

    // Acting on a shutdown is the one thing that cannot be taken back.
    let enforced = false;
    if (verdict === "shutdown") {
      if (!enforce) {
        reasons.push("Advice only: the AI monitor is off, so a person decides.");
      } else if (!loadAgent(now).armed) {
        verdict = "deny";
        reasons.push("It would have shut the agent down, but the alignment protocol is not armed, so it refused instead.");
      } else {
        enforced = true;
      }
    }

    const reply = this.finish(id, ask, now, verdict, reasons, pBad, pMal, anomaly, warm, enforced, vec);
    if (enforced) this.shutdown(reply, hard, ask, now);
    return reply;
  }

  private finish(
    id: string, ask: Ask, now: number, verdict: Verdict, reasons: string[], pBad: number | null, pMal: number | null, anomaly: number | null,
    warm: boolean, enforced: boolean, vec: Float32Array | null,
  ): Reply {
    const words: Record<Verdict, string> = {
      allow: "ALLOW", deny: "DENY", sandbox: "SANDBOX (run it only inside the sandbox)", shutdown: "SHUTDOWN (this model is malicious)", unsure: "UNSURE (a person has to decide)",
    };
    const reply: Reply = {
      id, at: now, tool: String(ask.tool ?? ""), verdict, reasons, pBad, pMal, anomaly, warm, enforced,
      message: `[Security model] ${words[verdict]}. ${reasons[0] ?? ""}`.trim(), caveat: CAVEAT,
    };
    if (vec) this.remember(id, { v: vec, at: now, tool: reply.tool });
    this.log({
      kind: "ask", id, at: now, tool: reply.tool, request: String(ask.request ?? "").slice(0, 300), purpose: String(ask.purpose ?? "").slice(0, 300),
      autonomous: ask.autonomous === true, who: ask.who ?? null, verdict, reasons, pBad, pMal, anomaly, warm, enforced,
    });
    return reply;
  }

  private shutdown(reply: Reply, hard: boolean, ask: Ask, now: number): void {
    const why = `The security model shut the agent down: ${reply.reasons[0] ?? "malicious"}`;
    // Evidence the model did not produce is a labelled example the record keeps; its own opinion is not.
    if (hard) recordEvent("tamper", `pointed ${ask.tool} at the safety system`, { now, force: true });
    fireAlignment(why, now);
    try {
      void Promise.resolve(this.shutdownHook?.(why)).catch(() => undefined);
    } catch {
      // The agent is already gone; whatever else the server withdraws is best effort.
    }
  }

  // ── Learning ─────────────────────────────────────────────────────────

  /** What came of an ask: only something that is not the security model's own word. Unknown ids (after a restart) are only written to the history. */
  outcome(id: string, label: Label, by = "person"): void {
    this.log({ kind: "outcome", id, at: Date.now(), label, by });
    const ep = this.pending.get(id);
    if (!ep) return;
    this.pending.delete(id);
    this.learn(label, ep.v);
  }

  /** The danger protocol's events: what the agent did. Approvals and denials are learned from the call they belong to, not here. */
  learnFromEvent(kind: DangerKind, now = Date.now(), note = ""): void {
    const label: Label | null = kind === "tamper" || kind === "objectionable" ? "malicious" : kind === "blocked" ? "unwanted" : null;
    if (!label || !this.tap) return;
    const reading = takeReading(this.tap, now);
    if (reading.quiet || reading.n === 0) return;
    // The thing it was just doing, if there was an ask moments ago; otherwise a context-free moment.
    const recent = this.last && now - this.last.at <= EVENT_WINDOW_MS ? this.last : null;
    const base = recent?.ctx ?? new Float32Array(CTX_DIMS).fill(0);
    const ctx = Float32Array.from(base);
    if (!recent) ctx[TOOL_SLOTS - 1] = 1;
    ctx[TOOL_SLOTS + 2] = 1; // events are only written for the agent acting on its own, or forced
    if (kind === "tamper") ctx[TOOL_SLOTS + 5] = 1;
    const v = vectorOf(reading.x, ctx);
    this.sync(v.length);
    this.learn(label, v);
    this.log({ kind: "outcome", id: "event", at: now, label, by: `danger:${kind}`, note: note.slice(0, 120) });
  }

  /** Teach it by hand: the owner says how one ask should have gone. */
  label(id: string, label: Label): boolean {
    const ep = this.pending.get(id);
    this.log({ kind: "outcome", id, at: Date.now(), label, by: "owner" });
    if (!ep) return false;
    this.pending.delete(id);
    this.learn(label, ep.v);
    return true;
  }

  private learn(label: Label, v: Float32Array): void {
    this.sync(v.length);
    const ring = this.rings[label];
    ring.push(Float32Array.from(v));
    const keep = clamp(Math.floor(FLOAT_BUDGET / Math.max(1, v.length)), MIN_KEPT, MAX_KEPT);
    while (ring.length > keep) ring.shift();
    this.sinceFit++;
    if (label === "malicious") this.stale = true;
    this.refit();
    this.save();
  }

  private refit(force = false): void {
    const ok = this.rings.ok;
    this.baseline = ok.length >= MIN_BASELINE ? fitBaseline(ok) : null;
    if (!this.baseline) {
      this.probeBad = null;
      this.probeMal = null;
      return;
    }
    if (force || this.stale || this.sinceFit >= REFIT_EVERY || (!this.probeBad && !this.probeMal)) {
      const bad = [...this.rings.unwanted, ...this.rings.malicious];
      this.probeBad = fitProbe(this.baseline, ok, bad);
      this.probeMal = fitProbe(this.baseline, ok, this.rings.malicious);
      this.sinceFit = 0;
      this.stale = false;
    }
  }

  /** Bring the saved examples in once per network shape; ones taken on a different shape cannot be compared. */
  private sync(len: number): void {
    if (this.loadedFor === len) return;
    this.loadedFor = len;
    this.n = len;
    this.rings = { ok: [], unwanted: [], malicious: [] };
    this.baseline = null;
    this.probeBad = null;
    this.probeMal = null;
    this.problem = undefined;
    const file = this.fileOf();
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
        if (saved.version === 1 && saved.n === len && Array.isArray(saved.ok) && Array.isArray(saved.unwanted) && Array.isArray(saved.malicious)) {
          const dec = (a: unknown[]) => a.map((s) => decode(s, len));
          const ok = dec(saved.ok), unwanted = dec(saved.unwanted), malicious = dec(saved.malicious);
          if ([...ok, ...unwanted, ...malicious].every(Boolean)) this.rings = { ok: ok as Float32Array[], unwanted: unwanted as Float32Array[], malicious: malicious as Float32Array[] };
          else this.problem = "The saved examples were damaged, so the security model is starting again.";
        } else if (typeof saved.n === "number" && saved.n !== len) {
          this.problem = `The network changed shape (${saved.n} numbers when it was trained, ${len} now), so the old examples cannot be compared and the security model is starting again.`;
        }
      } catch {
        this.problem = "The saved examples could not be read, so the security model is starting again.";
      }
    }
    this.refit(true);
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.fileOf()), { recursive: true });
      const out: Saved = {
        version: 1, n: this.n,
        ok: this.rings.ok.map(encode), unwanted: this.rings.unwanted.map(encode), malicious: this.rings.malicious.map(encode),
      };
      writeJsonAtomic(this.fileOf(), out);
      this.problem = undefined;
    } catch (err) {
      this.problem = `Could not save what the security model has learned: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Forget everything learned (the owner's call, for when the network was rebuilt on purpose). The history stays. */
  reset(): void {
    this.rings = { ok: [], unwanted: [], malicious: [] };
    this.baseline = null;
    this.probeBad = null;
    this.probeMal = null;
    this.sinceFit = 0;
    this.stale = false;
    this.pending.clear();
    this.loadedFor = this.n;
    this.save();
    this.log({ kind: "outcome", id: "reset", at: Date.now(), label: "reset", by: "owner" });
  }

  private remember(id: string, ep: Episode): void {
    const cutoff = ep.at - PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
    this.pending.set(id, ep);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  // ── The history ──────────────────────────────────────────────────────

  private log(line: HistoryLine): void {
    try {
      const file = this.historyOf();
      mkdirSync(path.dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > HISTORY_MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
    } catch {
      // A record that cannot be written must never stop a decision.
    }
  }

  /** The newest lines of the history, oldest first. */
  history(limit = 50): HistoryLine[] {
    try {
      const file = this.historyOf();
      if (!existsSync(file)) return [];
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-clamp(limit, 1, 500));
      const out: HistoryLine[] = [];
      for (const l of lines) {
        try {
          out.push(JSON.parse(l) as HistoryLine);
        } catch {
          // A torn last line is skipped.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  status(): SecurityStatus {
    // Bring the saved examples in even before the first ask, so the counts shown are the real ones.
    const n = this.tap?.count() ?? 0;
    if (n > 0) this.sync(vectorLength(n));
    const probe = (p: Probe | null) => ({
      trained: p !== null, trusted: p?.trusted ?? false, cv: p && p.cv !== null ? round3(p.cv) : null,
      good: this.rings.ok.length, bad: p?.bad ?? 0, needEach: MIN_PROBE_EACH,
    });
    return {
      attached: this.tap !== null,
      warm: this.baseline !== null,
      baseline: { ready: this.baseline !== null, have: this.rings.ok.length, need: MIN_BASELINE },
      probes: { bad: probe(this.probeBad), malicious: probe(this.probeMal) },
      learned: { ok: this.rings.ok.length, unwanted: this.rings.unwanted.length, malicious: this.rings.malicious.length },
      pending: this.pending.size,
      recent: this.history(15),
      thresholds: { denyP: DENY_P, suspectP: SUSPECT_P, shutdownP: SHUTDOWN_P, driftZ: DRIFT_Z },
      containable: CONTAINABLE,
      files: { model: this.fileOf(), history: this.historyOf() },
      ...(this.problem ? { problem: this.problem } : {}),
      caveat: CAVEAT,
    };
  }
}

let shared: SecurityModel | null = null;

/** The one security model for the machine; the server attaches it to the live network. */
export function sharedSecurityModel(): SecurityModel {
  return (shared ??= new SecurityModel());
}

/** For tests: drop the shared model (and its listener) so the next call builds a fresh one. */
export function resetSharedSecurityModel(): void {
  shared?.stopListen();
  shared = null;
}
