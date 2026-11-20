/**
 * Particles: tiny, short-lived things that are not worth a voxel.
 * Smoke and steam rise, dust settles, and sparks fly off fire and set
 * flammable things alight where they land, so a fire can jump a gap.
 *
 * One fixed pool (structure of arrays). A full pool overwrites the oldest,
 * so particles can never cost more than `capacity` each tick.
 */
import { hash32 } from './random.mjs';
import { M, FLAM, BODY_SOLID, PHASE_OF, PHASE } from './materials.mjs';

export const PK = Object.freeze({ NONE: 0, SMOKE: 1, SPARK: 2, STEAM: 3, DUST: 4 });

export class Particles {
  constructor(capacity = 1024) {
    this.cap = capacity;
    this.kind = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.owner = new Uint16Array(capacity);
    this.head = 0;
    this.alive = 0;
  }

  emit(kind, x, y, z, vx, vy, vz, life, owner = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.kind[i] === PK.NONE) this.alive++;
    this.kind[i] = kind;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life;
    this.owner[i] = owner;
  }

  kill(i) {
    if (this.kind[i] !== PK.NONE) this.alive--;
    this.kind[i] = PK.NONE;
  }

  /** Advance every live particle by dt seconds inside `world`. */
  step(dt, world) {
    if (this.alive === 0) return;
    const t = world.tick;
    for (let i = 0; i < this.cap; i++) {
      const k = this.kind[i];
      if (k === PK.NONE) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      // gentle deterministic jitter, no random stream consumed
      const jx = hash32(i, t, 1) / 4294967296 - 0.5;
      const jz = hash32(i, t, 2) / 4294967296 - 0.5;
      if (k === PK.SMOKE || k === PK.STEAM) {
        this.vy[i] += (1.6 - this.vy[i]) * 0.2;
        this.vx[i] += jx * 0.4;
        this.vz[i] += jz * 0.4;
      } else if (k === PK.SPARK) {
        this.vy[i] -= world.gravity * 0.35 * dt;
      } else if (k === PK.DUST) {
        this.vy[i] -= world.gravity * 0.2 * dt;
        this.vx[i] *= 0.9;
        this.vz[i] *= 0.9;
      }
      const nx = this.x[i] + this.vx[i] * dt;
      const ny = this.y[i] + this.vy[i] * dt;
      const nz = this.z[i] + this.vz[i] * dt;
      const m = world.get(Math.floor(nx * world.res), Math.floor(ny * world.res), Math.floor(nz * world.res));
      if (k === PK.SPARK) {
        if (m !== M.AIR && m !== M.FIRE) {
          if (FLAM[m] > 0 && world.rng.chance(Math.min(1, FLAM[m] * 0.7))) {
            world.ignite(
              Math.floor(nx * world.res), Math.floor(ny * world.res), Math.floor(nz * world.res), this.owner[i],
            );
          }
          this.kill(i);
          continue;
        }
      } else if (BODY_SOLID[m] || PHASE_OF[m] === PHASE.LIQUID) {
        this.kill(i);
        continue;
      }
      this.x[i] = nx; this.y[i] = ny; this.z[i] = nz;
    }
  }
}
