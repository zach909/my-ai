/**
 * Shared mesh learning (models && skills/core/shared-mesh.ts,
 * shared-mesh-sync.ts): weight changes, not text, persisted locally and --
 * only when opted into -- shared between installs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain';
import {
  extractCore, injectCore, combine, zerosLike, rms, makeBaseFile, encodeDelta, decodeDelta,
  readOthersContribution, MAX_DELTA_ABS, type CoreArrays,
} from '../../models && skills/core/shared-mesh';
import { SharedMeshSync, sharedLearningEnabled } from '../../models && skills/core/shared-mesh-sync';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'shared-mesh-'));
  tmps.push(d);
  return d;
}
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

function engine(): HyperDimensionalEngine {
  return new HyperDimensionalEngine({ dimensions: 4, neuronCount: 6, hyperGain: 1, hyperAdd: 1, hyperWaveGain: 1 });
}

/** Nudge every learned weight in the shared block, as training would. */
function learnSomething(e: HyperDimensionalEngine, shape: { neurons: number; dimensions: number }, amount = 0.01): void {
  const snap = e.captureNetworkState();
  const core = extractCore(snap, shape)!;
  const nudged: CoreArrays = {};
  for (const [k, v] of Object.entries(core)) nudged[k] = v.map((x, i) => x + amount * ((i % 3) - 1));
  expect(e.restoreNetworkState(injectCore(snap, nudged, shape)!)).toBe(true);
}

function setup(root: string, e: HyperDimensionalEngine) {
  const baseFile = path.join(root, 'base.json');
  const base = makeBaseFile(e.captureNetworkState());
  writeFileSync(baseFile, JSON.stringify(base));
  const deltasDir = path.join(root, 'deltas');
  mkdirSync(deltasDir, { recursive: true });
  return { base, paths: { root, baseFile, deltasDir, localDir: path.join(root, 'local'), publishScript: path.join(root, 'none.mjs') } };
}

describe('shared mesh: core block', () => {
  it('extracts the same base-sized block from a grown network, and writes it back without touching grafted neurons', () => {
    const e = engine();
    const shape = e.captureNetworkState().shape;
    const before = extractCore(e.captureNetworkState(), shape)!;
    e.addNeurons(3);
    const grown = e.captureNetworkState();
    expect(grown.shape.neurons).toBe(shape.neurons + 3);
    const after = extractCore(grown, shape)!;
    for (const k of Object.keys(before)) expect(Array.from(after[k])).toEqual(Array.from(before[k]));

    const zeroed = injectCore(grown, zerosLike(after), shape)!;
    const full = extractCore(zeroed, grown.shape)!;
    // A grafted neuron's own connection row is untouched by writing the base block.
    const N = grown.shape.neurons;
    expect(full.modWeight[(N - 1) * N + (N - 1)]).toBe(extractCore(grown, grown.shape)!.modWeight[(N - 1) * N + (N - 1)]);
    expect(rms(extractCore(zeroed, shape)!)).toBe(0);
  });
});

describe('shared mesh: deltas', () => {
  it('round-trips a delta through int8 quantisation within one step', () => {
    const e = engine();
    const shape = e.captureNetworkState().shape;
    const core = extractCore(e.captureNetworkState(), shape)!;
    const delta: CoreArrays = {};
    for (const [k, v] of Object.entries(core)) delta[k] = v.map((_, i) => Math.sin(i) * 0.05);
    const back = decodeDelta(JSON.parse(JSON.stringify(encodeDelta(delta, 'b', shape))), 'b', shape, Object.keys(core))!;
    for (const k of Object.keys(delta)) {
      for (let i = 0; i < delta[k].length; i++) expect(Math.abs(back[k][i] - delta[k][i])).toBeLessThanOrEqual(0.05 / 127 + 1e-7);
    }
  });

  it('rejects a delta for a different base, a different shape, or with an oversized step', () => {
    const e = engine();
    const shape = e.captureNetworkState().shape;
    const core = extractCore(e.captureNetworkState(), shape)!;
    const file = encodeDelta(zerosLike(core), 'b', shape);
    const keys = Object.keys(core);
    expect(decodeDelta(file, 'other', shape, keys)).toBeNull();
    expect(decodeDelta(file, 'b', { ...shape, neurons: shape.neurons + 1 }, keys)).toBeNull();
    const huge = JSON.parse(JSON.stringify(file));
    huge.arrays[keys[0]].scale = (MAX_DELTA_ABS * 10) / 127;
    expect(decodeDelta(huge, 'b', shape, keys)).toBeNull();
    const nan = JSON.parse(JSON.stringify(file));
    nan.arrays[keys[0]].scale = null;
    expect(decodeDelta(nan, 'b', shape, keys)).toBeNull();
  });

  it("averages other installs' deltas as sum / (installs + 1), skipping its own file and junk", () => {
    const root = tmp();
    const e = engine();
    const shape = e.captureNetworkState().shape;
    const core = extractCore(e.captureNetworkState(), shape)!;
    const ones: CoreArrays = {};
    for (const [k, v] of Object.entries(core)) ones[k] = new Float32Array(v.length).fill(0.3);
    writeFileSync(path.join(root, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify(encodeDelta(ones, 'b', shape)));
    writeFileSync(path.join(root, 'bbbbbbbbbbbbbbbb.json'), JSON.stringify(encodeDelta(ones, 'b', shape)));
    writeFileSync(path.join(root, 'cccccccccccccccc.json'), JSON.stringify(encodeDelta(ones, 'b', shape))); // "mine"
    writeFileSync(path.join(root, 'dddddddddddddddd.json'), '{not json');
    const r = readOthersContribution(root, { baseId: 'b', shape, expectedKeys: Object.keys(core), excludeInstallId: 'cccccccccccccccc', template: core });
    expect(r.installs).toBe(2);
    expect(r.contribution.modWeight[0]).toBeCloseTo((0.3 + 0.3) / 3, 5);
  });
});

describe('shared mesh: sync', () => {
  it('is opt-in: sharing is off unless NEUROCLAW_SHARED_LEARNING=1', () => {
    expect(sharedLearningEnabled({})).toBe(false);
    expect(sharedLearningEnabled({ NEUROCLAW_SHARED_LEARNING: '0' })).toBe(false);
    expect(sharedLearningEnabled({ NEUROCLAW_SHARED_LEARNING: '1' })).toBe(true);
  });

  it("keeps the mesh's learning across a restart, starting every install from the same base", async () => {
    const root = tmp();
    const first = engine();
    const { paths } = setup(root, first);
    const shape = first.captureNetworkState().shape;

    const a = new SharedMeshSync(() => first, null, paths, { enabled: false, log: () => {} });
    expect(a.boot()).toBe(true);
    learnSomething(first, shape);
    const learned = extractCore(first.captureNetworkState(), shape)!;
    await a.tick();
    expect(a.getStatus().ownDeltaRms).toBeGreaterThan(0);

    // A different, randomly initialised engine -- a restart, or another machine.
    const second = engine();
    const b = new SharedMeshSync(() => second, null, paths, { enabled: false, log: () => {} });
    expect(b.boot()).toBe(true);
    const restored = extractCore(second.captureNetworkState(), shape)!;
    for (const k of Object.keys(learned)) {
      for (let i = 0; i < learned[k].length; i++) expect(restored[k][i]).toBeCloseTo(learned[k][i], 5);
    }
  });

  it('with sharing off, never queues a push and ignores other installs', async () => {
    const root = tmp();
    const e = engine();
    const { paths, base } = setup(root, e);
    const shape = e.captureNetworkState().shape;
    const core = extractCore(e.captureNetworkState(), shape)!;
    const big: CoreArrays = {};
    for (const [k, v] of Object.entries(core)) big[k] = new Float32Array(v.length).fill(1);
    writeFileSync(path.join(paths.deltasDir, 'eeeeeeeeeeeeeeee.json'), JSON.stringify(encodeDelta(big, base.baseId, shape)));

    const sync = new SharedMeshSync(() => e, null, paths, { enabled: false, log: () => {} });
    expect(sync.boot()).toBe(true);
    expect(sync.getStatus().otherInstalls).toBe(0);
    learnSomething(e, shape);
    await sync.tick();
    expect(existsSync(path.join(paths.localDir, 'outbox.json'))).toBe(false);
  });

  it("with sharing on, merges others and publishes only this install's own learning", async () => {
    const root = tmp();
    const e = engine();
    const { paths, base } = setup(root, e);
    const shape = e.captureNetworkState().shape;
    const baseCore = extractCore(e.captureNetworkState(), shape)!;
    const other: CoreArrays = {};
    for (const [k, v] of Object.entries(baseCore)) other[k] = new Float32Array(v.length).fill(0.2);
    writeFileSync(path.join(paths.deltasDir, 'eeeeeeeeeeeeeeee.json'), JSON.stringify(encodeDelta(other, base.baseId, shape)));

    const sync = new SharedMeshSync(() => e, null, paths, { enabled: true, log: () => {} });
    expect(sync.boot()).toBe(true);
    expect(sync.getStatus().otherInstalls).toBe(1);
    // Absorbed at half weight: one other install, sum / (1 + 1).
    expect(extractCore(e.captureNetworkState(), shape)!.modWeight[0]).toBeCloseTo(baseCore.modWeight[0] + 0.1, 2);

    learnSomething(e, shape, 0.01);
    await sync.tick();
    const outbox = JSON.parse(readFileSync(path.join(paths.localDir, 'outbox.json'), 'utf8'));
    expect(outbox.relPath).toMatch(/^extension-builder\/shared-mesh\/deltas\/[a-f0-9]{16}\.json$/);
    const published = decodeDelta(JSON.parse(outbox.content), base.baseId, shape, Object.keys(baseCore))!;
    // Only the 0.01-sized nudge -- not the 0.1 absorbed from the other install.
    expect(rms(published)).toBeLessThan(0.02);
    expect(rms(published)).toBeGreaterThan(0.001);
    // Nothing but numbers leaves: no text fields beyond the file's own metadata.
    expect(Object.keys(JSON.parse(outbox.content)).sort()).toEqual(['arrays', 'baseId', 'shape', 'version']);
  });

  it('refuses to load a base that does not fit the engine, leaving it untouched', () => {
    const root = tmp();
    const small = engine();
    const { paths } = setup(root, small);
    const big = new HyperDimensionalEngine({ dimensions: 8, neuronCount: 6, hyperGain: 1, hyperAdd: 1, hyperWaveGain: 1 });
    const before = big.captureNetworkState();
    const sync = new SharedMeshSync(() => big, null, paths, { enabled: false, log: () => {} });
    expect(sync.boot()).toBe(false);
    expect(big.captureNetworkState().connDiag).toBe(before.connDiag);
  });
});

describe('combine', () => {
  it('adds and subtracts per array', () => {
    const a = { x: new Float32Array([1, 2]) };
    const b = { x: new Float32Array([0.5, 0.5]) };
    expect(Array.from(combine(a, b, -1).x)).toEqual([0.5, 1.5]);
  });
});

describe('shared mesh: withdrawing an install (the security model shut its agent down)', () => {
  it('skips an install that has a tombstone, wherever its delta already sits', () => {
    const root = tmp();
    const e = engine();
    const shape = e.captureNetworkState().shape;
    const core = extractCore(e.captureNetworkState(), shape)!;
    const ones: CoreArrays = {};
    for (const [k, v] of Object.entries(core)) ones[k] = new Float32Array(v.length).fill(0.3);
    const deltas = path.join(root, 'deltas');
    const revoked = path.join(root, 'revoked');
    mkdirSync(deltas, { recursive: true });
    mkdirSync(revoked, { recursive: true });
    writeFileSync(path.join(deltas, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify(encodeDelta(ones, 'b', shape)));
    writeFileSync(path.join(deltas, 'bbbbbbbbbbbbbbbb.json'), JSON.stringify(encodeDelta(ones, 'b', shape)));
    writeFileSync(path.join(revoked, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ installId: 'aaaaaaaaaaaaaaaa', at: 1, reason: 'malicious' }));
    writeFileSync(path.join(revoked, 'not-an-id.json'), '{}'); // only a real install id counts
    const opts = { baseId: 'b', shape, expectedKeys: Object.keys(core), excludeInstallId: 'cccccccccccccccc', template: core };
    for (const r of [readOthersContribution(deltas, { ...opts, revokedDir: revoked }), readOthersContribution(deltas, opts)]) {
      expect(r.installs).toBe(1); // the folder next to the deltas is the default
      expect(r.contribution.modWeight[0]).toBeCloseTo(0.3 / 2, 5);
    }
  });

  it("takes this install's learning back out of the network, retires its id and queues a tombstone", async () => {
    const root = tmp();
    const e = engine();
    const { paths } = setup(root, e);
    const shape = e.captureNetworkState().shape;
    const baseCore = extractCore(e.captureNetworkState(), shape)!;
    const script = path.join(root, 'publish.mjs');
    writeFileSync(script, '');
    const spawned: unknown[][] = [];
    const spawnFn = ((...a: unknown[]) => { spawned.push(a); return { on() {}, unref() {} }; }) as never;
    const sync = new SharedMeshSync(() => e, null, { ...paths, publishScript: script }, { enabled: true, log: () => {}, spawnFn });
    expect(sync.boot()).toBe(true);
    const oldId = sync.getStatus().installId!;
    expect(oldId).toMatch(/^[a-f0-9]{16}$/);

    learnSomething(e, shape, 0.05);
    await sync.tick();
    expect(Math.abs(extractCore(e.captureNetworkState(), shape)!.modWeight[0] - baseCore.modWeight[0])).toBeGreaterThan(0.01);
    const pushesBefore = spawned.length;

    const result = await sync.revokeOwn('The security model shut the agent down.');
    expect(result).toMatchObject({ purged: true, retiredId: oldId, tombstoneQueued: true });
    const after = extractCore(e.captureNetworkState(), shape)!;
    for (const k of Object.keys(baseCore)) for (let i = 0; i < baseCore[k].length; i++) expect(after[k][i]).toBeCloseTo(baseCore[k][i], 5);
    expect(existsSync(path.join(paths.localDir, 'own-delta.json.gz'))).toBe(false);
    expect(spawned.length).toBe(pushesBefore + 1);

    const outbox = JSON.parse(readFileSync(path.join(paths.localDir, 'outbox.json'), 'utf8'));
    expect(outbox.relPath).toBe(`extension-builder/shared-mesh/revoked/${oldId}.json`);
    expect(JSON.parse(outbox.content)).toMatchObject({ installId: oldId });
    expect(sync.getStatus().installId).not.toBe(oldId); // a clean identity from here on

    await sync.tick(); // nothing learned since, so nothing is published under the new id
    expect(JSON.parse(readFileSync(path.join(paths.localDir, 'outbox.json'), 'utf8')).relPath).toBe(`extension-builder/shared-mesh/revoked/${oldId}.json`);
  });

  it('still takes the learning out of the network when sharing is off, but pushes nothing', async () => {
    const root = tmp();
    const e = engine();
    const { paths } = setup(root, e);
    const shape = e.captureNetworkState().shape;
    const baseCore = extractCore(e.captureNetworkState(), shape)!;
    const sync = new SharedMeshSync(() => e, null, paths, { enabled: false, log: () => {} });
    expect(sync.boot()).toBe(true);
    learnSomething(e, shape, 0.05);
    const result = await sync.revokeOwn('malicious');
    expect(result).toMatchObject({ purged: true, tombstoneQueued: false });
    expect(extractCore(e.captureNetworkState(), shape)!.modWeight[0]).toBeCloseTo(baseCore.modWeight[0], 5);
    expect(existsSync(path.join(paths.localDir, 'outbox.json'))).toBe(false);
  });

  it('says plainly when there was nothing loaded to take out, and never throws', async () => {
    const root = tmp();
    const e = engine();
    const { paths } = setup(root, e);
    const sync = new SharedMeshSync(() => e, null, paths, { enabled: true, log: () => {} }); // never booted
    const result = await sync.revokeOwn('malicious');
    expect(result.purged).toBe(false);
    expect(result.note).toMatch(/not loaded/);
  });
});
