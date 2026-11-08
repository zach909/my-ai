/**
 * Neurons: how confident the AI should act.
 *
 * A separate input that rides the Zip Loop beside the prompt (its own `neurons/` folder in the same archive, see
 * ZIP_FOLDERS in zip-halt.ts). It is not part of the prompt and not a prompting skill: it does not say WHAT to do,
 * it says how sure of itself to be while doing it. It is a dial from 0 to 100.
 *
 *   - The less confident it is told to be, the more questions it asks before acting.
 *   - The more confident, the more it just assumes and gets on with it.
 *   - At the top it is sure enough to cover both bases: when a request could mean two things it does it both
 *     ways and hands back both answers, instead of asking which one was meant.
 *
 * (Effort, how long it keeps going and how hard it tries, is a different input and is not handled here.)
 *
 * Pure functions, no I/O. What reaches the mesh is one short line: the doorway reads bits, and a long
 * explanation would only cost ticks.
 */

/** The dial's range. */
export const NEURONS_MIN = 0;
export const NEURONS_MAX = 100;
/** Where the dial sits when nobody has set it. Nothing is sent to the mesh at the default. */
export const NEURONS_DEFAULT = 50;
/** The most clarifying questions it may ask, at the lowest setting. */
export const NEURONS_MAX_QUESTIONS = 5;
/** The most characters the input file may have. */
export const NEURONS_TEXT_MAX = 200;

export type NeuronsMode = 'unsure' | 'cautious' | 'balanced' | 'assured' | 'certain';

export interface NeuronsPlan {
  /** The dial, clamped to 0-100 and rounded. */
  level: number;
  mode: NeuronsMode;
  /** How many clarifying questions it may ask before acting. Falls as confidence rises; 0 from "assured" up. */
  questions: number;
  /** True when a request that could mean two things is done both ways and both answers are given. */
  both: boolean;
}

/**
 * Read a dial value from anything a request might carry. A number or a numeric string is clamped to 0-100;
 * anything else (missing, null, NaN, text, an object) is "not set" and returns null, so nothing is guessed.
 */
export function parseNeurons(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(NEURONS_MAX, Math.max(NEURONS_MIN, n)));
}

/** Turn a dial value into what it means. A value that does not parse is the default. */
export function planNeurons(value: unknown): NeuronsPlan {
  const level = parseNeurons(value) ?? NEURONS_DEFAULT;
  const mode: NeuronsMode =
    level >= 90 ? 'certain' : level >= 75 ? 'assured' : level >= 50 ? 'balanced' : level >= 25 ? 'cautious' : 'unsure';
  // Questions fall in a straight line from the cap at 0 to none at 75 (rounded up, so anything under 75 still
  // asks at least one), then stay at none.
  const questions = level >= 75 ? 0 : Math.ceil(NEURONS_MAX_QUESTIONS * (1 - level / 75));
  return { level, mode, questions, both: level >= 90 };
}

/**
 * The line the mesh gets. Short on purpose.
 * Returns null when the dial was not set (or is exactly the default): the zip archive then carries no neurons
 * input at all and a reply behaves as it did before this input existed.
 */
export function neuronsText(value: unknown): string | null {
  const set = parseNeurons(value);
  if (set === null || set === NEURONS_DEFAULT) return null;
  const p = planNeurons(set);
  let rule: string;
  if (p.both) rule = 'Never ask. If the request could mean two things, do it both ways and give both.';
  else if (p.questions === 0) rule = 'Do not ask. Assume the likeliest meaning, say what you assumed, and do it.';
  else rule = `Ask up to ${p.questions} clarifying question${p.questions === 1 ? '' : 's'} before acting, only if unsure.`;
  return `Confidence ${p.level}/100 (${p.mode}). ${rule}`.slice(0, NEURONS_TEXT_MAX);
}
