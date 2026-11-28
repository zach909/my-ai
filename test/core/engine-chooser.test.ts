import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Chooser, SEED_WEIGHTS, FEATURE_NAMES, taskSize, looksLikeSecret, rewardFor, loadChooser, saveChooser,
} from '../../models && skills/core/engine-chooser.js';
import type { ChooserInput } from '../../models && skills/core/engine-chooser.js';
import {
  parseLinuxBattery, parsePmset, parseWindowsBattery, probeDevice,
} from '../../models && skills/core/device-profile.js';
import type { DeviceProfile } from '../../models && skills/core/device-profile.js';

const GB = 1024 ** 3;
const FULL = 4 * GB;
const QUANT = 1 * GB;
const BIG = 'Design and implement a rate limiter for our API, then write the tests, and finally explain the trade-offs step by step.';

function device(over: Partial<DeviceProfile> = {}): DeviceProfile {
  return { kind: 'desktop', platform: 'linux', cores: 8, totalMemBytes: 32 * GB, freeMemBytes: 24 * GB, load: 0.1, mops: 6000, battery: null, online: true, ...over };
}
const phone = (over: Partial<DeviceProfile> = {}) => device({ kind: 'phone', platform: 'android', cores: 8, totalMemBytes: 6 * GB, freeMemBytes: 3 * GB, load: 0.3, mops: 300, battery: { level: 0.2, charging: false }, ...over });
function input(prompt: string, d: DeviceProfile, remote = true): ChooserInput {
  return { device: d, prompt, remote: { available: remote }, fullModelBytes: FULL, quantizedModelBytes: QUANT };
}
const pick = (prompt: string, d: DeviceProfile, remote = true) => new Chooser().choose(input(prompt, d, remote)).engine;

afterEach(() => { delete process.env.NEUROCLAW_ENGINE; });

describe('choosing an engine', () => {
  it('a weak phone on a low battery hands a big job to the remote computer', () => {
    expect(pick(BIG, phone())).toBe('remote');
  });

  it('...but answers a small question itself with the quantized model', () => {
    expect(pick('what time is it in Tokyo?', phone())).toBe('local-quantized');
  });

  it('a powerful plugged-in computer runs the full model, for big and small alike', () => {
    expect(pick(BIG, device())).toBe('local-full');
    expect(pick('hi', device())).toBe('local-full');
  });

  it('a strong laptop on a nearly flat battery does not start the full model', () => {
    const low = device({ kind: 'laptop', battery: { level: 0.15, charging: false } });
    const c = new Chooser().choose(input(BIG, low));
    expect(c.scores['local-full']).toBeNull();
    expect(c.engine).not.toBe('local-full');
    expect(c.reasons.join(' ')).toMatch(/battery at 15% and unplugged/);
  });

  it('the same laptop on the charger is fine', () => {
    expect(pick(BIG, device({ kind: 'laptop', battery: { level: 0.15, charging: true } }))).toBe('local-full');
  });

  it('rules out the full model when it will not fit in free memory', () => {
    const c = new Chooser().choose(input(BIG, device({ freeMemBytes: 5 * GB }), false));
    expect(c.scores['local-full']).toBeNull();
    expect(c.engine).toBe('local-quantized');
  });

  it('never picks the remote when there is none, or the device is offline', () => {
    expect(pick(BIG, phone(), false)).toBe('local-quantized');
    expect(pick(BIG, phone({ online: false }))).toBe('local-quantized');
  });

  it('keeps anything that looks like a secret off the remote, however big', () => {
    const c = new Chooser().choose(input(BIG + '\npassword: correcthorsebattery', phone()));
    expect(c.scores.remote).toBeNull();
    expect(c.engine).toBe('local-quantized');
    expect(c.reasons.join(' ')).toMatch(/holds a secret/);
  });

  it('still answers when everything is ruled out, with the lightest engine', () => {
    const c = new Chooser().choose(input('hi', device({ freeMemBytes: 0.1 * GB }), false));
    expect(c.engine).toBe('local-quantized');
    expect(c.reasons.join(' ')).toMatch(/lightest engine/);
  });

  it('a strong computer that is only just strong enough, or slow, still prefers the quantized model for small talk', () => {
    expect(pick('hi', device({ mops: 500, freeMemBytes: 8 * GB }))).toBe('local-quantized');
    expect(pick('hi', device({ mops: 1500, freeMemBytes: 16 * GB, battery: { level: 0.9, charging: true } }))).toBe('local-quantized');
  });

  it('treats a speed nobody measured as middling, not fast', () => {
    const measured = new Chooser().choose(input('hi', device({ mops: 6000 }))).features.slow;
    const unknown = new Chooser().choose(input('hi', device({ mops: null }))).features.slow;
    expect(measured).toBe(0);
    expect(unknown).toBe(0.5);
  });

  it('lets NEUROCLAW_ENGINE force an engine that is possible, and ignores one that is not', () => {
    process.env.NEUROCLAW_ENGINE = 'remote';
    expect(pick('hi', device())).toBe('remote');
    expect(pick('hi', device(), false)).toBe('local-full');
  });

  it('explains itself', () => {
    const c = new Chooser().choose(input(BIG, device()));
    expect(c.reasons.at(-1)).toBe('chose local-full');
    expect(c.reasons.join(' ')).toMatch(/build, analysis or write-up/);
  });
});

describe('job size', () => {
  it('is small for chat and big for work', () => {
    expect(taskSize('hi').size).toBe(0);
    expect(taskSize(BIG).size).toBeGreaterThanOrEqual(3);
    expect(taskSize('Why does this fail?\n```js\n' + 'const x = 1;\n'.repeat(60) + '```').size).toBeGreaterThanOrEqual(4);
  });
  it('counts a long conversation', () => {
    expect(taskSize('and review that', 5000).size).toBeGreaterThan(taskSize('and review that', 0).size);
  });
});

describe('secrets', () => {
  it('catches keys, tokens and passwords but not talk about them', () => {
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe(true);
    expect(looksLikeSecret('key AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksLikeSecret('use sk-abcdefghijklmnop1234')).toBe(true);
    expect(looksLikeSecret('api_key = abcd1234efgh')).toBe(true);
    expect(looksLikeSecret('How do I reset my password?')).toBe(false);
  });
});

describe('learning', () => {
  it('learns that an engine that keeps failing in these conditions is worse', () => {
    const c = new Chooser();
    const i = input(BIG, phone());
    const before = c.choose(i);
    expect(before.engine).toBe('remote');
    for (let n = 0; n < 40; n++) c.learn('remote', before.features, rewardFor({ ok: false, ms: 5000 }));
    const after = c.choose(i);
    expect(after.scores.remote as number).toBeLessThan(before.scores.remote as number);
    expect(after.engine).toBe('local-quantized');
  });

  it('learns that a fast local answer is worth repeating', () => {
    const c = new Chooser();
    const i = input('hi', phone());
    const f = c.choose(i).features;
    const before = c.choose(i).scores['local-quantized'] as number;
    for (let n = 0; n < 20; n++) c.learn('local-quantized', f, rewardFor({ ok: true, ms: 300 }));
    expect(c.choose(i).scores['local-quantized'] as number).toBeGreaterThan(before);
  });

  it('keeps weights within bounds however long it learns', () => {
    const c = new Chooser();
    const f = c.choose(input(BIG, phone())).features;
    for (let n = 0; n < 2000; n++) c.learn('remote', f, n % 2 ? 1 : -1);
    for (const w of c.weights.remote) expect(Math.abs(w)).toBeLessThanOrEqual(2);
  });

  it('rewards by speed and punishes failure', () => {
    expect(rewardFor({ ok: false, ms: 10 })).toBe(-1);
    expect(rewardFor({ ok: true, ms: 0 })).toBe(1);
    expect(rewardFor({ ok: true, ms: 15000 })).toBe(0.5);
    expect(rewardFor({ ok: true, ms: 10 ** 9 })).toBe(-0.5);
  });
});

describe('saved weights', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'chooser-')); dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

  it('round-trips what it learned', () => {
    const file = path.join(tmp(), 'chooser.json');
    const c = new Chooser();
    c.learn('remote', c.choose(input(BIG, phone())).features, -1);
    expect(saveChooser(c, file)).toEqual({ ok: true, error: null });
    expect(loadChooser(file).weights).toEqual(c.weights);
    expect(c.weights.remote).not.toEqual(SEED_WEIGHTS.remote);
  });

  it('starts from the seed when there is no file, a damaged file, or a wrong shape', () => {
    const dir = tmp();
    expect(loadChooser(path.join(dir, 'none.json')).weights).toEqual(SEED_WEIGHTS);
    writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(loadChooser(path.join(dir, 'bad.json')).weights).toEqual(SEED_WEIGHTS);
    writeFileSync(path.join(dir, 'odd.json'), JSON.stringify({ weights: { remote: [1, 2], 'local-full': ['x', 1, 1, 1, 1, 1] } }));
    expect(loadChooser(path.join(dir, 'odd.json')).weights).toEqual(SEED_WEIGHTS);
  });

  it('reports a save that failed instead of throwing', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'blocker'), 'x');
    const r = saveChooser(new Chooser(), path.join(dir, 'blocker', 'chooser.json'));
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('has one weight per feature for every engine', () => {
    for (const w of Object.values(SEED_WEIGHTS)) expect(w).toHaveLength(FEATURE_NAMES.length);
  });
});

describe('reading the device', () => {
  it('parses Linux, macOS and Windows battery answers', () => {
    expect(parseLinuxBattery([{ capacity: '87\n', status: 'Discharging\n' }])).toEqual({ level: 0.87, charging: false });
    expect(parseLinuxBattery([{ capacity: '40', status: 'Charging' }])).toEqual({ level: 0.4, charging: true });
    expect(parseLinuxBattery([])).toBeNull();
    const mac = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t62%; discharging; 3:10 remaining present: true";
    expect(parsePmset(mac)).toEqual({ level: 0.62, charging: false });
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 0:42 remaining present: true")).toEqual({ level: 0.8, charging: true });
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull();
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":55,"BatteryStatus":1}')).toEqual({ level: 0.55, charging: false });
    expect(parseWindowsBattery('[{"EstimatedChargeRemaining":90,"BatteryStatus":2}]')).toEqual({ level: 0.9, charging: true });
    expect(parseWindowsBattery('')).toBeNull();
    expect(parseWindowsBattery('garbage')).toBeNull();
  });

  const readers = (over = {}) => ({
    platform: () => 'linux', cores: () => 4, totalMem: () => 8 * GB, freeMem: () => 4 * GB, loadAvg1: () => 2,
    battery: async () => null, ...over,
  });

  it('builds a profile from the readers, with load per core', async () => {
    const p = await probeDevice({ readers: readers(), mops: 1234 });
    expect(p).toMatchObject({ kind: 'desktop', cores: 4, load: 0.5, mops: 1234, battery: null, online: null });
  });

  it('calls a battery-powered computer a laptop and an android one a phone', async () => {
    expect((await probeDevice({ readers: readers({ battery: async () => ({ level: 0.5, charging: false }) }) })).kind).toBe('laptop');
    expect((await probeDevice({ readers: readers({ platform: () => 'android' }) })).kind).toBe('phone');
  });

  it('lets a client override what it knows better, and survives a battery reader that throws', async () => {
    const p = await probeDevice({ readers: readers({ battery: async () => { throw new Error('x'); } }), overrides: { kind: 'phone', online: false, battery: { level: 0.1, charging: false } } });
    expect(p).toMatchObject({ kind: 'phone', online: false, battery: { level: 0.1, charging: false } });
  });

  it('reads the real machine without throwing', async () => {
    const p = await probeDevice();
    expect(p.cores).toBeGreaterThanOrEqual(1);
    expect(p.totalMemBytes).toBeGreaterThan(0);
  });
});
