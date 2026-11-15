/**
 * Tests for the training simulation (training/simulation/).
 * Node's built-in runner:  node --test "test/training/*.test.mjs"
 * No browser, no build step, no packages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../../training/simulation/sim.mjs';
import { World } from '../../training/simulation/world.mjs';
import { M } from '../../training/simulation/materials.mjs';
import { ROLES, forager } from '../../training/simulation/policies.mjs';
import { observe, encodeObservation, encodeAction, decodeAction, ACTION_BYTES } from '../../training/simulation/observe.mjs';
import { renderTop } from '../../training/simulation/render.mjs';

const GROUND = 14;

/** A sim whose middle is a level arena, so scenarios start from a known stage. */
function arena(opts = {}) {
  const sim = new Simulation({ seed: 5, ...opts });
  sim.world.flatArena(40, 40, 8, GROUND);
  return sim;
}
const put = (sim, name, x, z, y = GROUND + 0.001) => sim.addAgent({ name, x, y, z });
const run = (sim, n, acts = {}) => { let r; for (let i = 0; i < n; i++) r = sim.step(typeof acts === 'function' ? acts(i) : acts); return r; };
const incidents = (sim, kind) => sim.ledger.incidents.filter((i) => !kind || i.kind === kind);
const total = (rewards, id, key) => (rewards.get(id) ? rewards.get(id)[key] : 0);
/** Count a material inside a box of voxel coordinates (inclusive). */
function countIn(w, m, [x0, y0, z0, x1, y1, z1]) {
  let c = 0;
  for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) if (w.get(ix, iy, iz) === m) c++;
  return c;
}
/** `a` steps up to `b` and hits it (a hit knocks the victim back, so a fight needs to close the gap again). */
function strike(sim, a, b) {
  a.x = b.x - 1.2; a.z = b.z; a.y = b.y; a.vx = a.vz = 0;
  const r = sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  run(sim, 6);
  return r;
}

// ---------------------------------------------------------------------------
// the world: space, resolution, time
// ---------------------------------------------------------------------------

test('the same seed makes the same world; a different seed does not', () => {
  const a = new World({ seed: 9 }), b = new World({ seed: 9 }), c = new World({ seed: 10 });
  assert.equal(a.checksum(), b.checksum());
  assert.notEqual(a.checksum(), c.checksum());
});

test('resolution changes smoothness, not the land: terrain follows the same hills at every resolution', () => {
  const err = {};
  for (const res of [0.5, 1, 2, 4]) {
    const w = new World({ seed: 3, res, size: [32, 32, 32] });
    let sum = 0, worst = 0, n = 0;
    for (let iz = 0; iz < w.nz; iz += 3) {
      for (let ix = 0; ix < w.nx; ix += 3) {
        let top = -1;
        for (let iy = w.ny - 1; iy >= 0; iy--) {
          const m = w.mat[w.idx(ix, iy, iz)];
          if (m === M.GRASS || m === M.SAND || m === M.DIRT || m === M.STONE) { top = (iy + 1) * w.vs; break; }
        }
        const e = Math.abs(top - w.heights[iz * w.nx + ix]);
        sum += e; worst = Math.max(worst, e); n++;
        assert.ok(e <= w.vs + 1e-6, `surface off by ${e} at res ${res}`);
      }
    }
    err[res] = sum / n;
  }
  assert.ok(err[4] < err[2] && err[2] < err[1] && err[1] < err[0.5], `error should shrink as resolution rises: ${JSON.stringify(err)}`);
});

test('water volume is the same lake at any resolution', () => {
  const vol = (res) => {
    const w = new World({ seed: 3, res, size: [64, 32, 64] });
    return w.countMaterial(M.WATER) * w.vs ** 3;
  };
  const v1 = vol(1), v2 = vol(2);
  assert.ok(v1 > 100, 'there should be a lake to measure');
  assert.ok(Math.abs(v1 - v2) / v1 < 0.15, `lake volumes ${v1} vs ${v2}`);
});

test('gravity: sand dropped from 5 m lands in the time physics says, at any resolution', () => {
  for (const res of [1, 2]) {
    const sim = arena({ res });
    const w = sim.world;
    const ix = w.cell(40), iz = w.cell(40);
    w.set(ix, w.cell(GROUND + 5), iz, M.SAND, 0, 0, 0);
    let ticks = 0;
    while (ticks < 60) { sim.step(); ticks++; if (w.blocks.length === 0) break; }
    const expected = Math.sqrt((2 * 5) / 9.81) / w.dt; // about 10 ticks
    assert.ok(Math.abs(ticks - expected) <= 3, `res ${res}: ${ticks} ticks, expected about ${expected.toFixed(1)}`);
    assert.equal(w.get(ix, w.cell(GROUND), iz), M.SAND, 'sand rests on the ground');
  }
});

test('sand piles up and slides rather than standing in a tower', () => {
  const sim = arena();
  const w = sim.world;
  for (let k = 0; k < 12; k++) {
    w.set(40, GROUND + 6, 40, M.SAND, 0, 0, 0);
    run(sim, 14);
  }
  run(sim, 40);
  let count = 0, wide = 0;
  for (let iz = 36; iz <= 44; iz++) for (let ix = 36; ix <= 44; ix++) if (w.get(ix, GROUND, iz) === M.SAND) { count++; if (ix !== 40 || iz !== 40) wide++; }
  assert.ok(count >= 4 && wide >= 3, `sand should spread into a pile (base ${count}, off-centre ${wide})`);
  assert.equal(w.active.size, 0, 'and then be completely still');
});

test('water falls, flows downhill, loses nothing and settles', () => {
  const sim = arena();
  const w = sim.world;
  w.fillBox(36, 37, GROUND, GROUND + 3, 36, 44, M.STONE); // a wall to pour next to
  const before = w.countMaterial(M.WATER);
  for (let k = 0; k < 8; k++) w.set(40, GROUND + 4 + k, 40, M.WATER, 0, 0, 0);
  run(sim, 400);
  assert.equal(w.countMaterial(M.WATER) - before, 8, 'no water created or destroyed');
  assert.equal(w.active.size, 0, 'settled');
  let highest = 0;
  for (let iy = GROUND; iy < GROUND + 12; iy++) for (let iz = 30; iz < 50; iz++) for (let ix = 30; ix < 50; ix++) if (w.get(ix, iy, iz) === M.WATER) highest = Math.max(highest, iy);
  assert.ok(highest <= GROUND + 1, 'eight cubes of water should be lying on the ground, not stacked up');
});

test('fire spreads through fuel, burns out, and is put out by water', () => {
  const sim = arena();
  const w = sim.world;
  const block = [40, GROUND, 40, 43, GROUND + 3, 43];
  w.fillBox(40, 44, GROUND, GROUND + 4, 40, 44, M.LEAVES);
  const fuel = countIn(w, M.LEAVES, block);
  assert.equal(fuel, 64);
  w.ignite(40, GROUND, 40, 0);
  run(sim, 800);
  assert.ok(countIn(w, M.LEAVES, block) < fuel * 0.15, `most of the fuel burned (${countIn(w, M.LEAVES, block)} of ${fuel} left)`);
  assert.equal(w.countMaterial(M.FIRE), 0, 'and the fire went out by itself');
  assert.equal(w.active.size, 0);

  // fire next to water is put out
  const sim2 = arena();
  const w2 = sim2.world;
  w2.set(40, GROUND, 40, M.WATER, 0, 0, 0);
  w2.set(41, GROUND, 40, M.FIRE, 0, 100, 0);
  run(sim2, 2);
  assert.equal(w2.get(41, GROUND, 40), M.AIR);
});

test('lava turns to stone when water meets it', () => {
  const sim = arena();
  const w = sim.world;
  w.set(40, GROUND, 40, M.LAVA, 0, 0, 0);
  w.set(41, GROUND, 40, M.WATER, 0, 0, 0);
  run(sim, 12);
  assert.equal(w.get(40, GROUND, 40), M.STONE);
});

test('sparks carry fire across a gap', () => {
  const sim = arena({ seed: 2 });
  const w = sim.world;
  w.fillBox(32, 38, GROUND, GROUND + 3, 38, 44, M.LEAVES); // a big fire...
  w.fillBox(40, 42, GROUND, GROUND + 2, 34, 48, M.LEAVES); // ...and a wall of fuel two metres away, not touching
  assert.equal(countIn(w, M.LEAVES, [38, GROUND, 34, 39, GROUND + 2, 48]), 0, 'a real gap');
  w.ignite(32, GROUND, 38, 0);
  let reached = false;
  for (let t = 0; t < 1500 && !reached; t++) {
    sim.step();
    reached = countIn(w, M.FIRE, [40, GROUND, 34, 41, GROUND + 1, 48]) > 0;
  }
  assert.ok(reached, 'a spark should have jumped the gap');
});

// ---------------------------------------------------------------------------
// only what is needed
// ---------------------------------------------------------------------------

test('a world nobody is near, and nothing is moving in, costs nothing', () => {
  const sim = new Simulation({ seed: 4 });
  run(sim, 100);
  assert.equal(sim.world.stats.voxelUpdates, 0);
  assert.equal(sim.world.stats.awakeChunks, 0);
  assert.equal(sim.world.particles.alive, 0);
});

test('only chunks near an agent are awake, and a far chunk is left alone', () => {
  const sim = new Simulation({ seed: 4, size: [128, 32, 128], interestRadius: 20 });
  sim.addAgent({ name: 'a', ...sim.world.findSpawn(sim.rng, 20, 20, 2) });
  run(sim, 3);
  assert.ok(sim.world.stats.awakeChunks > 0);
  assert.ok(sim.world.stats.awakeChunks < sim.world.chunkLast.length / 3, 'most of a big world sleeps');
});

test('physics cost follows activity: voxel updates stop when things settle', () => {
  const sim = arena();
  const w = sim.world;
  w.set(40, GROUND + 6, 40, M.SAND, 0, 0, 0);
  const costs = [];
  for (let k = 0; k < 60; k++) { sim.step(); costs.push(w.stats.voxelUpdates); }
  assert.ok(Math.max(...costs) <= 8, 'one grain is a handful of updates, not a world scan');
  assert.equal(costs.slice(-10).reduce((a, b) => a + b, 0), 0);
});

test('a chunk that slept catches up on the time it missed when someone returns', () => {
  const sim = arena({ interestRadius: 20 });
  const w = sim.world;
  const spots = [];
  for (let k = 0; k < 24; k++) {
    const ix = 4 + (k % 8), iz = 50 + Math.floor(k / 8);
    const iy = w.topSolid(ix, iz) + 1;
    if (w.get(ix, iy, iz) === M.AIR && w.get(ix, iy - 1, iz) !== M.WATER) { w.mat[w.idx(ix, iy, iz)] = M.BUSH_BARE; spots.push([ix, iy, iz]); }
  }
  assert.ok(spots.length >= 12);
  const a = put(sim, 'a', 40, 40);
  run(sim, 3000);
  const ripe = () => spots.filter(([x, y, z]) => w.get(x, y, z) === M.BUSH_RIPE).length;
  assert.equal(ripe(), 0, 'nothing grows where nobody is');
  a.x = 8; a.z = 51; a.y = w.topSolid(8, 51) * w.vs + w.vs + 0.001;
  run(sim, 3);
  assert.ok(ripe() >= spots.length * 0.8, `time passed there: ${ripe()}/${spots.length} ripe on return`);
});

test('particles live in a fixed pool and cannot grow without bound', () => {
  const sim = arena({ world: { particles: 64 } });
  const w = sim.world;
  put(sim, 'a', 40, 40);
  w.fillBox(41, 47, GROUND, GROUND + 5, 41, 47, M.LEAVES);
  w.ignite(41, GROUND, 41, 0);
  for (let t = 0; t < 300; t++) { sim.step(); assert.ok(w.particles.alive <= 64); }
});

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

test('an agent walks at about walking speed, stays on the ground and is stopped by a wall', () => {
  const sim = arena();
  const a = put(sim, 'a', 36.5, 40.5);
  sim.world.fillBox(44, 45, GROUND, GROUND + 3, 32, 48, M.STONE);
  const x0 = a.x;
  run(sim, 20, { [a.id]: { move: { dx: 1, dz: 0 } } });
  assert.ok(a.x - x0 > 5 && a.x - x0 < 9, `moved ${(a.x - x0).toFixed(2)} m in 2 s`);
  assert.ok(Math.abs(a.y - GROUND) < 0.02);
  run(sim, 40, { [a.id]: { move: { dx: 1, dz: 0 } } });
  assert.ok(a.x + a.hw <= 44 + 1e-6, 'does not walk through stone');
  assert.ok(a.x > 43, 'but gets right up to it');
});

test('an agent steps up a one-voxel ledge and can jump about 1.25 m', () => {
  for (const res of [1, 2]) {
    const sim = arena({ res });
    const w = sim.world;
    const a = put(sim, 'a', 38.5, 40.5);
    w.fillBox(42, 48, GROUND, GROUND + w.vs, 32, 48, M.STONE); // a ledge one voxel high
    run(sim, 20, { [a.id]: { move: { dx: 1, dz: 0 } } });
    assert.ok(a.x > 43.5 && a.x < 48, `res ${res}: climbed onto the ledge (x=${a.x.toFixed(2)})`);
    assert.ok(a.y >= GROUND + w.vs - 0.05);
  }
  const sim = arena();
  const a = put(sim, 'a', 38.5, 40.5);
  run(sim, 3);
  let apex = 0;
  sim.step({ [a.id]: { move: { dx: 0, dz: 0, jump: true } } });
  for (let t = 0; t < 12; t++) { sim.step(); apex = Math.max(apex, a.y - GROUND); }
  assert.ok(apex > 1.0 && apex < 1.5, `jump apex ${apex.toFixed(2)} m`);
});

test('falling hurts by how far you fell, and a short drop does not', () => {
  const sim = arena();
  const hi = sim.addAgent({ name: 'hi', x: 38.5, y: GROUND + 10, z: 40.5 });
  const lo = sim.addAgent({ name: 'lo', x: 42.5, y: GROUND + 1.5, z: 40.5 });
  run(sim, 40);
  assert.ok(hi.health < 85 && hi.health > 55, `10 m fall left ${hi.health.toFixed(1)}`);
  assert.ok(lo.health > 99, 'a 1.5 m drop is harmless');
  assert.equal(sim.ledger.incidents.length, 0, 'gravity is nobody\'s fault');
});

test('water: you can swim and breathe at the surface, you walk at half speed, and you drown if you sink', () => {
  const pool = () => {
    const sim = arena();
    sim.world.fillBox(36, 46, 8, GROUND, 36, 46, M.AIR);
    sim.world.fillBox(36, 46, 8, GROUND, 36, 46, M.WATER); // a pool six metres deep
    return sim;
  };
  let sim = pool();
  const swimmer = sim.addAgent({ name: 'swimmer', x: 40.5, y: GROUND + 0.001, z: 40.5 });
  run(sim, 200, { [swimmer.id]: { move: { dx: 0, dz: 0, jump: true } } });
  assert.equal(swimmer.health, 100, 'kept its head up');
  assert.equal(swimmer.air, 10);

  sim = pool();
  const sinker = sim.addAgent({ name: 'sinker', x: 40.5, y: GROUND + 0.001, z: 40.5 });
  run(sim, 200);
  assert.ok(sinker.y < 9, 'sank to the bottom');
  assert.ok(sinker.health < 90, `drowning hurts (${sinker.health.toFixed(1)})`);
  assert.equal(sim.ledger.incidents.length, 0, 'and nobody is to blame for a lake');

  sim = pool();
  const wader = sim.addAgent({ name: 'wader', x: 37.5, y: 8.001, z: 40.5 });
  run(sim, 10, { [wader.id]: { move: { dx: 1, dz: 0 } } });
  const land = arena();
  const walker = land.addAgent({ name: 'walker', x: 37.5, y: GROUND + 0.001, z: 40.5 });
  run(land, 10, { [walker.id]: { move: { dx: 1, dz: 0 } } });
  assert.ok(Math.abs(wader.vx / walker.vx - 0.5) < 0.1, `water ${wader.vx.toFixed(2)} vs land ${walker.vx.toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

test('mining collects, placing builds and counts as structure, and amounts scale with voxel size', () => {
  for (const res of [1, 2]) {
    const sim = arena({ res });
    const a = put(sim, 'a', 40.5, 40.5);
    const w = sim.world;
    run(sim, 3);
    sim.step({ [a.id]: { do: { type: 'mine', at: [1, -1, 0] } } });
    assert.ok(a.lastResult.ok, a.lastResult.reason);
    assert.ok(Math.abs(a.inv.dirt - w.vs ** 3) < 1e-9, `one voxel of grass gives one voxel-load of dirt (${a.inv.dirt})`);
    sim.step({ [a.id]: { do: { type: 'place', item: 'dirt', at: [1, -1, 0] } } });
    assert.ok(a.lastResult.ok);
    assert.equal(w.built.get(a.id), 1);
    assert.equal(a.inv.dirt, undefined, 'spent exactly what it placed');
  }
});

test('you cannot mine bedrock, reach too far, or place where someone stands', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5);
  const b = put(sim, 'b', 41.5, 40.5);
  run(sim, 3);
  a.add('dirt', 5);
  sim.step({ [a.id]: { do: { type: 'mine', at: [0, -14, 0] } } });
  assert.equal(a.lastResult.ok, false);
  sim.step({ [a.id]: { do: { type: 'mine', at: [7, -1, 0] } } });
  assert.equal(a.lastResult.reason, 'too far');
  sim.step({ [a.id]: { do: { type: 'place', item: 'dirt', at: [1, 0, 0] } } });
  assert.equal(a.lastResult.reason, 'someone is there');
  void b;
});

test('berries: harvest regrows, eating feeds, seeds plant new bushes', () => {
  const sim = arena();
  const w = sim.world;
  const a = put(sim, 'a', 40.5, 40.5);
  w.set(42, GROUND, 40, M.BUSH_RIPE, 0, 0, 0);
  a.satiety = 20;
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'harvest', at: [2, 0, 0] } } });
  assert.ok(a.lastResult.ok);
  assert.equal(w.get(42, GROUND, 40), M.BUSH_BARE, 'the bush stays, bare');
  sim.step({ [a.id]: { do: { type: 'eat' } } });
  assert.ok(a.satiety > 55, `ate: ${a.satiety}`);
  a.add('seed', 1);
  sim.step({ [a.id]: { do: { type: 'place', item: 'seed', at: [-2, 0, 0] } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  assert.equal(w.get(38, GROUND, 40), M.BUSH_BARE);
  assert.equal(w.getOwner(38, GROUND, 40), a.id, 'the planter owns the crop');
});

test('wood becomes planks and starvation hurts but is nobody\'s fault', () => {
  const sim = arena({ hungerSeconds: 20 });
  const a = put(sim, 'a', 40.5, 40.5);
  a.add('wood', 2);
  sim.step({ [a.id]: { do: { type: 'craft', recipe: 'planks', amount: 1.5 } } });
  assert.ok(Math.abs(a.inv.planks - 1.5) < 1e-9 && Math.abs(a.inv.wood - 0.5) < 1e-9);
  run(sim, 400);
  assert.ok(a.health < 100 || !a.alive);
  assert.equal(sim.ledger.incidents.length, 0);
});

// ---------------------------------------------------------------------------
// harm is punished, wherever it comes from
// ---------------------------------------------------------------------------

test('hitting someone costs the hitter reward and not the victim', () => {
  const sim = arena({ justice: { mode: 'none' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  run(sim, 3);
  const r = sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  assert.ok(a.lastResult.ok);
  assert.ok(Math.abs(b.health - 92) < 0.2, `health ${b.health}`);
  assert.ok(total(r.rewards, a.id, 'harm') < 0);
  assert.equal(total(r.rewards, b.id, 'harm'), 0);
  assert.equal(incidents(sim, 'attack').length, 1);
  assert.ok(sim.ledger.reputation(a.id) < 0);
});

test('harm that arrives by an indirect route is traced back to whoever set it off', () => {
  // 1. sand dropped from above
  let sim = arena({ justice: { mode: 'none' } });
  let a = put(sim, 'a', 38.5, 40.5), b = put(sim, 'b', 40.5, 40.5);
  a.add('sand', 1);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'place', item: 'sand', at: [2, 3, 0] } } });
  run(sim, 25);
  assert.ok(b.health < 70);
  assert.deepEqual(incidents(sim, 'block').map((i) => [i.actor, i.victim]), [[a.id, b.id]]);

  // 2. pulling the floor out from under someone who then falls
  sim = arena({ justice: { mode: 'none' } });
  sim.world.fillBox(38, 41, GROUND + 7, GROUND + 8, 40, 41, M.STONE); // a little floating bridge, 7 m up
  a = sim.addAgent({ name: 'a', x: 38.5, y: GROUND + 8.001, z: 40.5 });
  b = sim.addAgent({ name: 'b', x: 40.5, y: GROUND + 8.001, z: 40.5 });
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'mine', at: [2, -1, 0] } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  run(sim, 25);
  assert.ok(b.health < 85, `b fell and was hurt (${b.health})`);
  assert.deepEqual(incidents(sim, 'fall').map((i) => [i.actor, i.victim]), [[a.id, b.id]]);

  // 3. a fire lit next to someone
  sim = arena({ justice: { mode: 'none' } });
  a = put(sim, 'a', 38.5, 40.5); b = put(sim, 'b', 41.5, 40.5);
  a.add('wood', 1);
  sim.world.fillBox(41, 42, GROUND, GROUND + 1, 40, 41, M.AIR);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'ignite', at: [3, 0, 0] } } });
  run(sim, 60);
  assert.ok(b.health < 100 || b.burn > 0);
  assert.ok(incidents(sim, 'fire').every((i) => i.actor === a.id && i.victim === b.id) && incidents(sim, 'fire').length >= 1);
});

test('shoving someone off a ledge is on the shover, and so is flooding someone', () => {
  // knocked off a high platform: the hit, and then the fall, are both the attacker's doing
  let sim = arena({ justice: { mode: 'none' } });
  sim.world.fillBox(38, 42, GROUND + 7, GROUND + 8, 39, 42, M.STONE); // a platform seven metres up
  let a = sim.addAgent({ name: 'a', x: 40.4, y: GROUND + 8.001, z: 40.5 });
  let b = sim.addAgent({ name: 'b', x: 41.6, y: GROUND + 8.001, z: 40.5 });
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  run(sim, 30);
  assert.ok(b.health < 80, `went over the edge (${b.health.toFixed(1)})`);
  assert.deepEqual(incidents(sim).map((i) => [i.kind, i.actor, i.victim]).sort(), [['attack', a.id, b.id], ['fall', a.id, b.id]]);

  // water poured into a pit someone is standing in
  sim = arena({ justice: { mode: 'none' } });
  const w = sim.world;
  w.fillBox(42, 43, GROUND - 3, GROUND, 40, 41, M.AIR); // a one-metre-wide pit, three deep
  a = put(sim, 'a', 40.5, 40.5);
  b = sim.addAgent({ name: 'b', x: 42.5, y: GROUND - 3 + 0.001, z: 40.5 });
  a.add('water', 3);
  run(sim, 3);
  for (let k = 0; k < 3; k++) { sim.step({ [a.id]: { do: { type: 'place', item: 'water', at: [2, 0, 0] } } }); assert.ok(a.lastResult.ok, a.lastResult.reason); }
  run(sim, 200);
  assert.ok(b.health < 85, `b drowned a little (${b.health.toFixed(1)})`);
  assert.deepEqual(incidents(sim, 'drown').map((i) => [i.actor, i.victim]).slice(0, 1), [[a.id, b.id]]);
});

test('fire that spreads to someone else\'s house is arson, charged to whoever lit it', () => {
  const sim = arena({ justice: { mode: 'none' } });
  const a = put(sim, 'a', 38.5, 40.5), b = put(sim, 'b', 30.5, 30.5);
  const w = sim.world;
  w.fillBox(41, 44, GROUND, GROUND + 2, 40, 41, M.AIR);
  for (let ix = 42; ix < 45; ix++) w.set(ix, GROUND, 40, M.PLANKS, b.id, 0, 0); // b's wall
  a.add('wood', 1);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'ignite', at: [4, 0, 0] } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  run(sim, 400);
  const arson = incidents(sim, 'property');
  assert.ok(arson.length >= 1 && arson.every((i) => i.actor === a.id && i.victim === b.id));
});

test('breaking, picking or taking what belongs to someone is harm; common things are free', () => {
  const sim = arena({ justice: { mode: 'none' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 30.5, 30.5);
  const w = sim.world;
  w.set(42, GROUND, 40, M.PLANKS, b.id, 0, 0);
  w.set(40, GROUND, 42, M.BUSH_RIPE, b.id, 0, 0);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'mine', at: [0, -1, 3] } } }); // natural grass nearby
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  assert.equal(incidents(sim).length, 0, 'digging the commons harms nobody');
  sim.step({ [a.id]: { do: { type: 'mine', at: [2, 0, 0] } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  assert.deepEqual(incidents(sim, 'property').map((i) => [i.actor, i.victim]), [[a.id, b.id]]);
  sim.step({ [a.id]: { do: { type: 'harvest', at: [0, 0, 2] } } });
  assert.deepEqual(incidents(sim, 'theft').map((i) => [i.actor, i.victim]), [[a.id, b.id]]);
  // taking from a pack
  const c = put(sim, 'c', 41.5, 40.5);
  c.add('berries', 2);
  sim.step({ [a.id]: { do: { type: 'take', target: c.id, item: 'berries', amount: 1 } } });
  assert.ok(a.lastResult.ok);
  assert.equal(incidents(sim, 'theft').length, 2);
  assert.ok(Math.abs(c.inv.berries - 1) < 1e-9);
});

test('hitting back in a fight someone else started is self-defence: it counts for much less and is not prosecuted', () => {
  const sim = arena({ justice: { mode: 'automatic' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  a.add('planks', 5);
  b.add('planks', 5);
  run(sim, 3);
  const first = sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  run(sim, 6);
  const back = sim.step({ [b.id]: { do: { type: 'attack', target: a.id } } });
  const [i1, i2] = incidents(sim, 'attack');
  assert.equal(i1.selfDefense, false);
  assert.equal(i2.selfDefense, true);
  assert.equal(i2.status, 'dismissed');
  assert.equal(i1.status, 'prosecuted');
  assert.ok(Math.abs(total(back.rewards, b.id, 'harm')) < Math.abs(total(first.rewards, a.id, 'harm')) * 0.3);
  assert.ok(sim.ledger.reputation(b.id) > sim.ledger.reputation(a.id));
});

// ---------------------------------------------------------------------------
// kindness is never punished
// ---------------------------------------------------------------------------

test('giving is rewarded, more when the need is real, and is never an incident', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5), hungry = put(sim, 'h', 41.5, 40.5), full = put(sim, 'f', 39.5, 40.5);
  a.add('berries', 2);
  hungry.satiety = 15;
  full.satiety = 100;
  run(sim, 3);
  const r1 = sim.step({ [a.id]: { do: { type: 'give', target: hungry.id, item: 'berries', amount: 1 } } }).rewards;
  const r2 = sim.step({ [a.id]: { do: { type: 'give', target: full.id, item: 'berries', amount: 1 } } }).rewards;
  const toHungry = total(r1, a.id, 'kindness'), toFull = total(r2, a.id, 'kindness');
  assert.ok(toHungry > 0 && toFull > 0);
  assert.ok(toHungry > toFull * 3, `${toHungry} vs ${toFull}`);
  assert.equal(sim.ledger.incidents.length, 0);
  assert.ok(sim.ledger.reputation(a.id) > 0);
  assert.ok(Math.abs(hungry.inv.berries - 1) < 1e-9);
});

test('swapping the same gift back and forth cannot be farmed', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 41.5, 40.5);
  a.add('berries', 1);
  a.satiety = 20; b.satiety = 20;
  run(sim, 3);
  let first = 0, sum = 0;
  for (let k = 0; k < 40; k++) {
    const giver = k % 2 ? b : a, taker = k % 2 ? a : b;
    const r = sim.step({ [giver.id]: { do: { type: 'give', target: taker.id, item: 'berries' } } });
    const got = total(r.rewards, giver.id, 'kindness');
    if (k === 0) first = got;
    sum += got;
  }
  assert.ok(first > 0);
  assert.ok(sum < first * 3, `40 swaps earned ${sum.toFixed(3)}, a single gift earned ${first.toFixed(3)}`);
});

test('a purely generous society is never sanctioned', () => {
  const sim = arena({ justice: { mode: 'automatic' } });
  const people = [put(sim, 'a', 38.5, 40.5), put(sim, 'b', 40.5, 40.5), put(sim, 'c', 42.5, 40.5)];
  people.forEach((p, i) => { p.add('berries', 3); p.satiety = 30 + i * 20; });
  run(sim, 3);
  for (let k = 0; k < 30; k++) {
    const g = people[k % 3], t = people[(k + 1) % 3];
    sim.step({ [g.id]: { do: { type: 'give', target: t.id, item: 'berries', amount: 0.2 } } });
  }
  assert.equal(sim.ledger.incidents.length, 0);
  assert.equal(sim.justice.counts.prosecuted, 0);
  assert.equal(sim.justice.counts.jailed, 0);
  for (const p of people) assert.ok(sim.ledger.reputation(p.id) > 0);
});

// ---------------------------------------------------------------------------
// justice
// ---------------------------------------------------------------------------

test('automatic law: a first small offence pays the victim back and nothing more', () => {
  const sim = arena({ justice: { mode: 'automatic' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  a.add('planks', 5);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  const inc = incidents(sim, 'attack')[0];
  assert.equal(inc.status, 'prosecuted');
  assert.ok(Math.abs(inc.sanction.restitution - 8) < 1e-6, 'made whole to the value of the harm');
  assert.equal(inc.sanction.jail, 0);
  assert.ok(b.inv.planks > 0.6 && a.inv.planks < 4.4);
  assert.equal(sim.justice.isJailed(a), false);
});

test('automatic law: repeat offending ends in jail; prisoners cannot hit, cannot dig out, are fed, and are released', () => {
  const sim = arena({ justice: { mode: 'automatic' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  a.add('planks', 50);
  run(sim, 3);
  for (let k = 0; k < 4 && !sim.justice.isJailed(a); k++) strike(sim, a, b);
  assert.ok(sim.justice.isJailed(a), 'a repeat attacker is jailed');
  const j = sim.world.jail;
  assert.ok(Math.abs(a.x - j.x) < 3 && Math.abs(a.z - j.z) < 3, 'inside the cell');
  assert.equal(sim.justice.record(a.id).convictions >= 3, true);

  sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  assert.equal(a.lastResult.reason, 'in jail');

  const [x0, y0, z0, x1, y1, z1] = sim.world.jail.box;
  a.satiety = 5;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const left = a.jailedUntil - sim.tick;
  for (let t = 0; t < Math.min(left - 2, 300); t++) {
    const d = dirs[Math.floor(t / 10) % 4];
    sim.step({ [a.id]: { move: { dx: d[0], dz: d[1], jump: t % 7 === 0 }, do: { type: 'mine', at: [d[0] * 2, 0, d[1] * 2] } } });
    assert.ok(a.x > x0 && a.x < x1 && a.z > z0 && a.z < z1 && a.y > y0 && a.y < y1, 'never leaves the cell');
  }
  assert.ok(a.satiety >= 30 - 1e-9, 'fed in jail');
  run(sim, left + 5);
  assert.equal(sim.justice.isJailed(a), false, 'released when the time is served');
  assert.ok(Math.hypot(a.x - j.x, a.z - j.z) > 5, 'and back outside');
});

test('reported law: nothing happens until someone speaks up, then the court checks the facts', () => {
  const sim = arena({ justice: { mode: 'reported' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5), w = put(sim, 'w', 44.5, 40.5), far = put(sim, 'far', 20.5, 20.5);
  a.add('planks', 5);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  const inc = incidents(sim, 'attack')[0];
  assert.equal(inc.status, 'open');
  assert.deepEqual(inc.witnesses, [w.id]);
  run(sim, 50);
  assert.equal(a.inv.planks, 5, 'no report, no sanction');

  assert.equal(sim.justice.accuse(far.id, a.id, inc.id).reason, 'not a party to it');
  assert.equal(sim.justice.accuse(w.id, w.id === far.id ? b.id : b.id, inc.id).reason, 'false accusation');
  assert.equal(sim.justice.counts.perjury, 1);
  assert.ok(sim.justice.isJailed(w), 'a false accuser is sanctioned');
  assert.equal(inc.status, 'open', 'and the real incident is still open');

  const ok = sim.justice.accuse(b.id, a.id, inc.id);
  assert.ok(ok.ok);
  assert.equal(inc.status, 'prosecuted');
  assert.ok(a.inv.planks < 5 && b.inv.planks > 0);
  assert.equal(sim.justice.accuse(b.id, a.id, inc.id).reason, 'incident is prosecuted');
});

test('reported law: a witness can accuse when the victim cannot, and old incidents expire', () => {
  const sim = arena({ justice: { mode: 'reported', reportWindow: 100 } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5), w = put(sim, 'w', 44.5, 40.5);
  run(sim, 3);
  strike(sim, a, b);
  sim.step({ [w.id]: { do: { type: 'accuse', target: a.id, incident: 1 } } });
  assert.ok(w.lastResult.ok, w.lastResult.reason);
  assert.equal(incidents(sim, 'attack')[0].status, 'prosecuted');
  a.jailedUntil = 0; // out again, to offend once more
  a.x = b.x - 1.2; a.z = b.z; a.y = b.y;
  strike(sim, a, b);
  run(sim, 150);
  const stale = incidents(sim, 'attack').find((i) => i.status === 'open');
  assert.equal(sim.justice.accuse(b.id, a.id, stale.id).reason, 'too late to report');
});

test('debts are paid by giving, which is not rewarded as kindness; forgiving is rewarded and wipes them', () => {
  const sim = arena({ justice: { mode: 'automatic' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  run(sim, 3);
  strike(sim, a, b); // a owns nothing: the harm stays a debt
  assert.ok(sim.justice.debtOf(a.id) > 7);
  run(sim, 100); // a short sentence for the unpaid debt, served
  assert.equal(sim.justice.isJailed(a), false);
  a.x = b.x - 1.5; a.z = b.z; a.y = b.y;
  a.add('berries', 0.5);
  const r = sim.step({ [a.id]: { do: { type: 'give', target: b.id, item: 'berries' } } });
  assert.ok(a.lastResult.ok, a.lastResult.reason);
  assert.ok(a.lastResult.debtPaid > 5, `paid ${a.lastResult.debtPaid}`);
  assert.equal(total(r.rewards, a.id, 'kindness'), 0, 'repaying what you owe is not generosity');
  assert.ok(sim.justice.debtOf(a.id) < 3);
  const r2 = sim.step({ [b.id]: { do: { type: 'forgive', target: a.id } } });
  assert.ok(b.lastResult.ok);
  assert.equal(sim.justice.debtOf(a.id), 0);
  assert.ok(total(r2.rewards, b.id, 'kindness') > 0);
});

test('no courts: harm is still scored but nobody is sanctioned', () => {
  const sim = arena({ justice: { mode: 'none' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  a.add('planks', 5);
  run(sim, 3);
  for (let k = 0; k < 5; k++) strike(sim, a, b);
  assert.ok(sim.ledger.stat(a.id).harmDone >= 40, `harm ${sim.ledger.stat(a.id).harmDone}`);
  assert.equal(a.inv.planks, 5);
  assert.equal(sim.justice.counts.jailed, 0);
});

test('killing is the heaviest harm, the dead lose their goods and come back', () => {
  const sim = arena({ justice: { mode: 'none' } });
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 42, 40.5);
  b.health = 5;
  b.add('ore', 1);
  run(sim, 3);
  sim.step({ [a.id]: { do: { type: 'attack', target: b.id } } });
  assert.equal(b.alive, false);
  assert.deepEqual(b.inv, {});
  const death = incidents(sim, 'death')[0];
  assert.ok(death && death.harm >= 100 && death.actor === a.id);
  run(sim, 60);
  assert.equal(b.alive, true);
  assert.equal(b.health, 100);
});

// ---------------------------------------------------------------------------
// bytes for the mesh
// ---------------------------------------------------------------------------

test('an agent\'s view is local, knows who owns what, and shrinks at night', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5), b = put(sim, 'b', 43.5, 40.5);
  sim.world.set(41, GROUND, 40, M.PLANKS, b.id, 0, 0);
  sim.world.set(39, GROUND, 40, M.PLANKS, a.id, 0, 0);
  run(sim, 3);
  const obs = observe(sim, a, true);
  const { radius, size, mat, rel } = obs.view;
  const at = (dx, dy, dz) => ((dy + radius) * size + (dz + radius)) * size + (dx + radius);
  assert.equal(size, 2 * radius + 1);
  assert.equal(mat[at(0, -1, 0)], M.GRASS);
  assert.equal(mat[at(1, 0, 0)], M.PLANKS);
  assert.equal(rel[at(1, 0, 0)], 2, 'someone else\'s');
  assert.equal(rel[at(-1, 0, 0)], 1, 'mine');
  assert.equal(obs.agents.length, 1);
  assert.equal(obs.agents[0].id, b.id);
  assert.ok(Math.abs(obs.agents[0].dx - 3) < 0.1);
  sim.tick = Math.round((sim.cfg.dayLength / sim.cfg.dt) * 0.0) + 1; // time of day with the sun low
  let night = null;
  for (let t = 0; t < sim.cfg.dayLength / sim.cfg.dt; t += 50) { sim.tick = t; if (sim.daylight < 0.2) { night = observe(sim, a, true); break; } }
  assert.ok(night, 'there is a night');
  assert.ok(night.view.mat.includes(255), 'far voxels are unknown in the dark');
});

test('actions survive a round trip through bytes', () => {
  const acts = [
    { move: { dx: 1, dz: -0.5, jump: true } },
    { move: { dx: 0, dz: 0 }, do: { type: 'mine', at: [1, -1, 2] } },
    { move: { dx: 0, dz: 0 }, do: { type: 'place', item: 'planks', at: [-3, 0, 1] } },
    { move: { dx: 0, dz: 0 }, do: { type: 'give', target: 7, item: 'berries', amount: 3 } },
    { move: { dx: 0, dz: 0 }, do: { type: 'accuse', target: 12, incident: 345 } },
    { move: { dx: 0, dz: 0 }, do: { type: 'attack', target: 2 } },
  ];
  for (const a of acts) {
    const bytes = encodeAction(a);
    assert.equal(bytes.length, ACTION_BYTES);
    const back = decodeAction(bytes, 1);
    assert.equal(back.move.jump, !!a.move.jump);
    assert.ok(Math.abs(back.move.dx - a.move.dx) < 0.02 && Math.abs(back.move.dz - a.move.dz) < 0.02);
    if (a.do) assert.deepEqual(back.do, a.do);
    else assert.equal(back.do, undefined);
  }
});

test('observations flatten to bytes of a known size with the right contents', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5);
  a.add('berries', 2);
  a.satiety = 64;
  run(sim, 3);
  const obs = observe(sim, a, true);
  const bytes = encodeObservation(obs);
  const S = obs.view.size;
  assert.equal(bytes.length, 20 + 8 * 9 + 4 * 6 + 2 * S * S * S);
  assert.equal(bytes[1], S);
  assert.equal(bytes[6], 64);
  assert.equal(bytes[9 + 8], 2, 'two voxel-loads of berries');
  assert.deepEqual([...bytes.slice(-S * S * S * 2, -S * S * S)], [...obs.view.mat]);
});

test('a byte-driven agent can act: decoded bytes run through the same simulation', () => {
  const sim = arena();
  const a = put(sim, 'a', 40.5, 40.5);
  run(sim, 3);
  const act = decodeAction(encodeAction({ move: { dx: 0, dz: 0 }, do: { type: 'mine', at: [1, -1, 0] } }), sim.world.vs);
  sim.step({ [a.id]: act });
  assert.ok(a.lastResult.ok);
  assert.ok(a.inv.dirt > 0);
});

// ---------------------------------------------------------------------------
// the whole thing
// ---------------------------------------------------------------------------

function society(opts, ticks) {
  const sim = new Simulation({ seed: 21, ...opts });
  ['forager', 'builder', 'forager', 'brawler', 'thief', 'builder'].forEach((role, i) => sim.addAgent({ name: `${role}${i}`, policy: ROLES[role]() }));
  for (let t = 0; t < ticks; t++) sim.stepPolicies();
  return sim;
}

test('a mixed society runs, stays sane, and is deterministic', () => {
  const run1 = society({}, 1500), run2 = society({}, 1500);
  assert.equal(run1.world.checksum(), run2.world.checksum());
  assert.equal(JSON.stringify(run1.summary()), JSON.stringify(run2.summary()));
  assert.notEqual(society({ seed: 22 }, 300).world.checksum(), run1.world.checksum());
  for (const a of run1.agents.values()) {
    for (const v of [a.x, a.y, a.z, a.vx, a.vy, a.vz, a.health, a.satiety]) assert.ok(Number.isFinite(v));
    assert.ok(a.health >= 0 && a.health <= 100 && a.satiety >= 0 && a.satiety <= 100);
    for (const u of Object.values(a.inv)) assert.ok(u > 0);
    assert.ok(a.x >= 0 && a.x <= 64 && a.z >= 0 && a.z <= 64);
  }
  const s = run1.summary();
  assert.ok(s.builtVoxels > 0, 'someone built something');
  assert.ok(s.incidents > 0, 'the brawler and thief did harm');
});

test('courts calm a society down: the same crowd does far less harm with courts than without', () => {
  const none = society({ justice: { mode: 'none' } }, 2500).summary();
  const law = society({ justice: { mode: 'automatic' } }, 2500).summary();
  assert.ok(law.harm < none.harm * 0.6, `harm with courts ${law.harm}, without ${none.harm}`);
  assert.ok(law.jailings > 0 && none.jailings === 0);
});

test('every resolution runs the same society without falling over', () => {
  for (const res of [0.5, 2]) {
    const sim = society({ res }, 400);
    assert.ok(sim.alive().length >= 5, `res ${res}`);
    for (const a of sim.agents.values()) assert.ok(Number.isFinite(a.x) && a.y > 0);
  }
});

test('training mode: a policy-controlled agent gets per-tick rewards and observations', () => {
  const sim = arena();
  const a = sim.addAgent({ name: 'learner', x: 40.5, y: GROUND + 0.001, z: 40.5, policy: forager() });
  sim.world.set(43, GROUND, 40, M.BUSH_RIPE, 0, 0, 0);
  let total_ = 0;
  for (let t = 0; t < 300; t++) total_ += sim.stepPolicies().rewards.get(a.id).total;
  assert.ok(total_ > 0 && Number.isFinite(total_));
  assert.ok((a.inv.berries || 0) > 0 || a.satiety > 90, 'the scripted forager found the bush');
});

test('the ASCII renderer draws the map', () => {
  const sim = arena();
  put(sim, 'a', 40.5, 40.5);
  const map = renderTop(sim, 64);
  assert.equal(map.split('\n').length, 64);
  assert.ok(map.includes('A'));
});
