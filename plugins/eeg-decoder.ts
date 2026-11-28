/**
 * EEG decoder: turns recorded or simulated EEG samples into a short list of
 * events the agent can read.
 *
 * What this really does, so nobody expects more: it measures the electrical
 * signal. Per window it finds how strong each brain-wave band is (delta, theta,
 * alpha, beta, gamma), scores focus / relaxation / drowsiness from the band
 * ratios, and spots eye blinks and jaw clenches (muscle artefacts). It cannot
 * read thoughts or words. Imagery commands would need a per-person trained
 * classifier and are not part of this.
 *
 * Pure and dependency-free: Node/JS maths only (own radix-2 FFT), no packages,
 * no file or network access. The plugin (eeg.ts) does the reading.
 */

export type EegBand = "delta" | "theta" | "alpha" | "beta" | "gamma";

export const BANDS: Record<EegBand, [number, number]> = {
  delta: [0.5, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 45],
};

export type BrainState = "relaxed" | "focused" | "drowsy" | "mixed";

export interface EegRecording {
  /** One array per channel, all the same length. */
  channels: number[][];
  sampleRate: number;
}

export interface EegWindow {
  /** Start time of the window in seconds. */
  t: number;
  /** Share of power in each band, summing to 1. */
  bands: Record<EegBand, number>;
  state: BrainState;
  /** 0..1 each. */
  focus: number;
  relaxation: number;
  drowsiness: number;
  blink: boolean;
  clench: boolean;
}

export type EegEventKind = "state" | "blink" | "clench";

export interface EegEvent {
  t: number;
  kind: EegEventKind;
  /** For "state": the new state. Otherwise the kind itself. */
  label: string;
}

export interface EegDecoding {
  sampleRate: number;
  seconds: number;
  channels: number;
  windows: EegWindow[];
  events: EegEvent[];
  /** Mean band shares over the whole recording. */
  average: Record<EegBand, number>;
}

export const MAX_SAMPLES = 2_000_000;
export const MIN_SAMPLE_RATE = 64;
export const MAX_SAMPLE_RATE = 2000;
const WINDOW_SECONDS = 2;
const HOP_SECONDS = 1;

export class EegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EegError";
  }
}

// ---------------------------------------------------------------- parsing

/**
 * Parse CSV/TSV/whitespace text: one row per sample, one column per channel.
 * A leading `# fs=256` (or `# sample_rate=256`) comment sets the rate, else
 * `defaultRate`. Rows with a header or non-numeric cells are skipped, and so
 * is a first column that is a plain time axis (0, 1, 2... or steadily
 * increasing by 1/fs) when other columns exist.
 */
export function parseEegText(text: string, defaultRate = 256): EegRecording {
  let rate = defaultRate;
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /(?:fs|sample[_ ]?rate|hz)\s*[=:]\s*([0-9.]+)/i.exec(line);
      if (m) rate = Number(m[1]);
      continue;
    }
    const cells = line.split(/[\s,;]+/);
    const nums = cells.map(Number);
    if (nums.some(n => !Number.isFinite(n))) continue;
    rows.push(nums);
    if (rows.length > MAX_SAMPLES) throw new EegError(`Too many samples (limit ${MAX_SAMPLES}).`);
  }
  if (!Number.isFinite(rate) || rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
    throw new EegError(`Sample rate must be ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz (got ${rate}).`);
  }
  if (rows.length < rate * WINDOW_SECONDS) {
    throw new EegError(`Need at least ${WINDOW_SECONDS} seconds of samples (${Math.ceil(rate * WINDOW_SECONDS)} rows at ${rate} Hz); found ${rows.length}.`);
  }
  const width = rows[0].length;
  if (rows.some(r => r.length !== width)) throw new EegError("Rows have different numbers of columns.");

  let first = 0;
  if (width > 1 && looksLikeTimeAxis(rows.map(r => r[0]), rate)) first = 1;
  const channels: number[][] = [];
  for (let c = first; c < width; c++) channels.push(rows.map(r => r[c]));
  return { channels, sampleRate: rate };
}

function looksLikeTimeAxis(col: number[], fs: number): boolean {
  const n = Math.min(col.length - 1, 50);
  if (n < 5) return false;
  const step = col[1] - col[0];
  if (step <= 0) return false;
  for (let i = 1; i <= n; i++) if (Math.abs(col[i] - col[i - 1] - step) > step * 1e-3) return false;
  // Index (step 1) or seconds (step 1/fs) or ms (step 1000/fs).
  return [1, 1 / fs, 1000 / fs].some(s => Math.abs(step - s) <= s * 0.01);
}

// ---------------------------------------------------------------- maths

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
}

/** Absolute power per band for one window of one channel (mean removed, Hann windowed). */
export function bandPower(samples: ArrayLike<number>, fs: number): Record<EegBand, number> {
  const n = samples.length;
  const size = nextPow2(n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const m = mean(samples);
  for (let i = 0; i < n; i++) re[i] = (samples[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const out: Record<EegBand, number> = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  const binHz = fs / size;
  for (let k = 1; k < size / 2; k++) {
    const f = k * binHz;
    const p = re[k] * re[k] + im[k] * im[k];
    for (const b of Object.keys(BANDS) as EegBand[]) {
      const [lo, hi] = BANDS[b];
      if (f >= lo && f < hi) { out[b] += p; break; }
    }
  }
  return out;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------- decoding

/**
 * Decode a recording. Channels are averaged for band power (a single
 * "overall" trace); blinks are judged on each window's peak-to-peak swing
 * against the recording's own typical swing, so there is no fixed microvolt
 * threshold to get wrong for a different amplifier.
 */
export function decodeEeg(rec: EegRecording): EegDecoding {
  const fs = rec.sampleRate;
  const len = rec.channels[0]?.length ?? 0;
  if (!rec.channels.length || len < fs * WINDOW_SECONDS) throw new EegError("Recording is too short to decode.");
  const win = Math.round(fs * WINDOW_SECONDS);
  const hop = Math.round(fs * HOP_SECONDS);

  const starts: number[] = [];
  for (let s = 0; s + win <= len; s += hop) starts.push(s);

  const raw = starts.map(s => {
    const sums: Record<EegBand, number> = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    let swing = 0;
    for (const ch of rec.channels) {
      const slice = ch.slice(s, s + win);
      const bp = bandPower(slice, fs);
      for (const b of Object.keys(bp) as EegBand[]) sums[b] += bp[b];
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of slice) { if (v < lo) lo = v; if (v > hi) hi = v; }
      swing = Math.max(swing, hi - lo);
    }
    return { s, sums, swing };
  });

  const typicalSwing = median(raw.map(r => r.swing)) || 1;
  const typicalGamma = median(raw.map(r => {
    const t = r.sums.delta + r.sums.theta + r.sums.alpha + r.sums.beta + r.sums.gamma;
    return t > 0 ? r.sums.gamma / t : 0;
  }));

  const windows: EegWindow[] = raw.map(r => {
    const total = r.sums.delta + r.sums.theta + r.sums.alpha + r.sums.beta + r.sums.gamma || 1;
    const bands = {} as Record<EegBand, number>;
    for (const b of Object.keys(BANDS) as EegBand[]) bands[b] = r.sums[b] / total;

    const blink = r.swing > typicalSwing * 3 && bands.delta + bands.theta > 0.5;
    const clench = bands.gamma > Math.max(0.25, typicalGamma * 3);

    const focus = clamp01(bands.beta / (bands.alpha + bands.theta + bands.beta || 1) * 1.5 - 0.15);
    const relaxation = clamp01(bands.alpha / (bands.alpha + bands.beta + bands.theta || 1) * 1.5 - 0.15);
    const drowsiness = clamp01((bands.theta + bands.delta * 0.5) / (bands.theta + bands.alpha + bands.beta || 1) * 1.5 - 0.15);

    // Ignore delta and gamma for the label: they carry blinks and muscle noise.
    const best = Math.max(focus, relaxation, drowsiness);
    let state: BrainState = "mixed";
    if (best >= 0.45) {
      const winners = [focus, relaxation, drowsiness].filter(v => best - v < 0.05).length;
      if (winners === 1) state = best === focus ? "focused" : best === relaxation ? "relaxed" : "drowsy";
    }
    return { t: r.s / fs, bands, state, focus, relaxation, drowsiness, blink, clench };
  });

  const events: EegEvent[] = [];
  let prev: BrainState | null = null;
  let prevBlink = false;
  let prevClench = false;
  for (const w of windows) {
    // A blink or clench window smears the band mix, so judge state only on clean windows.
    if (!w.blink && !w.clench && w.state !== prev) {
      events.push({ t: w.t, kind: "state", label: w.state });
      prev = w.state;
    }
    if (w.blink && !prevBlink) events.push({ t: w.t, kind: "blink", label: "blink" });
    if (w.clench && !prevClench) events.push({ t: w.t, kind: "clench", label: "clench" });
    prevBlink = w.blink;
    prevClench = w.clench;
  }

  const average = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 } as Record<EegBand, number>;
  for (const w of windows) for (const b of Object.keys(average) as EegBand[]) average[b] += w.bands[b] / windows.length;

  return { sampleRate: fs, seconds: len / fs, channels: rec.channels.length, windows, events, average };
}

// ---------------------------------------------------------------- output

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A short human-readable report. Capped so a long recording cannot flood a chat. */
export function describeDecoding(d: EegDecoding, maxEvents = 20): string {
  const a = d.average;
  const lines = [
    `Decoded ${d.seconds.toFixed(1)} s of EEG (${d.channels} channel${d.channels === 1 ? "" : "s"}, ${d.sampleRate} Hz).`,
    `Average band power: delta ${pct(a.delta)}, theta ${pct(a.theta)}, alpha ${pct(a.alpha)}, beta ${pct(a.beta)}, gamma ${pct(a.gamma)}.`,
  ];
  const counts: Record<BrainState, number> = { relaxed: 0, focused: 0, drowsy: 0, mixed: 0 };
  for (const w of d.windows) counts[w.state]++;
  const total = d.windows.length || 1;
  lines.push(`Time in state: ${(Object.keys(counts) as BrainState[]).map(k => `${k} ${pct(counts[k] / total)}`).join(", ")}.`);
  if (d.events.length === 0) {
    lines.push("No events.");
  } else {
    lines.push("Events:");
    for (const e of d.events.slice(0, maxEvents)) lines.push(`  ${e.t.toFixed(0)}s ${e.kind === "state" ? `state -> ${e.label}` : e.label}`);
    if (d.events.length > maxEvents) lines.push(`  ...and ${d.events.length - maxEvents} more.`);
  }
  lines.push("This measures signal patterns only; it cannot tell what you are thinking.");
  return lines.join("\n");
}

/**
 * Pack events as raw bytes for the bit-level path (no tokenizer): per event
 * 4 bytes = u16 seconds (big-endian, clamped), u8 kind, u8 label code.
 */
export function eventsToBytes(events: EegEvent[]): Uint8Array {
  const kinds: Record<EegEventKind, number> = { state: 1, blink: 2, clench: 3 };
  const labels: Record<string, number> = { relaxed: 1, focused: 2, drowsy: 3, mixed: 4, blink: 5, clench: 6 };
  const out = new Uint8Array(events.length * 4);
  events.forEach((e, i) => {
    const t = Math.min(65535, Math.max(0, Math.round(e.t)));
    out[i * 4] = t >> 8;
    out[i * 4 + 1] = t & 255;
    out[i * 4 + 2] = kinds[e.kind];
    out[i * 4 + 3] = labels[e.label] ?? 0;
  });
  return out;
}

// ---------------------------------------------------------------- simulation

/** Small seeded PRNG (mulberry32) so a demo is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SimSegment = { state: "relaxed" | "focused" | "drowsy"; seconds: number; blinkAt?: number[]; clenchAt?: number[] };

const SIM_MIX: Record<SimSegment["state"], Record<EegBand, number>> = {
  relaxed: { delta: 4, theta: 4, alpha: 20, beta: 5, gamma: 0.6 },
  focused: { delta: 3, theta: 3, alpha: 5, beta: 16, gamma: 1.2 },
  drowsy: { delta: 9, theta: 16, alpha: 5, beta: 3, gamma: 0.4 },
};
const SIM_FREQ: Record<EegBand, number[]> = {
  delta: [2], theta: [6], alpha: [10, 11], beta: [18, 22], gamma: [35],
};

/** Synthetic single-channel EEG: sinusoids per band plus noise, with optional blinks and clenches. */
export function simulateEeg(segments: SimSegment[], sampleRate = 256, seed = 1): EegRecording {
  const rand = rng(seed);
  const samples: number[] = [];
  let offset = 0;
  for (const seg of segments) {
    const n = Math.round(seg.seconds * sampleRate);
    const mix = SIM_MIX[seg.state];
    const phases: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const t = (offset + i) / sampleRate;
      let v = 0;
      for (const b of Object.keys(mix) as EegBand[]) {
        for (const f of SIM_FREQ[b]) {
          const key = `${b}${f}`;
          phases[key] ??= rand() * 2 * Math.PI;
          v += (mix[b] / SIM_FREQ[b].length) * Math.sin(2 * Math.PI * f * t + phases[key]);
        }
      }
      v += (rand() - 0.5) * 2;
      samples.push(v);
    }
    for (const at of seg.blinkAt ?? []) addBlink(samples, Math.round((offset / sampleRate + at) * sampleRate), sampleRate);
    for (const at of seg.clenchAt ?? []) addClench(samples, Math.round((offset / sampleRate + at) * sampleRate), sampleRate, rand);
    offset += n;
  }
  return { channels: [samples], sampleRate };
}

function addBlink(samples: number[], at: number, fs: number): void {
  const w = Math.round(fs * 0.3);
  for (let i = 0; i < w; i++) {
    const idx = at + i;
    if (idx >= 0 && idx < samples.length) samples[idx] += 150 * Math.sin((Math.PI * i) / w);
  }
}

function addClench(samples: number[], at: number, fs: number, rand: () => number): void {
  const w = Math.round(fs * 1.5);
  for (let i = 0; i < w; i++) {
    const idx = at + i;
    if (idx >= 0 && idx < samples.length) samples[idx] += 30 * Math.sin(2 * Math.PI * 38 * (idx / fs) + rand());
  }
}

/** The demo recording: relaxed, then focused (with a blink), then drowsy. */
export function demoRecording(sampleRate = 256, seed = 1): EegRecording {
  return simulateEeg(
    [
      { state: "relaxed", seconds: 12 },
      { state: "focused", seconds: 12, blinkAt: [5] },
      { state: "drowsy", seconds: 12 },
    ],
    sampleRate,
    seed,
  );
}
