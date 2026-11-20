/**
 * Seeded randomness and smooth noise for the training simulation.
 * Written for this project from scratch (Node built-ins only, nothing imported).
 *
 * Everything in the simulation that looks random comes from here, so the same
 * seed always gives the same world and the same run.
 */

/** Mix up to four integers into one unsigned 32-bit hash. */
export function hash32(a, b = 0, c = 0, d = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13) ^ c, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16) ^ d, 0x165667b1);
  return (h ^ (h >>> 15)) >>> 0;
}

const TWO32 = 4294967296;

/** A small seeded random stream (xorshift core, output mixed). */
export class Rng {
  constructor(seed = 1) {
    this.s = hash32(seed | 0, 0x5eed) | 0 || 0x2545f491;
  }
  u32() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    let y = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    y = Math.imul(y ^ (y >>> 12), 0x297a2d39);
    return (y ^ (y >>> 15)) >>> 0;
  }
  /** Float in [0, 1). */
  next() {
    return this.u32() / TWO32;
  }
  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  /** In-place Fisher-Yates shuffle. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
  /** A new independent stream derived from this one and a label. */
  fork(label = 0) {
    return new Rng(hash32(this.u32() | 0, label | 0));
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function lat2(seed, x, z) {
  return hash32(seed, x, z, 0x2f1) / TWO32;
}
function lat3(seed, x, y, z) {
  return hash32(seed, x, y, z) / TWO32;
}

/** Smooth value noise in [0, 1), 2D. */
export function noise2(seed, x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = smooth(x - x0), tz = smooth(z - z0);
  return lerp(
    lerp(lat2(seed, x0, z0), lat2(seed, x0 + 1, z0), tx),
    lerp(lat2(seed, x0, z0 + 1), lat2(seed, x0 + 1, z0 + 1), tx),
    tz,
  );
}

/** Smooth value noise in [0, 1), 3D. */
export function noise3(seed, x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const tx = smooth(x - x0), ty = smooth(y - y0), tz = smooth(z - z0);
  const plane = (zz) =>
    lerp(
      lerp(lat3(seed, x0, y0, zz), lat3(seed, x0 + 1, y0, zz), tx),
      lerp(lat3(seed, x0, y0 + 1, zz), lat3(seed, x0 + 1, y0 + 1, zz), tx),
      ty,
    );
  return lerp(plane(z0), plane(z0 + 1), tz);
}

/** Layered noise: big shapes plus finer detail, in [0, 1). */
export function fbm2(seed, x, z, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(seed + o * 131, x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
