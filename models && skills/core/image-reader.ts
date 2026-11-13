/**
 * Image reader: turns a picture of one character into the character, two different ways,
 * and scores them against each other.
 *
 *   pixel reader     -- looks at the raw bit grid. For each character it keeps the average
 *                       picture seen in training and answers with the closest one.
 *   geometry reader  -- first turns the picture into lines and geometry (thins it to a
 *                       skeleton, traces it into straight segments, finds the ends, the
 *                       crossings and the holes), then answers from those facts.
 *
 * The geometry (`toGeometry`) is also what images are trained on as "lines": `geometryBytes`
 * gives it as plain bytes for the Zip Loop, no tokenizer.
 *
 * `compareReaders` trains and tests both on the SAME balanced set: every one of the 95
 * printable characters appears, each exactly the same number of times, so no character
 * (and no blank or dotty one) can carry the score. It reports the plain accuracy and the
 * average of the per-character accuracies, which is the number to trust.
 *
 * Own code only. The thinning step is the textbook two-pass thinning rule written out here.
 */
import { GLYPH_W, GLYPH_H, PRINTABLE, makeRng, renderGlyph, type RenderOptions } from "./stroke-glyphs.js";

export type Bits = Uint8Array; // GLYPH_W * GLYPH_H, 1 = ink
const W = GLYPH_W, H = GLYPH_H;

const NEIGHBOURS8: Array<[number, number]> = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** Drop lone specks and fill single-pixel pinholes. */
export function cleanBits(bits: Bits, w = W, h = H): Bits {
  const out = Uint8Array.from(bits);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bits[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (const [dx, dy] of NEIGHBOURS8) n += at(x + dx, y + dy);
      if (bits[y * w + x] && n === 0) out[y * w + x] = 0;
      else if (!bits[y * w + x] && n >= 6) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Thin ink to a one-pixel-wide skeleton (two sub-passes, repeated until nothing changes). */
export function thin(bits: Bits, w = W, h = H): Bits {
  const img = Uint8Array.from(bits);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const remove: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p = NEIGHBOURS8.map(([dx, dy]) => at(x + dx, y + dy)); // p2..p9, clockwise from the top
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          const [p2, , p4, , p6, , p8] = p;
          if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) remove.push(y * w + x);
        }
      }
      for (const i of remove) img[i] = 0;
      if (remove.length) changed = true;
    }
  }
  return img;
}

/** Holes: background areas (4-connected, 3+ pixels) that do not touch the edge. */
function countHoles(bits: Bits, w: number, h: number): number {
  const seen = new Uint8Array(w * h);
  let holes = 0;
  for (let s = 0; s < w * h; s++) {
    if (bits[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let area = 0, touchesEdge = false;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!bits[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!touchesEdge && area >= 3) holes++;
  }
  return holes;
}

type P = [number, number];

/** Douglas-Peucker style simplification: keep only the points that bend the line by more than eps. */
function simplify(points: P[], eps: number): P[] {
  if (points.length < 3) return points;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  let worst = -1, worstD = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
    if (d > worstD) { worstD = d; worst = i; }
  }
  if (worstD <= eps) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, worst + 1), eps);
  const right = simplify(points.slice(worst), eps);
  return [...left.slice(0, -1), ...right];
}

export interface Geometry {
  /** Straight pieces, [x1, y1, x2, y2] in picture pixels. */
  segments: Array<[number, number, number, number]>;
  /** Where lines end. */
  endpoints: P[];
  /** Where lines cross or join (one point per crossing). */
  junctions: P[];
  /** Closed loops (the inside of an o, a, 8, 0...). */
  holes: number;
  /** Tiny pieces too short to be a line: dots and the like (their centres). */
  dotPoints: P[];
  /** How many of those there are. */
  dots: number;
  /** [left, top, right, bottom] of the ink, or null for a blank picture. */
  bbox: [number, number, number, number] | null;
}

/** Turn a picture into lines and geometry. */
export function toGeometry(bits: Bits, w = W, h = H): Geometry {
  const clean = cleanBits(bits, w, h);
  const skel = thin(clean, w, h);
  const idx = (x: number, y: number): number => y * w + x;
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && skel[idx(x, y)] === 1;
  const nbrs = (x: number, y: number): P[] => {
    const out: P[] = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]] as P[]) if (on(x + dx, y + dy)) out.push([x + dx, y + dy]);
    return out;
  };

  const pixels: P[] = [];
  const deg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) { pixels.push([x, y]); deg[idx(x, y)] = nbrs(x, y).length; }

  // ends and crossings
  const endpoints = pixels.filter(([x, y]) => deg[idx(x, y)] === 1);
  const jp = pixels.filter(([x, y]) => deg[idx(x, y)] >= 3);
  const junctions: P[] = [];
  const jSeen = new Set<number>();
  for (const [x, y] of jp) {
    if (jSeen.has(idx(x, y))) continue;
    const group: P[] = [], stack: P[] = [[x, y]];
    jSeen.add(idx(x, y));
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      group.push([cx, cy]);
      for (const [nx, ny] of NEIGHBOURS8.map(([dx, dy]) => [cx + dx, cy + dy] as P)) {
        if (on(nx, ny) && deg[idx(nx, ny)] >= 3 && !jSeen.has(idx(nx, ny))) { jSeen.add(idx(nx, ny)); stack.push([nx, ny]); }
      }
    }
    junctions.push([group.reduce((s, p) => s + p[0], 0) / group.length, group.reduce((s, p) => s + p[1], 0) / group.length]);
  }

  // trace the skeleton into paths, ends first
  const visited = new Uint8Array(w * h);
  const segments: Geometry["segments"] = [];
  const dotPoints: P[] = [];
  const walk = (start: P): P[] => {
    const path: P[] = [];
    let cur = start;
    for (;;) {
      const next = nbrs(cur[0], cur[1]).find(([x, y]) => !visited[idx(x, y)]);
      if (!next) break;
      visited[idx(next[0], next[1])] = 1;
      path.push(next);
      cur = next;
    }
    return path;
  };
  for (const start of [...endpoints, ...pixels]) {
    if (visited[idx(start[0], start[1])]) continue;
    visited[idx(start[0], start[1])] = 1;
    const forward = walk(start);
    const back = walk(start);
    const path: P[] = [...back.reverse(), start, ...forward];
    if (path.length < 3) { dotPoints.push([path.reduce((a, p) => a + p[0], 0) / path.length, path.reduce((a, p) => a + p[1], 0) / path.length]); continue; }
    const line = simplify(path, 0.9);
    for (let i = 0; i + 1 < line.length; i++) segments.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  }

  let bbox: Geometry["bbox"] = null;
  if (pixels.length) {
    bbox = [Math.min(...pixels.map((p) => p[0])), Math.min(...pixels.map((p) => p[1])), Math.max(...pixels.map((p) => p[0])), Math.max(...pixels.map((p) => p[1]))];
  }
  return { segments, endpoints, junctions, holes: countHoles(clean, w, h), dotPoints, dots: dotPoints.length, bbox };
}

/** The geometry as plain bytes (for the Zip Loop): counts first, then each segment's four corners. */
export function geometryBytes(g: Geometry, w = W, h = H): Uint8Array {
  const q = (v: number, size: number): number => Math.max(0, Math.min(255, Math.round((v / (size - 1)) * 255)));
  const segs = g.segments.slice(0, 40);
  const out = [Math.min(255, g.holes), Math.min(255, g.endpoints.length), Math.min(255, g.junctions.length), Math.min(255, g.dots), segs.length];
  for (const [x1, y1, x2, y2] of segs) out.push(q(x1, w), q(y1, h), q(x2, w), q(y2, h));
  return Uint8Array.from(out);
}

/** The numbers the geometry reader decides from. */
export function geometryFeatures(g: Geometry, w = W, h = H): number[] {
  const f: number[] = [];
  const zone = (x: number, y: number, box: [number, number, number, number]): number => {
    const bw = Math.max(1, box[2] - box[0]), bh = Math.max(1, box[3] - box[1]);
    const zx = Math.min(2, Math.max(0, Math.floor(((x - box[0]) / bw) * 3)));
    const zy = Math.min(2, Math.max(0, Math.floor(((y - box[1]) / bh) * 3)));
    return zy * 3 + zx;
  };
  const box = g.bbox ?? [0, 0, 1, 1];
  // length of line in each of 3x3 zones, split by direction (horizontal, diagonal up, vertical, diagonal down)
  const dir = new Array(36).fill(0);
  let total = 0;
  for (const [x1, y1, x2, y2] of g.segments) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len === 0) continue;
    let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    if (ang < 0) ang += 180;
    if (ang >= 180) ang -= 180;
    const bin = Math.floor(((ang + 22.5) % 180) / 45); // 0 horizontal, 1 down-right, 2 vertical, 3 down-left
    // spread the segment over the zones along its length
    const steps = Math.max(1, Math.round(len));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      dir[zone(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, box) * 4 + bin] += len / steps;
    }
    total += len;
  }
  for (const v of dir) f.push(total > 0 ? v / total : 0);
  const ends = new Array(9).fill(0), joins = new Array(9).fill(0);
  for (const [x, y] of g.endpoints) ends[zone(x, y, box)]++;
  for (const [x, y] of g.junctions) joins[zone(x, y, box)]++;
  f.push(...ends, ...joins);
  f.push(g.holes, g.endpoints.length, g.junctions.length, g.dots, g.segments.length, total / (w + h));
  // where the ink sits on the page (tells a small letter from a capital, a comma from a quote mark)
  f.push(g.bbox ? box[0] / w : 0, g.bbox ? box[1] / h : 0, g.bbox ? box[2] / w : 0, g.bbox ? box[3] / h : 0);
  f.push(g.bbox ? 1 : 0);
  // where the dots are, by height on the page (top / middle / bottom third) and side to side
  const dotRows = [0, 0, 0], dotCols = [0, 0, 0];
  for (const [x, y] of g.dotPoints) { dotRows[Math.min(2, Math.floor((y / h) * 3))]++; dotCols[Math.min(2, Math.floor((x / w) * 3))]++; }
  f.push(...dotRows, ...dotCols);
  // how much of the picture's height / width the ink spans, and how tall the ink is for its width
  f.push(g.bbox ? (box[3] - box[1] + 1) / h : 0, g.bbox ? (box[2] - box[0] + 1) / w : 0);
  return f;
}

export interface Sample { char: string; bits: Bits }

export interface Reader {
  readonly name: string;
  train(samples: Sample[]): void;
  classify(bits: Bits): string;
}

/** Average picture per character; answers with the nearest. */
export class PixelReader implements Reader {
  readonly name = "pixel grid";
  private centroids = new Map<string, Float64Array>();
  train(samples: Sample[]): void {
    const sums = new Map<string, { v: Float64Array; n: number }>();
    for (const s of samples) {
      const e = sums.get(s.char) ?? { v: new Float64Array(W * H), n: 0 };
      for (let i = 0; i < s.bits.length; i++) e.v[i] += s.bits[i];
      e.n++;
      sums.set(s.char, e);
    }
    this.centroids = new Map([...sums].map(([c, e]) => [c, e.v.map((v) => v / e.n)]));
  }
  classify(bits: Bits): string {
    let best = "", bestD = Infinity;
    for (const [c, v] of this.centroids) {
      let d = 0;
      for (let i = 0; i < v.length; i++) { const e = bits[i] - v[i]; d += e * e; }
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
}

/** Lines and geometry per character; answers with the nearest (each number scaled by how much it varies). */
export class GeometryReader implements Reader {
  readonly name = "lines and geometry";
  private centroids = new Map<string, number[]>();
  private mean: number[] = [];
  private spread: number[] = [];
  train(samples: Sample[]): void {
    const feats = samples.map((s) => ({ char: s.char, f: geometryFeatures(toGeometry(s.bits)) }));
    const n = feats[0].f.length;
    this.mean = new Array(n).fill(0);
    this.spread = new Array(n).fill(0);
    for (const { f } of feats) f.forEach((v, i) => (this.mean[i] += v / feats.length));
    for (const { f } of feats) f.forEach((v, i) => (this.spread[i] += ((v - this.mean[i]) ** 2) / feats.length));
    this.spread = this.spread.map((v) => Math.max(Math.sqrt(v), 0.05));
    const sums = new Map<string, { v: number[]; n: number }>();
    for (const { char, f } of feats) {
      const z = f.map((v, i) => (v - this.mean[i]) / this.spread[i]);
      const e = sums.get(char) ?? { v: new Array(n).fill(0), n: 0 };
      z.forEach((v, i) => (e.v[i] += v));
      e.n++;
      sums.set(char, e);
    }
    this.centroids = new Map([...sums].map(([c, e]) => [c, e.v.map((v) => v / e.n)]));
  }
  classify(bits: Bits): string {
    const z = geometryFeatures(toGeometry(bits)).map((v, i) => (v - this.mean[i]) / this.spread[i]);
    let best = "", bestD = Infinity;
    for (const [c, v] of this.centroids) {
      let d = 0;
      for (let i = 0; i < v.length; i++) { const e = z[i] - v[i]; d += e * e; }
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
}

/** The same number of pictures of every character, so none carries the score. */
export function balancedSamples(perChar: number, seed: number, opts: RenderOptions = {}, chars: string[] = PRINTABLE): Sample[] {
  const rng = makeRng(seed);
  const out: Sample[] = [];
  for (let i = 0; i < perChar; i++) for (const char of chars) out.push({ char, bits: renderGlyph(char, rng, opts) });
  return out;
}

export interface ReaderScore {
  name: string;
  /** Share of all test pictures read right. */
  accuracy: number;
  /** Average of each character's own accuracy: the fair number, since every character counts the same. */
  macroAccuracy: number;
  perChar: Record<string, number>;
  /** The most common mistakes, "a read as o". */
  worstMistakes: Array<{ truth: string; read: string; count: number }>;
}

export interface Comparison {
  characters: number;
  trainPerChar: number;
  testPerChar: number;
  /** True when every one of the characters is in both the training and the test set. */
  everyCharacterPresent: boolean;
  /** Share of ink pixels per character picture: lowest, average, highest. */
  inkShare: { min: number; mean: number; max: number };
  readers: ReaderScore[];
  /** How often the two readers agree, and how often they are right when they do. */
  agreement: { agree: number; rightWhenAgree: number; bothWrong: number };
}

export function score(reader: Reader, test: Sample[]): { score: ReaderScore; reads: string[] } {
  const reads = test.map((s) => reader.classify(s.bits));
  const hit = new Map<string, number>(), seen = new Map<string, number>();
  const mistakes = new Map<string, number>();
  reads.forEach((r, i) => {
    const t = test[i].char;
    seen.set(t, (seen.get(t) ?? 0) + 1);
    if (r === t) hit.set(t, (hit.get(t) ?? 0) + 1);
    else mistakes.set(`${t}\u0000${r}`, (mistakes.get(`${t}\u0000${r}`) ?? 0) + 1);
  });
  const perChar: Record<string, number> = {};
  for (const [c, n] of seen) perChar[c] = (hit.get(c) ?? 0) / n;
  const per = Object.values(perChar);
  return {
    reads,
    score: {
      name: reader.name,
      accuracy: reads.filter((r, i) => r === test[i].char).length / reads.length,
      macroAccuracy: per.reduce((s, v) => s + v, 0) / per.length,
      perChar,
      worstMistakes: [...mistakes].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, count]) => {
        const [truth, read] = k.split("\u0000");
        return { truth, read, count };
      }),
    },
  };
}

/** Train both readers on the same balanced set, test them on a fresh one, and compare. */
export function compareReaders(opts: { trainPerChar?: number; testPerChar?: number; seed?: number; render?: RenderOptions } = {}): Comparison {
  const trainPerChar = opts.trainPerChar ?? 30, testPerChar = opts.testPerChar ?? 10, seed = opts.seed ?? 1;
  const train = balancedSamples(trainPerChar, seed, opts.render);
  const test = balancedSamples(testPerChar, seed + 100003, opts.render);
  const readers: Reader[] = [new PixelReader(), new GeometryReader()];
  const results = readers.map((r) => { r.train(train); return score(r, test); });
  let agree = 0, right = 0, bothWrong = 0;
  test.forEach((s, i) => {
    const a = results[0].reads[i], b = results[1].reads[i];
    if (a === b) { agree++; if (a === s.char) right++; }
    if (a !== s.char && b !== s.char) bothWrong++;
  });
  const share = test.map((s) => s.bits.reduce((n, v) => n + v, 0) / s.bits.length);
  const has = (set: Sample[]): boolean => PRINTABLE.every((c) => set.some((s) => s.char === c));
  return {
    characters: PRINTABLE.length, trainPerChar, testPerChar,
    everyCharacterPresent: has(train) && has(test),
    inkShare: { min: Math.min(...share), mean: share.reduce((s, v) => s + v, 0) / share.length, max: Math.max(...share) },
    readers: results.map((r) => r.score),
    agreement: { agree: agree / test.length, rightWhenAgree: agree ? right / agree : 0, bothWrong: bothWrong / test.length },
  };
}
