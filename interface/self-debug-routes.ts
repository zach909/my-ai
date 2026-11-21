/**
 * Self-debug, wired in (the loop itself is models && skills/core/self-debug.ts).
 *
 * This file is the part that touches the world: it keeps what the loop learns
 * between restarts, gives it the Extension Builder to make skills with and the
 * Extension Manager to install plugin proposals into, runs it on a timer, and
 * answers the HTTP routes. It belongs to the Self-improvement page.
 *
 *   GET  /api/self-improvement/self-debug                   status: nets and how they score, last
 *                                                           run, plugins waiting for approval,
 *                                                           the weights the history trusts
 *   GET  /api/self-improvement/self-debug/sessions/:id      one run in full: the two voices and
 *                                                           every round
 *   POST /api/self-improvement/self-debug/run               {net, maxRounds?, patience?, edits?,
 *                                                           minCosine?, makeSkills?, makePlugins?,
 *                                                           useMistakes?, confirm?}
 *   POST /api/self-improvement/self-debug/auto              {enabled}   the background pass
 *   POST /api/self-improvement/self-debug/plugins/:id/approve | /deny
 *
 * Owner routes, behind the server's normal gate. A net that is part of the live
 * AI (a skill graft) is only touched when the owner says so with confirm:true;
 * the background pass never touches one.
 *
 * Where things go:
 *   state            <data folder>/self-debug/state.json    ledger + recent runs, bounded
 *   skills it makes  extension-builder/extensions/<name>.ext.json   the format the server already
 *                    loads at boot (gitignored: they can hold what someone typed)
 *   plugin proposals <data folder>/extensions/ through ExtensionManager, installed OFF
 */

import type http from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ExtensionBuilder } from "../extension-builder/builder.js";
import { ExtensionManager } from "../extension_system/manager.js";
import {
  SelfDebugger, WeightLedger, casesFromMistakes, casesFromNet, normalizeCases, scoreSuite, summarize,
  type DebugCase, type DebugOptions, type DebugSession, type PluginProposer, type SkillMaker, type SkillSpec,
} from "../models && skills/core/self-debug.js";
import type { Mistake } from "../models && skills/core/mistake-tracker.js";
import { madeNets } from "./weights-routes.js";
import { codeRoot, configFile, dataRoot } from "./platform/app-paths.js";
import { writeJsonAtomic } from "../models && skills/core/atomic-write.js";

export interface SelfDebugContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
  /** The live mistake tracker's mistakes, for runs that ask to use them. */
  mistakes?: () => Promise<Mistake[]>;
  /** Recent errors, as plain lines. Listed in a run's report; no weight can fix them. */
  errors?: () => string[];
}

export const isSelfDebugRoute = (pathname: string): boolean =>
  pathname === "/api/self-improvement/self-debug" || pathname.startsWith("/api/self-improvement/self-debug/");

/** Sessions kept on disk, and dialogue lines kept per saved session. Bounded: a long-running install must not grow a log. */
const SAVED_SESSIONS = 30;
const SAVED_DIALOGUE = 120;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";

// ── The service ──────────────────────────────────────────────────────────

export interface ServiceDirs {
  /** Where state.json lives. */
  state: string;
  /** Where made skills go, in the format the server loads at boot. */
  skills: string;
  /** Where plugin proposals are installed. */
  extensions: string;
}

export function defaultDirs(): ServiceDirs {
  return {
    state: path.join(dataRoot(), "self-debug"),
    skills: path.join(codeRoot(), "extension-builder", "extensions"),
    extensions: path.join(dataRoot(), "extensions"),
  };
}

export class SelfDebugService {
  readonly debugger: SelfDebugger;
  private readonly ledger: WeightLedger;
  private saved: DebugSession[] = [];
  private readonly manager: ExtensionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private autoPassRunning = false;

  constructor(readonly dirs: ServiceDirs = defaultDirs()) {
    const state = this.readState();
    this.ledger = WeightLedger.fromJSON(state.ledger);
    this.saved = Array.isArray(state.sessions) ? (state.sessions as DebugSession[]).slice(-SAVED_SESSIONS) : [];
    this.manager = new ExtensionManager({ rootDir: dirs.extensions });
    try { this.manager.load(); } catch { /* an unreadable extensions folder is an empty one */ }
    this.debugger = new SelfDebugger({
      ledger: this.ledger,
      makeSkill: this.skillMaker,
      proposePlugin: this.pluginProposer,
      activatePlugin: async id => { await this.manager.activate(id); },
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private statePath(): string { return path.join(this.dirs.state, "state.json"); }

  private readState(): { ledger?: unknown; sessions?: unknown; auto?: boolean } {
    try {
      const file = this.statePath();
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    } catch { return {}; }
  }

  /** Never throws into a request: a full disk must not break a run. Returns whether it saved. */
  private save(): boolean {
    try {
      mkdirSync(this.dirs.state, { recursive: true });
      const sessions = this.saved.slice(-SAVED_SESSIONS).map(s => ({ ...s, dialogue: s.dialogue.slice(0, SAVED_DIALOGUE) }));
      writeJsonAtomic(this.statePath(), { ledger: this.ledger.toJSON(), sessions, auto: this.autoEnabled() });
      return true;
    } catch { return false; }
  }

  // ── Making skills and plugin proposals ─────────────────────────────────

  /**
   * A skill is built with the Extension Builder and trained with it (the same delta-rule training as its
   * Train button). Written in the format the server already loads at boot, so it takes effect on the
   * next start; nothing is grafted into the live AI here.
   */
  readonly skillMaker: SkillMaker = async (spec: SkillSpec) => {
    // Two scripts that answer the same question differently would make a skill that contradicts itself.
    const seen = new Map<string, string>();
    for (const s of spec.scripts) {
      const key = s.userSays.toLowerCase().replace(/\s+/g, " ").trim();
      const prior = seen.get(key);
      if (prior !== undefined && prior !== s.response) return { ok: false, converged: false, detail: `two scripts answer "${s.userSays}" differently, so there is nothing consistent to learn` };
      seen.set(key, s.response);
    }
    const builder = new ExtensionBuilder();
    const project = builder.createProject(spec.name, spec.description);
    // One neuron per script, as scripts/skill-agent.mjs builds its skills: a single neuron
    // does not converge on several different (input -> answer) pairs.
    const unique = Array.from(seen.entries());
    const ids: string[] = [];
    for (let i = 0; i < unique.length; i++) {
      const neuron = builder.addNeuron(project.id, `${slug(spec.name)}-${i + 1}`, 0);
      if (!neuron) return { ok: false, converged: false, detail: "the Extension Builder would not add a neuron" };
      const script = spec.scripts.find(s => s.userSays.toLowerCase().replace(/\s+/g, " ").trim() === unique[i][0])!;
      builder.addScript(project.id, neuron.id, script.userSays, script.response);
      ids.push(neuron.id);
    }
    // The Extension Builder's own training, reported as it came out. Whether it converges depends on
    // the exact text (measured: some sets of scripts never do), and what chat does with a skill is
    // match what was typed to a stored script and return its answer, which needs no convergence. So a
    // skill is kept either way, and each neuron's `trained` flag says truthfully whether the mesh
    // training reproduced it. Nothing here claims training that did not happen.
    const trained = builder.train(project.id, { epochs: 5000 });
    const json = builder.saveWithoutQuantization(project.id);
    if (!json) return { ok: false, converged: false, detail: "nothing to save" };
    mkdirSync(this.dirs.skills, { recursive: true });
    const file = path.join(this.dirs.skills, `${slug(spec.name)}.ext.json`);
    writeJsonAtomic(file, JSON.parse(json));
    const reproduced = ids.filter(id => project.neurons.get(id)?.trained).length;
    return {
      ok: true, converged: !!trained?.converged && reproduced === ids.length, id: slug(spec.name),
      detail: `${ids.length} script${ids.length === 1 ? "" : "s"} saved as ${path.basename(file)}; the Extension Builder's training reproduced ${reproduced} of ${ids.length}${reproduced < ids.length ? ", so the rest answer by matching what was typed, not through trained weights" : ""}`,
    };
  };

  /** Installs the plugin through the one registration path (ExtensionManager), OFF. Never activates. */
  readonly pluginProposer: PluginProposer = async (source, spec) => {
    try {
      const record = await this.manager.autoCreate({
        id: spec.id, name: spec.name, kind: "plugin", description: spec.description,
        capabilities: spec.capabilities, permissions: [], payload: Buffer.from(source, "utf8"),
        createdBy: "self-debug", sources: ["self-debug"],
      });
      return { ok: true, id: record.manifest.id, detail: `installed version ${record.manifest.version}, inactive` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── Running ────────────────────────────────────────────────────────────

  async run(netId: string, options: DebugOptions & { useMistakes?: boolean } = {}, extra: { mistakes?: Mistake[]; observations?: string[] } = {}): Promise<DebugSession> {
    const made = madeNets().find(m => m.id === netId);
    if (!made) throw new NotFound("No such net (they are forgotten on restart).");
    const cases: DebugCase[] = casesFromNet(made.net);
    if (options.useMistakes && extra.mistakes) cases.push(...casesFromMistakes(extra.mistakes));
    const session = await this.debugger.debug(made.name, made.net, cases, { ...options, observations: [...(options.observations ?? []), ...(extra.observations ?? [])] }, made.editor);
    this.saved.push(session);
    while (this.saved.length > SAVED_SESSIONS) this.saved.shift();
    this.save();
    return session;
  }

  // ── The background pass ────────────────────────────────────────────────

  autoEnabled(): boolean {
    if (process.env.NEUROCLAW_SELF_DEBUG === "0") return false;
    try {
      const f = configFile("self-debug.json");
      if (existsSync(f.read)) { const v = JSON.parse(readFileSync(f.read, "utf8")); if (typeof v?.auto === "boolean") return v.auto; }
    } catch { /* default */ }
    return true;
  }

  setAuto(enabled: boolean): boolean {
    try {
      const f = configFile("self-debug.json");
      mkdirSync(path.dirname(f.write), { recursive: true });
      writeJsonAtomic(f.write, { auto: enabled });
      return true;
    } catch { return false; }
  }

  /**
   * One look at every net that is not part of the live AI. A net that already answers everything
   * clearly costs only the scoring, which is a handful of reads. Returns the sessions it ran.
   */
  async autoPass(observations: () => string[] = () => []): Promise<DebugSession[]> {
    if (this.autoPassRunning || this.debugger.isRunning() || !this.autoEnabled()) return [];
    this.autoPassRunning = true;
    const ran: DebugSession[] = [];
    try {
      for (const made of madeNets()) {
        if (made.kind === "skill") continue; // the live AI is only changed when the owner says so
        const cases = normalizeCases(casesFromNet(made.net));
        if (cases.length === 0 || scoreSuite(made.net, cases).every(s => s.confident)) continue;
        ran.push(await this.run(made.id, { maxMs: 5000, maxRounds: 30 }, { observations: observations() }));
      }
    } catch { /* the next pass tries again */ } finally { this.autoPassRunning = false; }
    return ran;
  }

  startLoop(observations?: () => string[]): void {
    if (this.timer || process.env.NEUROCLAW_SELF_DEBUG === "0") return;
    const every = Math.max(60_000, Number(process.env.NEUROCLAW_SELF_DEBUG_INTERVAL_MS) || 10 * 60_000);
    this.timer = setInterval(() => { void this.autoPass(observations); }, every);
    this.timer.unref?.();
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── What the page reads ────────────────────────────────────────────────

  /** Every run kept, oldest first: the ones saved from earlier starts and this one's. */
  sessions(): DebugSession[] {
    return this.saved;
  }

  status() {
    const sessions = this.sessions();
    const last = sessions[sessions.length - 1];
    return {
      running: this.debugger.isRunning(),
      auto: this.autoEnabled(),
      nets: madeNets().map(m => {
        const cases = normalizeCases(casesFromNet(m.net));
        const s = summarize(scoreSuite(m.net, cases));
        return { id: m.id, name: m.name, kind: m.kind, cases: s.cases, correct: s.correct, confident: s.confident, totalLoss: s.totalLoss };
      }),
      last: last ? brief(last) : null,
      sessions: sessions.slice(-20).reverse().map(brief),
      pendingPlugins: this.debugger.pendingPlugins(),
      trustedWeights: this.ledger.top(10),
      weightsTracked: this.ledger.size(),
      actions: this.debugger.actions.history().slice(-20).map(a => ({ action: a.action, why: a.why, approval: a.approval, result: a.result ?? null })),
    };
  }

  session(id: string): DebugSession | undefined {
    return this.saved.find(s => s.id === id);
  }
}

/** A run without its dialogue and rounds: what a list needs. */
function brief(s: DebugSession) {
  return {
    id: s.id, net: s.net, startedAt: s.startedAt, endedAt: s.endedAt,
    before: s.before, after: s.after, stopReason: s.stopReason, restored: s.restored,
    rounds: s.rounds.length,
    kept: s.rounds.filter(r => r.verdict === "kept").length,
    undone: s.rounds.filter(r => r.verdict === "undone").length,
    problems: s.problems.map(p => ({ id: p.id, outcome: p.outcome, lossBefore: p.lossBefore, lossAfter: p.lossAfter })),
    skills: s.skills, plugins: s.plugins, observations: s.observations,
  };
}

let shared: SelfDebugService | null = null;
/** The one service this process uses. */
export function selfDebugService(): SelfDebugService {
  shared ??= new SelfDebugService();
  return shared;
}
/** Tests: start over with other folders. */
export function resetSelfDebugService(service: SelfDebugService | null = null): void {
  shared?.stopLoop();
  shared = service;
}

// ── Routes ───────────────────────────────────────────────────────────────

class BadRequest extends Error { constructor(message: string, readonly status = 400) { super(message); } }
class NotFound extends BadRequest { constructor(message: string) { super(message, 404); } }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns true when the route was handled. */
export async function handleSelfDebugRoutes(ctx: SelfDebugContext, service: SelfDebugService = selfDebugService()): Promise<boolean> {
  if (!isSelfDebugRoute(ctx.pathname)) return false;
  const send = (data: unknown, status = 200): true => { ctx.sendJson(ctx.res, data, status); return true; };
  try {
    const { pathname, method } = ctx;
    const body = async (): Promise<Record<string, unknown>> => {
      const b = await ctx.parseBody(ctx.req, 8 * 1024);
      if (!isObj(b)) throw new BadRequest("Expected a JSON object.");
      return b;
    };
    const optNum = (b: Record<string, unknown>, key: string, min: number, max: number): number | undefined => {
      const v = b[key];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`Expected "${key}" to be a number.`);
      return Math.max(min, Math.min(max, v));
    };
    const optBool = (b: Record<string, unknown>, key: string): boolean | undefined => {
      const v = b[key];
      if (v === undefined) return undefined;
      if (typeof v !== "boolean") throw new BadRequest(`Expected "${key}" to be true or false.`);
      return v;
    };

    if (pathname === "/api/self-improvement/self-debug" && method === "GET") return send(service.status());

    if (pathname.startsWith("/api/self-improvement/self-debug/sessions/") && method === "GET") {
      const id = pathname.slice("/api/self-improvement/self-debug/sessions/".length);
      const s = /^[A-Za-z0-9_]{3,60}$/.test(id) ? service.session(id) : undefined;
      if (!s) throw new NotFound("No such run.");
      return send(s);
    }

    if (pathname === "/api/self-improvement/self-debug/run" && method === "POST") {
      const b = await body();
      if (typeof b.net !== "string" || !/^[0-9a-f]{10}$/.test(b.net)) throw new BadRequest('Expected "net": the id of a net from /api/nets.');
      const made = madeNets().find(n => n.id === b.net);
      if (!made) throw new NotFound("No such net (they are forgotten on restart).");
      if (made.kind === "skill" && b.confirm !== true) throw new BadRequest('That net is part of the live AI, and a run changes its weights. Send "confirm": true to do that.', 409);
      if (service.debugger.isRunning()) throw new BadRequest("A self-debug run is already in progress.", 409);
      const options: DebugOptions & { useMistakes?: boolean } = {
        maxRounds: optNum(b, "maxRounds", 1, 200), patience: optNum(b, "patience", 1, 10), edits: optNum(b, "edits", 1, 8),
        minCosine: optNum(b, "minCosine", 0, 0.99), maxMs: optNum(b, "maxMs", 500, 60_000),
        makeSkills: optBool(b, "makeSkills"), makePlugins: optBool(b, "makePlugins"), useMistakes: optBool(b, "useMistakes"),
      };
      const mistakes = options.useMistakes && ctx.mistakes ? await ctx.mistakes() : undefined;
      const session = await service.run(made.id, options, { mistakes, observations: ctx.errors?.() ?? [] });
      return send(session);
    }

    if (pathname === "/api/self-improvement/self-debug/auto" && method === "POST") {
      const b = await body();
      const enabled = optBool(b, "enabled");
      if (enabled === undefined) throw new BadRequest('Expected "enabled": true or false.');
      const saved = service.setAuto(enabled);
      if (!saved) return send({ error: "Could not save that setting.", auto: service.autoEnabled() }, 500);
      return send({ auto: service.autoEnabled(), overriddenByEnv: process.env.NEUROCLAW_SELF_DEBUG === "0" });
    }

    if (pathname.startsWith("/api/self-improvement/self-debug/plugins/") && method === "POST") {
      // .../plugins/<id>/approve or .../plugins/<id>/deny
      const m = /^([a-z0-9-]{1,80})\/(approve|deny)$/.exec(pathname.slice("/api/self-improvement/self-debug/plugins/".length));
      if (!m) throw new NotFound("Expected .../plugins/<id>/approve or .../plugins/<id>/deny.");
      const result = m[2] === "approve" ? await service.debugger.approvePlugin(m[1]) : service.debugger.denyPlugin(m[1]);
      return send(result, result.ok ? 200 : 404);
    }

    return false;
  } catch (err) {
    const status = err instanceof BadRequest ? err.status : 500;
    return send({ error: err instanceof Error ? err.message : String(err) }, status);
  }
}
