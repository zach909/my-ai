/**
 * What an agent can do. An action is a plain object:
 *
 *   {
 *     move: { dx, dz, jump },         // walk direction (x east, z south), any length, jump once
 *     do:   { type: 'mine', at: [dx, dy, dz] },
 *     say:  'hello',                  // heard by agents within 16 m
 *   }
 *
 * Every field is optional. `at` is an offset in voxels from the voxel the
 * agent's feet are in. Types of `do`:
 *
 *   mine {at}                    break a voxel, collect it
 *   place {item, at}             put an item down as a voxel (seed plants a bush)
 *   harvest {at}                 pick a ripe bush (it regrows) for berries and maybe a seed
 *   eat {amount?}                eat berries
 *   craft {recipe:'planks', amount?}   wood to planks
 *   ignite {at}                  set a flammable voxel alight (costs a little wood)
 *   attack {target}              hit another agent in reach
 *   give {target, item, amount?} hand someone items
 *   take {target, item, amount?} grab items from someone's pack
 *   accuse {target, incident}    tell the court who did an incident you were part of
 *   forgive {target}             wipe out a debt someone owes you
 *
 * Each returns { ok, reason } and the result is shown in the agent's next view.
 */
import {
  M, MINABLE, MATERIAL_ITEM, ITEM_VALUE, ITEM_PLACES, NUTRITION,
} from './materials.mjs';
import { overlaps } from './bodies.mjs';

const fail = (reason) => ({ ok: false, reason });
const ok = (extra = {}) => ({ ok: true, ...extra });
const EPS = 1e-9;

function targetCell(sim, agent, a) {
  const w = sim.world;
  const at = a && a.at;
  if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isInteger)) return null;
  return [w.cell(agent.x) + at[0], w.cell(agent.y + 1e-3) + at[1], w.cell(agent.z) + at[2]];
}

function inReach(sim, agent, ix, iy, iz) {
  const w = sim.world;
  const dx = (ix + 0.5) * w.vs - agent.x;
  const dy = (iy + 0.5) * w.vs - (agent.y + agent.eye);
  const dz = (iz + 0.5) * w.vs - agent.z;
  const reach = sim.cfg.reach + w.vs * 0.87; // slack so coarse voxels stay reachable
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y + 0.9 - (b.y + 0.9), a.z - b.z);
}

function otherAgent(sim, agent, id) {
  const t = sim.agents.get(id);
  return t && t.alive && t !== agent ? t : null;
}

function valueOf(item, units) {
  return (ITEM_VALUE[item] ?? 2) * units;
}

const DO = {
  mine(sim, agent, a) {
    const t = targetCell(sim, agent, a);
    if (!t) return fail('bad target');
    const w = sim.world;
    const [ix, iy, iz] = t;
    if (!w.inBounds(ix, iy, iz)) return fail('outside the world');
    const m = w.get(ix, iy, iz);
    if (!MINABLE[m]) return fail('cannot mine that');
    if (!inReach(sim, agent, ix, iy, iz)) return fail('too far');
    const owner = w.getOwner(ix, iy, iz);
    const units = w.vs ** 3;
    const item = MATERIAL_ITEM[m];
    w.set(ix, iy, iz, M.AIR, 0, 0, agent.id);
    if (item) agent.add(item, m === M.BUSH_BARE || m === M.BUSH_RIPE ? units * 0.5 : units);
    sim.disturbGround(agent, ix, iy, iz);
    if (owner && owner !== agent.id) {
      sim.harm(agent.id, owner, 'property', valueOf(item || 'wood', units) * sim.cfg.propertyWeight, { note: 'mined someone else\'s block' });
    }
    return ok({ got: item });
  },

  place(sim, agent, a) {
    const t = targetCell(sim, agent, a);
    if (!t) return fail('bad target');
    const w = sim.world;
    const item = a.item;
    const isSeed = item === 'seed';
    if (!isSeed && ITEM_PLACES[item] === undefined) return fail('cannot place that');
    const units = w.vs ** 3;
    if (!agent.has(item, units)) return fail('not enough');
    const [ix, iy, iz] = t;
    if (!w.inBounds(ix, iy, iz)) return fail('outside the world');
    if (w.get(ix, iy, iz) !== M.AIR) return fail('occupied');
    if (!inReach(sim, agent, ix, iy, iz)) return fail('too far');
    const box = { x: (ix + 0.5) * w.vs, y: iy * w.vs, z: (iz + 0.5) * w.vs, hw: w.vs / 2, h: w.vs };
    for (const o of sim.agents.values()) if (o.alive && overlaps(box, o)) return fail('someone is there');
    if (isSeed) {
      const below = w.get(ix, iy - 1, iz);
      if (below !== M.GRASS && below !== M.DIRT) return fail('seeds need soil');
      w.set(ix, iy, iz, M.BUSH_BARE, agent.id, 0, agent.id);
    } else {
      w.set(ix, iy, iz, ITEM_PLACES[item], agent.id, 0, agent.id);
    }
    agent.take(item, units);
    return ok();
  },

  harvest(sim, agent, a) {
    const t = targetCell(sim, agent, a);
    if (!t) return fail('bad target');
    const w = sim.world;
    const [ix, iy, iz] = t;
    if (w.get(ix, iy, iz) !== M.BUSH_RIPE) return fail('nothing ripe there');
    if (!inReach(sim, agent, ix, iy, iz)) return fail('too far');
    const owner = w.getOwner(ix, iy, iz);
    const units = w.vs ** 3;
    w.set(ix, iy, iz, M.BUSH_BARE, owner, 0, 0);
    agent.add('berries', units);
    if (sim.rng.chance(0.5)) agent.add('seed', units * 0.5);
    if (owner && owner !== agent.id) {
      sim.harm(agent.id, owner, 'theft', valueOf('berries', units) * sim.cfg.theftWeight, { note: 'picked someone else\'s crop' });
    }
    return ok({ got: 'berries' });
  },

  eat(sim, agent, a) {
    const want = a.amount ?? Infinity;
    const need = (100 - agent.satiety) / NUTRITION.berries;
    const amt = Math.min(want, agent.inv.berries || 0, need);
    if (amt <= EPS) return fail('nothing to eat');
    agent.take('berries', amt);
    agent.satiety = Math.min(100, agent.satiety + amt * NUTRITION.berries);
    return ok({ ate: amt });
  },

  craft(sim, agent, a) {
    if (a.recipe !== 'planks') return fail('unknown recipe');
    const amt = Math.min(a.amount ?? Infinity, agent.inv.wood || 0);
    if (amt <= EPS) return fail('no wood');
    agent.take('wood', amt);
    agent.add('planks', amt);
    return ok({ made: amt });
  },

  ignite(sim, agent, a) {
    if (sim.justice.isJailed(agent)) return fail('in jail');
    const t = targetCell(sim, agent, a);
    if (!t) return fail('bad target');
    const w = sim.world;
    const cost = w.vs ** 3 * 0.05;
    if (!agent.has('wood', cost)) return fail('needs a little wood');
    const [ix, iy, iz] = t;
    if (!inReach(sim, agent, ix, iy, iz)) return fail('too far');
    if (!w.ignite(ix, iy, iz, agent.id)) return fail('nothing to light');
    agent.take('wood', cost);
    return ok();
  },

  attack(sim, agent, a) {
    if (sim.justice.isJailed(agent)) return fail('in jail');
    const t = otherAgent(sim, agent, a.target);
    if (!t) return fail('no such target');
    if (dist(agent, t) > sim.cfg.attackReach) return fail('too far');
    if (sim.tick < agent.attackReadyAt) return fail('not ready');
    agent.attackReadyAt = sim.tick + 5;
    agent.lastAttackTick = sim.tick;
    const dx = t.x - agent.x, dz = t.z - agent.z;
    const d = Math.hypot(dx, dz) || 1;
    t.vx += (dx / d) * 5;
    t.vz += (dz / d) * 5;
    t.vy += 2.5;
    t.recentCause = { id: agent.id, tick: sim.tick };
    sim.damage(t, sim.cfg.attackDamage, agent.id, 'attack');
    return ok();
  },

  give(sim, agent, a) {
    const t = otherAgent(sim, agent, a.target);
    if (!t) return fail('no such target');
    if (dist(agent, t) > 4) return fail('too far');
    if (ITEM_VALUE[a.item] === undefined) return fail('unknown item');
    const amt = Math.min(a.amount ?? Infinity, agent.inv[a.item] || 0);
    if (amt <= EPS) return fail('nothing to give');
    agent.take(a.item, amt);
    t.add(a.item, amt);
    const value = valueOf(a.item, amt);
    const paid = sim.justice.pay(agent.id, t.id, value); // pays down any debt first
    const benefit = (value - paid) * needFactor(t, a.item);
    const credited = sim.ledger.kindness(agent.id, t.id, 'gift', benefit);
    sim.note(t, { type: 'gift', from: agent.id, item: a.item, amount: amt });
    return ok({ gave: amt, debtPaid: paid, credited });
  },

  take(sim, agent, a) {
    if (sim.justice.isJailed(agent)) return fail('in jail');
    const t = otherAgent(sim, agent, a.target);
    if (!t) return fail('no such target');
    if (dist(agent, t) > sim.cfg.attackReach) return fail('too far');
    if (ITEM_VALUE[a.item] === undefined) return fail('unknown item');
    const amt = Math.min(a.amount ?? Infinity, t.inv[a.item] || 0);
    if (amt <= EPS) return fail('they have none');
    t.take(a.item, amt);
    agent.add(a.item, amt);
    sim.harm(agent.id, t.id, 'theft', valueOf(a.item, amt) * sim.cfg.theftWeight, { note: 'took from a pack' });
    return ok({ took: amt });
  },

  accuse(sim, agent, a) {
    return sim.justice.accuse(agent.id, a.target, a.incident);
  },

  forgive(sim, agent, a) {
    const owed = sim.justice.forgive(agent.id, a.target);
    return owed > 0 ? ok({ forgave: owed }) : fail('they owe nothing');
  },
};

/** How much a gift helps the one who gets it: food for the hungry matters most. */
function needFactor(t, item) {
  if (item === 'berries') return Math.max(0.1, Math.min(1, 0.1 + 0.9 * ((100 - t.satiety) / 100)));
  return 0.4;
}

/** Apply one action object for one agent. Returns the result of its `do`, if any. */
export function applyAction(sim, agent, act) {
  if (!act || typeof act !== 'object') return null;
  const mv = act.move || {};
  agent.move = {
    dx: Number.isFinite(mv.dx) ? mv.dx : 0,
    dz: Number.isFinite(mv.dz) ? mv.dz : 0,
    jump: !!mv.jump,
  };
  if (typeof act.say === 'string' && act.say) sim.say(agent, act.say.slice(0, 140));
  if (!act.do) return null;
  const fn = DO[act.do.type];
  const res = fn ? fn(sim, agent, act.do) : fail('unknown action');
  agent.lastResult = { type: act.do.type, ...res };
  return res;
}

export const ACTION_TYPES = Object.keys(DO);
