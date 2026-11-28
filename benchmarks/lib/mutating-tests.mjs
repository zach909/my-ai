// Self-changing tests: the machinery that stops an AI from scoring well by remembering the test.
//
// Four things change on their own, with no one editing a test file:
//   1. SEED     every run draws a new random seed, so every problem is new (--seed replays one).
//   2. LEDGER   every problem ever served is remembered by hash and never served again. A solver
//               that memorised an earlier exam gains nothing: the same problem cannot come back.
//   3. LEVEL    each family of problems has a difficulty level. A family the AI passes (>= 85%)
//               gets harder next run (bigger numbers, longer chains, more wordings); one it
//               fails (<= 35%) gets easier.
//   4. WEIGHTS  each tag (a problem kind, an operator, a size) has a weight. A tag the AI fails on
//               is drawn more often next run, one it passes less often. The exam drifts toward
//               whatever the AI is currently worst at.
// Because 3 and 4 make the exam harder over time, scores from different runs are not comparable on
// their own. So every run also carries an ANCHOR track: problems drawn at level 1 with equal
// weights, whatever the state. The anchor score is the one to compare across changes to the model.
//
// State is one small JSON file (default .neuroclaw/mutating-tests/<name>.json, git-ignored,
// written atomically, ledger capped). Pass `persist: false` for a run that touches nothing.
// Node built-ins only.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MAX_LEVEL = 6;
export const LEDGER_CAP = 20000;          // 12 hex chars each: about 300 KB at the cap
export const LEVEL_UP_AT = 0.85;
export const LEVEL_DOWN_AT = 0.35;
export const ANCHOR_SHARE = 0.4;
const W_MIN = 0.2, W_MAX = 5;

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const freshSeed = () => randomBytes(4).readUInt32BE(0);
export const hashText = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const seedFromName = (name) => parseInt(hashText(name).slice(0, 8), 16);
export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = (r, a) => a[Math.floor(r() * a.length)];
export function weightedPick(r, entries) {            // entries: [[value, weight], ...]
  const total = entries.reduce((s, [, w]) => s + w, 0); let x = r() * total;
  for (const [v, w] of entries) { x -= w; if (x <= 0) return v; }
  return entries.at(-1)[0];
}
export function shuffled(r, arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** What persists between runs. */
export function emptyState() { return { version: 1, runs: 0, ledger: [], families: {} }; }

function readState(path) {
  try { const s = JSON.parse(readFileSync(path, 'utf8')); if (s && s.version === 1 && Array.isArray(s.ledger) && s.families) return s; } catch { /* missing or damaged: start fresh */ }
  return emptyState();
}
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path);
}

export class MutatingRun {
  /**
   * @param {object} o
   * @param {string} [o.name]       state file name (one per exam)
   * @param {string} [o.statePath]  full path, overrides the default
   * @param {number} [o.seed]       fixed seed; omitted = a new random one
   * @param {object} [o.recipe]     a recipe from an earlier run's report: replays exactly, touches no state
   * @param {boolean} [o.persist]   false: read nothing, write nothing (a throwaway run)
   */
  constructor({ name = 'exam', statePath, seed, recipe, persist = true } = {}) {
    this.name = name;
    this.replay = !!recipe;
    this.persist = persist && !recipe;
    this.statePath = statePath ? resolve(statePath) : resolve('.neuroclaw', 'mutating-tests', `${name}.json`);
    this.state = this.persist && existsSync(this.statePath) ? readState(this.statePath) : emptyState();
    if (recipe) {
      this.seed = recipe.seed >>> 0;
      this.state.families = JSON.parse(JSON.stringify(recipe.families ?? {}));
    } else this.seed = (seed ?? freshSeed()) >>> 0;
    this.ledger = new Set(this.state.ledger);
    this.served = new Set();                 // claimed this run (kept apart so a replay can reuse old problems)
    this.outcomes = {};                      // family -> [{ track, tags, ok }]
    this._claimedHashes = [];
  }

  /** An independent random stream for one part of the exam. */
  rngFor(label) { return rng((this.seed ^ seedFromName(label)) >>> 0); }
  family(name) { return (this.state.families[name] ??= { level: 1, weights: {}, recent: [] }); }
  level(name, track = 'adaptive') { return track === 'anchor' ? 1 : this.family(name).level; }
  weight(name, tag, track = 'adaptive') { return track === 'anchor' ? 1 : this.family(name).weights[tag] ?? 1; }
  /** Draw a track for one item: ANCHOR_SHARE of items are level-1 / equal-weight anchors. */
  trackFor(r) { return r() < ANCHOR_SHARE ? 'anchor' : 'adaptive'; }

  /**
   * Try to use a problem. False if it was served before (any earlier run) or already this run:
   * the generator then draws another. In a replay the ledger is ignored so old problems can come back.
   */
  claim(text) {
    const h = hashText(text);
    if (this.served.has(h) || (!this.replay && this.ledger.has(h))) return false;
    this.served.add(h); this._claimedHashes.push(h);
    return true;
  }

  /** Everything needed to replay this exact exam: `new MutatingRun({ recipe })`. */
  recipe() { return { seed: this.seed, families: JSON.parse(JSON.stringify(this.state.families)) }; }

  record(family, { track, tags, ok }) { (this.outcomes[family] ??= []).push({ track, tags, ok: !!ok }); }

  /**
   * Fold the results into the state and save it: retire the served problems, move levels, move tag weights.
   * Levels move only on adaptive items (anchor items never feed back, so the anchor stays a fixed yardstick).
   */
  finish() {
    const summary = { families: {}, retired: this._claimedHashes.length };
    for (const [name, rows] of Object.entries(this.outcomes)) {
      const f = this.family(name), adaptive = rows.filter((r) => r.track === 'adaptive');
      const before = f.level;
      if (adaptive.length >= 8 && !this.replay) {
        const acc = adaptive.filter((r) => r.ok).length / adaptive.length;
        if (acc >= LEVEL_UP_AT && f.level < MAX_LEVEL) f.level++; else if (acc <= LEVEL_DOWN_AT && f.level > 1) f.level--;
        for (const r of adaptive) for (const tag of r.tags) {
          const w = f.weights[tag] ?? 1;
          f.weights[tag] = +Math.min(W_MAX, Math.max(W_MIN, r.ok ? w * 0.97 : w * 1.12)).toFixed(4);
        }
      }
      summary.families[name] = { levelBefore: before, levelAfter: f.level, items: rows.length, adaptiveItems: adaptive.length };
    }
    if (this.persist) {
      this.state.runs++;
      this.state.ledger = [...this.state.ledger, ...this._claimedHashes].slice(-LEDGER_CAP);
      writeAtomic(this.statePath, JSON.stringify(this.state));
    }
    return summary;
  }
}
