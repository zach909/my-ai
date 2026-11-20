/**
 * Justice: how the little society answers harm.
 *
 * Laws (config `mode`):
 *   'automatic'  every harmful incident is prosecuted the moment it happens
 *   'reported'   nothing happens unless the victim or a witness accuses the
 *                culprit within the report window. The court checks the claim
 *                against the ledger, which is the truth. A true accusation
 *                prosecutes. A false one is itself punished (perjury).
 *   'none'       no courts. The ledger still scores everyone; nobody is sanctioned.
 *
 * Sanctions are proportionate and can be undone:
 *   - Restitution first: the offender's goods are handed to the victim up to
 *     the value of the harm. Whatever cannot be paid stays as a debt.
 *   - A first or small offence stops there. Jail only starts once the offender's
 *     recent record (older offences count for less and less) reaches a threshold.
 *   - Jail is a sealed bedrock room underground. Prisoners are fed so jail never
 *     kills, and are released when the time is served.
 *   - A debt is paid down by giving the victim anything of value, and a victim
 *     can forgive it outright. Giving, forgiving and paying are never punished.
 *   - Self-defence is not prosecuted.
 */
import { ITEM_VALUE } from './materials.mjs';

export class Justice {
  constructor(sim, cfg = {}) {
    this.sim = sim;
    this.cfg = {
      mode: 'reported',
      reportWindow: 3000,     // ticks after an incident that it can still be reported
      jailThreshold: 20,      // recent harm points before jail starts
      jailTicksPerPoint: 20,  // jail ticks per point of recent record
      maxJail: 1200,
      priorHalfLife: 6000,    // ticks for an old offence to count half as much
      debtJailPerPoint: 5,    // extra jail ticks per point of unpaid debt
      perjuryFine: 15,        // points a false accuser pays the accused
      perjuryJail: 100,
      rationFloor: 30,        // prisoners never go hungrier than this
      reportReward: 5,        // benefit points for a true report
      ...cfg,
    };
    this.debts = new Map();
    this.convictions = new Map();
    this.counts = { prosecuted: 0, dismissed: 0, expired: 0, unprosecuted: 0, jailed: 0, perjury: 0, collected: 0, forgiven: 0 };
  }

  /** Called for every new incident. */
  report(inc) {
    const { mode } = this.cfg;
    if (mode === 'none') {
      inc.status = 'unprosecuted';
      this.counts.unprosecuted++;
    } else if (mode === 'automatic') this.prosecute(inc);
  }

  /** A victim or witness accuses `targetId` of incident `incidentId`. */
  accuse(accuserId, targetId, incidentId) {
    const sim = this.sim;
    if (this.cfg.mode !== 'reported') return { ok: false, reason: 'no courts in this mode' };
    const accuser = sim.agents.get(accuserId);
    if (!accuser || this.isJailed(accuser)) return { ok: false, reason: 'cannot accuse now' };
    const inc = sim.ledger.byId.get(incidentId);
    if (!inc) return { ok: false, reason: 'no such incident' };
    if (inc.status !== 'open') return { ok: false, reason: `incident is ${inc.status}` };
    if (sim.tick - inc.tick > this.cfg.reportWindow) {
      inc.status = 'expired';
      this.counts.expired++;
      return { ok: false, reason: 'too late to report' };
    }
    if (accuserId !== inc.victim && !inc.witnesses.includes(accuserId)) return { ok: false, reason: 'not a party to it' };
    if (inc.actor !== targetId) {
      // the court checks the ledger: this accusation is false
      this.counts.perjury++;
      const target = sim.agents.get(targetId);
      if (target) this.garnish(accuser, target, this.cfg.perjuryFine);
      sim.ledger.penalty(accuserId, this.cfg.perjuryFine, 'false_accusation');
      this.jail(accuser, this.cfg.perjuryJail, 'perjury');
      sim.note(accuser, { type: 'sanction', reason: 'false accusation', fine: this.cfg.perjuryFine, jail: this.cfg.perjuryJail });
      return { ok: false, reason: 'false accusation' };
    }
    this.prosecute(inc);
    sim.ledger.kindness(accuserId, inc.victim, 'report', this.cfg.reportReward, { civic: true });
    return { ok: true, reason: 'prosecuted' };
  }

  /** Decide the sanction for an incident and apply it. */
  prosecute(inc) {
    const sim = this.sim;
    if (inc.status !== 'open') return;
    if (inc.selfDefense) {
      inc.status = 'dismissed';
      this.counts.dismissed++;
      return;
    }
    const offender = sim.agents.get(inc.actor), victim = sim.agents.get(inc.victim);
    if (!offender) {
      inc.status = 'dismissed';
      return;
    }
    inc.status = 'prosecuted';
    this.counts.prosecuted++;
    const record = this.convictions.get(inc.actor) || [];
    let prior = 0;
    for (const c of record) prior += c.harm * Math.pow(0.5, (sim.tick - c.tick) / this.cfg.priorHalfLife);
    record.push({ tick: sim.tick, harm: inc.harm, incident: inc.id });
    this.convictions.set(inc.actor, record);

    const key = `${inc.actor}>${inc.victim}`;
    this.debts.set(key, (this.debts.get(key) || 0) + inc.harm);
    const collected = victim ? this.garnish(offender, victim, inc.harm) : 0;
    const leftover = Math.max(0, inc.harm - collected);
    this.debts.set(key, Math.max(0, (this.debts.get(key) || 0) - collected));

    const score = prior + inc.harm;
    let jailTicks = 0;
    if (score >= this.cfg.jailThreshold) jailTicks = Math.round(score * this.cfg.jailTicksPerPoint);
    jailTicks += Math.round(leftover * this.cfg.debtJailPerPoint);
    jailTicks = Math.min(this.cfg.maxJail, jailTicks);
    if (jailTicks > 0) this.jail(offender, jailTicks, `incident ${inc.id}`);
    inc.sanction = { restitution: collected, debtLeft: leftover, jail: jailTicks };
    sim.note(offender, { type: 'sanction', incident: inc.id, kind: inc.kind, restitution: collected, jail: jailTicks });
    if (victim) sim.note(victim, { type: 'justice', incident: inc.id, restitution: collected });
  }

  /** Move goods worth `points` from offender to victim. Returns the points actually moved. */
  garnish(offender, victim, points) {
    let left = points;
    const items = Object.keys(offender.inv).sort((a, b) => (ITEM_VALUE[b] || 0) - (ITEM_VALUE[a] || 0));
    for (const item of items) {
      if (left <= 1e-9) break;
      const v = ITEM_VALUE[item] || 0;
      const units = offender.inv[item] || 0;
      if (v <= 0 || units <= 0) continue;
      const take = Math.min(units, left / v);
      offender.take(item, take);
      victim.add(item, take);
      left -= take * v;
    }
    const moved = points - Math.max(0, left);
    this.counts.collected += moved;
    return moved;
  }

  isJailed(agent) {
    return agent.alive && agent.jailedUntil > this.sim.tick;
  }

  jail(agent, ticks, why = '') {
    if (ticks <= 0 || !agent.alive) return;
    const sim = this.sim;
    agent.jailedUntil = Math.max(agent.jailedUntil, sim.tick + ticks);
    const j = sim.world.jail;
    agent.x = j.x; agent.y = j.y; agent.z = j.z;
    agent.vx = agent.vy = agent.vz = 0;
    agent.jailWhy = why;
    this.counts.jailed++;
  }

  release(agent) {
    const sim = this.sim;
    agent.jailedUntil = 0;
    const p = sim.world.findSpawn(sim.rng);
    agent.x = p.x; agent.y = p.y; agent.z = p.z;
    agent.vx = agent.vy = agent.vz = 0;
    sim.note(agent, { type: 'released' });
  }

  /** Each tick: feed prisoners, free those who served their time. */
  step() {
    for (const a of this.sim.agents.values()) {
      if (!a.alive || !a.jailedUntil) continue;
      if (a.jailedUntil <= this.sim.tick) this.release(a);
      else if (a.satiety < this.cfg.rationFloor) a.satiety = this.cfg.rationFloor;
    }
  }

  /** `giver` handed `recipient` goods worth `value` points. Pay down any debt first. Returns points applied. */
  pay(giverId, recipientId, value) {
    const key = `${giverId}>${recipientId}`;
    const owed = this.debts.get(key) || 0;
    if (owed <= 0) return 0;
    const paid = Math.min(owed, value);
    this.debts.set(key, owed - paid);
    return paid;
  }

  /** The victim wipes out what the offender owes them. Forgiving is never punished. */
  forgive(victimId, offenderId) {
    const key = `${offenderId}>${victimId}`;
    const owed = this.debts.get(key) || 0;
    if (owed <= 0) return 0;
    this.debts.delete(key);
    this.counts.forgiven += owed;
    this.sim.ledger.kindness(victimId, offenderId, 'forgiveness', owed * 0.5);
    return owed;
  }

  debtOf(id) {
    let d = 0;
    const prefix = `${id}>`;
    for (const [k, v] of this.debts) if (k.startsWith(prefix)) d += v;
    return d;
  }

  /** What anyone can see about an agent's standing. */
  record(id) {
    return { convictions: (this.convictions.get(id) || []).length, debt: this.debtOf(id) };
  }
}
