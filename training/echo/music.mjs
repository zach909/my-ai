/**
 * Music theory for the echo step, as rules the randomizer must stay inside.
 * Written for this project from scratch. Nothing imported but our own modules.
 *
 * A tune is a list of SCALE DEGREES (0..10, about an octave and a half), not pitches. So every key and mode is the
 * same tune in a different place; `toMidi` puts it somewhere. The rules (from docs/TRAINING_CURRICULUM.md, Stage 1):
 *
 *   start      on a chord tone of the tonic triad (degree 0, 2 or 4)
 *   steps      move by 1 or 2 degrees (common)
 *   leaps      move by 3 or 4 degrees (allowed, but not twice in a row)
 *   after a leap the next move must be a STEP BACK the other way
 *   repeats    the same degree at most 3 times in a row
 *   range      stay inside degrees 0..10
 *   cadence    end on a stable degree: the tonic (0, 7) or the dominant (4), and never hanging off a leap
 *
 * Not modelled here yet (the notes say so): rhythm, chords and voice leading, clash checks, form. This is the
 * melody rule set only, so the label for a clip is its exact note list.
 */
import { Walk } from './rules.mjs';

export const DEGREES = 11;
const STABLE = new Set([0, 4]); // degree % 7: tonic and dominant

function nextMusic(state) {
  if (state === 'S') return [0, 2, 4].map((d) => [d, `${d}:n:1`]);
  const [d, mv, runS] = state.split(':');
  const deg = Number(d);
  const run = Number(runS);
  const out = [];
  for (let iv = -4; iv <= 4; iv++) {
    const t = deg + iv;
    if (t < 0 || t >= DEGREES) continue;
    const size = Math.abs(iv);
    if (size === 0) {
      if (run < 3 && mv !== 'U' && mv !== 'D') out.push([t, `${t}:a:${run + 1}`]);
    } else if (size <= 2) {
      if (mv === 'U' && iv > 0) continue; // after a leap up, come back down
      if (mv === 'D' && iv < 0) continue; // after a leap down, come back up
      out.push([t, `${t}:a:1`]);
    } else if (mv !== 'U' && mv !== 'D') {
      out.push([t, `${t}:${iv > 0 ? 'U' : 'D'}:1`]);
    }
  }
  return out;
}

export const musicSpec = {
  init: 'S',
  next: nextMusic,
  accept: (state) => {
    if (state === 'S') return false;
    const [d, mv] = state.split(':');
    return STABLE.has(Number(d) % 7) && mv !== 'U' && mv !== 'D';
  },
};

export const musicWalk = new Walk(musicSpec);

/** Semitones above the tonic for each degree of a scale. */
export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

/** Scale degrees -> MIDI note numbers in the chosen key (tonic 60 = middle C) and mode. */
export function toMidi(tune, tonic = 60, mode = 'major') {
  const scale = MODES[mode];
  if (!scale) throw new Error(`unknown mode ${mode}`);
  return tune.map((d) => tonic + 12 * Math.floor(d / scale.length) + scale[d % scale.length]);
}

/**
 * Notes -> raw audio: unsigned 8-bit mono, no header, 4 kHz, each note a sine with a short
 * attack and release (so the notes do not click). 128 is silence.
 */
export function renderPcm8(midi, { sr = 4000, ms = 250 } = {}) {
  const per = Math.round((sr * ms) / 1000);
  const out = new Uint8Array(per * midi.length);
  const atk = Math.max(1, Math.round(sr * 0.01));
  const rel = Math.max(1, Math.round(sr * 0.04));
  midi.forEach((m, n) => {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    for (let i = 0; i < per; i++) {
      const env = Math.min(1, (i + 1) / atk, (per - i) / rel);
      out[n * per + i] = Math.round(128 + 127 * 0.8 * env * Math.sin((2 * Math.PI * f * i) / sr));
    }
  });
  return out;
}
