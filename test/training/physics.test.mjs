/**
 * Tests for the walking physics sim (training/physics/).
 * Node's built-in runner:  node --test "test/training/*.test.mjs"
 * Offline and deterministic. The one slow check (does training really teach it to walk?) only runs when
 * NEUROCLAW_SLOW_TESTS=1, because it takes about a minute on four cores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const P = '../../training/physics/';
const { PhysicsWorld } = await import(P + 'world.mjs');
const { buildCreature, MUSCLES } = await import(P + 'body.mjs');
const env = await import(P + 'env.mjs');
const { WalkEnv, rollout, OBS_SIZE, ACT_SIZE } = env;
const { MLP, paramCount, DEFAULT_SIZES, noiseFor } = await import(P + 'policy.mjs');
const es = await import(P + 'es.mjs');
const { makePoolEvaluator } = await import(P + 'eval-pool.mjs');
const { audit } = await import(P + 'play.mjs');

const G = 9.81;
const zeros = () => new Float64Array(ACT_SIZE);

// ---------- the physics ----------

test('a dropped point falls the way gravity says, lands on the plane and stays there', () => {
  const w = new PhysicsWorld({ damping: 0 });
  const i = w.addPoint(0, 1, 0, 1, 0.03, 0.8);
  for (let s = 0; s < 9; s++) w.step(); // 0.3 s
  const analytic = 1 - 0.5 * G * 0.3 * 0.3;
  assert.ok(Math.abs(w.y[i] - analytic) < 0.012, `y ${w.y[i]} vs ${analytic}`);
  for (let s = 0; s < 60; s++) w.step();
  assert.ok(Math.abs(w.y[i] - 0.03) < 1e-9, 'rests on the plane at its radius');
  assert.ok(Math.abs(w.vy[i]) < 1e-9, 'and is not moving');
  assert.equal(w.contact[i], 1);
});

test('nothing ever goes below the ground, however hard the muscles pull', () => {
  const { world: w, creature: c } = buildCreature();
  const u = zeros();
  let lowest = Infinity;
  for (let t = 0; t < 900; t++) {
    for (let k = 0; k < MUSCLES; k++) u[k] = Math.sin(t * 0.37 + k * 1.3) > 0 ? 1 : -1; // violent
    c.drive(u); w.step();
    for (let i = 0; i < w.n; i++) lowest = Math.min(lowest, w.y[i] - w.radius[i]);
  }
  assert.ok(lowest > -1e-9, `a point went ${lowest} m into the ground`);
  assert.ok(w.isFinite());
});

test('sliding friction is Coulomb friction: a sliding foot stops where v^2 / (2 mu g) says', () => {
  for (const mu of [0.2, 0.5, 0.8, 1.2]) {
    const w = new PhysicsWorld({ damping: 0 });
    const i = w.addPoint(0, 0.03, 0, 1, 0.03, mu);
    w.vx[i] = 2;
    for (let s = 0; s < 300; s++) w.step();
    const expected = (2 * 2) / (2 * mu * G);
    assert.ok(Math.abs(w.x[i] - expected) / expected < 0.03, `mu ${mu}: slid ${w.x[i]}, expected ${expected}`);
    assert.equal(w.vx[i], 0, 'and it stays stopped');
  }
});

test('a muscle moves no faster than its speed limit, and pulls no harder than its strength', () => {
  const w = new PhysicsWorld({});
  const a = w.addPoint(0, 5, 0, 1000, 0.01), b = w.addPoint(0.5, 5, 0, 1, 0.01);
  w.invMass[a] = 0; // pinned in the air
  const m = w.addMuscle(a, b, { maxForce: 50, rate: 0.4, length: 0.5 });
  w.setMuscle(m, 0.1);
  const before = w.rest[m];
  w.step();
  assert.ok(before - w.rest[m] <= 0.4 * w.dt + 1e-12, 'rest length changed faster than the rate');
  let peak = 0;
  for (let s = 0; s < 60; s++) { w.step(); peak = Math.max(peak, Math.abs(w.force[m])); }
  assert.ok(peak <= 50 * 1.001, `muscle force ${peak} N exceeded its 50 N limit`);
});

test('a bone is rigid: a standing creature keeps every bone within 1% for 20 seconds', () => {
  const { world: w, creature: c } = buildCreature();
  c.drive(zeros());
  let worst = 0;
  for (let t = 0; t < 600; t++) { w.step(); worst = Math.max(worst, w.maxBondError()); }
  assert.ok(worst < 0.01, `a bone stretched ${(worst * 100).toFixed(2)}%`);
});

test('the creature stands still on its own for 20 seconds, feet down', () => {
  const { world: w, creature: c } = buildCreature();
  c.drive(zeros());
  for (let t = 0; t < 600; t++) w.step();
  c.frame();
  assert.ok(c.position()[1] > 0.4, 'sagged');
  assert.ok(c.uy > 0.98, 'tilted');
  for (let f = 0; f < 4; f++) assert.equal(c.footContact(f), 1);
  assert.ok(Math.hypot(...c.velocity()) < 0.01);
});

test('energy is not created: a creature dropped onto the plane never has more energy than it started with', () => {
  const { world: w, creature: c } = buildCreature({ x: 0 });
  for (let i = 0; i < w.n; i++) { w.y[i] += 0.3; w.py[i] += 0.3; }
  c.drive(zeros());
  const e0 = w.energy();
  let top = -Infinity;
  for (let t = 0; t < 300; t++) { w.step(); top = Math.max(top, w.energy()); }
  assert.ok(top <= e0 * 1.001, `energy rose from ${e0} to ${top}`);
});

test('muscle commands that are NaN, infinite or huge cannot break the world', () => {
  const { world: w, creature: c } = buildCreature();
  const bad = [NaN, Infinity, -Infinity, 1e9, -1e9, undefined, 0.5, -0.5];
  for (let t = 0; t < 120; t++) { c.drive(bad); w.step(); }
  assert.ok(w.isFinite());
  for (let k = 0; k < MUSCLES; k++) assert.ok(Math.abs(c.controls[k]) <= 1);
});

test('the same seed and policy give exactly the same run; a different seed does not', () => {
  const net = new MLP().init(5);
  for (let i = 0; i < net.params.length; i++) net.params[i] += 0.3 * Math.sin(i); // not the standing net
  const a = rollout(net, new WalkEnv(), 11), b = rollout(net, new WalkEnv(), 11), c = rollout(net, new WalkEnv(), 12);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

// ---------- the task ----------

test('observations are the right size, finite, and stay within [-2, 2] through a wild episode', () => {
  const e = new WalkEnv({ seconds: 10 });
  let obs = e.reset(3);
  assert.equal(obs.length, OBS_SIZE);
  const u = zeros();
  for (let t = 0; t < 300; t++) {
    for (let k = 0; k < ACT_SIZE; k++) u[k] = Math.sin(t * 0.3 + k);
    const r = e.step(u);
    for (const v of r.obs) assert.ok(Number.isFinite(v) && v >= -2 && v <= 2, `obs value ${v}`);
    if (r.done) break;
  }
});

test('the creature is never told where it is in the world: shifting the whole scene changes nothing it feels', () => {
  const a = new WalkEnv(), b = new WalkEnv();
  const oa = Float64Array.from(a.reset(4)), ob = (() => {
    b.reset(4);
    const w = b.world;
    for (let i = 0; i < w.n; i++) { w.x[i] += 25; w.px[i] += 25; w.z[i] -= 40; w.pz[i] -= 40; }
    b.goalX += 25; b.goalZ -= 40;
    b.creature.frame();
    return Float64Array.from(b._observe());
  })();
  for (let i = 0; i < OBS_SIZE; i++) assert.ok(Math.abs(ob[i] - oa[i]) < 1e-9, `sense ${i}: ${oa[i]} vs ${ob[i]}`);
});

test('arriving at the goal pays a bonus and puts a new goal somewhere else', () => {
  const e = new WalkEnv();
  e.reset(2);
  const p = e.creature.position();
  const old = [e.goalX, e.goalZ];
  e.goalX = p[0] + 0.1; e.goalZ = p[2];
  e.prevDist = e._goalDistance();
  const r = e.step(zeros());
  assert.equal(e.goalsReached, 1);
  assert.ok(r.reward > e.cfg.goalBonus - 0.5, `reward ${r.reward}`);
  assert.ok(Math.hypot(e.goalX - p[0], e.goalZ - p[2]) > e.cfg.goalMin - 0.2, 'new goal is far again');
  assert.notDeepEqual([e.goalX, e.goalZ], old);
});

test('walking toward the goal earns reward, walking away costs it', () => {
  const e = new WalkEnv();
  e.reset(6);
  const w = e.world, cr = e.creature;
  const gx = e.goalX, gz = e.goalZ;
  const p = cr.position();
  const d = Math.hypot(gx - p[0], gz - p[2]);
  const ux = (gx - p[0]) / d, uz = (gz - p[2]) / d;
  const shove = (s) => { for (let i = 0; i < w.n; i++) { w.x[i] += ux * s; w.z[i] += uz * s; w.px[i] += ux * s; w.pz[i] += uz * s; } };
  shove(0.2);
  const toward = e.step(zeros()).reward;
  shove(-0.5);
  const away = e.step(zeros()).reward;
  assert.ok(toward > 0.1 && away < -0.2, `toward ${toward}, away ${away}`);
});

test('falling over ends the episode and costs the fall penalty', () => {
  const e = new WalkEnv({ fallUp: 2 }); // anything counts as down
  e.reset(1);
  const r = e.step(zeros());
  assert.equal(r.done, true);
  assert.equal(e.fell, true);
  assert.ok(r.reward < -e.cfg.fallPenalty + 0.1, `reward ${r.reward}`); // the penalty, plus a sliver of progress/effort
});

test('a bone stretched past the sanity limit ends the episode as a broken world, not a trick', () => {
  const e = new WalkEnv({ maxStretch: 0 });
  e.reset(1);
  e.world.x[0] += 0.5; // tear the skeleton
  const r = e.step(zeros());
  assert.equal(e.broke, true);
  assert.equal(r.done, true);
});

// ---------- bytes, no tokenizer ----------

test('observations and actions round-trip through plain bytes', () => {
  const e = new WalkEnv();
  const o = e.reset(8);
  const bytes = env.encodeObservation(o);
  assert.ok(bytes instanceof Uint8Array && bytes.length === OBS_SIZE);
  const back = env.decodeObservation(bytes);
  for (let i = 0; i < OBS_SIZE; i++) assert.ok(Math.abs(back[i] - o[i]) <= 4 / 255 / 2 + 1e-12, `obs ${i}`);

  const act = Float64Array.from({ length: ACT_SIZE }, (_, i) => Math.sin(i) * 0.9);
  const ab = env.encodeAction(act);
  const ar = env.decodeAction(ab);
  for (let i = 0; i < ACT_SIZE; i++) assert.ok(Math.abs(ar[i] - act[i]) <= 1 / 255 + 1e-12, `act ${i}`);
  assert.ok(Math.abs(env.decodeAction(new Uint8Array(ACT_SIZE).fill(255))[0] - 1) < 1e-12);
  assert.ok(Math.abs(env.decodeAction(new Uint8Array(ACT_SIZE).fill(0))[0] + 1) < 1e-12);
});

test('a brain that only sees and writes bytes can drive the creature', () => {
  const e = new WalkEnv({ seconds: 2 });
  let obs = e.reset(1);
  const brain = (bytes) => new Uint8Array(ACT_SIZE).fill(128); // a "mesh" that only reads and writes bytes
  for (let t = 0; t < 60; t++) {
    const r = e.step(env.decodeAction(brain(env.encodeObservation(obs))));
    obs = r.obs;
    if (r.done) break;
  }
  assert.ok(e.stats().steps >= 60 && !e.fell);
});

// ---------- the policy and the trainer ----------

test('policy: checkpoint round-trips, bad checkpoints are refused, outputs stay in [-1, 1]', () => {
  const net = new MLP().init(2);
  net.params.forEach((_, i) => { net.params[i] += Math.cos(i) * 2; });
  const again = MLP.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
  const obs = Float64Array.from({ length: OBS_SIZE }, (_, i) => Math.sin(i));
  const a = net.act(obs, zeros()), b = again.act(obs, zeros());
  for (let i = 0; i < ACT_SIZE; i++) { assert.ok(Math.abs(a[i] - b[i]) < 1e-4); assert.ok(Math.abs(a[i]) <= 1); }
  assert.equal(net.params.length, paramCount(DEFAULT_SIZES));
  assert.throws(() => MLP.fromJSON({ sizes: [OBS_SIZE, 4, ACT_SIZE], params: [1, 2, 3] }));
  assert.throws(() => MLP.fromJSON({ sizes: [5, 4, 2], params: new Array(paramCount([5, 4, 2])).fill(0) }));
  assert.throws(() => MLP.fromJSON(null));
});

test('a fresh network outputs zero, so the first thing it does is stand', () => {
  const out = new MLP().init(1).act(Float64Array.from({ length: OBS_SIZE }, (_, i) => Math.cos(i)), zeros());
  assert.ok(out.every((v) => v === 0));
});

test('noise comes from its seed alone, so workers never need it sent', () => {
  const a = noiseFor(123, new Float64Array(50)), b = noiseFor(123, new Float64Array(50)), c = noiseFor(124, new Float64Array(50));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const big = noiseFor(9, new Float64Array(20000));
  const mean = big.reduce((s, v) => s + v, 0) / big.length;
  const sd = Math.sqrt(big.reduce((s, v) => s + (v - mean) ** 2, 0) / big.length);
  assert.ok(Math.abs(mean) < 0.03 && Math.abs(sd - 1) < 0.03, `mean ${mean}, sd ${sd}`);
});

test('rank shaping: one huge outlier cannot dominate', () => {
  const r = es.centeredRanks([1, 2, 3, 1e9]);
  [-0.5, -1 / 6, 1 / 6, 0.5].forEach((want, i) => assert.ok(Math.abs(r[i] - want) < 1e-12, `rank ${i}: ${r[i]}`));
});

test('the evolution trainer climbs a problem whose answer is known (so the optimizer itself is right)', async () => {
  // A stand-in "world" for the trainer: score is higher the closer the weights are to a hidden target.
  const sizes = [2, 3, 1];
  const n = paramCount(sizes);
  const target = Float64Array.from({ length: n }, (_, i) => Math.sin(i + 1) * 0.5);
  const dist = (th) => { let s = 0; for (let i = 0; i < n; i++) s += (th[i] - target[i]) ** 2; return -s; };
  const evaluator = {
    async evaluate({ theta, sigma, jobs }) {
      const eps = new Float64Array(n), trial = new Float64Array(n), out = new Float64Array(jobs.length);
      jobs.forEach((j, k) => { noiseFor(j.noiseSeed, eps); for (let i = 0; i < n; i++) trial[i] = theta[i] + j.sign * sigma * eps[i]; out[k] = dist(trial); });
      return out;
    },
    close() {},
  };
  const start = new MLP(sizes); // all zeros
  const before = dist(start.params);
  const net = await es.train({ sizes, evaluator, generations: 150, pairs: 8, sigma: 0.1, lr: 0.05, decay: 0, seed: 4 });
  const after = dist(net.params);
  assert.ok(after > before * 0.05, `distance only fell from ${-before} to ${-after}`);
});

test('worker threads give exactly the same scores as one thread', async () => {
  const sizes = DEFAULT_SIZES;
  const theta = new MLP(sizes).init(3).params;
  for (let i = 0; i < theta.length; i += 7) theta[i] += 0.05;
  const jobs = [];
  for (let j = 0; j < 4; j++) jobs.push({ noiseSeed: 100 + j, sign: 1 }, { noiseSeed: 100 + j, sign: -1 });
  const task = { theta, sigma: 0.1, jobs, seeds: [21, 22], envOptions: { seconds: 6 } };
  const local = await es.makeLocalEvaluator(sizes, null).evaluate(task);
  const pool = makePoolEvaluator(sizes, null, 2);
  try {
    const threaded = await pool.evaluate(task);
    assert.deepEqual(Array.from(threaded), Array.from(local));
  } finally { pool.close(); }
});

test('the audit reports a standing creature as standing: no travel, no slide, no stretch', () => {
  const r = audit({ act: (o, out) => out.fill(0) }, 1, { seconds: 5 });
  assert.equal(r.fell, false);
  assert.ok(Math.abs(r.distance) < 0.05);
  assert.ok(r.audit.maxStretchPct < 1);
  assert.ok(r.audit.footSlideSpeed < 0.01);
  assert.ok(r.audit.airbornePct < 2);
});

test('SLOW: training teaches it to walk to goals without falling (NEUROCLAW_SLOW_TESTS=1)', { skip: process.env.NEUROCLAW_SLOW_TESTS !== '1' }, async () => {
  const sizes = DEFAULT_SIZES;
  const pool = makePoolEvaluator(sizes, null, 4);
  const ramp = 80;
  let net;
  try {
    net = await es.train({
      sizes, evaluator: pool, generations: 150, pairs: 24, episodes: 2, seed: 1,
      curriculum: (g) => ({ goalAngle: Math.min(1, (g - 1) / ramp) * Math.PI }),
    });
  } finally { pool.close(); }
  const e = new WalkEnv();
  let dist = 0, falls = 0;
  const seeds = [9001, 9002, 9003, 9004];
  for (const s of seeds) { const r = rollout(net, e, s); dist += r.distance; if (r.fell) falls++; }
  const untrained = rollout(new MLP(sizes).init(1), e, 9001).distance;
  assert.ok(dist / seeds.length > 6, `only ${dist / seeds.length} m toward goals per 20 s episode`);
  assert.ok(dist / seeds.length > untrained + 5);
  assert.ok(falls <= 1, `${falls} of ${seeds.length} fell`);
});
