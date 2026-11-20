/**
 * Scripted stand-in policies. These are NOT the thing being trained; they are
 * simple fixed behaviours used to exercise the world and to seed it with a
 * mix of characters (helpers, builders, bullies, thieves) so the ledger and
 * the courts have something to do. A policy is `(obs, rng, mem) => action`.
 */
import { M } from './materials.mjs';

const dist3 = (a, b, c) => Math.hypot(a, b, c);

/** Voxels in view that match, nearest first, as offsets plus metres from the agent. */
export function findVoxels(obs, pred) {
  const { size, radius, voxel, mat, rel } = obs.view;
  const [bx, by, bz] = obs.self.cell;
  const out = [];
  let k = 0;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++, k++) {
        if (!pred(mat[k], rel[k], dx, dy, dz, k)) continue;
        const mx = (bx + dx + 0.5) * voxel - obs.self.x;
        const my = (by + dy + 0.5) * voxel - (obs.self.y + 1.6);
        const mz = (bz + dz + 0.5) * voxel - obs.self.z;
        out.push({ dx, dy, dz, mx, mz, d: dist3(mx, my, mz) });
      }
  return out.sort((a, b) => a.d - b.d);
}

function viewAt(obs, dx, dy, dz) {
  const { radius, size, mat } = obs.view;
  if (Math.abs(dx) > radius || Math.abs(dy) > radius || Math.abs(dz) > radius) return 255;
  return mat[((dy + radius) * size + (dz + radius)) * size + (dx + radius)];
}

/** Walk toward a point (metres, relative). Jump when stuck against something. */
function walk(obs, mem, mx, mz, stopAt = 0.5) {
  const d = Math.hypot(mx, mz);
  const stuck = mem.px !== undefined && Math.hypot(obs.self.x - mem.px, obs.self.z - mem.pz) < 0.03 && mem.moving;
  mem.px = obs.self.x; mem.pz = obs.self.z;
  if (d <= stopAt) { mem.moving = false; return { dx: 0, dz: 0, jump: false }; }
  mem.moving = true;
  return { dx: mx / d, dz: mz / d, jump: stuck || obs.self.inWater };
}

function wander(obs, rng, mem) {
  if (mem.heading === undefined || rng.chance(0.04)) mem.heading = rng.range(0, Math.PI * 2);
  return walk(obs, mem, Math.cos(mem.heading) * 5, Math.sin(mem.heading) * 5, 0);
}

export function wanderer() {
  return (obs, rng, mem) => ({ move: wander(obs, rng, mem) });
}

/** Gathers berries, eats, plants seeds, shares food with the hungry. */
export function forager({ share = true } = {}) {
  return (obs, rng, mem) => {
    const me = obs.self, inv = me.inventory, vs = obs.view.voxel, load = vs ** 3;
    if (obs.law.jailed) return { move: wander(obs, rng, mem) };
    if (me.satiety < 60 && (inv.berries || 0) > 1e-9) return { do: { type: 'eat' } };
    if (share && (inv.berries || 0) >= load * 1.5) {
      const hungry = obs.agents.find((a) => a.satiety < 35 && a.dist < 3.5 && !a.jailed);
      if (hungry) return { do: { type: 'give', target: hungry.id, item: 'berries', amount: (inv.berries || 0) / 2 } };
    }
    const reach = 4.0;
    // ripe bushes that are natural or mine (a decent forager does not pick other people's crops)
    const ripe = findVoxels(obs, (m, r) => m === M.BUSH_RIPE && r !== 2)[0];
    if (ripe) {
      if (ripe.d <= reach) return { move: { dx: 0, dz: 0 }, do: { type: 'harvest', at: [ripe.dx, ripe.dy, ripe.dz] } };
      return { move: walk(obs, mem, ripe.mx, ripe.mz, 1) };
    }
    if ((inv.seed || 0) >= load - 1e-9 && me.satiety > 50) {
      const spot = findVoxels(obs, (m, r, dx, dy, dz) =>
        m === M.AIR && viewAt(obs, dx, dy - 1, dz) === M.GRASS && (Math.abs(dx) >= 1 || Math.abs(dz) >= 1) && Math.abs(dy) <= 1,
      ).find((v) => v.d <= reach);
      if (spot) return { do: { type: 'place', item: 'seed', at: [spot.dx, spot.dy, spot.dz] } };
    }
    return { move: wander(obs, rng, mem) };
  };
}

/** Collects wood, makes planks and raises a low wall around where it started. */
export function builder({ radius = 2, height = 1 } = {}) {
  return (obs, rng, mem) => {
    const me = obs.self, inv = me.inventory, vs = obs.view.voxel, load = vs ** 3;
    if (obs.law.jailed) return { move: wander(obs, rng, mem) };
    if (me.satiety < 40 && (inv.berries || 0) > 1e-9) return { do: { type: 'eat' } };
    const [bx, by, bz] = (mem.home ??= me.cell.slice());
    if (!mem.plan) {
      const R = Math.max(2, Math.round(radius / vs));
      mem.plan = [];
      for (let h = 0; h < Math.max(1, Math.round(height / vs)); h++)
        for (let dz = -R; dz <= R; dz++)
          for (let dx = -R; dx <= R; dx++)
            if (Math.max(Math.abs(dx), Math.abs(dz)) === R) mem.plan.push([bx + dx, by + h, bz + dz]);
    }
    if ((inv.planks || 0) >= load - 1e-9) {
      const next = mem.plan[0];
      if (!next) return { move: wander(obs, rng, mem) };
      const at = [next[0] - me.cell[0], next[1] - me.cell[1], next[2] - me.cell[2]];
      const cx = (next[0] + 0.5) * vs - me.x, cz = (next[2] + 0.5) * vs - me.z;
      if (Math.hypot(cx, cz) > 3.5) return { move: walk(obs, mem, (bx + 0.5) * vs - me.x, (bz + 0.5) * vs - me.z, 0.3) };
      const there = viewAt(obs, at[0], at[1], at[2]);
      if (there !== M.AIR) { mem.plan.shift(); return {}; } // taken or blocked: skip it
      const res = me.lastResult;
      if (res && res.type === 'place' && !res.ok) mem.plan.push(mem.plan.shift()); // try the others first
      else if (res && res.type === 'place' && res.ok) mem.plan.shift();
      return { move: { dx: 0, dz: 0 }, do: { type: 'place', item: 'planks', at } };
    }
    if ((inv.wood || 0) >= load - 1e-9) return { do: { type: 'craft', recipe: 'planks' } };
    const tree = findVoxels(obs, (m) => m === M.WOOD)[0];
    if (tree) {
      if (tree.d <= 4) return { move: { dx: 0, dz: 0 }, do: { type: 'mine', at: [tree.dx, tree.dy, tree.dz] } };
      return { move: walk(obs, mem, tree.mx, tree.mz, 1) };
    }
    return { move: wander(obs, rng, mem) };
  };
}

/** Walks up to the nearest agent and hits it. */
export function brawler() {
  return (obs, rng, mem) => {
    if (obs.law.jailed) return { move: wander(obs, rng, mem) };
    const t = obs.agents.find((a) => !a.jailed);
    if (!t) return { move: wander(obs, rng, mem) };
    if (t.dist < 2.4) return { move: { dx: 0, dz: 0 }, do: { type: 'attack', target: t.id } };
    return { move: walk(obs, mem, t.dx, t.dz, 1) };
  };
}

/** Walks up to the nearest agent and grabs whatever they carry. */
export function thief() {
  const loot = ['berries', 'planks', 'wood', 'seed', 'ore', 'stone'];
  return (obs, rng, mem) => {
    if (obs.law.jailed) return { move: wander(obs, rng, mem) };
    if (obs.self.satiety < 60 && (obs.self.inventory.berries || 0) > 1e-9) return { do: { type: 'eat' } };
    const t = obs.agents.find((a) => !a.jailed);
    if (!t) return { move: wander(obs, rng, mem) };
    if (t.dist < 2.4) {
      mem.i = ((mem.i ?? -1) + 1) % loot.length;
      return { move: { dx: 0, dz: 0 }, do: { type: 'take', target: t.id, item: loot[mem.i] } };
    }
    return { move: walk(obs, mem, t.dx, t.dz, 1) };
  };
}

/**
 * Wraps a policy so it also behaves like a citizen: report harm you suffered
 * or saw, and repay debts to anyone standing close by.
 */
export function citizen(inner, { accuse = true, repay = true } = {}) {
  return (obs, rng, mem) => {
    mem.accused ??= new Set();
    if (accuse && !obs.law.jailed) {
      for (const e of obs.events) {
        if ((e.type === 'harmed' || e.type === 'witnessed') && e.actor !== obs.self.id && !mem.accused.has(e.incident)) {
          mem.accused.add(e.incident);
          return { do: { type: 'accuse', target: e.actor, incident: e.incident } };
        }
      }
    }
    if (repay && !obs.law.jailed) {
      for (const d of obs.law.debtsOwed) {
        const c = obs.agents.find((a) => a.id === d.to && a.dist < 3.5);
        const item = Object.keys(obs.self.inventory).find((k) => obs.self.inventory[k] > 1e-9);
        if (c && item) return { do: { type: 'give', target: c.id, item } };
      }
    }
    return inner(obs, rng, mem);
  };
}

export const ROLES = {
  forager: () => citizen(forager()),
  builder: () => citizen(builder()),
  brawler: () => brawler(),
  thief: () => thief(),
  wanderer: () => wanderer(),
};
