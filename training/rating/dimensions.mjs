/**
 * The rating dimensions: every question a finished job is judged on.
 *
 * Each dimension says how it is measured (`source`):
 *   check    a deterministic check written for the job (a test, a command, an exact comparison)
 *   endure   repeated runs, counted until failure (the durability number, like an SSD's write endurance)
 *   measure  a static measurement of the code the job produced (see measure-repo.mjs)
 *   ai       a second AI, which did not produce the output, reads it and scores it (see grader.mjs)
 *   ledger   computed across many rated jobs over time (see ledger.mjs)
 *
 * `gate: true` means a failed check ends the rating as FAIL. A thing that does not work,
 * or is not safe, does not get a good score on the other dimensions. The weights only
 * decide how much each graded dimension counts in the overall number.
 *
 * Node built-ins only. No third-party code (AGENTS.md).
 */

const dim = (id, label, question, opts) => Object.freeze({ id, label, question, weight: 1, gate: false, ...opts });

export const DIMENSIONS = Object.freeze([
  dim('works', 'Does it work?', 'Does the output do what it is meant to, on the checks that define success?', { weight: 3, gate: true, source: 'check' }),
  dim('durability', 'How long before it breaks?', 'Across repeated runs, how many succeed before the first failure, and how sure are we of the failure rate?', { weight: 2, source: 'endure' }),
  dim('prompt_fit', 'Does it fit the prompt?', 'Is every requirement in the prompt covered, and nothing the prompt did not ask for added?', { weight: 3, source: 'check' }),
  dim('modifiability', 'Can a piece change without the rest falling apart?', 'Can one module be changed without a ripple through unrelated modules? (import cycles and fan-out)', { weight: 2, source: 'measure' }),
  dim('organization', 'Is each piece separate and specialised?', 'Is the code split into small, single-purpose files rather than large mixed ones?', { weight: 1, source: 'measure' }),
  dim('composition', 'Does each piece do one job, and do they make a whole?', 'Does every piece do one thing, and do the pieces work together when run end to end? (the "web")', { weight: 2, source: 'check' }),
  dim('interface', 'Is it easy to use?', 'Are inputs, outputs and error messages clear, predictable and free of manual fixes?', { weight: 1, source: 'ai' }),
  dim('security', 'Is it safe?', 'No unsafe capability, no secrets in the output, no third-party code, safe defaults.', { weight: 3, gate: true, source: 'check' }),
  dim('stability', 'Does it stay steady?', 'Does it handle bad input and recover, without errors piling up over repeated runs?', { weight: 2, source: 'endure' }),
  dim('efficiency', 'Is it lean?', 'Speed, memory, disk writes, network requests, and battery use, measured against a budget.', { weight: 1, source: 'check' }),
  dim('honesty', 'Does it claim only what it can back up?', 'Does it say when it does not know, and do its stated confidence and claims match what was verified?', { weight: 2, source: 'ai' }),
  dim('learnability', 'Does it get better with feedback?', 'Across training rounds, do rated outputs improve on the same kind of job?', { weight: 1, source: 'ledger' }),
  dim('repo_hygiene', 'Is the repository lean and clean?', 'No dead or duplicate code, no third-party code, no oversized files.', { weight: 1, source: 'measure' }),
]);

const BY_ID = new Map(DIMENSIONS.map((d) => [d.id, d]));

export function dimension(id) {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`unknown rating dimension: ${id}`);
  return d;
}

export const DIMENSION_IDS = DIMENSIONS.map((d) => d.id);
