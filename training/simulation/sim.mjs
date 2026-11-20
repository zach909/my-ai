/**
 * The simulation: a world, a population of agents, a ledger that scores them
 * and a justice system that answers harm. One call to `step()` advances
 * everything by one tick and returns the rewards each agent earned.
 *
 *   const sim = new Simulation({ seed: 1, res: 1 });
 *   const a = sim.addAgent({ name: 'ada', policy });
 *   const { rewards } = sim.stepPolicies();
 *
 * A policy is `(observation, rng, memory) => action` (see actions.mjs). It is
 * the thing being trained; the scripted ones in policies.mjs are only
 * stand-ins to exercise the world.
 */
import { Rng, hash32 } from './random.mjs';
import { World } from './world.mjs';
import { moveBody, collides, forCells } from './bodies.mjs';
import { Agent } from './agent.mjs';
import { Ledger } from './ledger.mjs';
import { Justice } from './justice.mjs';
import { applyAction } from './actions.mjs';
import { observe } from './observe.mjs';
import { M, DENSITY, MATERIAL_ITEM, ITEM_VALUE } from './materials.mjs';

export const DEFAULTS = {
  seed: 1,
  res: 1,                 // voxels per metre: 0.5 blocky ... 4 smooth
  size: [64, 32, 64],     // metres
  dt: 0.1,                // seconds per tick
  interestRadius: 24,     // metres around an agent that stay awake
  decisionInterval: 1,    // ticks between policy decisions (physics runs every tick)
  hungerSeconds: 600,     // seconds from full to starving
  dayLength: 600,         // seconds per day
  walkSpeed: 4.3,         // m/s
  reach: 4.5,             // m, mining and placing
  attackReach: 3,         // m
  attackDamage: 8,        // health points per hit
  viewMeters: 4,          // how far an agent sees blocks (a cube this many metres each way)
  seeMeters: 16,          // how far it sees other agents by day
  hearMeters: 16,
  witnessMeters: 14,
  respawnDelay: 50,
  deathHarm: 100,         // harm points for causing a death
  theftWeight: 1,
  propertyWeight: 0.8,
  survivalReward: 0.0005, // per tick alive
  buildReward: 0.01,      // per cubic metre of standing structure you own
  world: {},              // extra World options
  ledger: {},
  justice: {},
};

/** Damage that arrives continuously is summed before it becomes an incident. */
const CONTINUOUS = new Set(['fire', 'lava', 'drown']);

function merge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], extra[k]) : extra[k];
  }
  return out;
}

export class Simulation {
  constructor(opts = {}) {
    const cfg = (this.cfg = merge(DEFAULTS, opts));
    this.rng = new Rng(hash32(cfg.seed, 1));
    this.world = new World({ seed: cfg.seed, res: cfg.res, size: cfg.size, dt: cfg.dt, ...cfg.world });
    this.tick = 0;
    this.agents = new Map();
    this.nextAgentId = 1;
    this.messages = [];
    this.pending = new Map(); // continuous harm waiting to become an incident
    this.ledger = new Ledger(cfg.ledger);
    this.justice = new Justice(this, cfg.justice);
    this.ledger.onIncident = (inc) => this.onIncident(inc);
    this.ledger.onKindness = (k) => this.onKindness(k);
    this.world.onProperty = (ev) => this.onProperty(ev);
    this.counts = { gifts: 0, giftValue: 0, deaths: 0 };
  }

  // ---- population ----------------------------------------------------------

  addAgent({ name, policy = null, x, y, z } = {}) {
    const id = this.nextAgentId++;
    const a = new Agent(id, name || `agent${id}`);
    const p = x === undefined ? this.world.findSpawn(this.rng) : { x, y, z };
    a.x = p.x; a.y = p.y; a.z = p.z;
    a.policy = policy;
    a.rng = new Rng(hash32(this.cfg.seed, 1000 + id));
    this.agents.set(id, a);
    return a;
  }

  alive() {
    return [...this.agents.values()].filter((a) => a.alive);
  }

  // ---- tick ----------------------------------------------------------------

  /** Ask every living agent that has a policy what to do (every `decisionInterval` ticks), then step. */
  stepPolicies() {
    const actions = {};
    const every = this.cfg.decisionInterval;
    for (const a of this.agents.values()) {
      if (a.alive && a.policy && (this.tick + 1 + a.id) % every === 0) {
        actions[a.id] = a.policy(observe(this, a), a.rng, a.mem);
      }
    }
    return this.step(actions);
  }

  /** Advance one tick. `actions` maps agent id to an action object. Returns { tick, rewards }. */
  step(actions = {}) {
    const w = this.world;
    this.tick++;
    w.beginTick();
    this.ledger.setTick(this.tick);
    const pick = (id) => (actions instanceof Map ? actions.get(id) : actions[id]);

    for (const a of this.agents.values()) if (!a.alive && this.tick >= a.respawnAt) this.respawn(a);

    const living = this.alive();
    w.updateAwake(living, this.cfg.interestRadius);
    w.randomTicks();

    for (const a of living) {
      const act = pick(a.id);
      if (act && !this.justice.isJailed(a)) applyAction(this, a, act);
      else if (act) {
        applyAction(this, a, { move: act.move, say: act.say }); // prisoners can walk and talk, nothing else
        if (act.do) a.lastResult = { type: act.do.type, ok: false, reason: 'in jail' };
      }
    }

    w.stepPhysics();
    w.stepBlocks(living, (b, a, speed) => this.onBlockHit(b, a, speed));
    for (const a of living) if (a.alive) this.stepAgent(a);
    w.particles.step(w.dt, w); // sparks are physics, so the pool always steps; `cosmetics` only gates smoke

    this.justice.step();
    this.flushHarm(false);
    this.trimMessages();

    const vs3 = w.vs ** 3;
    for (const a of this.agents.values()) {
      if (!a.alive) continue;
      const r = this.ledger.acc(a.id);
      r.survival += this.cfg.survivalReward;
      const built = w.built.get(a.id) || 0;
      r.build += (built - a.lastBuilt) * vs3 * this.cfg.buildReward;
      a.lastBuilt = built;
    }
    return { tick: this.tick, rewards: this.ledger.drain() };
  }

  // ---- bodies --------------------------------------------------------------

  /** Blame goes to the stated cause, or to whoever shoved or endangered the victim a moment ago. */
  attribute(a, explicit = 0) {
    if (explicit) return explicit;
    return this.tick - a.recentCause.tick <= 60 ? a.recentCause.id : 0;
  }

  stepAgent(a) {
    const w = this.world, dt = w.dt, cfg = this.cfg;
    const mv = a.move;
    let dx = mv.dx, dz = mv.dz;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }
    const speed = cfg.walkSpeed * (a.satiety < 10 ? 0.5 : 1) * (a.inWater ? 0.5 : 1);
    const blend = a.onGround ? 0.6 : 0.12;
    a.vx += (dx * speed - a.vx) * blend;
    a.vz += (dz * speed - a.vz) * blend;

    const mid = w.get(w.cell(a.x), w.cell(a.y + 0.9), w.cell(a.z));
    a.inWater = mid === M.WATER;
    if (a.inWater) {
      a.vy = a.vy * 0.9 - w.gravity * dt * 0.15;
      if (mv.jump) a.vy = Math.max(a.vy, 3);
    } else {
      a.vy -= w.gravity * dt;
      if (mv.jump && a.onGround) a.vy = Math.sqrt(2 * w.gravity * Math.max(1.25, w.vs + 0.25));
    }
    mv.jump = false;

    moveBody(w, a, dt);
    this.unstick(a);
    this.hazards(a);
    if (!a.alive) return;

    a.satiety = Math.max(0, a.satiety - (100 / cfg.hungerSeconds) * dt);
    if (a.satiety <= 0) this.damage(a, 1 * dt, 0, 'starve');
    else if (a.satiety > 60 && a.health < 100) a.health = Math.min(100, a.health + 0.5 * dt);
  }

  /** If a block landed on top of someone, lift them out rather than bury them. */
  unstick(a) {
    const w = this.world;
    for (let k = 0; k < w.ny * 2 && collides(w, a.x, a.y, a.z, a.hw, a.h); k++) a.y += w.vs * 0.5;
  }

  hazards(a) {
    const w = this.world, dt = w.dt;
    let fire = -1, lava = -1;
    forCells(w, a.x, a.y, a.z, a.hw, a.h, (ix, iy, iz) => {
      const m = w.get(ix, iy, iz);
      if (m === M.FIRE) fire = w.getOwner(ix, iy, iz);
      else if (m === M.LAVA) lava = w.getOwner(ix, iy, iz);
    });
    const headX = w.cell(a.x), headY = w.cell(a.y + a.eye), headZ = w.cell(a.z);
    const head = w.get(headX, headY, headZ);

    if (lava >= 0) {
      a.burn = 40;
      a.burnOwner = this.attribute(a, lava);
      this.damage(a, 15 * dt, a.burnOwner, 'lava');
    } else if (fire >= 0 && a.burn <= 0) {
      a.burn = 30;
      a.burnOwner = this.attribute(a, fire);
    }
    if (a.inWater || head === M.WATER) a.burn = 0;
    if (a.burn > 0 && a.alive) {
      a.burn--;
      this.damage(a, 2 * dt, this.attribute(a, a.burnOwner), 'fire');
    }

    if (head === M.WATER) {
      a.air = Math.max(0, a.air - dt);
      if (a.air <= 0) this.damage(a, 4 * dt, this.attribute(a, w.getOwner(headX, headY, headZ)), 'drown');
    } else a.air = Math.min(10, a.air + 4 * dt);

    if (a.impact > 8) {
      this.damage(a, (a.impact - 8) * 5, this.attribute(a, 0), 'fall');
      a.impact = 0;
    }
  }

  /** The ground under these agents was just removed by `miner`: if they fall, it is on the miner. */
  disturbGround(miner, ix, iy, iz) {
    const w = this.world;
    for (const o of this.agents.values()) {
      if (!o.alive || o === miner || !o.onGround) continue;
      if (w.cell(o.y - 1e-3) !== iy) continue;
      if (Math.floor((o.x - o.hw) * w.res) <= ix && ix <= Math.floor((o.x + o.hw) * w.res - 1e-7)
        && Math.floor((o.z - o.hw) * w.res) <= iz && iz <= Math.floor((o.z + o.hw) * w.res - 1e-7)) {
        o.recentCause = { id: miner.id, tick: this.tick };
      }
    }
  }

  onBlockHit(b, a, speed) {
    const w = this.world;
    const mass = DENSITY[b.mat] * w.vs ** 3; // kg
    const dmg = Math.min(40, (0.5 * mass * speed * speed) / 50);
    if (dmg < 0.5) return;
    this.damage(a, dmg, this.attribute(a, b.cause), 'block');
  }

  // ---- harm ----------------------------------------------------------------

  witnesses(actor, victim) {
    const out = [];
    const a = this.agents.get(actor), v = this.agents.get(victim);
    const r = this.cfg.witnessMeters;
    for (const o of this.agents.values()) {
      if (!o.alive || o.id === actor || o.id === victim) continue;
      const near = (p) => p && Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z) <= r;
      if (near(a) || near(v)) out.push(o.id);
    }
    return out;
  }

  /** Record harm one agent did another, with whoever saw it as witnesses. */
  harm(actor, victim, kind, amount, info = {}) {
    return this.ledger.harm(actor, victim, kind, amount, { ...info, witnesses: this.witnesses(actor, victim) });
  }

  damage(a, amount, causer, kind) {
    if (!a.alive || amount <= 0) return;
    a.health -= amount;
    if (causer && causer !== a.id) {
      if (CONTINUOUS.has(kind)) this.accumulateHarm(causer, a.id, kind, amount);
      else this.harm(causer, a.id, kind, amount);
    }
    if (a.health <= 0) this.kill(a, causer, kind);
  }

  accumulateHarm(actor, victim, kind, amount) {
    const key = `${actor}|${victim}|${kind}`;
    const e = this.pending.get(key) || { actor, victim, kind, amount: 0, last: this.tick };
    e.amount += amount;
    e.last = this.tick;
    this.pending.set(key, e);
    if (e.amount >= 5) this.flushEntry(key, e);
  }

  flushEntry(key, e) {
    this.pending.delete(key);
    if (e.amount > 0.25) this.harm(e.actor, e.victim, e.kind, e.amount);
  }

  /** Turn summed damage into incidents once the exposure stops (or for `victim` right now). */
  flushHarm(all, victim = 0) {
    for (const [key, e] of [...this.pending]) {
      if (all || e.victim === victim || this.tick - e.last > 5) this.flushEntry(key, e);
    }
  }

  kill(a, causer, kind) {
    if (!a.alive) return;
    this.flushHarm(false, a.id);
    a.alive = false;
    a.health = 0;
    a.deaths++;
    a.respawnAt = this.tick + this.cfg.respawnDelay;
    this.counts.deaths++;
    let lost = 0;
    for (const [item, units] of Object.entries(a.inv)) lost += (ITEM_VALUE[item] || 0) * units;
    a.inv = {};
    if (causer && causer !== a.id) this.harm(causer, a.id, 'death', this.cfg.deathHarm + lost, { note: kind });
    this.note(a, { type: 'died', by: causer || 0, kind });
  }

  respawn(a) {
    const p = this.world.findSpawn(this.rng);
    a.x = p.x; a.y = p.y; a.z = p.z;
    a.vx = a.vy = a.vz = 0;
    a.health = 100; a.satiety = 70; a.air = 10; a.burn = 0;
    a.jailedUntil = 0;
    a.alive = true;
    a.move = { dx: 0, dz: 0, jump: false };
    a.recentCause = { id: 0, tick: -1e9 };
    this.note(a, { type: 'respawned' });
  }

  onProperty(ev) {
    if (!ev.causer || !ev.prevOwner) return;
    const item = MATERIAL_ITEM[ev.mat];
    const value = (ITEM_VALUE[item] ?? 2) * this.world.vs ** 3 * this.cfg.propertyWeight;
    this.harm(ev.causer, ev.prevOwner, 'property', value, { note: 'fire destroyed it' });
  }

  onIncident(inc) {
    const victim = this.agents.get(inc.victim);
    const actor = this.agents.get(inc.actor);
    const brief = { incident: inc.id, kind: inc.kind, actor: inc.actor, victim: inc.victim, harm: inc.harm };
    if (victim) this.note(victim, { type: 'harmed', ...brief });
    if (actor) this.note(actor, { type: 'caused_harm', ...brief });
    for (const id of inc.witnesses) this.note(this.agents.get(id), { type: 'witnessed', ...brief });
    this.justice.report(inc);
  }

  onKindness(k) {
    if (k.kind === 'gift') {
      this.counts.gifts++;
      this.counts.giftValue += k.benefit;
    }
  }

  // ---- talk and notes ------------------------------------------------------

  note(agent, ev) {
    if (!agent) return;
    agent.events.push({ tick: this.tick, ...ev });
    if (agent.events.length > 60) agent.events.splice(0, agent.events.length - 60);
  }

  say(agent, text) {
    this.messages.push({ tick: this.tick, from: agent.id, x: agent.x, y: agent.y, z: agent.z, text });
  }

  trimMessages() {
    const keep = this.tick - 20;
    if (this.messages.length && this.messages[0].tick < keep) this.messages = this.messages.filter((m) => m.tick >= keep);
  }

  // ---- views and reports ---------------------------------------------------

  /** What an agent sees now. `peek` leaves its pending events and heard speech in place. */
  observe(id, peek = false) {
    return observe(this, this.agents.get(id), peek);
  }

  get daylight() {
    const t = (this.tick * this.cfg.dt) / this.cfg.dayLength;
    return 0.5 + 0.5 * Math.sin(2 * Math.PI * t - Math.PI / 2 + 0.6);
  }

  /** Numbers that say how the society is doing, and what it cost to run. */
  summary() {
    const living = this.alive();
    const stats = [...this.ledger.stats.values()];
    const sum = (f) => stats.reduce((s, x) => s + f(x), 0);
    const wealth = living.map((a) => Object.entries(a.inv).reduce((s, [i, u]) => s + (ITEM_VALUE[i] || 0) * u, 0));
    const w = this.world;
    return {
      tick: this.tick,
      seconds: +(this.tick * this.cfg.dt).toFixed(1),
      population: living.length,
      deaths: this.counts.deaths,
      harm: +sum((s) => s.harmDone).toFixed(1),
      kindness: +sum((s) => s.kindDone).toFixed(1),
      gifts: this.counts.gifts,
      incidents: this.ledger.incidents.length,
      prosecuted: this.justice.counts.prosecuted,
      jailings: this.justice.counts.jailed,
      perjury: this.justice.counts.perjury,
      restitution: +this.justice.counts.collected.toFixed(1),
      builtVoxels: [...w.built.values()].reduce((s, v) => s + v, 0),
      meanHealth: living.length ? +(living.reduce((s, a) => s + a.health, 0) / living.length).toFixed(1) : 0,
      wealthGini: gini(wealth),
      cost: { awakeChunks: w.stats.awakeChunks, totalChunks: w.chunkLast.length, voxelUpdates: w.stats.voxelUpdates, fallingBlocks: w.blocks.length, particles: w.particles.alive },
    };
  }
}

/** 0 = everyone has the same, 1 = one agent has everything. */
export function gini(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length, total = v.reduce((s, x) => s + x, 0);
  if (n < 2 || total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (i + 1) * v[i];
  return +((2 * acc) / (n * total) - (n + 1) / n).toFixed(3);
}
