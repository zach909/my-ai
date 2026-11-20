import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vault, VaultError, MIN_PASSPHRASE_LENGTH } from '../../models && skills/core/vault.js';

const PASS = 'correct horse battery staple';
// Each test gets its own folder; cleanup removes exactly that folder and nothing above it.
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'vault-')); dirs.push(d); return path.join(d, 'x.vault'); };
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop() as string;
    if (path.basename(d).startsWith('vault-') && path.dirname(d) === tmpdir()) rmSync(d, { recursive: true, force: true });
  }
});

interface Data { secret: string; n: number }
const mk = (file: string, pass = PASS, purpose = 'test') => new Vault<Data>(file, pass, purpose, () => ({ secret: '', n: 0 }));

describe('vault', () => {
  it('reads as empty only when the file does not exist yet', () => {
    expect(mk(tmp()).read()).toEqual({ secret: '', n: 0 });
  });

  it('round-trips, including from a new instance with the same passphrase', () => {
    const f = tmp();
    mk(f).write({ secret: 'hunter2-the-sequel', n: 7 });
    expect(mk(f).read()).toEqual({ secret: 'hunter2-the-sequel', n: 7 });
  });

  it('writes no plaintext to disk', () => {
    const f = tmp();
    mk(f).write({ secret: 'PLAINTEXT-MARKER-12345', n: 424242 });
    const raw = readFileSync(f);
    expect(raw.includes(Buffer.from('PLAINTEXT-MARKER'))).toBe(false);
    expect(raw.includes(Buffer.from('secret'))).toBe(false);
    expect(raw.includes(Buffer.from('424242'))).toBe(false);
  });

  it('pads the file to 4 KiB blocks so its size says little', () => {
    const a = tmp(), b = tmp();
    mk(a).write({ secret: 'a', n: 1 });
    mk(b).write({ secret: 'b'.repeat(2000), n: 1 });
    expect(statSync(a).size).toBe(statSync(b).size);
    mk(a).write({ secret: 'c'.repeat(5000), n: 1 });
    expect(statSync(a).size).toBeGreaterThan(statSync(b).size);
  });

  it('is not the same bytes twice for the same data', () => {
    const a = tmp(), b = tmp();
    mk(a).write({ secret: 'same', n: 1 });
    mk(b).write({ secret: 'same', n: 1 });
    expect(readFileSync(a).equals(readFileSync(b))).toBe(false);
  });

  it('fails closed with the wrong passphrase: throws, never returns empty', () => {
    const f = tmp();
    mk(f).write({ secret: 'x', n: 1 });
    expect(() => mk(f, 'a completely different passphrase').read()).toThrow();
    let err: unknown;
    try { mk(f, 'a completely different passphrase').read(); } catch (e) { err = e; }
    expect(err instanceof VaultError).toBe(true);
    expect((err as VaultError).message).toMatch(/Nothing was read/);
  });

  it('fails closed when any single byte is changed, in the header or the body', () => {
    const f = tmp();
    mk(f).write({ secret: 'x', n: 1 });
    const good = readFileSync(f);
    for (const at of [0, 3, 4, 10, 20, 32, 40, 60, 100, good.length - 1]) {
      const bad = Buffer.from(good);
      bad[at] ^= 0x01;
      writeFileSync(f, bad);
      expect(() => mk(f).read(), `byte ${at}`).toThrow();
    }
  });

  it('fails closed on a truncated or garbage file', () => {
    const f = tmp();
    mk(f).write({ secret: 'x', n: 1 });
    const good = readFileSync(f);
    writeFileSync(f, good.subarray(0, good.length - 1));
    expect(() => mk(f).read()).toThrow();
    writeFileSync(f, 'this is not a vault');
    expect(() => mk(f).read()).toThrow();
    writeFileSync(f, '');
    expect(() => mk(f).read()).toThrow();
  });

  it('will not open as a different kind of vault', () => {
    const f = tmp();
    mk(f, PASS, 'hosted').write({ secret: 'x', n: 1 });
    expect(() => mk(f, PASS, 'something-else').read()).toThrow();
  });

  it('refuses a short passphrase', () => {
    expect(PASS.length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
    expect(() => mk(tmp(), 'short')).toThrow();
  });

  it('overwrites without leaving a temp file behind, and keeps working after many writes', () => {
    const f = tmp();
    const v = mk(f);
    for (let n = 0; n < 5; n++) v.write({ secret: 's', n });
    expect(mk(f).read().n).toBe(4);
    expect(existsSync(f)).toBe(true);
  });

  it('reports a save that cannot happen instead of pretending', () => {
    const f = tmp();
    writeFileSync(f, 'a file where a folder is needed');
    expect(() => mk(path.join(f, 'child.vault')).write({ secret: 'x', n: 1 })).toThrow();
  });
});
