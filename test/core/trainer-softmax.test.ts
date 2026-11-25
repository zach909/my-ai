/**
 * Tests for the shared output-layer math in trainer.ts: stable softmax,
 * floored cross-entropy and gradient-norm clipping. Both training loops
 * (dense and elastic-core) use these, so they must behave identically.
 */
import { describe, it, expect } from 'vitest';
import { stableSoftmax, crossEntropyLoss, gradClipScale } from '../../models && skills/trainer.js';

const sum = (a: ArrayLike<number>) => Array.from(a as ArrayLike<number> & Iterable<number>).reduce((s, v) => s + v, 0);

describe('stableSoftmax', () => {
  it('matches the textbook definition and sums to 1', () => {
    const p = stableSoftmax([1, 2, 3]);
    const e = [Math.exp(1), Math.exp(2), Math.exp(3)];
    const s = e[0]! + e[1]! + e[2]!;
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(e[i]! / s, 5);
    expect(sum(p)).toBeCloseTo(1, 5);
  });

  it('does not overflow on huge logits', () => {
    const p = stableSoftmax([1000, 1001, 999]);
    expect(Array.from(p).every(Number.isFinite)).toBe(true);
    expect(sum(p)).toBeCloseTo(1, 5);
    expect(p[1]!).toBeGreaterThan(p[0]!);
  });

  it('is shift-invariant', () => {
    const a = stableSoftmax([0.1, 0.5, -0.3]);
    const b = stableSoftmax([100.1, 100.5, 99.7]);
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 4);
  });

  it('treats NaN and Infinity logits as near-zero probability', () => {
    const p = stableSoftmax([2, NaN, Infinity, -Infinity]);
    expect(Array.from(p).every(Number.isFinite)).toBe(true);
    expect(sum(p)).toBeCloseTo(1, 5);
    expect(p[0]!).toBeGreaterThan(0.99);
  });

  it('falls back to uniform when every logit is non-finite', () => {
    const p = stableSoftmax([NaN, NaN, NaN, NaN]);
    for (const v of p) expect(v).toBeCloseTo(0.25, 6);
  });

  it('handles an empty vector and reuses a provided buffer', () => {
    expect(stableSoftmax([]).length).toBe(0);
    const buf = new Float32Array(2);
    expect(stableSoftmax([0, 0], buf)).toBe(buf);
    expect(buf[0]).toBeCloseTo(0.5, 6);
  });
});

describe('crossEntropyLoss', () => {
  it('is -ln(p) for the target class', () => {
    expect(crossEntropyLoss([0.25, 0.75], 1)).toBeCloseTo(-Math.log(0.75), 6);
  });

  it('floors a zero or non-finite probability instead of returning Infinity', () => {
    const floor = -Math.log(1e-10);
    expect(crossEntropyLoss([0, 1], 0)).toBeCloseTo(floor, 6);
    expect(crossEntropyLoss([NaN, 1], 0)).toBeCloseTo(floor, 6);
  });
});

describe('gradClipScale', () => {
  it('leaves small gradients alone', () => {
    expect(gradClipScale([3, 4])).toBe(1);
  });

  it('shrinks a large gradient to the max norm', () => {
    const g = [30, 40]; // norm 50
    const s = gradClipScale(g, 10);
    expect(s).toBeCloseTo(0.2, 6);
    expect(Math.hypot(g[0]! * s, g[1]! * s)).toBeCloseTo(10, 6);
  });
});
