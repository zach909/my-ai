/**
 * The ledger: who did what to whom, and the training signal that follows.
 *
 * Two rules, applied to every agent, always:
 *   1. Anything that HARMS another agent is recorded against whoever caused it
 *      and costs that agent reward. Causing it includes indirect routes: lighting
 *      a fire that spreads, mining out the ground someone stands on, dropping sand
 *      on them, shoving them off a ledge. (Nature causes harm too; nobody is
 *      blamed for that.)
 *   2. Anything KIND is never punished. Giving someone something they need earns
 *      reward. Kindness that is only a loop (two agents swapping the same thing
 *      back and forth) earns less every time, so it cannot be farmed.
 *
 * Harm is measured in "harm points": one point is one health point, and every
 * other kind of loss (stolen food, a wrecked wall, a death) is converted into
 * points using the item values in materials.mjs.
 *
 * Self-defence is real: if the victim started the fight, hitting back is
 * recorded but counts for a fraction of its harm and is not prosecuted.
 */

export const HARM_KINDS = ['attack', 'fire', 'lava', 'block', 'fall', 'drown', 'theft', 'property', 'death', 'other'];

export class Ledger {
  constructor(cfg = {}) {
    this.cfg = {
      harmScale: 0.01,        // reward per harm point (100 points = -1.0)
      kindScale: 0.01,        // reward per benefit point
      selfDefenseFactor: 0.2, // how much of the harm still counts when hitting back
      fightWindow: 100,       // ticks a fight stays "live"
      giftWindow: 3000,       // ticks over which repeat gifts between a pair lose value
      repScale: 100,          // harm points that move reputation by 1.0
      ...cfg,
    };
    this.tick = 0;
    this.nextId = 1;
    this.incidents = [];
    this.byId = new Map();
    this.rewards = new Map();
    this.stats = new Map();
    this.rep = new Map();
    this.lastAgg = new Map();
    this.fightStart = new Map();
    this.gifts = new Map();
    this.natural = { harm: 0 };
    /** set by the simulation: called with each new incident */
    this.onIncident = null;
    /** set by the simulation: called with each kindness record */
    this.onKindness = null;
  }

  setTick(t) {
    this.tick = t;
    if (t % 100 === 0) for (const [k, v] of this.rep) this.rep.set(k, v * 0.99); // old deeds fade
  }

  stat(id) {
    let s = this.stats.get(id);
    if (!s) {
      s = { harmDone: 0, harmReceived: 0, kindDone: 0, kindReceived: 0, incidents: 0, selfDefense: 0 };
      this.stats.set(id, s);
    }
    return s;
  }
  acc(id) {
    let r = this.rewards.get(id);
    if (!r) {
      r = { harm: 0, kindness: 0, survival: 0, build: 0, justice: 0 };
      this.rewards.set(id, r);
    }
    return r;
  }
  reputation(id) {
    return Math.max(-1, Math.min(1, this.rep.get(id) || 0));
  }
  addRep(id, d) {
    this.rep.set(id, (this.rep.get(id) || 0) + d);
  }

  /** Was `actor` hitting back in a fight `victim` started? */
  isSelfDefense(actor, victim) {
    const w = this.cfg.fightWindow;
    const tb = this.lastAgg.get(`${victim}>${actor}`);
    if (tb === undefined || this.tick - tb > w) return false;
    const ta = this.lastAgg.get(`${actor}>${victim}`);
    const fa = ta !== undefined && this.tick - ta <= w ? this.fightStart.get(`${actor}>${victim}`) : undefined;
    if (fa === undefined) return true;
    return this.fightStart.get(`${victim}>${actor}`) < fa;
  }

  noteAggression(actor, victim) {
    const key = `${actor}>${victim}`;
    const last = this.lastAgg.get(key);
    if (last === undefined || this.tick - last > this.cfg.fightWindow) this.fightStart.set(key, this.tick);
    this.lastAgg.set(key, this.tick);
  }

  /**
   * Record harm. Returns the incident, or null when nobody is to blame
   * (nature, or an agent hurting itself).
   */
  harm(actor, victim, kind, amount, info = {}) {
    if (amount <= 0) return null;
    if (!actor || actor === victim) {
      if (!actor) this.natural.harm += amount;
      return null;
    }
    const sd = this.isSelfDefense(actor, victim);
    if (kind === 'attack') this.noteAggression(actor, victim);
    const weight = sd ? this.cfg.selfDefenseFactor : 1;
    this.acc(actor).harm -= amount * weight * this.cfg.harmScale;
    const sa = this.stat(actor), sv = this.stat(victim);
    sa.harmDone += amount;
    sa.incidents++;
    if (sd) sa.selfDefense++;
    sv.harmReceived += amount;
    this.addRep(actor, (-amount * weight) / this.cfg.repScale);
    const inc = {
      id: this.nextId++, tick: this.tick, kind, actor, victim, harm: amount, selfDefense: sd,
      witnesses: info.witnesses || [], status: 'open', note: info.note || '',
    };
    this.incidents.push(inc);
    this.byId.set(inc.id, inc);
    if (this.incidents.length > 4000) {
      for (const old of this.incidents.splice(0, 1000)) this.byId.delete(old.id);
    }
    if (this.onIncident) this.onIncident(inc);
    return inc;
  }

  /** A reward cost with no incident attached (for example a false accusation). */
  penalty(actor, points, reason = '') {
    if (!actor || points <= 0) return;
    this.acc(actor).justice -= points * this.cfg.harmScale;
    this.addRep(actor, -points / this.cfg.repScale);
  }

  /**
   * Record kindness. `benefit` is in the same points as harm. Returns the
   * amount credited after diminishing returns for repeat gifts in a pair.
   */
  kindness(giver, receiver, kind, benefit, info = {}) {
    if (!giver || giver === receiver || benefit <= 0) return 0;
    const key = giver < receiver ? `${giver}-${receiver}` : `${receiver}-${giver}`;
    const recent = (this.gifts.get(key) || []).filter((t) => this.tick - t <= this.cfg.giftWindow);
    const credited = benefit * Math.pow(0.5, recent.length);
    recent.push(this.tick);
    this.gifts.set(key, recent);
    this.acc(giver).kindness += credited * this.cfg.kindScale;
    this.stat(giver).kindDone += credited;
    this.stat(receiver).kindReceived += credited;
    this.addRep(giver, (credited * 0.5) / this.cfg.repScale);
    if (this.onKindness) this.onKindness({ tick: this.tick, giver, receiver, kind, benefit: credited, ...info });
    return credited;
  }

  /** Hand back and clear the rewards collected since the last call. */
  drain() {
    const out = new Map();
    for (const [id, r] of this.rewards) {
      out.set(id, { ...r, total: r.harm + r.kindness + r.survival + r.build + r.justice });
    }
    this.rewards = new Map();
    return out;
  }
}
