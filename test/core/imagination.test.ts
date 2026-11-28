/**
 * Imagination and reconstructive recall (models && skills/core/imagination.ts).
 *
 * The two ideas, pinned against the real engine:
 *  - recalling a memory rebuilds it from different neurons every time, and each
 *    rebuild lands a little differently, yet stays close to the memory;
 *  - imagining puts together pieces of memories chosen at random, and what it
 *    makes is new, tagged as imagined, and never mistaken for a real memory.
 * And the limits: recalling and imagining leave the mesh as they found it, and
 * an imagination never pushes a real memory out.
 */
import { describe, it, expect } from 'vitest';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain';
import { Imagination } from '../../models && skills/core/imagination';

const mesh = () => new HyperDimensionalEngine({ neuronCount: 48, dimensions: 32 });

const FACTS = [
  'the cat sat on the mat',
  'rain fell on the quiet harbour all night',
  'she learned to ride a bicycle on a gravel road',
  'the soup needed more salt and a squeeze of lemon',
  'we watched the lunar eclipse from the roof',
  'his grandfather repaired clocks in a narrow shop',
];

function loaded(opts: ConstructorParameters<typeof Imagination>[1] = {}, engine = mesh()) {
  const im = new Imagination(engine, { seed: 7, ...opts });
  const ids = FACTS.map((f, i) => im.remember(`fact ${i}`, f));
  return { im, ids, engine };
}

const jaccard = (a: number[], b: number[]) => {
  const sa = new Set(a);
  const both = b.filter(x => sa.has(x)).length;
  return both / (sa.size + b.length - both);
};

describe('recall rebuilds a memory from different neurons each time', () => {
  it('never uses the same neurons twice running, and the sets really differ', () => {
    const { im, ids } = loaded();
    const sets: number[][] = [];
    for (let i = 0; i < 40; i++) sets.push(im.recall(ids[0])!.neurons);
    for (let i = 1; i < sets.length; i++) expect(sets[i].join(',')).not.toBe(sets[i - 1].join(','));
    expect(new Set(sets.map(s => s.join(','))).size).toBe(40);
    const overlaps = sets.slice(1).map((s, i) => jaccard(s, sets[i]));
    const mean = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
    expect(mean).toBeLessThan(0.6); // two random halves of a pool overlap by about a third
  });

  it('each rebuild lands a little differently, yet stays close to the memory', () => {
    const { im, ids } = loaded();
    const rebuilds = Array.from({ length: 20 }, () => im.recall(ids[1])!);
    const distinct = new Set(rebuilds.map(r => Array.from(r.pattern).join(',')));
    expect(distinct.size).toBe(20);
    for (const r of rebuilds) {
      expect(r.error).toBeGreaterThan(0); // never an exact replay
      expect(r.error).toBeLessThan(0.08); // but still recognisably the same memory
    }
  });

  it('is still the right memory: a rebuild is closer to its own memory than to any other', () => {
    const { im, ids } = loaded();
    for (let m = 0; m < ids.length; m++) {
      for (let i = 0; i < 5; i++) {
        const r = im.recall(ids[m])!;
        const best = im.find(Array.from(r.pattern), 1)[0];
        expect(best.id).toBe(ids[m]);
      }
    }
  });

  it('says which neurons carried it, and only those are touched on the mesh', () => {
    const engine = mesh();
    const touched = new Set<number>();
    const set = engine.setNeuronState.bind(engine);
    engine.setNeuronState = (id: number, content: ArrayLike<number>) => { touched.add(id); return set(id, content); };
    const { im, ids } = loaded({}, engine);
    touched.clear();
    const r = im.recall(ids[2])!;
    expect([...touched].sort((a, b) => a - b)).toEqual(r.neurons);
    for (const id of r.neurons) expect(im.neurons()).toContain(id);
    expect(Math.min(...r.neurons)).toBeGreaterThanOrEqual(8); // clear of the Zip Loop doorway
  });

  it('is read off the mesh\'s neurons, not off a copy kept beside it', () => {
    const engine = mesh();
    const { im, ids } = loaded({}, engine);
    const honest = im.recall(ids[3])!;
    expect(honest.error).toBeLessThan(0.08);
    // Make the mesh hand back the opposite of what was driven into it. If the memory really passes through
    // the neurons, the rebuild flips; if it were read from the layer's own copy, nothing would change.
    const read = engine.readNeuronContent.bind(engine);
    const driven = new Set<number>();
    const set = engine.setNeuronState.bind(engine);
    engine.setNeuronState = (id: number, content: ArrayLike<number>) => { driven.add(id); return set(id, content); };
    engine.readNeuronContent = (id: number, out: Float32Array) => {
      const n = read(id, out);
      if (driven.has(id)) for (let i = 0; i < n; i++) out[i] = -out[i];
      return n;
    };
    const flipped = im.recall(ids[3])!;
    expect(flipped.error).toBeGreaterThan(1.8); // cosine near -1
  });

  it('leaves the mesh exactly as it found it', () => {
    const engine = mesh();
    const { im, ids } = loaded({}, engine);
    const before = engine.getNeuronStates().map(n => Array.from(n.state));
    for (let i = 0; i < 10; i++) im.recall(ids[i % ids.length]);
    im.imagine();
    const after = engine.getNeuronStates().map(n => Array.from(n.state));
    expect(after).toEqual(before);
  });

  it('answers null for a memory it does not hold', () => {
    const { im } = loaded();
    expect(im.recall('nope')).toBeNull();
  });
});

describe('imagination puts random memories together', () => {
  it('needs at least two real memories to put together', () => {
    const im = new Imagination(mesh(), { seed: 1 });
    expect(im.imagine()).toBeNull();
    im.remember('one', 'only one thing');
    expect(im.imagine()).toBeNull();
    im.remember('two', 'a second thing');
    expect(im.imagine()).not.toBeNull();
  });

  it('makes something new, from several parents, tagged as imagined', () => {
    const { im } = loaded();
    for (let i = 0; i < 20; i++) {
      const x = im.imagine({ parents: 3 })!;
      expect(x.imagined).toBe(true);
      expect(x.parents).toHaveLength(3);
      expect(new Set(x.parents.map(p => p.id)).size).toBe(3);
      expect(x.parents.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 6);
      expect(x.novelty).toBeGreaterThan(0.05);
      for (const id of x.neurons) expect(im.neurons()).toContain(id);
      for (const v of x.pattern) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it('is random: different draws put different memories together', () => {
    const { im } = loaded();
    const combos = new Set<string>();
    for (let i = 0; i < 30; i++) combos.add(im.imagine({ parents: 2 })!.parents.map(p => p.id).sort().join('+'));
    expect(combos.size).toBeGreaterThan(5); // 15 pairs exist
  });

  it('is repeatable from a seed, and not from a different one', () => {
    const run = (seed: number) => {
      const { im } = loaded({ seed });
      const a = im.recall('m1')!.neurons.join(',');
      const b = Array.from(im.imagine()!.pattern).join(',');
      return a + '|' + b;
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });

  it('keeps nothing unless told to', () => {
    const { im } = loaded();
    const n = im.size();
    for (let i = 0; i < 10; i++) im.imagine();
    expect(im.size()).toBe(n);
  });
});

describe('an imagined thing is never mistaken for something that happened', () => {
  it('a kept imagination stays tagged, lists its parents, and can be recalled as imagined', () => {
    const { im, ids } = loaded();
    const x = im.imagine({ parents: 2 })!;
    const id = im.keep(x, 'a dream')!;
    expect(im.parentsOf(id).sort()).toEqual(x.parents.map(p => p.id).sort());
    for (const p of im.parentsOf(id)) expect(ids).toContain(p);
    const r = im.recall(id)!;
    expect(r.source).toBe('imagined');
    expect(im.find(Array.from(x.pattern), 1)[0]).toMatchObject({ id, source: 'imagined' });
    expect(im.recall(ids[0])!.source).toBe('real');
  });

  it('draws only from real memories by default, so imagination does not feed on itself', () => {
    const { im } = loaded();
    for (let i = 0; i < 4; i++) im.keep(im.imagine()!, `dream ${i}`);
    for (let i = 0; i < 60; i++) {
      for (const p of im.imagine({ parents: 3 })!.parents) expect(p.id.startsWith('i')).toBe(false);
    }
  });

  it('can draw from kept imaginations when asked to', () => {
    const { im } = loaded();
    for (let i = 0; i < 4; i++) im.keep(im.imagine()!, `dream ${i}`);
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) {
      seen = im.imagine({ parents: 3, includeImagined: true })!.parents.some(p => p.id.startsWith('i'));
    }
    expect(seen).toBe(true);
  });
});

describe('it is bounded, and imagination never pushes a real memory out', () => {
  it('holds at most `capacity` memories, dropping imagined ones first', () => {
    const im = new Imagination(mesh(), { seed: 3, capacity: 6 });
    for (let i = 0; i < 4; i++) im.remember(`real ${i}`, FACTS[i]);
    for (let i = 0; i < 6; i++) im.keep(im.imagine()!, `dream ${i}`);
    expect(im.size()).toBe(6);
    expect(im.find('the cat sat on the mat', 10).filter(h => h.source === 'real')).toHaveLength(4);
    // A new real memory pushes an imagined one out, not a real one.
    im.remember('real 4', FACTS[4]);
    expect(im.size()).toBe(6);
    expect(im.find('the cat sat on the mat', 10).filter(h => h.source === 'real')).toHaveLength(5);
  });

  it('keeps nothing when the store is full of real memories', () => {
    const im = new Imagination(mesh(), { seed: 3, capacity: 4 });
    for (let i = 0; i < 4; i++) im.remember(`real ${i}`, FACTS[i]);
    expect(im.keep(im.imagine()!, 'dream')).toBeNull();
    expect(im.size()).toBe(4);
  });
});

describe('finding a memory from a cue', () => {
  it('finds a memory by words from it', () => {
    const { im } = loaded();
    expect(im.find('a cat on a mat')[0].label).toBe('fact 0');
    expect(im.find('lunar eclipse from the roof')[0].label).toBe('fact 4');
  });
});

describe('setup', () => {
  it('refuses a mesh with too few neurons to spread a memory over', () => {
    expect(() => new Imagination(new HyperDimensionalEngine({ neuronCount: 10, dimensions: 8 }))).toThrow(/at least 4/);
    expect(() => new Imagination(mesh(), { neurons: [9, 10] })).toThrow(/at least 4/);
  });

  it('works on the live-sized mesh too', () => {
    const live = new HyperDimensionalEngine({
      dimensions: 64, ballStates: 8, neuronCount: 64, learningRate: 0.05,
      hyperGain: 1, hyperAdd: 1, hyperWaveGain: 1, hyperWaveAdd: 1, waveGain: 0.1, connectionBias: true, propagationSteps: 32,
    } as never);
    const { im, ids } = loaded({}, live);
    expect(im.neurons()).toHaveLength(56);
    const a = im.recall(ids[0])!;
    const b = im.recall(ids[0])!;
    expect(a.neurons.join(',')).not.toBe(b.neurons.join(','));
    expect(a.error).toBeLessThan(0.08);
    expect(im.imagine()!.novelty).toBeGreaterThan(0.05);
  }, 60_000);
});
