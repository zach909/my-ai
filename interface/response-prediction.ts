/**
 * The prediction folder: every reply has to carry a guess at the user's next message, and the guess is scored when it arrives.
 *
 *   prediction/next-message.md   the guess, in the user's voice, as it would be typed
 *   prediction/prediction.json   the record: id, the guess, where it came from, and `status`
 *   prediction/outcome.json      only once the real next message is known: what it was, how close the guess was, how surprised
 *
 * FORCED. A zip is never made without a prediction. If no guess was given (the mesh had none yet), the record says
 * `source: "none"` and the guess is empty; an empty guess is still scored like any other, and is simply maximally surprising,
 * which is the same standard continuous-learning.ts holds itself to. Nothing is invented to fill the gap.
 *
 * SCORED, NOT FAKED. The score is the project's own measure (tokenSimilarity in prediction-engine.ts, the one
 * continuous-learning.ts already uses), plus an exact match. `surprise` = 1 - similarity is the learning signal.
 *
 * WHAT THIS DOES AND DOES NOT DO. It makes the predict-first, compare-after loop explicit and keeps its record in the zip
 * itself (like the edits, no server state). It does not by itself change the mesh's weights: the live ContinuousLearner is
 * built without a NextMessagePredictor (src/index.ts), so today the comparison is a reported number. Training the mesh on
 * these scores means wiring that predictor in (models && skills/core/next-message.ts, measured by
 * benchmarks/next_message.mjs), which is a separate, deliberate change to the live runtime.
 *
 * The record is rebuilt field by field from whatever comes in, so nothing but the known fields can ride along.
 */

import { createHash } from "node:crypto";
import { tokenSimilarity } from "../models && skills/core/prediction-engine.js";

export const MAX_PREDICTION_CHARS = 2000;

export type PredictionSource = "mesh" | "caller" | "none";

export interface PredictionOutcome {
  /** The message that really came next, cut to MAX_PREDICTION_CHARS. */
  actual: string;
  /** 0..1 token overlap between the guess and the real message. */
  similarity: number;
  /** 1 - similarity: the learning signal. */
  surprise: number;
  /** The guess equals the real message, ignoring surrounding space. */
  exact: boolean;
}

export interface PredictionRecord {
  /** Same reply and same guess give the same id. */
  id: string;
  /** What the agent expects the user to say next. May be empty. */
  predicted: string;
  source: PredictionSource;
  madeAt: string;
  status: "open" | "scored";
  outcome?: PredictionOutcome;
}

const clip = (s: string): string => (s.length > MAX_PREDICTION_CHARS ? s.slice(0, MAX_PREDICTION_CHARS) : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function predictionId(reply: string, predicted: string): string {
  return createHash("sha256").update(reply).update("\n").update(predicted).digest("hex").slice(0, 16);
}

/** How close a guess was to what came. Pure. */
export function scoreGuess(predicted: string, actual: string): PredictionOutcome {
  const a = clip(actual);
  const similarity = tokenSimilarity(predicted, a);
  return { actual: a, similarity, surprise: 1 - similarity, exact: predicted.trim() !== "" && predicted.trim() === a.trim() };
}

/**
 * The record for this reply. `raw` is what the caller has: a string (the guess), an earlier record (kept, including its
 * outcome if it has one), or nothing, which gives an empty guess with `source: "none"`.
 */
export function resolvePrediction(raw: unknown, reply: string, now = new Date()): PredictionRecord {
  if (isObj(raw) && typeof raw.predicted === "string") {
    const predicted = clip(raw.predicted);
    const source: PredictionSource = raw.source === "mesh" || raw.source === "none" ? raw.source : "caller";
    const rec: PredictionRecord = {
      id: predictionId(reply, predicted),
      predicted,
      source: predicted === "" && source === "caller" ? "none" : source,
      madeAt: typeof raw.madeAt === "string" && !Number.isNaN(Date.parse(raw.madeAt)) ? new Date(raw.madeAt).toISOString() : now.toISOString(),
      status: "open",
    };
    const o = raw.outcome;
    if (isObj(o) && typeof o.actual === "string") {
      // A stored outcome is recomputed from the two texts, never trusted: a score that was edited in the file is dropped.
      rec.outcome = scoreGuess(predicted, o.actual);
      rec.status = "scored";
    }
    return rec;
  }
  const predicted = typeof raw === "string" ? clip(raw) : "";
  return { id: predictionId(reply, predicted), predicted, source: predicted === "" ? "none" : "caller", madeAt: now.toISOString(), status: "open" };
}

/** Score the record against the message that really came next. A record already scored keeps its first outcome: one guess, one score. */
export function scorePrediction(rec: PredictionRecord, actual: string): PredictionRecord {
  if (rec.status === "scored" && rec.outcome) return rec;
  return { ...rec, status: "scored", outcome: scoreGuess(rec.predicted, actual) };
}

/** The files of the prediction folder. */
export function predictionFiles(rec: PredictionRecord): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [
    { name: "prediction/next-message.md", body: rec.predicted ? rec.predicted + "\n" : "(no guess: the mesh had not predicted anything yet)\n" },
    { name: "prediction/prediction.json", body: JSON.stringify({ ...rec, outcome: undefined }, null, 2) + "\n" },
  ];
  if (rec.outcome) out.push({ name: "prediction/outcome.json", body: JSON.stringify({ id: rec.id, ...rec.outcome }, null, 2) + "\n" });
  return out;
}
