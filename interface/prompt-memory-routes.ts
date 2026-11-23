/**
 * HTTP routes for prompt memory (models && skills/core/prompt-memory.ts): small
 * stand-in archives that make the mesh say what a big archive makes it say.
 *
 * Behind the server's normal gate, like every /api route, and per person (the
 * store follows dataDir()). Every write reads a JSON body (parseBody insists on
 * a JSON content type, which is the server's guard against another tab posting
 * here).
 *
 *   GET    /api/prompt-memory                    every stand-in, without its text  (?stale=1 also asks the mesh)
 *   GET    /api/prompt-memory/standin?id=        one stand-in, with its files
 *   POST   /api/prompt-memory/use                {id, extra?}  the files to send to /api/zip-loop/run
 *   POST   /api/prompt-memory/record             {files, binary?, name?, threshold?, maxTrials?, maxMs?, probes?, keepOriginal?}
 *   POST   /api/prompt-memory/refresh            {id}  make it again from the kept original
 *   GET    /api/prompt-memory/job                what the search is doing now, or last did
 *   DELETE /api/prompt-memory?id=                forget one
 *
 * Finding a stand-in runs the archive through the real mesh again and again
 * (about a second per byte on the live mesh), so record and refresh answer 202
 * at once and the work goes on in the background. It holds the doorway while it
 * works, so chat waits its turn; one search at a time. The caps below keep one
 * request from asking for an unbounded amount of that.
 */

import type http from "node:http";
import {
  PromptMemory,
  PromptMemoryError,
  type PromptRunner,
  type RecordOutcome,
  type ShrinkOptions,
  type ShrinkProgress,
} from "../models && skills/core/prompt-memory.js";
import type { ZipTree } from "../models && skills/core/zip-halt.js";

export interface PromptMemoryContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
  /** Run `work` with the live mesh held and put back after each trial. Rejects with a PromptMemoryError when there is no mesh yet. */
  withRunner<T>(work: (runner: PromptRunner) => Promise<T>): Promise<T>;
  /** A name for the mesh as it is now, or null when there is none yet. */
  fingerprint(): Promise<string | null>;
}

/** An archive can be large; this is the most one request may carry. */
const BODY_LIMIT = 16 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_TRIALS = 500;
const MAX_MS = 2 * 60 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isPromptMemoryRoute = (pathname: string): boolean => pathname === "/api/prompt-memory" || pathname.startsWith("/api/prompt-memory/");

// ── One search at a time ──────────────────────────────────────────────────

interface Job {
  name: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  stage?: ShrinkProgress["stage"];
  runs: number;
  bestBytes?: number;
  outcome?: { ok: boolean; reason?: string; message?: string; id?: string; bigBytes?: number; standInBytes?: number; similarity?: number; exhausted?: boolean };
  error?: string;
}

/** The last job per person's folder, and whether the mesh is taken. */
const jobs = new Map<string, Job>();
let busy = false;

function summarise(outcome: RecordOutcome): NonNullable<Job["outcome"]> {
  if (outcome.ok === false) return { ok: false, reason: outcome.reason, message: outcome.message };
  const e = outcome.entry;
  return { ok: true, id: e.id, bigBytes: e.bigBytes, standInBytes: e.standInBytes, similarity: e.similarity, exhausted: e.exhausted };
}

/** Starts the search and returns at once. */
function startJob(ctx: PromptMemoryContext, store: PromptMemory, name: string, work: (runner: PromptRunner, onProgress: (p: ShrinkProgress) => void) => Promise<RecordOutcome>): Job {
  if (busy) throw new PromptMemoryError("A stand-in is already being made. Wait for it to finish (GET /api/prompt-memory/job).", 409);
  const job: Job = { name, state: "running", startedAt: Date.now(), runs: 0 };
  jobs.set(store.location, job);
  busy = true;
  const onProgress = (p: ShrinkProgress): void => {
    job.stage = p.stage;
    job.runs = p.runs;
    job.bestBytes = p.bestBytes;
  };
  void ctx
    .withRunner(runner => work(runner, onProgress))
    .then(outcome => {
      job.outcome = summarise(outcome);
      job.state = "done";
    })
    .catch((err: unknown) => {
      job.error = err instanceof Error ? err.message : String(err);
      job.state = "failed";
    })
    .finally(() => {
      job.finishedAt = Date.now();
      busy = false;
    });
  return job;
}

// ── Reading what was sent ─────────────────────────────────────────────────

function stringMap(raw: unknown, what: string): Record<string, string> {
  if (!isObj(raw)) throw new PromptMemoryError(`${what} must be an object of file name to text.`);
  const names = Object.keys(raw);
  if (names.length > MAX_FILES) throw new PromptMemoryError(`${what} has more than ${MAX_FILES} files.`);
  const out: Record<string, string> = {};
  for (const name of names) {
    if (typeof raw[name] !== "string") throw new PromptMemoryError(`${what}: ${name} must be text.`);
    out[name] = raw[name] as string;
  }
  return out;
}

function readTree(b: Record<string, unknown>): ZipTree {
  const files = stringMap(b.files, "files");
  const binary = b.binary === undefined ? {} : stringMap(b.binary, "binary");
  for (const k of Object.keys(binary)) if (k in files) throw new PromptMemoryError(`${k} is in both files and binary.`);
  return { files, ...(Object.keys(binary).length > 0 ? { binary } : {}) };
}

function number(v: unknown, what: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PromptMemoryError(`${what} must be a number from ${min} to ${max}.`);
  return v;
}

function readOptions(b: Record<string, unknown>): ShrinkOptions {
  const opts: ShrinkOptions = {};
  const threshold = number(b.threshold, "threshold", 0, 1);
  if (threshold !== undefined) opts.threshold = threshold;
  const maxTrials = number(b.maxTrials, "maxTrials", 0, MAX_TRIALS);
  if (maxTrials !== undefined) opts.maxTrials = Math.floor(maxTrials);
  const maxMs = number(b.maxMs, "maxMs", 1000, MAX_MS);
  if (maxMs !== undefined) opts.maxMs = maxMs;
  if (b.probes !== undefined) {
    if (!Array.isArray(b.probes)) throw new PromptMemoryError("probes must be a list of file sets.");
    opts.probes = b.probes.map(p => stringMap(p, "a probe"));
  }
  return opts;
}

// ── Routes ────────────────────────────────────────────────────────────────

/** Returns true when the route was handled. */
export async function handlePromptMemoryRoutes(ctx: PromptMemoryContext): Promise<boolean> {
  if (!isPromptMemoryRoute(ctx.pathname)) return false;
  try {
    return await route(ctx);
  } catch (err) {
    const status = err instanceof PromptMemoryError ? err.status : /Not logged in/.test(String((err as Error)?.message)) ? 401 : 500;
    ctx.sendJson(ctx.res, { error: err instanceof Error ? err.message : String(err) }, status);
    return true;
  }
}

async function route(ctx: PromptMemoryContext): Promise<boolean> {
  const { pathname, method, req, res, url } = ctx;
  const send = (data: unknown, status = 200): true => {
    ctx.sendJson(res, data, status);
    return true;
  };
  const body = async (): Promise<Record<string, unknown>> => {
    const b = await ctx.parseBody(req, BODY_LIMIT);
    if (!isObj(b)) throw new PromptMemoryError("Expected a JSON object.");
    return b;
  };
  const store = new PromptMemory();

  if (pathname === "/api/prompt-memory" && method === "GET") {
    const fingerprint = url.searchParams.get("stale") === "1" ? await ctx.fingerprint() : null;
    return send({ standIns: store.list(fingerprint ? { fingerprint: () => fingerprint } : undefined), busy });
  }

  if (pathname === "/api/prompt-memory/standin" && method === "GET") {
    const entry = store.get(url.searchParams.get("id") ?? "");
    if (!entry) throw new PromptMemoryError("No such stand-in.", 404);
    return send(entry);
  }

  if (pathname === "/api/prompt-memory/use" && method === "POST") {
    const b = await body();
    const fingerprint = await ctx.fingerprint();
    const used = store.use(String(b.id ?? ""), b.extra === undefined ? {} : stringMap(b.extra, "extra"), fingerprint ? { fingerprint: () => fingerprint } : undefined);
    // The same shape /api/zip-loop/run takes, so the answer can be posted straight back.
    return send({ id: used.id, files: used.tree.files, binary: used.tree.binary ?? {}, packedBytes: used.packedBytes, stale: used.stale });
  }

  if (pathname === "/api/prompt-memory/record" && method === "POST") {
    const b = await body();
    const tree = readTree(b);
    const opts = readOptions(b);
    const name = typeof b.name === "string" ? b.name : undefined;
    const keepOriginal = b.keepOriginal === true;
    const job = startJob(ctx, store, name ?? "unnamed", (runner, onProgress) => store.record(runner, tree, { ...opts, name, keepOriginal, onProgress }));
    return send({ started: true, job }, 202);
  }

  if (pathname === "/api/prompt-memory/refresh" && method === "POST") {
    const b = await body();
    const id = String(b.id ?? "");
    const entry = store.get(id);
    if (!entry) throw new PromptMemoryError("No such stand-in.", 404);
    const opts = readOptions(b);
    const job = startJob(ctx, store, entry.name, (runner, onProgress) => store.refresh(runner, entry.id, { ...opts, onProgress }));
    return send({ started: true, job }, 202);
  }

  if (pathname === "/api/prompt-memory/job" && method === "GET") {
    return send({ busy, job: jobs.get(store.location) ?? null });
  }

  if (pathname === "/api/prompt-memory" && method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!store.forget(id)) throw new PromptMemoryError("No such stand-in.", 404);
    return send({ forgotten: true });
  }

  return false;
}
