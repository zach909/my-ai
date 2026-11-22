// A math exam that is different every time, so the AI cannot pass it by remembering it.
//
//   node benchmarks/math_exam.mjs [--solver reference|memorise|<path>|mesh|zip] [--n 200] [--dist dist]
//        [--seed N] [--recipe report.json] [--state file] [--no-state] [--json out.json]
//
// What happens in a run (see lib/mutating-tests.mjs and lib/math-problems.mjs):
//   1. A new random seed builds a new teaching set (a random 60% of the small-number facts) and
//      new problems the solver was never taught. No problem is ever served twice (hash ledger).
//   2. The solver is taught and examined. The exact `reference` solver must score 100% (otherwise the
//      exam is broken) and the `memorise` canary must score near 0% (otherwise the exam can be passed by remembering).
//   3. The result feeds back: kinds the AI passes get harder, kinds it fails get drawn more often.
//
// Scores to read:
//   anchor     problems at fixed level-1 settings: comparable between runs, the number to watch across model changes
//   adaptive   problems at the current level and weights: shows where the AI is weak now, NOT comparable between runs
//   seen gap   score on taught problems minus score on fresh ones: large = remembering, not computing
//
// mesh and zip need the compiled TypeScript backend in dist/, which this repo no longer builds; pass your own solver
// module with --solver path/to/solver.mjs for a model Node can call.
//
// --seed N replays a seed against the saved levels; --recipe replays a whole earlier exam (seed + levels + weights) and
// changes nothing. --no-state (or a reference / memorise solver) reads and writes no state.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MutatingRun } from './lib/mutating-tests.mjs';
import { buildExam, FAMILY } from './lib/math-problems.mjs';
import { loadSolver, reference, memoriser } from './lib/math-solvers.mjs';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : f; };
const flag = (n) => args.includes('--' + n);
const SOLVER = opt('solver', 'mesh');
const N = Number(opt('n', 200));
const dist = resolve(opt('dist', 'dist'));
const OUT = opt('json', null);
const ephemeral = flag('no-state') || SOLVER === 'reference' || SOLVER === 'memorise';

const recipe = opt('recipe', null) ? JSON.parse(readFileSync(opt('recipe'), 'utf8')).recipe : undefined;
const run = new MutatingRun({ name: 'math', seed: opt('seed', undefined) === undefined ? undefined : Number(opt('seed')), recipe, statePath: opt('state', undefined), persist: !ephemeral });
const levelsBefore = run.family(FAMILY).level;
const exam = buildExam(run, { n: N });
const ctx = { train: exam.train, T: exam.T, seed: run.seed, dist };

const rate = (rows) => (rows.length ? +(rows.filter((r) => r.ok).length / rows.length).toFixed(3) : null);
async function sit(solver, items) {
  return items.map((p) => { let said = null; try { said = solver.solve(p); } catch { said = null; } return { id: p.id, kind: p.kind, track: p.track, tags: p.tags, text: p.text, answer: p.answer, said, ok: said !== null && Math.round(said) === p.answer }; });
}

// the exam must be valid before its result means anything
const ref = await sit(reference(), exam.test);
if (rate(ref) !== 1) { console.error('exam is broken: the exact reference solver did not score 100%'); process.exit(2); }
const canary = await sit(memoriser(ctx), exam.test);

const t0 = performance.now();
const solver = await loadSolver(SOLVER, ctx);
const teachMs = Math.round(performance.now() - t0);
const rows = await sit(solver, exam.test);
const seenRows = await sit(solver, exam.seen);
for (const r of rows) run.record(FAMILY, { track: r.track, tags: r.tags, ok: r.ok });

// closeness: exact match is all-or-nothing, so a weak model sits at 0% whatever changes. Mean absolute error and the share
// within 10% (or 1) of the right answer still move when a model gets better or worse.
const close = (rs) => { const got = rs.filter((r) => r.said !== null && Number.isFinite(r.said)); return { meanAbsError: got.length ? +(got.reduce((s, r) => s + Math.abs(r.said - r.answer), 0) / got.length).toFixed(3) : null, within10pct: rs.length ? +(rs.filter((r) => r.said !== null && Math.abs(r.said - r.answer) <= Math.max(1, 0.1 * Math.abs(r.answer))).length / rs.length).toFixed(3) : null, unanswered: rs.filter((r) => r.said === null).length }; };
const byKind = {};
for (const k of new Set(rows.map((r) => r.kind))) byKind[k] = { n: rows.filter((r) => r.kind === k).length, score: rate(rows.filter((r) => r.kind === k)) };
const anchor = rows.filter((r) => r.track === 'anchor'), adaptive = rows.filter((r) => r.track === 'adaptive');
const summary = run.finish();
const seenScore = rate(seenRows), freshScore = rate(rows);
const report = {
  meta: { seed: run.seed, solver: solver.name, items: rows.length, taught: exam.train.length, T: exam.T, persisted: run.persist, replay: run.replay, levelBefore: levelsBefore, levelAfter: run.persist ? summary.families[FAMILY]?.levelAfter ?? levelsBefore : levelsBefore, teachMs, node: process.version },
  recipe: run.recipe(),
  score: { overall: freshScore, anchor: rate(anchor), adaptive: rate(adaptive), anchorItems: anchor.length, adaptiveItems: adaptive.length },
  closeness: { anchor: close(anchor), overall: close(rows) },
  byKind,
  memorisation: { seenScore, freshScore, seenGap: seenScore === null || freshScore === null ? null : +(seenScore - freshScore).toFixed(3), canaryMemoriser: rate(canary), referenceExact: rate(ref) },
  evolution: summary,
  weights: run.family(FAMILY).weights,
  cases: rows.filter((r) => !r.ok).slice(0, 40).map(({ id, kind, track, text, answer, said }) => ({ id, kind, track, text, answer, said })),
};
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));

const pc = (x) => (x === null ? '  - ' : (x * 100).toFixed(0).padStart(3) + '%');
console.log(`\nmath exam | seed ${run.seed} | ${solver.name} | ${rows.length} fresh problems, taught ${exam.train.length} facts${run.replay ? ' | REPLAY' : ''}${run.persist ? '' : ' | no state'}`);
console.log(`  anchor ${pc(report.score.anchor)} (${anchor.length})   adaptive ${pc(report.score.adaptive)} (${adaptive.length})   overall ${pc(freshScore)}   level ${levelsBefore} -> ${report.meta.levelAfter}`);
console.log(`  closeness (anchor): mean error ${report.closeness.anchor.meanAbsError ?? '-'}, within 10% ${pc(report.closeness.anchor.within10pct)}, unanswered ${report.closeness.anchor.unanswered}`);
console.log('  by kind: ' + Object.entries(byKind).map(([k, v]) => `${k} ${pc(v.score)} (${v.n})`).join('  '));
console.log(`  seen ${pc(seenScore)}  fresh ${pc(freshScore)}  gap ${report.memorisation.seenGap === null ? '-' : (report.memorisation.seenGap * 100).toFixed(0) + ' pts'}   canary memoriser ${pc(report.memorisation.canaryMemoriser)}   reference ${pc(report.memorisation.referenceExact)}`);
