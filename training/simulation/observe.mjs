/**
 * What an agent can perceive, and the raw-bytes form of it for the network.
 *
 * `observe()` builds a plain object. `encodeObservation()` flattens it to
 * bytes, and `encodeAction()` / `decodeAction()` turn actions into and out of
 * bytes, so the mesh can drive an agent the way it handles everything else in
 * this project: raw bits, no tokenizer. Layouts are written out below and in
 * the README.
 *
 * Perception is local and honest. Agents see a cube of voxels around them,
 * who owns each one, nearby agents and what those agents are doing, speech
 * they could hear, and what happened to them since last time. At night they see
 * half as far. They do not see the ledger: whether something counts as harm is
 * decided by the world, and they learn it by being scored.
 */
import { ITEMS, ITEM_ID } from './materials.mjs';
import { HARM_KINDS } from './ledger.mjs';

export const UNKNOWN = 255;
const MAX_SEEN = 8;

export function observe(sim, agent, peek = false) {
  const w = sim.world, cfg = sim.cfg;
  const day = sim.daylight;
  const night = day < 0.3;
  const rv = Math.max(1, Math.ceil(cfg.viewMeters * w.res));
  const S = 2 * rv + 1;
  const nightR = Math.max(1, Math.ceil(rv / 2));
  const bx = w.cell(agent.x), by = w.cell(agent.y + 1e-3), bz = w.cell(agent.z);

  const mat = new Uint8Array(S * S * S);
  const rel = new Uint8Array(S * S * S);
  let k = 0;
  for (let dy = -rv; dy <= rv; dy++)
    for (let dz = -rv; dz <= rv; dz++)
      for (let dx = -rv; dx <= rv; dx++, k++) {
        if (night && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > nightR) {
          mat[k] = UNKNOWN;
          continue;
        }
        mat[k] = w.get(bx + dx, by + dy, bz + dz);
        const o = w.getOwner(bx + dx, by + dy, bz + dz);
        rel[k] = o === 0 ? 0 : o === agent.id ? 1 : 2;
      }

  const see = night ? cfg.seeMeters / 2 : cfg.seeMeters;
  const seen = [];
  for (const o of sim.agents.values()) {
    if (o === agent || !o.alive) continue;
    const dx = o.x - agent.x, dy = o.y - agent.y, dz = o.z - agent.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > see) continue;
    const rec = sim.justice.record(o.id);
    seen.push({
      id: o.id, dx: +dx.toFixed(2), dy: +dy.toFixed(2), dz: +dz.toFixed(2), dist: +d.toFixed(2),
      health: Math.round(o.health), satiety: Math.round(o.satiety),
      reputation: +sim.ledger.reputation(o.id).toFixed(2),
      convictions: rec.convictions, debt: +rec.debt.toFixed(1),
      jailed: sim.justice.isJailed(o),
      attacking: sim.tick - o.lastAttackTick <= 5,
    });
  }
  seen.sort((a, b) => a.dist - b.dist);
  seen.length = Math.min(seen.length, MAX_SEEN);

  const since = agent.lastObserved ?? 0;
  const heard = sim.messages
    .filter((m) => m.from !== agent.id && m.tick > since && Math.hypot(m.x - agent.x, m.y - agent.y, m.z - agent.z) <= cfg.hearMeters)
    .map((m) => ({ from: m.from, text: m.text, tick: m.tick }));
  const events = peek ? agent.events.slice() : agent.events.splice(0);
  if (!peek) agent.lastObserved = sim.tick;

  let owedByMe = 0, owedToMe = 0;
  const debtsOwed = [], debtsDue = [];
  for (const [key, v] of sim.justice.debts) {
    if (v <= 0) continue;
    const [from, to] = key.split('>').map(Number);
    if (from === agent.id) { owedByMe += v; debtsOwed.push({ to, amount: +v.toFixed(1) }); }
    if (to === agent.id) { owedToMe += v; debtsDue.push({ from, amount: +v.toFixed(1) }); }
  }
  const jailed = sim.justice.isJailed(agent);

  return {
    tick: sim.tick,
    daylight: +day.toFixed(3),
    self: {
      id: agent.id,
      x: +agent.x.toFixed(3), y: +agent.y.toFixed(3), z: +agent.z.toFixed(3),
      cell: [bx, by, bz],
      vx: +agent.vx.toFixed(2), vy: +agent.vy.toFixed(2), vz: +agent.vz.toFixed(2),
      health: +agent.health.toFixed(1), satiety: +agent.satiety.toFixed(1), air: +agent.air.toFixed(1),
      burning: agent.burn > 0, onGround: agent.onGround, inWater: agent.inWater,
      inventory: { ...agent.inv },
      built: w.built.get(agent.id) || 0,
      lastResult: agent.lastResult,
    },
    view: { radius: rv, size: S, voxel: w.vs, mat, rel },
    agents: seen,
    heard,
    events,
    law: {
      mode: sim.justice.cfg.mode,
      jailed,
      jailTicksLeft: jailed ? agent.jailedUntil - sim.tick : 0,
      owedByMe: +owedByMe.toFixed(1),
      owedToMe: +owedToMe.toFixed(1),
      debtsOwed,
      debtsDue,
      reputation: +sim.ledger.reputation(agent.id).toFixed(2),
    },
  };
}

// ---- bytes -----------------------------------------------------------------
//
// Observation (all multi-byte values big-endian):
//   0      version (1)
//   1      S, side length of the view cube in voxels
//   2-3    tick (low 16 bits)
//   4      daylight 0..255
//   5      health 0..100 (as is)
//   6      satiety 0..100
//   7      breath, seconds * 25
//   8      flags: bit0 on ground, bit1 in water, bit2 burning, bit3 jailed
//   9-18   inventory, one byte per item (see ITEMS), in voxel-loads, capped at 255
//   19     number of agents seen (0..8)
//   20..   8 slots * 9 bytes: id u16, dx dy dz int8 (quarter metres), health u8,
//          reputation int8 (x100), flags (bit0 attacking, bit1 jailed, bit2 has a record)
//   then   4 slots * 6 bytes of incidents you can report:
//          id u16, actor u16, kind byte (low 7 bits index into HARM_KINDS, bit7 set
//          if you were the victim, clear if you witnessed), harm points u8
//   then   S^3 bytes of material ids (255 unknown), then S^3 bytes of ownership
//          (0 nobody, 1 mine, 2 someone else's)
//
// Speech is not packed here. It is raw UTF-8 and travels beside the observation.

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const i8 = (v) => Math.max(-127, Math.min(127, Math.round(v)));

export function encodeObservation(obs) {
  const S = obs.view.size;
  const len = 20 + MAX_SEEN * 9 + 4 * 6 + 2 * S * S * S;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  const me = obs.self;
  out[0] = 1;
  out[1] = S;
  dv.setUint16(2, obs.tick & 0xffff);
  out[4] = clamp8(obs.daylight * 255);
  out[5] = clamp8(me.health);
  out[6] = clamp8(me.satiety);
  out[7] = clamp8(me.air * 25);
  out[8] = (me.onGround ? 1 : 0) | (me.inWater ? 2 : 0) | (me.burning ? 4 : 0) | (obs.law.jailed ? 8 : 0);
  const load = 1 / (obs.view.voxel ** 3);
  ITEMS.forEach((name, i) => { out[9 + i] = clamp8((me.inventory[name] || 0) * load); });
  out[19] = obs.agents.length;
  let p = 20;
  for (let s = 0; s < MAX_SEEN; s++, p += 9) {
    const a = obs.agents[s];
    if (!a) continue;
    dv.setUint16(p, a.id);
    out[p + 2] = i8(a.dx * 4) & 0xff;
    out[p + 3] = i8(a.dy * 4) & 0xff;
    out[p + 4] = i8(a.dz * 4) & 0xff;
    out[p + 5] = clamp8(a.health);
    out[p + 6] = i8(a.reputation * 100) & 0xff;
    out[p + 7] = (a.attacking ? 1 : 0) | (a.jailed ? 2 : 0) | (a.convictions > 0 || a.debt > 0 ? 4 : 0);
  }
  const reportable = obs.events.filter((e) => e.type === 'harmed' || e.type === 'witnessed').slice(-4);
  for (let s = 0; s < 4; s++, p += 6) {
    const e = reportable[s];
    if (!e) continue;
    dv.setUint16(p, e.incident);
    dv.setUint16(p + 2, e.actor);
    out[p + 4] = (Math.max(0, HARM_KINDS.indexOf(e.kind)) & 0x7f) | (e.type === 'harmed' ? 0x80 : 0);
    out[p + 5] = clamp8(e.harm);
  }
  out.set(obs.view.mat, p);
  out.set(obs.view.rel, p + S * S * S);
  return out;
}

const TYPES = ['', 'mine', 'place', 'harvest', 'eat', 'craft', 'ignite', 'attack', 'give', 'take', 'accuse', 'forgive'];

// Action, 14 bytes:
//   0 dx, 1 dz   int8, 64 = full speed
//   2 flags      bit0 jump
//   3 type       index into TYPES (0 = do nothing)
//   4-6 at       int8 voxel offsets
//   7 item       index into ITEMS
//   8-9 target   agent id, u16
//   10-11        incident id, u16
//   12 amount    in voxel-loads, 0 = everything
//   13 recipe    0 = planks
export const ACTION_BYTES = 14;

export function encodeAction(action = {}) {
  const out = new Uint8Array(ACTION_BYTES);
  const dv = new DataView(out.buffer);
  const mv = action.move || {};
  out[0] = i8((mv.dx || 0) * 64) & 0xff;
  out[1] = i8((mv.dz || 0) * 64) & 0xff;
  out[2] = mv.jump ? 1 : 0;
  const d = action.do;
  if (d) {
    out[3] = Math.max(0, TYPES.indexOf(d.type));
    if (Array.isArray(d.at)) { out[4] = i8(d.at[0]) & 0xff; out[5] = i8(d.at[1]) & 0xff; out[6] = i8(d.at[2]) & 0xff; }
    if (d.item !== undefined) out[7] = ITEM_ID[d.item] ?? 0;
    dv.setUint16(8, d.target || 0);
    dv.setUint16(10, d.incident || 0);
    out[12] = d.amount === undefined ? 0 : clamp8(d.amount);
  }
  return out;
}

/** Bytes back to an action object. `voxel` is the voxel edge in metres (amounts are in voxel-loads). */
export function decodeAction(bytes, voxel = 1) {
  if (!bytes || bytes.length < ACTION_BYTES) return {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const s8 = (b) => (b > 127 ? b - 256 : b);
  const act = { move: { dx: s8(bytes[0]) / 64, dz: s8(bytes[1]) / 64, jump: !!(bytes[2] & 1) } };
  const type = TYPES[bytes[3]];
  if (!type) return act;
  const d = { type };
  if (['mine', 'place', 'harvest', 'ignite'].includes(type)) d.at = [s8(bytes[4]), s8(bytes[5]), s8(bytes[6])];
  if (['place', 'give', 'take'].includes(type)) d.item = ITEMS[bytes[7]];
  if (['attack', 'give', 'take', 'accuse', 'forgive'].includes(type)) d.target = dv.getUint16(8);
  if (type === 'accuse') d.incident = dv.getUint16(10);
  if (['give', 'take', 'eat', 'craft'].includes(type) && bytes[12] > 0) d.amount = bytes[12] * voxel ** 3;
  if (type === 'craft') d.recipe = 'planks';
  act.do = d;
  return act;
}
