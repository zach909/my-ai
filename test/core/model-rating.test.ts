import { describe, it, expect } from 'vitest';
import {
  complexityBits,
  rateModel,
  transparencyScore,
  INSPECTABILITY_WEIGHT,
} from '../../models && skills/core/model-rating';

describe('model rating', () => {
  it('counts complexity in bits: count * log2(statesEach), summed over groups', () => {
    const { total, breakdown } = complexityBits([
      { name: 'weights', count: 10, statesEach: 256 }, // 80 bits
      { name: 'switches', count: 4, statesEach: 2 }, // 4 bits
    ]);
    expect(total).toBeCloseTo(84, 10);
    expect(breakdown[0]).toEqual({ name: 'weights', bits: 80 });
  });

  it('gives a one-state group zero bits', () => {
    expect(complexityBits([{ name: 'fixed', count: 1000, statesEach: 1 }]).total).toBe(0);
  });

  it('rejects invalid groups', () => {
    expect(() => complexityBits([{ name: 'bad', count: -1, statesEach: 2 }])).toThrow(RangeError);
    expect(() => complexityBits([{ name: 'bad', count: 1, statesEach: 0 }])).toThrow(RangeError);
    expect(() => complexityBits([{ name: 'bad', count: NaN, statesEach: 2 }])).toThrow(RangeError);
  });

  it('computes transparency as a weighted mix of inspectability and provenance', () => {
    const t = transparencyScore({
      inspectableUnits: 50,
      totalUnits: 100,
      decisionsWithProvenance: 80,
      totalDecisions: 100,
    });
    expect(t.inspectability).toBeCloseTo(0.5, 10);
    expect(t.provenance).toBeCloseTo(0.8, 10);
    expect(t.transparency).toBeCloseTo(INSPECTABILITY_WEIGHT * 0.5 + (1 - INSPECTABILITY_WEIGHT) * 0.8, 10);
  });

  it('uses the one available measure alone when the other has no data', () => {
    const t = transparencyScore({
      inspectableUnits: 0,
      totalUnits: 0,
      decisionsWithProvenance: 3,
      totalDecisions: 4,
    });
    expect(t.inspectability).toBeNull();
    expect(t.transparency).toBeCloseTo(0.75, 10);
  });

  it('returns null transparency when there is no evidence at all', () => {
    const t = transparencyScore({ inspectableUnits: 0, totalUnits: 0, decisionsWithProvenance: 0, totalDecisions: 0 });
    expect(t.transparency).toBeNull();
  });

  it('rejects a part larger than its whole', () => {
    expect(() =>
      transparencyScore({ inspectableUnits: 5, totalUnits: 4, decisionsWithProvenance: 0, totalDecisions: 0 }),
    ).toThrow(RangeError);
  });

  it('rates a model: complexity over power, and transparency', () => {
    const r = rateModel({
      groups: [{ name: 'weights', count: 10, statesEach: 256 }],
      power: 0.5,
      transparency: { inspectableUnits: 10, totalUnits: 10, decisionsWithProvenance: 0, totalDecisions: 10 },
    });
    expect(r.complexityBits).toBeCloseTo(80, 10);
    expect(r.complexityOverPower).toBeCloseTo(160, 10);
    expect(r.transparency).toBeCloseTo(INSPECTABILITY_WEIGHT * 1 + 0, 10);
  });

  it('leaves complexity over power undefined when power is zero', () => {
    const r = rateModel({
      groups: [{ name: 'weights', count: 1, statesEach: 2 }],
      power: 0,
      transparency: { inspectableUnits: 0, totalUnits: 0, decisionsWithProvenance: 0, totalDecisions: 0 },
    });
    expect(r.complexityOverPower).toBeNull();
  });

  it('rejects power outside [0, 1]', () => {
    const base = {
      groups: [],
      transparency: { inspectableUnits: 0, totalUnits: 0, decisionsWithProvenance: 0, totalDecisions: 0 },
    };
    expect(() => rateModel({ ...base, power: 1.2 })).toThrow(RangeError);
    expect(() => rateModel({ ...base, power: -0.1 })).toThrow(RangeError);
  });
});

import { rateFromMetrics, ratingJudge, RATING_KEYS } from '../../models && skills/core/model-rating';
import { ImprovementLoop } from '../../models && skills/core/improvement-loop';

const seed = (over: Record<string, number>) => ({
  [RATING_KEYS.complexityBits]: 1000,
  [RATING_KEYS.power]: 0.8,
  [RATING_KEYS.inspectableUnits]: 10,
  [RATING_KEYS.totalUnits]: 10,
  [RATING_KEYS.decisionsWithProvenance]: 5,
  [RATING_KEYS.totalDecisions]: 5,
  ...over,
});

describe('rating from reported metrics', () => {
  it('reads complexity bits and power back exactly', () => {
    const r = rateFromMetrics(seed({}));
    expect(r.complexityBits).toBeCloseTo(1000, 10);
    expect(r.power).toBe(0.8);
    expect(r.complexityOverPower).toBeCloseTo(1250, 10);
  });

  it('treats missing transparency keys as no evidence, not as full transparency', () => {
    const r = rateFromMetrics({ power: 0.5, complexityBits: 10 });
    expect(r.transparency).toBeNull();
  });
});

describe('ratingJudge', () => {
  const judge = ratingJudge({ minTransparencyDelta: 0 });

  it('passes a candidate with the same transparency', () => {
    expect(judge([seed({})], [seed({})])).toEqual([]);
  });

  it('rejects a candidate that loses transparency on average', () => {
    const reasons = judge(
      [seed({ [RATING_KEYS.inspectableUnits]: 2 })],
      [seed({})],
    );
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/transparency changed/);
  });

  it('rejects a candidate with no transparency evidence at all', () => {
    const reasons = judge([{ power: 0.9 }], [seed({})]);
    expect(reasons[0]).toMatch(/no transparency evidence/);
  });

  it('enforces an explicit complexity cap only when one is set', () => {
    expect(judge([seed({ [RATING_KEYS.complexityBits]: 5000 })], [seed({})])).toEqual([]);
    const capped = ratingJudge({ minTransparencyDelta: 0, maxComplexityBits: 2000 });
    expect(capped([seed({ [RATING_KEYS.complexityBits]: 5000 })], [seed({})])[0]).toMatch(/exceeds the cap/);
  });
});

describe('ImprovementLoop with the rating judge', () => {
  const evaluator = {
    fingerprint: () => 'rating-test',
    primary: 'score',
    guards: [],
    seeds: [1, 2],
    evaluate: (config: Record<string, unknown>) => {
      const k = Number(config.k ?? 1);
      return seed({
        score: k === 2 ? 0.9 : 0.5,
        [RATING_KEYS.power]: k === 2 ? 0.9 : 0.5,
        [RATING_KEYS.inspectableUnits]: k === 3 ? 1 : 10,
      });
    },
  };

  it('promotes a gain that keeps transparency, and rejects one that loses it', () => {
    const loop = new ImprovementLoop({
      evaluator,
      baseline: { k: 1 },
      minGain: 0.01,
      judge: ratingJudge({ minTransparencyDelta: 0 }),
    });
    expect(loop.consider({ id: 'gain', description: '', changes: { k: 2 } }).verdict).toBe('accepted');
    const opaque = loop.consider({ id: 'opaque', description: '', changes: { k: 3 } });
    expect(opaque.verdict).toBe('rejected');
    expect(opaque.reasons.join(' ')).toMatch(/transparency/);
  });
});
