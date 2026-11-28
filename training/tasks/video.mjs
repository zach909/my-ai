/**
 * video.mjs -- video TASKS with LIVE CAPTIONS built into every video. Own code, Node built-ins only.
 *
 * A video is 8 frames of 16x16 RGB (raw bytes) with a coloured square moving across a black background. The generator
 * knows the truth (hue, direction, speed), so every video has exact labels and an exact caption for every frame.
 *
 * Live captions, defined precisely:
 *   - a caption track is part of the video sample (`packVideo`): the frame bytes, then one length-prefixed UTF-8 caption
 *     per frame. The captions are written by the generator from what it knows. They are NOT speech-to-text, and no
 *     recogniser or outside model makes them (CLAUDE.md bans those).
 *   - "live" means causal: caption(t) may use frames 0..t only, never a later one. Frame 0 can only say what colour it
 *     sees; from frame 1 there is motion to read. `causalityCheck` proves it by changing the future and confirming the
 *     caption does not move.
 *
 * Tasks (graded exact-match, on hue/direction combinations never seen together in training):
 *   hue, direction, speed (one classifier each) and `caption`: the whole caption string for every frame.
 */
import { Rng } from '../simulation/random.mjs'
import { trainSoftmax, predict, score } from './learn.mjs'

export const W = 16, H = 16, T = 8, DOT = 2
export const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']
export const DIRS = ['right', 'left', 'down', 'up']
export const SPEEDS = [1, 2]
const SPEED_WORD = { 1: 'slow', 2: 'fast' }
const VEC = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] }

function hueRgb(i) {
  const h = i * 60, s = 0.8, v = 0.9
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255))
}

/** The caption for frame t: only what a viewer who has seen frames 0..t could say. */
export function captionFor({ hue, dir, speed }, t) {
  return t === 0 ? `${HUES[hue]} square` : `${HUES[hue]} square moving ${DIRS[dir]} ${SPEED_WORD[SPEEDS[speed]]}`
}

export function makeVideo(rng, { hue, dir, speed, noise = 0 }) {
  const [dx, dy] = VEC[DIRS[dir]], sp = SPEEDS[speed], rgb = hueRgb(hue)
  const span = W - DOT
  const x0 = dx > 0 ? 0 : dx < 0 ? span : rng.int(span + 1)
  const y0 = dy > 0 ? 0 : dy < 0 ? span : rng.int(span + 1)
  const frames = new Uint8Array(T * H * W * 3)
  for (let t = 0; t < T; t++) {
    const px = x0 + dx * sp * t, py = y0 + dy * sp * t
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const on = x >= px && x < px + DOT && y >= py && y < py + DOT
      for (let c = 0; c < 3; c++) {
        const v = (on ? rgb[c] : 0) + (noise ? (rng.next() * 2 - 1) * noise * 60 : 0)
        frames[((t * H + y) * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)))
      }
    }
  }
  const labels = { hue, dir, speed }
  return { frames, labels, captions: Array.from({ length: T }, (_, t) => captionFor(labels, t)) }
}

/** One sample = frame bytes followed by the caption track (1 length byte + UTF-8 per frame). Captions travel with the video. */
export function packVideo(v) {
  const caps = v.captions.map((c) => Buffer.from(c, 'utf8'))
  const out = new Uint8Array(v.frames.length + caps.reduce((a, c) => a + 1 + c.length, 0))
  out.set(v.frames, 0)
  let p = v.frames.length
  for (const c of caps) { out[p++] = c.length; out.set(c, p); p += c.length }
  return out
}
export function unpackVideo(bytes) {
  const frames = bytes.slice(0, T * H * W * 3), captions = []
  let p = frames.length
  while (p < bytes.length) { const n = bytes[p++]; captions.push(Buffer.from(bytes.slice(p, p + n)).toString('utf8')); p += n }
  return { frames, captions }
}

const frameAt = (frames, t) => frames.subarray(t * H * W * 3, (t + 1) * H * W * 3)
function lit(frame) {
  let n = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0
  for (let i = 0; i < H * W; i++) {
    const R = frame[i * 3], G = frame[i * 3 + 1], B = frame[i * 3 + 2]
    if (Math.max(R, G, B) > 100) { n++; sx += i % W; sy += Math.floor(i / W); r += R; g += G; b += B }
  }
  return n ? { cx: sx / n, cy: sy / n, rgb: [r / n, g / n, b / n] } : null
}

/** Causal features: only frames 0..t are read. `colour` comes from frame 0, `motion` from displacement up to t. */
export function featuresUpTo(frames, t) {
  const f0 = lit(frameAt(frames, 0)), ft = lit(frameAt(frames, t))
  if (!f0 || !ft) return null
  const m = Math.max(...f0.rgb) || 1
  const colour = f0.rgb.map((v) => v / m)
  const dx = t ? (ft.cx - f0.cx) / t : 0, dy = t ? (ft.cy - f0.cy) / t : 0
  return { colour, motion: [dx, dy], speed: [Math.hypot(dx, dy)] }
}

/** Training combinations vs combinations held out entirely (never seen together): decided by (hue + direction) % 3. */
export const seenCombo = (hue, dir) => (hue + dir) % 3 !== 0

function videos(seed, count, pred, noise) {
  const rng = new Rng(seed), out = []
  while (out.length < count) {
    const l = { hue: rng.int(HUES.length), dir: rng.int(DIRS.length), speed: rng.int(SPEEDS.length) }
    if (pred(l.hue, l.dir)) out.push(makeVideo(rng, { ...l, noise }))
  }
  return out
}

export function trainVideo({ trainVideos = 150, seed = 1, epochs = 200 } = {}) {
  const vs = videos(seed, trainVideos, seenCombo, 0.05)
  const rows = { hue: [[], []], dir: [[], []], speed: [[], []] }
  for (const v of vs) {
    const f0 = featuresUpTo(v.frames, 1)
    rows.hue[0].push(f0.colour); rows.hue[1].push(v.labels.hue)
    for (let t = 1; t < T; t++) {
      const f = featuresUpTo(v.frames, t)
      rows.dir[0].push(f.motion); rows.dir[1].push(v.labels.dir)
      rows.speed[0].push(f.speed); rows.speed[1].push(v.labels.speed)
    }
  }
  return {
    hue: trainSoftmax(rows.hue[0], rows.hue[1], HUES.length, { epochs }),
    dir: trainSoftmax(rows.dir[0], rows.dir[1], DIRS.length, { epochs }),
    speed: trainSoftmax(rows.speed[0], rows.speed[1], SPEEDS.length, { epochs }),
    trained: { videos: vs.length, samples: rows.dir[1].length },
  }
}

/** The live caption for frame t, from the model, using frames 0..t only. */
export function liveCaption(models, frames, t) {
  const f = featuresUpTo(frames, Math.max(t, 1))
  const hue = predict(models.hue, f.colour)
  if (t === 0) return captionFor({ hue }, 0)
  const ft = featuresUpTo(frames, t)
  return captionFor({ hue, dir: predict(models.dir, ft.motion), speed: predict(models.speed, ft.speed) }, t)
}

/** Proof that captions are live: rewrite every frame after t with noise and confirm the caption at t is unchanged. */
export function causalityCheck(models, v, seed = 7) {
  const rng = new Rng(seed)
  for (let t = 0; t < T; t++) {
    const before = liveCaption(models, v.frames, t)
    const f2 = v.frames.slice()
    for (let i = (t + 1) * H * W * 3; i < f2.length; i++) f2[i] = rng.int(256)
    if (liveCaption(models, f2, t) !== before) return false
  }
  return true
}

export function examVideo(models, { count = 60, seed = 5, noise = 0.05, heldOut = true } = {}) {
  const vs = videos(seed + 1000, count, heldOut ? (h, d) => !seenCombo(h, d) : seenCombo, noise)
  const X = { hue: [], dir: [], speed: [] }, Y = { hue: [], dir: [], speed: [] }
  let capOk = 0, capN = 0, videoOk = 0, causal = 0
  for (const v of vs) {
    let all = true
    for (let t = 0; t < T; t++) {
      const got = liveCaption(models, v.frames, t)
      capN++; if (got === v.captions[t]) capOk++; else all = false
    }
    if (all) videoOk++
    if (causalityCheck(models, v)) causal++
    const f1 = featuresUpTo(v.frames, 1)
    X.hue.push(f1.colour); Y.hue.push(v.labels.hue)
    const fT = featuresUpTo(v.frames, T - 1)
    X.dir.push(fT.motion); Y.dir.push(v.labels.dir); X.speed.push(fT.speed); Y.speed.push(v.labels.speed)
  }
  return {
    hue: score(models.hue, X.hue, Y.hue), direction: score(models.dir, X.dir, Y.dir), speed: score(models.speed, X.speed, Y.speed),
    captionExactPerFrame: +(capOk / capN).toFixed(4), captionExactWholeVideo: +(videoOk / vs.length).toFixed(4),
    liveCaptionsCausal: `${causal}/${vs.length}`, videos: vs.length,
  }
}
