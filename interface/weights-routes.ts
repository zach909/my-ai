/**
 * HTTP routes for the net maker, the net skill maker, the weight editor and
 * the compiler.
 *
 * Owner routes, behind the server's normal gate. Every POST reads a JSON body
 * (parseBody insists on a JSON content type, the server's guard against another
 * tab posting here). Nets live in memory, a handful at a time; a restart
 * forgets them.
 *
 *   GET  /api/nets                        the nets made so far
 *   POST /api/nets                        {source, name?, dimensions?, seed?, confirm?}
 *                                          make one. kind="skill" grafts into the LIVE AI and
 *                                          needs confirm:true; anything else is a network of its own.
 *   GET  /api/nets/:id                    neurons, frozen, edit history
 *   POST /api/nets/:id/respond            {text}                       type something, get the response
 *   POST /api/nets/:id/view               {text, goal?, drive?, read?, dims?, top?}   explain the weights
 *   POST /api/nets/:id/nudge              {target, source, dim, delta, reason?}       one small edit
 *   POST /api/nets/:id/undo               {count?}
 *   POST /api/nets/:id/step               {text, goal, edits?, size?}  a few small edits, kept only if closer
 *   POST /api/nets/:id/improve            {text, goal, steps?, size?}
 *   POST /api/nets/:id/freeze             {neuron, frozen}
 *   POST /api/compile                     {code, inputs?}              the compiler: code -> weights
 *   POST /api/task-training               {mode, agents?, rounds?, epochs?, tasks? | generate?}
 *                                          train AIs on tasks: single, hive, separate or silent
 */

import type http from "node:http";
import { randomBytes } from "node:crypto";
import type { HyperDimensionalEngine } from "../models && skills/core/onebrain.js";
import { makeFromSource, type BuiltNet, type MakerResult } from "../models && skills/core/neuro-build.js";
import { EditRefused, WeightEditor, compileView } from "../models && skills/core/weight-editor.js";
import { NeuroLangInterpreter } from "../models && skills/core/neuro-lang.js";
import { MAX_TASKS, TASK_MODES, arithmeticTasks, trainTasks, type Task, type TaskMode } from "../models && skills/core/task-training.js";

export interface WeightsContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
  /** The live base AI a skill joins, or null where there is none. */
  base(): Promise<HyperDimensionalEngine | null>;
}

interface Made {
  id: string;
  name: string;
  kind: string;
  net: BuiltNet;
  editor: WeightEditor;
  made: number;
  training: MakerResult["training"];
  warnings: string[];
}

const MAX_NETS = 8;
const MAX_SOURCE_BYTES = 64 * 1024;
const nets = new Map<string, Made>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isWeightsRoute = (pathname: string): boolean =>
  pathname === "/api/nets" || pathname.startsWith("/api/nets/") || pathname === "/api/compile" || pathname === "/api/task-training";

class BadRequest extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function summary(m: Made) {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    neurons: Array.from(m.net.ids.keys()),
    inputNeuron: m.net.inputName,
    outputNeuron: m.net.outputName,
    frozen: Array.from(m.net.frozen),
    dims: m.net.dims,
    training: m.training,
    warnings: m.warnings,
    edits: m.editor.getHistory().length,
  };
}

/** Returns true when the route was handled. */
export async function handleWeightsRoutes(ctx: WeightsContext): Promise<boolean> {
  if (!isWeightsRoute(ctx.pathname)) return false;
  try {
    return await route(ctx);
  } catch (err) {
    const status = err instanceof BadRequest || err instanceof EditRefused ? err.status : 500;
    // An unknown neuron name is the caller's mistake, not the server's.
    const message = err instanceof Error ? err.message : String(err);
    ctx.sendJson(ctx.res, { error: message }, status === 500 && /^No neuron named/.test(message) ? 400 : status);
    return true;
  }
}

async function route(ctx: WeightsContext): Promise<boolean> {
  const { pathname, method, req, res } = ctx;
  const send = (data: unknown, status = 200): true => { ctx.sendJson(res, data, status); return true; };
  const body = async (max = 8 * 1024): Promise<Record<string, unknown>> => {
    const b = await ctx.parseBody(req, max);
    if (!isObj(b)) throw new BadRequest("Expected a JSON object.");
    return b;
  };
  const str = (b: Record<string, unknown>, key: string, required = true): string => {
    const v = b[key];
    if (typeof v === "string") return v;
    if (required) throw new BadRequest(`Expected "${key}" to be text.`);
    return "";
  };
  const num = (b: Record<string, unknown>, key: string): number => {
    const v = b[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`Expected "${key}" to be a number.`);
    return v;
  };
  const optNum = (b: Record<string, unknown>, key: string): number | undefined => (b[key] === undefined ? undefined : num(b, key));

  if (pathname === "/api/compile" && method === "POST") {
    const b = await body();
    const code = str(b, "code");
    if (code.length > 4000) throw new BadRequest("That code is too long to compile here (4000 characters).");
    const inputs = Array.isArray(b.inputs) ? b.inputs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(0, 16) : undefined;
    return send(compileView(code, inputs));
  }

  if (pathname === "/api/task-training" && method === "POST") {
    const b = await body(32 * 1024);
    const mode = b.mode;
    if (typeof mode !== "string" || !TASK_MODES.includes(mode as TaskMode)) throw new BadRequest(`"mode" must be one of ${TASK_MODES.join(", ")}.`);
    let tasks: Task[];
    if (Array.isArray(b.tasks)) {
      if (b.tasks.length > MAX_TASKS) throw new BadRequest(`At most ${MAX_TASKS} tasks.`);
      tasks = b.tasks.map((t, i) => {
        if (!isObj(t) || typeof t.input !== "string") throw new BadRequest(`Task ${i + 1}: expected {"input": "...", "parts": ["..."]}.`);
        const parts = Array.isArray(t.parts) ? t.parts.filter((p): p is string => typeof p === "string") : typeof t.answer === "string" ? [t.answer] : [];
        return { id: typeof t.id === "string" && t.id ? t.id : `t${i + 1}`, input: t.input, parts };
      });
    } else if (isObj(b.generate)) {
      const g = b.generate;
      tasks = arithmeticTasks(Math.min(MAX_TASKS, Math.max(1, optNum(g, "count") ?? 6)), optNum(g, "seed") ?? 1, g.composite === true);
    } else {
      throw new BadRequest('Send "tasks" or "generate": {"count": 6, "composite": false}.');
    }
    try {
      return send(await trainTasks(tasks, { mode: mode as TaskMode, agents: optNum(b, "agents"), rounds: optNum(b, "rounds"), epochs: optNum(b, "epochs"), seed: optNum(b, "seed") }));
    } catch (err) {
      throw new BadRequest(err instanceof Error ? err.message : String(err), 422);
    }
  }

  if (pathname === "/api/nets" && method === "GET") {
    return send({ nets: Array.from(nets.values()).map(summary) });
  }

  if (pathname === "/api/nets" && method === "POST") {
    const b = await body(MAX_SOURCE_BYTES);
    const source = str(b, "source");
    const kind = (await new NeuroLangInterpreter().parse(source)).program?.kind ?? "network";
    let base: HyperDimensionalEngine | undefined;
    if (kind === "skill") {
      if (b.confirm !== true) throw new BadRequest('A skill is grafted into the live AI and changes it. Send "confirm": true to do that.', 409);
      base = (await ctx.base()) ?? undefined;
      if (!base) throw new BadRequest("There is no live AI to graft a skill into here.", 503);
    }
    const result = await makeFromSource(source, {
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : undefined,
      dimensions: optNum(b, "dimensions"),
      seed: optNum(b, "seed"),
      base,
    });
    if (!result.ok || !result.net) return send({ ok: false, errors: result.errors, warnings: result.warnings }, 422);
    // A skill is part of the live AI, not a scratch net; it is still listed so it can be explained.
    const id = randomBytes(5).toString("hex");
    const made: Made = {
      id, name: result.net.name, kind: result.kind, net: result.net, editor: new WeightEditor(result.net),
      made: Date.now(), training: result.training, warnings: result.warnings,
    };
    nets.set(id, made);
    while (nets.size > MAX_NETS) nets.delete(nets.keys().next().value as string);
    return send({ ok: true, ...summary(made) });
  }

  const m = /^\/api\/nets\/([0-9a-f]{10})(?:\/([a-z]+))?$/.exec(pathname);
  if (!m) return false;
  const made = nets.get(m[1]);
  if (!made) throw new BadRequest("No such net (they are forgotten on restart).", 404);
  const action = m[2];

  if (!action && method === "GET") return send({ ...summary(made), history: made.editor.getHistory().slice(-50) });
  if (method !== "POST") return false;
  const b = await body();

  switch (action) {
    case "respond": {
      const r = made.net.respond(str(b, "text"));
      return send({ drove: r.drove, response: r.response, similarity: r.similarity, output: Array.from(r.output) });
    }
    case "view": {
      return send(made.editor.view({
        text: str(b, "text"),
        goal: typeof b.goal === "string" ? b.goal : undefined,
        drive: typeof b.drive === "string" ? b.drive : undefined,
        read: typeof b.read === "string" ? b.read : undefined,
        dims: Array.isArray(b.dims) ? b.dims.filter((x): x is number => typeof x === "number").slice(0, 8) : undefined,
        top: optNum(b, "top"),
      }));
    }
    case "nudge": {
      const edit = made.editor.nudge(str(b, "target"), str(b, "source"), num(b, "dim"), num(b, "delta"), typeof b.reason === "string" ? b.reason.slice(0, 200) : "");
      return send({ edit });
    }
    case "undo": {
      return send({ undone: made.editor.undo(Math.min(100, Math.max(1, optNum(b, "count") ?? 1))) });
    }
    case "step": {
      return send(made.editor.step({ text: str(b, "text"), goal: str(b, "goal"), edits: optNum(b, "edits"), size: optNum(b, "size") }));
    }
    case "improve": {
      return send(made.editor.improve({ text: str(b, "text"), goal: str(b, "goal"), steps: optNum(b, "steps"), size: optNum(b, "size") }));
    }
    case "freeze": {
      if (typeof b.frozen !== "boolean") throw new BadRequest('Expected "frozen": true or false.');
      made.editor.setFrozen(str(b, "neuron"), b.frozen);
      return send(summary(made));
    }
    default:
      return false;
  }
}
