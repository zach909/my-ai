/**
 * Evolution strategies: learn by trying small random changes to the weights and moving toward the ones
 * that made the creature walk better. No gradients and no backpropagation, just rollouts.
 * Written for this project from scratch (Node built-ins only).
 *
 * One generation:
 *   1. Draw P noise vectors. For each, build two neighbours of the current weights: theta + sigma*eps and
 *      theta - sigma*eps (mirrored, so the estimate is much less noisy).
 *   2. Score every neighbour by running it for a few episodes. All of them get the SAME episodes
 *      (same seeds), so a difference in score is a difference in the brain, not luck.
 *   3. Replace scores with ranks (so one lucky run cannot dominate), and step toward the noise vectors
 *      whose + side beat their - side. The step uses Adam's scaling for steadier progress.
 *
 * A noise vector is never stored or sent: it is rebuilt from its seed, so workers only get numbers.
 */
import { Rng } from '../simulation/random.mjs';
import { MLP, noiseFor, paramCount } from './policy.mjs';
import { WalkEnv, rollout } from './env.mjs';

/** Score one set of weights: mean total reward over the given episode seeds, using `env`. */
export function score(theta, sizes, seeds, env) {
  const net = new MLP(sizes, theta);
  let total = 0;
  for (const s of seeds) total += rollout(net, env, s).reward;
  return total / seeds.length;
}

/** Ranks of `values`, scaled to [-0.5, 0.5]. Ties share the lower rank. */
export function centeredRanks(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const out = new Float64Array(n);
  for (let r = 0; r < n; r++) out[order[r]] = r / (n - 1) - 0.5;
  return out;
}

/**
 * Same-thread evaluator: jobs are [{ noiseSeed, sign }]. Returns one score per job.
 * (eval-pool.mjs does the same across worker threads.)
 */
export function makeLocalEvaluator(sizes, envOptions) {
  const env = new WalkEnv(envOptions);
  const n = paramCount(sizes);
  const eps = new Float64Array(n), trial = new Float64Array(n);
  return {
    async evaluate({ theta, sigma, jobs, seeds, envOptions: eo }) {
      if (eo) Object.assign(env.cfg, eo);
      const out = new Float64Array(jobs.length);
      for (let k = 0; k < jobs.length; k++) {
        noiseFor(jobs[k].noiseSeed, eps);
        for (let i = 0; i < trial.length; i++) trial[i] = theta[i] + jobs[k].sign * sigma * eps[i];
        out[k] = score(trial, sizes, seeds, env);
      }
      return out;
    },
    close() {},
  };
}

/**
 * Train. Returns the final MLP. `onGeneration(info)` runs after each one; judging the network (held-out
 * episodes, keeping the best checkpoint) is the caller's job, because the top perturbed score says
 * little about the network actually being kept.
 *
 * @param {object} o
 * @param {number[]} o.sizes
 * @param {{evaluate:Function,close:Function}} o.evaluator
 * @param {number} [o.generations=100]
 * @param {number} [o.pairs=32]        noise vectors per generation (2x as many rollouts)
 * @param {number} [o.episodes=2]      episodes per score
 * @param {number} [o.sigma=0.1]       size of the weight perturbation
 * @param {number} [o.lr=0.03]         Adam learning rate
 * @param {number} [o.decay=0.005]     weight decay, keeps the weights from growing without bound
 * @param {number} [o.seed=1]
 * @param {(gen:number)=>object} [o.curriculum]  env option overrides for a generation (e.g. wider goal angle)
 * @param {MLP} [o.start]              continue from an existing network
 */
export async function train(o) {
  const {
    sizes, evaluator, generations = 100, pairs = 32, episodes = 2, sigma = 0.1, lr = 0.03, decay = 0.005,
    seed = 1, curriculum = null, onGeneration = null, start = null,
  } = o;
  const net = start ? start.clone() : new MLP(sizes).init(seed);
  const n = net.params.length;
  const rng = new Rng(seed ^ 0x51ed);
  const m = new Float64Array(n), v = new Float64Array(n);
  const eps = new Float64Array(n), grad = new Float64Array(n);
  const b1 = 0.9, b2 = 0.999;

  for (let gen = 1; gen <= generations; gen++) {
    const jobs = [];
    for (let j = 0; j < pairs; j++) {
      const noiseSeed = rng.u32() | 0;
      jobs.push({ noiseSeed, sign: 1 }, { noiseSeed, sign: -1 });
    }
    const seeds = Array.from({ length: episodes }, () => rng.u32() | 0);
    const scores = await evaluator.evaluate({
      theta: net.params, sigma, jobs, seeds, envOptions: curriculum ? curriculum(gen) : null,
    });

    const ranks = centeredRanks(scores);
    grad.fill(0);
    for (let j = 0; j < pairs; j++) {
      const w = ranks[2 * j] - ranks[2 * j + 1];
      noiseFor(jobs[2 * j].noiseSeed, eps);
      for (let i = 0; i < n; i++) grad[i] += w * eps[i];
    }
    const t = gen;
    for (let i = 0; i < n; i++) {
      const g = grad[i] / (2 * pairs * sigma) - decay * net.params[i];
      m[i] = b1 * m[i] + (1 - b1) * g;
      v[i] = b2 * v[i] + (1 - b2) * g * g;
      net.params[i] += lr * (m[i] / (1 - b1 ** t)) / (Math.sqrt(v[i] / (1 - b2 ** t)) + 1e-8);
    }

    let top = -Infinity, sum = 0;
    for (const s of scores) { sum += s; if (s > top) top = s; }
    const mean = sum / scores.length;
    if (onGeneration) onGeneration({ generation: gen, mean, top, params: net.params, sigma, lr });
  }
  return net;
}
