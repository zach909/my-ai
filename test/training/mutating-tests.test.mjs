/**
 * Tests for the self-changing math exam (benchmarks/lib/mutating-tests.mjs, math-problems.mjs, math-solvers.mjs)
 * and the model-change trigger (scripts/model-change-test.mjs).
 * Node's built-in runner:  node --test "test/training/*.test.mjs"   No build step, no packages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MutatingRun, LEDGER_CAP, MAX_LEVEL } from '../../benchmarks/lib/mutating-tests.mjs';
import { buildExam, evalParts, FAMILY, T } from '../../benchmarks/lib/math-problems.mjs';
import { reference, memoriser } from '../../benchmarks/lib/math-solvers.mjs';
import { droppedBeyondChance, changeSince } from '../../scripts/model-change-test.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'mutating-tests-')), 'state.json');
const texts = (exam) => exam.test.map((p) => p.text);
const sit = (solver, items) => items.map((p) => { const s = solver.solve(p); return s !== null && Math.round(s) === p.answer; });
const rate = (a) => a.filter(Boolean).length / a.length;

test('the same seed builds the same exam; a different seed builds a different one', () => {
  const a = buildExam(new MutatingRun({ seed: 11, persist: false }), { n: 120 });
  const b = buildExam(new MutatingRun({ seed: 11, persist: false }), { n: 120 });
  const c = buildExam(new MutatingRun({ seed: 12, persist: false }), { n: 120 });
  assert.deepEqual(texts(a), texts(b));
  assert.notDeepEqual(texts(a), texts(c));
  const shared = texts(a).filter((t) => new Set(texts(c)).has(t)).length;
  assert.ok(shared < 0.5 * 120, `two seeds share ${shared} of 120 problems`);
});

test('with no seed given, each run draws a new random one', () => {
  const seeds = new Set(Array.from({ length: 20 }, () => new MutatingRun({ persist: false }).seed));
  assert.ok(seeds.size >= 19);
});

test('answers are exact, no exam problem is a taught fact, and every exam is valid for the reference solver', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = new MutatingRun({ seed, persist: false });
    const exam = buildExam(run, { n: 150 });
    assert.equal(exam.test.length, 150);
    for (const p of exam.test) assert.equal(p.answer, evalParts(p.parts));
    assert.equal(rate(sit(reference(), exam.test)), 1);
    const taught = new Set(exam.train.map((f) => `${f.a}|${f.op}|${f.b}`));
    for (const p of exam.test) if (p.parts.ops.length === 1) assert.ok(!taught.has(`${p.parts.operands[0]}|${p.parts.ops[0]}|${p.parts.operands[1]}`), p.text);
  }
});

test('a solver that only remembers the taught facts fails the exam, so remembering cannot pass it', () => {
  for (const seed of [21, 22, 23]) {
    const run = new MutatingRun({ seed, persist: false });
    const exam = buildExam(run, { n: 200 });
    const m = memoriser({ train: exam.train });
    assert.equal(rate(sit(m, exam.test)), 0);
    assert.equal(rate(sit(m, exam.seen)), 1, 'it does know what it was taught');   // so the seen-vs-fresh gap is real
  }
});

test('a problem served in one run is never served in a later run (ledger), and state survives between runs', () => {
  const path = tmp();
  const served = new Set();
  for (let i = 0; i < 4; i++) {
    const run = new MutatingRun({ seed: 100 + i, statePath: path });
    const exam = buildExam(run, { n: 150 });
    for (const t of texts(exam)) { assert.ok(!served.has(t), `served twice: ${t}`); served.add(t); }
    run.finish();
  }
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runs, 4);
  // same seed again: the old problems are retired, so the exam still comes out all new
  const again = buildExam(new MutatingRun({ seed: 100, statePath: path }), { n: 150 });
  for (const t of texts(again)) assert.ok(!served.has(t), `a retired problem came back: ${t}`);
  rmSync(path, { force: true });
});

test('the ledger is bounded', () => {
  const path = tmp();
  const run = new MutatingRun({ seed: 1, statePath: path });
  for (let i = 0; i < LEDGER_CAP + 500; i++) run.claim(`problem ${i}`);
  run.finish();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).ledger.length, LEDGER_CAP);
});

test('a recipe replays the exact exam and writes nothing', () => {
  const path = tmp();
  const first = new MutatingRun({ seed: 5, statePath: path });
  const exam1 = buildExam(first, { n: 100 });
  const recipe = first.recipe();
  first.finish();
  const replay = new MutatingRun({ recipe, statePath: path });
  const exam2 = buildExam(replay, { n: 100 });
  assert.deepEqual(texts(exam1), texts(exam2));
  const before = readFileSync(path, 'utf8');
  replay.finish();
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('levels rise when the AI passes and fall when it fails; the anchor never moves', () => {
  const path = tmp();
  let lastLevel = 1;
  for (let i = 0; i < 8; i++) {
    const run = new MutatingRun({ seed: 200 + i, statePath: path });
    const exam = buildExam(run, { n: 120 });
    for (const p of exam.test) run.record(FAMILY, { track: p.track, tags: p.tags, ok: true });      // a perfect solver
    run.finish();
    lastLevel = run.family(FAMILY).level;
  }
  assert.equal(lastLevel, MAX_LEVEL);
  const hard = new MutatingRun({ seed: 300, statePath: path });
  const exam = buildExam(hard, { n: 120 });
  assert.equal(hard.level(FAMILY, 'anchor'), 1);
  assert.ok(exam.test.some((p) => p.track === 'adaptive' && p.parts.operands.length >= 5), 'at the top level, chains get long');
  assert.ok(exam.test.filter((p) => p.track === 'anchor').every((p) => p.parts.operands.length <= 3 && !p.tags.some((t) => t.startsWith('noise:'))), 'anchor items stay at level 1');
  for (const p of exam.test) hard.record(FAMILY, { track: p.track, tags: p.tags, ok: false });       // now it fails everything
  hard.finish();
  assert.equal(hard.family(FAMILY).level, MAX_LEVEL - 1);
  rmSync(path, { force: true });
});

test('a kind the AI fails is drawn more often next time', () => {
  const path = tmp();
  for (let i = 0; i < 12; i++) {
    const run = new MutatingRun({ seed: 400 + i, statePath: path });
    const exam = buildExam(run, { n: 120 });
    for (const p of exam.test) run.record(FAMILY, { track: p.track, tags: p.tags, ok: p.kind !== 'chain' });   // fails only chains
    run.finish();
  }
  const f = new MutatingRun({ seed: 1, statePath: path }).family(FAMILY);
  assert.ok(f.weights['kind:chain'] > 2, `chain weight ${f.weights['kind:chain']}`);
  assert.ok(f.weights['kind:interp'] < 1, `interp weight ${f.weights['kind:interp']}`);
});

test('a drop in score counts as a regression only when it is bigger than chance', () => {
  assert.equal(droppedBeyondChance(0.5, 0.49, 150), false);       // noise
  assert.equal(droppedBeyondChance(0.5, 0.2, 150), true);         // a real drop
  assert.equal(droppedBeyondChance(null, 0.1, 150), false);       // no baseline yet
  assert.equal(droppedBeyondChance(0.3, 0.5, 150), false);        // better is never a regression
});

test('with no earlier tested state, a change counts as big (the first run is always taken)', () => {
  assert.equal(changeSince(null).lines, Infinity);
  assert.equal(changeSince({ sha: '0000000000000000000000000000000000000000' }).lines, Infinity);
});

test('the exam is built from numbers within T for the chain and anchor kinds', () => {
  const exam = buildExam(new MutatingRun({ seed: 9, persist: false }), { n: 200 });
  for (const p of exam.test.filter((q) => q.kind === 'chain')) assert.ok(p.parts.operands.every((x) => x >= 0 && x <= T));
});
