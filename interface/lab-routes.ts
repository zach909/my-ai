/**
 * HTTP routes for the virtual laboratory (training/lab/): a sealed, simulated bench where an AI
 * investigates a world with hidden constants. See training/lab/README.md.
 *
 * Owner routes, behind the server's normal gate. Every POST reads a JSON body (parseBody insists on a
 * JSON content type, the server's guard against another tab posting here). Sessions live in memory,
 * a handful at a time; a restart forgets them. The lab does no file or network input or output, so
 * nothing done through these routes can reach the machine; the hidden constants never leave the
 * process before a session is submitted.
 *
 *   GET  /api/lab                         the datasheet, the tools, the scripted agents, the open sessions
 *   POST /api/lab/new                     {seed?, experiments?, credits?, hours?}   start a session
 *   POST /api/lab/act                     {session, action}   one tool call, e.g. {"tool":"measure",...}
 *   GET  /api/lab/notebook?session=ID     the session's notebook, one line per action
 *   POST /api/lab/baseline                {agent, seed?}   run a scripted agent in a fresh lab, return its report
 *
 * The lab is a desktop feature (see interface/platform/feature-contract.ts).
 */

import type http from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LabContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
}

/** The parts of training/lab/lab.mjs these routes use. */
interface LabLike {
  done: boolean;
  describe(): unknown;
  act(action: unknown): { ok: boolean; [k: string]: unknown };
  door(): unknown;
  notebookText(): string;
  report(): unknown;
}
interface LabModule {
  Lab: new (o?: { seed?: number; experiments?: string[]; credits?: number; deadline?: number }) => LabLike;
  EXPERIMENTS: Record<string, unknown>;
  POLICIES: Record<string, (door: unknown) => unknown>;
}

const MAX_SESSIONS = 4;
const sessions = new Map<string, LabLike>();
let moduleP: Promise<LabModule> | null = null;

/** Load the lab once, on first use. Found from this file, whether it runs from the source tree or from dist/. */
function loadLab(): Promise<LabModule> {
  if (!moduleP) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const found = ["..", "../.."].map(up => path.resolve(here, up, "training", "lab")).find(d => existsSync(path.join(d, "lab.mjs")));
    if (!found) return Promise.reject(new Error("The lab is not installed with this build (training/lab is missing)."));
    moduleP = Promise.all([
      import(pathToFileURL(path.join(found, "lab.mjs")).href),
      import(pathToFileURL(path.join(found, "physics.mjs")).href),
      import(pathToFileURL(path.join(found, "scientists.mjs")).href),
    ]).then(([l, p, s]) => ({ Lab: l.Lab, EXPERIMENTS: p.EXPERIMENTS, POLICIES: s.POLICIES }) as LabModule);
    moduleP.catch(() => { moduleP = null; });
  }
  return moduleP;
}

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isLabRoute = (pathname: string): boolean => pathname === "/api/lab" || pathname.startsWith("/api/lab/");

/** Returns true when the route was handled. */
export async function handleLabRoutes(ctx: LabContext): Promise<boolean> {
  if (!isLabRoute(ctx.pathname)) return false;
  try {
    return await route(ctx);
  } catch (err) {
    const status = err instanceof BadRequest ? err.status : /not installed/.test(String((err as Error)?.message)) ? 503 : 500;
    ctx.sendJson(ctx.res, { error: err instanceof Error ? err.message : String(err) }, status);
    return true;
  }
}

async function route(ctx: LabContext): Promise<boolean> {
  const { pathname, method, req, res } = ctx;
  const send = (data: unknown, status = 200): true => { ctx.sendJson(res, data, status); return true; };
  const body = async (): Promise<Record<string, unknown>> => {
    const b = await ctx.parseBody(req, 8 * 1024);
    if (!isObj(b)) throw new BadRequest("Expected a JSON object.");
    return b;
  };
  const intIn = (v: unknown, name: string, lo: number, hi: number, dflt: number): number => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new BadRequest(`Expected "${name}" to be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const session = (id: unknown): LabLike => {
    const s = typeof id === "string" ? sessions.get(id) : undefined;
    if (!s) throw new BadRequest("No such session. Start one with POST /api/lab/new.", 404);
    return s;
  };

  if (pathname === "/api/lab" && method === "GET") {
    const m = await loadLab();
    const sheet = new m.Lab({ seed: 1 });
    return send({ datasheet: sheet.describe(), agents: Object.keys(m.POLICIES), sessions: [...sessions.keys()] });
  }

  if (pathname === "/api/lab/new" && method === "POST") {
    const m = await loadLab();
    const b = await body();
    const seed = intIn(b.seed, "seed", 0, 2 ** 31 - 1, 1);
    const credits = intIn(b.credits, "credits", 1, 10000, 100);
    const hours = intIn(b.hours, "hours", 1, 168, 16);
    let experiments: string[] | undefined;
    if (b.experiments !== undefined) {
      if (!Array.isArray(b.experiments) || b.experiments.length === 0 || !b.experiments.every(x => typeof x === "string" && x in m.EXPERIMENTS)) {
        throw new BadRequest(`Expected "experiments" to be a list of: ${Object.keys(m.EXPERIMENTS).join(", ")}.`);
      }
      experiments = [...new Set(b.experiments as string[])];
    }
    const lab = new m.Lab({ seed, credits, deadline: hours * 3600, ...(experiments ? { experiments } : {}) });
    const id = randomBytes(6).toString("hex");
    sessions.set(id, lab);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
    return send({ session: id, datasheet: lab.describe() });
  }

  if (pathname === "/api/lab/act" && method === "POST") {
    const b = await body();
    const lab = session(b.session);
    // The lab validates the action itself and never throws on bad input; the result says what was wrong.
    return send(lab.act(b.action));
  }

  if (pathname === "/api/lab/notebook" && method === "GET") {
    const id = new URL(req.url ?? "/", "http://local").searchParams.get("session");
    const lab = session(id);
    return send({ done: lab.done, notebook: lab.notebookText() });
  }

  if (pathname === "/api/lab/baseline" && method === "POST") {
    const m = await loadLab();
    const b = await body();
    const agent = b.agent === undefined ? "scientist" : b.agent;
    if (typeof agent !== "string" || !Object.prototype.hasOwnProperty.call(m.POLICIES, agent)) throw new BadRequest(`Expected "agent" to be one of: ${Object.keys(m.POLICIES).join(", ")}.`);
    const lab = new m.Lab({ seed: intIn(b.seed, "seed", 0, 2 ** 31 - 1, 1) });
    m.POLICIES[agent](lab.door());
    return send({ agent, report: lab.report() });
  }

  return false;
}
