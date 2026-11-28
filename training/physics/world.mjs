/**
 * A small 3D physics world: point masses, rigid bones, muscles, gravity, and an infinite flat plane.
 * Written for this project from scratch (Node built-ins only, nothing imported).
 *
 * Method: extended position-based dynamics with many small substeps. Each substep moves every point by
 * its velocity and gravity, pulls constraint pairs back to their rest length, pushes points out of the
 * ground, applies Coulomb friction there, and reads the new velocity from how far each point really moved.
 *
 * Units: metres, seconds, kilograms, newtons. Y is up. The ground is the plane y = 0.
 *
 * What is physical here
 *   - Gravity (9.81 m/s^2), inertia, momentum: a point keeps moving unless something pushes it.
 *   - Bones are stiff distance constraints. Muscles are the same but can change their rest length at a
 *     limited speed (`rate`, m/s) and can pull with a limited force (`maxForce`, N). A muscle cannot
 *     teleport and cannot lift more than it is strong enough for.
 *   - The ground pushes back, never pulls. Friction is Coulomb: a foot sticks while the sideways push is
 *     below `mu` times the normal push, and slides (losing speed) when it is above.
 *   - Nothing is inelastic by magic: speed is measured from displacement, so a landing really loses
 *     its downward speed to the ground and energy is only lost through damping and friction.
 *
 * What is simplified: bodies are made of points (no rotational inertia of their own); the ground is
 * perfectly flat and rigid; no air flow, only a small linear drag.
 */

const GRAVITY = 9.81;

export class PhysicsWorld {
  /**
   * @param {object} [o]
   * @param {number} [o.dt=1/30]        seconds per step()
   * @param {number} [o.substeps=8]     solver substeps per step (smaller substeps = stiffer, more exact)
   * @param {number} [o.iterations=2]   constraint passes per substep
   * @param {number} [o.damping=0.15]   linear drag, 1/s (air)
   * @param {number} [o.maxPoints=64]
   * @param {number} [o.maxConstraints=128]
   */
  constructor(o = {}) {
    this.dt = o.dt ?? 1 / 30;
    this.substeps = o.substeps ?? 8;
    this.iterations = o.iterations ?? 2;
    this.damping = o.damping ?? 0.15;
    this.gravity = o.gravity ?? GRAVITY;
    this.time = 0;

    const P = o.maxPoints ?? 64;
    const C = o.maxConstraints ?? 128;
    this.maxPoints = P;
    this.maxConstraints = C;
    this.n = 0; // points
    this.m = 0; // constraints

    // positions, previous positions, velocities (x, y, z interleaved by array)
    this.x = new Float64Array(P); this.y = new Float64Array(P); this.z = new Float64Array(P);
    this.px = new Float64Array(P); this.py = new Float64Array(P); this.pz = new Float64Array(P);
    this.vx = new Float64Array(P); this.vy = new Float64Array(P); this.vz = new Float64Array(P);
    this.invMass = new Float64Array(P);
    this.mass = new Float64Array(P);
    this.radius = new Float64Array(P);
    this.mu = new Float64Array(P);
    this.contact = new Uint8Array(P); // 1 if touching the ground at the end of the last step
    this.contactForce = new Float64Array(P); // normal force estimate, newtons (last substep)

    // constraints
    this.ca = new Int32Array(C); this.cb = new Int32Array(C);
    this.rest = new Float64Array(C);
    this.target = new Float64Array(C);
    this.compliance = new Float64Array(C);
    this.maxForce = new Float64Array(C);   // Infinity for bones
    this.rate = new Float64Array(C);       // m/s the rest length may move toward target (Infinity for bones)
    this.isMuscle = new Uint8Array(C);
    this.force = new Float64Array(C);      // force in the constraint, newtons (last substep, signed: + pulls together)
  }

  addPoint(x, y, z, mass = 1, radius = 0.03, mu = 0.8) {
    if (this.n >= this.maxPoints) throw new Error('too many points');
    const i = this.n++;
    this.x[i] = this.px[i] = x; this.y[i] = this.py[i] = y; this.z[i] = this.pz[i] = z;
    this.mass[i] = mass;
    this.invMass[i] = mass > 0 ? 1 / mass : 0;
    this.radius[i] = radius;
    this.mu[i] = mu;
    return i;
  }

  distance(a, b) {
    const dx = this.x[a] - this.x[b], dy = this.y[a] - this.y[b], dz = this.z[a] - this.z[b];
    return Math.hypot(dx, dy, dz);
  }

  /** A stiff bone between two points, rest length taken from where they are now (or given). */
  addBond(a, b, length = this.distance(a, b), compliance = 0) {
    return this._add(a, b, length, compliance, Infinity, Infinity, 0);
  }

  /** A muscle: like a bone, but its length is steered with setMuscle(), with a speed and force limit. */
  addMuscle(a, b, { length = this.distance(a, b), maxForce = 400, rate = 1, compliance = 1e-6 } = {}) {
    return this._add(a, b, length, compliance, maxForce, rate, 1);
  }

  _add(a, b, length, compliance, maxForce, rate, muscle) {
    if (this.m >= this.maxConstraints) throw new Error('too many constraints');
    const c = this.m++;
    this.ca[c] = a; this.cb[c] = b;
    this.rest[c] = this.target[c] = length;
    this.compliance[c] = compliance;
    this.maxForce[c] = maxForce;
    this.rate[c] = rate;
    this.isMuscle[c] = muscle;
    return c;
  }

  _buildOrder() {
    const order = new Int32Array(this.m);
    let k = 0;
    for (let c = 0; c < this.m; c++) if (this.isMuscle[c]) order[k++] = c;
    for (let c = 0; c < this.m; c++) if (!this.isMuscle[c]) order[k++] = c;
    this.order = order;
    this._orderM = this.m;
  }

  /** Ask a muscle to move toward this length; it gets there no faster than its `rate`. */
  setMuscle(c, length) {
    this.target[c] = length;
  }

  /** One control step of `dt` seconds. */
  step() {
    const n = this.n, m = this.m;
    const h = this.dt / this.substeps;
    const g = this.gravity;
    const { x, y, z, px, py, pz, vx, vy, vz, invMass } = this;
    const drag = Math.max(0, 1 - this.damping * h);
    const ih2 = 1 / (h * h);
    const { ca, cb, rest, target, compliance, maxForce, rate, force, contact, contactForce, radius, mu } = this;
    if (this._orderM !== m) this._buildOrder();
    const order = this.order;

    for (let s = 0; s < this.substeps; s++) {
      // 1. predict
      for (let i = 0; i < n; i++) {
        px[i] = x[i]; py[i] = y[i]; pz[i] = z[i];
        if (invMass[i] === 0) continue;
        vy[i] -= g * h;
        x[i] += vx[i] * h; y[i] += vy[i] * h; z[i] += vz[i] * h;
      }
      // 2. muscles move their rest length toward the target, no faster than their speed
      for (let c = 0; c < m; c++) {
        if (!this.isMuscle[c]) continue;
        const d = target[c] - rest[c], step = rate[c] * h;
        rest[c] += d > step ? step : d < -step ? -step : d;
      }
      // 3. constraints. Muscles are solved first and bones last in every pass, so a bone always has the
      //    final word: a muscle can strain a joint but cannot stretch the skeleton.
      for (let it = 0; it < this.iterations; it++) {
        for (let k = 0; k < m; k++) {
          const c = order[k];
          const a = ca[c], b = cb[c];
          const dx = x[a] - x[b], dy = y[a] - y[b], dz = z[a] - z[b];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-9) continue;
          const w = invMass[a] + invMass[b];
          const at = compliance[c] * ih2;
          let dl = -(d - rest[c]) / (w + at);
          const cap = maxForce[c] * h * h;
          if (dl > cap) dl = cap; else if (dl < -cap) dl = -cap;
          force[c] = -dl * ih2; // + when pulling the two points together
          const q = dl / d;
          x[a] += invMass[a] * q * dx; y[a] += invMass[a] * q * dy; z[a] += invMass[a] * q * dz;
          x[b] -= invMass[b] * q * dx; y[b] -= invMass[b] * q * dy; z[b] -= invMass[b] * q * dz;
        }
      }
      // 4. ground: push out, then Coulomb friction from how far the point slid this substep
      for (let i = 0; i < n; i++) {
        contact[i] = 0; contactForce[i] = 0;
        if (invMass[i] === 0) continue;
        const pen = radius[i] - y[i];
        if (pen > 0) {
          y[i] = radius[i];
          contact[i] = 1;
          contactForce[i] = pen * this.mass[i] * ih2;
          const tx = x[i] - px[i], tz = z[i] - pz[i];
          const slide = Math.sqrt(tx * tx + tz * tz);
          const grip = mu[i] * pen;
          if (slide <= grip) { x[i] = px[i]; z[i] = pz[i]; }
          else { const f = grip / slide; x[i] -= tx * f; z[i] -= tz * f; }
        } else if (pen > -0.004) {
          contact[i] = 1; // resting on it, within 4 mm
        }
      }
      // 5. velocities from the real motion, plus a little air drag
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        vx[i] = (x[i] - px[i]) / h * drag;
        vy[i] = (y[i] - py[i]) / h * drag;
        vz[i] = (z[i] - pz[i]) / h * drag;
      }
    }
    this.time += this.dt;
  }

  /** Total kinetic + gravitational potential energy, joules (for tests). */
  energy() {
    let e = 0;
    for (let i = 0; i < this.n; i++) {
      const v2 = this.vx[i] ** 2 + this.vy[i] ** 2 + this.vz[i] ** 2;
      e += 0.5 * this.mass[i] * v2 + this.mass[i] * this.gravity * this.y[i];
    }
    return e;
  }

  /** Centre of mass [x, y, z]. */
  com(out = [0, 0, 0]) {
    let M = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.mass[i];
      M += w; cx += w * this.x[i]; cy += w * this.y[i]; cz += w * this.z[i];
    }
    out[0] = cx / M; out[1] = cy / M; out[2] = cz / M;
    return out;
  }

  /** Largest relative stretch of any bone (0 = all exact). A health check for the solver. */
  maxBondError() {
    let worst = 0;
    for (let c = 0; c < this.m; c++) {
      if (this.isMuscle[c]) continue;
      const e = Math.abs(this.distance(this.ca[c], this.cb[c]) - this.rest[c]) / this.rest[c];
      if (e > worst) worst = e;
    }
    return worst;
  }

  /** True while every position is a finite number. */
  isFinite() {
    for (let i = 0; i < this.n; i++) {
      if (!Number.isFinite(this.x[i] + this.y[i] + this.z[i])) return false;
    }
    return true;
  }
}
