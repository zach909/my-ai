#!/usr/bin/env node
/**
 * Run the virtual laboratory from the command line.
 *
 *   node training/lab/run.mjs                       every scripted agent on the same lab, side by side
 *   node training/lab/run.mjs --agent scientist --notebook --detail
 *   node training/lab/run.mjs --stdio --seed 5      let any process drive the lab (see below)
 *
 * Options: --seed N  --agent scientist|reckless|guesser|all  --credits N  --hours N (bench time)
 *          --experiments a,b,c  --notebook (print the lab notebook)  --detail (print every claim)  --stdio
 *
 * --stdio: the datasheet is printed as one JSON line, then for every JSON line read from standard input,
 * one JSON result line is written, e.g.  {"tool":"measure","experiment":"pendulum","controls":{"length":1}}
 * The session ends at {"tool":"submit"} or end of input. This is how a model that is not in this process
 * works in the lab; the lab itself still touches nothing outside its own memory.
 */
import { createInterface } from 'node:readline';
import { Lab } from './lab.mjs';
import { EXPERIMENTS } from './physics.mjs';
import { POLICIES } from './scientists.mjs';

function args() {
  const o = { seed: 1, agent: 'all', credits: 100, hours: 16, experiments: Object.keys(EXPERIMENTS).join(','), notebook: false, detail: false, stdio: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'notebook' || k === 'detail' || k === 'stdio') o[k] = true;
    else if (k in o) o[k] = ['agent', 'experiments'].includes(k) ? a[++i] : Number(a[++i]);
    else { console.error(`unknown option ${a[i]}`); process.exit(2); }
  }
  return o;
}

const o = args();
const make = () => new Lab({ seed: o.seed, experiments: o.experiments.split(','), credits: o.credits, deadline: o.hours * 3600 });

if (o.stdio) {
  const lab = make();
  console.log(JSON.stringify({ datasheet: lab.describe() }));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (lab.done || !line.trim()) return; // the session ended at submit; lines already buffered behind it are dropped
    let action;
    try { action = JSON.parse(line); } catch { console.log(JSON.stringify({ ok: false, reason: 'bad_json', message: 'send one JSON object per line' })); return; }
    const res = lab.act(action);
    console.log(JSON.stringify(res));
    if (lab.done) rl.close();
  });
} else {
  const names = o.agent === 'all' ? Object.keys(POLICIES) : [o.agent];
  for (const n of names) if (!POLICIES[n]) { console.error(`no agent "${n}"; try: ${Object.keys(POLICIES).join(', ')}`); process.exit(2); }
  console.log(`lab seed=${o.seed} benches=${o.experiments} credits=${o.credits} bench time=${o.hours} h\n`);
  console.log('agent      score  discovery prediction incidents credits-left time-left actions');
  const runs = [];
  for (const n of names) {
    const lab = make();
    const started = Date.now();
    POLICIES[n](lab.door());
    const r = lab.report();
    runs.push({ n, lab, r, ms: Date.now() - started });
    console.log(
      n.padEnd(10) + r.score.toFixed(3).padEnd(7) + r.discovery.toFixed(3).padEnd(10) + r.prediction.toFixed(3).padEnd(11) +
      String(r.incidents.length).padEnd(10) + r.credits_left.toFixed(1).padEnd(13) + `${(r.bench_seconds_left / 3600).toFixed(1)} h`.padEnd(10) + r.actions,
    );
  }
  for (const { n, lab, r, ms } of runs) {
    if (!o.detail && !o.notebook) continue;
    console.log(`\n=== ${n} (${ms} ms) ===`);
    if (o.detail) {
      for (const c of r.constants) console.log(`  ${c.experiment}.${c.constant}`.padEnd(26) + `claimed ${String(c.claimed === null ? '-' : Number(c.claimed.toPrecision(4))).padEnd(12)} truth ${String(c.truth).padEnd(12)} error ${c.rel_error === null ? '-' : (c.rel_error * 100).toFixed(1) + '%'}`);
      for (const p of r.predictions) console.log(`  ${p.challenge}`.padEnd(26) + (p.answered ? `predicted ${p.predicted.toPrecision(4)} truth ${p.truth} error ${(p.rel_error * 100).toFixed(1)}%` : 'not answered'));
      for (const i of r.incidents) console.log(`  INCIDENT ${i.experiment}: ${i.what}`);
    }
    if (o.notebook) console.log(lab.notebookText());
  }
}
