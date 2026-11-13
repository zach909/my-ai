/**
 * Effort: how hard the AI tries and how long it keeps going.
 *
 * A second dial that rides the Zip Loop beside the prompt, in its own `effort/` folder (see ZIP_FOLDERS in
 * zip-halt.ts), and arrives on Port 8 (core/ports.ts). It is not part of the prompt and not a skill. It is a dial
 * from 0 to 100, the sibling of the confidence dial in core/neurons.ts (Port 7), which decides how many questions
 * to ask. The two are independent: how sure to be, and how hard to work.
 *
 *   - Low effort: give the first answer that works and stop.
 *   - Middle: check the answer once before stopping.
 *   - High: keep going until it is right, checking and fixing as it goes.
 *   - At the top: do not stop at "good enough"; try another way and compare.
 *
 * Pure functions, no I/O. What reaches the mesh is one short line, because the doorway reads bits and a long
 * explanation only costs ticks.
 */

export const EFFORT_MIN = 0;
export const EFFORT_MAX = 100;
/** Where the dial sits when nobody has set it. Nothing is sent to the mesh at the default. */
export const EFFORT_DEFAULT = 50;
/** The most characters the input file may have. */
export const EFFORT_TEXT_MAX = 200;
/** The most times it may check its own answer, at the top setting. */
export const EFFORT_MAX_CHECKS = 3;

export type EffortMode = 'minimal' | 'light' | 'steady' | 'thorough' | 'exhaustive';

export interface EffortPlan {
  /** The dial, clamped to 0-100 and rounded. */
  level: number;
  mode: EffortMode;
  /** How many times it checks its answer before it stops. 0 at the bottom, rising to EFFORT_MAX_CHECKS. */
  checks: number;
  /** True at the top: it tries a second way and compares instead of stopping at the first good answer. */
  tryAnother: boolean;
}

/** Read a dial value from anything a request might carry; anything that is not a number is "not set" (null). */
export function parseEffort(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(EFFORT_MAX, Math.max(EFFORT_MIN, n)));
}

/** Turn a dial value into what it means. A value that does not parse is the default. */
export function planEffort(value: unknown): EffortPlan {
  const level = parseEffort(value) ?? EFFORT_DEFAULT;
  const mode: EffortMode =
    level >= 90 ? 'exhaustive' : level >= 70 ? 'thorough' : level >= 40 ? 'steady' : level >= 15 ? 'light' : 'minimal';
  const checks = level < 15 ? 0 : Math.min(EFFORT_MAX_CHECKS, Math.ceil((level / 100) * EFFORT_MAX_CHECKS));
  return { level, mode, checks, tryAnother: level >= 90 };
}

/**
 * The line the mesh gets. Null when the dial was not set (or is exactly the default), so the archive then carries
 * no effort input at all and a reply behaves as it did before this input existed.
 */
export function effortText(value: unknown): string | null {
  const set = parseEffort(value);
  if (set === null || set === EFFORT_DEFAULT) return null;
  const p = planEffort(set);
  let rule: string;
  if (p.tryAnother) rule = `Do not stop at good enough. Check your answer ${p.checks} times, then try a second way and compare.`;
  else if (p.checks === 0) rule = 'Give the first answer that works and stop.';
  else rule = `Check your answer ${p.checks} time${p.checks === 1 ? '' : 's'} before you stop.`;
  return `Effort ${p.level}/100 (${p.mode}). ${rule}`.slice(0, EFFORT_TEXT_MAX);
}
