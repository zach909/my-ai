/**
 * audio.mjs -- audio TASKS (not prediction). Clips come from the echo step's own synth (training/echo/music.mjs), so
 * every clip has an exact answer key: the notes. Two tasks:
 *   note   one 250 ms window -> which MIDI note is it?
 *   tune   a whole clip -> the full list of notes, scored exact-match (every note right, in order)
 * Training uses some keys and modes; the exam uses keys and modes the model never trained on, and also noisier clips.
 * The front end (a bank of Goertzel filters, one per semitone) is hand-written signal processing, not learned.
 * Labels come from the generator that made the sound. No speech-to-text or other recogniser is involved.
 */
import { musicWalk, toMidi, renderPcm8 } from '../echo/music.mjs'
import { Rng } from '../simulation/random.mjs'
import { trainSoftmax, predict, score } from './learn.mjs'

export const SR = 4000, MS = 250, PER = (SR * MS) / 1000
export const LOW = 40, HIGH = 90, NOTES = HIGH - LOW + 1
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12)

/** Energy at each semitone from LOW to HIGH over the steady middle of a window, normalised so loudness does not matter. */
export function noteFeatures(win) {
  const a = Math.round(win.length * 0.12), b = win.length - a, n = b - a, e = new Array(NOTES)
  for (let k = 0; k < NOTES; k++) {
    const w = (2 * Math.PI * hz(LOW + k)) / SR, c = 2 * Math.cos(w)
    let s1 = 0, s2 = 0
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      const s = ((win[a + i] - 128) / 127) * hann + c * s1 - s2
      s2 = s1; s1 = s
    }
    e[k] = s1 * s1 + s2 * s2 - c * s1 * s2
  }
  const t = e.reduce((x, y) => x + y, 0) || 1
  return e.map((v) => Math.sqrt(v / t))
}

function addNoise(pcm, amp, rng) {
  if (!amp) return pcm
  return pcm.map((v) => Math.max(0, Math.min(255, Math.round(v + (rng.next() * 2 - 1) * amp * 127))))
}

/** One clip: a rule-legal random tune in the given key and mode, its raw audio, and the exact notes. */
export function makeClip(rng, { len = 6, tonics, modes, noise = 0 }) {
  const tune = musicWalk.random(len, rng)
  const tonic = rng.pick(tonics), mode = rng.pick(modes)
  const midi = toMidi(tune, tonic, mode)
  return { midi, tonic, mode, pcm: addNoise(renderPcm8(midi, { sr: SR, ms: MS }), noise, rng) }
}

export const windows = (clip) => clip.midi.map((_, i) => clip.pcm.subarray(i * PER, (i + 1) * PER))

export const TRAIN = { tonics: [48, 50, 53, 55, 57, 60, 62, 65, 67, 69, 72], modes: ['major', 'minor', 'dorian'] }
export const HELD = { tonics: [49, 51, 54, 56, 58, 61, 63, 66, 68, 70], modes: ['mixolydian', 'pentatonic'] }

function dataset(seed, count, cfg) {
  const rng = new Rng(seed), clips = []
  for (let i = 0; i < count; i++) clips.push(makeClip(rng, { ...cfg, len: rng.pick([6, 8]) }))
  return clips
}

/** Train the note task, then score both tasks on held-out keys/modes (clean and noisy). */
export function runAudio({ trainClips = 120, testClips = 60, seed = 1, epochs = 200 } = {}) {
  const train = dataset(seed, trainClips, { ...TRAIN, noise: 0.05 })
  const X = [], y = []
  for (const c of train) windows(c).forEach((w, i) => { X.push(noteFeatures(w)); y.push(c.midi[i] - LOW) })
  const model = trainSoftmax(X, y, NOTES, { epochs })
  const trainedNotes = new Set(y)

  const exam = (cfg, name) => {
    const clips = dataset(seed + 1000, testClips, cfg)
    const Xn = [], yn = []
    let tuneOk = 0, unseen = 0
    for (const c of clips) {
      const got = windows(c).map((w) => predict(model, noteFeatures(w)) + LOW)
      if (got.every((m, i) => m === c.midi[i])) tuneOk++
      c.midi.forEach((m, i) => { Xn.push(noteFeatures(windows(c)[i])); yn.push(m - LOW); if (!trainedNotes.has(m - LOW)) unseen++ })
    }
    return { exam: name, note: score(model, Xn, yn), tuneExact: +(tuneOk / clips.length).toFixed(4), tunes: clips.length, notesNeverTrained: unseen }
  }
  return {
    trained: { clips: trainClips, notes: y.length, loss: model.loss },
    results: [
      exam({ ...TRAIN, noise: 0.05 }, 'seen keys+modes (sanity)'),
      exam({ ...HELD, noise: 0.05 }, 'UNSEEN keys+modes'),
      exam({ ...HELD, noise: 0.35 }, 'UNSEEN keys+modes, much noisier'),
    ],
  }
}
