/**
 * Tests for the rating framework (training/rating/).
 * Node's built-in runner:  node --test "test/training/rating.test.mjs"
 * Synthetic fixtures only; nothing here calls a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const R = '../../training/rating/';
const { DIMENSIONS, DIMENSION_IDS, dimension } = await import(R + 'dimensions.mjs');
const { scoreReport } = await import(R + 'score.mjs');
const { wilsonInterval, endurance } = await import(R + 'endurance.mjs');
const { createGrader } = await import(R + 'grader.mjs');
const { openLedger, exportTraining, learnability } = await import(R + 'ledger.mjs');
const { measureTree, findCycles } = await import(R + 'measure-repo.mjs');
const { rateJob, sampleJob, demoGenerator } = await import(R + 'run.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'myai-rate-'));

test('dimensions: unique ids, the gates are works and security, every source is known', () => {
  assert.equal(new Set(DIMENSION_IDS).size, DIMENSION_IDS.length);
  assert.deepEqual(DIMENSIONS.filter((d) => d.gate).map((d) => d.id).sort(), ['security', 'works']);
  const sources = new Set(['check', 'endure', 'measure', 'ai', 'ledger']);
  for (const d of DIMENSIONS) assert.ok(sources.has(d.source), d.id);
  assert.throws(() => dimension('nope'), /unknown rating dimension/);
});

test('scoreReport: a failed gate gives FAIL with no overall number', () => {
  const r = scoreReport([
    { dimension: 'works', score: 0 },
    { dimension: 'prompt_fit', score: 1 },
  ]);
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.overall, null);
  assert.deepEqual(r.gatesFailed, ['works']);
});

test('scoreReport: no evidence is UNGRADED, never a made-up number', () => {
  const r = scoreReport([]);
  assert.equal(r.verdict, 'UNGRADED');
  assert.equal(r.overall, null);
  assert.equal(r.coverage.graded, 0);
  assert.deepEqual(r.gatesUngraded.sort(), ['security', 'works']);
});

test('scoreReport: overall is the weighted mean of graded dimensions only, and coverage says how many', () => {
  const r = scoreReport([
    { dimension: 'works', score: 1 }, // weight 3
    { dimension: 'security', score: 1 }, // weight 3
    { dimension: 'prompt_fit', score: 0.5 }, // weight 3
    { dimension: 'interface', score: null }, // ungraded, not counted
  ]);
  assert.equal(r.verdict, 'SCORED');
  assert.ok(Math.abs(r.overall - (1 * 3 + 1 * 3 + 0.5 * 3) / 9) < 1e-9);
  assert.equal(r.coverage.graded, 3);
  assert.equal(r.dimensions.interface.status, 'ungraded');
});

test('scoreReport: rejects non-numeric scores instead of guessing', () => {
  assert.throws(() => scoreReport([{ dimension: 'works', score: 'yes' }]), /non-numeric/);
});

test('wilsonInterval: zero failures in 100 runs has an upper bound near 3.7%', () => {
  const [lo, hi] = wilsonInterval(0, 100);
  assert.ok(lo < 1e-9, `lo=${lo}`);
  assert.ok(hi > 0.03 && hi < 0.04, `hi=${hi}`);
  const [lo2, hi2] = wilsonInterval(50, 100);
  assert.ok(lo2 < 0.5 && hi2 > 0.5);
});

test('endurance: counts failures, finds the first one, and records thrown errors as failures', async () => {
  const r = await endurance((i) => {
    if (i === 4) throw new Error('disk full');
    return i !== 7;
  }, { runs: 10 });
  assert.equal(r.failures, 2);
  assert.equal(r.firstFailureAt, 5);
  assert.equal(r.survived, 8);
  assert.deepEqual(r.errors, ['disk full']);
  assert.ok(r.score < 1);
});

test('endurance: a clean run is penalised for having few runs (rule of three)', async () => {
  const small = await endurance(() => true, { runs: 10 });
  const big = await endurance(() => true, { runs: 1000 });
  assert.equal(small.failures, 0);
  assert.ok(big.score > small.score, 'more clean runs should score higher');
  assert.ok(Math.abs(small.ruleOfThreeBound - 0.3) < 1e-9);
});

test('grader: refuses to grade its own output', () => {
  assert.throws(() => createGrader({ generatorId: 'mesh-a', graderId: 'mesh-a', judge: async () => ({ score: 1 }) }), /same AI/);
  assert.throws(() => createGrader({ generatorId: 'mesh-a', judge: async () => ({ score: 1 }) }), /needs an id/);
});

test('grader: uncalibrated grades come back null, never filled in', async () => {
  const g = createGrader({ generatorId: 'a', graderId: 'b', judge: async () => ({ score: 0.9, reason: 'fine' }) });
  const ev = await g.grade({ job: {}, output: 'x', dimension: 'interface' });
  assert.equal(ev.score, null);
  assert.match(ev.detail, /uncalibrated/);
});

test('grader: calibration passes only when agreement with gold reaches the threshold', async () => {
  const gold = [
    { job: {}, output: 'a', dimension: 'honesty', score: 0.9 },
    { job: {}, output: 'b', dimension: 'honesty', score: 0.2 },
    { job: {}, output: 'c', dimension: 'honesty', score: 0.5 },
    { job: {}, output: 'd', dimension: 'honesty', score: 0.8 },
  ];
  const good = createGrader({ generatorId: 'a', graderId: 'b', gold, judge: async ({ output }) => ({ score: { a: 0.9, b: 0.25, c: 0.5, d: 0.1 }[output] }) });
  assert.equal((await good.calibrate()).calibrated, false); // d is off by 0.7, so 3 of 4 agree = 0.75 < 0.8
  const better = createGrader({ generatorId: 'a', graderId: 'b', gold, minAgreement: 0.7, judge: async ({ output }) => ({ score: { a: 0.9, b: 0.25, c: 0.5, d: 0.1 }[output] }) });
  assert.equal((await better.calibrate()).calibrated, true);
  const ev = await better.grade({ job: {}, output: 'a', dimension: 'honesty' });
  assert.equal(typeof ev.score, 'number');
  assert.ok(ev.score >= 0 && ev.score <= 1);
});

test('ledger: appends, reads back, skips malformed lines, and rotates when full', () => {
  const dir = tmp();
  const ledger = openLedger(dir, { maxBytes: 200 });
  for (let i = 0; i < 10; i++) ledger.append({ n: i, pad: 'x'.repeat(40) });
  fs.appendFileSync(ledger.file, 'not json\n');
  const { records, malformed } = ledger.read();
  assert.equal(malformed, 1);
  // Rotation keeps one old file, so older records are dropped on purpose (bounded disk). The newest must survive.
  assert.ok(records.length < 10, `kept ${records.length}`);
  assert.equal(records.at(-1).n, 9);
  assert.ok(fs.existsSync(ledger.file + '.1'), 'old file rotated');
});

test('exportTraining: only SCORED, gate-clean, calibrated, non-self-graded, above threshold', () => {
  const good = { job: { prompt: 'p' }, output: 'o', generatorId: 'a', graderId: 'b', graderCalibrated: true, report: { verdict: 'SCORED', overall: 0.9, gatesFailed: [], gatesUngraded: [], dimensions: { works: { score: 1 }, interface: { score: null } } } };
  const uncal = { ...good, graderCalibrated: false };
  const selfGraded = { ...good, graderId: 'a' };
  const lowScore = { ...good, report: { ...good.report, overall: 0.3 } };
  const noGate = { ...good, report: { ...good.report, gatesUngraded: ['security'] } };
  const { pairs, skipped } = exportTraining([good, uncal, selfGraded, lowScore, noGate]);
  assert.equal(pairs.length, 1);
  assert.equal(skipped, 4);
  assert.deepEqual(pairs[0].scores, { works: 1 });
});

test('learnability: needs enough rounds, then reports the change', () => {
  const rec = (kind, overall) => ({ job: { kind }, report: { verdict: 'SCORED', overall } });
  assert.equal(learnability([rec('k', 0.5)]).delta, null);
  const recs = [...Array(10).fill(0.4), ...Array(10).fill(0.7)].map((o) => rec('k', o));
  const l = learnability(recs, { window: 10 });
  assert.ok(Math.abs(l.delta - 0.3) < 1e-9);
});

test('findCycles: finds a two-file loop and ignores a straight chain', () => {
  const g = new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['c', new Set(['a'])], ['d', new Set()]]);
  const cycles = findCycles(g);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].sort(), ['a', 'b']);
});

test('measureTree: finds a cycle, a third-party import, a builtin that is allowed, and an oversize file', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.mjs'), "import { b } from './b.mjs';\nimport fs from 'node:fs';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(root, 'b.mjs'), "export { a } from './a.mjs';\n");
  fs.writeFileSync(path.join(root, 'c.mjs'), "import left from 'left-pad';\n");
  fs.writeFileSync(path.join(root, 'big.mjs'), 'x\n'.repeat(900));
  const m = measureTree(root);
  assert.equal(m.files, 4);
  assert.equal(m.filesInCycles, 2);
  assert.equal(m.thirdPartyImportCount, 1);
  assert.equal(m.thirdPartyImports[0].spec, 'left-pad');
  assert.equal(m.filesOverSize, 1);
  assert.ok(m.scores.repo_hygiene < 1);
  assert.ok(m.scores.organization < 1);
});

test('rateJob: runs checks and durability, leaves AI dimensions ungraded without a grader, and records to the ledger', async () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  const rec = await rateJob({ job: sampleJob, generator: demoGenerator, ledger, round: 0 });
  assert.equal(rec.report.dimensions.works.score, 1);
  assert.ok(['good', 'fair'].includes(rec.report.dimensions.durability.status), rec.report.dimensions.durability.status);
  assert.equal(rec.report.dimensions.interface.status, 'ungraded');
  assert.ok(rec.report.gatesUngraded.includes('security'), 'security has no check here, so it must be reported as ungraded');
  assert.equal(ledger.read().records.length, 1);
  assert.equal(exportTraining([rec]).pairs.length, 0, 'an ungraded gate must never reach training');
});

test('rateJob: a grader that is not the generator fills the AI dimensions once calibrated', async () => {
  const gold = [{ job: {}, output: 'o', dimension: 'interface', score: 0.8 }];
  const grader = createGrader({ generatorId: 'generator', graderId: 'second-mesh', gold, minAgreement: 0.5, judge: async () => ({ score: 0.8, reason: 'clear' }) });
  const rec = await rateJob({ job: sampleJob, generator: demoGenerator, grader });
  assert.equal(rec.graderCalibrated, true);
  assert.equal(rec.report.dimensions.interface.score, 0.8);
});
