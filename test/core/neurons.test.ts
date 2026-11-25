import { describe, it, expect } from 'vitest';
import { parseNeurons, planNeurons, neuronsText, NEURONS_DEFAULT, NEURONS_TEXT_MAX } from '../../models && skills/core/neurons.js';
import { ZIP_FOLDERS } from '../../models && skills/core/zip-halt.js';

describe('neurons (how confident the AI acts)', () => {
  it('reads a dial value from a request and ignores anything else', () => {
    expect(parseNeurons(30)).toBe(30);
    expect(parseNeurons('80')).toBe(80);
    expect(parseNeurons(-5)).toBe(0);
    expect(parseNeurons(250)).toBe(100);
    expect(parseNeurons(42.6)).toBe(43);
    for (const bad of [undefined, null, '', 'high', NaN, Infinity, true, {}, []]) expect(parseNeurons(bad)).toBeNull();
  });

  it('asks fewer questions as confidence rises, none from 75, and does both only at the top', () => {
    const q = [0, 20, 40, 60, 74, 75, 100].map(v => planNeurons(v).questions);
    expect(q[0]).toBe(5);
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeLessThanOrEqual(q[i - 1]);
    expect(planNeurons(75).questions).toBe(0);
    expect(planNeurons(89).both).toBe(false);
    expect(planNeurons(90).both).toBe(true);
    expect(planNeurons(100).mode).toBe('certain');
    expect(planNeurons(0).mode).toBe('unsure');
    expect(planNeurons(undefined).level).toBe(NEURONS_DEFAULT);
  });

  it('sends nothing when the dial is unset or at the default', () => {
    expect(neuronsText(undefined)).toBeNull();
    expect(neuronsText('junk')).toBeNull();
    expect(neuronsText(NEURONS_DEFAULT)).toBeNull();
  });

  it('says to ask when unsure, to assume when sure, and to do both when certain', () => {
    expect(neuronsText(0)).toMatch(/Ask up to 5 clarifying questions/);
    expect(neuronsText(70)).toMatch(/Ask up to 1 clarifying question before/);
    expect(neuronsText(80)).toMatch(/Do not ask\. Assume/);
    expect(neuronsText(95)).toMatch(/both ways/);
    for (let v = 0; v <= 100; v++) { const t = neuronsText(v); if (t) expect(t.length).toBeLessThanOrEqual(NEURONS_TEXT_MAX); }
  });

  it('has its own folder in the Zip Loop archive', () => {
    expect(ZIP_FOLDERS.neurons).toBe('neurons/');
    expect(Object.values(ZIP_FOLDERS)).toHaveLength(new Set(Object.values(ZIP_FOLDERS)).size);
  });
});
