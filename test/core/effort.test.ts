import { describe, it, expect } from 'vitest';
import { parseEffort, planEffort, effortText, EFFORT_DEFAULT, EFFORT_TEXT_MAX, EFFORT_MAX_CHECKS } from '../../models && skills/core/effort.js';
import { ZIP_FOLDERS } from '../../models && skills/core/zip-halt.js';

describe('effort (how hard the AI tries)', () => {
  it('reads a dial value and ignores anything else', () => {
    expect(parseEffort(30)).toBe(30);
    expect(parseEffort('80')).toBe(80);
    expect(parseEffort(-5)).toBe(0);
    expect(parseEffort(250)).toBe(100);
    for (const bad of [undefined, null, '', 'high', NaN, Infinity, true, {}, []]) expect(parseEffort(bad)).toBeNull();
  });

  it('checks more as effort rises and tries another way only at the top', () => {
    const checks = [0, 14, 15, 50, 70, 100].map(v => planEffort(v).checks);
    expect(checks[0]).toBe(0);
    for (let i = 1; i < checks.length; i++) expect(checks[i]).toBeGreaterThanOrEqual(checks[i - 1]);
    expect(planEffort(100).checks).toBe(EFFORT_MAX_CHECKS);
    expect(planEffort(89).tryAnother).toBe(false);
    expect(planEffort(90).tryAnother).toBe(true);
    expect(planEffort(undefined).level).toBe(EFFORT_DEFAULT);
  });

  it('sends nothing when unset or at the default', () => {
    expect(effortText(undefined)).toBeNull();
    expect(effortText('junk')).toBeNull();
    expect(effortText(EFFORT_DEFAULT)).toBeNull();
  });

  it('says to stop early when low, check when high, and try another way at the top', () => {
    expect(effortText(5)).toMatch(/first answer that works/);
    expect(effortText(80)).toMatch(/Check your answer \d times? before/);
    expect(effortText(95)).toMatch(/second way/);
    for (let v = 0; v <= 100; v++) { const t = effortText(v); if (t) expect(t.length).toBeLessThanOrEqual(EFFORT_TEXT_MAX); }
  });

  it('has its own folder, distinct from every other', () => {
    expect(ZIP_FOLDERS.effort).toBe('effort/');
    expect(Object.values(ZIP_FOLDERS)).toHaveLength(new Set(Object.values(ZIP_FOLDERS)).size);
  });
});
