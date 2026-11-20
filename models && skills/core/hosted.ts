/**
 * Hosted mode: this computer runs the full AI for other people, each with an
 * account, so a phone or a laptop elsewhere (see engine-chooser.ts) can hand
 * its big jobs here.
 *
 * It sits on what already exists. People sign up through accounts.ts. Each
 * account can make tokens (up to a few) and give one to its own NeuroClaw as a
 * peer: that app already speaks to `/api/corona/v1/compute/run` with a bearer
 * token (compute-share.ts borrow()), so nothing on the client changes. A hosted
 * token starts with "nch_"; the route hands those to this file and every other
 * token to the lease code as before.
 *
 * ── What a guest gets, and what they cannot do ─────────────────────────
 *
 * Text answers from the full engine and nothing else. The route runs the job
 * through the text-only path (never a plugin, a tool, a file or the desktop),
 * so the owner's computer is not what a stranger's prompt can reach.
 *
 * ── The limits, whichever hits first ───────────────────────────────────
 *
 *   daily compute   each account has `dailyCu` Compute Units a UTC day (a CU is
 *                   work, not clock time: compute-share.ts), reset at 00:00 UTC.
 *   request rate    `perMinute` jobs a minute per account.
 *   concurrency     `maxConcurrent` jobs at once on this computer; up to
 *                   `maxQueue` more wait their turn; beyond that, 429 at once.
 *                   A job that outlives its time budget is abandoned, not
 *                   killed (JavaScript cannot), so its slot is freed only when
 *                   it really finishes, never earlier.
 *   bad tokens      20 unknown tokens in ten minutes from one address, and that
 *                   address is refused for the rest of the window.
 *   job size        prompts are capped, and one job gets at most two minutes.
 *
 * ── Stored encrypted, and fails closed ─────────────────────────────────
 *
 * Token hashes, usage and the limits live in an encrypted vault (vault.ts), key
 * from NEUROCLAW_VAULT_PASSPHRASE. No passphrase, or a vault that will not open,
 * means hosted mode refuses every request; it never runs unmetered. A token is
 * shown once when made and only its SHA-256 is stored. If a save fails, new jobs
 * are refused until a save works, so a failing disk cannot be used to dodge the
 * quota.
 *
 * ── Said plainly ───────────────────────────────────────────────────────
 *
 *   - The machine that runs a job can read it. Say so wherever hosting is offered.
 *   - Everyone talks to the same brain. accounts.ts's learnFromUsers is off by
 *     default and the guest path does not learn, but what the brain already knows
 *     is shared.
 *   - Counters for rate and for bad tokens are in memory and restart with the
 *     server. The daily compute used is saved.
 *   - Addresses are the socket's own. Behind a reverse proxy every guest shares
 *     the proxy's address; this does not trust forwarded headers.
 */

import crypto from "node:crypto";
import path from "node:path";
import { computeUnits, machineMops, REFERENCE_MOPS } from "./compute-share.js";
import { baseDir } from "./user-context.js";
import { Vault, VaultError } from "./vault.js";

export class HostedError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

export const TOKEN_PREFIX = "nch_";
export const isHostedToken = (token: string | null): token is string => typeof token === "string" && token.startsWith(TOKEN_PREFIX);

const MAX_JOB_MS = 120_000;
const MAX_LABEL = 40;
const BAD_TOKEN_LIMIT = 20;
const BAD_TOKEN_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;

export interface HostedSettings {
  enabled: boolean;
  dailyCu: number;
  perMinute: number;
  maxConcurrent: number;
  maxQueue: number;
  maxPromptChars: number;
  maxTokensPerAccount: number;
}

export const DEFAULT_HOSTED_SETTINGS: HostedSettings = {
  enabled: false, dailyCu: 30, perMinute: 10, maxConcurrent: 2, maxQueue: 8, maxPromptChars: 16_000, maxTokensPerAccount: 5,
};

/** Each limit's allowed range: a typo cannot turn a limit into "none" or into something absurd. */
const BOUNDS: Record<Exclude<keyof HostedSettings, "enabled">, [number, number]> = {
  dailyCu: [0, 100_000], perMinute: [1, 600], maxConcurrent: [1, 16], maxQueue: [0, 100], maxPromptChars: [100, 64_000], maxTokensPerAccount: [1, 20],
};

interface TokenRecord { id: string; label: string; hash: string; createdAt: number; revokedAt: number | null }
interface AccountRecord { tokens: TokenRecord[]; day: string; usedCu: number; jobs: number }
interface HostedData { v: 1; settings: HostedSettings; accounts: Record<string, AccountRecord> }
export type PublicToken = Omit<TokenRecord, "hash">;

const emptyData = (): HostedData => ({ v: 1, settings: { ...DEFAULT_HOSTED_SETTINGS }, accounts: {} });
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface HostedDeps {
  vault: { read(): HostedData; write(d: HostedData): void } | null;
  /** Why there is no vault, when there is none (shown to the admin). */
  lockedReason?: string;
  /** Whether an account exists and is not disabled. */
  userActive(userId: string): boolean;
  now(): number;
  mops(): number;
}

export interface HostedJobResult {
  result: string;
  /** Always 0 here: a hosted guest is limited by its account's daily quota, not by a ledger on its own computer. */
  cu: 0;
  /** What this job used of the account's day. */
  usedCu: number;
  remainingCu: number;
  mops: number;
  hosted: true;
}

export class HostedService {
  private data: HostedData | null = null;
  /** A vault that would not open, remembered briefly so asking again does not repeat the key derivation. */
  private failure: { at: number; error: HostedError } | null = null;
  private index = new Map<string, { userId: string; tokenId: string }>();
  private dirty = false;
  private active = 0;
  private waiting: Array<() => void> = [];
  private windows = new Map<string, number[]>();
  private bad = new Map<string, number[]>();

  constructor(private readonly deps: HostedDeps) {}

  /* ----------------------------------------------------------- state */

  private load(): HostedData {
    if (this.data) return this.data;
    if (!this.deps.vault) throw new HostedError(this.deps.lockedReason ?? "Hosted mode is locked.", 503);
    if (this.failure && this.deps.now() - this.failure.at < 30_000) throw this.failure.error;
    let d: HostedData;
    try {
      d = this.deps.vault.read();
    } catch (e) {
      const error = new HostedError(e instanceof VaultError ? e.message : "The hosted vault could not be opened.", 503);
      this.failure = { at: this.deps.now(), error };
      throw error;
    }
    this.failure = null;
    // Read what is there and keep only what is valid: a missing field is a default, never a bypass.
    const base = emptyData();
    const s = (d && typeof d === "object" ? d.settings : null) ?? {};
    const settings: HostedSettings = { ...base.settings, enabled: (s as HostedSettings).enabled === true };
    for (const k of Object.keys(BOUNDS) as Array<keyof typeof BOUNDS>) {
      const v = Number((s as Record<string, unknown>)[k]);
      settings[k] = Number.isFinite(v) ? Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], v)) : base.settings[k];
    }
    const accounts: Record<string, AccountRecord> = {};
    for (const [id, a] of Object.entries(d?.accounts ?? {})) {
      if (!a || !Array.isArray(a.tokens)) continue;
      accounts[id] = {
        tokens: a.tokens.filter(t => t && typeof t.hash === "string" && typeof t.id === "string").map(t => ({
          id: t.id, label: String(t.label ?? "").slice(0, MAX_LABEL), hash: t.hash, createdAt: Number(t.createdAt) || 0, revokedAt: typeof t.revokedAt === "number" ? t.revokedAt : null,
        })),
        day: typeof a.day === "string" ? a.day : "",
        usedCu: Math.max(0, Number(a.usedCu) || 0),
        jobs: Math.max(0, Number(a.jobs) || 0),
      };
    }
    this.data = { v: 1, settings, accounts };
    this.reindex();
    return this.data;
  }

  private reindex(): void {
    this.index.clear();
    for (const [userId, a] of Object.entries(this.data?.accounts ?? {})) {
      for (const t of a.tokens) if (t.revokedAt === null) this.index.set(t.hash, { userId, tokenId: t.id });
    }
  }

  private save(): void {
    if (!this.deps.vault || !this.data) throw new HostedError(this.deps.lockedReason ?? "Hosted mode is locked.", 503);
    try {
      this.deps.vault.write(this.data);
      this.dirty = false;
    } catch (e) {
      this.dirty = true;
      throw new HostedError(e instanceof VaultError ? e.message : "The hosted vault could not be saved.", 503);
    }
  }

  private account(userId: string): AccountRecord {
    const d = this.load();
    return (d.accounts[userId] ??= { tokens: [], day: dayOf(this.deps.now()), usedCu: 0, jobs: 0 });
  }

  private rollDay(a: AccountRecord): void {
    const today = dayOf(this.deps.now());
    if (a.day !== today) { a.day = today; a.usedCu = 0; a.jobs = 0; }
  }

  /* -------------------------------------------------- admin and accounts */

  /** What anyone may be told. Never throws: a locked server just says so. */
  status(): { available: boolean; enabled: boolean; reason: string | null; settings: HostedSettings | null } {
    try {
      const d = this.load();
      return { available: true, enabled: d.settings.enabled, reason: null, settings: { ...d.settings } };
    } catch (e) {
      return { available: false, enabled: false, reason: e instanceof Error ? e.message : String(e), settings: null };
    }
  }

  settings(): HostedSettings { return { ...this.load().settings }; }

  /** Admin only (the route checks). Unknown fields are refused; numbers are held inside their bounds. */
  setSettings(patch: unknown): HostedSettings {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HostedError("Send a JSON object of settings to change.");
    const d = this.load();
    const next = { ...d.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "enabled") {
        if (typeof v !== "boolean") throw new HostedError("enabled must be true or false.");
        next.enabled = v;
      } else if (k in BOUNDS) {
        const n = Number(v);
        const [lo, hi] = BOUNDS[k as keyof typeof BOUNDS];
        if (!Number.isFinite(n) || n < lo || n > hi) throw new HostedError(`${k} must be a number from ${lo} to ${hi}.`);
        (next as unknown as Record<string, number>)[k] = k === "dailyCu" ? n : Math.floor(n);
      } else {
        throw new HostedError(`Unknown setting "${k}".`);
      }
    }
    d.settings = next;
    this.save();
    return { ...next };
  }

  createToken(userId: string, label: string): { token: string; record: PublicToken } {
    const d = this.load();
    if (!this.deps.userActive(userId)) throw new HostedError("This account cannot make tokens.", 403);
    const a = this.account(userId);
    const live = a.tokens.filter(t => t.revokedAt === null);
    if (live.length >= d.settings.maxTokensPerAccount) throw new HostedError(`An account may hold ${d.settings.maxTokensPerAccount} tokens. Revoke one first.`, 409);
    const clean = String(label ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, MAX_LABEL) || "token";
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const rec: TokenRecord = { id: crypto.randomBytes(8).toString("hex"), label: clean, hash: sha256(token), createdAt: this.deps.now(), revokedAt: null };
    a.tokens.push(rec);
    try { this.save(); } catch (e) { a.tokens.pop(); throw e; }
    this.reindex();
    const { hash: _hash, ...pub } = rec;
    return { token, record: pub };
  }

  listTokens(userId: string): PublicToken[] {
    return this.account(userId).tokens.map(({ hash: _h, ...pub }) => pub);
  }

  revokeToken(userId: string, tokenId: string): boolean {
    const t = this.account(userId).tokens.find(x => x.id === tokenId && x.revokedAt === null);
    if (!t) return false;
    t.revokedAt = this.deps.now();
    this.save();
    this.reindex();
    return true;
  }

  usage(userId: string): { day: string; usedCu: number; remainingCu: number; dailyCu: number; jobs: number } {
    const d = this.load();
    const a = this.account(userId);
    this.rollDay(a);
    return { day: a.day, usedCu: round(a.usedCu), remainingCu: round(Math.max(0, d.settings.dailyCu - a.usedCu)), dailyCu: d.settings.dailyCu, jobs: a.jobs };
  }

  /** When an account is deleted, its tokens and usage go too. */
  forgetAccount(userId: string): void {
    const d = this.load();
    if (d.accounts[userId]) { delete d.accounts[userId]; this.save(); this.reindex(); }
  }

  /* ------------------------------------------------------------ guests */

  private noteBad(ip: string): void {
    if (this.bad.size > MAX_TRACKED) this.bad.clear();
    const now = this.deps.now();
    const list = (this.bad.get(ip) ?? []).filter(t => now - t < BAD_TOKEN_WINDOW_MS);
    list.push(now);
    this.bad.set(ip, list);
  }

  private blocked(ip: string): boolean {
    const now = this.deps.now();
    return (this.bad.get(ip) ?? []).filter(t => now - t < BAD_TOKEN_WINDOW_MS).length >= BAD_TOKEN_LIMIT;
  }

  /** Who a token belongs to, or the same 401 for every kind of wrong. */
  private authenticate(token: string | null, ip: string): { userId: string } {
    if (this.blocked(ip)) throw new HostedError("Too many unknown tokens from this address. Try again later.", 429);
    const hit = isHostedToken(token) ? this.index.get(sha256(token)) : undefined;
    if (!hit) { this.noteBad(ip); throw new HostedError("Unknown token.", 401); }
    return { userId: hit.userId };
  }

  /** What a borrower asks before a job: how much of today is left. Same checks as a job, without running one. */
  offer(token: string | null, ip = "?"): { remainingCu: number; pointsPerCu: 0; forSaleCu: null; hosted: true } {
    const d = this.load();
    if (!d.settings.enabled) throw new HostedError("This computer is not hosting right now.", 403);
    const { userId } = this.authenticate(token, ip);
    if (!this.deps.userActive(userId)) throw new HostedError("This account is disabled.", 403);
    return { remainingCu: this.usage(userId).remainingCu, pointsPerCu: 0, forSaleCu: null, hosted: true };
  }

  private async takeSlot(max: number, maxQueue: number): Promise<void> {
    if (this.active < max) { this.active++; return; }
    if (this.waiting.length >= maxQueue) throw new HostedError("This computer is busy. Try again shortly.", 429);
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private freeSlot(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight on; `active` stays as it is
    else this.active = Math.max(0, this.active - 1);
  }

  async run(token: string | null, prompt: unknown, runner: { chat(prompt: string): Promise<string> }, ip = "?"): Promise<HostedJobResult> {
    const d = this.load();
    if (!d.settings.enabled) throw new HostedError("This computer is not hosting right now.", 403);
    const { userId } = this.authenticate(token, ip);
    if (!this.deps.userActive(userId)) throw new HostedError("This account is disabled.", 403);
    if (this.dirty) this.save(); // refuses (503) while the record of usage cannot be kept
    const s = d.settings;

    const now = this.deps.now();
    const win = (this.windows.get(userId) ?? []).filter(t => now - t < 60_000);
    if (win.length >= s.perMinute) throw new HostedError(`Too many requests: this account may run ${s.perMinute} a minute.`, 429);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > s.maxPromptChars) {
      throw new HostedError(`A job needs a "prompt" of 1 to ${s.maxPromptChars} characters.`);
    }
    const a = this.account(userId);
    this.rollDay(a);
    const remaining = s.dailyCu - a.usedCu;
    const mops = this.deps.mops();
    const budgetMs = Math.min(MAX_JOB_MS, (remaining / (mops / REFERENCE_MOPS)) * 1000);
    if (remaining <= 0 || budgetMs < 50) throw new HostedError("This account's compute for today is used up. It resets at 00:00 UTC.", 429);

    win.push(now);
    if (this.windows.size > MAX_TRACKED) this.windows.clear();
    this.windows.set(userId, win);

    await this.takeSlot(s.maxConcurrent, s.maxQueue);
    const started = this.deps.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = "";
    let failure: unknown = null;
    // The slot goes back only when the engine is really done, even if the caller gave up on it.
    const job = Promise.resolve().then(() => runner.chat(prompt)).finally(() => this.freeSlot());
    job.catch(() => undefined);
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HostedError("The job ran past the compute it was allowed.", 408)), budgetMs);
      });
      result = await Promise.race([job, timeout]);
    } catch (e) {
      failure = e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Charged whether it finished, failed or timed out: it used the machine.
    const busyMs = Math.min(this.deps.now() - started, budgetMs);
    const fresh = this.account(userId);
    this.rollDay(fresh);
    const charge = Math.min(computeUnits(busyMs, mops), Math.max(0, s.dailyCu - fresh.usedCu));
    fresh.usedCu = round(fresh.usedCu + charge);
    fresh.jobs += 1;
    this.dirty = true;
    try { this.save(); } catch { /* stays dirty: the next job is refused until a save works */ }

    if (failure) {
      if (failure instanceof HostedError) throw failure;
      throw new HostedError(failure instanceof Error ? failure.message : String(failure), 500);
    }
    return { result, cu: 0, usedCu: round(charge), remainingCu: round(Math.max(0, s.dailyCu - fresh.usedCu)), mops, hosted: true };
  }
}

/* ------------------------------------------------------------- the server's own */

let instance: HostedService | null = null;

export function hostedFile(): string {
  return process.env.CORONA_HOSTED_FILE ? path.resolve(process.env.CORONA_HOSTED_FILE) : path.join(baseDir(), "hosted.vault");
}

/**
 * The server's hosted service. Without NEUROCLAW_VAULT_PASSPHRASE there is no
 * vault and every hosted request is refused: there is no unencrypted or
 * unmetered mode to fall back to.
 */
export function getHosted(userActive: (userId: string) => boolean): HostedService {
  if (instance) return instance;
  const pass = process.env.NEUROCLAW_VAULT_PASSPHRASE ?? "";
  let vault: HostedDeps["vault"] = null;
  let lockedReason: string | undefined;
  try {
    vault = new Vault<HostedData>(hostedFile(), pass, "hosted", emptyData);
  } catch (e) {
    lockedReason = pass
      ? (e instanceof Error ? e.message : String(e))
      : "Hosted mode needs NEUROCLAW_VAULT_PASSPHRASE (at least 12 characters) to encrypt its records. It stays off until one is set.";
  }
  instance = new HostedService({ vault, lockedReason, userActive, now: Date.now, mops: () => machineMops() });
  return instance;
}

export function resetHosted(): void {
  instance = null;
}
