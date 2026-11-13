/**
 * Image reader: stroke glyphs for every printable character, a pixel reader and a
 * lines-and-geometry reader, compared on the same balanced set.
 */
import { describe, it, expect } from 'vitest';
import { PRINTABLE, GLYPH_W, GLYPH_H, glyphStrokes, makeRng, renderGlyph } from '../../models && skills/core/stroke-glyphs';
import { compareReaders, geometryBytes, toGeometry } from '../../models && skills/core/image-reader';

const clean = { shift: 0, scale: 0, tilt: 0, width: [1.6, 1.6] as [number, number], speckle: 0 };

describe('stroke glyphs', () => {
  it('has a drawing for all 95 printable characters, and only the space is blank', () => {
    expect(PRINTABLE).toHaveLength(95);
    for (const c of PRINTABLE) {
      const ink = renderGlyph(c, makeRng(1), clean).reduce((n, v) => n + v, 0);
      if (c === ' ') expect(ink).toBe(0); else expect(ink, `ink for ${JSON.stringify(c)}`).toBeGreaterThan(0);
      expect(glyphStrokes(c).length > 0 || c === ' ').toBe(true);
    }
  });

  it('draws no two characters identically', () => {
    const seen = new Map<string, string>();
    for (const c of PRINTABLE) {
      const key = renderGlyph(c, makeRng(1), clean).join('');
      expect(seen.get(key), `${JSON.stringify(c)} looks like ${JSON.stringify(seen.get(key))}`).toBeUndefined();
      seen.set(key, c);
    }
  });

  it('renders the same picture from the same seed, and different ones from different seeds', () => {
    const a = renderGlyph('g', makeRng(7)), b = renderGlyph('g', makeRng(7)), c = renderGlyph('g', makeRng(8));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(a).toHaveLength(GLYPH_W * GLYPH_H);
  });
});

describe('geometry', () => {
  it('finds the holes, ends and crossings of a clean picture', () => {
    const geo = (c: string) => toGeometry(renderGlyph(c, makeRng(1), clean));
    expect(geo('O').holes).toBe(1);
    expect(geo('8').holes).toBe(2);
    expect(geo('I').holes).toBe(0);
    expect(geo('T').junctions.length).toBeGreaterThanOrEqual(1);
    expect(geo('L').endpoints.length).toBe(2);
    expect(geo(' ').bbox).toBeNull();
    expect(geo(' ').segments).toHaveLength(0);
  });

  it('gives bytes for the Zip Loop, the same every time', () => {
    const g = toGeometry(renderGlyph('K', makeRng(3), clean));
    const a = geometryBytes(g), b = geometryBytes(g);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a[4]).toBe(g.segments.length);
    expect(a).toHaveLength(5 + 4 * Math.min(40, g.segments.length));
  });
});

describe('comparing the two readers', () => {
  const cmp = compareReaders({ trainPerChar: 30, testPerChar: 10, seed: 1 });

  it('trains and tests on every character, the same number of each, not mostly dots', () => {
    expect(cmp.characters).toBe(95);
    expect(cmp.everyCharacterPresent).toBe(true);
    expect(cmp.inkShare.mean).toBeGreaterThan(0.1);
    for (const r of cmp.readers) expect(Object.keys(r.perChar)).toHaveLength(95);
  });

  it('reads far better than chance with either method, and the two agree on the easy ones', () => {
    const [pixel, geometry] = cmp.readers;
    expect(pixel.name).toBe('pixel grid');
    expect(geometry.name).toBe('lines and geometry');
    expect(pixel.macroAccuracy).toBeGreaterThan(0.75);
    expect(geometry.macroAccuracy).toBeGreaterThan(0.65);
    expect(cmp.agreement.rightWhenAgree).toBeGreaterThan(0.95);
  });
});
