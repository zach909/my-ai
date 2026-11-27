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
