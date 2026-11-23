/**
 * Stroke glyphs: every printable ASCII character drawn as lines, written for this project.
 *
 * A system font would be someone else's data, so each character is hand-drawn here as a few
 * strokes (straight runs of points) on a small grid, 4 wide and 8 tall:
 *
 *      y 0  top of capitals, digits and tall letters
 *      y 2  top of small letters
 *      y 6  the baseline
 *      y 8  bottom of letters that hang below the line (g j p q y)
 *
 * The strokes are the "lines and geometry" form of a character. `renderGlyph` turns them into
 * the raw-bit picture of the character (1 = ink) with a random shift, size, tilt, stroke width
 * and speckle, so the same character never looks exactly the same twice.
 *
 * Pure code: no imports, no fonts, no files.
 */

export const GLYPH_W = 16;
export const GLYPH_H = 20;

export type Point = [number, number];
export type Stroke = Point[];

/** Each entry: strokes separated by ";", points by spaces, a point is "x,y". "" is a blank character. */
const SOURCE: Record<string, string> = {
  // capitals
  A: "0,6 2,0 4,6; 1,3 3,3",
  B: "0,0 0,6; 0,0 3,0 4,1 4,2 3,3 0,3; 3,3 4,4 4,5 3,6 0,6",
  C: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5",
  D: "0,0 0,6; 0,0 2,0 4,2 4,4 2,6 0,6",
  E: "4,0 0,0 0,6 4,6; 0,3 3,3",
  F: "4,0 0,0 0,6; 0,3 3,3",
  G: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3",
  H: "0,0 0,6; 4,0 4,6; 0,3 4,3",
  I: "1,0 3,0; 2,0 2,6; 1,6 3,6",
  J: "4,0 4,5 3,6 1,6 0,5",
  K: "0,0 0,6; 4,0 0,3 4,6",
  L: "0,0 0,6 4,6",
  M: "0,6 0,0 2,3 4,0 4,6",
  N: "0,6 0,0 4,6 4,0",
  O: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0",
  P: "0,6 0,0 3,0 4,1 4,2 3,3 0,3",
  Q: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0; 2,4 4,6",
  R: "0,6 0,0 3,0 4,1 4,2 3,3 0,3; 2,3 4,6",
  S: "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5",
  T: "0,0 4,0; 2,0 2,6",
  U: "0,0 0,5 1,6 3,6 4,5 4,0",
  V: "0,0 2,6 4,0",
  W: "0,0 1,6 2,3 3,6 4,0",
  X: "0,0 4,6; 4,0 0,6",
  Y: "0,0 2,3 4,0; 2,3 2,6",
  Z: "0,0 4,0 0,6 4,6",
  // digits
  "0": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0; 1.5,4.5 2.5,1.5",
  "1": "1,1 2,0 2,6; 1,6 3,6",
  "2": "0,1 1,0 3,0 4,1 4,2 0,6 4,6",
  "3": "0,0 4,0 2,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5",
  "4": "3,6 3,0 0,4 4,4",
  "5": "4,0 0,0 0,3 3,3 4,4 4,5 3,6 1,6 0,5",
  "6": "3,0 1,0 0,2 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,4",
  "7": "0,0 4,0 1.5,6",
  "8": "1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0; 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3",
  "9": "4,2 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,4 3,6 1,6 0,5",
  // small letters
  a: "4,2 4,6; 4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  b: "0,0 0,6; 0,3 1,2 3,2 4,3 4,5 3,6 1,6 0,5",
  c: "4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  d: "4,0 4,6; 4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  e: "0,4 4,4 4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  f: "4,1 3,0 2,0 1,1 1,6; 0,2 3,2",
  g: "4,2 4,7 3,8 1,8 0,7; 4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  h: "0,0 0,6; 0,3 1,2 3,2 4,3 4,6",
  i: "2,2 2,6; 2,0 2,1",
  j: "3,2 3,7 2,8 1,8 0,7; 3,0 3,1",
  k: "0,0 0,6; 4,2 0,4.5 4,6",
  l: "1,0 2,0 2,5 3,6",
  m: "0,2 0,6; 0,3 1,2 2,3 2,6; 2,3 3,2 4,3 4,6",
  n: "0,2 0,6; 0,3 1,2 3,2 4,3 4,6",
  o: "1,2 3,2 4,3 4,5 3,6 1,6 0,5 0,3 1,2",
  p: "0,2 0,8; 0,3 1,2 3,2 4,3 4,5 3,6 1,6 0,5",
  q: "4,2 4,8; 4,3 3,2 1,2 0,3 0,5 1,6 3,6 4,5",
  r: "0,2 0,6; 0,3 1,2 3,2 4,3",
  s: "4,3 3,2 1,2 0,3 1,4 3,4 4,5 3,6 1,6 0,5",
  t: "1,0 1,5 2,6 4,6; 0,2 3,2",
  u: "0,2 0,5 1,6 3,6 4,5; 4,2 4,6",
  v: "0,2 2,6 4,2",
  w: "0,2 1,6 2,3 3,6 4,2",
  x: "0,2 4,6; 4,2 0,6",
  y: "0,2 2,6; 4,2 2,6 1,8 0,8",
  z: "0,2 4,2 0,6 4,6",
  // punctuation and symbols
  " ": "",
  "!": "2,0 2,4; 2,5.5 2,6",
  '"': "1,0 1,2; 3,0 3,2",
  "#": "1,0 1,6; 3,0 3,6; 0,2 4,2; 0,4 4,4",
  $: "4,1.5 3,1 1,1 0,2 1,3 3,3 4,4 3,5 1,5 0,4.5; 2,0 2,6",
  "%": "0,0 1,0 1,1 0,1 0,0; 4,5 3,5 3,6 4,6 4,5; 4,0 0,6",
  "&": "4,6 1,2 1,1 2,0 3,1 3,2 0,4 0,5 1,6 2,6 4,3",
  "'": "2,0 2,2",
  "(": "3,0 1,2 1,4 3,6",
  ")": "1,0 3,2 3,4 1,6",
  "*": "2,1 2,5; 0,2 4,4; 4,2 0,4",
  "+": "2,2 2,5; 0,3.5 4,3.5",
  ",": "2,5.5 2,6.5 1,7.5",
  "-": "0,4 4,4",
  ".": "2,5.5 2,6",
  "/": "4,0 0,6",
  ":": "2,2 2,3; 2,5 2,6",
  ";": "2,2 2,3; 2,5 2,6 1,7.5",
  "<": "4,1 0,3.5 4,6",
  "=": "0,2.5 4,2.5; 0,4.5 4,4.5",
  ">": "0,1 4,3.5 0,6",
  "?": "0,1 1,0 3,0 4,1 4,2 2,3.5 2,4.5; 2,5.5 2,6",
  "@": "4,5 4,2 3,1 1,1 0,2 0,4 1,5 3,5; 3,4 3,2.5 2,2.5 2,4 3,4 4,4",
  "[": "3,0 1,0 1,6 3,6",
  "\\": "0,0 4,6",
  "]": "1,0 3,0 3,6 1,6",
  "^": "0,2 2,0 4,2",
  _: "0,7 4,7",
  "`": "1,0 2,1",
  "{": "3,0 2,0 2,2 1,3 2,4 2,6 3,6",
  "|": "2,0 2,8",
  "}": "1,0 2,0 2,2 3,3 2,4 2,6 1,6",
  "~": "0,4 1,3 3,5 4,4",
};

/** All 95 printable ASCII characters, space first. */
export const PRINTABLE: string[] = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

const parsed = new Map<string, Stroke[]>();
export function glyphStrokes(ch: string): Stroke[] {
  const cached = parsed.get(ch);
  if (cached) return cached;
  const src = SOURCE[ch];
  if (src === undefined) throw new Error(`No glyph drawn for ${JSON.stringify(ch)}.`);
  const strokes = src.split(";").map((s) => s.trim()).filter(Boolean).map((s) =>
    s.split(/\s+/).map((p) => p.split(",").map(Number) as Point));
  parsed.set(ch, strokes);
  return strokes;
}

/** A small seeded random generator (xorshift32), so pictures can be reproduced from a seed. */
export function makeRng(seed: number): () => number {
  let x = (seed | 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

export interface RenderOptions {
  /** Largest random shift in pixels (each way). Default 1. */
  shift?: number;
  /** Largest random size change as a fraction. Default 0.08. */
  scale?: number;
  /** Largest random tilt in degrees. Default 5. */
  tilt?: number;
  /** Stroke width range in pixels. Default [1.3, 1.9]. */
  width?: [number, number];
  /** Chance that any single pixel is flipped afterwards. Default 0.015. */
  speckle?: number;
}

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** The strokes of a character after the random shift / size / tilt, in picture pixels. */
export function placedStrokes(ch: string, rng: () => number, opts: RenderOptions = {}): Stroke[] {
  const shift = opts.shift ?? 1, scale = opts.scale ?? 0.08, tilt = ((opts.tilt ?? 5) * Math.PI) / 180;
  const s = 1 + (rng() * 2 - 1) * scale;
  const a = (rng() * 2 - 1) * tilt;
  const dx = (rng() * 2 - 1) * shift, dy = (rng() * 2 - 1) * shift;
  const cos = Math.cos(a), sin = Math.sin(a);
  const sx = 2.6 * s, sy = 2.0 * s; // grid units -> pixels
  const cx = GLYPH_W / 2 + dx, cy = GLYPH_H / 2 + dy;
  return glyphStrokes(ch).map((stroke) =>
    stroke.map(([x, y]): Point => {
      const gx = (x - 2) * sx, gy = (y - 4) * sy;
      return [cx + gx * cos - gy * sin, cy + gx * sin + gy * cos];
    }));
}

/** The raw-bit picture of one character: GLYPH_W * GLYPH_H values, 1 = ink. */
export function renderGlyph(ch: string, rng: () => number, opts: RenderOptions = {}): Uint8Array {
  const strokes = placedStrokes(ch, rng, opts);
  const [w0, w1] = opts.width ?? [1.3, 1.9];
  const half = (w0 + rng() * (w1 - w0)) / 2;
  const speckle = opts.speckle ?? 0.015;
  const bits = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      let ink = 0;
      for (const stroke of strokes) {
        for (let i = 0; i + 1 < stroke.length && !ink; i++) {
          if (distToSegment(x + 0.5, y + 0.5, stroke[i][0], stroke[i][1], stroke[i + 1][0], stroke[i + 1][1]) <= half) ink = 1;
        }
        if (ink) break;
      }
      if (speckle > 0 && rng() < speckle) ink ^= 1;
      bits[y * GLYPH_W + x] = ink;
    }
  }
  return bits;
}
