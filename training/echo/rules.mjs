/**
 * Rule walks: the "go through every possible tune" engine.
 * Written for this project from scratch (Node built-ins and our own seeded hash only).
 *
 * A domain's rules (music theory, a colour-harmony rule, a phonotactic rule, a grammar...) are written as a
 * small deterministic state machine:
 *
 *   init            the start state (a string)
 *   next(state)     -> [[symbol, nextState], ...]   the moves the rules allow from here (symbol = a byte, 0..255)
 *   accept(state)   -> true if a sample may END in this state
 *
 * A "tune" is one path of exactly `len` symbols from `init` to an accepting state. Because the rules are a finite
 * machine we can, without trying them one by one:
 *
 *   count(len)      how many rule-legal tunes of that length exist (BigInt, can be huge)
 *   enumerate(len)  every one of them, in order
 *   unrank(len, i)  the i-th one, so any tune can be built from just its number
 *   shuffled(len)   every one of them exactly once, in a seeded random order (the randomizer that never repeats)
 *   random(len)     one uniformly random legal tune (the dice, inside the rules)
 *   legalNext(p)    what the rules allow after the prefix p AND can still be finished in `len` symbols
 *
 * The rules make it music (or art, or a sentence); the dice make it different every time; the counting makes sure
 * the dice can be made to visit everything.
 */
import { hash32 } from '../simulation/random.mjs';

const U32 = 0xffffffffn;

export class Walk {
  constructor({ init, next, accept }) {
    this.init = init;
    this._next = next;
    this._accept = accept;
    this._edges = new Map();
    this._memo = new Map();
  }

  /** Allowed moves from a state, sorted by symbol. Rules must be deterministic: a symbol leads to one state. */
  edges(state) {
    let e = this._edges.get(state);
    if (!e) {
      e = this._next(state).slice().sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < e.length; i++) {
        if (e[i][0] === e[i - 1][0]) throw new Error(`rule is not deterministic at "${state}": symbol ${e[i][0]} appears twice`);
      }
      this._edges.set(state, e);
    }
    return e;
  }

  /** Number of ways to go `rem` more symbols from `state` and end in an accepting state. */
  count(rem, state = this.init) {
    if (rem === 0) return this._accept(state) ? 1n : 0n;
    const key = `${rem}|${state}`;
    const hit = this._memo.get(key);
    if (hit !== undefined) return hit;
    let c = 0n;
    for (const [, to] of this.edges(state)) c += this.count(rem - 1, to);
    this._memo.set(key, c);
    return c;
  }

  total(len) {
    return this.count(len);
  }

  /** State after following `prefix`, or null if the prefix breaks a rule. */
  after(prefix) {
    let s = this.init;
    for (const sym of prefix) {
      const e = this.edges(s).find((x) => x[0] === sym);
      if (!e) return null;
      s = e[1];
    }
    return s;
  }

  /** Symbols the rules allow next after `prefix`, keeping only those that can still be finished in `len` symbols. */
  legalNext(prefix, len) {
    const s = this.after(prefix);
    if (s === null || prefix.length >= len) return [];
    const rem = len - prefix.length - 1;
    return this.edges(s).filter(([, to]) => this.count(rem, to) > 0n).map(([sym]) => sym);
  }

  /** True if `tune` has exactly `len` symbols, breaks no rule, and ends where the rules allow. */
  isLegal(tune, len) {
    if (tune.length !== len) return false;
    const s = this.after(tune);
    return s !== null && this._accept(s);
  }

  /** The idx-th legal tune of length `len` (0-based, in symbol order). */
  unrank(len, idx) {
    let i = BigInt(idx);
    if (i < 0n || i >= this.total(len)) throw new RangeError(`tune ${i} of ${this.total(len)}`);
    let s = this.init;
    const out = [];
    for (let r = len; r > 0; r--) {
      for (const [sym, to] of this.edges(s)) {
        const c = this.count(r - 1, to);
        if (i < c) { out.push(sym); s = to; break; }
        i -= c;
      }
    }
    return out;
  }

  /** Every legal tune of length `len`, in symbol order. Only sensible when total(len) is small. */
  *enumerate(len) {
    const self = this;
    const buf = [];
    function* go(state, rem) {
      if (rem === 0) { if (self._accept(state)) yield buf.slice(); return; }
      for (const [sym, to] of self.edges(state)) {
        if (self.count(rem - 1, to) === 0n) continue;
        buf.push(sym);
        yield* go(to, rem - 1);
        buf.pop();
      }
    }
    yield* go(this.init, len);
  }

  /** One uniformly random legal tune. `rng` is a `Rng` from training/simulation/random.mjs. */
  random(len, rng) {
    const n = this.total(len);
    if (n === 0n) throw new Error(`no legal tune of length ${len}`);
    return this.unrank(len, randomBelow(n, rng));
  }

  /** Every legal tune exactly once, in a seeded random order. Lazy: only the tunes you ask for are built. */
  *shuffled(len, seed = 1) {
    const n = this.total(len);
    const p = permutation(n, seed);
    for (let i = 0n; i < n; i++) yield this.unrank(len, p(i));
  }
}

/** Uniform BigInt in [0, n) from the seeded stream. */
export function randomBelow(n, rng) {
  const bits = n.toString(2).length;
  const limbs = Math.ceil(bits / 32);
  const mask = (1n << BigInt(bits)) - 1n;
  for (;;) {
    let x = 0n;
    for (let j = 0; j < limbs; j++) x = (x << 32n) | BigInt(rng.u32());
    x &= mask;
    if (x < n) return x;
  }
}

/**
 * A seeded bijection on [0, n): a Feistel network over the next even power of two, "cycle-walked" back into range.
 * Same seed, same order. Not for secrets; it only has to be a fair shuffle that never repeats or skips.
 */
export function permutation(n, seed = 1) {
  n = BigInt(n);
  if (n <= 1n) return (i) => BigInt(i);
  let bits = (n - 1n).toString(2).length;
  if (bits % 2) bits++;
  const k = BigInt(bits / 2);
  const mask = (1n << k) - 1n;
  const limbs = Math.ceil(Number(k) / 32);
  const F = (round, x) => {
    let f = hash32(seed | 0, round, 0x7f4a);
    for (let y = x; y > 0n; y >>= 32n) f = hash32(f, Number(y & U32), round);
    let out = 0n;
    for (let j = 0; j < limbs; j++) out = (out << 32n) | BigInt(hash32(f, round, j, 0x51));
    return out & mask;
  };
  const enc = (x) => {
    let l = x >> k;
    let r = x & mask;
    for (let round = 0; round < 6; round++) [l, r] = [r, l ^ F(round, r)];
    return (l << k) | r;
  };
  return (i) => {
    let x = BigInt(i);
    do x = enc(x); while (x >= n);
    return x;
  };
}
