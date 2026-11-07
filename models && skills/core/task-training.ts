/**
 * Task training: AIs get a task and are trained until they can do it.
 *
 * A task is an input and what the answer should be (an answer can have
 * several parts). The agents are nets made by the net maker (neuro-build.ts),
 * each in an engine of its own. A round is: every agent learns what it is
 * responsible for, and then everyone is scored on the tasks. Four ways to run
 * it, which differ in who learns what and what the agents may share:
 *
 *   single    One AI gets every task.
 *   hive      Several AIs inside a HiveMind (hive-mind.ts). Each starts with
 *             its own share of the tasks, and they MAY talk: an agent posts the
 *             tasks it can verifiably do to the hive's shared blackboard and
 *             the others learn them from there. Trust moves with who was
 *             right, and the team answers by trust-weighted vote.
 *   separate  Several AIs, each given every task, each trained on its own with
 *             its own random start. They share nothing at all. Each is scored
 *             alone; the team answer is a majority vote taken from outside, by
 *             this file, not by the agents.
 *   silent    Several AIs that cannot talk and work together. Nothing joins
 *             them while they run: no blackboard, no messages, no shared net.
 *             What lets them cooperate is an agreement made BEFORE the run: a
 *             fixed rule says who is responsible for which task, and for
 *             which part of an answer that has several. The team is scored
 *             jointly: a task counts only if every responsible agent got its
 *             part right.
 *
 * What the numbers mean, said plainly so nobody reads more into them:
 *  - Scores are the share of tasks answered exactly right, using the answers
 *    the agent was taught. An agent can only give an answer it has been taught,
 *    so a task it was never given is simply not answerable by it. This
 *    measures whether a mode ends with agents (or a team) that can do the
 *    tasks. It does NOT measure doing a task nobody taught them.
 *  - The grader is exact string equality with the stored answer. No model
 *    judges anything.
 *  - Nothing here caps the number of tasks, agents, rounds, epochs or the
 *    length of the text. Cost still grows (the nets are all-to-all, roughly
 *    with the square of the tasks), and one training step runs to the end
 *    before anything else in the process can run, so a very large run holds
 *    up whatever else this process is serving. The loop yields between agents,
 *    not inside one.
 *  - One agent has a limited capacity. Measured here: 5 of 6 arithmetic tasks
 *    in one 16-dimension net, 3 of 3 for three tasks. Splitting the tasks
 *    across agents (hive, silent) gets more of them right mostly because each
 *    agent holds fewer, so read those scores with that in mind.
 *  - "messages" counts reads and writes between agents. It is 0 for single,
 *    separate and silent, and the silent mode is built so it cannot be
 *    anything else (it has no channel to count).
 */

import { netMaker, type BuiltNet } from "./neuro-build.js";
import { HiveMind } from "./hive-mind.js";
import { yieldToEventLoop, type NeuriNeuron } from "./neuro-lang.js";

export type TaskMode = "single" | "hive" | "separate" | "silent";
export const TASK_MODES: readonly TaskMode[] = ["single", "hive", "separate", "silent"];

export interface Task {
  id: string;
  input: string;
  /** What the answer says. Several parts make a composite answer (joined with a space for one AI). */
  parts: string[];
}

export interface TaskTrainingOptions {
  mode: TaskMode;
  /** Agents for hive, separate and silent. Default 3. Single always uses 1. */
  agents?: number;
  /** Rounds of learn-then-score. Default 3. */
  rounds?: number;
  /** Training epochs per round. Default 120. */
  epochs?: number;
  /** Content dimensions per neuron in each agent's net. Default 16. */
  dimensions?: number;
  seed?: number;
}

export interface AgentReport {
  id: string;
  /** Tasks this agent holds an answer for at the end. */
  knows: number;
  /** Share of ALL tasks this agent answers right on its own. */
  score: number;
  /** Silent mode: the parts this agent is responsible for. */
  responsibleFor?: string[];
  /** Hive mode: this agent's share of the hive's trust budget (it moves with who was right). */
  trust?: number;
}

export interface TaskTrainingReport {
  mode: TaskMode;
  tasks: number;
  agents: AgentReport[];
  /** The team's score after each round, with round 0 = before anything was learned. */
  teamScore: number[];
  /** How the team answer is formed in this mode. */
  teamRule: string;
  /** Reads and writes between agents. */
  messages: number;
  /** Tasks the team gets wrong at the end. */
  missed: string[];
  notes: string[];
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * What a task needs to mean anything: an id nobody else has, an input, at
 * least one answer part, and an input no other task shares (two tasks with one
 * input would have no single answer to it). There is no cap on how many tasks
 * there are or how long the text is, and no character is forbidden: task text
 * is held on the neurons directly and never passes through the program parser.
 */
export function validateTasks(tasks: Task[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  if (tasks.length === 0) problems.push("no tasks");
  for (const t of tasks) {
    if (!t.id || seen.has(t.id)) problems.push(`task id "${t.id}" is missing or repeated`);
    seen.add(t.id);
    if (typeof t.input !== "string" || t.input.length === 0) problems.push(`task "${t.id}": the input is empty`);
    if (!Array.isArray(t.parts) || t.parts.length === 0) problems.push(`task "${t.id}": needs at least one answer part`);
    else for (const p of t.parts) if (typeof p !== "string" || p.length === 0) problems.push(`task "${t.id}": an answer part is empty`);
  }
  const inputs = tasks.map(t => t.input);
  if (new Set(inputs).size !== inputs.length) problems.push("two tasks have the same input, so the answer to it is not defined");
  return problems;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Arithmetic tasks whose answers this code computes, so nothing is looked up
 * and no model invents them. `composite` tasks have two answer parts: the sum
 * and the product, which is what lets silent agents each own one part.
 */
export function arithmeticTasks(count: number, seed = 1, composite = false): Task[] {
  const rand = rng(seed);
  const tasks: Task[] = [];
  const used = new Set<string>();
  // The operands widen with the count, so there are always more distinct
  // problems than asked for (a fixed range would run out and never return).
  const span = Math.max(18, Math.ceil(Math.sqrt(count * 2)) + 1);
  while (tasks.length < count) {
    const a = 2 + Math.floor(rand() * span);
    const b = 2 + Math.floor(rand() * span);
    const input = composite ? `${a} and ${b}` : `${a} + ${b}`;
    if (used.has(input)) continue;
    used.add(input);
    tasks.push({
      id: `t${tasks.length + 1}`,
      input,
      parts: composite ? [`sum ${a + b}`, `product ${a * b}`] : [`${a + b}`],
    });
  }
  return tasks;
}

// ── One agent ────────────────────────────────────────────────────────────────

/** A net that holds the answers it has been taught, one drive neuron per task. */
class TaskAgent {
  /** task key -> the drive neuron holding it and the answer it holds. */
  private held = new Map<string, { neuron: string; answer: string }>();

  constructor(readonly id: string, readonly net: BuiltNet, private readonly capacity: number) {}

  get knows(): number { return this.held.size; }
  has(key: string): boolean { return this.held.has(key); }

  /** Hold (or change) the answer to `input`. Takes effect at the next train(). */
  hold(key: string, input: string, answer: string): void {
    const existing = this.held.get(key);
    const neuron = existing?.neuron ?? `n${this.held.size + 1}`;
    if (!existing && this.held.size >= this.capacity) throw new Error(`${this.id} has no free neuron for another task`);
    const n = this.net.neurons.get(neuron) as NeuriNeuron;
    n.input = input;
    n.response = answer;
    this.held.set(key, { neuron, answer });
  }

  train(epochs: number): void {
    // A tight tolerance on purpose. At the net maker's default (0.2) training
    // stops after a few milliseconds, once every output is merely near the
    // average of the answers, and similar answers are then not told apart:
    // measured, 1 of 6 tasks right at 0.2 and 5 of 6 at 0.01.
    this.net.trainResponses({ epochs, rounds: 1, tolerance: 0.01 });
  }

  /** The answer this agent gives to `input`, or null if it has been taught nothing. */
  answer(input: string): string | null {
    return this.held.size === 0 ? null : this.net.respond(input).response;
  }
}

async function makeAgent(id: string, tasks: number, dimensions: number, seed: number): Promise<TaskAgent> {
  const neurons = Math.max(4, tasks + 1); // one drive neuron per task, then the output
  const made = await netMaker(`neurons="${neurons}"`, { dimensions, seed, name: id, maxNeurons: Infinity });
  if (!made.ok || !made.net) throw new Error(`could not make agent ${id}: ${made.errors.join("; ")}`);
  return new TaskAgent(id, made.net, neurons - 1);
}

// ── The four modes ───────────────────────────────────────────────────────────

export async function trainTasks(tasks: Task[], options: TaskTrainingOptions): Promise<TaskTrainingReport> {
  const problems = validateTasks(tasks);
  if (problems.length) throw new Error(problems.join("; "));
  if (!TASK_MODES.includes(options.mode)) throw new Error(`mode must be one of ${TASK_MODES.join(", ")}`);
  const mode = options.mode;
  // No upper bound on agents, rounds or epochs: the caller decides, and pays the cost.
  const count = mode === "single" ? 1 : Math.max(2, Math.floor(options.agents ?? 3));
  const rounds = Math.max(1, Math.floor(options.rounds ?? 3));
  const epochs = Math.max(1, Math.floor(options.epochs ?? 120));
  const dims = options.dimensions ?? 16;
  const seed = options.seed ?? 1;
  const widest = Math.max(...tasks.map(t => t.parts.length));
  if (mode === "silent" && count < widest) {
    throw new Error(`silent mode needs at least ${widest} agents: a task with ${widest} parts needs ${widest} different agents`);
  }

  const agents: TaskAgent[] = [];
  for (let i = 0; i < count; i++) agents.push(await makeAgent(`agent${i + 1}`, tasks.length, dims, seed * 1000 + i + 1));

  const notes: string[] = [];
  const full = (t: Task) => t.parts.join(" ");
  let messages = 0;
  let teamRule = "";
  let teamAnswer: (t: Task) => string | null;
  let responsible: Map<string, string[]> | undefined;
  let hive: HiveMind | undefined;

  // The agreement made before the run: task i, part p belongs to agent (i + p) mod count.
  const owner = (taskIndex: number, part: number) => (taskIndex + part) % count;

  if (mode === "single") {
    teamRule = "the one agent's answer";
    teamAnswer = t => agents[0].answer(t.input);
  } else if (mode === "separate") {
    teamRule = "majority vote of the agents' separate answers, counted from outside; the agents never see each other";
    teamAnswer = t => {
      const votes = new Map<string, number>();
      for (const a of agents) { const r = a.answer(t.input); if (r !== null) votes.set(r, (votes.get(r) ?? 0) + 1); }
      let best: string | null = null, top = 0;
      for (const [r, v] of votes) if (v > top) { best = r; top = v; }
      return best;
    };
  } else if (mode === "hive") {
    hive = new HiveMind({ totalTrust: 100 });
    for (const a of agents) hive.spawn({ id: a.id, role: "learner", specialization: "tasks" });
    teamRule = "trust-weighted vote; trust moves with who is right";
    teamAnswer = t => {
      const weight = new Map<string, number>();
      for (const a of agents) {
        const r = a.answer(t.input);
        if (r !== null) weight.set(r, (weight.get(r) ?? 0) + (hive!.get(a.id)?.trust ?? 0));
      }
      let best: string | null = null, top = -1;
      for (const [r, w] of weight) if (w > top) { best = r; top = w; }
      return best;
    };
  } else {
    teamRule = "joint: a task counts only if every responsible agent got its part right";
    responsible = new Map(agents.map(a => [a.id, [] as string[]]));
    teamAnswer = t => {
      const i = tasks.indexOf(t);
      const parts: string[] = [];
      for (let p = 0; p < t.parts.length; p++) {
        const r = agents[owner(i, p)].answer(t.input);
        if (r === null) return null;
        parts.push(r);
      }
      return parts.join(" ");
    };
  }

  const teamCorrect = (): string[] => tasks.filter(t => teamAnswer(t) !== full(t)).map(t => t.id);
  const teamScores: number[] = [1 - teamCorrect().length / tasks.length];

  for (let round = 1; round <= rounds; round++) {
    if (mode === "single" || mode === "separate") {
      for (const a of agents) {
        tasks.forEach(t => a.hold(t.id, t.input, full(t)));
        a.train(epochs);
        await yieldToEventLoop();
      }
    } else if (mode === "hive") {
      // 1. Each agent learns its own share.
      tasks.forEach((t, i) => agents[i % count].hold(t.id, t.input, full(t)));
      for (const a of agents) { a.train(epochs); await yieldToEventLoop(); }
      // 2. They talk: each posts what it can verifiably do.
      for (const a of agents) {
        for (const [i, t] of tasks.entries()) {
          if (i % count !== agents.indexOf(a)) continue;
          if (a.answer(t.input) === full(t)) {
            hive!.get(a.id)!.share(`solved:${t.id}`, { input: t.input, answer: full(t) });
            messages++;
            hive!.reward(a.id, 2);
          } else {
            hive!.reward(a.id, -1);
          }
        }
      }
      // 3. And learn from each other, from the blackboard only.
      for (const a of agents) {
        for (const t of tasks) {
          if (a.has(t.id)) continue;
          const posted = hive!.blackboard.read(a.id, `solved:${t.id}`) as { input: string; answer: string } | undefined;
          messages++;
          if (posted) a.hold(t.id, posted.input, posted.answer);
        }
        a.train(epochs);
        await yieldToEventLoop();
      }
    } else {
      // Silent: nothing is shared. Each agent learns only what the prior agreement makes it responsible for.
      tasks.forEach((t, i) => t.parts.forEach((part, p) => {
        const a = agents[owner(i, p)];
        a.hold(`${t.id}#${p + 1}`, t.input, part);
      }));
      for (const a of agents) { a.train(epochs); await yieldToEventLoop(); }
    }
    teamScores.push(1 - teamCorrect().length / tasks.length);
  }

  if (mode === "silent") {
    // The same answer to the same input from two parts of one task would collide, so check the rule held.
    tasks.forEach((t, i) => t.parts.forEach((_, p) => responsible!.get(agents[owner(i, p)].id)!.push(`${t.id}#${p + 1}`)));
  }

  const missed = teamCorrect();
  const agentReports: AgentReport[] = agents.map(a => ({
    id: a.id,
    knows: a.knows,
    score: 1 - tasks.filter(t => a.answer(t.input) !== full(t)).length / tasks.length,
    ...(responsible ? { responsibleFor: responsible.get(a.id) } : {}),
    ...(hive ? { trust: Math.round((hive.get(a.id)?.trust ?? 0) * 100) / 100 } : {}),
  }));

  if (mode === "separate") notes.push("each agent was given every task and trained alone, so the team vote only adds redundancy");
  if (mode === "silent") notes.push("a part is scored by the agent that owns it; an agent's own score on all tasks is low by design, because it was never taught the other parts");
  notes.push("scores are the share of tasks answered exactly right from the answers the agents were taught: they show who can do the tasks, not that anyone can do a task nobody taught them");

  return { mode, tasks: tasks.length, agents: agentReports, teamScore: teamScores, teamRule, messages, missed, notes };
}
