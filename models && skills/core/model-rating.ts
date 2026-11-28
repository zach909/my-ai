/**
 * Model rating: two numbers for judging a model (and later its recursive
 * self-improvement).
 *
 *  - Complexity: how many distinct ways the model can be placed under its
 *    rules, counted in bits (log2 of the number of reachable configurations).
 *    Each group of mutable units contributes count * log2(statesEach).
 *  - Power: task performance in [0, 1], measured on a fixed evaluation set.
 *  - Complexity over power: complexityBits / power. A ratio, not a score to
 *    maximise: it says how much room the model has per unit of performance.
 *  - Transparency: in [0, 1], how much of the model can be inspected and how
 *    much of its decisions carry a logged reason. Complexity's enemy.
 *
 * Pure functions, no I/O, no third-party code. Inputs are plain numbers that
 * the caller measures; this module only does the arithmetic and validation.
 */

/** A group of mutable units that can each take `statesEach` distinct values. */
export interface MutableUnitGroup {
  /** Human-readable name, e.g. "synaptic weights", "thresholds", "wiring". */
  name: string;
  /** How many units of this kind the model has. */
  count: number;
  /** Distinct values one unit can take (2 = binary, 256 = 8-bit, ...). */
  statesEach: number;
}

export interface TransparencyEvidence {
  /** Units whose state can be read and explained. */
  inspectableUnits: number;
  /** All units. */
  totalUnits: number;
  /** Decisions that carry a logged reason (provenance). */
  decisionsWithProvenance: number;
  /** All decisions made. */
  totalDecisions: number;
}

export interface ModelRatingInput {
  groups: MutableUnitGroup[];
  /** Task performance in [0, 1] on the fixed evaluation set. */
  power: number;
  transparency: TransparencyEvidence;
}

export interface ModelRating {
  complexityBits: number;
  power: number;
  /** complexityBits / power. Null when power is 0 (the ratio is undefined). */
  complexityOverPower: number | null;
  /** Share of inspectable units, in [0, 1]. Null when there are no units. */
  inspectability: number | null;
  /** Share of decisions with logged provenance, in [0, 1]. Null when no decisions. */
  provenance: number | null;
  /** Weighted transparency in [0, 1]. Null when neither measure is available. */
  transparency: number | null;
  /** Per-group contribution to complexityBits, largest first. */
  breakdown: Array<{ name: string; bits: number }>;
}

/** Weight of inspectability inside transparency; provenance gets the rest. */
export const INSPECTABILITY_WEIGHT = 0.5;

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number >= 0 (got ${value})`);
  }
}

function share(part: number, whole: number, label: string): number | null {
  assertFiniteNonNegative(part, `${label} (part)`);
  assertFiniteNonNegative(whole, `${label} (whole)`);
  if (whole === 0) return null;
  if (part > whole) throw new RangeError(`${label}: part (${part}) exceeds whole (${whole})`);
  return part / whole;
}

export function complexityBits(groups: MutableUnitGroup[]): {
  total: number;
  breakdown: Array<{ name: string; bits: number }>;
} {
  const breakdown = groups.map(g => {
    assertFiniteNonNegative(g.count, `group "${g.name}" count`);
    if (!Number.isFinite(g.statesEach) || g.statesEach < 1) {
      throw new RangeError(`group "${g.name}" statesEach must be >= 1 (got ${g.statesEach})`);
    }
    // A group of one-state units holds no choice, so it adds zero bits.
    const bits = g.count * Math.log2(g.statesEach);
    return { name: g.name, bits };
  });
  const total = breakdown.reduce((sum, b) => sum + b.bits, 0);
  breakdown.sort((a, b) => b.bits - a.bits);
  return { total, breakdown };
}

export function transparencyScore(
  evidence: TransparencyEvidence,
): { transparency: number | null; inspectability: number | null; provenance: number | null } {
  const inspectability = share(evidence.inspectableUnits, evidence.totalUnits, 'inspectable units');
  const provenance = share(
    evidence.decisionsWithProvenance,
    evidence.totalDecisions,
    'decisions with provenance',
  );
  if (inspectability === null && provenance === null) {
    return { transparency: null, inspectability, provenance };
  }
  // If one measure has no data yet, the other stands alone rather than being
  // averaged with an implied zero or one.
  let transparency: number;
  if (inspectability !== null && provenance !== null) {
    transparency = INSPECTABILITY_WEIGHT * inspectability + (1 - INSPECTABILITY_WEIGHT) * provenance;
  } else {
    transparency = (inspectability ?? provenance) as number;
  }
  return { transparency, inspectability, provenance };
}

export function rateModel(input: ModelRatingInput): ModelRating {
  if (!Number.isFinite(input.power) || input.power < 0 || input.power > 1) {
    throw new RangeError(`power must be in [0, 1] (got ${input.power})`);
  }
  const { total, breakdown } = complexityBits(input.groups);
  const { transparency, inspectability, provenance } = transparencyScore(input.transparency);
  return {
    complexityBits: total,
    power: input.power,
    complexityOverPower: input.power === 0 ? null : total / input.power,
    inspectability,
    provenance,
    transparency,
    breakdown,
  };
}

/** Metric keys a component reports so the loop can rate it. Missing keys mean no evidence. */
export const RATING_KEYS = {
  complexityBits: "complexityBits",
  power: "power",
  inspectableUnits: "inspectableUnits",
  totalUnits: "totalUnits",
  decisionsWithProvenance: "decisionsWithProvenance",
  totalDecisions: "totalDecisions",
} as const;

/** Builds a rating from one seed's metrics. Missing or invalid keys fall back to "no evidence" (null transparency). */
export function rateFromMetrics(metrics: Record<string, number>): ModelRating {
  const g = (k: string): number => (typeof metrics[k] === "number" ? metrics[k] : 0);
  const power = Math.min(1, Math.max(0, g(RATING_KEYS.power)));
  // The component reports its complexity already in bits: one binary group of that many units gives exactly those bits.
  const bits = Math.max(0, g(RATING_KEYS.complexityBits));
  return rateModel({
    groups: [{ name: "reported", count: bits, statesEach: 2 }],
    power,
    transparency: {
      inspectableUnits: g(RATING_KEYS.inspectableUnits),
      totalUnits: g(RATING_KEYS.totalUnits),
      decisionsWithProvenance: g(RATING_KEYS.decisionsWithProvenance),
      totalDecisions: g(RATING_KEYS.totalDecisions),
    },
  });
}

export interface RatingJudgeOptions {
  /** Smallest mean change in transparency allowed. 0 means "no loss". */
  minTransparencyDelta: number;
  /** Optional cap on the candidate's complexity in bits. Omit to record complexity without gating it. */
  maxComplexityBits?: number;
}

/**
 * A judge for ImprovementLoop: rejects a candidate that makes the model less transparent
 * (per seed, on average), that reports no transparency evidence at all, or that exceeds an
 * explicit complexity cap. Returns reasons; an empty list means the rating passes.
 */
export function ratingJudge(opts: RatingJudgeOptions): (candidate: Record<string, number>[], baseline: Record<string, number>[]) => string[] {
  return (candidate, baseline) => {
    const reasons: string[] = [];
    if (candidate.length === 0 || candidate.length !== baseline.length) {
      return ["rating: candidate and baseline have no matching seeds to compare"];
    }
    const cRatings = candidate.map(rateFromMetrics);
    const bRatings = baseline.map(rateFromMetrics);
    if (cRatings.some((r) => r.transparency === null)) {
      reasons.push("rating: no transparency evidence from the candidate, so it cannot be judged transparent");
      return reasons;
    }
    const deltas = cRatings.map((r, i) => (r.transparency as number) - (bRatings[i].transparency ?? 0));
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (meanDelta < opts.minTransparencyDelta) {
      reasons.push(`rating: transparency changed by ${meanDelta.toFixed(4)} (minimum ${opts.minTransparencyDelta})`);
    }
    if (opts.maxComplexityBits !== undefined) {
      const worst = Math.max(...cRatings.map((r) => r.complexityBits));
      if (worst > opts.maxComplexityBits) {
        reasons.push(`rating: complexity ${worst.toFixed(1)} bits exceeds the cap of ${opts.maxComplexityBits}`);
      }
    }
    return reasons;
  };
}
