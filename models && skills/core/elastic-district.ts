/**
 * Elastic districts: islands of neurons that learn because the input is about
 * their subject.
 *
 * The network already stretches at two scales:
 *
 *   - the CORE: one zero-sum value budget over every neuron (ValueRangeAllocator),
 *     so the whole network learns without forgetting what it has locked in;
 *   - the NEURON: each neuron's own points set its own learning rate, and the
 *     network can grow a neuron when it needs one (growNetwork).
 *
 * Neither knows what anything is FOR. A neuron that holds the agent's coding
 * knowledge learns exactly as fast as one that holds its knowledge of the
 * weather, whatever the input is about, so a day of talk about one thing
 * wears away the other.
 *
 * A district is the third scale, between the two: an island of neurons with a
 * subject. Three things make it elastic:
 *
 *   1. DEFINED. An island is carved out of the neurons, either by naming its
 *      members (a net skill's region is one already) or by discovering it:
 *      neurons that mean similar things, and belong to nothing yet, are
 *      gathered into one.
 *   2. DECIDED. Once it exists, the island works out what it is: its members'
 *      meanings, taken together, are compared with the subjects the router
 *      knows. A good match makes it that subject and its neurons join that
 *      region. No match leaves it with a subject made of its own words, which
 *      it can be asked about but is never mistaken for a known skill. And an
 *      island that cannot tell what it is at all is left alone, because a wrong
 *      subject would gate the wrong neurons.
 *   3. STRETCHED. When the input is about a district's subject, the district
 *      opens and its neurons learn faster; every other district closes and
 *      learns very little, so it keeps what it knows. How far a district can
 *      stretch is its own elasticity: high while it is new or still surprised,
 *      lower as it settles. A district that stays surprised grows a neuron.
 *
 * The decision of which subject an input is about is NOT made here. The net
 * skill router (net-skill-router.ts) already is that small agent, and a
 * second network deciding for the first is what that file was written to get
 * away from. A district hears the router's choice and acts on it; only a
 * district whose subject is not a router region (one it made up from its own
 * members) scores the input itself, with the same embedding and the same
 * floor.
 *
 * What districts do NOT touch: the value fractions that gate each neuron's
 * state, the wiring, and the weights. They scale learning rates and nothing
 * else, so a network with no districts, or with every district unknown, runs
 * exactly as it did.
 */
import { embedText } from "./neuro-lang.js";

/** What a district needs from the network it lives in. The hyperdimensional engine already has all of it. */
export interface DistrictHost {
  getNeuronCount(): number;
  neuronGroupsOf(id: number): string[];
  setNeuronGroup(id: number, group: string): boolean;
  clearNeuronGroup(id: number, group: string): boolean;
  /**
   * Grow the network. The caller decides what else growing means (enrolling
   * the neuron in the value budget, say); the district only asks for ids.
   */
  addNeurons(count: number): number[];
  /** Optional: put a grown neuron where its subject points. */
  tuneNeuronTo?(id: number, from: number, toward: ArrayLike<number>): boolean;
  getDimensions?(): number;
}

/** A subject the router knows: a skill region, by name and by what it is for. */
export interface DistrictSubject {
  id: string;
  name: string;
  meaning: string;
}

/**
 * region:  the island IS that router region, or joined it after deciding.
 * own:     no region fits; the subject is the members' own words.
 * unknown: it could not tell, so it is never gated.
 */
export type DistrictSubjectSource = "region" | "own" | "unknown";

export interface District {
  id: string;
  subject: string;
  source: DistrictSubjectSource;
  /** The router region this district opens with, when its subject is one. */
  regionId: string | null;
  /** Member neuron ids, ascending. */
  members: number[];
  /** How far this district can stretch, from `minElasticity` (settled) to 1 (new or surprised). */
  elasticity: number;
  /** How well each member fits the subject, 0..1. A member with no profile fits fully. */
  fit: Record<number, number>;
  /** Ticks this district has been asked on. */
  openTicks: number;
  /** How much recurring surprise it holds: +1 per surprise, 90% kept per quiet tick. */
  restless: number;
  /** How many neurons it has grown. */
  grown: number;
  /**
   * True when discovery made this island and gave its neurons their label, so
   * letting them go takes the label back. A district defined over an existing
   * region never touches that region's labels.
   */
  discovered: boolean;
}

export interface DistrictConfig {
  /**
   * Learning-rate multiplier for a district that was not asked. Not zero:
   * a closed district stays connected, and a network that could never touch
   * one part of itself could never correct a wrong decision about it.
   */
  closedGain: number;
  /** Extra multiplier for the district that was asked, at full openness, elasticity and fit. 1 means up to double. */
  openBoost: number;
  /** A boosted rate never exceeds this. Matches the value budget's own maximum. */
  maxRate: number;
  /** The least a district's elasticity can settle to. */
  minElasticity: number;
  /**
   * A district is surprised when its neurons move this many times more than
   * they have been moving lately. Measured against ITS OWN recent level,
   * never the rest of the network: the neurons outside an asked district are
   * held and barely move, and the asked ones are driven, so against the
   * network an asked district always looks surprised, whatever it is doing.
   * (That was the first version, and it grew a neuron every few ticks on one
   * repeated sentence.)
   */
  restlessAbove: number;
  /** A district has settled when its movement has fallen to this fraction of its own peak. */
  settledBelow: number;
  /** How fast an unsettled district stretches back toward 1. */
  stretchRate: number;
  /** How fast a settled district stiffens. */
  settleRate: number;
  /**
   * How much recurring surprise a district takes to grow a neuron. Each
   * surprise adds 1 and every quiet tick keeps 90%, so a district surprised
   * every other tick reaches about 5 and one surprised now and then never
   * does.
   */
  growAfter: number;
  /** A district never holds more neurons than this. Mirrors MAX_NEURONS_PER_SKILL. */
  maxMembers: number;
  /** The network never grows past this many neurons because of a district. Mirrors MAX_MESH_NEURONS. */
  maxMeshNeurons: number;
  /** How many districts are asked at once by their own subject. */
  topK: number;
  /** A discovered island needs this many neurons. */
  minIsland: number;
  /**
   * Cosine at which a neuron's meaning joins an island. This embedding
   * compares shared character runs, not meaning: measured at 1024 dimensions,
   * two descriptions that share a word score 0.1 to 0.3, unrelated ones
   * score up to about 0.07, and related ones with no word in common score
   * about zero. So it sits just above the noise, and discovery gathers
   * neurons whose descriptions share vocabulary, no more.
   */
  gatherAt: number;
  /** A member that fits its subject less than this is let go when the district rebalances. */
  releaseBelow: number;
}

export const DEFAULT_DISTRICT_CONFIG: DistrictConfig = {
  closedGain: 0.1,
  openBoost: 1,
  maxRate: 0.01,
  minElasticity: 0.15,
  restlessAbove: 1.5,
  settledBelow: 0.6,
  stretchRate: 0.2,
  settleRate: 0.05,
  growAfter: 4,
  maxMembers: 256,
  maxMeshNeurons: 1024,
  topK: 2,
  minIsland: 2,
  gatherAt: 0.1,
  releaseBelow: 0.05,
};

/**
 * Below this a subject does not describe the neurons at all. The router's own
 * floor for the same embedding size, and for the same reason: unrelated text
 * scores up to about 0.07 at 1024 dimensions.
 */
const MIN_SCORE = 0.08;
const TEXT_DIMS = 1024;
/** How much of its members' words an own subject keeps. */
const OWN_SUBJECT_CHARS = 400;

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function unit(vec: ArrayLike<number>): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return Array.from(vec, (v) => v * inv);
}

/** What `shape` did, for a person or a test to read. */
export interface DistrictPlan {
  /** The rates to learn with: the input rates, scaled by district. */
  rates: Map<number, number>;
  /** Districts that were asked, best first. */
  open: Array<{ id: string; subject: string; openness: number; elasticity: number }>;
  /** How many neurons learn faster this tick, and how many learn less. */
  boosted: number;
  closed: number;
}

export interface DistrictSnapshot {
  version: 1;
  districts: District[];
  nextId: number;
}

export class ElasticDistricts {
  private readonly districts = new Map<string, District>();
  private subjects: DistrictSubject[] = [];
  private readonly config: DistrictConfig;
  private nextId = 1;
  /** Districts asked on the last shape(), which is whose surprise observe() reads. */
  private lastOpen = new Set<string>();
  private readonly subjectVectors = new Map<string, number[]>();
  /** What each district's neurons have been moving by: its recent level, and the highest it has been. */
  private readonly trace = new Map<string, { level: number; peak: number }>();

  constructor(private readonly host: DistrictHost, config: Partial<DistrictConfig> = {}) {
    this.config = { ...DEFAULT_DISTRICT_CONFIG, ...config };
  }

  // ─── Defining ────────────────────────────────────────────────────────────

  /** Tell the districts which subjects the router knows, so an island can decide it is one of them. */
  setSubjects(subjects: DistrictSubject[]): void {
    this.subjects = subjects.slice();
  }

  /**
   * Make an island out of neurons that are already known to be one thing, such
   * as a net skill's region. Its subject is given, so nothing is decided.
   * Returns null when no listed neuron exists.
   */
  define(
    id: string,
    neuronIds: Iterable<number>,
    subject: { regionId?: string; text: string },
    profiles?: ReadonlyMap<number, string>,
  ): District | null {
    const members = this.validMembers(neuronIds);
    if (members.length === 0) return null;
    const existing = this.districts.get(id);
    if (existing) {
      // Same island again: widen it, keep what it has learned about itself.
      const merged = Array.from(new Set([...existing.members, ...members])).sort((a, b) => a - b);
      existing.members = merged.slice(0, this.config.maxMembers);
      this.refit(existing, profiles);
      return existing;
    }
    const district: District = {
      id,
      subject: subject.text,
      source: "region",
      regionId: subject.regionId ?? null,
      members: members.slice(0, this.config.maxMembers),
      elasticity: 1,
      fit: {},
      openTicks: 0,
      restless: 0,
      grown: 0,
      discovered: false,
    };
    this.districts.set(id, district);
    this.refit(district, profiles);
    return district;
  }

  /**
   * Find islands among neurons that belong to nothing yet, then decide what
   * each one is.
   *
   * `profiles` says what each candidate neuron means, in words (a grafted
   * neuron's definition). Neurons are gathered in id order into the island
   * whose centre they are closest to, if they are close enough, and start a
   * new one if they are not. An island under `minIsland` is not an island: its
   * neurons stay with the core.
   */
  discover(profiles: ReadonlyMap<number, string>): District[] {
    const candidates = Array.from(profiles.keys())
      .filter((id) => this.isFree(id) && (profiles.get(id) ?? "").trim().length > 0)
      .sort((a, b) => a - b);
    const vecs = new Map<number, number[]>();
    for (const id of candidates) vecs.set(id, unit(embedText(profiles.get(id)!, TEXT_DIMS)));
    const islands: Array<{ ids: number[]; sum: number[] }> = [];
    for (const id of candidates) {
      const vec = vecs.get(id)!;
      let best = -1, bestScore = this.config.gatherAt;
      for (let i = 0; i < islands.length; i++) {
        const score = cosine(vec, islands[i].sum);
        if (score >= bestScore) { best = i; bestScore = score; }
      }
      if (best < 0) islands.push({ ids: [id], sum: vec.slice() });
      else {
        islands[best].ids.push(id);
        for (let k = 0; k < TEXT_DIMS; k++) islands[best].sum[k] += vec[k];
      }
    }
    // One pass in id order depends on the order: a neuron that started an
    // island before the island it belongs to had grown a centre is never
    // looked at again. So every neuron is offered every island, judged
    // against the island WITHOUT itself in it (an island of one would
    // otherwise always be the best fit for its only member), and moves when
    // another fits better than its own. Stops when nothing moves.
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (const id of candidates) {
        const vec = vecs.get(id)!;
        const current = islands.findIndex((island) => island.ids.includes(id));
        const fitOf = (i: number): number => {
          const island = islands[i];
          if (i !== current) return cosine(vec, island.sum);
          if (island.ids.length < 2) return 0;
          return cosine(vec, island.sum.map((v, k) => v - vec[k]));
        };
        let target = current, targetScore = fitOf(current);
        for (let i = 0; i < islands.length; i++) {
          if (i === current) continue;
          const score = fitOf(i);
          if (score >= this.config.gatherAt && score > targetScore) { target = i; targetScore = score; }
        }
        if (target === current) continue;
        islands[current].ids.splice(islands[current].ids.indexOf(id), 1);
        for (let k = 0; k < TEXT_DIMS; k++) islands[current].sum[k] -= vec[k];
        islands[target].ids.push(id);
        for (let k = 0; k < TEXT_DIMS; k++) islands[target].sum[k] += vec[k];
        moved = true;
      }
      if (!moved) break;
    }
    for (const island of islands) island.ids.sort((a, b) => a - b);
    const made: District[] = [];
    for (const island of islands) {
      if (island.ids.length < this.config.minIsland) continue;
      const members = island.ids.slice(0, this.config.maxMembers);
      const id = this.freshId();
      const district: District = {
        id, subject: "", source: "unknown", regionId: null,
        members, elasticity: 1, fit: {}, openTicks: 0, restless: 0, grown: 0, discovered: true,
      };
      this.districts.set(id, district);
      this.decide(district, profiles);
      made.push(district);
    }
    return made;
  }

  /**
   * Work out what an island is. Its members' meanings, taken together, against
   * every subject the router knows. A match joins the region (its neurons
   * take the region's label, so the router asking for the region asks them
   * too). No match gives the island a subject of its own words. No words at
   * all leaves it unknown, and an unknown district is never gated.
   */
  decide(district: District, profiles?: ReadonlyMap<number, string>): DistrictSubjectSource {
    const words = district.members
      .map((id) => profiles?.get(id) ?? "")
      .filter((text) => text.trim().length > 0);
    if (words.length === 0) { this.release(district); district.source = "unknown"; return "unknown"; }

    const centre = new Array<number>(TEXT_DIMS).fill(0);
    for (const text of words) {
      const vec = unit(embedText(text, TEXT_DIMS));
      for (let k = 0; k < TEXT_DIMS; k++) centre[k] += vec[k];
    }
    let best: DistrictSubject | null = null, bestScore = MIN_SCORE;
    for (const subject of this.subjects) {
      const score = cosine(centre, embedText(`${subject.name} ${subject.meaning}`, TEXT_DIMS));
      if (score > bestScore) { best = subject; bestScore = score; }
    }

    this.release(district);
    if (best) {
      district.source = "region";
      district.regionId = best.id;
      district.subject = best.meaning;
    } else {
      district.source = "own";
      district.regionId = null;
      district.subject = words.join(" ").slice(0, OWN_SUBJECT_CHARS);
    }
    this.subjectVectors.delete(district.id);
    // The island's neurons take the label their subject answers to, which is
    // what lets "the router asked for coding" reach them.
    if (district.discovered) {
      const label = district.regionId ?? district.id;
      for (const id of district.members) this.host.setNeuronGroup(id, label);
    }
    this.refit(district, profiles);
    return district.source;
  }

  /**
   * Re-judge an island's members against its subject. A member that has come
   * to fit it far worse than the rest is let go back to the core: a district
   * can shrink as well as grow, or it would only ever become the whole
   * network. Never below `minIsland`.
   */
  rebalance(id: string, profiles: ReadonlyMap<number, string>): number[] {
    const district = this.districts.get(id);
    if (!district) return [];
    this.refit(district, profiles);
    const released: number[] = [];
    const label = district.regionId ?? district.id;
    const ranked = district.members.slice().sort((a, b) => (district.fit[a] ?? 1) - (district.fit[b] ?? 1));
    for (const member of ranked) {
      if (district.members.length - released.length <= this.config.minIsland) break;
      if ((district.fit[member] ?? 1) >= this.config.releaseBelow) break;
      released.push(member);
      if (district.discovered) this.host.clearNeuronGroup(member, label);
      delete district.fit[member];
    }
    if (released.length > 0) district.members = district.members.filter((m) => !released.includes(m));
    return released;
  }

  // ─── Learning ────────────────────────────────────────────────────────────

  /**
   * The learning rates for this tick.
   *
   * `asked` is the router's own choice: region id -> score. A district whose
   * subject is a region opens exactly when the router asked for that region.
   * A district with a subject of its own words scores the input itself, and
   * only when the input is text.
   *
   * The asked districts open in proportion to their score against the best
   * one; their neurons' rates rise by up to `openBoost`, scaled by how far
   * the district can still stretch and how well each neuron fits the
   * subject. Every other gated district's neurons are scaled down to
   * `closedGain`. Neurons in no gated district, and every neuron when no
   * district exists or can say what it is, keep the rate they came with. A
   * neuron in several districts takes the most open one.
   */
  shape(
    input: string | ArrayLike<number>,
    rates: ReadonlyMap<number, number>,
    asked: ReadonlyMap<string, number> = new Map(),
  ): DistrictPlan {
    const gated = Array.from(this.districts.values()).filter((d) => d.source !== "unknown");
    const score = new Map<string, number>();
    const own: Array<{ id: string; score: number }> = [];
    for (const d of gated) {
      if (d.regionId !== null) {
        const s = asked.get(d.regionId);
        if (s !== undefined && s >= MIN_SCORE) score.set(d.id, s);
      } else if (typeof input === "string" && input.trim().length > 0) {
        const s = cosine(embedText(input, TEXT_DIMS), this.subjectVector(d));
        if (s >= MIN_SCORE) own.push({ id: d.id, score: s });
      }
    }
    own.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (const o of own.slice(0, Math.max(0, this.config.topK))) score.set(o.id, o.score);

    // Nothing asked is not "everything closed". The router runs the mesh
    // ungated when it is about nothing, because a wrong gate costs more than
    // none; learning follows the same rule.
    if (score.size === 0) {
      this.lastOpen = new Set();
      return { rates: new Map(rates), open: [], boosted: 0, closed: 0 };
    }

    const top = Math.max(0, ...score.values());
    const openness = new Map<string, number>();
    for (const [id, s] of score) openness.set(id, top > 0 ? s / top : 0);

    // Per neuron: the gain of the most open district it belongs to.
    const gain = new Map<number, number>();
    for (const d of gated) {
      const o = openness.get(d.id) ?? 0;
      for (const n of d.members) {
        const g = o === 0
          ? this.config.closedGain
          : 1 + this.config.openBoost * o * d.elasticity * (0.5 + 0.5 * (d.fit[n] ?? 1));
        const had = gain.get(n);
        // Open beats closed; among open, the larger gain stands.
        if (had === undefined || (g > 1 && (had <= 1 || g > had))) gain.set(n, g);
      }
    }

    const out = new Map(rates);
    let boosted = 0, held = 0;
    for (const [n, g] of gain) {
      const rate = rates.get(n);
      if (rate === undefined) continue;
      if (g > 1) { out.set(n, Math.min(Math.max(rate, this.config.maxRate), rate * g)); boosted++; }
      else { out.set(n, rate * g); held++; }
    }

    this.lastOpen = new Set(openness.keys());
    for (const id of this.lastOpen) this.districts.get(id)!.openTicks++;
    const open = Array.from(openness, ([id, o]) => ({
      id, subject: this.districts.get(id)!.subject, openness: o, elasticity: this.districts.get(id)!.elasticity,
    })).sort((a, b) => b.openness - a.openness || a.id.localeCompare(b.id));
    return { rates: out, open, boosted, closed: held };
  }

  /**
   * Feed back how much each neuron just changed (the engine's `stateDeltas`).
   *
   * Only the districts that were asked on the last tick are judged, and each
   * against its own history. One that moved far more than it had been moving
   * is surprised by its own subject: it stretches back toward 1 and, if that
   * keeps happening, grows a neuron. One whose movement has fallen well below
   * its own peak has settled: it stiffens, so what it has learned is harder
   * to knock loose. One that is simply busy at a steady level is neither.
   * Returns the ids of any neurons grown.
   */
  observe(deltas: ReadonlyMap<number, number>): number[] {
    if (deltas.size === 0) return [];
    const grown: number[] = [];
    for (const id of this.lastOpen) {
      const d = this.districts.get(id);
      if (!d) continue;
      let sum = 0, count = 0;
      for (const n of d.members) {
        const v = deltas.get(n);
        if (v === undefined) continue;
        sum += Math.abs(v); count++;
      }
      if (count === 0) continue;
      const now = sum / count;
      const seen = this.trace.get(id);
      if (!seen) { this.trace.set(id, { level: now, peak: now }); continue; }

      const surprised = seen.level > 0 && now / seen.level >= this.config.restlessAbove;
      seen.level = 0.7 * seen.level + 0.3 * now;
      seen.peak = Math.max(seen.level, seen.peak * 0.995);

      if (surprised) {
        d.elasticity = Math.min(1, d.elasticity + this.config.stretchRate * (1 - d.elasticity));
        d.restless += 1;
      } else {
        d.restless *= 0.9;
        if (seen.peak > 0 && seen.level <= this.config.settledBelow * seen.peak) {
          d.elasticity = Math.max(this.config.minElasticity, d.elasticity * (1 - this.config.settleRate));
        }
      }
      if (d.restless >= this.config.growAfter) {
        const newId = this.grow(d);
        if (newId !== null) grown.push(newId);
        d.restless = 0;
        // A new neuron moves a lot at first. Start the district's baseline over.
        this.trace.delete(id);
      }
    }
    return grown;
  }

  /** One more neuron for a district, if the caps allow it. Null when they do not or the network refused. */
  grow(district: District): number | null {
    if (district.source === "unknown") return null;
    if (district.members.length >= this.config.maxMembers) return null;
    if (this.host.getNeuronCount() >= this.config.maxMeshNeurons) return null;
    const [id] = this.host.addNeurons(1);
    if (id === undefined) return null;
    this.host.setNeuronGroup(id, district.regionId ?? district.id);
    if (this.host.tuneNeuronTo && this.host.getDimensions) {
      this.host.tuneNeuronTo(id, 0, embedText(district.subject, this.host.getDimensions()));
    }
    district.members.push(id);
    district.fit[id] = 1;
    district.grown++;
    return id;
  }

  // ─── Reading and saving ──────────────────────────────────────────────────

  get(id: string): District | undefined { return this.districts.get(id); }
  list(): District[] { return Array.from(this.districts.values()); }
  size(): number { return this.districts.size; }

  /** Which district a neuron belongs to, by first definition. */
  districtOf(neuronId: number): District | undefined {
    for (const d of this.districts.values()) if (d.members.includes(neuronId)) return d;
    return undefined;
  }

  toJSON(): DistrictSnapshot {
    return { version: 1, districts: this.list().map((d) => ({ ...d, members: d.members.slice(), fit: { ...d.fit } })), nextId: this.nextId };
  }

  /**
   * Take a saved set back. Members the network no longer has are dropped, and
   * a district left with none is dropped too. Replaces whatever was here.
   */
  load(snapshot: DistrictSnapshot | null | undefined): number {
    this.districts.clear();
    this.subjectVectors.clear();
    this.trace.clear();
    this.lastOpen = new Set();
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.districts)) return 0;
    this.nextId = Math.max(1, Math.floor(snapshot.nextId) || 1);
    for (const raw of snapshot.districts) {
      if (!raw || typeof raw.id !== "string") continue;
      const members = this.validMembers(Array.isArray(raw.members) ? raw.members : []);
      if (members.length === 0) continue;
      const fit: Record<number, number> = {};
      for (const m of members) {
        const f = raw.fit?.[m];
        fit[m] = typeof f === "number" && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 1;
      }
      const source = raw.source === "region" || raw.source === "own" ? raw.source : "unknown";
      this.districts.set(raw.id, {
        id: raw.id,
        subject: typeof raw.subject === "string" ? raw.subject : "",
        source,
        regionId: typeof raw.regionId === "string" ? raw.regionId : null,
        members,
        elasticity: Math.min(1, Math.max(this.config.minElasticity, Number(raw.elasticity) || 1)),
        fit,
        openTicks: Math.max(0, Math.floor(Number(raw.openTicks) || 0)),
        restless: 0,
        grown: Math.max(0, Math.floor(Number(raw.grown) || 0)),
        discovered: raw.discovered === true,
      });
    }
    return this.districts.size;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private freshId(): string {
    let id = `district_${this.nextId++}`;
    while (this.districts.has(id)) id = `district_${this.nextId++}`;
    return id;
  }

  private validMembers(ids: Iterable<number>): number[] {
    const count = this.host.getNeuronCount();
    return Array.from(new Set(Array.from(ids).filter((n) => Number.isInteger(n) && n >= 0 && n < count)))
      .sort((a, b) => a - b);
  }

  /** Free means in no district and under no label: the core. */
  private isFree(id: number): boolean {
    if (this.host.neuronGroupsOf(id).length > 0) return false;
    for (const d of this.districts.values()) if (d.members.includes(id)) return false;
    return true;
  }

  private subjectVector(d: District): number[] {
    let vec = this.subjectVectors.get(d.id);
    if (!vec) { vec = embedText(d.subject, TEXT_DIMS); this.subjectVectors.set(d.id, vec); }
    return vec;
  }

  /** Each member's fit: its meaning against the subject, relative to the best member. */
  private refit(district: District, profiles?: ReadonlyMap<number, string>): void {
    const fit: Record<number, number> = {};
    if (!profiles || district.subject.trim().length === 0) {
      for (const m of district.members) fit[m] = district.fit[m] ?? 1;
      district.fit = fit;
      return;
    }
    const subject = this.subjectVector(district);
    const raw = new Map<number, number>();
    for (const m of district.members) {
      const text = profiles.get(m);
      if (text === undefined || text.trim().length === 0) continue;
      raw.set(m, Math.max(0, cosine(embedText(text, TEXT_DIMS), subject)));
    }
    const best = Math.max(0, ...raw.values());
    for (const m of district.members) {
      const r = raw.get(m);
      fit[m] = r === undefined || !(best > 0) ? 1 : Math.min(1, r / best);
    }
    district.fit = fit;
  }

  /** Take a discovered island's neurons off the label it last gave them. */
  private release(district: District): void {
    if (!district.discovered) return;
    const label = district.regionId ?? district.id;
    for (const id of district.members) this.host.clearNeuronGroup(id, label);
  }
}
