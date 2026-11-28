/**
 * Self-debug wiring (interface/self-debug-routes.ts): routes, what it keeps between restarts, the
 * skills it makes with the Extension Builder, the plugin proposals it installs OFF through the
 * Extension Manager, and the background pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain';
import { handleWeightsRoutes } from '../../interface/weights-routes';
import { handleSelfDebugRoutes, isSelfDebugRoute, SelfDebugService, resetSelfDebugService } from '../../interface/self-debug-routes';
import { PLUGIN_THRESHOLD } from '../../models && skills/core/self-debug';

const SRC = `neurons="8"\n"n1"@input="hello"\n"n1"@response="hi there"\n"n2"@input="goodbye"\n"n2"@response="see you later"\n"n3"@input="thanks"\n"n3"@response="you are welcome"`;

let tmp: string;
let service: SelfDebugService;
let engine: HyperDimensionalEngine | null = null;
const oldEnv = { ...process.env };

const dirsIn = (root: string) => ({ state: path.join(root, 'state'), skills: path.join(root, 'skills'), extensions: path.join(root, 'extensions') });

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'self-debug-'));
  process.env.CORONA_DATA_DIR = path.join(tmp, 'data');
  delete process.env.NEUROCLAW_SELF_DEBUG;
  service = new SelfDebugService(dirsIn(tmp));
  resetSelfDebugService(service);
  engine = null;
});
afterEach(() => {
  resetSelfDebugService(null);
  vi.useRealTimers();
  process.env = { ...oldEnv };
  rmSync(tmp, { recursive: true, force: true });
});

async function weights(method: string, pathname: string, body?: unknown) {
  let out: { status: number; data: any } | undefined;
  await handleWeightsRoutes({
    req: {} as never, res: {} as never, pathname, method,
    parseBody: async () => body,
    sendJson: (_r, data, status = 200) => { out = { status, data }; },
    base: async () => engine,
  });
  return out!;
}
async function call(method: string, pathname: string, body?: unknown, svc: SelfDebugService = service) {
  let out: { status: number; data: any } | undefined;
  const handled = await handleSelfDebugRoutes({
    req: {} as never, res: {} as never, pathname, method,
    parseBody: async () => body,
    sendJson: (_r, data, status = 200) => { out = { status, data }; },
  }, svc);
  return { handled, ...out! };
}
const makeNet = async (name = 'demo') => (await weights('POST', '/api/nets', { source: SRC + '\ntrain', dimensions: 32, name })).data.id as string;

describe('routes', () => {
  it('only claims its own paths', async () => {
    expect(isSelfDebugRoute('/api/self-improvement/self-debug')).toBe(true);
    expect(isSelfDebugRoute('/api/self-improvement/self-debug/run')).toBe(true);
    expect(isSelfDebugRoute('/api/self-improvement/history')).toBe(false);
    expect(isSelfDebugRoute('/api/self-improvement/self-debugger')).toBe(false);
    expect((await call('GET', '/api/self-improvement/history')).handled).toBe(false);
    expect((await call('GET', '/api/self-improvement/self-debug/nothing')).handled).toBe(false);
  });

  it('lists the nets and how each scores, runs one, and serves the full run', async () => {
    const id = await makeNet();
    const status = await call('GET', '/api/self-improvement/self-debug');
    expect(status.status).toBe(200);
    expect(status.data.nets).toEqual([expect.objectContaining({ id, name: 'demo', cases: 3 })]);
    expect(status.data.running).toBe(false);
    expect(status.data.last).toBeNull();

    const run = await call('POST', '/api/self-improvement/self-debug/run', { net: id, minCosine: 0.6, maxRounds: 40 });
    expect(run.status).toBe(200);
    expect(run.data.after.confident).toBeGreaterThan(run.data.before.confident);
    expect(run.data.dialogue.length).toBeGreaterThan(2);

    const after = await call('GET', '/api/self-improvement/self-debug');
    expect(after.data.last.id).toBe(run.data.id);
    expect(after.data.last.rounds).toBeGreaterThan(0);
    expect(after.data.last).not.toHaveProperty('dialogue'); // the list is brief
    expect(after.data.trustedWeights.length).toBeGreaterThan(0);

    const full = await call('GET', `/api/self-improvement/self-debug/sessions/${run.data.id}`);
    expect(full.data.dialogue.length).toBe(run.data.dialogue.length);
    expect((await call('GET', '/api/self-improvement/self-debug/sessions/nope123')).status).toBe(404);
  });

  it('checks what it is sent', async () => {
    expect((await call('POST', '/api/self-improvement/self-debug/run', { net: 'zz' })).status).toBe(400);
    expect((await call('POST', '/api/self-improvement/self-debug/run', {})).status).toBe(400);
    expect((await call('POST', '/api/self-improvement/self-debug/run', 'text' as never)).status).toBe(400);
    expect((await call('POST', '/api/self-improvement/self-debug/run', { net: '0123456789' })).status).toBe(404);
    const id = await makeNet();
    expect((await call('POST', '/api/self-improvement/self-debug/run', { net: id, maxRounds: 'lots' })).status).toBe(400);
    expect((await call('POST', '/api/self-improvement/self-debug/run', { net: id, makeSkills: 'yes' })).status).toBe(400);
    expect((await call('POST', '/api/self-improvement/self-debug/auto', {})).status).toBe(400);
  });

  it('will not change the live AI without confirm', async () => {
    engine = new HyperDimensionalEngine({ neuronCount: 10, dimensions: 32, seed: 3 });
    const made = await weights('POST', '/api/nets', { source: `kind="skill"\nneurons="3"\n"n1"@input="hi"\n"n1"@response="x"`, confirm: true, name: 'live-skill' });
    expect(made.status).toBe(200);
    const refused = await call('POST', '/api/self-improvement/self-debug/run', { net: made.data.id });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/confirm/);
    expect((await call('POST', '/api/self-improvement/self-debug/run', { net: made.data.id, confirm: true })).status).toBe(200);
  });

  it('turns the background pass on and off, and an environment switch beats it', async () => {
    expect((await call('GET', '/api/self-improvement/self-debug')).data.auto).toBe(true);
    expect((await call('POST', '/api/self-improvement/self-debug/auto', { enabled: false })).data.auto).toBe(false);
    expect((await call('GET', '/api/self-improvement/self-debug')).data.auto).toBe(false);
    expect((await call('POST', '/api/self-improvement/self-debug/auto', { enabled: true })).data.auto).toBe(true);
    process.env.NEUROCLAW_SELF_DEBUG = '0';
    expect((await call('GET', '/api/self-improvement/self-debug')).data.auto).toBe(false);
  });

  it('says so when a plugin to approve does not exist', async () => {
    expect((await call('POST', '/api/self-improvement/self-debug/plugins/nothing/approve')).status).toBe(404);
    expect((await call('POST', '/api/self-improvement/self-debug/plugins/nothing/deny')).status).toBe(404);
  });
});

describe('what it keeps', () => {
  it('survives a restart: the weights history and the recent runs come back', async () => {
    const id = await makeNet();
    const run = await call('POST', '/api/self-improvement/self-debug/run', { net: id, minCosine: 0.6 });
    const tracked = (await call('GET', '/api/self-improvement/self-debug')).data.weightsTracked;
    expect(tracked).toBeGreaterThan(0);

    const reborn = new SelfDebugService(dirsIn(tmp));
    const status = await call('GET', '/api/self-improvement/self-debug', undefined, reborn);
    expect(status.data.weightsTracked).toBe(tracked);
    expect(status.data.last.id).toBe(run.data.id);
    expect((await call('GET', `/api/self-improvement/self-debug/sessions/${run.data.id}`, undefined, reborn)).status).toBe(200);
  });

  it('keeps a bounded number of runs, and a bounded amount of each', async () => {
    const id = await makeNet();
    for (let i = 0; i < 3; i++) await call('POST', '/api/self-improvement/self-debug/run', { net: id, minCosine: 0.99, maxRounds: 1 });
    const file = JSON.parse(readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8'));
    expect(file.sessions.length).toBeLessThanOrEqual(30);
    expect(file.sessions.every((s: any) => s.dialogue.length <= 120)).toBe(true);
  });

  it('starts clean when the saved state is unreadable', () => {
    mkdirSyncFile(path.join(tmp, 'state'), 'state.json', '{not json');
    const svc = new SelfDebugService(dirsIn(tmp));
    expect(svc.status().sessions).toEqual([]);
    expect(svc.status().weightsTracked).toBe(0);
  });
});

function mkdirSyncFile(dir: string, name: string, content: string) {
  // node:fs imported lazily to keep the top of the file about the service
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe('making skills with the Extension Builder', () => {
  it('saves in the format the server loads at boot, and reports truthfully whether the mesh training reproduced each script', async () => {
    const r = await service.skillMaker({
      name: 'self-debug-demo-1', description: 'demo',
      scripts: [{ userSays: 'good morning', response: 'morning to you' }, { userSays: 'good night', response: 'sleep well' }, { userSays: 'thank you', response: 'you are welcome' }],
      sources: ['self-debug'],
    });
    expect(r).toMatchObject({ ok: true, id: 'self-debug-demo-1' });
    const saved = JSON.parse(readFileSync(path.join(tmp, 'skills', 'self-debug-demo-1.ext.json'), 'utf8'));
    expect(saved.project.name).toBe('self-debug-demo-1');
    expect(saved.neurons.map((n: any) => n.scripts[0])).toEqual([
      { userSays: 'good morning', response: 'morning to you' }, { userSays: 'good night', response: 'sleep well' }, { userSays: 'thank you', response: 'you are welcome' },
    ]);
    // The flag and the result agree: nothing is claimed trained that was not.
    const allTrained = saved.neurons.every((n: any) => n.trained === true);
    expect(r.converged).toBe(allTrained);
    expect(r.detail).toMatch(/reproduced \d+ of 3/);
    if (!allTrained) expect(r.detail).toMatch(/matching what was typed/);
  });

  it('keeps nothing when two scripts answer the same question differently', async () => {
    const r = await service.skillMaker({
      name: 'self-debug-bad-1', description: 'contradictory',
      scripts: [{ userSays: 'hello', response: 'one' }, { userSays: 'Hello ', response: 'two' }],
      sources: [],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/differently/);
    expect(existsSync(path.join(tmp, 'skills', 'self-debug-bad-1.ext.json'))).toBe(false);
  });

  it('counts a repeated script once', async () => {
    const r = await service.skillMaker({ name: 'self-debug-dup-1', description: '', scripts: [{ userSays: 'good morning', response: 'morning to you' }, { userSays: 'good morning', response: 'morning to you' }], sources: [] });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(tmp, 'skills', 'self-debug-dup-1.ext.json'), 'utf8')).neurons).toHaveLength(1);
  });

  it('writes only a safe file name', async () => {
    const r = await service.skillMaker({ name: '../../etc/x', description: '', scripts: [{ userSays: 'a b', response: 'c d' }], sources: [] });
    const files = existsSync(path.join(tmp, 'skills')) ? readdirSync(path.join(tmp, 'skills')) : [];
    expect(files.every(f => /^[a-z0-9-]+\.ext\.json$/.test(f))).toBe(true);
    expect(r.id ?? '').not.toContain('/');
  });
});

describe('plugin proposals through the Extension Manager', () => {
  const contradictions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, text: 'hello', expect: `answer number ${i} is different`, drive: 'n1', source: 'user' as const }));

  it('installs OFF, and activates only when the owner approves', async () => {
    const id = await makeNet();
    // A run whose weights cannot satisfy contradictions: make a skill, then propose a plugin.
    // (The real skill maker cannot train contradictory scripts, so use consistent ones through a stand-in.)
    const svc = new SelfDebugService(dirsIn(tmp));
    resetSelfDebugService(svc);
    const real = svc.pluginProposer;
    const spec = { id: 'self-debug-demo-plugin', name: 'Demo', description: 'd', capabilities: ['answer'], table: [{ userSays: 'a b', response: 'c' }] };
    const { makePluginSource } = await import('../../models && skills/core/self-debug');
    const source = makePluginSource(spec);
    const installed = await real(source, spec);
    expect(installed).toMatchObject({ ok: true, id: 'self-debug-demo-plugin' });
    expect(installed.detail).toMatch(/inactive/);
    const active = path.join(tmp, 'extensions', 'active.json');
    expect(existsSync(active) ? JSON.parse(readFileSync(active, 'utf8')) : {}).not.toHaveProperty('self-debug-demo-plugin');
    void id; void contradictions; void PLUGIN_THRESHOLD;

    // Approval goes through the debugger, which activates through the manager.
    (svc.debugger as any).pending.set('self-debug-demo-plugin', svc.debugger.actions.request('plugin:activate:self-debug-demo-plugin', 'x', 'self-debug'));
    const approved = await call('POST', '/api/self-improvement/self-debug/plugins/self-debug-demo-plugin/approve', undefined, svc);
    expect(approved.status).toBe(200);
    expect(JSON.parse(readFileSync(active, 'utf8'))).toHaveProperty('self-debug-demo-plugin');
  });

  it('records the provenance: written by the self-debug loop, not by a person', async () => {
    const spec = { id: 'prov-plugin', name: 'P', description: 'd', capabilities: ['answer'], table: [{ userSays: 'a b', response: 'c' }] };
    const { makePluginSource } = await import('../../models && skills/core/self-debug');
    await service.pluginProposer(makePluginSource(spec), spec);
    const manifest = JSON.parse(readFileSync(path.join(tmp, 'extensions', 'prov-plugin', '1.0.0', 'manifest.json'), 'utf8'));
    expect(manifest.provenance).toMatchObject({ autoCreated: true, createdBy: 'self-debug' });
    expect(manifest.kind).toBe('plugin');
    expect(manifest.permissions).toEqual([]);
  });
});

describe('the background pass', () => {
  it('works on nets that are not part of the live AI, and leaves the live AI alone', async () => {
    await makeNet('plain');
    engine = new HyperDimensionalEngine({ neuronCount: 10, dimensions: 32, seed: 3 });
    const live = await weights('POST', '/api/nets', { source: `kind="skill"\nneurons="3"\n"n1"@input="hi"\n"n1"@response="x"`, confirm: true, name: 'live' });
    expect(live.status).toBe(200);
    const spy = vi.spyOn(service, 'run');
    const ran = await service.autoPass();
    // Everything a plain net answers clearly is left alone; whatever it does run on is never the live skill.
    for (const call of spy.mock.calls) expect(call[0]).not.toBe(live.data.id);
    expect(Array.isArray(ran)).toBe(true);
  });

  it('does nothing when switched off', async () => {
    await makeNet();
    await call('POST', '/api/self-improvement/self-debug/auto', { enabled: false });
    const spy = vi.spyOn(service, 'run');
    expect(await service.autoPass()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs on a timer, and stops', () => {
    vi.useFakeTimers();
    process.env.NEUROCLAW_SELF_DEBUG_INTERVAL_MS = '60000';
    const pass = vi.spyOn(service, 'autoPass').mockResolvedValue([]);
    service.startLoop();
    service.startLoop(); // twice is still one timer
    vi.advanceTimersByTime(60_000);
    expect(pass).toHaveBeenCalledTimes(1);
    service.stopLoop();
    vi.advanceTimersByTime(180_000);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('never starts the timer when switched off in the environment', () => {
    vi.useFakeTimers();
    process.env.NEUROCLAW_SELF_DEBUG = '0';
    const pass = vi.spyOn(service, 'autoPass').mockResolvedValue([]);
    service.startLoop();
    vi.advanceTimersByTime(3_600_000);
    expect(pass).not.toHaveBeenCalled();
  });
});
