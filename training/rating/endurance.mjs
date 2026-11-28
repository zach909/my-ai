/**
 * Durability: how many runs succeed before the first failure.
 *
 * This is the SSD idea: wear the thing with repeated work and count what it survives. Each run is a trial that
 * is either ok or failed. A run that throws counts as a failure, with its message kept.
 *
 * Honesty about the number: surviving N runs does not prove the failure rate is zero. The report gives a 95%
 * Wilson interval for the failure rate and a "rule of three" bound (with zero failures in N runs, the failure
 * rate is below about 3/N at 95% confidence). The durability score is 1 minus the upper bound, so a thing that
 * was only tried a few times cannot score well just because nothing broke yet.
 */

const Z95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion. Returns [low, high]. */
export function wilsonInterval(failures, n, z = Z95) {
  if (n <= 0) return [0, 1];
  const p = failures / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * @param {(i: number) => boolean | Promise<boolean>} trial  one run; true = ok, false = failed
 * @param {{runs?: number, now?: () => number}} [opts]
 */
export async function endurance(trial, { runs = 100, now = () => Date.now() } = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  const t0 = now();
  let failures = 0;
  let firstFailureAt = null;
  const errors = [];
  for (let i = 0; i < runs; i++) {
    let ok;
    try {
      ok = (await trial(i)) === true;
    } catch (err) {
      ok = false;
      if (errors.length < 5) errors.push(String(err && err.message ? err.message : err));
    }
    if (!ok) {
      failures++;
      if (firstFailureAt === null) firstFailureAt = i + 1;
    }
  }
  const [lo, hi] = wilsonInterval(failures, runs);
  const ruleOfThree = failures === 0 ? 3 / runs : null;
  const upperBound = failures === 0 ? ruleOfThree : hi;
  return {
    runs,
    failures,
    survived: runs - failures,
    firstFailureAt,
    failureRate: failures / runs,
    ci95: [lo, hi],
    ruleOfThreeBound: ruleOfThree,
    score: Math.max(0, Math.min(1, 1 - upperBound)),
    errors,
    elapsedMs: now() - t0,
  };
}
