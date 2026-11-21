// Run the randomly generated math exam after every big change to the model.
//
//   node scripts/model-change-test.mjs                 # check: run the exam only if the model changed a lot since the last test
//   node scripts/model-change-test.mjs --force         # run it now
//   node scripts/model-change-test.mjs --watch         # stay running; test whenever a big change has settled
//   options: --min-lines 20  --solver mesh  --n 400  --skip-build  --no-fail
//
// "The model" is the code under MODEL_DIRS (the Android engine, the OneBrain assets and training/). "Big" is MIN_LINES changed lines (added + removed) in them since the
// last tested state. The state tested is the working tree, uncommitted edits included. Small edits pile up until
// together they reach the limit.
//
// Before testing, the backend is rebuilt when scripts/build-backend.mjs exists (the Android layout has none) so the exam measures the code as it is now and never a
// stale dist/. The exam (benchmarks/math_exam.mjs) draws fresh random problems each time. The ANCHOR score of each run is
// kept in history.jsonl next to the git state it was measured on, and compared with the median of the recent runs. Problems
// are new every time, so a score moves a little by chance; a drop is reported as a regression only when it is larger than
// that chance (about 2.5 standard errors). A reported regression exits 1 (unless --no-fail).
//
// State lives in .neuroclaw/mutating-tests/ (git-ignored): last-tested.json and history.jsonl (last 200 runs).
// Node built-ins and git only.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
export const MODEL_DIRS = ['app/src/main/java/com/example/engine', 'app/src/main/assets/onebrain', 'training'];
const STATE_DIR = join(ROOT, '.neuroclaw', 'mutating-tests');
const LAST = join(STATE_DIR, 'last-tested.json'), HISTORY = join(STATE_DIR, 'history.jsonl');
const HISTORY_CAP = 200;
const SKIP_SEGMENTS = new Set(['node_modules', '__pycache__', 'dist', '.git']);

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : f; };
const flag = (n) => args.includes('--' + n);

const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const isRepo = () => { try { git(['rev-parse', '--git-dir']); return true; } catch { return false; } };
const lines = (text) => (text.length ? text.split('\n').length : 0);

/** Untracked model files: path -> content hash (git diff does not see them). */
function untracked() {
  const out = {};
  for (const f of git(['ls-files', '-o', '--exclude-standard', '--', ...MODEL_DIRS]).split('\n').filter(Boolean)) {
    if (f.split('/').some((s) => SKIP_SEGMENTS.has(s))) continue;
    try { if (statSync(join(ROOT, f)).size > (1 << 20)) continue; out[f] = createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 16); } catch { /* vanished */ }
  }
  return out;
}

/** A snapshot of the model code right now: a commit-like id for tracked files plus hashes of untracked ones. */
function snapshot() {
  let sha = git(['rev-parse', 'HEAD']).trim();
  try { const s = git(['stash', 'create']).trim(); if (s) sha = s; } catch { /* nothing to stash */ }   // unreferenced commit of the working tree; nothing in the tree changes
  return { sha, untracked: untracked(), head: git(['rev-parse', 'HEAD']).trim() };
}

/** Changed lines (added + removed) in the model code between a saved snapshot and now. Infinity = no usable baseline. */
export function changeSince(base) {
  if (!base || !base.sha) return { lines: Infinity, files: 0, reason: 'no earlier test' };
  try { git(['cat-file', '-e', base.sha + '^{commit}']); } catch { return { lines: Infinity, files: 0, reason: 'the last tested state is gone from git' }; }
  let total = 0, files = 0;
  for (const row of git(['diff', '--numstat', base.sha, '--', ...MODEL_DIRS]).split('\n').filter(Boolean)) {
    const [a, d] = row.split('\t'); files++; total += a === '-' ? 200 : Number(a) + Number(d);   // binary file: count as 200
  }
  const now = untracked();
  for (const [f, h] of Object.entries(now)) if (base.untracked?.[f] !== h) { files++; try { total += lines(readFileSync(join(ROOT, f), 'utf8')); } catch { /* vanished */ } }
  for (const f of Object.keys(base.untracked ?? {})) if (!(f in now)) { files++; total += 1; }
  return { lines: total, files };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
function writeAtomic(p, text) { mkdirSync(STATE_DIR, { recursive: true }); const t = `${p}.${process.pid}.tmp`; writeFileSync(t, text); renameSync(t, p); }
const history = () => (existsSync(HISTORY) ? readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
function appendHistory(row) {
  appendFileSync(HISTORY, JSON.stringify(row) + '\n');
  const all = history(); if (all.length > HISTORY_CAP) writeAtomic(HISTORY, all.slice(-HISTORY_CAP).map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** Is `now` lower than the recent median by more than chance? p = baseline, n = anchor problems in this run. */
export function droppedBeyondChance(baseline, now, n) {
  if (baseline === null || now === null) return false;
  const se = Math.sqrt((2 * Math.max(baseline * (1 - baseline), 0.02)) / Math.max(n, 1));
  return baseline - now > Math.max(0.04, 2.5 * se);
}

function runExam() {
  if (!flag('skip-build') && existsSync(join(ROOT, 'scripts', 'build-backend.mjs'))) {   // no build script in the Android layout: nothing to rebuild
    const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-backend.mjs')], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) { console.error('model-change-test: the backend did not build, so the exam would measure old code. Not run. (--skip-build to use the current dist/.)'); return null; }
  }
  const out = join(STATE_DIR, 'last-report.json'); mkdirSync(STATE_DIR, { recursive: true });
  const solver = opt('solver', 'mesh');   // mesh needs a built dist/; pass --solver path/to/solver.mjs for a model Node can call
  const r = spawnSync(process.execPath, [join(ROOT, 'benchmarks', 'math_exam.mjs'), '--solver', solver, '--n', opt('n', '400'), '--json', out], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`model-change-test: the exam failed (exit ${r.status}).`); return null; }
  return readJson(out);
}

/** One check. Returns 0 (fine / skipped), 1 (regression), 2 (could not run). */
export function checkOnce({ force = false } = {}) {
  if (!isRepo()) { console.error('model-change-test: not a git repository; cannot tell what changed. Use --force.'); if (!force) return 2; }
  const base = readJson(LAST);
  const minLines = Number(opt('min-lines', 20));
  const change = isRepo() ? changeSince(base) : { lines: Infinity, files: 0, reason: 'no git' };
  const big = change.lines >= minLines;
  if (!force && !big) { console.log(`model-change-test: ${change.lines} changed line(s) in ${change.files} model file(s) since the last test (limit ${minLines}). Skipped.`); return 0; }
  console.log(`model-change-test: ${force ? 'forced' : change.lines === Infinity ? change.reason : `${change.lines} changed lines in ${change.files} files`}. Running the math exam.`);
  const snap = isRepo() ? snapshot() : null;
  const report = runExam();
  if (!report) return 2;

  const prev = history().filter((h) => h.solver === report.meta.solver).slice(-5);
  const anchor = report.score.anchor, within = report.closeness.anchor.within10pct, n = report.score.anchorItems;
  const baseAnchor = prev.length ? median(prev.map((h) => h.anchor)) : null, baseWithin = prev.length ? median(prev.map((h) => h.within10pct)) : null;
  const regress = [];
  if (droppedBeyondChance(baseAnchor, anchor, n)) regress.push(`anchor exact-match ${(baseAnchor * 100).toFixed(1)}% -> ${(anchor * 100).toFixed(1)}%`);
  if (droppedBeyondChance(baseWithin, within, n)) regress.push(`anchor within-10% ${(baseWithin * 100).toFixed(1)}% -> ${(within * 100).toFixed(1)}%`);
  appendHistory({ at: new Date().toISOString(), head: snap?.head ?? null, changedLines: change.lines === Infinity ? null : change.lines, solver: report.meta.solver, seed: report.meta.seed, level: report.meta.levelBefore, anchor, within10pct: within, meanAbsError: report.closeness.anchor.meanAbsError, adaptive: report.score.adaptive, seenGap: report.memorisation.seenGap, n });
  if (snap) writeAtomic(LAST, JSON.stringify(snap));

  if (!prev.length) console.log('model-change-test: first recorded run for this solver; it is the baseline.');
  else if (regress.length) console.error(`model-change-test: REGRESSION vs the median of the last ${prev.length} run(s): ${regress.join('; ')} (larger than chance for ${n} anchor problems).`);
  else console.log(`model-change-test: no drop beyond chance vs the median of the last ${prev.length} run(s) (anchor ${(baseAnchor * 100).toFixed(1)}% -> ${(anchor * 100).toFixed(1)}%).`);
  return regress.length && !flag('no-fail') ? 1 : 0;
}

function watchMode() {
  const dirs = MODEL_DIRS.map((d) => join(ROOT, d)).filter(existsSync);
  let timer = null, running = false, again = false;
  const fire = () => {
    if (running) { again = true; return; }
    running = true;
    try { checkOnce(); } finally { running = false; if (again) { again = false; schedule(); } }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(fire, Number(opt('settle', 8)) * 1000); };
  for (const d of dirs) watch(d, { recursive: true }, (_e, f) => { if (f && !String(f).split(/[\\/]/).some((s) => SKIP_SEGMENTS.has(s))) schedule(); });
  console.log(`model-change-test: watching ${MODEL_DIRS.join(', ')}; testing ${opt('settle', 8)}s after the last edit once ${opt('min-lines', 20)}+ lines have changed. Ctrl-C to stop.`);
  schedule();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (flag('watch')) watchMode(); else process.exit(checkOnce({ force: flag('force') }));
}
