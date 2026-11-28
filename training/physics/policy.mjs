/**
 * The thing being trained: a small feed-forward network, observation in, muscle commands out.
 * Written for this project from scratch (Node built-ins only).
 *
 * All the weights live in one flat Float64Array, so a checkpoint is just that array and training can
 * nudge it directly. Any other brain can stand in for this class as long as it has
 * `act(obs, out)` that fills `out[0..7]` with numbers in [-1, 1] (see `rollout` in env.mjs).
 */
import { Rng } from '../simulation/random.mjs';
import { OBS_SIZE, ACT_SIZE } from './env.mjs';

export const DEFAULT_SIZES = [OBS_SIZE, 32, ACT_SIZE];

export function paramCount(sizes) {
  let n = 0;
  for (let l = 0; l < sizes.length - 1; l++) n += sizes[l] * sizes[l + 1] + sizes[l + 1];
  return n;
}

/** A standard normal number from a seeded stream (Box-Muller). */
export function gaussian(rng) {
  const u = Math.max(rng.next(), 1e-12), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fill `out` with standard normal noise determined entirely by `seed`. */
export function noiseFor(seed, out) {
  const rng = new Rng(seed);
  for (let i = 0; i < out.length; i++) out[i] = gaussian(rng);
  return out;
}

export class MLP {
  constructor(sizes = DEFAULT_SIZES, params = null) {
    this.sizes = sizes.slice();
    this.params = params ?? new Float64Array(paramCount(sizes));
    this.h = sizes.slice(1).map((n) => new Float64Array(n));
  }

  /** Small random weights; the output layer starts at zero so the first behaviour is "stand still". */
  init(seed = 1) {
    const rng = new Rng(seed);
    let o = 0;
    const last = this.sizes.length - 2;
    for (let l = 0; l <= last; l++) {
      const fanIn = this.sizes[l], fanOut = this.sizes[l + 1];
      const scale = l === last ? 0 : 1 / Math.sqrt(fanIn);
      for (let i = 0; i < fanIn * fanOut; i++) this.params[o++] = gaussian(rng) * scale;
      for (let i = 0; i < fanOut; i++) this.params[o++] = 0;
    }
    return this;
  }

  clone() {
    return new MLP(this.sizes, Float64Array.from(this.params));
  }

  /** obs (Float64Array) in, muscle commands in [-1, 1] out. */
  act(obs, out) {
    const p = this.params, sizes = this.sizes;
    let o = 0, input = obs;
    for (let l = 0; l < sizes.length - 1; l++) {
      const fanIn = sizes[l], fanOut = sizes[l + 1], h = this.h[l];
      for (let j = 0; j < fanOut; j++) {
        let s = 0;
        const base = o + j * fanIn;
        for (let i = 0; i < fanIn; i++) s += p[base + i] * input[i];
        h[j] = Math.tanh(s + p[o + fanIn * fanOut + j]);
      }
      o += fanIn * fanOut + fanOut;
      input = h;
    }
    for (let j = 0; j < out.length; j++) out[j] = input[j];
    return out;
  }

  /** JSON-safe form, for saving a checkpoint. */
  toJSON() {
    return { sizes: this.sizes, params: Array.from(this.params, (v) => Math.round(v * 1e6) / 1e6) };
  }

  static fromJSON(j) {
    if (!j || !Array.isArray(j.sizes) || !Array.isArray(j.params)) throw new Error('not a policy checkpoint');
    if (j.params.length !== paramCount(j.sizes)) throw new Error('checkpoint size does not match its layers');
    if (j.sizes[0] !== OBS_SIZE || j.sizes[j.sizes.length - 1] !== ACT_SIZE) {
      throw new Error('checkpoint is for a different body or senses');
    }
    return new MLP(j.sizes, Float64Array.from(j.params));
  }
}
