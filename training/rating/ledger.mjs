/**
 * The ledger: every rated job, appended as one JSON line.
 *
 * - Bounded disk: when the file passes `maxBytes` it is rotated to `.1` (one old copy kept), so logs never grow
 *   without limit (repository and drive rule in the owner's optimisation notes).
 * - Malformed lines are skipped and counted, never fatal.
 * - exportTraining() is the hand-off to the final training stage. It only emits records whose rating is SCORED,
 *   whose gates passed, and whose AI grader was calibrated. Everything else stays in the ledger as evidence.
 * - learnability() measures whether later rounds score higher on the same kind of job.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function openLedger(dir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ratings.jsonl');

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size >= maxBytes) fs.renameSync(file, file + '.1');
  }

  function append(record) {
    rotateIfNeeded();
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  }

  function read() {
    const records = [];
    let malformed = 0;
    for (const f of [file + '.1', file]) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          malformed++;
        }
      }
    }
    return { records, malformed };
  }

  return { file, append, read };
}

/**
 * Records that are safe to train on: SCORED, every gate passed, the grader calibrated, and the overall score
 * at or above `minOverall`. The output is the training pair plus the per-dimension scores, so the final stage can
 * learn from the breakdown and not just a single number.
 */
export function exportTraining(records, { minOverall = 0.6 } = {}) {
  const out = [];
  let skipped = 0;
  for (const r of records) {
    const ok =
      r.report &&
      r.report.verdict === 'SCORED' &&
      r.report.gatesFailed.length === 0 &&
      r.report.gatesUngraded.length === 0 &&
      r.graderCalibrated === true &&
      r.graderId !== r.generatorId &&
      r.report.overall >= minOverall;
    if (!ok) {
      skipped++;
      continue;
    }
    out.push({
      prompt: r.job?.prompt ?? '',
      output: r.output ?? '',
      overall: r.report.overall,
      scores: Object.fromEntries(
        Object.entries(r.report.dimensions)
          .filter(([, d]) => d.score !== null)
          .map(([id, d]) => [id, d.score]),
      ),
    });
  }
  return { pairs: out, skipped };
}

/**
 * Learnability: mean overall score of the last `window` rated jobs of each kind, minus the first `window`.
 * Returns null when there are not enough rounds to compare (no fake trend). A positive delta means later outputs
 * of the same kind scored higher.
 */
export function learnability(records, { window = 10 } = {}) {
  const byKind = new Map();
  for (const r of records) {
    if (r.report?.verdict !== 'SCORED') continue;
    const kind = r.job?.kind ?? 'unknown';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(r.report.overall);
  }
  const deltas = [];
  for (const scores of byKind.values()) {
    if (scores.length < window * 2) continue;
    const first = scores.slice(0, window);
    const last = scores.slice(-window);
    deltas.push(mean(last) - mean(first));
  }
  if (deltas.length === 0) return { delta: null, kinds: 0, reason: `need at least ${window * 2} scored jobs of one kind` };
  const delta = mean(deltas);
  return { delta, kinds: deltas.length, score: Math.min(1, Math.max(0, 0.5 + delta)) };
}

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
