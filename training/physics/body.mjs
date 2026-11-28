/**
 * The body that has to learn to walk: a four-legged creature built from points, bones and muscles.
 *
 *   - A rigid box torso (8 corner points, braced so it cannot shear).
 *   - Four legs. Each leg has a hip hinge and a knee hinge. A hinge is made the way a real one works:
 *     the knee is held at fixed distances from two hip points that lie along the hinge axis, so it can only
 *     swing around that axis. The same trick holds the foot in the leg's plane.
 *   - Two muscles per leg (8 in all): the hip muscle swings the thigh fore and aft, the knee muscle
 *     bends or straightens the leg. That is the whole control surface: 8 numbers in [-1, 1].
 *
 * Axes: +x is the creature's front, +y is up, +z is its side axis (right-handed: x cross y = z).
 */
import { PhysicsWorld } from './world.mjs';

export const MUSCLES = 8;
export const FEET = 4;
export const LEG_NAMES = ['front-a', 'front-b', 'back-a', 'back-b'];

// Dimensions in metres. About 14 kg all up, 0.6 m long and 0.44 m wide, standing about 0.4 m tall.
const L = 0.6, W = 0.44, H = 0.2;      // torso
const UPPER = 0.25, LOWER = 0.25;      // thigh and shin
const HIP_SPAN = 0.10;                 // distance between the two points that define a hip axis
const STAND_REACH = 0.34;              // hip-to-foot distance when standing
const HIP_RANGE = 0.12, KNEE_RANGE = 0.09; // metres a muscle can lengthen or shorten

/**
 * Build a creature into a new world. Returns { world, parts }.
 * `strength` is the muscle's maximum force in newtons. `tau` is the muscle activation time constant in
 * seconds: a command moves the real activation toward it over about this long, as in a living muscle.
 */
export function buildCreature({ x = 0, z = 0, yaw = 0, strength = 250, rate = 0.9, tau = 0.06, dt = 1 / 30, substeps = 8, iterations = 2 } = {}) {
  const w = new PhysicsWorld({ dt, substeps, iterations });
  const FOOT_R = 0.035;
  const standY = STAND_REACH + FOOT_R; // hip height: the feet start exactly touching the ground, not inside it
  const corner = (sx, sy, sz) => [sx * L / 2, standY + (sy > 0 ? H : 0), sz * W / 2];

  // --- torso: 8 corners, indexed by bits (x, y, z)
  const T = [];
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    const [cx, cy, cz] = corner(sx, sy, sz);
    T[idx(sx, sy, sz)] = w.addPoint(cx, cy, cz, 1.0, 0.05, 0.6);
  }
  function idx(sx, sy, sz) { return (sx > 0 ? 4 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 1 : 0); }
  // edges, face diagonals and space diagonals: a box that stays a box
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) w.addBond(T[a], T[b]);

  // --- legs
  const legs = [];
  const muscles = [];     // muscle constraint indices, [hip, knee] per leg
  const base = [];        // the length each muscle has at control = 0
  const range = [];       // metres per unit of control
  const feet = [];
  const sensors = [];     // [a, b] point pairs whose distance is reported back as the muscle's length

  for (const [sx, sz] of [[1, -1], [1, 1], [-1, -1], [-1, 1]]) {
    // hip axis: H_in is the bottom corner, H_out sits HIP_SPAN further out along the side axis
    const hipIn = T[idx(sx, 0, sz)];
    const hx = sx * L / 2, hy = standY, hz = sz * W / 2;
    const hipOut = w.addPoint(hx, hy, hz + sz * HIP_SPAN, 0.5, 0.03, 0.6);
    // hold H_out rigidly to the torso: to its own corner and the three others on that side face
    w.addBond(hipOut, hipIn);
    w.addBond(hipOut, T[idx(sx, 1, sz)]);
    w.addBond(hipOut, T[idx(-sx, 0, sz)]);
    w.addBond(hipOut, T[idx(-sx, 1, sz)]);

    // two-link leg in the plane z = hz: foot straight below the hip at STAND_REACH, knee forward of the line
    const a = STAND_REACH / 2;
    const kneeOffset = Math.sqrt(UPPER * UPPER - a * a);
    const kneeX = hx + kneeOffset, kneeY = hy - a;
    const knee = w.addPoint(kneeX, kneeY, hz, 0.6, 0.03, 0.6);
    const foot = w.addPoint(hx, hy - STAND_REACH, hz, 0.5, FOOT_R, 1.1);
    // the knee swings about the hip axis: fixed distance to both hip points
    w.addBond(knee, hipIn, UPPER);
    w.addBond(knee, hipOut, Math.hypot(UPPER, HIP_SPAN));
    w.addBond(foot, knee, LOWER);

    // hip muscle: knee to the far top corner on the same side (the far end breaks the left/right symmetry)
    const far = T[idx(-sx, 1, sz)];
    const hipLen = w.distance(knee, far);
    const hipM = w.addMuscle(knee, far, { maxForce: strength, rate, length: hipLen });
    // knee muscle: two cables from the foot to the two hip points, so the foot stays in the leg's plane
    const reach = w.distance(foot, hipIn);
    const kneeM = w.addMuscle(foot, hipIn, { maxForce: strength, rate, length: reach });
    const kneeM2 = w.addMuscle(foot, hipOut, { maxForce: strength, rate, length: Math.hypot(reach, HIP_SPAN) });

    legs.push({ hipIn, hipOut, knee, foot, hip: hipM, kneeA: kneeM, kneeB: kneeM2 });
    muscles.push(hipM, kneeM);
    base.push(hipLen, reach);
    range.push(HIP_RANGE, KNEE_RANGE);
    feet.push(foot);
    sensors.push([knee, far], [foot, hipIn]);
  }

  // turn the whole creature to face `yaw` and place it at (x, z)
  if (yaw !== 0 || x !== 0 || z !== 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < w.n; i++) {
      const ox = w.x[i], oz = w.z[i];
      const nx = c * ox + s * oz, nz = -s * ox + c * oz; // rotation about +y
      w.x[i] = w.px[i] = nx + x;
      w.z[i] = w.pz[i] = nz + z;
    }
  }

  const parts = { torso: T, legs, muscles, base, range, feet, sensors, length: L, width: W, height: H };
  return { world: w, parts, creature: new Creature(w, parts, tau) };
}

/** Everything about the creature that is not physics: reading it, and steering its muscles. */
export class Creature {
  constructor(world, parts, tau = 0.06) {
    this.world = world;
    this.parts = parts;
    this.raw = new Float64Array(MUSCLES);       // what was last asked for, clamped to [-1, 1]
    this.controls = new Float64Array(MUSCLES);  // the activation the muscles actually have
    this.mix = tau > 0 ? 1 - Math.exp(-world.dt / tau) : 1;
    this._com = [0, 0, 0];
    // body frame, refreshed by frame()
    this.fx = 1; this.fy = 0; this.fz = 0;     // front axis
    this.ux = 0; this.uy = 1; this.uz = 0;     // up axis
    this.sx = 0; this.sy = 0; this.sz = 1;     // side axis
  }

  /**
   * Steer the muscles: one number in [-1, 1] each. Out-of-range or NaN is clamped to a safe value.
   * The command does not act at once: the activation moves toward it with time constant `tau`.
   */
  drive(u) {
    const { world: w, parts: p } = this;
    for (let i = 0; i < MUSCLES; i++) {
      let v = +u[i];
      if (!(v === v)) v = 0;
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      this.raw[i] = v;
      const a = (this.controls[i] += (v - this.controls[i]) * this.mix);
      const len = p.base[i] + a * p.range[i];
      w.setMuscle(p.muscles[i], len);
      if (i % 2 === 1) { // the knee has a second cable that keeps the foot in plane
        w.setMuscle(p.legs[(i - 1) >> 1].kneeB, Math.hypot(len, HIP_SPAN));
      }
    }
  }

  /** Refresh the front / up / side axes of the torso from its corner points. */
  frame() {
    const { world: w, parts: p } = this;
    const T = p.torso;
    const idx = (sx, sy, sz) => T[(sx > 0 ? 4 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 1 : 0)];
    // front: mean of the +x corners minus mean of the -x corners
    let fx = 0, fy = 0, fz = 0, sx = 0, sy = 0, sz = 0;
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const pf = idx(1, a, b), pb = idx(-1, a, b);
      fx += w.x[pf] - w.x[pb]; fy += w.y[pf] - w.y[pb]; fz += w.z[pf] - w.z[pb];
      const ps = idx(a, b, 1), pn = idx(a, b, -1);
      sx += w.x[ps] - w.x[pn]; sy += w.y[ps] - w.y[pn]; sz += w.z[ps] - w.z[pn];
    }
    let l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
    // remove the part of side along front, normalise
    const d = sx * fx + sy * fy + sz * fz;
    sx -= d * fx; sy -= d * fy; sz -= d * fz;
    l = Math.hypot(sx, sy, sz) || 1; sx /= l; sy /= l; sz /= l;
    // up = side cross front  (z cross x = y)
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    this.fx = fx; this.fy = fy; this.fz = fz;
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.ux = ux; this.uy = uy; this.uz = uz;
  }

  /** Centre of mass of the torso corners (what "where is the body" means). */
  position(out = this._com) {
    const { world: w } = this;
    let cx = 0, cy = 0, cz = 0;
    for (const i of this.parts.torso) { cx += w.x[i]; cy += w.y[i]; cz += w.z[i]; }
    out[0] = cx / 8; out[1] = cy / 8; out[2] = cz / 8;
    return out;
  }

  /** Mean velocity of the torso corners. */
  velocity(out = [0, 0, 0]) {
    const { world: w } = this;
    let vx = 0, vy = 0, vz = 0;
    for (const i of this.parts.torso) { vx += w.vx[i]; vy += w.vy[i]; vz += w.vz[i]; }
    out[0] = vx / 8; out[1] = vy / 8; out[2] = vz / 8;
    return out;
  }

  /** Angular velocity of the torso (rad/s, world frame), from the corners' motion about their centre. */
  angularVelocity(out = [0, 0, 0]) {
    const { world: w } = this;
    const c = this.position(), v = this.velocity();
    let lx = 0, ly = 0, lz = 0, I = 0;
    for (const i of this.parts.torso) {
      const rx = w.x[i] - c[0], ry = w.y[i] - c[1], rz = w.z[i] - c[2];
      const ux = w.vx[i] - v[0], uy = w.vy[i] - v[1], uz = w.vz[i] - v[2];
      lx += ry * uz - rz * uy; ly += rz * ux - rx * uz; lz += rx * uy - ry * ux;
      I += rx * rx + ry * ry + rz * rz;
    }
    I = I || 1;
    out[0] = lx / I; out[1] = ly / I; out[2] = lz / I;
    return out;
  }

  /** Current length of muscle i, as a number in about [-1, 1] (control units), measured from the real points. */
  muscleState(i) {
    const { world: w, parts: p } = this;
    const [a, b] = p.sensors[i];
    return (w.distance(a, b) - p.base[i]) / p.range[i];
  }

  /** 1 if foot i is touching the ground. */
  footContact(i) {
    return this.world.contact[this.parts.feet[i]];
  }
}
