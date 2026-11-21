import { describe, it, expect, afterEach } from 'vitest';
import { routeMessage, chooserEnabled } from '../../models && skills/core/engine-router.js';
import type { RouterDeps } from '../../models && skills/core/engine-router.js';
import { Chooser } from '../../models && skills/core/engine-chooser.js';
import type { DeviceProfile } from '../../models && skills/core/device-profile.js';

const GB = 1024 ** 3;
const BIG = 'Design and implement a rate limiter for our API, then write the tests, and finally explain the trade-offs step by step.';
const weakPhone: DeviceProfile = {
  kind: 'phone', platform: 'android', cores: 8, totalMemBytes: 6 * GB, freeMemBytes: 3 * GB, load: 0.3, mops: 300,
  battery: { level: 0.2, charging: false }, online: true,
};
const strongDesktop: DeviceProfile = { ...weakPhone, kind: 'desktop', platform: 'linux', totalMemBytes: 32 * GB, freeMemBytes: 24 * GB, load: 0.1, mops: 6000, battery: null };

function deps(over: Partial<RouterDeps> = {}) {
  const calls = { borrow: [] as Array<[string, string]>, saved: 0 };
  const d: RouterDeps = {
    probe: async () => weakPhone,
    remote: () => ({ available: true, peerId: 'peer1' }),
    borrow: async (id, prompt) => { calls.borrow.push([id, prompt]); return { result: 'the big answer' }; },
    chooser: new Chooser(),
    save: () => { calls.saved++; },
    modelBytes: () => ({ full: 4 * GB, quantized: 1 * GB }),
    now: (() => { let t = 0; return () => (t += 500); })(),
    ...over,
  };
  return { d, calls };
}

afterEach(() => { delete process.env.NEUROCLAW_CHOOSER; });

describe('routeMessage', () => {
  it('sends a big job from a weak phone to the remote computer and returns its answer', async () => {
    const { d, calls } = deps();
    const r = await routeMessage(BIG, [], d);
    expect(r.choice.engine).toBe('remote');
    expect(r.answer).toBe('the big answer');
    expect(calls.borrow).toEqual([['peer1', BIG]]);
    expect(calls.saved).toBe(1);
  });

  it('leaves a small message for the device to answer, and learns from how that went', async () => {
    const { d, calls } = deps();
    const before = [...d.chooser.weights['local-quantized']];
    const r = await routeMessage('hi', [], d);
    expect(r.choice.engine).toBe('local-quantized');
    expect(r.answer).toBeNull();
    expect(calls.borrow).toHaveLength(0);
    r.finish(true, 200);
    expect(d.chooser.weights['local-quantized']).not.toEqual(before);
    expect(calls.saved).toBe(1);
  });

  it('falls back to answering locally when the remote fails, and learns the failure', async () => {
    const { d } = deps({ borrow: async () => { throw new Error('peer down'); } });
    const before = [...d.chooser.weights.remote];
    const r = await routeMessage(BIG, [], d);
    expect(r.answer).toBeNull();
    expect(r.notes.join(' ')).toMatch(/remote computer failed \(peer down\)/);
    expect(d.chooser.weights.remote).not.toEqual(before);
    // The local answer is not credited to the engine that was not chosen.
    const mid = JSON.stringify(d.chooser.weights);
    r.finish(true, 100);
    expect(JSON.stringify(d.chooser.weights)).toBe(mid);
  });

  it('does not use the remote when there is no peer, even for a big job', async () => {
    const { d, calls } = deps({ remote: () => ({ available: true, peerId: null }) });
    const r = await routeMessage(BIG, [], d);
    expect(r.choice.engine).not.toBe('remote');
    expect(calls.borrow).toHaveLength(0);
  });

  it('keeps a message with a secret off the remote', async () => {
    const { d, calls } = deps();
    const r = await routeMessage(BIG + '\npassword: correcthorsebattery', [], d);
    expect(r.answer).toBeNull();
    expect(calls.borrow).toHaveLength(0);
  });

  it('leaves a strong computer to answer for itself', async () => {
    const { d, calls } = deps({ probe: async () => strongDesktop });
    const r = await routeMessage(BIG, [], d);
    expect(r.choice.engine).toBe('local-full');
    expect(r.answer).toBeNull();
    expect(calls.borrow).toHaveLength(0);
  });

  it('answers locally, without throwing, when the device cannot be read', async () => {
    const { d, calls } = deps({ probe: async () => { throw new Error('no sensors'); } });
    const r = await routeMessage(BIG, [], d);
    expect(r.answer).toBeNull();
    expect(r.notes.join(' ')).toMatch(/could not read this device/);
    expect(calls.borrow).toHaveLength(0);
    expect(() => r.finish(true, 1)).not.toThrow();
  });

  it('survives a chooser that cannot save', async () => {
    const { d } = deps({ save: () => { throw new Error('read-only'); } });
    const r = await routeMessage('hi', [], d);
    expect(() => r.finish(true, 100)).not.toThrow();
  });
});

describe('the switch', () => {
  it('is off unless NEUROCLAW_CHOOSER=1', () => {
    expect(chooserEnabled()).toBe(false);
    process.env.NEUROCLAW_CHOOSER = '1';
    expect(chooserEnabled()).toBe(true);
    process.env.NEUROCLAW_CHOOSER = 'true';
    expect(chooserEnabled()).toBe(false);
  });
});
