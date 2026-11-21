// Audio understanding, kept as three separate capabilities (the brief asks for this):
//   recognize(samples, sr)  -> which sound class is this?            (learned: standardised features + kNN / centroid)
//   groupOf(label)          -> which family is it (animal, human...)?  (classification by the ESC-50 group table + ontology)
//   interpret(label)        -> what does it mean / where does it sit in the AudioSet ontology?  (symbolic lookup)
// Pure JS (radix-2 FFT, mel filterbank). No audio libraries. WAV: 16-bit PCM only (what ESC-50 ships).

export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4), b = p + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(b), ch: buf.readUInt16LE(b + 2), sr: buf.readUInt32LE(b + 4), bits: buf.readUInt16LE(b + 14) };
    else if (id === 'data') { data = buf.subarray(b, Math.min(b + sz, buf.length)); break; }
    p = b + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('malformed WAV'); if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM supported');
  const n = Math.floor(data.length / 2 / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2); x[i] = s / fmt.ch / 32768; }
  return { samples: x, sr: fmt.sr };
}
export function writeWav(samples, sr) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)); return b;
}

function fft(re, im) { // in-place iterative radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
const hz2mel = (f) => 2595 * Math.log10(1 + f / 700), mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
function melBank(nMel, nfft, sr) {
  const pts = Array.from({ length: nMel + 2 }, (_, i) => mel2hz(hz2mel(0) + (hz2mel(sr / 2) - hz2mel(0)) * i / (nMel + 1)));
  const bins = pts.map((f) => Math.floor((nfft + 1) * f / sr)); const bank = [];
  for (let m = 1; m <= nMel; m++) { const w = new Float32Array(nfft / 2 + 1); for (let k = bins[m - 1]; k < bins[m]; k++) w[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]); for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]); bank.push(w); }
  return bank;
}
const bankCache = new Map();
export const NMEL = 32;

/** Feature vector: mean + std of log-mel over time (64), temporal-energy stats, zero-crossing rate, spectral centroid/rolloff. */
export function features(x, sr, { nfft = 1024, hop = 512 } = {}) {
  const key = nfft + ':' + sr; if (!bankCache.has(key)) bankCache.set(key, melBank(NMEL, nfft, sr)); const bank = bankCache.get(key);
  const win = Float32Array.from({ length: nfft }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (nfft - 1)));
  const frames = []; const cent = [], roll = [], rms = []; let zc = 0;
  for (let s = 0; s + nfft <= x.length; s += hop) {
    const re = new Float32Array(nfft), im = new Float32Array(nfft); let e = 0;
    for (let i = 0; i < nfft; i++) { re[i] = x[s + i] * win[i]; e += x[s + i] * x[s + i]; }
    for (let i = 1; i < nfft; i++) if ((x[s + i] >= 0) !== (x[s + i - 1] >= 0)) zc++;
    fft(re, im); const mag = new Float32Array(nfft / 2 + 1); let tot = 0, wsum = 0;
    for (let k = 0; k <= nfft / 2; k++) { mag[k] = re[k] * re[k] + im[k] * im[k]; tot += mag[k]; wsum += mag[k] * k; }
    let acc = 0, r = 0; for (let k = 0; k <= nfft / 2; k++) { acc += mag[k]; if (acc >= 0.85 * tot) { r = k; break; } }
    cent.push(tot > 0 ? wsum / tot * sr / nfft : 0); roll.push(r * sr / nfft); rms.push(Math.sqrt(e / nfft));
    frames.push(bank.map((w) => { let a = 0; for (let k = 0; k < w.length; k++) a += w[k] * mag[k]; return Math.log(a + 1e-10); }));
  }
  const T = frames.length; if (!T) throw new Error('clip too short');
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const f = []; for (let m = 0; m < NMEL; m++) { const col = frames.map((r) => r[m]); f.push(mean(col), sd(col)); }
  const lr = rms.map((v) => Math.log(v + 1e-6));
  f.push(mean(lr), sd(lr), Math.max(...lr) - Math.min(...lr), zc / (T * nfft), mean(cent) / sr, sd(cent) / sr, mean(roll) / sr, sd(roll) / sr);
  return f;
}
export function dominantHz(x, sr) {
  const n = 1 << Math.floor(Math.log2(Math.min(x.length, 16384))); const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))); fft(re, im);
  let bi = 1, bv = 0; for (let k = 1; k < n / 2; k++) { const v = re[k] ** 2 + im[k] ** 2; if (v > bv) { bv = v; bi = k; } } return bi * sr / n;
}

// ---- classifier ----
export function fitStandardiser(X) { const d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0); for (const r of X) r.forEach((v, i) => (mu[i] += v / X.length)); for (const r of X) r.forEach((v, i) => (sd[i] += (v - mu[i]) ** 2 / X.length)); return { mu, sd: sd.map((v) => Math.sqrt(v) || 1) }; }
const std = (s, r) => r.map((v, i) => (v - s.mu[i]) / s.sd[i]);
export function trainAudio(X, y, { mode = 'knn', k = 5 } = {}) {
  const s = fitStandardiser(X), Z = X.map((r) => std(s, r)); const classes = [...new Set(y)].sort();
  const model = { type: 'audio-' + mode, std: s, classes, k, features: NMEL * 2 + 8 };
  if (mode === 'knn') { model.X = Z; model.y = y; } else model.centroids = classes.map((c) => { const rows = Z.filter((_, i) => y[i] === c); return rows[0].map((_, j) => rows.reduce((a, r) => a + r[j], 0) / rows.length); });
  return model;
}
const d2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };
export function predictAudio(model, f) {
  const z = std(model.std, f);
  if (model.centroids) { const sc = model.classes.map((c, i) => [c, d2(z, model.centroids[i])]).sort((a, b) => a[1] - b[1]); return { label: sc[0][0], scores: sc }; }
  const nn = model.X.map((r, i) => [model.y[i], d2(z, r)]).sort((a, b) => a[1] - b[1]).slice(0, model.k); const v = {};
  for (const [c, d] of nn) v[c] = (v[c] || 0) + 1 / (1e-6 + d);
  const sc = Object.entries(v).sort((a, b) => b[1] - a[1]); const tot = sc.reduce((a, b) => a + b[1], 0);
  return { label: sc[0][0], scores: sc.map(([c, s]) => [c, s / tot]) };
}
export function confusion(truth, pred, classes) { const m = Object.fromEntries(classes.map((c) => [c, Object.fromEntries(classes.map((d) => [d, 0]))])); truth.forEach((t, i) => m[t][pred[i]]++); return m; }

// ---- classification into families + symbolic interpretation ----
const GROUPS = ['animals', 'natural_soundscapes_and_water', 'human_non_speech', 'interior_domestic', 'exterior_urban'];
export const ESC_ORDER = ['dog', 'rooster', 'pig', 'cow', 'frog', 'cat', 'hen', 'insects', 'sheep', 'crow', 'rain', 'sea_waves', 'crackling_fire', 'crickets', 'chirping_birds', 'water_drops', 'wind', 'pouring_water', 'toilet_flush', 'thunderstorm', 'crying_baby', 'sneezing', 'clapping', 'breathing', 'coughing', 'footsteps', 'laughing', 'brushing_teeth', 'snoring', 'drinking_sipping', 'door_wood_knock', 'mouse_click', 'keyboard_typing', 'door_wood_creaks', 'can_opening', 'washing_machine', 'vacuum_cleaner', 'clock_alarm', 'clock_tick', 'glass_breaking', 'helicopter', 'chainsaw', 'siren', 'car_horn', 'engine', 'train', 'church_bells', 'airplane', 'fireworks', 'hand_saw'];
export const groupOf = (label) => { const i = ESC_ORDER.indexOf(label); return i < 0 ? null : GROUPS[Math.floor(i / 10)]; };
const ONT_NAME = { dog: 'Dog', rooster: 'Chicken, rooster', rain: 'Rain', crying_baby: 'Baby cry, infant cry', siren: 'Siren', keyboard_typing: 'Typing', cat: 'Cat', crow: 'Crow', thunderstorm: 'Thunderstorm', laughing: 'Laughter', coughing: 'Cough', sneezing: 'Sneeze', clapping: 'Clapping', helicopter: 'Helicopter', train: 'Train', clock_alarm: 'Alarm clock', car_horn: 'Vehicle horn, car horn, honking' };
/** Symbolic interpretation: link a recognised class to its place in the AudioSet ontology (is_a chain) using the extracted KB. */
export function interpret(label, ontology /* {byName: Map(name->entry), parents: Map(mid->[mid]) , byMid}*/) {
  const name = ONT_NAME[label]; if (!name || !ontology) return { label, ontology: null };
  const e = ontology.byName.get(name); if (!e) return { label, ontology: null, note: `no ontology class named "${name}"` };
  const chain = []; let cur = e; const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur.name); const par = ontology.parents.get(cur.id)?.[0]; cur = par && ontology.byMid.get(par); }
  return { label, ontology: e.name, path: chain.reverse(), description: e.description };
}
export function loadOntology(list) {
  const byName = new Map(list.map((c) => [c.name, c])), byMid = new Map(list.map((c) => [c.id, c])), parents = new Map();
  for (const c of list) for (const ch of c.child_ids) { if (!parents.has(ch)) parents.set(ch, []); parents.get(ch).push(c.id); }
  return { byName, byMid, parents };
}

// ---- synthetic signals (for offline tests) ----
export const tone = (hz, sr, sec, amp = 0.5) => Float32Array.from({ length: Math.floor(sr * sec) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));
export function noise(sr, sec, amp = 0.3, seed = 1) { let s = seed >>> 0; return Float32Array.from({ length: Math.floor(sr * sec) }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return amp * (s / 2147483648 - 1); }); }
