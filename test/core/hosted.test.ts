import { describe, it, expect } from 'vitest';
import { HostedService, HostedError, DEFAULT_HOSTED_SETTINGS, TOKEN_PREFIX, isHostedToken } from '../../models && skills/core/hosted.js';
import type { HostedDeps } from '../../models && skills/core/hosted.js';
import { VaultError } from '../../models && skills/core/vault.js';

/** An in-memory stand-in for the vault, with switches for the two ways a real one fails. */
function fakeVault() {
  const v = {
    data: { v: 1, settings: { ...DEFAULT_HOSTED_SETTINGS, enabled: true }, accounts: {} } as any,
    failRead: false, failWrite: false, writes: 0,
    read() { if (v.failRead) throw new VaultError('The vault could not be opened: wrong passphrase, or the file was changed. Nothing was read.'); return JSON.parse(JSON.stringify(v.data)); },
    write(d: any) { if (v.failWrite) throw new VaultError('The vault could not be saved: disk full'); v.writes++; v.data = JSON.parse(JSON.stringify(d)); },
  };
  return v;
}

function setup(over: { settings?: Partial<typeof DEFAULT_HOSTED_SETTINGS>; mops?: number; active?: (id: string) => boolean; realTime?: boolean } = {}) {
  const vault = fakeVault();
  Object.assign(vault.data.settings, over.settings ?? {});
  const clock = { t: Date.UTC(2026, 10, 13, 12, 0, 0) };
  const deps: HostedDeps = {
    vault, userActive: over.active ?? (() => true),
    now: over.realTime ? Date.now : () => clock.t,
    mops: () => over.mops ?? 1000,
  };
  const svc = new HostedService(deps);
  /** A runner that takes `ms` of the fake clock and answers. */
  const answer = (ms = 2000, text = 'the answer') => ({ chat: async () => { clock.t += ms; return text; } });
  return { svc, vault, clock, answer };
}

const status = async (p: Promise<unknown>): Promise<number | null> => { try { await p; return null; } catch (e) { return (e as HostedError).status ?? -1; } };

describe('tokens', () => {
  it('makes a token, shows it once, and stores only its hash', () => {
    const { svc, vault } = setup();
    const { token, record } = svc.createToken('u1', 'my phone');
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(isHostedToken(token)).toBe(true);
    expect(record.label).toBe('my phone');
    expect(JSON.stringify(vault.data)).not.toContain(token);
    expect(JSON.stringify(svc.listTokens('u1'))).not.toContain('hash');
    expect(svc.listTokens('u1')).toHaveLength(1);
  });

  it('limits how many an account may hold, and frees a place when one is revoked', () => {
    const { svc } = setup({ settings: { maxTokensPerAccount: 2 } });
    const a = svc.createToken('u1', 'a');
    svc.createToken('u1', 'b');
    expect(() => svc.createToken('u1', 'c')).toThrow();
    expect(svc.revokeToken('u1', a.record.id)).toBe(true);
    expect(svc.revokeToken('u1', a.record.id)).toBe(false);
    expect(() => svc.createToken('u1', 'c')).not.toThrow();
  });

  it('will not make tokens for an account that is disabled or gone', () => {
    const { svc } = setup({ active: () => false });
    expect(() => svc.createToken('u1', 'x')).toThrow();
  });

  it('keeps one account from seeing or revoking another\'s tokens', () => {
    const { svc } = setup();
    const a = svc.createToken('u1', 'a');
    expect(svc.listTokens('u2')).toHaveLength(0);
    expect(svc.revokeToken('u2', a.record.id)).toBe(false);
  });
});

describe('running a job', () => {
  it('runs the full engine for a token holder and meters it in compute units', async () => {
    const { svc, answer } = setup({ settings: { dailyCu: 30 } });
    const { token } = svc.createToken('u1', 't');
    const r = await svc.run(token, 'hello there', answer(2000));
    expect(r).toMatchObject({ result: 'the answer', cu: 0, hosted: true, usedCu: 2, remainingCu: 28 });
    expect(svc.usage('u1')).toMatchObject({ usedCu: 2, remainingCu: 28, jobs: 1 });
  });

  it('answers a borrower\'s offer check with what is left of today', () => {
    const { svc } = setup({ settings: { dailyCu: 30 } });
    const { token } = svc.createToken('u1', 't');
    expect(svc.offer(token)).toEqual({ remainingCu: 30, pointsPerCu: 0, forSaleCu: null, hosted: true });
  });

  it('is off until the admin turns it on', async () => {
    const { svc, answer } = setup({ settings: { enabled: false } });
    const { token } = svc.createToken('u1', 't');
    expect(await status(svc.run(token, 'hi', answer()))).toBe(403);
    expect(() => svc.offer(token)).toThrow();
  });

  it('gives the same 401 for an unknown, malformed or revoked token', async () => {
    const { svc, answer } = setup();
    const { token, record } = svc.createToken('u1', 't');
    svc.revokeToken('u1', record.id);
    const msgs = new Set<string>();
    for (const t of ['nch_nonsense', 'lease-token-from-somewhere', '', null, token]) {
      try { await svc.run(t as string, 'hi', answer()); } catch (e) { msgs.add(`${(e as HostedError).status} ${(e as HostedError).message}`); }
    }
    expect([...msgs]).toEqual(['401 Unknown token.']);
  });

  it('refuses a disabled account even with a good token', async () => {
    let active = true;
    const { svc, answer } = setup({ active: () => active });
    const { token } = svc.createToken('u1', 't');
    active = false;
    expect(await status(svc.run(token, 'hi', answer()))).toBe(403);
  });

  it('refuses an empty, missing or oversized prompt', async () => {
    const { svc, answer } = setup({ settings: { maxPromptChars: 100 } });
    const { token } = svc.createToken('u1', 't');
    for (const p of ['', '   ', undefined, 42, 'x'.repeat(101)]) expect(await status(svc.run(token, p, answer())), String(p)).toBe(400);
    expect(await status(svc.run(token, 'x'.repeat(100), answer()))).toBe(null);
  });

  it('rate-limits per account, and a minute later it is open again', async () => {
    const { svc, clock, answer } = setup({ settings: { perMinute: 2 } });
    const a = svc.createToken('u1', 't').token;
    const b = svc.createToken('u2', 't').token;
    await svc.run(a, 'one', answer(10));
    await svc.run(a, 'two', answer(10));
    expect(await status(svc.run(a, 'three', answer(10)))).toBe(429);
    expect(await status(svc.run(b, 'someone else is fine', answer(10)))).toBe(null);
    clock.t += 61_000;
    expect(await status(svc.run(a, 'again', answer(10)))).toBe(null);
  });

  it('stops an account at its daily compute, and starts it again at the next UTC day', async () => {
    const { svc, clock, answer } = setup({ settings: { dailyCu: 3, perMinute: 100 } });
    const { token } = svc.createToken('u1', 't');
    const first = await svc.run(token, 'big job', answer(5000)); // costs 5 CU but only 3 are left to charge
    expect(first.usedCu).toBe(3);
    expect(first.remainingCu).toBe(0);
    expect(await status(svc.run(token, 'more', answer(10)))).toBe(429);
    clock.t = Date.UTC(2026, 10, 14, 0, 0, 1);
    expect(svc.usage('u1').usedCu).toBe(0);
    expect(await status(svc.run(token, 'a new day', answer(10)))).toBe(null);
  });

  it('charges for a job that failed, and says so', async () => {
    const { svc, clock } = setup();
    const { token } = svc.createToken('u1', 't');
    const boom = { chat: async () => { clock.t += 3000; throw new Error('the engine fell over'); } };
    expect(await status(svc.run(token, 'x', boom))).toBe(500);
    expect(svc.usage('u1').usedCu).toBe(3);
  });

  it('lets a few jobs run at once, queues a few, and turns the rest away', async () => {
    const { svc } = setup({ settings: { maxConcurrent: 1, maxQueue: 1, perMinute: 100 } });
    const { token } = svc.createToken('u1', 't');
    const releases: Array<() => void> = [];
    const held = (label: string) => ({ chat: () => new Promise<string>(res => { releases.push(() => res(label)); }) });
    const first = svc.run(token, 'a', held('first'));
    await Promise.resolve(); await Promise.resolve();
    const second = svc.run(token, 'b', held('second')); // waits for the slot
    await Promise.resolve(); await Promise.resolve();
    expect(await status(svc.run(token, 'c', held('third')))).toBe(429); // queue full
    expect(releases).toHaveLength(1);
    releases[0]();
    expect((await first).result).toBe('first');
    await new Promise(r => setTimeout(r, 5));
    expect(releases).toHaveLength(2);
    releases[1]();
    expect((await second).result).toBe('second');
  });

  it('keeps a timed-out job\'s slot until the engine is really done with it', async () => {
    const { svc } = setup({ realTime: true, mops: 1000, settings: { dailyCu: 0.1, maxConcurrent: 1, maxQueue: 0, perMinute: 100 } });
    const a = svc.createToken('u1', 't').token;
    const b = svc.createToken('u2', 't').token;
    let finish: () => void = () => undefined;
    const stuck = { chat: () => new Promise<string>(res => { finish = () => res('late'); }) };
    expect(await status(svc.run(a, 'hangs', stuck))).toBe(408); // budget is 100ms
    const quick = { chat: async () => 'quick' };
    expect(await status(svc.run(b, 'still busy', quick))).toBe(429);
    finish();
    await new Promise(r => setTimeout(r, 5));
    expect(await status(svc.run(b, 'free now', quick))).toBe(null);
  });
});

describe('guessing tokens', () => {
  it('blocks an address after too many unknown tokens, even for a good one, and forgives after the window', async () => {
    const { svc, clock, answer } = setup({ settings: { perMinute: 100 } });
    const { token } = svc.createToken('u1', 't');
    for (let i = 0; i < 20; i++) expect(await status(svc.run('nch_guess' + i, 'x', answer(), '9.9.9.9'))).toBe(401);
    expect(await status(svc.run(token, 'hi', answer(), '9.9.9.9'))).toBe(429);
    expect(await status(svc.run(token, 'hi', answer(10), '1.2.3.4'))).toBe(null);
    clock.t += 11 * 60_000;
    expect(await status(svc.run(token, 'hi', answer(10), '9.9.9.9'))).toBe(null);
  });
});

describe('failing closed', () => {
  it('with no vault (no passphrase) refuses everything and says why', async () => {
    const svc = new HostedService({ vault: null, lockedReason: 'needs NEUROCLAW_VAULT_PASSPHRASE', userActive: () => true, now: Date.now, mops: () => 1000 });
    expect(svc.status()).toMatchObject({ available: false, enabled: false });
    expect(svc.status().reason).toMatch(/NEUROCLAW_VAULT_PASSPHRASE/);
    expect(await status(svc.run('nch_x', 'hi', { chat: async () => 'no' }))).toBe(503);
    expect(() => svc.createToken('u1', 'x')).toThrow();
  });

  it('with a vault that will not open (wrong passphrase, changed file) refuses everything and does not start fresh', async () => {
    const { svc, vault } = setup();
    vault.failRead = true;
    expect(svc.status().available).toBe(false);
    expect(await status(svc.run('nch_x', 'hi', { chat: async () => 'no' }))).toBe(503);
    expect(vault.writes).toBe(0);
  });

  it('does not retry a vault that failed to open on every request', () => {
    const { svc, vault } = setup();
    let reads = 0;
    const orig = vault.read.bind(vault);
    vault.read = () => { reads++; return orig(); };
    vault.failRead = true;
    for (let i = 0; i < 5; i++) svc.status();
    expect(reads).toBe(1);
  });

  it('stops taking jobs while it cannot save the record of usage, and resumes once it can', async () => {
    const { svc, vault, answer } = setup({ settings: { perMinute: 100 } });
    const { token } = svc.createToken('u1', 't');
    vault.failWrite = true;
    // This job still gets its answer; its charge just cannot be saved yet.
    expect((await svc.run(token, 'one', answer(100))).result).toBe('the answer');
    expect(await status(svc.run(token, 'two', answer(100)))).toBe(503);
    vault.failWrite = false;
    expect(await status(svc.run(token, 'three', answer(100)))).toBe(null);
    expect(vault.data.accounts.u1.jobs).toBe(2);
  });

  it('survives a restart: tokens and the day\'s usage come back from the vault', async () => {
    const a = setup({ settings: { dailyCu: 30 } });
    const { token } = a.svc.createToken('u1', 't');
    await a.svc.run(token, 'hi', a.answer(4000));
    const restarted = new HostedService({ vault: a.vault, userActive: () => true, now: () => a.clock.t, mops: () => 1000 });
    expect(restarted.usage('u1')).toMatchObject({ usedCu: 4, remainingCu: 26, jobs: 1 });
    expect(restarted.offer(token).remainingCu).toBe(26);
  });

  it('treats damaged numbers in the vault as defaults, not as unlimited', () => {
    const a = setup();
    a.vault.data.settings = { enabled: true, dailyCu: 'lots', perMinute: -5, maxConcurrent: null, maxQueue: 1e9, maxPromptChars: 'x', maxTokensPerAccount: 0 };
    const s = a.svc.settings();
    expect(s.dailyCu).toBe(DEFAULT_HOSTED_SETTINGS.dailyCu);
    expect(s.perMinute).toBe(1);
    expect(s.maxQueue).toBe(100);
    expect(s.maxTokensPerAccount).toBe(1);
    expect(s.maxPromptChars).toBe(DEFAULT_HOSTED_SETTINGS.maxPromptChars);
  });
});

describe('settings and accounts', () => {
  it('validates changes and saves them', () => {
    const { svc, vault } = setup();
    expect(svc.setSettings({ dailyCu: 50, perMinute: 5, enabled: false })).toMatchObject({ dailyCu: 50, perMinute: 5, enabled: false });
    expect(vault.data.settings.dailyCu).toBe(50);
    for (const bad of [{ dailyCu: -1 }, { dailyCu: 'many' }, { perMinute: 0 }, { maxConcurrent: 99 }, { enabled: 'yes' }, { surprise: 1 }, null, [1]]) {
      expect(() => svc.setSettings(bad), JSON.stringify(bad)).toThrow();
    }
    expect(svc.settings().dailyCu).toBe(50);
  });

  it('forgets an account\'s tokens and usage when it is deleted', async () => {
    const { svc, answer } = setup();
    const { token } = svc.createToken('u1', 't');
    svc.forgetAccount('u1');
    expect(await status(svc.run(token, 'hi', answer()))).toBe(401);
    expect(svc.listTokens('u1')).toHaveLength(0);
  });
});
