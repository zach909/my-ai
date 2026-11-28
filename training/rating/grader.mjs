/**
 * The second AI: the one that grades a job it did not do.
 *
 * The rule this enforces: the AI that makes an output may not be the AI that grades it. A grader with the same id
 * as the generator is refused. That is a structural check, not a promise.
 *
 * A grader is trusted only after calibration. The owner (or a gold set with known answers) supplies items that
 * already carry the score a careful reader would give. The grader rates them; if its scores agree with the gold
 * within a tolerance on at least `minAgreement` of items, the grader is calibrated. Until then every AI-graded
 * dimension comes back with score null, marked uncalibrated. A grader that has not been checked does not get to
 * write training labels.
 *
 * No model is bundled here. `judge` is supplied by the caller: in NeuroClaw it is a separate instance of the
 * in-repo mesh, never a third-party or local-model runner (AGENTS.md).
 */

export const DEFAULT_TOLERANCE = 0.2;
export const DEFAULT_MIN_AGREEMENT = 0.8;

export function createGrader({
  generatorId,
  graderId,
  judge,
  gold = [],
  tolerance = DEFAULT_TOLERANCE,
  minAgreement = DEFAULT_MIN_AGREEMENT,
} = {}) {
  if (!graderId) throw new Error('a grader needs an id');
  if (graderId === generatorId) {
    throw new Error(`grader "${graderId}" is the same AI as the generator; an AI may not grade its own output`);
  }
  if (typeof judge !== 'function') throw new Error('a grader needs a judge function');

  let calibration = null;

  async function calibrate() {
    if (gold.length === 0) {
      calibration = { calibrated: false, agreement: null, n: 0, reason: 'no gold items supplied' };
      return calibration;
    }
    let agree = 0;
    let errors = 0;
    for (const g of gold) {
      try {
        const r = await judge({ job: g.job, output: g.output, dimension: g.dimension });
        if (Math.abs(clamp01(r.score) - g.score) <= tolerance) agree++;
      } catch {
        errors++;
      }
    }
    const agreement = agree / gold.length;
    calibration = {
      calibrated: agreement >= minAgreement,
      agreement,
      n: gold.length,
      errors,
      reason: agreement >= minAgreement ? 'agrees with gold' : `agreement ${agreement.toFixed(2)} below ${minAgreement}`,
    };
    return calibration;
  }

  /** Score one dimension of one output. Returns an evidence item (score null if not calibrated or it errored). */
  async function grade({ job, output, dimension }) {
    if (!calibration || !calibration.calibrated) {
      return { dimension, score: null, source: 'ai', detail: `grader uncalibrated (${calibration?.reason ?? 'not calibrated yet'})` };
    }
    try {
      const r = await judge({ job, output, dimension });
      return { dimension, score: clamp01(r.score), source: 'ai', detail: String(r.reason ?? '') };
    } catch (err) {
      return { dimension, score: null, source: 'ai', detail: `judge error: ${err.message ?? err}` };
    }
  }

  return { graderId, generatorId, calibrate, grade, get calibration() { return calibration; } };
}

function clamp01(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) throw new Error('judge must return a numeric score');
  return Math.min(1, Math.max(0, x));
}
