#!/usr/bin/env node
/**
 * Watch a trained creature, as text: where it walked on the plane, its footfalls, and checks on the
 * physics (did it really walk, or did it exploit the solver?).
 *
 *   node training/physics/play.mjs                      # saved checkpoint, one episode
 *   node training/physics/play.mjs --seed 7 --seconds 30
 *   node training/physics/play.mjs --untrained          # the standing-still network, for comparison
 *
 * Options: --policy FILE (default training/physics/out/walker.json)  --seed N  --seconds N  --gait (footfall lines)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WalkEnv, rollout, OBS_SIZE, ACT_SIZE } from './env.mjs';
import { MLP, DEFAULT_SIZES } from './policy.mjs';
import { FEET } from './body.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run one episode and measure it. Exported for the tests.
 * Returns the usual stats plus physics audits.
 */
export function audit(policy, seed, envOptions = {}, keepGait = false) {
  const env = new WalkEnv(envOptions);
  const path_ = [];
  const gait = [];
  let maxStretch = 0, maxHeight = 0, minHeight = Infinity, airborne = 0, steps = 0;
  let maxStepMove = 0, slide = 0, slideN = 0, effort = 0;
  const prev = [0, 0, 0], p = [0, 0, 0];
  let first = true;
  const stats = rollout(policy, env, seed, (e) => {
    const cr = e.creature, w = e.world;
    cr.position(p);
    if (first) { prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2]; first = false; }
    maxStepMove = Math.max(maxStepMove, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
    prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];
    maxStretch = Math.max(maxStretch, w.maxBondError());
    maxHeight = Math.max(maxHeight, p[1]); minHeight = Math.min(minHeight, p[1]);
    let touching = 0, code = '';
    for (let f = 0; f < FEET; f++) {
      const c = cr.footContact(f);
      touching += c; code += c ? '#' : '.';
      if (c) { // foot speed along the ground while touching: skating, not stepping
        const i = cr.parts.feet[f];
        slide += Math.hypot(w.vx[i], w.vz[i]); slideN++;
      }
    }
    if (touching === 0) airborne++;
    for (let i = 0; i < ACT_SIZE; i++) effort += cr.controls[i] * cr.controls[i];
    steps++;
    if (steps % 3 === 0) path_.push([p[0], p[2]]);
    if (keepGait) gait.push(code);
  });
  return {
    ...stats, path: path_, gait,
    audit: {
      maxStretchPct: maxStretch * 100, maxHeight, minHeight, airbornePct: 100 * airborne / Math.max(steps, 1),
      maxStepMove, footSlideSpeed: slideN ? slide / slideN : 0, meanSpeed: stats.distance / Math.max(stats.seconds, 1e-9),
      meanEffort: effort / Math.max(steps * ACT_SIZE, 1),
    },
  };
}

/** Top-down picture of the plane: the path as dots, start S, end E. */
export function drawPath(points, goalsNote = '', width = 61, height = 25) {
  if (!points.length) return '';
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const span = Math.max(maxX - minX, (maxZ - minZ) * 2, 1);   // characters are about twice as tall as wide
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const grid = Array.from({ length: height }, () => Array(width).fill(' '));
  const put = (x, z, ch) => {
    const c = Math.round((x - cx) / span * (width - 1) + (width - 1) / 2);
    const r = Math.round((z - cz) / span * (width - 1) / 2 + (height - 1) / 2);
    if (r >= 0 && r < height && c >= 0 && c < width) grid[r][c] = ch;
  };
  for (const [x, z] of points) put(x, z, '.');
  put(points[0][0], points[0][1], 'S');
  put(points[points.length - 1][0], points[points.length - 1][1], 'E');
  const scale = (span / (width - 1)).toFixed(2);
  return grid.map((r) => '|' + r.join('') + '|').join('\n') + `\n(one column is ${scale} m${goalsNote})`;
}

function args() {
  const o = { policy: path.join(here, 'out', 'walker.json'), seed: 1, seconds: 20, gait: false, untrained: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'gait' || k === 'untrained') o[k] = true;
    else if (k === 'policy') o.policy = path.resolve(a[++i]);
    else if (k in o) o[k] = Number(a[++i]);
    else { console.error(`unknown option ${a[i]}`); process.exit(2); }
  }
  return o;
}

function main() {
  const o = args();
  let net;
  if (o.untrained) net = new MLP(DEFAULT_SIZES).init(1);
  else {
    if (!fs.existsSync(o.policy)) { console.error(`no checkpoint at ${o.policy}. Train one: node training/physics/train.mjs`); process.exit(1); }
    net = MLP.fromJSON(JSON.parse(fs.readFileSync(o.policy, 'utf8')).policy);
  }
  const r = audit(net, o.seed, { seconds: o.seconds }, o.gait);
  console.log(drawPath(r.path, `, ${r.goals} goals reached`));
  console.log(`\n${r.seconds.toFixed(1)} s: ${r.distance.toFixed(1)} m toward goals (${r.audit.meanSpeed.toFixed(2)} m/s), ${r.goals} goals reached, ${r.fell ? 'FELL' : 'stayed up'}`);
  const a = r.audit;
  console.log(`physics audit: bones stretched at most ${a.maxStretchPct.toFixed(1)}%, body height ${a.minHeight.toFixed(2)}-${a.maxHeight.toFixed(2)} m, ` +
    `all feet off the ground ${a.airbornePct.toFixed(1)}% of the time, foot slide while planted ${a.footSlideSpeed.toFixed(2)} m/s, ` +
    `fastest step ${(a.maxStepMove / (1 / 30)).toFixed(2)} m/s, effort ${a.meanEffort.toFixed(2)}`);
  if (o.gait) {
    console.log('\nfootfalls (# = foot on the ground), one column per 1/30 s, rows are the 4 feet:');
    const seg = r.gait.slice(0, 90);
    for (let f = 0; f < FEET; f++) console.log(`foot ${f}  ` + seg.map((c) => c[f]).join(''));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
void OBS_SIZE;
