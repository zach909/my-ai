/**
 * Turns evidence into a rating report.
 *
 * Evidence is one measurement against one dimension:
 *   { dimension, score, source, detail }
 *   score is a number in [0, 1], or null when the measurement could not be made (it then counts as ungraded).
 *
 * Rules (kept deliberately simple so they can be checked by reading):
 *   - Gate dimensions: any evidence scored below 1 on a gate fails the whole rating (verdict FAIL).
 *     Gate evidence must be binary, so a half-working thing is still a fail.
 *   - Each dimension's score is the mean of its evidence.
 *   - Overall is the weighted mean of the dimensions that were graded. Dimensions with no evidence are NOT
 *     counted as zero and NOT counted as passing: they are listed as ungraded, and the report says how many
 *     of the dimensions the overall number rests on.
 */

import { DIMENSIONS, dimension } from './dimensions.mjs';

export const STATUS_GOOD = 0.8;
export const STATUS_FAIR = 0.5;

export function statusOf(score) {
  if (score >= STATUS_GOOD) return 'good';
  if (score >= STATUS_FAIR) return 'fair';
  return 'poor';
}

/** Validate one evidence item and clamp it. Throws on malformed input rather than guessing. */
export function normaliseEvidence(e) {
  const d = dimension(e.dimension);
  if (e.score === null || e.score === undefined) {
    return { dimension: d.id, score: null, source: e.source ?? d.source, detail: e.detail ?? 'not measured' };
  }
  if (typeof e.score !== 'number' || Number.isNaN(e.score)) {
    throw new Error(`evidence for ${d.id} has a non-numeric score`);
  }
  const score = Math.min(1, Math.max(0, e.score));
  return { dimension: d.id, score, source: e.source ?? d.source, detail: String(e.detail ?? '') };
}

/**
 * @param {object[]} evidence
 * @param {{dimensions?: object[]}} [opts]
 * @returns {{verdict: 'FAIL'|'SCORED'|'UNGRADED', overall: number|null, gatesFailed: string[],
 *            dimensions: Record<string, object>, coverage: {graded: number, total: number}}}
 */
export function scoreReport(evidence, { dimensions = DIMENSIONS } = {}) {
  const items = evidence.map(normaliseEvidence);
  const out = {};

  for (const d of dimensions) {
    const mine = items.filter((e) => e.dimension === d.id);
    const graded = mine.filter((e) => e.score !== null);
    if (graded.length === 0) {
      out[d.id] = { status: 'ungraded', score: null, weight: d.weight, gate: d.gate, n: 0, details: mine.map((e) => e.detail) };
      continue;
    }
    const score = graded.reduce((s, e) => s + e.score, 0) / graded.length;
    const gateFailed = d.gate && graded.some((e) => e.score < 1);
    out[d.id] = {
      status: gateFailed ? 'fail' : statusOf(score),
      score,
      weight: d.weight,
      gate: d.gate,
      n: graded.length,
      details: graded.map((e) => e.detail).filter(Boolean),
    };
  }

  const gatesFailed = dimensions.filter((d) => d.gate && out[d.id].status === 'fail').map((d) => d.id);
  const gatesUngraded = dimensions.filter((d) => d.gate && out[d.id].score === null).map((d) => d.id);
  const graded = dimensions.filter((d) => out[d.id].score !== null);
  const coverage = { graded: graded.length, total: dimensions.length };

  if (gatesFailed.length) {
    return { verdict: 'FAIL', overall: null, gatesFailed, gatesUngraded, dimensions: out, coverage };
  }
  if (graded.length === 0) {
    return { verdict: 'UNGRADED', overall: null, gatesFailed: [], gatesUngraded, dimensions: out, coverage };
  }
  const wsum = graded.reduce((s, d) => s + d.weight, 0);
  const overall = graded.reduce((s, d) => s + out[d.id].score * d.weight, 0) / wsum;
  // An ungraded gate is not a pass. Say so, and do not let the number read as a finished rating.
  if (gatesUngraded.length) {
    return { verdict: 'INCOMPLETE', overall, gatesFailed: [], gatesUngraded, dimensions: out, coverage };
  }
  return { verdict: 'SCORED', overall, gatesFailed: [], gatesUngraded, dimensions: out, coverage };
}
