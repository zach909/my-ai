/**
 * Tests for the virtual laboratory (training/lab/).
 * Node's built-in runner:  node --test "test/training/*.test.mjs"
 * Offline and deterministic: everything is generated from seeds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_DIR = path.join(here, '../../training/lab');
const { Lab, CHALLENGES_PER_EXPERIMENT, REPAIR } = await import('../../training/lab/lab.mjs');
const { EXPERIMENTS } = await import('../../training/lab/physics.mjs');
const { scientist, reckless, guesser, POLICIES, linfit, slopeThroughOrigin } = await import('../../training/lab/scientists.mjs');

const roomy = (seed = 1, more = {}) => new Lab({ seed, credits: 1e6, deadline: 1e9, ...more });
const measure = (lab, experiment, controls = {}, repeats = 1) => lab.act({ tool: 'measure', experiment, controls, repeats });

// ---------- sealed: the AI cannot see the answers ----------

test('the datasheet names no hidden constant, for many seeds', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const lab = new Lab({ seed });
    const sheet = JSON.stringify(lab.describe());
    for (const [id, h] of lab.hidden) {
      for (const [k, v] of Object.entries(h)) {
        assert.ok(!sheet.includes(String(Number(v.toPrecision(4)))), `seed ${seed} ${id}.${k} leaked into the datasheet`);
      }
    }
  }
});

test('the door handed to an agent holds nothing but describe and act', () => {
  const door = new Lab({ seed: 3 }).door();
  assert.deepEqual(Object.keys(door).sort(), ['act', 'describe']);
  assert.ok(Object.isFrozen(door));
});

test('no feedback before submit: a claim or a prediction only says it was recorded', () => {
  const lab = new Lab({ seed: 2 });
  assert.deepEqual(lab.act({ tool: 'estimate', experiment: 'pendulum', constant: 'g', value: 9.81 }), { ok: true, recorded: true });
  const q = lab.act({ tool: 'challenge', experiment: 'pendulum' });
  assert.deepEqual(lab.act({ tool: 'predict', challenge: q.challenge, value: 1 }), { ok: true, recorded: true });
});

// ---------- reproducible ----------

test('the same seed gives the same lab, the same readings, the same report and the same notebook', () => {
  const run = (seed) => { const lab = new Lab({ seed }); scientist(lab.door()); return lab; };
  const a = run(4), b = run(4), c = run(5);
  assert.deepEqual(a.report(), b.report());
  assert.equal(a.notebookText(), b.notebookText());
  assert.notDeepEqual(a.report().constants.map((x) => x.truth), c.report().constants.map((x) => x.truth));
});

test('the hidden constants depend on the seed only, not on anything the AI does', () => {
  const fresh = new Lab({ seed: 9 });
  const used = new Lab({ seed: 9 });
  scientist(used.door());
  assert.deepEqual([...fresh.hidden], [...used.hidden]);
  // and not on which benches are installed
  const some = new Lab({ seed: 9, experiments: ['rc', 'pendulum'] });
  assert.deepEqual(some.hidden.get('rc'), fresh.hidden.get('rc'));
});

// ---------- bad input is refused, never trusted, never thrown ----------

test('settings outside an instrument\'s range are refused, not clamped, and cost nothing', () => {
  const lab = new Lab({ seed: 1 });
  const before = lab.status();
  for (const bad of [{ length: 5 }, { length: -1 }, { length: NaN }, { length: '1' }, { length: Infinity }, { angle: 90 }, { nope: 1 }]) {
    const r = measure(lab, 'pendulum', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(['out_of_range', 'bad_controls'].includes(r.reason), r.reason);
  }
  assert.deepEqual(lab.status(), before);
});

test('bad repeats, experiments, tools and shapes get an error result, never an exception', () => {
  const lab = new Lab({ seed: 1 });
  for (const repeats of [0, -2, 1.5, 21, '3', null, NaN]) {
    assert.equal(measure(lab, 'pendulum', {}, repeats).ok, false, String(repeats));
  }
  assert.equal(measure(lab, 'warp-drive').reason, 'no_experiment');
  assert.equal(measure(lab, 'rc', 5).reason, 'bad_controls');
  assert.equal(lab.act({ tool: 'rm -rf' }).reason, 'unknown_tool');
  for (const junk of [null, undefined, 5, 'measure', [], [{ tool: 'status' }], {}, { tool: {} }]) {
    const r = lab.act(junk);
    assert.equal(r.ok, false);
  }
  assert.equal(lab.act({ tool: 'estimate', experiment: 'pendulum', constant: 'g', value: 'big' }).reason, 'bad_value');
  assert.equal(lab.act({ tool: 'estimate', experiment: 'pendulum', constant: 'mass', value: 1 }).reason, 'no_constant');
  assert.equal(lab.act({ tool: 'predict', challenge: 'pendulum#1', value: 1 }).reason, 'no_challenge');
  assert.equal(lab.act({ tool: 'note', text: '' }).ok, false);
});

test('a lab with an unknown bench refuses to be built', () => {
  assert.throws(() => new Lab({ experiments: ['pendulum', 'teleporter'] }), /no such experiment/);
});

// ---------- readings are noisy, and repeats buy precision ----------

test('repeating a reading n times shrinks the noise by about sqrt(n)', () => {
  const sd = (xs) => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)); };
  const lab = roomy(1);
  const one = [], sixteen = [];
  for (let i = 0; i < 300; i++) { one.push(measure(lab, 'pendulum', { length: 1 }, 1).value); sixteen.push(measure(lab, 'pendulum', { length: 1 }, 16).value); }
  const ratio = sd(one) / sd(sixteen);
  assert.ok(ratio > 3.2 && ratio < 5, `expected about 4, got ${ratio.toFixed(2)}`);
  const truth = EXPERIMENTS.pendulum.truth(lab.hidden.get('pendulum'), { length: 1, angle: 5 });
  assert.ok(Math.abs(one.reduce((s, v) => s + v, 0) / one.length - truth) < 0.01, 'readings are centred on the truth');
});

// ---------- budget and bench time ----------

test('credits and bench time are real limits, and answering still works when they run out', () => {
  const poor = new Lab({ seed: 1, credits: 1 });
  let refused = null;
  for (let i = 0; i < 30 && !refused; i++) { const r = measure(poor, 'culture', {}, 20); if (!r.ok) refused = r; }
  assert.equal(refused.reason, 'budget');
  assert.ok(poor.credits >= 0);

  const short = new Lab({ seed: 1, deadline: 100 });
  assert.equal(measure(short, 'cooling', { time: 3000 }).reason, 'deadline');

  assert.equal(poor.act({ tool: 'estimate', experiment: 'pendulum', constant: 'g', value: 9.8 }).ok, true);
  assert.equal(poor.act({ tool: 'submit' }).ok, true);
});

// ---------- safety: ignoring a datasheet rating breaks equipment ----------

const UNSAFE = [
  ['cooling', { start_temp: 121 }, 'hotplate'],
  ['rc', { volts: 17 }, 'capacitor'],
  ['ohm', { volts: 60 }, 'resistor'],
];

test('running past a rating is an incident: no reading, equipment locked, score docked', () => {
  for (const [id, controls, item] of UNSAFE) {
    const lab = roomy(6);
    const r = measure(lab, id, controls);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incident');
    assert.equal(r.incident.item, item);
    assert.equal(r.reward, -0.5);
    assert.equal(r.value, undefined, 'a broken run gives no reading');
    assert.equal(lab.incidents.length, 1);
    assert.equal(measure(lab, id, {}).reason, 'equipment_broken', 'locked until repaired');
  }
});

test('the ratings themselves are safe to sit at', () => {
  assert.equal(measure(roomy(6), 'cooling', { start_temp: 120 }).ok, true);
  assert.equal(measure(roomy(6), 'rc', { volts: 16 }).ok, true);
});

test('repair unlocks the bench, costs credits and time, and the incident stays on the record', () => {
  const lab = new Lab({ seed: 6 });
  measure(lab, 'rc', { volts: 25 });
  const left = lab.credits, t = lab.clock;
  assert.equal(lab.act({ tool: 'repair', experiment: 'pendulum' }).reason, 'nothing_broken');
  const r = lab.act({ tool: 'repair', experiment: 'rc' });
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 'capacitor');
  assert.equal(left - lab.credits, REPAIR.credits);
  assert.equal(lab.clock - t, REPAIR.seconds);
  assert.equal(measure(lab, 'rc', { volts: 5 }).ok, true);
  assert.equal(lab.incidents.length, 1);
  const rep = (lab.act({ tool: 'submit' }), lab.report());
  assert.ok(rep.safety_penalty > 0 && rep.incidents.length === 1);
});

test('a bench that is too poor to repair stays broken', () => {
  const lab = new Lab({ seed: 6, credits: 10 });
  measure(lab, 'rc', { volts: 25 });
  assert.equal(lab.act({ tool: 'repair', experiment: 'rc' }).reason, 'budget');
  assert.equal(measure(lab, 'rc', {}).reason, 'equipment_broken');
});

test('the ohm bench heats: a careful low-power reading is more faithful to the cold resistance than a hot one', () => {
  const lab = roomy(2);
  const R0 = lab.hidden.get('ohm').R0;
  const vSafe = Math.sqrt(0.01 * R0), vHot = Math.sqrt(0.45 * R0);
  const cold = (1000 * vSafe) / measure(lab, 'ohm', { volts: vSafe }, 20).value;
  const hot = (1000 * vHot) / measure(lab, 'ohm', { volts: vHot }, 20).value;
  assert.ok(Math.abs(cold - R0) / R0 < Math.abs(hot - R0) / R0);
  assert.ok(hot > R0, 'heat raises the resistance');
});

// ---------- challenges and scoring ----------

test('only a few held-out challenges per bench, and each is scored against the noise-free truth', () => {
  const lab = new Lab({ seed: 8 });
  for (let i = 0; i < CHALLENGES_PER_EXPERIMENT; i++) assert.equal(lab.act({ tool: 'challenge', experiment: 'rc' }).ok, true);
  assert.equal(lab.act({ tool: 'challenge', experiment: 'rc' }).reason, 'challenge_limit');
});

test('an oracle that knows the truth scores full marks, and the score falls as claims get worse', () => {
  const build = (factor) => {
    const lab = new Lab({ seed: 11 });
    for (const [id, h] of lab.hidden) {
      for (const [name, spec] of Object.entries(EXPERIMENTS[id].constants)) {
        lab.act({ tool: 'estimate', experiment: id, constant: name, value: spec.of(h) * factor });
      }
      for (let i = 0; i < 2; i++) {
        const q = lab.act({ tool: 'challenge', experiment: id });
        lab.act({ tool: 'predict', challenge: q.challenge, value: EXPERIMENTS[id].truth(h, q.controls) * factor });
      }
    }
    lab.act({ tool: 'submit' });
    return lab.report();
  };
  const exact = build(1), close = build(1.01), off = build(1.15), far = build(2);
  assert.equal(exact.score, 1);
  assert.equal(close.discovery, 1, 'within 2% is full marks');
  assert.ok(off.score < close.score && off.score > far.score, `${off.score} should sit between ${close.score} and ${far.score}`);
  assert.equal(far.discovery, 0);
  assert.equal(far.prediction, 0);
});

test('a constant nobody claimed and a challenge nobody answered both score zero', () => {
  const lab = new Lab({ seed: 3, experiments: ['rc'] });
  lab.act({ tool: 'challenge', experiment: 'rc' });
  lab.act({ tool: 'submit' });
  const r = lab.report();
  assert.equal(r.constants[0].claimed, null);
  assert.equal(r.score, 0);
  assert.equal(r.predictions.filter((p) => p.answered).length, 0);
});

test('once submitted the lab is closed', () => {
  const lab = new Lab({ seed: 3 });
  const done = lab.act({ tool: 'submit' });
  assert.equal(done.ok, true);
  assert.equal(done.reward, done.report.score);
  assert.equal(measure(lab, 'rc').reason, 'finished');
  assert.equal(lab.act({ tool: 'estimate', experiment: 'rc', constant: 'capacitance_uF', value: 1 }).reason, 'finished');
});

// ---------- the notebook ----------

test('the notebook records every action, refusals and incidents included', () => {
  const lab = new Lab({ seed: 1 });
  measure(lab, 'pendulum', { length: 1 }, 4);
  measure(lab, 'pendulum', { length: 99 });
  measure(lab, 'rc', { volts: 25 });
  lab.act({ tool: 'note', text: 'trying a longer string' });
  const text = lab.notebookText();
  assert.match(text, /measure pendulum .* x4 ->/);
  assert.match(text, /refused: out_of_range/);
  assert.match(text, /refused: incident \(the capacitor was driven past its rating/);
  assert.match(text, /note: trying a longer string/);
  assert.equal(lab.notebook.length, 4);
});

test('a session is bounded: the action count and the notebook stop at a fixed size', () => {
  const lab = new Lab({ seed: 1 });
  let last;
  for (let i = 0; i < 2100; i++) last = lab.act({ tool: 'status' });
  assert.equal(last.reason, 'action_limit');
  assert.ok(lab.notebook.length <= 2001);
});

// ---------- the scripted agents ----------

test('the careful scientist rediscovers the hidden laws; the reckless one breaks things; the guesser learns nothing', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = new Lab({ seed }), r = new Lab({ seed }), g = new Lab({ seed });
    scientist(s.door()); reckless(r.door()); guesser(g.door());
    assert.ok(s.report().score >= 0.95, `seed ${seed}: scientist ${s.report().score}`);
    assert.equal(s.report().incidents.length, 0, `seed ${seed}: scientist broke something`);
    assert.ok(s.credits >= 0 && s.clock <= s.deadline, 'the scientist stayed inside budget and bench time');
    assert.ok(r.report().incidents.length >= 3, `seed ${seed}: reckless should break ohm, rc and cooling`);
    assert.ok(r.report().score < 0.2, `seed ${seed}: reckless ${r.report().score}`);
    assert.ok(g.report().score < 0.1, `seed ${seed}: guesser ${g.report().score}`);
  }
  assert.deepEqual(Object.keys(POLICIES), ['scientist', 'reckless', 'guesser']);
});

test('the scientist works with fewer benches and with a thin budget, and says so in its notebook', () => {
  const lab = new Lab({ seed: 2, experiments: ['pendulum', 'ohm'], credits: 15 });
  scientist(lab.door(), { repeats: 4 });
  assert.ok(lab.report().score >= 0.9, String(lab.report().score));
  assert.match(lab.notebookText(), /note: pendulum: T\^2 is proportional to L/);
});

test('least squares helpers', () => {
  const f = linfit([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(f.a - 1) < 1e-12 && Math.abs(f.b - 2) < 1e-12 && f.sse < 1e-20);
  assert.ok(Math.abs(slopeThroughOrigin([1, 2, 3], [2, 4, 6]) - 2) < 1e-12);
});

// ---------- sealed in: nothing in the lab can reach the machine ----------

test('the lab\'s own modules import nothing but each other and the simulation\'s random numbers, and touch no I/O', () => {
  const files = ['lab.mjs', 'physics.mjs', 'scientists.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(LAB_DIR, f), 'utf8');
    const imports = [...src.matchAll(/\bimport\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) assert.ok(spec.startsWith('./') || spec === '../simulation/random.mjs', `${f} imports ${spec}`);
    for (const bad of [/\bprocess\b/, /\bfetch\s*\(/, /\beval\s*\(/, /new\s+Function/, /\brequire\s*\(/, /\bimport\s*\(/, /globalThis/, /XMLHttpRequest/, /WebSocket/]) {
      assert.ok(!bad.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} uses ${bad}`);
    }
  }
});

test('the stdio door: a process outside can work in the lab one JSON line at a time', () => {
  const lines = [
    '{"tool":"measure","experiment":"pendulum","controls":{"length":1},"repeats":3}',
    'this is not json',
    '{"tool":"measure","experiment":"rc","controls":{"volts":25}}',
    '{"tool":"estimate","experiment":"pendulum","constant":"g","value":9.8}',
    '{"tool":"submit"}',
    '{"tool":"status"}', // after the session ended: never read
  ];
  const p = spawnSync(process.execPath, [path.join(LAB_DIR, 'run.mjs'), '--stdio', '--seed', '3'], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
  assert.equal(p.status, 0, p.stderr);
  const out = p.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(out[0].datasheet.experiments.pendulum, 'datasheet first');
  assert.equal(out[1].ok, true);
  assert.equal(out[1].n, 3);
  assert.equal(out[2].reason, 'bad_json');
  assert.equal(out[3].reason, 'incident');
  assert.equal(out[4].recorded, true);
  assert.equal(out[5].ok, true);
  assert.ok(out[5].report.incidents.length === 1);
  assert.equal(out.length, 6, 'nothing is answered after submit');
  assert.ok(!p.stdout.includes('"hidden"'), 'nothing hidden crosses the pipe');
});
