/**
 * The voxel world: terrain, elements, gravity, fire, water, falling sand.
 *
 * RESOLUTION. `res` is voxels per metre. The terrain is a smooth function of
 * position in metres, sampled at the centre of each voxel, so the same seed at
 * res 0.5 is a blocky version and at res 4 a smooth version of the same land.
 * Bodies collide with the real voxels, so blocky really is blocky to walk on.
 *
 * ONLY WHAT IS NEEDED. Nothing here scans the whole world each tick.
 *   - Voxel physics (falling, flowing, burning) runs from a work queue. A voxel
 *     is queued only when it or a neighbour changes, and leaves the queue when
 *     it settles. A still world costs nothing.
 *   - Slow processes (plants ripening) run as random ticks, but only in chunks
 *     near an agent ("awake" chunks). A chunk that was asleep catches up in one
 *     pass when it wakes, so time still passed there.
 *   - Falling blocks are bodies only while they fall.
 *   - Particles come from a fixed pool.
 *
 * TIME. One tick is `dt` seconds. Gravity, speeds and damage are all in metres,
 * seconds and kilograms, so changing `dt` or `res` changes fidelity, not the laws.
 */
import { Rng, hash32, noise3, fbm2 } from './random.mjs';
import {
  M, PHASE, PHASE_OF, BODY_SOLID, FLAM, BURN, DYNAMIC, STRUCT,
} from './materials.mjs';
import { Particles, PK } from './particles.mjs';
import { moveBody, overlaps } from './bodies.mjs';

export const CHUNK = 16;
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TWO32 = 4294967296;

export class World {
  /**
   * @param {object} o
   * @param {number} [o.seed]
   * @param {number} [o.res]        voxels per metre (0.5 blocky, 1 default, 2-4 smooth)
   * @param {number[]} [o.size]     [x, y, z] extent in metres
   * @param {number} [o.dt]         seconds per tick
   * @param {number} [o.gravity]    m/s^2
   * @param {number} [o.seaLevel]   metres
   */
  constructor(o = {}) {
    this.seed = o.seed ?? 1;
    this.res = o.res ?? 1;
    this.vs = 1 / this.res;
    this.dt = o.dt ?? 0.1;
    this.gravity = o.gravity ?? 9.81;
    this.seaLevel = o.seaLevel ?? 10;
    const size = o.size ?? [64, 32, 64];
    this.sizeM = size;
    this.nx = Math.max(8, Math.round(size[0] * this.res));
    this.ny = Math.max(8, Math.round(size[1] * this.res));
    this.nz = Math.max(8, Math.round(size[2] * this.res));
    this.n = this.nx * this.ny * this.nz;
    this.mat = new Uint8Array(this.n);
    this.owner = new Uint16Array(this.n);
    this.meta = new Uint8Array(this.n);
    this.cnx = Math.ceil(this.nx / CHUNK);
    this.cny = Math.ceil(this.ny / CHUNK);
    this.cnz = Math.ceil(this.nz / CHUNK);
    this.chunkLast = new Int32Array(this.cnx * this.cny * this.cnz);

    this.tick = 0;
    this.rng = new Rng(hash32(this.seed, 77));
    this.randomTicksPerChunk = o.randomTicksPerChunk ?? 6;
    this.maxVoxelUpdates = o.maxVoxelUpdates ?? 20000;
    this.stepHeight = Math.max(0.6, this.vs);

    /** voxel indices that need physics next tick */
    this.active = new Set();
    /** voxel index -> id of the agent whose action set this chain of events off */
    this.cause = new Map();
    this.blocks = [];
    this.awake = new Set();
    this.particles = new Particles(o.particles ?? 1024);
    this.cosmetics = o.cosmetics ?? true;
    /** agent id -> number of voxels they placed that are still standing */
    this.built = new Map();
    /** set by the simulation: called when fire destroys somebody's property */
    this.onProperty = null;
    this.stats = { voxelUpdates: 0, awakeChunks: 0, wokeChunks: 0, blocksFalling: 0, queued: 0 };

    this.generate();
  }

  // ---- addressing ----------------------------------------------------------

  idx(ix, iy, iz) {
    return (iy * this.nz + iz) * this.nx + ix;
  }
  inBounds(ix, iy, iz) {
    return ix >= 0 && iy >= 0 && iz >= 0 && ix < this.nx && iy < this.ny && iz < this.nz;
  }
  /** Material at a voxel. Outside the sides and below is bedrock; above is open sky. */
  get(ix, iy, iz) {
    if (iy >= this.ny && ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz) return M.AIR;
    if (!this.inBounds(ix, iy, iz)) return M.BEDROCK;
    return this.mat[this.idx(ix, iy, iz)];
  }
  getOwner(ix, iy, iz) {
    return this.inBounds(ix, iy, iz) ? this.owner[this.idx(ix, iy, iz)] : 0;
  }
  isBodySolid(ix, iy, iz) {
    if (iy < 0 || ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return true;
    if (iy >= this.ny) return false;
    return BODY_SOLID[this.mat[this.idx(ix, iy, iz)]] === 1;
  }
  chunkOf(ix, iy, iz) {
    return ((iy >> 4) * this.cnz + (iz >> 4)) * this.cnx + (ix >> 4);
  }
  /** Voxel coordinate of a point in metres. */
  cell(m) {
    return Math.floor(m * this.res);
  }

  /**
   * Change one voxel. Wakes the voxel and its neighbours so physics notices.
   * `cause` is the agent (if any) whose action started this, so a landslide or
   * a flood can be traced back to who set it off.
   */
  set(ix, iy, iz, m, owner = 0, meta = 0, cause = 0) {
    if (!this.inBounds(ix, iy, iz)) return false;
    const i = this.idx(ix, iy, iz);
    const po = this.owner[i];
    if (po && STRUCT[this.mat[i]]) this.built.set(po, (this.built.get(po) || 1) - 1);
    this.mat[i] = m;
    this.owner[i] = owner;
    this.meta[i] = meta;
    if (owner && STRUCT[m]) this.built.set(owner, (this.built.get(owner) || 0) + 1);
    this.wake(ix, iy, iz, cause);
    for (const d of DIRS6) this.wake(ix + d[0], iy + d[1], iz + d[2], cause);
    return true;
  }

  wake(ix, iy, iz, cause = 0) {
    if (!this.inBounds(ix, iy, iz)) return;
    const i = this.idx(ix, iy, iz);
    if (DYNAMIC[this.mat[i]]) {
      this.active.add(i);
      if (cause) this.cause.set(i, cause);
    }
  }

  // ---- terrain -------------------------------------------------------------

  /** Ground height in metres at a point. The same at every resolution. */
  terrainHeight(x, z) {
    // value noise clusters near 0.5, so stretch it to get real hills and lakes
    const a = Math.min(1, Math.max(0, 0.5 + (fbm2(this.seed, x * 0.025, z * 0.025, 4) - 0.5) * 2.6));
    const b = fbm2(this.seed + 1, x * 0.08, z * 0.08, 2);
    const h = 4 + a * 16 + b * 3;
    return Math.min(h, this.ny * this.vs - 6);
  }

  fillBox(x0, x1, y0, y1, z0, z1, m) {
    const r = this.res;
    const lo = (v) => Math.floor(v * r + 1e-6);
    const hi = (v, l) => Math.max(l, Math.ceil(v * r - 1e-6) - 1);
    const ax = lo(x0), ay = lo(y0), az = lo(z0);
    const bx = hi(x1, ax), by = hi(y1, ay), bz = hi(z1, az);
    for (let iy = Math.max(0, ay); iy <= Math.min(this.ny - 1, by); iy++)
      for (let iz = Math.max(0, az); iz <= Math.min(this.nz - 1, bz); iz++)
        for (let ix = Math.max(0, ax); ix <= Math.min(this.nx - 1, bx); ix++) {
          const i = this.idx(ix, iy, iz);
          this.mat[i] = m;
          this.owner[i] = 0;
          this.meta[i] = 0;
        }
  }

  generate() {
    const { nx, ny, nz, vs, seed, seaLevel, mat } = this;
    const heights = (this.heights = new Float32Array(nx * nz));
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++) heights[iz * nx + ix] = this.terrainHeight((ix + 0.5) * vs, (iz + 0.5) * vs);

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const h = heights[iz * nx + ix];
        const beach = h < seaLevel + 1.0;
        const xc = (ix + 0.5) * vs, zc = (iz + 0.5) * vs;
        for (let iy = 0; iy < ny; iy++) {
          const yc = (iy + 0.5) * vs;
          let m = M.AIR;
          if (iy === 0) m = M.BEDROCK;
          else if (yc < h) {
            const depth = h - yc;
            if (depth <= vs) m = beach ? M.SAND : M.GRASS;
            else if (depth <= (beach ? 1.5 : 3)) m = beach ? M.SAND : M.DIRT;
            else {
              m = M.STONE;
              if (depth > 5) {
                if (noise3(seed + 11, xc * 0.11, yc * 0.16, zc * 0.11) > 0.72) m = yc < 3 ? M.LAVA : M.AIR;
                else if (noise3(seed + 23, xc * 0.3, yc * 0.3, zc * 0.3) > 0.8) m = M.ORE;
                else if (noise3(seed + 31, xc * 0.2, yc * 0.2, zc * 0.2) > 0.82) m = M.GRAVEL;
              }
            }
          } else if (yc < seaLevel) m = M.WATER;
          mat[this.idx(ix, iy, iz)] = m;
        }
      }
    }
    this.plantTrees();
    this.plantBushes();
    this.buildJail();
  }

  /** Index of the highest voxel in a column that is not air or fire. */
  topSolid(ix, iz) {
    for (let iy = this.ny - 1; iy >= 0; iy--) {
      const m = this.mat[this.idx(ix, iy, iz)];
      if (m !== M.AIR && m !== M.FIRE) return iy;
    }
    return 0;
  }

  plantTrees() {
    const CELL = 7;
    const { vs, res, seed, seaLevel } = this;
    const sx = this.nx * vs, sz = this.nz * vs;
    for (let cz = 0; cz * CELL < sz; cz++) {
      for (let cx = 0; cx * CELL < sx; cx++) {
        const hh = hash32(seed, cx, cz, 5);
        if (hh / TWO32 > 0.3) continue;
        const fx = (hash32(seed, cx, cz, 6) / TWO32) * 0.7 + 0.15;
        const fz = (hash32(seed, cx, cz, 7) / TWO32) * 0.7 + 0.15;
        const ix0 = Math.floor((cx + fx) * CELL * res), iz0 = Math.floor((cz + fz) * CELL * res);
        if (ix0 < 2 || iz0 < 2 || ix0 >= this.nx - 2 || iz0 >= this.nz - 2) continue;
        const h = this.heights[iz0 * this.nx + ix0];
        if (h < seaLevel + 1.5 || this.mat[this.idx(ix0, Math.floor(h * res - 1e-6), iz0)] !== M.GRASS) continue;
        const tx = (ix0 + 0.5) * vs, tz = (iz0 + 0.5) * vs;
        const trunkH = 4 + ((hh >>> 8) % 3);
        const trunkR = Math.max(0.4, vs * 0.5);
        const top = h + trunkH;
        const R = 2.2;
        const bx0 = Math.max(0, Math.floor((tx - R) * res)), bx1 = Math.min(this.nx - 1, Math.floor((tx + R) * res));
        const bz0 = Math.max(0, Math.floor((tz - R) * res)), bz1 = Math.min(this.nz - 1, Math.floor((tz + R) * res));
        const by0 = Math.max(1, Math.floor(h * res)), by1 = Math.min(this.ny - 1, Math.floor((top + R) * res));
        for (let iy = by0; iy <= by1; iy++) {
          const yc = (iy + 0.5) * vs;
          for (let iz = bz0; iz <= bz1; iz++) {
            for (let ix = bx0; ix <= bx1; ix++) {
              const xc = (ix + 0.5) * vs, zc = (iz + 0.5) * vs;
              const i = this.idx(ix, iy, iz);
              const cur = this.mat[i];
              if (cur !== M.AIR && cur !== M.LEAVES) continue;
              if (yc >= h && yc < top && Math.abs(xc - tx) <= trunkR && Math.abs(zc - tz) <= trunkR) {
                this.mat[i] = M.WOOD;
              } else if (cur === M.AIR && yc >= h + trunkH * 0.5) {
                const d2 = (xc - tx) ** 2 + (yc - top) ** 2 + (zc - tz) ** 2;
                if (d2 <= R * R) this.mat[i] = M.LEAVES;
              }
            }
          }
        }
      }
    }
  }

  plantBushes() {
    const { vs, seed } = this;
    const p = 0.015 * vs * vs;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        if (hash32(seed, ix, iz, 9) / TWO32 >= p) continue;
        const top = this.topSolid(ix, iz);
        if (this.mat[this.idx(ix, top, iz)] !== M.GRASS || top + 1 >= this.ny) continue;
        const i = this.idx(ix, top + 1, iz);
        if (this.mat[i] !== M.AIR) continue;
        this.mat[i] = hash32(seed, ix, iz, 10) % 5 < 3 ? M.BUSH_RIPE : M.BUSH_BARE;
      }
    }
  }

  /**
   * The jail is a sealed bedrock room underground. Prisoners cannot dig out
   * because bedrock cannot be mined, and the state feeds them (see sim.mjs).
   */
  buildJail() {
    const { vs, seaLevel } = this;
    const sx = this.nx * vs, sz = this.nz * vs;
    let jx = sx * 0.25, jz = sz * 0.25, h = this.terrainHeight(jx, jz);
    for (let k = 0; k < 40 && h < seaLevel + 3; k++) {
      jx = 6 + ((k * 13) % Math.max(1, sx - 12));
      jz = 6 + ((k * 29) % Math.max(1, sz - 12));
      h = this.terrainHeight(jx, jz);
    }
    const jy = Math.max(3, Math.round(h) - 8);
    this.fillBox(jx - 3, jx + 3, jy - 1, jy + 4, jz - 3, jz + 3, M.BEDROCK);
    this.fillBox(jx - 2, jx + 2, jy, jy + 3, jz - 2, jz + 2, M.AIR);
    const ix = this.cell(jx), iz = this.cell(jz);
    let iy = Math.max(1, this.cell(jy - 1));
    while (iy < this.ny - 1 && this.mat[this.idx(ix, iy, iz)] !== M.AIR) iy++;
    this.jail = { x: jx, y: iy * vs + 1e-3, z: jz, box: [jx - 3, jy - 1, jz - 3, jx + 3, jy + 4, jz + 3] };
  }

  /**
   * Flatten a square of the world into a level arena (stone, dirt, grass) with
   * open sky above. For tests and for curricula that need a known stage.
   * Returns the height of the ground surface in metres.
   */
  flatArena(cx, cz, half = 8, ground = 14) {
    const ny = this.ny * this.vs;
    const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
    this.fillBox(x0, x1, 1, ground - 2, z0, z1, M.STONE);
    this.fillBox(x0, x1, ground - 2, ground - 1, z0, z1, M.DIRT);
    this.fillBox(x0, x1, ground - 1, ground, z0, z1, M.GRASS);
    this.fillBox(x0, x1, ground, ny, z0, z1, M.AIR);
    return ground;
  }

  /** A standing spot on dry land near (cx, cz). */
  findSpawn(rng, cx = this.nx * this.vs / 2, cz = this.nz * this.vs / 2, radius = 10) {
    const clear = Math.ceil(2 * this.res) + 1;
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = Math.min(this.nx * this.vs - 2, Math.max(2, cx + (rng.next() * 2 - 1) * radius));
      const z = Math.min(this.nz * this.vs - 2, Math.max(2, cz + (rng.next() * 2 - 1) * radius));
      const ix = this.cell(x), iz = this.cell(z);
      const top = this.topSolid(ix, iz);
      const m = this.mat[this.idx(ix, top, iz)];
      if (m !== M.GRASS && m !== M.SAND && m !== M.DIRT) continue;
      if (top + clear >= this.ny) continue;
      let free = true;
      for (let k = 1; k <= clear && free; k++) if (this.get(ix, top + k, iz) !== M.AIR) free = false;
      if (free) return { x: (ix + 0.5) * this.vs, y: (top + 1) * this.vs + 1e-3, z: (iz + 0.5) * this.vs };
    }
    return { x: cx, y: this.ny * this.vs - 2, z: cz };
  }

  // ---- awake chunks, random ticks, catching up -----------------------------

  beginTick() {
    this.tick++;
    this.stats.voxelUpdates = 0;
    this.stats.wokeChunks = 0;
  }

  /** Decide which chunks are near enough to someone to be worth simulating. */
  updateAwake(points, radiusM) {
    const awake = new Set();
    const r = radiusM * this.res;
    for (const p of points) {
      const c = (v, n, size) => Math.min(n - 1, Math.max(0, Math.floor(v / size)));
      const x0 = c(p.x * this.res - r, this.cnx, CHUNK), x1 = c(p.x * this.res + r, this.cnx, CHUNK);
      const y0 = c(p.y * this.res - r, this.cny, CHUNK), y1 = c(p.y * this.res + r, this.cny, CHUNK);
      const z0 = c(p.z * this.res - r, this.cnz, CHUNK), z1 = c(p.z * this.res + r, this.cnz, CHUNK);
      for (let cy = y0; cy <= y1; cy++)
        for (let cz = z0; cz <= z1; cz++)
          for (let cx = x0; cx <= x1; cx++) awake.add((cy * this.cnz + cz) * this.cnx + cx);
    }
    for (const c of awake) {
      const missed = this.tick - this.chunkLast[c] - 1;
      if (missed > 0) {
        this.catchUp(c, missed);
        this.stats.wokeChunks++;
      }
    }
    this.awake = awake;
    this.stats.awakeChunks = awake.size;
  }

  chunkBounds(c) {
    const cx = c % this.cnx, r = (c - cx) / this.cnx, cz = r % this.cnz, cy = (r - cz) / this.cnz;
    return {
      x0: cx * CHUNK, x1: Math.min(this.nx, cx * CHUNK + CHUNK),
      y0: cy * CHUNK, y1: Math.min(this.ny, cy * CHUNK + CHUNK),
      z0: cz * CHUNK, z1: Math.min(this.nz, cz * CHUNK + CHUNK),
    };
  }

  /** Per-voxel chance that a random tick lands on it in one tick. */
  get randomRate() {
    return this.randomTicksPerChunk / (CHUNK * CHUNK * CHUNK);
  }

  /** A chunk that slept for `missed` ticks: do in one pass what random ticks would have done. */
  catchUp(c, missed) {
    const p = 1 - Math.pow(1 - this.randomRate, missed);
    const b = this.chunkBounds(c);
    for (let iy = b.y0; iy < b.y1; iy++)
      for (let iz = b.z0; iz < b.z1; iz++)
        for (let ix = b.x0; ix < b.x1; ix++) {
          const i = this.idx(ix, iy, iz);
          if (this.mat[i] === M.BUSH_BARE && this.rng.chance(p)) this.mat[i] = M.BUSH_RIPE;
        }
  }

  randomTicks() {
    for (const c of this.awake) {
      const b = this.chunkBounds(c);
      for (let k = 0; k < this.randomTicksPerChunk; k++) {
        const ix = b.x0 + this.rng.int(CHUNK), iy = b.y0 + this.rng.int(CHUNK), iz = b.z0 + this.rng.int(CHUNK);
        if (ix >= b.x1 || iy >= b.y1 || iz >= b.z1) continue;
        const i = this.idx(ix, iy, iz);
        if (this.mat[i] === M.BUSH_BARE) this.mat[i] = M.BUSH_RIPE;
      }
      this.chunkLast[c] = this.tick;
    }
  }

  // ---- voxel physics -------------------------------------------------------

  /** Run queued voxel physics: falling, flowing, burning. Cost follows activity, not world size. */
  stepPhysics() {
    this.stats.queued = this.active.size;
    if (this.active.size === 0) return;
    const list = Array.from(this.active).sort((a, b) => a - b); // low voxels first, so a column falls together
    this.active.clear();
    let used = 0;
    let k = 0;
    for (; k < list.length && used < this.maxVoxelUpdates; k++, used++) this.updateVoxel(list[k]);
    for (; k < list.length; k++) this.active.add(list[k]);
    this.stats.voxelUpdates = used;
  }

  updateVoxel(i) {
    const m = this.mat[i];
    const cause = this.cause.get(i) || 0;
    this.cause.delete(i);
    const ix = i % this.nx;
    const r = (i - ix) / this.nx;
    const iz = r % this.nz;
    const iy = (r - iz) / this.nz;
    if (m === M.FIRE) this.updateFire(ix, iy, iz, i);
    else if (PHASE_OF[m] === PHASE.POWDER) this.updatePowder(ix, iy, iz, i, m, cause);
    else if (PHASE_OF[m] === PHASE.LIQUID) this.updateLiquid(ix, iy, iz, i, m, cause);
  }

  /** Swap a voxel into an empty neighbour. */
  moveVoxel(ix, iy, iz, tx, ty, tz, cause) {
    const i = this.idx(ix, iy, iz), t = this.idx(tx, ty, tz);
    const m = this.mat[i], o = this.owner[i], meta = this.meta[i];
    const was = this.mat[t];
    this.mat[t] = m; this.owner[t] = o; this.meta[t] = meta;
    this.mat[i] = M.AIR; this.owner[i] = 0; this.meta[i] = 0;
    if (was === M.FIRE) this.puff(PK.STEAM, tx, ty, tz);
    this.wake(tx, ty, tz, cause);
    for (const d of DIRS6) {
      this.wake(ix + d[0], iy + d[1], iz + d[2], cause);
      this.wake(tx + d[0], ty + d[1], tz + d[2], cause);
    }
  }

  puff(kind, ix, iy, iz) {
    if (!this.cosmetics) return;
    const c = this.chunkOf(ix, iy, iz);
    if (!this.awake.has(c)) return;
    const v = this.vs;
    this.particles.emit(kind, (ix + 0.5) * v, (iy + 0.5) * v, (iz + 0.5) * v, 0, kind === PK.DUST ? 0.5 : 1, 0, 1.5 + this.rng.next());
  }

  updatePowder(ix, iy, iz, i, m, cause) {
    const below = this.get(ix, iy - 1, iz);
    if (below === M.AIR || below === M.FIRE) {
      // nothing under it: it becomes a falling block with real gravity
      const owner = this.owner[i];
      this.set(ix, iy, iz, M.AIR, 0, 0, cause);
      const v = this.vs;
      this.blocks.push({
        kind: 'block', mat: m, owner, cause,
        x: (ix + 0.5) * v, y: iy * v + v * 0.01, z: (iz + 0.5) * v,
        vx: 0, vy: 0, vz: 0, hw: v * 0.49, h: v * 0.98, hit: new Set(), onGround: false, impact: 0,
      });
      return;
    }
    if (PHASE_OF[below] === PHASE.LIQUID) {
      // denser than liquid: sink through it
      const ti = this.idx(ix, iy - 1, iz);
      const lm = this.mat[ti], lo = this.owner[ti], lmeta = this.meta[ti];
      const po = this.owner[i];
      this.mat[ti] = m; this.owner[ti] = po; this.meta[ti] = 0;
      this.mat[i] = lm; this.owner[i] = lo; this.meta[i] = lmeta;
      this.wake(ix, iy, iz, cause);
      for (const d of DIRS6) {
        this.wake(ix + d[0], iy + d[1], iz + d[2], cause);
        this.wake(ix + d[0], iy - 1 + d[1], iz + d[2], cause);
      }
      return;
    }
    // resting on something: slide down a slope if there is room
    const dirs = this.rng.shuffle(DIRS4.slice());
    for (const [dx, dz] of dirs) {
      if (this.get(ix + dx, iy, iz + dz) === M.AIR && this.get(ix + dx, iy - 1, iz + dz) === M.AIR) {
        this.moveVoxel(ix, iy, iz, ix + dx, iy, iz + dz, cause);
        return;
      }
    }
  }

  updateLiquid(ix, iy, iz, i, m, cause) {
    if (m === M.LAVA) {
      if ((this.tick & 3) !== 0) { this.active.add(i); return; } // lava is slow
      const o = this.owner[i];
      for (const d of DIRS6) {
        const nm = this.get(ix + d[0], iy + d[1], iz + d[2]);
        if (nm === M.WATER) {
          this.set(ix, iy, iz, M.STONE, 0, 0, o);
          this.puff(PK.STEAM, ix, iy, iz);
          return;
        }
        if (FLAM[nm] > 0 && this.rng.chance(0.08)) this.ignite(ix + d[0], iy + d[1], iz + d[2], o);
      }
    }
    const below = this.get(ix, iy - 1, iz);
    if (below === M.AIR || below === M.FIRE) {
      this.moveVoxel(ix, iy, iz, ix, iy - 1, iz, cause);
      return;
    }
    const levelling = PHASE_OF[below] === PHASE.LIQUID;
    const dirs = this.rng.shuffle(DIRS4.slice());
    for (const [dx, dz] of dirs) {
      if (this.get(ix + dx, iy, iz + dz) !== M.AIR) continue;
      const tb = this.get(ix + dx, iy - 1, iz + dz);
      // flows off an edge, or levels out when it sits on more liquid
      if (tb === M.AIR || tb === M.FIRE || levelling) {
        this.moveVoxel(ix, iy, iz, ix + dx, iy, iz + dz, cause);
        return;
      }
    }
  }

  updateFire(ix, iy, iz, i) {
    const owner = this.owner[i];
    for (const d of DIRS6) {
      if (this.get(ix + d[0], iy + d[1], iz + d[2]) === M.WATER) {
        this.set(ix, iy, iz, M.AIR, 0, 0, 0);
        this.puff(PK.STEAM, ix, iy, iz);
        return;
      }
    }
    if (this.meta[i] <= 1) {
      this.set(ix, iy, iz, M.AIR, 0, 0, 0);
      this.puff(PK.SMOKE, ix, iy, iz);
      return;
    }
    this.meta[i]--;
    for (const d of DIRS6) {
      const nm = this.get(ix + d[0], iy + d[1], iz + d[2]);
      if (FLAM[nm] > 0 && this.rng.chance(FLAM[nm] * 0.05)) this.ignite(ix + d[0], iy + d[1], iz + d[2], owner);
    }
    if (this.rng.chance(0.02)) {
      const v = this.vs;
      this.particles.emit(
        PK.SPARK, (ix + 0.5) * v, (iy + 1) * v, (iz + 0.5) * v,
        this.rng.range(-2, 2), this.rng.range(1, 3.5), this.rng.range(-2, 2), 2, owner,
      );
    }
    if (this.rng.chance(0.05)) this.puff(PK.SMOKE, ix, iy + 1, iz);
    this.active.add(i);
  }

  /**
   * Set a voxel on fire. Flammable things burn for their burn time; empty air
   * gets a short flame. Fire remembers who lit it, so harm can be traced.
   */
  ignite(ix, iy, iz, owner = 0) {
    const m = this.get(ix, iy, iz);
    if (m === M.FIRE || m === M.BEDROCK || !this.inBounds(ix, iy, iz)) return false;
    if (m === M.AIR) {
      this.set(ix, iy, iz, M.FIRE, owner, 25, owner);
      return true;
    }
    if (FLAM[m] <= 0) return false;
    const prev = this.owner[this.idx(ix, iy, iz)];
    this.set(ix, iy, iz, M.FIRE, owner, Math.max(2, BURN[m]), owner);
    if (prev && prev !== owner && this.onProperty) {
      this.onProperty({ kind: 'arson', mat: m, prevOwner: prev, causer: owner, ix, iy, iz });
    }
    return true;
  }

  // ---- falling blocks ------------------------------------------------------

  /**
   * Move falling blocks under gravity. `agents` are checked for impacts;
   * `onHit(block, agent, speed)` is called once per block per agent.
   */
  stepBlocks(agents, onHit) {
    const dt = this.dt;
    const keep = [];
    for (const b of this.blocks) {
      b.vy = Math.max(b.vy - this.gravity * dt, -60);
      const speed = -b.vy;
      moveBody(this, b, dt);
      for (const a of agents) {
        if (a.alive && !b.hit.has(a.id) && overlaps(b, a)) {
          b.hit.add(a.id);
          onHit(b, a, Math.max(speed, b.impact || 0));
        }
      }
      if (b.onGround) this.land(b);
      else keep.push(b);
    }
    this.blocks = keep;
    this.stats.blocksFalling = keep.length;
  }

  land(b) {
    const ix = this.cell(b.x), iz = this.cell(b.z);
    let iy = this.cell(b.y + b.h * 0.5);
    for (let k = 0; k < 6; k++, iy++) {
      const cur = this.get(ix, iy, iz);
      if (cur === M.AIR || cur === M.FIRE) break;
      if (PHASE_OF[cur] === PHASE.LIQUID) {
        this.displaceLiquid(ix, iy, iz);
        break;
      }
    }
    if (!this.inBounds(ix, iy, iz)) return;
    const cur = this.get(ix, iy, iz);
    if (cur !== M.AIR && cur !== M.FIRE) return; // nowhere to land: the block is lost
    this.set(ix, iy, iz, b.mat, b.owner, 0, b.cause);
    this.puff(PK.DUST, ix, iy, iz);
  }

  /** Push a liquid voxel up to the nearest free cell above it (a block is taking its place). */
  displaceLiquid(ix, iy, iz) {
    const i = this.idx(ix, iy, iz);
    const m = this.mat[i], o = this.owner[i];
    for (let k = 1; k <= 8; k++) {
      const c = this.get(ix, iy + k, iz);
      if (c === M.AIR || c === M.FIRE) {
        this.set(ix, iy + k, iz, m, o);
        this.set(ix, iy, iz, M.AIR);
        return;
      }
      if (PHASE_OF[c] !== PHASE.LIQUID) break;
    }
    this.set(ix, iy, iz, M.AIR); // nowhere for it to go
  }

  // ---- helpers for tests and tools -----------------------------------------

  countMaterial(m) {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.mat[i] === m) c++;
    return c;
  }

  /** A fingerprint of the whole world, to check two runs came out identical. */
  checksum() {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.n; i++) {
      h = Math.imul(h ^ this.mat[i], 16777619);
      h = Math.imul(h ^ this.owner[i], 16777619);
    }
    return h >>> 0;
  }
}
