// Learn to recognise the KEY and MODE of music from audio, using the composer as a labelled-data factory.
// The generator knows every piece's tonic and mode exactly, so labels are free and perfect. What is learned: for each mode,
// the average pitch-class energy profile ("chroma") measured relative to the tonic. A new clip is classified by trying all 12
// tonics against all mode profiles and taking the best correlation. Honest limit: trained and tested on the composer's own
// synthetic sound; no claim is made about real recordings.
import { compose, SCALES, toWav, render } from './compose.mjs';

const FFT_N = 4096;
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
}
/** 12-bin pitch-class profile (C=0) summed over frames, 55-2000 Hz, normalised to sum 1. */
export function chroma(x, sr, hop = 2048) {
  const win = Float32Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1)));
  const pc = new Float64Array(12); const binPc = new Int8Array(FFT_N / 2).fill(-1);
  for (let k = 1; k < FFT_N / 2; k++) { const f = k * sr / FFT_N; if (f >= 55 && f <= 2000) binPc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12; }
  for (let s = 0; s + FFT_N <= x.length; s += hop) {
    const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N); for (let i = 0; i < FFT_N; i++) re[i] = x[s + i] * win[i]; fft(re, im);
    for (let k = 1; k < FFT_N / 2; k++) if (binPc[k] >= 0) pc[binPc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  const tot = pc.reduce((a, b) => a + b, 0) || 1; return Array.from(pc, (v) => v / tot);
}
const rot = (v, k) => v.map((_, i) => v[(i + k) % 12]);          // profile relative to tonic k: rot(chroma, tonic)[0] is the tonic energy
const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length; let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
export const MODES = ['major', 'minor', 'dorian', 'mixolydian'];

/** Training example from a seed: audio rendered by the composer -> chroma, labelled with the true tonic pitch class and mode. */
export function example(seed, sr = 11025, bars = 8) {
  const p = compose({ seed, bars }); const r = render(p, sr); return { seed, chroma: chroma(r.samples, sr), tonic: p.tonic % 12, mode: p.mode };
}
export function trainKeyModel(examples) {
  const profiles = {}; for (const m of MODES) { const rows = examples.filter((e) => e.mode === m).map((e) => rot(e.chroma, e.tonic)); profiles[m] = rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length); }
  return { type: 'key-mode-profiles', modes: MODES, profiles };
}
/** Untrained comparison: theory-only templates (1 for scale tones, 0 otherwise). */
export function theoryModel() { const profiles = {}; for (const m of MODES) { const v = new Array(12).fill(0); for (const s of SCALES[m]) v[s] = 1; profiles[m] = v; } return { type: 'key-mode-theory', modes: MODES, profiles }; }
export function predictKey(model, ch) {
  let best = null; for (const m of model.modes) for (let t = 0; t < 12; t++) { const c = corr(rot(ch, t), model.profiles[m]); if (!best || c > best.score) best = { tonic: t, mode: m, score: c }; } return best;
}
export function evaluateKeyModel(model, examples) {
  let key = 0, tonic = 0, mode = 0, relative = 0; const conf = {};
  for (const e of examples) { const p = predictKey(model, e.chroma); const okT = p.tonic === e.tonic, okM = p.mode === e.mode; if (okT) tonic++; if (okM) mode++; if (okT && okM) key++;
    (conf[e.mode] ||= {})[p.mode] = (conf[e.mode][p.mode] || 0) + 1; }
  const n = examples.length; return { accuracy: +(key / n).toFixed(4), tonic: +(tonic / n).toFixed(4), mode: +(mode / n).toFixed(4), confusion: conf, n };
}
