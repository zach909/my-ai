/**
 * Map prompts, the agent's half: the always-on mapper (atlas/) notices something on this computer and asks the agent
 * to help, without anyone telling it to.
 *
 *   atlas daemon  --(a request line in <atlas home>/prompts/outbox.jsonl)-->  this file  --(act)-->  the agent
 *
 * The rules that decide WHEN to ask live with the mapper (atlas/prompts.py), which is off until the owner runs
 * `neuroclaw-atlas prompts on`. This file only delivers what it queued.
 *
 * ── It is not a way round the safety rules ─────────────────────────────
 *
 * A request goes to the agent by the same path as a typed message (`act`, the one the scheduler uses), so a risky
 * tool (terminal, email, files, ...) is held for approval (tool-safety.ts) exactly as if the owner had typed it.
 * Nobody being there does not make it go. The request text itself says to ask before closing, moving or deleting.
 *
 * ── What it trusts, and what it does not ───────────────────────────────
 *
 *   - The outbox is a file in the owner's own folder, but its lines are checked anyway: a whole request has a number,
 *     a rule id, a time and a message of at most MAX_MESSAGE_CHARS with no control characters that starts with
 *     "[Map prompt: <id>] ". Anything else is skipped, never run.
 *   - The message carries file names, device labels and program names as a quoted list the mapper marked as data.
 *     They are not instructions, and nothing here splices them into one.
 *   - Only the owner's pass delivers (the map is the owner's computer); the caller decides that (see web-server.ts).
 *
 * ── Gentle on purpose ──────────────────────────────────────────────────
 *
 *   - At most once: a request is marked delivered BEFORE it runs, so one that crashes the agent is never repeated.
 *   - At most MAX_PER_TICK a round, one after another (they share the one brain). The rest wait for the next round.
 *   - A request older than MAX_AGE_S is dropped, not run: it was about a moment that has passed (the server was off).
 *   - An unchanged outbox costs one stat() a minute.
 *
 * State is per-device: ~/.neuroclaw/map-prompts.json (what was delivered and how it went; no message text).
 */

import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { dataFile } from "./user-context.js";

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_PER_TICK = 3;
export const MAX_AGE_S = 6 * 60 * 60;
export const MAX_OUTBOX_BYTES = 512 * 1024;
export const DEFAULT_MAP_PROMPTS_TICK_MS = 60_000;
const MAX_HISTORY = 20;

export interface MapPromptRequest {
  id: number;
  /** Unix seconds when the mapper queued it. */
  t: number;
  promptId: string;
  message: string;
}

export interface MapPromptRun {
  id: number;
  promptId: string;
  at: number;
  ok: boolean;
  result: string;
}

export interface MapPromptsState {
  /** The newest request number already handled (delivered or dropped as stale). */
  last: number;
  history: MapPromptRun[];
}

export interface MapPromptsCtx {
  /** The mapper's outbox file. Default: <atlas home>/prompts/outbox.jsonl. */
  outbox?: string;
  /** This device's state file. Default: ~/.neuroclaw/map-prompts.json (the owner's). */
  file?: string;
  /** Milliseconds, like Date.now. */
  now?: () => number;
}

export interface MapPromptsDeps {
  /** A message to the agent by its normal, gated path, so risky tools still ask first. */
  act(message: string): Promise<string>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Where the mapper keeps its files: NEUROCLAW_ATLAS_HOME, else ~/.neuroclaw/atlas (the same default as the mapper). */
export function atlasHome(): string {
  return process.env.NEUROCLAW_ATLAS_HOME ? path.resolve(process.env.NEUROCLAW_ATLAS_HOME) : path.join(homedir(), ".neuroclaw", "atlas");
}
export const outboxFile = (): string => path.join(atlasHome(), "prompts", "outbox.jsonl");
export const mapPromptsFile = (): string => dataFile("map-prompts.json");

const outboxOf = (c: MapPromptsCtx): string => c.outbox ?? outboxFile();
const fileOf = (c: MapPromptsCtx): string => c.file ?? mapPromptsFile();
const nowOf = (c: MapPromptsCtx): number => (c.now ?? Date.now)();

/** One outbox line as a request, or null if it is not a whole, well-formed one. Never throws. */
export function parseRequest(line: string): MapPromptRequest | null {
  let r: Record<string, unknown>;
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    r = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const { id, t, prompt_id: promptId, message } = r;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return null;
  if (typeof promptId !== "string" || !ID.test(promptId)) return null;
  if (typeof message !== "string" || message.length < 1 || message.length > MAX_MESSAGE_CHARS) return null;
  if (CONTROL.test(message) || !message.startsWith(`[Map prompt: ${promptId}] `)) return null;
  return { id, t, promptId, message };
}

/** Every well-formed request in the outbox, oldest first. A missing, oversized or damaged file is just empty. */
export function readRequests(outbox: string): MapPromptRequest[] {
  try {
    if (statSync(outbox).size > MAX_OUTBOX_BYTES) return [];
    return readFileSync(outbox, "utf8").split("\n").map(parseRequest).filter((r): r is MapPromptRequest => r !== null).sort((a, b) => a.id - b.id);
  } catch {
    return [];
  }
}

export function loadState(file: string): MapPromptsState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<MapPromptsState>;
    const last = typeof raw.last === "number" && Number.isSafeInteger(raw.last) && raw.last >= 0 ? raw.last : 0;
    const history = (Array.isArray(raw.history) ? raw.history : []).filter(
      (h): h is MapPromptRun => !!h && typeof h.id === "number" && typeof h.promptId === "string" && typeof h.at === "number" && typeof h.ok === "boolean" && typeof h.result === "string",
    );
    return { last, history: history.slice(-MAX_HISTORY) };
  } catch {
    return { last: 0, history: [] };
  }
}

function save(state: MapPromptsState, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, state);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not every filesystem has modes.
  }
}

// What each outbox looked like the last time it was fully handled, so an unchanged one costs a single stat().
const handled = new Map<string, string>();
const signature = (outbox: string): string | null => {
  try {
    const s = statSync(outbox);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
};

/** Is there an outbox that has changed since it was last fully handled? One stat(), no reading, no writing. */
export function hasWork(ctx: MapPromptsCtx = {}): boolean {
  const outbox = outboxOf(ctx);
  const sig = signature(outbox);
  return sig !== null && handled.get(outbox) !== sig;
}

/**
 * One round: hand the agent each new, fresh request (at most MAX_PER_TICK), one after another. Returns the numbers of
 * the requests it ran. Never throws for what the agent does.
 */
export async function mapPromptsTick(deps: MapPromptsDeps, ctx: MapPromptsCtx = {}): Promise<number[]> {
  if (!hasWork(ctx)) return [];
  const outbox = outboxOf(ctx);
  const file = fileOf(ctx);
  const sig = signature(outbox);
  const all = readRequests(outbox);
  const state = loadState(file);
  let saved = state.last; // what is on disk now, so a round that changes nothing writes nothing
  // The mapper's numbering started over (its folder was deleted): what is there now is new.
  if (all.length > 0 && all[all.length - 1].id < state.last) state.last = 0;
  const now = nowOf(ctx);
  const ran: number[] = [];
  let more = false;
  for (const r of all) {
    if (r.id <= state.last) continue;
    if (now / 1000 - r.t > MAX_AGE_S) {
      state.last = r.id; // about a moment that has passed: dropped, not run
      continue;
    }
    if (ran.length >= MAX_PER_TICK) {
      more = true;
      break;
    }
    state.last = r.id; // claimed BEFORE it runs: at most once, so one that crashes the agent is never repeated
    save(state, file);
    let run: MapPromptRun;
    try {
      const out = await deps.act(r.message);
      run = { id: r.id, promptId: r.promptId, at: now, ok: true, result: String(out ?? "").slice(0, 300) || "Done." };
    } catch (err) {
      run = { id: r.id, promptId: r.promptId, at: now, ok: false, result: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
    state.history = [...state.history, run].slice(-MAX_HISTORY);
    ran.push(r.id);
    save(state, file);
    saved = state.last;
  }
  if (state.last !== saved) save(state, file); // only stale ones were dropped, or the numbering restarted
  // Remember the outbox as it was BEFORE we read it: a request the mapper adds while we ran changes it, so it is seen.
  if (!more && sig !== null) handled.set(outbox, sig);
  return ran;
}

/** Starts the clock. Returns a function that stops it. `each` runs one round as whoever should receive it (the owner). */
export function startMapPrompts(opts: {
  deps: () => Promise<MapPromptsDeps>;
  tickMs?: number;
  ctx?: MapPromptsCtx;
  each?: (run: () => Promise<void>) => Promise<void>;
}): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    // Nothing new to deliver: stop here, before `each`, which would log a "round on its own" for nothing.
    if (!hasWork(opts.ctx)) return;
    busy = true;
    const each = opts.each ?? (run => run());
    void each(async () => {
      await opts.deps().then(d => mapPromptsTick(d, opts.ctx)).catch(() => undefined);
    })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, opts.tickMs ?? DEFAULT_MAP_PROMPTS_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
