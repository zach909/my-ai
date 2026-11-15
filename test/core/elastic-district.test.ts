/**
 * Elastic districts: islands of neurons that learn because the input is about
 * their subject.
 *
 * The core and the neuron already stretch (the zero-sum value budget, and
 * growNetwork). These tests are about the third scale: defining an island,
 * deciding what it is, opening it when its subject is asked and closing every
 * other one, and letting it stiffen, stretch and grow.
 *
 * They run against a fake host so what is under test is the district logic,
 * not the 1000-neuron mesh.
 */
import { describe, it, expect } from 'vitest';
import {
  ElasticDistricts,
  DEFAULT_DISTRICT_CONFIG,
  type DistrictHost,
} from '../../models && skills/core/elastic-district';
import { NeuroPipeline } from '../../models && skills/core/pipeline';
import { embedText } from '../../models && skills/core/neuro-lang';

class FakeHost implements DistrictHost {
  groups = new Map<number, Set<string>>();
  tuned: number[] = [];
  constructor(public count: number) {}
  getNeuronCount() { return this.count; }
  neuronGroupsOf(id: number) { return Array.from(this.groups.get(id) ?? []); }
  setNeuronGroup(id: number, g: string) {
    if (id < 0 || id >= this.count) return false;
    (this.groups.get(id) ?? this.groups.set(id, new Set()).get(id)!).add(g);
    return true;
  }
  clearNeuronGroup(id: number, g: string) {
    const s = this.groups.get(id);
    if (!s || !s.delete(g)) return false;
    if (s.size === 0) this.groups.delete(id);
    return true;
  }
  addNeurons(n: number) { const ids: number[] = []; for (let i = 0; i < n; i++) ids.push(this.count++); return ids; }
  tuneNeuronTo(id: number) { this.tuned.push(id); return true; }
  getDimensions() { return 16; }
}

/** Every neuron 0..n-1 at the same starting rate. */
const rates = (n: number, rate = 0.004) => new Map(Array.from({ length: n }, (_, i) => [i, rate] as [number, number]));

const CODING = 'coding programming write code python debug program';
const WEATHER = 'weather forecast rain storm temperature wind';

/** Neurons 0-2 are coding, 3-5 are weather, 6-7 belong to no district. */
function world() {
  const host = new FakeHost(8);
  const d = new ElasticDistricts(host);
  d.define('coding', [0, 1, 2], { regionId: 'coding', text: CODING });
  d.define('weather', [3, 4, 5], { regionId: 'weather', text: WEATHER });
  return { host, d };
}

describe('a district opens when its subject is asked and the rest close', () => {
  it('speeds up the asked district, slows the others, and leaves the core alone', () => {
    const { d } = world();
    const plan = d.shape('write python code', rates(8), new Map([['coding', 0.4]]));
    for (const n of [0, 1, 2]) expect(plan.rates.get(n)!).toBeGreaterThan(0.004);
    for (const n of [3, 4, 5]) expect(plan.rates.get(n)!).toBeCloseTo(0.004 * DEFAULT_DISTRICT_CONFIG.closedGain, 6);
    for (const n of [6, 7]) expect(plan.rates.get(n)).toBe(0.004);
    expect(plan.open.map((o) => o.id)).toEqual(['coding']);
    expect(plan.boosted).toBe(3);
    expect(plan.closed).toBe(3);
  });

  it('learns nothing different when the router asked for nothing', () => {
    // The router runs the mesh ungated when an input is about nothing it
    // knows, because a wrong gate costs more than none. Learning follows.
    const { d } = world();
    const input = rates(8);
    const plan = d.shape('zzz qqq', input, new Map());
    expect(Array.from(plan.rates)).toEqual(Array.from(input));
    expect(plan.open).toEqual([]);
    expect(plan.boosted).toBe(0);
  });

  it('opens in proportion to the router\'s score, the best one fully', () => {
    const { d } = world();
    const plan = d.shape('write python code to read the weather', rates(8), new Map([['coding', 0.4], ['weather', 0.2]]));
    const open = Object.fromEntries(plan.open.map((o) => [o.id, o.openness]));
    expect(open.coding).toBe(1);
    expect(open.weather).toBeCloseTo(0.5, 6);
    // Both asked, so neither is closed, and the better match learns faster.
    expect(plan.rates.get(0)!).toBeGreaterThan(plan.rates.get(3)!);
    expect(plan.rates.get(3)!).toBeGreaterThan(0.004);
  });

  it('never raises a rate past the value budget\'s own maximum', () => {
    const { d } = world();
    const plan = d.shape('write python code', rates(8, 0.009), new Map([['coding', 0.4]]));
    for (const n of [0, 1, 2]) expect(plan.rates.get(n)!).toBeLessThanOrEqual(0.01 + 1e-12);
    // A rate that was already above the cap is not pulled down by being asked.
    const high = d.shape('write python code', rates(8, 0.02), new Map([['coding', 0.4]]));
    expect(high.rates.get(0)!).toBe(0.02);
  });

  it('does not change the rates it was given', () => {
    const { d } = world();
    const input = rates(8);
    d.shape('write python code', input, new Map([['coding', 0.4]]));
    expect(input.get(0)).toBe(0.004);
  });

  it('takes the most open district for a neuron that is in two', () => {
    const host = new FakeHost(4);
    const d = new ElasticDistricts(host);
    d.define('coding', [0, 1], { regionId: 'coding', text: CODING });
    d.define('weather', [1, 2], { regionId: 'weather', text: WEATHER });
    const plan = d.shape('python', rates(4), new Map([['coding', 0.4]]));
    expect(plan.rates.get(1)!).toBeGreaterThan(0.004);
    expect(plan.rates.get(2)!).toBeCloseTo(0.0004, 6);
  });

  it('follows the router: a region it did not ask for stays closed even if its words match', () => {
    // The router may have switched the region off after it kept being wrong,
    // or cut it at top-k. A district must not override that.
    const { d } = world();
    const plan = d.shape('write python code', rates(8), new Map([['weather', 0.2]]));
    expect(plan.open.map((o) => o.id)).toEqual(['weather']);
    expect(plan.rates.get(0)!).toBeCloseTo(0.0004, 6);
  });
});

describe('a district stretches, settles and grows', () => {
  /** Every neuron moves by 1, except the given district's, which moves by `x`. */
  const deltas = (members: number[], x: number, n = 8) =>
    new Map(Array.from({ length: n }, (_, i) => [i, members.includes(i) ? x : 1] as [number, number]));
  const ask = (d: ElasticDistricts, n = 8) => d.shape('p', rates(n), new Map([['coding', 0.4]]));
  const CODE = [0, 1, 2];

  /** Learning that is winding down: its movement falls 10% a tick. */
  const learnAndSettle = (d: ElasticDistricts, ticks = 40) => {
    let x = 1;
    for (let i = 0; i < ticks; i++) { ask(d); d.observe(deltas(CODE, x)); x *= 0.9; }
  };

  it('stiffens when what it learns has settled, so the same ask moves it less', () => {
    const { d } = world();
    const before = ask(d).rates.get(0)!;
    learnAndSettle(d);
    const settled = d.get('coding')!;
    expect(settled.elasticity).toBeLessThan(0.5);
    expect(settled.elasticity).toBeGreaterThanOrEqual(DEFAULT_DISTRICT_CONFIG.minElasticity);
    const after = ask(d).rates.get(0)!;
    expect(after).toBeLessThan(before);
    // Still faster than it would be if it had not been asked at all.
    expect(after).toBeGreaterThan(0.004);
  });

  it('is neither settled nor surprised when it is simply busy at a steady level', () => {
    // The first version judged a district against the whole network. The
    // neurons outside an asked district are held and barely move, and the
    // asked ones are driven, so an asked district always looked "restless":
    // on one repeated sentence it grew a neuron every few ticks. A steady
    // level is the district's own normal.
    const { d, host } = world();
    for (let i = 0; i < 200; i++) { ask(d); expect(d.observe(deltas(CODE, 5))).toEqual([]); }
    expect(d.get('coding')!.elasticity).toBe(1);
    expect(d.get('coding')!.grown).toBe(0);
    expect(host.count).toBe(8);
  });

  it('is not surprised by a network where everything else is held still', () => {
    const { d, host } = world();
    const held = (x: number) => new Map(Array.from({ length: 8 }, (_, i) => [i, i < 3 ? x : 0.0001] as [number, number]));
    for (let i = 0; i < 100; i++) { ask(d); d.observe(held(3)); }
    expect(d.get('coding')!.grown).toBe(0);
    expect(host.count).toBe(8);
  });

  it('stretches back when something it thought it knew surprises it', () => {
    const { d } = world();
    learnAndSettle(d);
    const settled = d.get('coding')!.elasticity;
    for (let i = 0; i < 6; i++) { ask(d); d.observe(deltas(CODE, i % 2 ? 0.05 : 4)); }
    expect(d.get('coding')!.elasticity).toBeGreaterThan(settled);
  });

  it('only judges the districts that were asked', () => {
    const { d } = world();
    ask(d);
    d.observe(deltas([3, 4, 5], 0.01));
    expect(d.get('weather')!.elasticity).toBe(1);
    expect(d.get('weather')!.openTicks).toBe(0);
  });

  it('grows a neuron when it keeps being surprised, and the new neuron belongs to it', () => {
    const { d, host } = world();
    const grown: number[] = [];
    for (let i = 0; i < 24 && grown.length === 0; i++) { ask(d); grown.push(...d.observe(deltas(CODE, i % 2 ? 0.05 : 4))); }
    expect(grown).toEqual([8]);
    expect(host.count).toBe(9);
    expect(d.get('coding')!.members).toEqual([0, 1, 2, 8]);
    expect(host.neuronGroupsOf(8)).toEqual(['coding']);
    expect(host.tuned).toEqual([8]);
    expect(d.get('coding')!.grown).toBe(1);
  });

  it('does not grow for a surprise that comes only now and then', () => {
    const { d, host } = world();
    for (let i = 0; i < 300; i++) { ask(d); d.observe(deltas(CODE, i % 12 === 0 ? 6 : 1)); }
    expect(d.get('coding')!.grown).toBe(0);
    expect(host.count).toBe(8);
  });

  it('does not grow past its own cap or the network\'s', () => {
    const jumpy = (d: ElasticDistricts, host: FakeHost, i: number) => {
      d.shape('p', rates(host.count), new Map([['coding', 0.4]]));
      return d.observe(deltas(CODE, i % 2 ? 0.05 : 4, host.count));
    };
    const host = new FakeHost(8);
    const d = new ElasticDistricts(host, { growAfter: 1, maxMembers: 4, maxMeshNeurons: 99 });
    d.define('coding', CODE, { regionId: 'coding', text: CODING });
    for (let i = 0; i < 60; i++) jumpy(d, host, i);
    expect(d.get('coding')!.members).toHaveLength(4);   // its own cap
    expect(host.count).toBe(9);

    const tight = new FakeHost(8);
    const e = new ElasticDistricts(tight, { growAfter: 1, maxMeshNeurons: 8 });
    e.define('coding', CODE, { regionId: 'coding', text: CODING });
    for (let i = 0; i < 60; i++) jumpy(e, tight, i);
    expect(tight.count).toBe(8);                          // the network's cap
  });

  it('is not moved by a tick where nothing changed at all', () => {
    const { d } = world();
    ask(d);
    expect(d.observe(new Map([[0, 0], [1, 0]]))).toEqual([]);
    expect(d.get('coding')!.elasticity).toBe(1);
  });
});

describe('discovering islands among neurons that belong to nothing', () => {
  const profiles = new Map<number, string>([
    [0, 'write python code'], [1, 'debug the code program'], [2, 'python code function'],
    [3, 'weather forecast tomorrow'], [4, 'weather forecast rain'], [5, 'rain forecast temperature weather'],
    [6, 'chess opening'],
  ]);

  it('gathers neurons that mean alike and leaves a lone one with the core', () => {
    const host = new FakeHost(8);
    const d = new ElasticDistricts(host);
    const made = d.discover(profiles);
    expect(made.map((m) => m.members)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(d.districtOf(6)).toBeUndefined();
    expect(host.neuronGroupsOf(6)).toEqual([]);
  });

  it('finds the same islands whatever order the neurons come in', () => {
    // A neuron that started an island before its real island had a centre
    // used to be stranded there alone.
    const texts = [
      'python code', 'code program debug', 'python program code',
      'rain forecast', 'weather forecast rain storm', 'forecast weather',
    ];
    const islandsOf = (order: number[]) => {
      const byId = new Map(order.map((t, id) => [id, texts[t]] as [number, string]));
      const made = new ElasticDistricts(new FakeHost(8)).discover(byId);
      return made.map((m) => m.members.map((id) => byId.get(id)!).sort()).sort((a, b) => a[0].localeCompare(b[0]));
    };
    const forward = islandsOf([0, 1, 2, 3, 4, 5]);
    expect(forward).toHaveLength(2);
    expect(forward.map((island) => island.length)).toEqual([3, 3]);
    // Every ordering of the same descriptions finds the same two islands.
    for (const order of [[5, 4, 3, 2, 1, 0], [1, 3, 0, 5, 2, 4], [2, 0, 4, 1, 5, 3], [4, 2, 5, 0, 3, 1]]) {
      expect(islandsOf(order)).toEqual(forward);
    }
  });

  it('skips neurons that already belong to a region or a district', () => {
    const host = new FakeHost(8);
    host.setNeuronGroup(0, 'coding');
    const d = new ElasticDistricts(host);
    const made = d.discover(profiles);
    expect(made.flatMap((m) => m.members)).not.toContain(0);
    expect(d.discover(profiles)).toEqual([]);
  });

  it('decides an island is a known subject and joins that region', () => {
    const host = new FakeHost(8);
    const d = new ElasticDistricts(host);
    d.setSubjects([
      { id: 'coding', name: 'coding', meaning: CODING },
      { id: 'weather', name: 'weather', meaning: WEATHER },
    ]);
    const made = d.discover(profiles);
    expect(made.map((m) => [m.source, m.regionId])).toEqual([['region', 'coding'], ['region', 'weather']]);
    // Its neurons now answer to the region's label, so the router asking for
    // "coding" asks them too.
    expect(host.neuronGroupsOf(1)).toEqual(['coding']);
    expect(host.neuronGroupsOf(4)).toEqual(['weather']);
    // And the district opens exactly when the router asks for that region.
    const plan = d.shape('write python code', rates(8), new Map([['coding', 0.4]]));
    expect(plan.rates.get(0)!).toBeGreaterThan(0.004);
    expect(plan.rates.get(4)!).toBeCloseTo(0.0004, 6);
  });

  it('gives an island no region fits a subject of its own, which it scores itself', () => {
    const host = new FakeHost(8);
    const d = new ElasticDistricts(host);
    d.setSubjects([{ id: 'music', name: 'music', meaning: 'music song guitar melody' }]);
    const made = d.discover(profiles);
    expect(made.map((m) => m.source)).toEqual(['own', 'own']);
    expect(made[0].regionId).toBeNull();
    expect(host.neuronGroupsOf(0)).toEqual([made[0].id]);
    // The router knows nothing about it, so it hears the text itself.
    const plan = d.shape('how do I debug python code', rates(8), new Map());
    expect(plan.open.map((o) => o.id)).toEqual([made[0].id]);
    expect(plan.rates.get(0)!).toBeGreaterThan(0.004);
    expect(plan.rates.get(3)!).toBeCloseTo(0.0004, 6);
    // A vector has no words, so an own subject cannot be asked by one.
    const vector = d.shape(new Array(16).fill(0.5), rates(8), new Map());
    expect(vector.open).toEqual([]);
  });

  it('never gates an island that cannot say what it is', () => {
    const host = new FakeHost(4);
    const d = new ElasticDistricts(host);
    d.define('mystery', [0, 1], { text: '' });
    const mystery = d.get('mystery')!;
    d.decide(mystery);
    expect(mystery.source).toBe('unknown');
    const input = rates(4);
    const plan = d.shape('anything', input, new Map([['coding', 0.4]]));
    expect(Array.from(plan.rates)).toEqual(Array.from(input));
  });

  it('keeps a discovered island under the cap on its size', () => {
    const host = new FakeHost(8);
    const d = new ElasticDistricts(host, { maxMembers: 2 });
    const made = d.discover(profiles);
    expect(made.every((m) => m.members.length <= 2)).toBe(true);
  });
});

describe('a district can let a member go', () => {
  const profiles = new Map<number, string>([
    [0, 'python code'], [1, 'code program debug'], [2, 'python program code'], [3, 'qqq zzz'],
  ]);

  it('releases a member that no longer fits, and takes the label back when it gave it', () => {
    const host = new FakeHost(6);
    const d = new ElasticDistricts(host, { minIsland: 2 });
    d.setSubjects([{ id: 'coding', name: 'coding', meaning: CODING }]);
    const [district] = d.discover(new Map([...profiles].filter(([id]) => id < 3)));
    // A fourth neuron is added to the island whose meaning has drifted away.
    district.members.push(3);
    host.setNeuronGroup(3, 'coding');
    const released = d.rebalance(district.id, profiles);
    expect(released).toEqual([3]);
    expect(district.members).toEqual([0, 1, 2]);
    expect(host.neuronGroupsOf(3)).toEqual([]);
    expect(host.neuronGroupsOf(0)).toEqual(['coding']);
  });

  it('never shrinks an island below its minimum', () => {
    const host = new FakeHost(4);
    const d = new ElasticDistricts(host, { minIsland: 3 });
    const district = d.define('coding', [0, 1, 2, 3], { regionId: 'coding', text: CODING }, profiles)!;
    const released = d.rebalance('coding', profiles);
    expect(district.members.length).toBeGreaterThanOrEqual(3);
    expect(released.length).toBeLessThanOrEqual(1);
  });

  it('leaves a named region\'s own label alone when it lets a member go', () => {
    const host = new FakeHost(4);
    for (const n of [0, 1, 2, 3]) host.setNeuronGroup(n, 'coding');
    const d = new ElasticDistricts(host, { minIsland: 2 });
    d.define('coding', [0, 1, 2, 3], { regionId: 'coding', text: CODING }, profiles);
    const released = d.rebalance('coding', profiles);
    expect(released).toEqual([3]);
    expect(host.neuronGroupsOf(3)).toEqual(['coding']);
  });

  it('gives a member that fits less a smaller share of the boost', () => {
    const host = new FakeHost(4);
    const d = new ElasticDistricts(host, { releaseBelow: 0 });
    d.define('coding', [0, 1, 2, 3], { regionId: 'coding', text: CODING }, profiles);
    const plan = d.shape('python', rates(4), new Map([['coding', 0.4]]));
    expect(d.get('coding')!.fit[3]).toBeLessThan(d.get('coding')!.fit[0]);
    expect(plan.rates.get(3)!).toBeLessThan(plan.rates.get(0)!);
    expect(plan.rates.get(3)!).toBeGreaterThan(0.004);
  });
});

describe('districts survive a restart', () => {
  it('round-trips through JSON', () => {
    const { d, host } = world();
    for (let i = 0; i < 10; i++) {
      d.shape('p', rates(8), new Map([['coding', 0.4]]));
      d.observe(new Map(Array.from({ length: 8 }, (_, n) => [n, n < 3 ? 0.1 : 1] as [number, number])));
    }
    const saved = JSON.parse(JSON.stringify(d.toJSON()));
    const again = new ElasticDistricts(host);
    expect(again.load(saved)).toBe(2);
    expect(again.get('coding')!.members).toEqual([0, 1, 2]);
    expect(again.get('coding')!.elasticity).toBeCloseTo(d.get('coding')!.elasticity, 9);
    expect(again.get('coding')!.openTicks).toBe(10);
    expect(again.get('weather')!.regionId).toBe('weather');
  });

  it('drops neurons the network no longer has, and a district left with none', () => {
    const { d } = world();
    const saved = d.toJSON();
    const smaller = new ElasticDistricts(new FakeHost(4));
    expect(smaller.load(saved)).toBe(2);
    expect(smaller.get('coding')!.members).toEqual([0, 1, 2]);
    expect(smaller.get('weather')!.members).toEqual([3]);
    const tiny = new ElasticDistricts(new FakeHost(3));
    expect(tiny.load(saved)).toBe(1);
    expect(tiny.get('weather')).toBeUndefined();
  });

  it('treats a missing or foreign snapshot as nothing saved', () => {
    const d = new ElasticDistricts(new FakeHost(4));
    expect(d.load(null)).toBe(0);
    expect(d.load({ version: 2 } as any)).toBe(0);
    expect(d.load({ version: 1, districts: 'no', nextId: 1 } as any)).toBe(0);
  });
});

describe('in the live pipeline', () => {
  const cfg = { embeddingDim: 64, hiddenDim: 32, meshNodes: 16, hyperDimensions: 16 };
  const vec = (text: string) => Float32Array.from(embedText(text, 64));

  /** Run one input and keep the learning rates the network was handed. */
  async function learnedWith(config: Record<string, unknown>, text: string) {
    const pipeline = new NeuroPipeline(config);
    const engine = pipeline.ensureBrain();
    let handed: Map<number, number> | undefined;
    const process = engine.process.bind(engine);
    (engine as any).process = (input: any, rates: Map<number, number>, ...rest: any[]) => {
      handed = rates;
      return (process as any)(input, rates, ...rest);
    };
    const result = await pipeline.run(vec(text), text);
    return { pipeline, rates: handed!, result, registry: pipeline.getExpertNeuronRegistry() };
  }

  it('hands the network rates shaped by what the router asked for', async () => {
    const on = await learnedWith(cfg, 'camera take a photo');
    const off = await learnedWith({ ...cfg, elasticDistricts: false }, 'camera take a photo');
    const camera = on.registry.get('camera')![0];
    const location = on.registry.get('location')![0];
    expect(on.result.selectedPlugins).toContain('camera');
    expect(on.result.openDistricts).toContain('camera');
    // The asked district learns at least as fast as the budget says, and never past its maximum.
    expect(on.rates.get(camera)!).toBeGreaterThanOrEqual(off.rates.get(camera)!);
    expect(on.rates.get(camera)!).toBeLessThanOrEqual(0.01 + 1e-12);
    // A district nobody asked about learns a tenth as fast.
    expect(on.rates.get(location)!).toBeCloseTo(off.rates.get(location)! * DEFAULT_DISTRICT_CONFIG.closedGain, 9);
    // A neuron in no district is exactly as the budget set it.
    const core = Array.from(off.rates.keys()).find((id) => ![...on.registry.values()].some((ids) => ids.includes(id)))!;
    expect(on.rates.get(core)).toBe(off.rates.get(core));
  });

  it('is off when the config says so', async () => {
    const off = await learnedWith({ ...cfg, elasticDistricts: false }, 'camera take a photo');
    expect(off.pipeline.getDistricts()).toBeNull();
    expect(off.result.openDistricts).toEqual([]);
  });

  it('does not keep growing the network on one repeated sentence', async () => {
    // A district compared with the whole network always looked surprised, so
    // it grew a neuron every few ticks for as long as the same thing was said.
    const { pipeline } = await learnedWith(cfg, 'camera take a photo');
    const before = pipeline.ensureBrain().getNeuronCount();
    for (let i = 0; i < 40; i++) await pipeline.run(vec('camera take a photo'), 'camera take a photo');
    expect(pipeline.ensureBrain().getNeuronCount()).toBe(before);
    expect(pipeline.getDistricts()!.get('camera')!.grown).toBe(0);
  });

  it('gives a grafted skill\'s region a district too', async () => {
    const pipeline = new NeuroPipeline(cfg);
    const engine = pipeline.ensureBrain();
    const [a, b] = engine.addNeurons(2);
    engine.setNeuronGroup(a, 'cooking');
    engine.setNeuronGroup(b, 'cooking');
    pipeline.registerSkillRegion('cooking', 'Cooking', 'cooking recipe kitchen bake');
    expect(pipeline.getDistricts()!.get('cooking')!.members).toEqual([a, b]);
  });
});
