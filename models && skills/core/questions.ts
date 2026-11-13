/**
 * Questions: how often the AI asks when it is not sure.
 *
 * A third dial that rides the Zip Loop beside the prompt, in its own `questions/` folder (see ZIP_FOLDERS in
 * zip-halt.ts), and arrives on Port 9 (core/ports.ts). It is not part of the prompt and not a skill. It is a dial
 * from 0 to 100 and it answers one thing only: when the AI is unsure what a request means, does it stop and ask,
 * or does it pick the likeliest meaning and carry on?
 *
 *   - 0:   never asks. It assumes the likeliest meaning, says what it assumed, and does it.
 *   - Low: asks only when it is very unsure, and only one question.
 *   - Middle: asks when it is really unsure.
 *   - High: asks whenever it is unsure, more than one question if it needs to.
 *   - 100: asks whenever there is any doubt at all.
 *
 * It is the sibling of the confidence dial (core/neurons.ts, Port 7) and the effort dial (core/effort.ts, Port 8),
 * and independent of both: confidence is how sure to act, effort is how hard to work, this is how readily to ask.
 * The confidence dial also carries a question count, so when both are set this line says it decides on asking.
 *
 * Pure functions, no I/O. What reaches the mesh is one short line, because the doorway reads bits and a long
 * explanation only costs ticks.
 */

export const QUESTIONS_MIN = 0;
export const QUESTIONS_MAX = 100;
/** Where the dial sits when nobody has set it. Nothing is sent to the mesh at the default. */
export const QUESTIONS_DEFAULT = 50;
/** The most characters the input file may have. */
export const QUESTIONS_TEXT_MAX = 200;
/** The most questions it may ask in one go, at the top setting. */
export const QUESTIONS_MAX_ASKED = 5;

export type QuestionsMode = 'never' | 'rarely' | 'sometimes' | 'often' | 'always';

export interface QuestionsPlan {
  /** The dial, clamped to 0-100 and rounded. */
  level: number;
  mode: QuestionsMode;
  /**
   * It asks when it is less than this many percent sure what was meant. Equal to the dial, so 0 never asks
   * (nothing is less than 0% sure) and 100 asks unless it is certain.
   */
  askBelow: number;
  /** The most questions it may ask before it acts. 0 at the bottom, rising to QUESTIONS_MAX_ASKED. */
  maxQuestions: number;
}

/** Read a dial value from anything a request might carry; anything that is not a number is "not set" (null). */
export function parseQuestions(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(QUESTIONS_MAX, Math.max(QUESTIONS_MIN, n)));
}

/** Turn a dial value into what it means. A value that does not parse is the default. */
export function planQuestions(value: unknown): QuestionsPlan {
  const level = parseQuestions(value) ?? QUESTIONS_DEFAULT;
  const mode: QuestionsMode =
    level >= 90 ? 'always' : level >= 70 ? 'often' : level >= 40 ? 'sometimes' : level >= 15 ? 'rarely' : 'never';
  // Under 15 it never asks. From there the allowance climbs a question per 20 points, up to the cap.
  const maxQuestions = level < 15 ? 0 : Math.min(QUESTIONS_MAX_ASKED, Math.ceil(level / 20));
  return { level, mode, askBelow: level, maxQuestions };
}

/**
 * The line the mesh gets. Null when the dial was not set (or is exactly the default), so the archive then carries
 * no questions input at all and a reply behaves as it did before this input existed.
 */
export function questionsText(value: unknown): string | null {
  const set = parseQuestions(value);
  if (set === null || set === QUESTIONS_DEFAULT) return null;
  const p = planQuestions(set);
  const many = `${p.maxQuestions} question${p.maxQuestions === 1 ? '' : 's'}`;
  let rule: string;
  if (p.maxQuestions === 0) rule = 'Never ask. Assume the likeliest meaning, say what you assumed, and do it.';
  else if (p.mode === 'always') rule = `Ask whenever you have any doubt, up to ${many}, before you act.`;
  else rule = `If you are less than ${p.askBelow}% sure what is meant, ask up to ${many} before you act.`;
  return `Questions ${p.level}/100 (${p.mode}). ${rule} This decides whether to ask.`.slice(0, QUESTIONS_TEXT_MAX);
}
