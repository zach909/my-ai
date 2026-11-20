/**
 * An agent: a body in the world with needs, a bag of items, and a policy
 * (the thing being trained) that decides what to do.
 */
export class Agent {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    // body (metres, metres per second); x and z are the centre, y the feet
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.hw = 0.3; this.h = 1.8; this.eye = 1.6;
    this.step = true; // may climb small ledges
    this.onGround = false; this.inWater = false; this.impact = 0;
    // needs, 0..100
    this.health = 100;
    this.satiety = 100;
    this.air = 10; // seconds of breath
    this.burn = 0; this.burnOwner = 0;
    // life
    this.alive = true;
    this.deaths = 0;
    this.respawnAt = 0;
    this.jailedUntil = 0;
    this.jailWhy = '';
    /** the last agent that pushed or endangered us, so falls and fires can be traced */
    this.recentCause = { id: 0, tick: -1e9 };
    this.attackReadyAt = 0;
    this.lastAttackTick = -1e9;
    // controls
    this.move = { dx: 0, dz: 0, jump: false };
    this.inv = {};
    this.events = [];
    this.lastResult = null;
    this.lastBuilt = 0;
    // the thing being trained
    this.policy = null;
    this.rng = null;
    this.mem = {};
  }

  has(item, units) {
    return (this.inv[item] || 0) >= units - 1e-9;
  }
  add(item, units) {
    if (units <= 0) return;
    this.inv[item] = (this.inv[item] || 0) + units;
  }
  take(item, units) {
    const have = this.inv[item] || 0;
    if (have < units - 1e-9) return false;
    const left = have - units;
    if (left <= 1e-9) delete this.inv[item];
    else this.inv[item] = left;
    return true;
  }
  get speed() {
    return Math.hypot(this.vx, this.vz);
  }
}
