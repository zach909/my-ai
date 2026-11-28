/**
 * The walking task: a blank plane, one creature, a goal marker somewhere on the ground.
 *
 * The creature has to get to the marker. When it arrives, a new marker appears a few metres away in a
 * new direction, so "walk around" means walking, turning and walking again. It starts standing. If it
 * falls over, the episode ends. Nothing else is in the world: no walls, no slopes, no other creature.
 *
 * What the creature feels (OBS_SIZE numbers, each already scaled to about [-1, 1]):
 *    0-2   which way is down, in the body's own axes (front, up, side)
 *    3-5   its velocity in the body's axes
 *    6-8   its spin in the body's axes
 *    9-11  the goal: how far ahead and to the side (unit direction), and how far (0 = here, 1 = 6 m+)
 *   12-19  how long each of the 8 muscles is right now
 *   20-23  which feet touch the ground
 *   24     height of the body above the ground
 *   25-26  a slow clock (sin, cos), the only thing that marks time
 * It does NOT get its position in the world, the world's compass, or any score.
 *
 * What it does: 8 numbers in [-1, 1], one per muscle, 30 times a second.
 *
 * Reward each step (all of it is physical or about the goal, nothing about "style"):
 *    + metres gained toward the goal this step
 *    + GOAL_BONUS on arrival
 *    - a small cost for effort (mean squared muscle command)
 *    - a small cost for jerk (mean squared change in the command since the last step), so the command
 *      stays smooth. (The muscles also respond with a 60 ms lag, like real ones, so a command that flips
 *      every frame cannot move the body anyway.)
 *    - FALL_PENALTY if it falls over, or if the physics breaks (a bone stretched more than 25%)
 */
import { Rng } from '../simulation/random.mjs';
import { buildCreature, MUSCLES } from './body.mjs';

export const OBS_SIZE = 27;
export const ACT_SIZE = MUSCLES;

export const DEFAULTS = {
  seconds: 20,            // episode length
  clockPeriod: 0.6,       // seconds per tick of the clock input
  goalRadius: 0.45,       // metres: arrival
  goalMin: 2.5, goalMax: 4.5, // metres from the body when a new goal is placed
  goalAngle: Math.PI,     // new goals appear within +-this many radians of straight ahead
  goalBonus: 3,
  effortCost: 0.02,
  jerkCost: 0.03,
  fallPenalty: 2,
  fallHeight: 0.14,       // body lower than this (m) counts as down
  fallUp: 0.45,           // body tilted past this (up.y below it) counts as down
  maxStretch: 0.25,       // physics sanity limit on any bone
  strength: 250,          // muscle force limit, newtons
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class WalkEnv {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.obs = new Float64Array(OBS_SIZE);
    this._v = [0, 0, 0];
    this._w = [0, 0, 0];
    this._p = [0, 0, 0];
    this.rng = new Rng(1);
  }

  /** Start a new episode from a seed. Returns the first observation. */
  reset(seed = 1) {
    const c = this.cfg;
    this.rng = new Rng(seed);
    const yaw = this.rng.range(-Math.PI, Math.PI);
    const built = buildCreature({ yaw, strength: c.strength });
    this.world = built.world;
    this.creature = built.creature;
    this.steps = 0;
    this.maxSteps = Math.round(c.seconds / this.world.dt);
    this.goalsReached = 0;
    this.fell = false;
    this.broke = false;
    this.distance = 0;       // metres of progress made toward goals
    this.totalReward = 0;
    this.creature.drive(new Float64Array(ACT_SIZE));
    this.prevAction = new Float64Array(ACT_SIZE);
    this.creature.frame();
    this._placeGoal();
    this.prevDist = this._goalDistance();
    return this._observe();
  }

  _placeGoal() {
    const c = this.cfg, cr = this.creature;
    cr.frame();
    const p = cr.position(this._p);
    const hx = cr.fx, hz = cr.fz, l = Math.hypot(hx, hz) || 1;
    const ang = Math.atan2(-hz / l, hx / l) + this.rng.range(-c.goalAngle, c.goalAngle); // heading as a yaw, plus an offset
    const r = this.rng.range(c.goalMin, c.goalMax);
    this.goalX = p[0] + Math.cos(ang) * r;
    this.goalZ = p[2] - Math.sin(ang) * r;
  }

  _goalDistance() {
    const p = this.creature.position(this._p);
    return Math.hypot(this.goalX - p[0], this.goalZ - p[2]);
  }

  /** Advance one control step with 8 muscle commands in [-1, 1]. */
  step(action) {
    const c = this.cfg, w = this.world, cr = this.creature;
    cr.drive(action);
    w.step();
    this.steps++;
    cr.frame();

    let dist = this._goalDistance();
    let reward = this.prevDist - dist;
    this.distance += reward;
    if (dist < c.goalRadius) {
      reward += c.goalBonus;
      this.goalsReached++;
      this._placeGoal();
      dist = this._goalDistance();
    }
    this.prevDist = dist;

    let effort = 0, jerk = 0;
    for (let i = 0; i < ACT_SIZE; i++) {
      const u = cr.controls[i], d = cr.raw[i] - this.prevAction[i];
      effort += u * u; jerk += d * d;
      this.prevAction[i] = cr.raw[i];
    }
    reward -= (c.effortCost * effort + c.jerkCost * jerk) / ACT_SIZE;

    const y = cr.position(this._p)[1];
    this.broke = !w.isFinite() || w.maxBondError() > c.maxStretch;
    this.fell = this.broke || y < c.fallHeight || cr.uy < c.fallUp;
    if (this.fell) reward -= c.fallPenalty;
    this.totalReward += reward;
    const done = this.fell || this.steps >= this.maxSteps;
    return { obs: this.broke ? this.obs : this._observe(), reward, done };
  }

  _observe() {
    const o = this.obs, cr = this.creature, w = this.world;
    // gravity in the body frame: world up expressed along front, up, side
    o[0] = cr.fy; o[1] = cr.uy; o[2] = cr.sy;
    const v = cr.velocity(this._v), s = cr.angularVelocity(this._w);
    o[3] = clamp((v[0] * cr.fx + v[1] * cr.fy + v[2] * cr.fz) / 1, -2, 2) / 2;
    o[4] = clamp((v[0] * cr.ux + v[1] * cr.uy + v[2] * cr.uz) / 1, -2, 2) / 2;
    o[5] = clamp((v[0] * cr.sx + v[1] * cr.sy + v[2] * cr.sz) / 1, -2, 2) / 2;
    o[6] = clamp((s[0] * cr.fx + s[1] * cr.fy + s[2] * cr.fz) / 4, -1, 1);
    o[7] = clamp((s[0] * cr.ux + s[1] * cr.uy + s[2] * cr.uz) / 4, -1, 1);
    o[8] = clamp((s[0] * cr.sx + s[1] * cr.sy + s[2] * cr.sz) / 4, -1, 1);
    // goal in the body's heading frame (on the ground plane)
    const p = cr.position(this._p);
    const gx = this.goalX - p[0], gz = this.goalZ - p[2];
    const l = Math.hypot(cr.fx, cr.fz) || 1;
    const hx = cr.fx / l, hz = cr.fz / l;     // heading
    const sx = -hz, sz = hx;                   // its side
    const d = Math.hypot(gx, gz) || 1e-9;
    o[9] = (gx * hx + gz * hz) / d;
    o[10] = (gx * sx + gz * sz) / d;
    o[11] = clamp(d / 6, 0, 1);
    for (let i = 0; i < MUSCLES; i++) o[12 + i] = clamp(cr.muscleState(i), -1.5, 1.5);
    for (let i = 0; i < 4; i++) o[20 + i] = cr.footContact(i);
    o[24] = clamp((p[1] - 0.5) * 4, -2, 2);
    const ph = 2 * Math.PI * w.time / this.cfg.clockPeriod;
    o[25] = Math.sin(ph); o[26] = Math.cos(ph);
    return o;
  }

  /** What the creature has done so far, for logs and tests. */
  stats() {
    const p = this.creature.position(this._p);
    return {
      steps: this.steps, seconds: this.world.time, reward: this.totalReward, distance: this.distance,
      goals: this.goalsReached, fell: this.fell, broke: this.broke, x: p[0], z: p[2],
    };
  }
}

/**
 * Run one episode with a policy: any object with act(obs, out) that fills out[0..7] with values in [-1, 1].
 * `onStep(env)` is called after every step if given (for traces and renders).
 */
export function rollout(policy, env, seed, onStep) {
  let obs = env.reset(seed);
  const act = new Float64Array(ACT_SIZE);
  for (;;) {
    policy.act(obs, act);
    const r = env.step(act);
    if (onStep) onStep(env);
    if (r.done) break;
    obs = r.obs;
  }
  return env.stats();
}

// ---------------------------------------------------------------------------------------------------
// Raw bytes. Same idea as training/simulation/observe.mjs: whatever reads and writes this world
// (the mesh, a script) sees plain bytes, no tokenizer. One byte per observation number, one per muscle.
// ---------------------------------------------------------------------------------------------------

/** Observation (floats in about [-2, 2]) to OBS_SIZE bytes. */
export function encodeObservation(obs, out = new Uint8Array(OBS_SIZE)) {
  for (let i = 0; i < OBS_SIZE; i++) out[i] = Math.round((clamp(obs[i], -2, 2) + 2) / 4 * 255);
  return out;
}

export function decodeObservation(bytes, out = new Float64Array(OBS_SIZE)) {
  for (let i = 0; i < OBS_SIZE; i++) out[i] = bytes[i] / 255 * 4 - 2;
  return out;
}

/** ACT_SIZE bytes (0 = full contract, 255 = full extend) to muscle commands in [-1, 1]. */
export function decodeAction(bytes, out = new Float64Array(ACT_SIZE)) {
  for (let i = 0; i < ACT_SIZE; i++) out[i] = bytes[i] / 255 * 2 - 1;
  return out;
}

export function encodeAction(action, out = new Uint8Array(ACT_SIZE)) {
  for (let i = 0; i < ACT_SIZE; i++) out[i] = Math.round((clamp(action[i], -1, 1) + 1) / 2 * 255);
  return out;
}
