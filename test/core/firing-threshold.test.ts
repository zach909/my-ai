/**
 * Firing thresholds on the hyperdimensional engine.
 *
 * Each neuron has its own threshold and one dial scales them all: off, power
 * saving ('saver'), or anywhere between. These tests pin the properties that
 * matter: off really is the old engine, the dial really is a dial, neurons that
 * are being driven or held are never silenced, a silent neuron respects vale,
 * and a saved network keeps its thresholds without breaking anything saved
 * before thresholds existed.
 */

import { describe, it, expect } from 'vitest';
import {
  HyperDimensionalEngine,
  DEFAULT_FIRING_THRESHOLD,
  FIRING_MODE_SCALE,
  firingModeName,
  resolveFiringScale,
  type NetworkStateSnapshot,
} from '../../models && skills/core/onebrain.js';

const N = 24;
const DIMS = 12;

/** The live pipeline's equation settings, small enough to run in a test. */
const live = (extra: Record<string, unknown> = {}) => ({
  neuronCount: N, dimensions: DIMS, seed: 7, propagationSteps: 8,
  hyperGain: 1, hyperAdd: 1, hyperWaveGain: 1, hyperWaveAdd: 1, waveGain: 0.1, connectionBias: true,
  ...extra,
});

/** Varied, repeatable inputs. */
function inputs(count: number): number[][] {
  let a = 424242;
  const out: number[][] = [];
  for (let t = 0; t < count; t++) {
    const v: number[] = [];
    for (let d = 0; d < DIMS; d++) { a = (Math.imul(a, 1103515245) + 12345) >>> 0; v.push(((a >>> 16) & 1023) / 511.5 - 1); }
    out.push(v);
  }
  return out;
}

/** Every neuron's settled state, read out of a snapshot: result[neuron][dimension], dimension 0 is the input flag. */
function statesOf(snapshot: NetworkStateSnapshot): number[][] {
  const bytes = Buffer.from(snapshot.states, 'base64');
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const D = DIMS + 1;
  return Array.from({ length: N }, (_, i) => Array.from({ length: D }, (_, d) => f[d * N + i]));
}

const contentIsZero = (s: number[]) => s.slice(1).every(v => v === 0);

function meanSilent(engine: HyperDimensionalEngine, ticks = 8): number {
  let sum = 0;
  for (const input of inputs(ticks)) {
    engine.process(input, undefined, new Set([0]));
    sum += engine.getFiringStats().silentFraction;
  }
  return sum / ticks;
}

describe('the dial', () => {
  it('maps the named modes to scales, and anything else to the fallback', () => {
    expect(FIRING_MODE_SCALE).toEqual({ off: 0, balanced: 0.5, saver: 0.7 });
    expect(resolveFiringScale('saver')).toBe(0.7);
    expect(resolveFiringScale(' Balanced ')).toBe(0.5);
    expect(resolveFiringScale('0.3')).toBe(0.3);
    expect(resolveFiringScale(0.7)).toBe(0.7);
    // Out of range is clamped, not trusted.
    expect(resolveFiringScale(5)).toBe(1);
    expect(resolveFiringScale(-2)).toBe(0);
    // A setting that means nothing never turns thresholds on.
    expect(resolveFiringScale('turbo')).toBe(0);
    expect(resolveFiringScale(undefined)).toBe(0);
    expect(resolveFiringScale(NaN)).toBe(0);
    expect(resolveFiringScale('', 0.4)).toBe(0.4);
    // An environment variable is free text: names every object inherits are not modes.
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(resolveFiringScale(word)).toBe(0);
      expect(resolveFiringScale(word, 0.4)).toBe(0.4);
    }
    expect(new HyperDimensionalEngine(live({ firingMode: 'constructor' })).getFiringMode()).toEqual({ mode: 'off', scale: 0 });
    expect(new HyperDimensionalEngine(live()).setFiringMode('constructor' as never)).toBe(false);
    expect(firingModeName(0)).toBe('off');
    expect(firingModeName(0.5)).toBe('balanced');
    expect(firingModeName(0.7)).toBe('saver');
    // Full scale is reachable by number, but it is not a named mode.
    expect(firingModeName(1)).toBe('custom');
    expect(firingModeName(0.25)).toBe('custom');
  });

  it('is off unless asked for', () => {
    expect(new HyperDimensionalEngine(live()).getFiringMode()).toEqual({ mode: 'off', scale: 0 });
    expect(new HyperDimensionalEngine(live({ firingMode: 'saver' })).getFiringMode()).toEqual({ mode: 'saver', scale: 0.7 });
    expect(new HyperDimensionalEngine(live({ firingScale: 0.25 })).getFiringMode()).toEqual({ mode: 'custom', scale: 0.25 });
    // A typo in config must not quietly switch the network's behaviour.
    expect(new HyperDimensionalEngine(live({ firingMode: 'sevr' })).getFiringMode().scale).toBe(0);
  });

  it('can be changed on a running engine, and refuses a setting it does not understand', () => {
    const engine = new HyperDimensionalEngine(live());
    expect(engine.setFiringMode('balanced')).toBe(true);
    expect(engine.getFiringMode()).toEqual({ mode: 'balanced', scale: 0.5 });
    expect(engine.setFiringMode('turbo' as never)).toBe(false);
    expect(engine.setFiringMode(NaN)).toBe(false);
    expect(engine.getFiringMode()).toEqual({ mode: 'balanced', scale: 0.5 });
    expect(engine.setFiringReference('absolute')).toBe(true);
    expect(engine.setFiringReference('rank')).toBe(true);
    expect(engine.setFiringReference('median' as never)).toBe(false);
    expect(engine.setFiringReference('range' as never)).toBe(false);
  });
});

describe('off is the old engine', () => {
  it('computes exactly what an engine that never heard of thresholds computes', () => {
    const plain = new HyperDimensionalEngine(live());
    const off = new HyperDimensionalEngine(live({ firingMode: 'off', firingThreshold: 3, firingReference: 'absolute' }));
    for (const input of inputs(6)) {
      plain.process(input, undefined, new Set([0]));
      off.process(input, undefined, new Set([0]));
    }
    const a = plain.captureNetworkState();
    const b = off.captureNetworkState();
    // Every learned array and the settled states, byte for byte. (The
    // threshold itself differs on purpose here, and is not part of the
    // network a plain engine has.)
    for (const key of ['states', 'energies', 'bias', 'connDiag', 'connShift', 'modWeight', 'addWeight', 'waveFreq', 'wavePhase'] as const) {
      expect(b[key]).toBe(a[key]);
    }
  });

  it('turning it on and back off leaves the engine computing the old thing again', () => {
    const plain = new HyperDimensionalEngine(live());
    const toggled = new HyperDimensionalEngine(live());
    toggled.setFiringMode('saver');
    toggled.setFiringMode('off');
    for (const input of inputs(4)) {
      plain.process(input, undefined, new Set([0]));
      toggled.process(input, undefined, new Set([0]));
    }
    expect(toggled.captureNetworkState().states).toBe(plain.captureNetworkState().states);
  });

  it('does no gating work at all: nothing is counted as eligible', () => {
    const engine = new HyperDimensionalEngine(live());
    engine.process(inputs(1)[0], undefined, new Set([0]));
    expect(engine.getFiringStats()).toMatchObject({ mode: 'off', scale: 0, eligible: 0, silent: 0, silentFraction: 0 });
  });
});

describe('turning the dial up silences more neurons', () => {
  it('silences none at off, about half at balanced, about 70% at saver', () => {
    const off = meanSilent(new HyperDimensionalEngine(live()));
    const balanced = meanSilent(new HyperDimensionalEngine(live({ firingMode: 'balanced' })));
    const saver = meanSilent(new HyperDimensionalEngine(live({ firingMode: 'saver' })));
    expect(off).toBe(0);
    // 23 neurons can be gated (one is driven): floor(0.5 * 23) = 11 and floor(0.7 * 23) = 16.
    expect(balanced).toBeCloseTo(11 / 23, 6);
    expect(saver).toBeCloseTo(16 / 23, 6);
  });

  it('moves smoothly between the named modes', () => {
    const scales = [0, 0.25, 0.5, 0.75, 1];
    const silent = scales.map(scale => meanSilent(new HyperDimensionalEngine(live({ firingScale: scale }))));
    for (let i = 1; i < silent.length; i++) expect(silent[i]).toBeGreaterThanOrEqual(silent[i - 1]);
    expect(silent[0]).toBe(0);
    expect(silent[silent.length - 1]).toBeGreaterThan(silent[2]);
  });

  it('is exactly the fraction silenced: scale * eligible neurons stay quiet, the loudest never does', () => {
    for (const scale of [0.25, 0.5, 0.75]) {
      const engine = new HyperDimensionalEngine(live({ firingScale: scale }));
      for (const input of inputs(5)) {
        engine.process(input, undefined, new Set([0]));
        const { eligible, silent } = engine.getFiringStats();
        expect(eligible).toBe(N - 1);
        expect(silent).toBe(Math.floor(scale * eligible));
      }
    }
    // Full scale ("one person talking") leaves only the loudest.
    const full = new HyperDimensionalEngine(live({ firingScale: 1 }));
    full.process(inputs(1)[0], undefined, new Set([0]));
    expect(full.getFiringStats().silent).toBe(N - 2);
  });

  it('never silences the whole mesh, whatever the thresholds are', () => {
    // Even thresholds far above 1 cannot take the loudest neuron out.
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver', firingThreshold: 50 }));
    for (const input of inputs(10)) {
      engine.process(input, undefined, new Set([0]));
      const stats = engine.getFiringStats();
      expect(stats.silent).toBeLessThan(stats.eligible);
    }
  });
});

describe('what a silent neuron is', () => {
  it('has zero content, while a neuron that fires does not', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver' }));
    engine.process(inputs(1)[0], undefined, new Set([0]));
    const states = statesOf(engine.captureNetworkState());
    const stats = engine.getFiringStats();
    const silent = states.slice(1).filter(contentIsZero).length;
    // Exactly the neurons the engine reported silent are the ones with nothing in them.
    expect(silent).toBe(stats.silent);
    expect(stats.silent).toBeGreaterThan(0);
    expect(states.slice(1).some(s => !contentIsZero(s))).toBe(true);
  });

  it('never silences a neuron that is being driven', () => {
    const input = inputs(1)[0];
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver', firingThreshold: 5 }));
    engine.process(input, undefined, new Set([0]));
    const driven = statesOf(engine.captureNetworkState())[0];
    // Clamped to its input, whatever the threshold.
    expect(driven[0]).toBe(1);
    for (let d = 0; d < DIMS; d++) expect(driven[d + 1]).toBeCloseTo(Math.max(-1, Math.min(1, input[d])), 6);
    // And it is not even counted as a neuron that could have been gated.
    expect(engine.getFiringStats().eligible).toBe(N - 1);
  });

  it('never gates a neuron that was held out of the tick by its group', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver' }));
    for (let i = 1; i < N; i++) engine.setNeuronGroup(i, i % 2 === 0 ? 'a' : 'b');
    engine.process(inputs(1)[0], undefined, new Set([0]), undefined, { activeGroups: new Set(['a']) });
    const held = Array.from({ length: N - 1 }, (_, k) => k + 1).filter(i => i % 2 === 1).length;
    // Driven neuron 0 and the held group-b neurons are not eligible.
    expect(engine.getFiringStats().eligible).toBe(N - 1 - held);
  });

  it('keeps vale\'s share of what it had, because vale resists change even in silence', () => {
    // One settle iteration, so each neuron's new content is a single step from
    // its old one: a silent neuron with vale 0.5 must land on exactly half of
    // what it held; a neuron that fires lands somewhere else.
    const make = (mode: 'off' | 'saver') => new HyperDimensionalEngine(live({ propagationSteps: 1, firingMode: mode }));
    const vale = new Map<number, number>();
    for (let i = 0; i < N; i++) vale.set(i, 0.5);
    const warm = inputs(1)[0];

    const engine = make('saver');
    engine.process(warm, undefined, new Set([0]), vale, { learn: false });
    const before = statesOf(engine.captureNetworkState());
    engine.process(inputs(2)[1], undefined, new Set([0]), vale, { learn: false });
    const after = statesOf(engine.captureNetworkState());
    const stats = engine.getFiringStats();
    expect(stats.silent).toBeGreaterThan(0);

    let halved = 0;
    for (let i = 1; i < N; i++) {
      const isHalf = after[i].slice(1).every((v, d) => Math.abs(v - 0.5 * before[i][d + 1]) < 1e-6);
      if (isHalf) halved++;
    }
    expect(halved).toBe(stats.silent);
  });

  it('keeps every state finite and inside tanh\'s range', () => {
    const engine = new HyperDimensionalEngine(live({ firingScale: 0.8 }));
    for (const input of inputs(20)) engine.process(input, undefined, new Set([0]));
    for (const s of statesOf(engine.captureNetworkState())) for (const v of s) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the decision is made once and held', () => {
  it('leaves silent neurons exactly zero at the end of a settle, however many iterations it ran', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'balanced', propagationSteps: 32 }));
    for (const input of inputs(4)) {
      const out = engine.process(input, undefined, new Set([0]));
      const states = statesOf(engine.captureNetworkState());
      expect(out.settleIterations).toBeGreaterThan(1);
      expect(states.slice(1).filter(contentIsZero).length).toBe(engine.getFiringStats().silent);
    }
  });

  it('does not make the mesh take more iterations to settle than it does with thresholds off', () => {
    const iterations = (mode: 'off' | 'balanced' | 'saver') => {
      const engine = new HyperDimensionalEngine(live({ firingMode: mode, propagationSteps: 32 }));
      let total = 0;
      for (const input of inputs(8)) total += engine.process(input, undefined, new Set([0])).settleIterations;
      return total / 8;
    };
    const off = iterations('off');
    // Re-deciding every iteration measured 2-4x as many here; a held decision is at worst
    // a little slower, never multiples.
    expect(iterations('balanced')).toBeLessThanOrEqual(off * 1.5 + 1);
    expect(iterations('saver')).toBeLessThanOrEqual(off * 1.5 + 1);
  });

  it('is made fresh every tick, from that tick\'s input', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'balanced' }));
    const silentSets: string[] = [];
    for (const input of inputs(6)) {
      engine.process(input, undefined, new Set([0]));
      silentSets.push(statesOf(engine.captureNetworkState()).map((s, i) => (i > 0 && contentIsZero(s) ? i : -1)).filter(i => i > 0).join(','));
    }
    // Different input, different neurons speak: not the same set every time.
    expect(new Set(silentSets).size).toBeGreaterThan(1);
  });
});

describe('a silent neuron sits the tick out of learning', () => {
  it('leaves its incoming connections untouched while the neurons that spoke learn', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'balanced' }));
    engine.process(inputs(2)[0], undefined, new Set([0]));
    const before = engine.captureNetworkState();
    engine.process(inputs(2)[1], undefined, new Set([0]));
    const after = engine.captureNetworkState();

    const states = statesOf(after);
    const D = DIMS + 1;
    const block = (snap: NetworkStateSnapshot, i: number) => {
      const bytes = Buffer.from(snap.connDiag, 'base64');
      const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      return Array.from(f.subarray(i * D * N, (i + 1) * D * N));
    };
    let silentChecked = 0;
    let activeChanged = 0;
    for (let i = 1; i < N; i++) {
      const same = block(before, i).every((v, k) => v === block(after, i)[k]);
      if (contentIsZero(states[i])) { expect(same).toBe(true); silentChecked++; }
      else if (!same) activeChanged++;
    }
    expect(silentChecked).toBeGreaterThan(0);
    expect(activeChanged).toBeGreaterThan(0);
  });

  it('with thresholds off, every neuron still learns as it always did', () => {
    // The skip is only taken with thresholds on.
    const engine = new HyperDimensionalEngine(live());
    engine.process(inputs(2)[0], undefined, new Set([0]));
    const before = engine.captureNetworkState().connDiag;
    engine.process(inputs(2)[1], undefined, new Set([0]));
    expect(engine.captureNetworkState().connDiag).not.toBe(before);
  });
});

describe('only a normal tick is gated', () => {
  it('leaves the definition trainers exact: same result with thresholds on or off', () => {
    const train = (mode: 'off' | 'saver') => {
      const engine = new HyperDimensionalEngine(live({ firingMode: mode }));
      const result = engine.trainDefinitions(
        [{ driveNeuronId: 0, input: new Array(DIMS).fill(0.5), readoutNeuronId: 1, target: new Array(DIMS).fill(0.3) }],
        { epochs: 4 },
      );
      return { result, snapshot: engine.captureNetworkState(), stats: engine.getFiringStats() };
    };
    const off = train('off');
    const saver = train('saver');
    expect(saver.result.losses).toEqual(off.result.losses);
    expect(saver.snapshot.connDiag).toBe(off.snapshot.connDiag);
    expect(saver.snapshot.states).toBe(off.snapshot.states);
    // Nothing was ever counted as eligible: the gate never ran.
    expect(saver.stats.eligible).toBe(0);
  });
});

describe('live correction and silence', () => {
  it('does not put activity back into a neuron the threshold silenced', () => {
    // Forced to fire on every iteration: any divergence at all counts, after one.
    const engine = new HyperDimensionalEngine(live({
      firingScale: 0.5, propagationSteps: 1, sustainedDivergenceTicks: 1, divergenceTolerance: 0,
    }));
    const [first, second] = inputs(2);
    engine.process(first, undefined, new Set([0]));
    const out = engine.process(second, undefined, new Set([0]));
    expect(out.liveCorrections).toBeGreaterThan(0);
    const states = statesOf(engine.captureNetworkState());
    expect(engine.getFiringStats().silent).toBeGreaterThan(0);
    expect(states.slice(1).filter(contentIsZero).length).toBe(engine.getFiringStats().silent);
  });
});

describe('explaining a neuron', () => {
  it('says so when a neuron was silent, and does not when thresholds are off', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'balanced' }));
    engine.process(inputs(1)[0], undefined, new Set([0]));
    const states = statesOf(engine.captureNetworkState());
    let silent = 0;
    let spoke = 0;
    for (let i = 1; i < N; i++) {
      const trace = engine.traceNeuron(i, 1)!;
      if (contentIsZero(states[i])) {
        expect(trace.silent).toBe(true);
        expect(trace.equation).toContain('silent');
        silent++;
      } else {
        expect(trace.silent).toBe(false);
        expect(trace.equation).not.toContain('silent');
        spoke++;
      }
    }
    expect(silent).toBeGreaterThan(0);
    expect(spoke).toBeGreaterThan(0);

    const plain = new HyperDimensionalEngine(live());
    plain.process(inputs(1)[0], undefined, new Set([0]));
    for (let i = 1; i < N; i++) expect(plain.traceNeuron(i, 1)!.silent).toBe(false);
  });
});

describe('each neuron has its own threshold', () => {
  it('starts every neuron at the default, and validates what it is told', () => {
    const engine = new HyperDimensionalEngine(live());
    expect(engine.getNeuronThreshold(3)).toBe(DEFAULT_FIRING_THRESHOLD);
    expect(engine.setNeuronThreshold(3, 0.25)).toBe(true);
    expect(engine.getNeuronThreshold(3)).toBe(0.25);
    expect(engine.setNeuronThreshold(3, -1)).toBe(false);
    expect(engine.setNeuronThreshold(3, NaN)).toBe(false);
    expect(engine.setNeuronThreshold(3, Infinity)).toBe(false);
    expect(engine.setNeuronThreshold(3, '1' as never)).toBe(false);
    expect(engine.setNeuronThreshold(N, 1)).toBe(false);
    expect(engine.setNeuronThreshold(-1, 1)).toBe(false);
    expect(engine.setNeuronThreshold(1.5, 1)).toBe(false);
    expect(engine.getNeuronThreshold(N)).toBeNull();
    // A refused value leaves the old one in place.
    expect(engine.getNeuronThreshold(3)).toBe(0.25);
  });

  it('lets one neuron be exempt while every other must clear its bar', () => {
    // Absolute thresholds make this exact: a huge bar for everyone but neuron 5,
    // whose bar is zero and so can never be silenced.
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver', firingReference: 'absolute', firingThreshold: 1e6 }));
    engine.setNeuronThreshold(5, 0);
    engine.process(inputs(1)[0], undefined, new Set([0]));
    const states = statesOf(engine.captureNetworkState());
    const stats = engine.getFiringStats();
    expect(stats.silent).toBe(N - 2);
    expect(contentIsZero(states[5])).toBe(false);
    for (let i = 1; i < N; i++) if (i !== 5) expect(contentIsZero(states[i])).toBe(true);
  });

  it('a threshold of zero everywhere silences nothing, at any scale', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver', firingThreshold: 0 }));
    for (const input of inputs(4)) {
      engine.process(input, undefined, new Set([0]));
      expect(engine.getFiringStats().silent).toBe(0);
    }
  });

  it('with the absolute reference, a huge bar silences every neuron that could fire', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver', firingReference: 'absolute', firingThreshold: 1e6 }));
    engine.process(inputs(1)[0], undefined, new Set([0]));
    expect(engine.getFiringStats()).toMatchObject({ reference: 'absolute', silent: N - 1, silentFraction: 1 });
  });

  it('gives a neuron added later the default, and keeps the others\' own', () => {
    const engine = new HyperDimensionalEngine(live());
    engine.setNeuronThreshold(2, 0.4);
    const [added] = engine.addNeurons(1);
    // Stored as Float32 like every other array in the engine, so 0.4 reads back as 0.4000000059.
    expect(engine.getNeuronThreshold(2)).toBeCloseTo(0.4, 6);
    expect(engine.getNeuronThreshold(added)).toBe(DEFAULT_FIRING_THRESHOLD);
    // And a grown network still settles under thresholds without reading past anything.
    engine.setFiringMode('balanced');
    engine.process(inputs(1)[0], undefined, new Set([0]));
    expect(engine.getFiringStats().eligible).toBe(N);
  });
});

describe('saving and restoring', () => {
  it('writes the snapshot it always did when no threshold was touched', () => {
    const engine = new HyperDimensionalEngine(live({ firingMode: 'saver' }));
    engine.process(inputs(1)[0], undefined, new Set([0]));
    // The mode is a runtime setting, not part of the network, and an untouched
    // threshold array adds no key, so every existing fingerprint stays valid.
    expect('firingThreshold' in engine.captureNetworkState()).toBe(false);
  });

  it('keeps a changed threshold across a save and restore', () => {
    const a = new HyperDimensionalEngine(live());
    a.setNeuronThreshold(4, 0.125);
    a.setNeuronThreshold(9, 2);
    const snap = a.captureNetworkState();
    expect(typeof snap.firingThreshold).toBe('string');

    const b = new HyperDimensionalEngine(live({ seed: 99 }));
    expect(b.restoreNetworkState(snap)).toBe(true);
    expect(b.getNeuronThreshold(4)).toBe(0.125);
    expect(b.getNeuronThreshold(9)).toBe(2);
    expect(b.getNeuronThreshold(0)).toBe(DEFAULT_FIRING_THRESHOLD);
  });

  it('loads a snapshot written before thresholds existed, with every neuron back at the default', () => {
    const old = new HyperDimensionalEngine(live()).captureNetworkState();
    expect('firingThreshold' in old).toBe(false);
    const engine = new HyperDimensionalEngine(live());
    engine.setNeuronThreshold(6, 0.01);
    expect(engine.restoreNetworkState(old)).toBe(true);
    expect(engine.getNeuronThreshold(6)).toBe(DEFAULT_FIRING_THRESHOLD);
  });

  it('refuses a snapshot with a threshold that would make the comparison lie, and changes nothing', () => {
    const source = new HyperDimensionalEngine(live());
    source.setNeuronThreshold(1, 0.5);
    const good = source.captureNetworkState();
    const bad = new Float32Array(N).fill(DEFAULT_FIRING_THRESHOLD);

    const target = new HyperDimensionalEngine(live({ seed: 5 }));
    target.process(inputs(1)[0], undefined, new Set([0]));
    const before = target.captureNetworkState();

    // Negative squares to a positive, NaN compares false: both must be turned away whole.
    for (const poison of [-1, NaN, Infinity]) {
      bad[3] = poison;
      const snap = { ...good, firingThreshold: Buffer.from(bad.buffer, bad.byteOffset, bad.byteLength).toString('base64') };
      expect(target.restoreNetworkState(snap)).toBe(false);
    }
    // Wrong length is refused too.
    expect(target.restoreNetworkState({ ...good, firingThreshold: Buffer.from(new Float32Array(N - 1).buffer).toString('base64') })).toBe(false);

    const after = target.captureNetworkState();
    expect(after.states).toBe(before.states);
    expect(after.connDiag).toBe(before.connDiag);
    expect(target.getNeuronThreshold(1)).toBe(DEFAULT_FIRING_THRESHOLD);
  });
});
