// Rule-based composer: music theory decides what is ALLOWED, a seeded random generator decides what is CHOSEN.
// Same seed -> byte-identical piece. Output: MIDI (3 tracks) and a WAV rendered with a small additive synth.
//
// Theory used (standard Western tonal practice, not copied from any recording):
//   scales as semitone patterns; diatonic triads built by stacking thirds inside the scale; functional harmony as a
//   weighted transition table between scale degrees; the piece starts on I and ends V -> I (authentic cadence);
//   melody: strong beats prefer chord tones, other beats move mostly by step, a leap larger than a third is followed by a
//   step in the opposite direction, range is limited, the last note is the tonic.
import { writeWav } from './audio.mjs';

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/** Seeded PRNG (mulberry32): the only source of randomness. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (pairs) => { const tot = pairs.reduce((s, p) => s + p[1], 0); let r = next() * tot; for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs.at(-1)[0]; } };
}

/** The scale a chord is built from: minor uses harmonic minor so V is major and vii is diminished. */
const chordScale = (mode) => (mode === 'minor' ? SCALES.harmonicMinor : SCALES[mode]);
/** Absolute scale-degree index d (may be negative / beyond 6) -> MIDI pitch. */
export function degreeToMidi(tonic, scale, d) { const n = scale.length, o = Math.floor(d / n), i = ((d % n) + n) % n; return tonic + o * 12 + scale[i]; }
/** Triad on degree (0..6): root, third, fifth = every other scale tone. */
export const triadDegrees = (deg) => [deg, deg + 2, deg + 4];

// Functional harmony: from-degree -> [[to-degree, weight]]. Degrees are 0-based (0 = I, 4 = V).
export const TRANSITIONS = {
  0: [[3, 3], [4, 3], [5, 2], [1, 1.5], [2, 0.5]],
  1: [[4, 6], [3, 2], [6, 1]],
  2: [[5, 5], [3, 5]],
  3: [[4, 4], [0, 2.5], [1, 2], [5, 1.5]],
  4: [[0, 6], [5, 2.5], [3, 1.5]],
  5: [[1, 3], [3, 4], [4, 3]],
  6: [[0, 10]],
};
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const RHYTHMS = [[1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [1.5, 0.5, 1, 1], [2, 2], [0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 2], [1, 1, 0.5, 0.5, 1], [3, 1]];

/** Generate-and-test: draw a piece from the seeded generator; if it breaks a hard rule (about 1% do), draw again from the next derived seed. Deterministic per seed. */
export function compose(opts = {}) {
  const seed = opts.seed ?? 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const piece = build({ ...opts, seed }, (seed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
    if (analyze(piece).ok) return { ...piece, attempts: attempt + 1 };
  }
  throw new Error('no rule-conforming piece found in 50 attempts');
}

function build({ key = null, mode = null, bars = 8, bpm = null, melodyLow = null, seed = 1 } = {}, rngSeed = seed) {
  if (bars < 4) throw new Error('bars must be at least 4');
  const r = rng(rngSeed);
  const tonic = key === null ? 43 + r.int(12) : key;                      // G2..F#3: melody sits two octaves above
  const m = mode || r.pick(['major', 'minor', 'dorian', 'mixolydian']);
  const scale = SCALES[m], cscale = chordScale(m);
  const tempo = bpm || 84 + r.int(48);

  // 1. harmony: start on I, random walk by the transition table, force the last two bars to V -> I
  const prog = [0];
  for (let b = 1; b < bars - 2; b++) {
    let opts = TRANSITIONS[prog[b - 1]];
    if (b === bars - 3) opts = opts.filter(([to]) => to !== 4 && TRANSITIONS[to].some(([x]) => x === 4)); // the bar before V must be able to lead to V
    prog.push(r.weighted(opts.length ? opts : TRANSITIONS[prog[b - 1]]));
  }
  prog.push(4, 0);

  // 2. harmony and bass notes (pitch numbers are MIDI; time in beats)
  const chords = [], bass = [];
  prog.forEach((deg, b) => {
    const tones = triadDegrees(deg).map((d) => degreeToMidi(tonic + 12, cscale, d));
    chords.push({ bar: b, degree: deg, roman: ROMAN[deg], pitches: tones, start: b * 4, dur: 4 });
    const root = degreeToMidi(tonic - 12, cscale, deg);
    bass.push({ pitch: root, start: b * 4, dur: 2 }, { pitch: r.next() < 0.5 ? root : root + 7, start: b * 4 + 2, dur: 2 });
  });

  // 3. melody, as scale-degree indices in the melody register
  const melScale = scale;
  const low = melodyLow ?? tonic + 24, lowD = Math.ceil((low - tonic) / 12) * melScale.length;       // degree index of the tonic at/above `low`
  const lo = lowD - 2, hi = lowD + melScale.length + 3;                                              // about 1.5 octaves
  const midiOf = (d) => degreeToMidi(tonic, melScale, d);
  const pcOf = (d) => ((midiOf(d) % 12) + 12) % 12;
  const chordPcs = (b) => new Set(chords[b].pitches.map((p) => ((p % 12) + 12) % 12));
  const slots = [];
  for (let b = 0; b < bars; b++) { const rhythm = b === bars - 1 ? [2, 2] : r.pick(RHYTHMS); let t = 0; for (const d of rhythm) { slots.push({ b, beat: t, dur: d }); t += d; } }
  const melody = []; let cur = lowD + r.pick([0, 2, 4]); let prevLeap = 0;                          // start on a tonic-triad tone
  const tonicNear = (d) => [lowD, lowD + melScale.length].reduce((x, y) => (Math.abs(y - d) < Math.abs(x - d) ? y : x));
  slots.forEach((sl, idx) => {
    const { b, beat, dur } = sl, strong = beat === 0 || beat === 2, last = idx === slots.length - 1;
    let next = cur;
    if (last) next = tonicNear(cur);
    else if (idx > 0) {
      const cands = [];
      for (let d = Math.max(lo, cur - 4); d <= Math.min(hi, cur + 4); d++) {
        const step = Math.abs(d - cur); let w = step === 0 ? 0.4 : step === 1 ? 6 : step === 2 ? 3 : step === 3 ? 0.8 : 0.25;
        if (Math.abs(prevLeap) >= 3 && !(step === 1 && Math.sign(d - cur) === -Math.sign(prevLeap))) w = 0;   // a leap resolves by step in the other direction
        if (w > 0) cands.push([d, w, chordPcs(b).has(pcOf(d))]);
      }
      const pool = strong && cands.some((c) => c[2]) ? cands.filter((c) => c[2]) : cands;                    // strong beats take chord tones when one is reachable
      next = pool.length ? r.weighted(pool.map(([d, w]) => [d, w])) : cur;
    }
    prevLeap = next - cur; cur = next;
    melody.push({ pitch: midiOf(cur), degree: cur, start: b * 4 + beat, dur, bar: b, strong });
  });
  return { seed, tonic, mode: m, scale, tempo, bars, progression: prog.map((d) => ROMAN[d]), chords, bass, melody, meter: '4/4' };
}

/** Check a piece against the rules it was built from. Returns booleans/counts; `ok` is true only if every hard rule holds. */
export function analyze(p) {
  const scalePcs = new Set([...p.scale, ...(p.mode === 'minor' ? [11] : [])].map((s) => (p.tonic + s) % 12));
  const pc = (x) => ((x % 12) + 12) % 12;
  const mel = p.melody; const inKey = mel.filter((n) => scalePcs.has(pc(n.pitch))).length / mel.length;
  const strong = mel.filter((n) => n.strong); const chordTone = strong.filter((n) => p.chords[n.bar].pitches.some((c) => pc(c) === pc(n.pitch))).length / (strong.length || 1);
  let unresolved = 0, maxLeap = 0;
  for (let i = 1; i < mel.length; i++) { const leap = mel[i].pitch - mel[i - 1].pitch; maxLeap = Math.max(maxLeap, Math.abs(leap));
    if (Math.abs(leap) > 4 && i + 2 < mel.length)   /* a leap into the note before the final tonic may land on it: cadences leap to the tonic */ { const nxt = mel[i + 1].pitch - mel[i].pitch; if (!(Math.abs(nxt) <= 2 && Math.sign(nxt) === -Math.sign(leap))) unresolved++; } }
  const degs = p.chords.map((c) => c.degree); let legal = degs[0] === 0;
  for (let i = 1; i < degs.length; i++) legal = legal && TRANSITIONS[degs[i - 1]].some(([to]) => to === degs[i]);
  const res = {
    melodyNotes: mel.length, inKey: +inKey.toFixed(3), strongBeatChordTones: +chordTone.toFixed(3), maxLeapSemitones: maxLeap, unresolvedLeaps: unresolved,
    startsOnTonicChord: degs[0] === 0, cadenceVI: degs.at(-2) === 4 && degs.at(-1) === 0, legalProgression: legal,
    endsOnTonic: pc(mel.at(-1).pitch) === pc(p.tonic), rangeSemitones: Math.max(...mel.map((n) => n.pitch)) - Math.min(...mel.map((n) => n.pitch)),
    barsFilled: p.melody.every((n) => n.start + n.dur <= p.bars * 4 + 1e-9) && Math.abs(mel.reduce((s, n) => s + n.dur, 0) - p.bars * 4) < 1e-9,
  };
  res.ok = res.inKey === 1 && res.strongBeatChordTones >= 0.8 && res.unresolvedLeaps === 0 && res.startsOnTonicChord && res.cadenceVI && res.legalProgression && res.endsOnTonic && res.barsFilled && res.rangeSemitones <= 24;
  return res;
}

// ---------- MIDI (SMF format 1, 480 ticks per quarter) ----------
const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
const TPQ = 480;
function track(events) { // events: [tick, bytes[]]
  events.sort((a, b) => a[0] - b[0] || (a[1][0] & 0xf0) - (b[1][0] & 0xf0)); // note-offs (0x80) before note-ons (0x90) at the same tick
  let last = 0; const out = [];
  for (const [t, bytes] of events) { out.push(...vlq(t - last), ...bytes); last = t; }
  out.push(0, 0xff, 0x2f, 0); const body = Buffer.from(out); const h = Buffer.alloc(8); h.write('MTrk'); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]);
}
export function toMidi(p) {
  const mpq = Math.round(60000000 / p.tempo);
  const meta = track([[0, [0xff, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255]], [0, [0xff, 0x58, 4, 4, 2, 24, 8]]]);
  const mk = (notes, ch, prog, vel) => { const ev = [[0, [0xc0 | ch, prog]]]; for (const n of notes) { const on = Math.round(n.start * TPQ), off = Math.round((n.start + n.dur) * TPQ) - 2; ev.push([on, [0x90 | ch, n.pitch, vel]], [off, [0x80 | ch, n.pitch, 0]]); } return track(ev); };
  const chordNotes = p.chords.flatMap((c) => c.pitches.map((pitch) => ({ pitch, start: c.start, dur: c.dur })));
  const tracks = [meta, mk(p.melody, 0, 0, 96), mk(chordNotes, 1, 48, 56), mk(p.bass, 2, 32, 80)];
  const head = Buffer.alloc(14); head.write('MThd'); head.writeUInt32BE(6, 4); head.writeUInt16BE(1, 8); head.writeUInt16BE(tracks.length, 10); head.writeUInt16BE(TPQ, 12);
  return Buffer.concat([head, ...tracks]);
}
/** Minimal reader used by the tests: returns {format, tracks, ticksPerQuarter, notes per track}. */
export function readMidi(buf) {
  if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('not MIDI');
  const nt = buf.readUInt16BE(10), tpq = buf.readUInt16BE(12); let p = 14; const tracks = [];
  for (let k = 0; k < nt; k++) {
    if (buf.toString('ascii', p, p + 4) !== 'MTrk') throw new Error('bad track'); const len = buf.readUInt32BE(p + 4); let q = p + 8; const end = q + len; let t = 0, run = 0; const notes = [];
    const rv = () => { let v = 0, b; do { b = buf[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (q < end) { t += rv(); let s = buf[q]; if (s === 0xff) { q += 2 + buf[q + 1] + (buf[q + 1] > 127 ? 0 : 0); continue; } if (s & 0x80) { run = s; q++; } s = run;
      const typ = s & 0xf0; if (typ === 0xc0) q++; else { const a = buf[q++], b = buf[q++]; if (typ === 0x90 && b > 0) notes.push({ tick: t, pitch: a }); } }
    tracks.push(notes); p = end;
  }
  return { format: buf.readUInt16BE(8), ticksPerQuarter: tpq, tracks };
}

// ---------- audio rendering ----------
export function render(p, sr = 22050) {
  const spb = 60 / p.tempo, total = Math.ceil((p.bars * 4 * spb + 1.5) * sr), out = new Float32Array(total);
  const voice = (n, amp, bright) => {
    const f = 440 * 2 ** ((n.pitch - 69) / 12), s0 = Math.floor(n.start * spb * sr), len = Math.floor((n.dur * spb + 0.25) * sr), dec = 1 / (n.dur * spb * 0.8 + 0.1);
    for (let i = 0; i < len && s0 + i < total; i++) { const t = i / sr; const env = Math.min(1, t / 0.01) * Math.exp(-t * dec) * (i > len - 0.05 * sr ? (len - i) / (0.05 * sr) : 1);
      let v = Math.sin(2 * Math.PI * f * t); v += bright * 0.5 * Math.sin(4 * Math.PI * f * t) + bright * 0.25 * Math.sin(6 * Math.PI * f * t); out[s0 + i] += amp * env * v; }
  };
  p.melody.forEach((n) => voice(n, 0.30, 0.8)); p.chords.forEach((c) => c.pitches.forEach((pitch) => voice({ pitch, start: c.start, dur: c.dur }, 0.09, 0.2))); p.bass.forEach((n) => voice(n, 0.22, 0.3));
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v)); if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.8;
  return { samples: out, sr };
}
export const toWav = (p, sr) => { const r = render(p, sr); return writeWav(r.samples, r.sr); };

/** Human-readable score + the reasoning behind each choice. */
export function describe(p) {
  const a = analyze(p);
  return [`seed ${p.seed}: ${noteName(p.tonic)} ${p.mode}, ${p.tempo} bpm, ${p.bars} bars of 4/4`, `progression: ${p.progression.join(' - ')}`,
    `melody: ${p.melody.map((n) => noteName(n.pitch)).join(' ')}`, `checks: ${a.ok ? 'all rules hold' : 'RULE VIOLATION'} ${JSON.stringify(a)}`].join('\n');
}
