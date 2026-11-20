#!/usr/bin/env node
/**
 * Run the simulation from the command line with a mixed crowd of scripted
 * agents, and print what happened.
 *
 *   node training/simulation/run.mjs
 *   node training/simulation/run.mjs --res 2 --agents 10 --ticks 6000 --law automatic --map
 *
 * Options: --seed N  --res N (0.5 blocky .. 4 smooth)  --agents N  --ticks N
 *          --law reported|automatic|none  --report N (print every N ticks)
 *          --size N (metres, square)  --decide N (ticks between decisions)  --map
 */
import { Simulation } from './sim.mjs';
import { ROLES } from './policies.mjs';
import { renderTop } from './render.mjs';

function args() {
  const o = { seed: 1, res: 1, agents: 8, ticks: 3000, law: 'reported', report: 500, size: 64, decide: 1, map: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'map') o.map = true;
    else if (k in o) o[k] = k === 'law' ? a[++i] : Number(a[++i]);
    else { console.error(`unknown option ${a[i]}`); process.exit(2); }
  }
  return o;
}

const o = args();
const sim = new Simulation({
  seed: o.seed, res: o.res, size: [o.size, 32, o.size], decisionInterval: o.decide, justice: { mode: o.law },
});
const roles = ['forager', 'forager', 'builder', 'forager', 'brawler', 'thief', 'builder', 'forager'];
const names = [];
for (let i = 0; i < o.agents; i++) {
  const role = roles[i % roles.length];
  const a = sim.addAgent({ name: `${role}${i + 1}`, policy: ROLES[role]() });
  a.role = role;
  names.push(a);
}

console.log(`world ${sim.world.nx}x${sim.world.ny}x${sim.world.nz} voxels at ${o.res}/m (${(sim.world.n / 1e6).toFixed(2)}M), ${o.agents} agents, law=${o.law}`);
const started = Date.now();
for (let t = 1; t <= o.ticks; t++) {
  sim.stepPolicies();
  if (t % o.report === 0 || t === o.ticks) {
    const s = sim.summary();
    console.log(
      `t=${String(s.tick).padStart(6)} alive=${s.population} harm=${s.harm} kind=${s.kindness} gifts=${s.gifts} ` +
      `jail=${s.jailings} built=${s.builtVoxels} health=${s.meanHealth} gini=${s.wealthGini} | ` +
      `awake ${s.cost.awakeChunks}/${s.cost.totalChunks} chunks, ${s.cost.voxelUpdates} voxel updates`,
    );
  }
}
const ms = Date.now() - started;
console.log(`\n${o.ticks} ticks in ${ms} ms (${(ms / o.ticks).toFixed(2)} ms per tick)\n`);
console.log('name'.padEnd(12) + 'alive health food  harmDone kindDone rep   record debt  built deaths');
for (const a of names) {
  const s = sim.ledger.stat(a.id), rec = sim.justice.record(a.id);
  console.log(
    a.name.padEnd(12) + String(a.alive).padEnd(6) + String(Math.round(a.health)).padEnd(7) + String(Math.round(a.satiety)).padEnd(6) +
    s.harmDone.toFixed(0).padEnd(9) + s.kindDone.toFixed(0).padEnd(9) + sim.ledger.reputation(a.id).toFixed(2).padEnd(6) +
    String(rec.convictions).padEnd(7) + rec.debt.toFixed(0).padEnd(6) + String(sim.world.built.get(a.id) || 0).padEnd(6) + a.deaths,
  );
}
if (o.map) console.log('\n' + renderTop(sim));
