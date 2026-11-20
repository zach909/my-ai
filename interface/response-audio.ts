/**
 * A spoken copy of a reply: response/reply.wav.
 *
 * Written from scratch on Node built-ins, no speech library and no model: a small formant synthesizer. It is NOT the mesh
 * speaking. The mesh has no audio output trained into it (the Zip Loop gives it raw bits and nothing has taught it to emit
 * sound), so until it does, this renders the reply text letter by letter:
 *
 *   vowels       a buzz at the voice's pitch through three resonators set to that vowel's formants
 *   l r w y m n  the same buzz with the formants of that sound (nasals are darker and quieter)
 *   s f h z v x  filtered noise (z and v add the buzz)
 *   p t k b d g  a short silence, then a burst (b d g add the buzz)
 *   digits       spoken as their names
 *   space, marks short pauses; a full stop, question or exclamation mark a longer one
 *
 * That is robotic and only partly intelligible, and it says so rather than pretending. The output is plain 16-bit mono PCM
 * in a WAV container and is the same bytes for the same text, so a reply can be checked by hash. `renderSpeechWav` is the
 * single seam: when the mesh can emit audio bits of its own, it is replaced there and nothing else changes.
 */

export const SAMPLE_RATE = 16_000;
/** Longest clip made; the text past this point is left unspoken. */
export const MAX_SECONDS = 120;

interface Phone {
  /** Formants in Hz (voiced sounds). */
  f?: [number, number, number];
  /** Bandwidths in Hz. */
  bw?: [number, number, number];
  voiced?: boolean;
  /** Noise: [low edge, high edge] in Hz. */
  noise?: [number, number];
  /** Stop: silence in ms before the burst. */
  stop?: number;
  ms: number;
  gain: number;
}

const V = (f: [number, number, number], ms = 115, gain = 1): Phone => ({ f, bw: [70, 90, 120], voiced: true, ms, gain });
const PHONES: Record<string, Phone> = {
  a: V([730, 1090, 2440]), e: V([530, 1840, 2480]), i: V([270, 2290, 3010]), o: V([570, 840, 2410]), u: V([300, 870, 2240]),
  y: V([270, 2100, 2900], 90, 0.8),
  l: V([360, 1300, 2800], 80, 0.75), r: V([310, 1060, 1380], 85, 0.75), w: V([290, 610, 2150], 80, 0.75),
  m: { f: [250, 1000, 2100], bw: [60, 150, 200], voiced: true, ms: 85, gain: 0.5 },
  n: { f: [250, 1500, 2500], bw: [60, 150, 200], voiced: true, ms: 80, gain: 0.5 },
  s: { noise: [4500, 7500], ms: 95, gain: 0.35 }, z: { noise: [4000, 7200], voiced: true, f: [250, 1500, 2500], bw: [80, 200, 300], ms: 90, gain: 0.35 },
  f: { noise: [1500, 7000], ms: 85, gain: 0.22 }, v: { noise: [1500, 6000], voiced: true, f: [250, 1100, 2200], bw: [80, 200, 300], ms: 80, gain: 0.25 },
  h: { noise: [500, 4500], ms: 70, gain: 0.2 }, x: { noise: [3500, 7500], ms: 100, gain: 0.3 },
  p: { noise: [800, 4000], stop: 40, ms: 20, gain: 0.3 }, t: { noise: [3000, 7000], stop: 35, ms: 18, gain: 0.3 }, k: { noise: [1200, 3500], stop: 40, ms: 25, gain: 0.3 },
  b: { noise: [300, 2500], stop: 35, ms: 22, gain: 0.35, voiced: true, f: [250, 900, 2200], bw: [80, 150, 250] },
  d: { noise: [1500, 5000], stop: 30, ms: 20, gain: 0.35, voiced: true, f: [250, 1700, 2600], bw: [80, 150, 250] },
  g: { noise: [800, 3000], stop: 35, ms: 24, gain: 0.35, voiced: true, f: [250, 1300, 2300], bw: [80, 150, 250] },
};
const ALIASES: Record<string, string> = { c: "k", q: "k", j: "d" };
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** What is spoken: markers, code and symbols out, digits spelled, nothing the reader would not hear. */
export function speakable(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[0-9]/g, d => ` ${DIGITS[Number(d)]} `)
    .replace(/[*_#>`~|\\/<>=+^{}[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Two-pole resonator. */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  private readonly a: number;
  private readonly b1: number;
  private readonly b2: number;
  constructor(freq: number, bw: number, fs: number) {
    const r = Math.exp((-Math.PI * bw) / fs);
    this.b1 = 2 * r * Math.cos((2 * Math.PI * freq) / fs);
    this.b2 = -r * r;
    this.a = 1 - this.b1 - this.b2;
  }
  step(x: number): number {
    const y = this.a * x + this.b1 * this.y1 + this.b2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Deterministic noise in [-1, 1). */
function noiseSource(seed = 0x2545f491): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

/** Band-limited noise: a high-pass and a low-pass one-pole each. */
function bandNoise(next: () => number, lo: number, hi: number, fs: number): () => number {
  const hp = Math.exp((-2 * Math.PI * lo) / fs);
  const lp = Math.exp((-2 * Math.PI * hi) / fs);
  let l = 0;
  let h = 0;
  return () => {
    const x = next();
    l = (1 - lp) * x + lp * l; // below hi
    h = (1 - hp) * l + hp * h; // below lo
    return l - h; // between lo and hi
  };
}

const PAUSE_MS = { word: 70, comma: 150, stop: 280 };

/** Plain 16-bit mono PCM WAV of the text spoken by the synthesizer above, or null if there is nothing to say. */
export function renderSpeechWav(text: string, opts: { sampleRate?: number; maxSeconds?: number } = {}): Buffer | null {
  const fs = opts.sampleRate ?? SAMPLE_RATE;
  const limit = Math.floor(fs * (opts.maxSeconds ?? MAX_SECONDS));
  const say = speakable(text).toLowerCase();
  if (!/[a-z]/.test(say)) return null;

  const next = noiseSource();
  const out: number[] = [];
  const silence = (ms: number) => { for (let i = 0, n = Math.round((fs * ms) / 1000); i < n && out.length < limit; i++) out.push(0); };

  // Pitch falls a little across each sentence and starts again at the next one.
  let sentenceStart = 0;
  let sentenceChars = Math.max(1, say.slice(0).search(/[.!?]/) + 1 || say.length);
  let phase = 0;

  for (let ci = 0; ci < say.length && out.length < limit; ci++) {
    const ch = say[ci];
    if (ch === " ") { silence(PAUSE_MS.word); continue; }
    if (ch === "," || ch === ";" || ch === ":") { silence(PAUSE_MS.comma); continue; }
    if (ch === "." || ch === "!" || ch === "?") {
      silence(PAUSE_MS.stop);
      sentenceStart = ci + 1;
      const rest = say.slice(sentenceStart).search(/[.!?]/);
      sentenceChars = Math.max(1, rest < 0 ? say.length - sentenceStart : rest + 1);
      continue;
    }
    const ph = PHONES[ALIASES[ch] ?? ch];
    if (!ph) continue;

    if (ph.stop) silence(ph.stop);
    const n = Math.round((fs * ph.ms) / 1000);
    const pos = Math.min(1, (ci - sentenceStart) / sentenceChars);
    const pitch = 125 - 22 * pos; // Hz
    const res = ph.f && ph.bw ? ph.f.map((f, k) => new Resonator(f, ph.bw![k], fs)) : [];
    const gains = [1, 0.6, 0.3];
    const noise = ph.noise ? bandNoise(next, ph.noise[0], ph.noise[1], fs) : null;
    const attack = Math.max(1, Math.round(fs * 0.008));

    for (let i = 0; i < n && out.length < limit; i++) {
      let s = 0;
      if (ph.voiced) {
        phase += pitch / fs;
        if (phase >= 1) phase -= 1;
        // A pulse: a rising ramp that falls away sharply, which has the many harmonics a throat does.
        const pulse = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) ** 2 : 0;
        const buzz = (pulse - 0.2) * (ph.noise ? 0.6 : 1);
        for (let k = 0; k < res.length; k++) s += gains[k] * res[k].step(buzz);
      }
      if (noise) s += noise() * (ph.voiced ? 0.8 : 3);
      const env = Math.min(1, (i + 1) / attack, (n - i) / attack);
      out.push(s * ph.gain * env);
    }
  }
  if (out.length === 0) return null;

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.8 / peak : 0;
  const data = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * scale * 32767))), i * 2);

  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(fs, 24);
  head.writeUInt32LE(fs * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
