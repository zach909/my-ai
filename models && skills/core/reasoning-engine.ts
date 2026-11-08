/**
 * Answering a problem (ASI §2 / §8).
 *
 * This used to be a fixed pipeline: understand, fix the objective, gather
 * information, list what is missing, search for it, try a creative
 * combination, generate three or four candidate approaches, score them,
 * decompose the winner, delegate each piece, detect mistakes, revise, verify.
 * Every message went through every stage in that order, whether it needed to
 * or not.
 *
 * That is gone on purpose. How to reason is something the network should
 * LEARN from training, not something the code forces on it. The old stages
 * are written up as training ideas in `train.md` at the repo root (what each
 * one was for, and how it could be taught as a skill instead of enforced).
 *
 * What is left is deliberately small: look up what memory already holds for
 * the problem, and hand the problem to the solver (in the running system, the
 * Hive Mind and then the neural runner). No stages, no scoring, no chosen
 * "strategy". Whatever structure the answer has comes from the network.
 *
 * `ReasoningResult` keeps its old fields so callers (the critic, solve()'s
 * bookkeeping, the tests) keep working; the ones that described stages are
 * empty or neutral now.
 */

export type SubSolver = (subproblem: string, depth: number) => Promise<string> | string;

export interface ReasoningDeps {
  /** Available information for the problem (e.g. long-term memory recall). */
  recall?: (query: string) => string[];
  /** Solve the problem via a specialized system (hive/runner). */
  solveSub?: SubSolver;
}

export interface ReasoningStep { kind: string; detail: string; }
export interface Approach { strategy: string; description: string; score: number; }
export interface Subresult { subproblem: string; result: string; }

export interface ReasoningResult {
  problem: string;
  /** The problem itself; no objective is derived any more. */
  objective: string;
  /** What memory held for the problem. */
  available: string[];
  /** Always empty: gaps are no longer enumerated by a forced stage. */
  missing: string[];
  /** Always empty (no forced search stage). */
  soughtAndResolved: string[];
  /** Never set (no forced creative-combination stage). */
  creativeCombination?: { name: string; definition: string };
  /** Always empty (no forced revision stage). */
  revised: string[];
  /** Always empty: no candidate approaches are generated or scored. */
  approaches: Approach[];
  /** Always "direct": the problem goes straight to the solver. */
  chosen: string;
  /** Just the problem. */
  subproblems: string[];
  /** One entry: the problem and what the solver returned. */
  subresults: Subresult[];
  result: string;
  /** True when the solver produced a non-empty answer that is not an error marker. */
  verified: boolean;
  confidence: number;
  /** Always empty (no forced mistake-lookup stage). */
  lessons: string[];
  /** Always empty (no forced consequence-prediction stage). */
  assumptions: string[];
  trace: ReasoningStep[];
}

export interface ReasonOptions {
  depth?: number;
}

export class ReasoningEngine {
  constructor(private deps: ReasoningDeps = {}) {}

  async reason(problem: string, _opts: ReasonOptions = {}): Promise<ReasoningResult> {
    const available = (this.deps.recall?.(problem) ?? []).slice(0, 8);

    // Recalled content is the answer when there is any; otherwise the solver
    // answers. Nothing else happens between the question and the answer.
    const generated = this.deps.solveSub ? String(await this.deps.solveSub(problem, 0)) : "";
    const result = available.length > 0 ? available[0] : generated;

    const failed = !result || /\[(error|unsolved|base):/i.test(result);
    const verified = !failed;
    const confidence = clamp01(0.4 + (verified ? 0.25 : 0) + (available.length > 0 ? 0.1 : 0));

    return {
      problem,
      objective: problem,
      available,
      missing: [],
      soughtAndResolved: [],
      revised: [],
      approaches: [],
      chosen: "direct",
      subproblems: [problem],
      subresults: [{ subproblem: problem, result: generated || result }],
      result,
      verified,
      confidence,
      lessons: [],
      assumptions: [],
      trace: [{ kind: "answer", detail: available.length > 0 ? `${available.length} recalled item(s)` : "solver" }],
    };
  }
}

/**
 * Split a goal on connectives ("and", "then", commas). Not used by the
 * reasoner any more; kept because the agent loop offers it to prompting skills
 * as a tool they may choose to call (`agent-capabilities.ts`).
 */
export function decompose(problem: string, maxSub: number): string[] {
  const parts = problem
    .split(/\b(?:and then|then|and|;|,|\band\b)\b|\bfollowed by\b/gi)
    .map(p => p.trim())
    .filter(p => p.length > 2);
  const unique = Array.from(new Set(parts));
  if (unique.length >= 2) return unique.slice(0, maxSub);
  const base = problem.trim();
  return [`analyze: ${base}`, `solve: ${base}`];
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
