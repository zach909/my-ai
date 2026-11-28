#!/usr/bin/env node
/**
 * Teach the creature to walk.
 *
 *   node training/physics/train.mjs                         # about 10 minutes on 4 cores
 *   node training/physics/train.mjs --generations 40 --pairs 16     # a quick try
 *   node training/physics/train.mjs --resume                # carry on from the saved checkpoint
 *
 * Options: --generations N  --pairs N (noise vectors per generation)  --episodes N (per score)
 *          --workers N (CPU cores, default all up to 4)  --seed N  --sigma X  --lr X  --hidden N
 *          --out FILE (default training/physics/out/walker.json)  --resume
 *          --check N (judge the network on held-out episodes every N generations)
 *
 * The goal starts straight ahead and the allowed angle widens to a full circle over the first 60% of the
 * run, so the creature learns to walk before it learns to turn. The saved checkpoint is the network that
 * did best on held-out episodes with goals in every direction, not the last one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { train, makeLocalEvaluator } from './es.mjs';
import { makePoolEvaluator } from './eval-pool.mjs';
import { MLP, DEFAULT_SIZES } from './policy.mjs';
import { WalkEnv, rollout, OBS_SIZE, ACT_SIZE } from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function args() {
  const o = {
    generations: 150, pairs: 24, episodes: 2, workers: Math.min(4, os.cpus().length), seed: 1,
    sigma: 0.1, lr: 0.03, hidden: DEFAULT_SIZES[1], out: path.join(here, 'out', 'walker.json'), resume: false, check: 5,
  };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'resume') o.resume = true;
    else if (k === 'out') o.out = path.resolve(a[++i]);
    else if (k in o) o[k] = Number(a[++i]);
    else { console.error(`unknown option ${a[i]}`); process.exit(2); }
  }
  return o;
}

/** Judge a network on fixed episodes it never trained on, goals in every direction. */
export function validate(net, seeds = [9001, 9002, 9003, 9004, 9005, 9006]) {
  const env = new WalkEnv();
  let reward = 0, distance = 0, goals = 0, falls = 0;
  for (const s of seeds) {
    const r = rollout(net, env, s);
    reward += r.reward; distance += r.distance; goals += r.goals; if (r.fell) falls++;
  }
  const n = seeds.length;
  return { reward: reward / n, distance: distance / n, goals: goals / n, falls, episodes: n };
}

async function main() {
  const o = args();
  const sizes = [OBS_SIZE, o.hidden, ACT_SIZE];
  fs.mkdirSync(path.dirname(o.out), { recursive: true });

  let start = null, bestVal = -Infinity;
  if (o.resume && fs.existsSync(o.out)) {
    const saved = JSON.parse(fs.readFileSync(o.out, 'utf8'));
    start = MLP.fromJSON(saved.policy);
    bestVal = saved.validation?.reward ?? -Infinity;
    console.log(`resuming from ${o.out} (validation reward ${bestVal.toFixed(2)})`);
  }

  const evaluator = o.workers > 1 ? makePoolEvaluator(sizes, null, o.workers) : makeLocalEvaluator(sizes, null);
  const ramp = Math.max(1, Math.round(o.generations * 0.6));
  const curriculum = (gen) => ({ goalAngle: Math.min(1, (gen - 1) / ramp) * Math.PI });
  const t0 = Date.now();
  console.log(`training: ${o.generations} generations x ${o.pairs * 2} rollouts x ${o.episodes} episodes, ${o.workers} worker(s), ${sizes.join('-')} network`);

  const net = await train({
    sizes, evaluator, generations: o.generations, pairs: o.pairs, episodes: o.episodes, sigma: o.sigma, lr: o.lr,
    seed: o.seed, curriculum, start,
    onGeneration: ({ generation, mean, top, params }) => {
      let line = `gen ${String(generation).padStart(4)}  mean ${mean.toFixed(2).padStart(7)}  top ${top.toFixed(2).padStart(7)}`;
      if (generation % o.check === 0 || generation === o.generations) {
        const v = validate(new MLP(sizes, params));
        line += `  | held-out: reward ${v.reward.toFixed(2)}, ${v.distance.toFixed(1)} m toward goals, ${v.goals.toFixed(1)} goals, ${v.falls}/${v.episodes} falls`;
        if (v.reward > bestVal) {
          bestVal = v.reward;
          const policy = new MLP(sizes, Float64Array.from(params)).toJSON();
          fs.writeFileSync(o.out, JSON.stringify({ format: 'walker-v1', generation, validation: v, policy }));
          line += '  *saved';
        }
      }
      console.log(line + `  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    },
  });
  evaluator.close();
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s. best held-out reward ${bestVal.toFixed(2)} saved to ${o.out}`);
  return net;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
