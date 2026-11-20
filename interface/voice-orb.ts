/**
 * The voice orb: a circle of dots that swells and settles with the volume of the reply, like the voice mode in
 * the big chat apps, but fed from the agent's response zip (interface/response-bundle.ts).
 *
 * What it plays, in this order:
 *   1. An audio file in the zip (response/reply.wav, or any wav, mp3, ogg, m4a, flac or webm outside response/formats/).
 *      The orb measures the real loudness of that sound as it plays, so the size follows the volume.
 *   2. Otherwise the text file (response/reply.md or reply.txt), read aloud by the computer's own voice (the browser's
 *      built-in speech synthesis; nothing is downloaded and no model is used). A browser cannot measure the volume of
 *      the system voice, so for this path the orb pulses on each word and holds a gentle level between them. The page
 *      says which of the two it is using.
 *   3. Otherwise nothing: the page says the zip has neither.
 *
 * What it shows: a sphere of dots by default. If the zip has a visual file (response/visual.png, jpg, gif, webp, svg
 * or html), that picture is cast onto the circle instead and swells with the volume the same way. An html visual runs
 * in the same sandbox as a visual in the chat (interface/visuals.ts): no network, no storage, no way out.
 *
 * This file holds the part that reads a zip (a pure function, tested), the styles, and the page script. Files are
 * recognised by their first bytes, not their names, so a text file renamed .wav is not played. Names are only ever
 * compared, never used as paths. Written on Node built-ins and the browser's own APIs; no outside code.
 */

import type { ZipEntry } from "../models && skills/core/zip-archive.js";
import { VISUAL_MAX_BYTES } from "./visuals.js";

export const ORB_MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const ORB_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** The system voice reads at most this many characters; the rest is left unspoken and the page says so. */
export const ORB_MAX_SPEECH_CHARS = 20_000;
/** One utterance is at most about this long: some voices stop mid-reply on long ones. */
export const ORB_CHUNK_CHARS = 220;

export interface OrbAudio { name: string; mime: string; /** base64 */ data: string }
export interface OrbVisual {
  name: string;
  kind: "image" | "html";
  mime: string;
  /** base64 for an image, the source text for html */
  data: string;
}
export interface OrbMedia {
  audio: OrbAudio | null;
  /** The reply as written, for showing when nothing can be spoken. */
  text: string | null;
  /** The reply as the system voice should say it, in short pieces. */
  speech: string[];
  visual: OrbVisual | null;
  /** What the orb will use: the audio file, the system voice, or nothing. */
  source: "audio" | "voice" | "none";
  /** Plain sentences about anything skipped, for the page to show. */
  notes: string[];
}

const AUDIO_EXT = new Set(["wav", "mp3", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const HTML_EXT = new Set(["html", "htm"]);
const TEXT_NAMES = ["response/reply.md", "response/reply.txt", "reply.md", "reply.txt"];
const MAX_TEXT = 200_000;

const parts = (name: string): { dir: string[]; stem: string; ext: string } => {
  const segs = name.split("/");
  const file = segs.pop() ?? "";
  const dot = file.lastIndexOf(".");
  return { dir: segs, stem: (dot > 0 ? file.slice(0, dot) : file).toLowerCase(), ext: dot > 0 ? file.slice(dot + 1).toLowerCase() : "" };
};
/** Files under response/formats/ are the reply converted to hundreds of formats, many of them only relabelled text: never played or cast. */
const inFormats = (name: string): boolean => parts(name).dir.includes("formats");
const rank = (name: string): number => (name.startsWith("response/") ? 0 : 1);

const startsWith = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** The audio type a file's first bytes say it is, or null if it is not audio. */
export function sniffAudio(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WAVE")) return "audio/wav";
  if (startsWith(b, 0, "OggS")) return "audio/ogg";
  if (startsWith(b, 0, "fLaC")) return "audio/flac";
  if (startsWith(b, 4, "ftyp")) return "audio/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (startsWith(b, 0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

/** The image type a file's first bytes say it is, or null. An svg is only ever shown through an <img>, which cannot run its scripts. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && startsWith(b, 1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (startsWith(b, 0, "GIF8")) return "image/gif";
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "image/webp";
  const head = Buffer.from(b.subarray(0, 2048)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/**
 * The reply as it should sound: code, visuals, markers, links and markdown marks out, everything a reader would not
 * say left behind. Lines stay separate (a newline is where the voice pauses); digits stay digits, since the system
 * voice reads them.
 */
export function spokenText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[\s|:-]+$/gm, "") // rules and table dividers
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\*+|~~/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** The spoken text cut into short pieces at sentence ends (and, for a very long sentence, at commas or spaces), then packed back up to `max`. */
export function speechChunks(text: string, max = ORB_CHUNK_CHARS): string[] {
  const sentences: string[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    for (const s of l.split(/(?<=[.!?…])\s+/)) {
      let rest = s.trim();
      while (rest.length > max) {
        let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max), rest.lastIndexOf(": ", max));
        if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
        const take = cut >= 1 ? cut + 1 : max;
        sentences.push(rest.slice(0, take).trim());
        rest = rest.slice(take).trim();
      }
      if (rest) sentences.push(rest);
    }
  }
  const out: string[] = [];
  for (const s of sentences) {
    const last = out.length - 1;
    if (last >= 0 && out[last].length + 1 + s.length <= max) out[last] += ` ${s}`;
    else out.push(s);
  }
  return out;
}

/** What the orb should play and show for the files of a response zip. */
export function orbMedia(entries: ZipEntry[]): OrbMedia {
  const notes: string[] = [];
  const byName = new Map(entries.map(e => [e.name, e]));

  // 1. Audio: reply.* first, response/ first, then by name. The first file that really is audio wins.
  let audio: OrbAudio | null = null;
  const audioCands = entries
    .filter(e => !inFormats(e.name) && AUDIO_EXT.has(parts(e.name).ext))
    .sort((a, b) => Number(parts(a.name).stem !== "reply") - Number(parts(b.name).stem !== "reply") || rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
  for (const e of audioCands) {
    if (e.data.length > ORB_MAX_AUDIO_BYTES) { notes.push(`${e.name} is over ${Math.round(ORB_MAX_AUDIO_BYTES / 1048576)} MB, so it was not played.`); continue; }
    const mime = sniffAudio(e.data);
    if (!mime) { notes.push(`${e.name} is not an audio file, so it was ignored.`); continue; }
    audio = { name: e.name, mime, data: e.data.toString("base64") };
    break;
  }

  // 2. Text, for the system voice (and to show when nothing can be spoken).
  let text: string | null = null;
  for (const n of TEXT_NAMES) {
    const e = byName.get(n);
    if (e) { text = e.data.toString("utf8").slice(0, MAX_TEXT); break; }
  }
  let speech: string[] = [];
  if (text !== null) {
    let spoken = spokenText(text);
    if (spoken.length > ORB_MAX_SPEECH_CHARS) { spoken = spoken.slice(0, ORB_MAX_SPEECH_CHARS); notes.push(`Only the first ${ORB_MAX_SPEECH_CHARS.toLocaleString("en-US")} characters are read aloud.`); }
    speech = /[A-Za-z0-9]/.test(spoken) ? speechChunks(spoken) : [];
  }

  // 3. A visual file: visual.<image or html>, never from formats/.
  let visual: OrbVisual | null = null;
  const visualCands = entries
    .filter(e => !inFormats(e.name) && parts(e.name).stem === "visual" && (IMAGE_EXT.has(parts(e.name).ext) || HTML_EXT.has(parts(e.name).ext)))
    .sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1));
  for (const e of visualCands) {
    const ext = parts(e.name).ext;
    if (HTML_EXT.has(ext)) {
      const code = e.data.toString("utf8");
      if (e.data.length > VISUAL_MAX_BYTES || !code.trim()) { notes.push(`${e.name} is empty or too big to show.`); continue; }
      visual = { name: e.name, kind: "html", mime: "text/html", data: code };
      break;
    }
    if (e.data.length > ORB_MAX_IMAGE_BYTES) { notes.push(`${e.name} is too big to show.`); continue; }
    const mime = sniffImage(e.data);
    if (!mime) { notes.push(`${e.name} is not a picture, so it was ignored.`); continue; }
    visual = { name: e.name, kind: "image", mime, data: e.data.toString("base64") };
    break;
  }

  const source = audio ? "audio" : speech.length ? "voice" : "none";
  return { audio, text, speech, visual, source, notes };
}

/** Styles for the overlay. Same tokens as the rest of the page (AGENTS.md, VISUAL STYLE): coral on warm dark, round, glass, no blue. */
export const ORB_CSS = `
  #nc-orb { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
    background: rgba(17, 12, 14, 0.76); backdrop-filter: blur(26px) saturate(1.5); -webkit-backdrop-filter: blur(26px) saturate(1.5);
    opacity: 0; transition: opacity 0.35s ease; color: #f8ede9; font-family: ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  #nc-orb[hidden] { display: none; }
  #nc-orb.on { opacity: 1; }
  #nc-orb-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
  #nc-orb-visual { position: absolute; border-radius: 50%; overflow: hidden; clip-path: circle(50%); pointer-events: none; transform-origin: 50% 50%;
    box-shadow: 0 0 60px rgba(227, 169, 157, 0.25); }
  #nc-orb-visual[hidden] { display: none; }
  #nc-orb-visual iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  #nc-orb-low { position: relative; z-index: 1; width: min(600px, calc(100% - 32px)); margin-bottom: max(22px, env(safe-area-inset-bottom)); text-align: center; }
  #nc-orb-caption { min-height: 3em; max-height: 7em; overflow: auto; padding: 0 8px 10px; font-size: 16px; line-height: 1.5; color: rgba(248, 237, 233, 0.86); }
  #nc-orb-status { min-height: 1.4em; margin-bottom: 12px; font-size: 12.5px; color: rgba(248, 237, 233, 0.62); }
  #nc-orb-controls { display: inline-flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 8px; border-radius: 999px;
    border: 1px solid rgba(255, 228, 218, 0.2); background: rgba(255, 240, 232, 0.07); backdrop-filter: blur(26px) saturate(1.5); -webkit-backdrop-filter: blur(26px) saturate(1.5);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.12) inset, 0 12px 28px rgba(0, 0, 0, 0.28), 0 0 24px rgba(227, 169, 157, 0.06); }
  #nc-orb-controls button { font: inherit; font-size: 14px; color: #f8ede9; background: rgba(255, 238, 230, 0.07); border: 1px solid rgba(255, 228, 218, 0.2);
    border-radius: 999px; padding: 10px 18px; min-height: 44px; cursor: pointer; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s; }
  #nc-orb-controls button:hover:not(:disabled) { background: rgba(227, 169, 157, 0.28); transform: translateY(-2px) scale(1.03); }
  #nc-orb-controls button:active:not(:disabled) { transform: scale(0.95); }
  #nc-orb-controls button:disabled { opacity: 0.4; cursor: default; }
  #nc-orb-controls button.primary { background: rgba(227, 169, 157, 0.16); border-color: rgba(227, 169, 157, 0.5); color: #efd0c8; }
  #nc-orb-controls button:focus-visible, #nc-orb-canvas:focus-visible { outline: 2px solid rgba(227, 169, 157, 0.8); outline-offset: 2px; }
  #nc-orb.drop #nc-orb-controls { border-color: rgba(227, 169, 157, 0.7); }
  .orb-btn { margin-left: 4px; }
  @media (prefers-reduced-motion: reduce) { #nc-orb, #nc-orb-controls button { transition: none; } }
`;

/**
 * The page side. One global, `ncOrb`: openReply({message, response, details}) asks the server for the reply's media
 * and plays it; openZip(file) does the same for a zip the person picks or drops; close(); toggle(). Plain browser
 * JavaScript. Like the visuals script it is spliced into the chat page's template, so it holds no backticks and no
 * backslashes and no dollar-brace.
 */
export const ORB_CLIENT_JS = `
var ncOrb = (function () {
  var DOTS = 900, TAU = 6.2832;
  var el = null, canvas = null, g = null, statusEl, captionEl, playBtn, replayBtn, zipBtn, closeBtn, fileEl, holder;
  var isOpen = false, raf = 0, lastT = 0, clock = 0, spin = 0;
  var W = 0, H = 0, DPR = 1, R0 = 100;
  var level = 0, target = 0, pulse = 0;
  var media = null, mode = 'idle', runId = 0, lastFocus = null;
  var audio = null, audioUrl = '', analyser = null, tbuf = null, actx = null;
  var speaking = false, voicePaused = false, chunks = [], at = 0, keep = null, heard = false;
  var img = null, imgReady = false, frame = null;
  var pts = makePoints(DOTS);
  var xs = [[], [], [], []];
  var COLORS = ['rgba(201,132,118,.30)', 'rgba(201,132,118,.55)', 'rgba(227,169,157,.82)', 'rgba(239,208,200,.96)'];

  function makePoints(n) {
    var out = [], ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), th = i * ga;
      var s = Math.sin(i * 12.9898) * 43758.5453; s = s - Math.floor(s);
      out.push({ x: Math.cos(th) * r, y: y, z: Math.sin(th) * r, s: s });
    }
    return out;
  }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function setStatus(text, tip) { statusEl.textContent = text; statusEl.title = tip || ''; }
  function unb64(t) { var s = atob(t), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'nc-orb'; el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Voice orb');
    canvas = document.createElement('canvas');
    canvas.id = 'nc-orb-canvas'; canvas.tabIndex = 0; canvas.setAttribute('role', 'button'); canvas.setAttribute('aria-label', 'Pause or play');
    holder = document.createElement('div');
    holder.id = 'nc-orb-visual'; holder.hidden = true;
    var low = document.createElement('div'); low.id = 'nc-orb-low';
    captionEl = document.createElement('div'); captionEl.id = 'nc-orb-caption';
    statusEl = document.createElement('div'); statusEl.id = 'nc-orb-status'; statusEl.setAttribute('aria-live', 'polite');
    var row = document.createElement('div'); row.id = 'nc-orb-controls';
    function btn(text, fn, cls) { var b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (cls) b.className = cls; b.onclick = fn; row.appendChild(b); return b; }
    playBtn = btn('Pause', toggle, 'primary');
    replayBtn = btn('Replay', replay);
    zipBtn = btn('Open zip', function () { fileEl.click(); });
    closeBtn = btn('Close', close);
    fileEl = document.createElement('input'); fileEl.type = 'file'; fileEl.accept = '.zip,application/zip'; fileEl.hidden = true;
    fileEl.onchange = function () { if (fileEl.files && fileEl.files[0]) openZip(fileEl.files[0]); fileEl.value = ''; };
    low.appendChild(captionEl); low.appendChild(statusEl); low.appendChild(row);
    el.appendChild(canvas); el.appendChild(holder); el.appendChild(low); el.appendChild(fileEl);
    document.body.appendChild(el);
    g = canvas.getContext('2d');
    canvas.onclick = toggle;
    el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', function () { el.classList.remove('drop'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault(); el.classList.remove('drop');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) openZip(f);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === ' ' && !e.altKey && document.activeElement && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); toggle(); return; }
      if (e.key === 'Tab') {
        var items = [canvas, playBtn, replayBtn, zipBtn, closeBtn].filter(function (b) { return !b.disabled; });
        var i = items.indexOf(document.activeElement);
        var next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
        e.preventDefault(); items[next].focus();
      }
    });
    window.addEventListener('resize', function () { if (isOpen) resize(); });
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    R0 = Math.max(60, Math.min(W, H * 0.8) * 0.2);
    holder.style.width = holder.style.height = Math.round(R0 * 2) + 'px';
  }

  /* ---- drawing ---- */
  function drawDots(cx, cy, r, still) {
    var yaw = spin, pitch = 0.35 + (still ? 0 : 0.1 * Math.sin(clock * 0.37));
    var cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    var b, j, p;
    for (b = 0; b < 4; b++) xs[b].length = 0;
    for (j = 0; j < pts.length; j++) {
      p = pts[j];
      var x1 = p.x * cyw + p.z * syw, z1 = -p.x * syw + p.z * cyw;
      var y2 = p.y * cp - z1 * sp, z2 = p.y * sp + z1 * cp;
      var rr = r * (1 + (still ? 0 : level * 0.22 * Math.sin(clock * 7 + p.s * 40)));
      var d = (z2 + 1) / 2;
      b = d < 0.25 ? 0 : d < 0.5 ? 1 : d < 0.75 ? 2 : 3;
      xs[b].push(cx + x1 * rr, cy + y2 * rr, (1.1 + 1.5 * d + 1.4 * level) * (R0 / 110));
    }
    for (b = 0; b < 4; b++) {
      g.fillStyle = COLORS[b]; g.beginPath();
      var a = xs[b];
      for (j = 0; j < a.length; j += 3) { g.moveTo(a[j] + a[j + 2], a[j + 1]); g.arc(a[j], a[j + 1], a[j + 2], 0, TAU); }
      g.fill();
    }
  }

  function drawPicture(cx, cy, r) {
    if (frame) { holder.style.left = Math.round(cx - R0) + 'px'; holder.style.top = Math.round(cy - R0) + 'px'; holder.style.transform = 'scale(' + (r / R0).toFixed(3) + ')'; return; }
    if (!img || !imgReady) return;
    var iw = img.naturalWidth || R0 * 2, ih = img.naturalHeight || R0 * 2, s = Math.max(2 * r / iw, 2 * r / ih);
    g.save(); g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.clip();
    g.drawImage(img, cx - iw * s / 2, cy - ih * s / 2, iw * s, ih * s);
    var v = g.createRadialGradient(cx, cy, r * 0.6, cx, cy, r);
    v.addColorStop(0, 'rgba(17,12,14,0)'); v.addColorStop(1, 'rgba(17,12,14,.38)');
    g.fillStyle = v; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }

  function readLevel(dt) {
    if (mode === 'audio' && audio) {
      if (audio.paused || audio.ended) return 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(tbuf);
        var s = 0; for (var i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
        return Math.min(1, Math.sqrt(s / tbuf.length) * 3.4);
      }
      return 0.2 + 0.15 * Math.abs(Math.sin(clock * 9) * Math.sin(clock * 3.1));
    }
    if (mode === 'voice' && speaking && !voicePaused) {
      pulse *= Math.exp(-dt / 0.12);
      return Math.min(1, 0.16 + 0.1 * Math.abs(Math.sin(clock * 9.1) * Math.sin(clock * 3.3)) + pulse);
    }
    if (mode === 'loading') return 0.06 + 0.05 * Math.sin(clock * 3);
    return 0;
  }

  function frameLoop(now) {
    if (!isOpen) return;
    raf = requestAnimationFrame(frameLoop);
    var dt = Math.max(0.001, Math.min(0.1, (now - lastT) / 1000 || 0.016)); lastT = now;
    var still = reduced();
    clock += dt; if (!still) spin += dt * 0.28;
    target = readLevel(dt);
    level += (target - level) * (1 - Math.exp(-dt / (target > level ? 0.045 : 0.22)));
    level = level > 0 && level < 1 ? level : (level >= 1 ? 1 : 0);
    g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H * 0.42;
    var r = R0 * (1 + (still ? 0.22 : 0.5) * Math.pow(level, 0.8) + (still ? 0 : 0.025 * Math.sin(clock * 1.6)));
    var gl = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.2);
    gl.addColorStop(0, 'rgba(227,169,157,' + (0.16 + 0.3 * level).toFixed(3) + ')'); gl.addColorStop(1, 'rgba(227,169,157,0)');
    g.fillStyle = gl; g.fillRect(cx - r * 2.2, cy - r * 2.2, r * 4.4, r * 4.4);
    if (frame || (img && imgReady)) drawPicture(cx, cy, r); else drawDots(cx, cy, r, still);
  }

  /* ---- what is playing ---- */
  function stopSound() {
    runId++;
    if (audio) { audio.onended = audio.onerror = audio.onpause = audio.onplay = null; try { audio.pause(); } catch (e) { /* gone */ } audio.removeAttribute('src'); audio = null; }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = ''; }
    analyser = null; speaking = false; voicePaused = false; keep = null; pulse = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
  function clearPicture() {
    img = null; imgReady = false;
    if (frame) { frame.remove(); frame = null; }
    holder.hidden = true;
  }
  function buttons() {
    var live = mode === 'audio' || mode === 'voice';
    playBtn.disabled = !(live || mode === 'done');
    playBtn.textContent = mode === 'done' ? 'Play again' : (mode === 'audio' && audio && audio.paused) || (mode === 'voice' && voicePaused) ? 'Play' : 'Pause';
    replayBtn.disabled = !media || mode === 'loading';
  }
  function finish() { mode = 'done'; speaking = false; setStatus('Finished. Press Play again, open another zip, or close.'); buttons(); }

  function showPicture(v) {
    clearPicture();
    if (!v) return;
    if (v.kind === 'image') {
      var im = new Image();
      im.onload = function () { img = im; imgReady = true; };
      im.onerror = function () { img = null; };
      im.src = 'data:' + v.mime + ';base64,' + v.data;
    } else if (window.ncVisuals) {
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('title', 'Visual on the orb'); frame.setAttribute('aria-hidden', 'true');
      frame.srcdoc = ncVisuals.srcdoc('orb', v.data);
      holder.appendChild(frame); holder.hidden = false;
    }
  }

  function playAudio(a, fallback) {
    var bytes = unb64(a.data), mine = ++runId;
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    audio = new Audio(); audio.src = audioUrl;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var node = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser(); analyser.fftSize = 1024; tbuf = new Float32Array(analyser.fftSize);
      node.connect(analyser); analyser.connect(actx.destination);
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { analyser = null; }
    mode = 'audio';
    setStatus('Playing the audio file ' + a.name, 'The orb follows the loudness of this sound.');
    audio.onended = function () { if (mine === runId) finish(); };
    audio.onpause = audio.onplay = buttons;
    audio.onerror = function () {
      if (mine !== runId) return;
      stopSound(); mode = 'idle';
      if (fallback && fallback.length) { setStatus('Could not play ' + a.name + ', so the system voice reads the reply.'); playVoice(fallback); }
      else { mode = 'done'; setStatus('Could not play ' + a.name + '.'); buttons(); }
    };
    var p = audio.play();
    if (p && p.catch) p.catch(function () { if (mine === runId) { setStatus('Tap the orb or press Play to start the sound.'); buttons(); } });
    buttons();
  }

  function playVoice(list) {
    var mine = ++runId;
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      mode = 'done'; captionEl.textContent = list.join(' ');
      setStatus('This browser has no system voice, so the text is shown instead.'); buttons(); return;
    }
    mode = 'voice'; chunks = list; at = 0; voicePaused = false; heard = false;
    setStatus('No audio file in the zip, so the system voice reads the reply.', 'The browser cannot measure the volume of the system voice, so the orb pulses with each word instead.');
    speechSynthesis.cancel();
    next(mine); buttons();
  }
  function next(mine) {
    if (mine !== runId) return;
    if (at >= chunks.length) {
      if (!heard) {
        mode = 'done'; captionEl.textContent = chunks.join(' ');
        setStatus('The system voice did not start (this computer may have no voice installed), so the text is shown instead.'); buttons(); return;
      }
      captionEl.textContent = ''; finish(); return;
    }
    var u = new SpeechSynthesisUtterance(chunks[at]);
    keep = u;
    u.lang = navigator.language || 'en-US';
    captionEl.textContent = chunks[at];
    u.onstart = function () { speaking = true; heard = true; };
    u.onboundary = function () { pulse = 0.5 + Math.random() * 0.35; };
    u.onend = function () { if (mine === runId) { at++; next(mine); } };
    u.onerror = function (e) { if (e && (e.error === 'canceled' || e.error === 'interrupted')) return; if (mine === runId) { at++; next(mine); } };
    speechSynthesis.speak(u);
  }

  function play(m) {
    stopSound(); captionEl.textContent = '';
    media = m; showPicture(m.visual);
    if (m.notes && m.notes.length) captionEl.textContent = m.notes.join(' ');
    if (m.audio) playAudio(m.audio, m.speech);
    else if (m.speech && m.speech.length) playVoice(m.speech);
    else { mode = 'done'; setStatus((m.visual ? 'Showing ' + m.visual.name + '. ' : '') + 'The zip has no audio file and no text file to read.'); buttons(); }
  }
  function replay() { if (media) play(media); }
  function toggle() {
    if (mode === 'audio' && audio) { if (audio.paused) { if (actx && actx.state === 'suspended') actx.resume(); audio.play(); } else audio.pause(); }
    else if (mode === 'voice') { if (speechSynthesis.paused) speechSynthesis.resume(); else speechSynthesis.pause(); voicePaused = speechSynthesis.paused; }
    else if (mode === 'done') replay();
    buttons();
  }

  /* ---- opening and closing ---- */
  function show() {
    build();
    if (!isOpen) {
      lastFocus = document.activeElement; isOpen = true; el.hidden = false; resize();
      requestAnimationFrame(function () { el.classList.add('on'); });
      lastT = performance.now(); raf = requestAnimationFrame(frameLoop);
    }
    media = null; mode = 'loading'; stopSound(); clearPicture(); captionEl.textContent = ''; buttons();
    closeBtn.focus();
  }
  function close() {
    if (!isOpen) return;
    stopSound(); clearPicture(); isOpen = false; mode = 'idle'; media = null;
    cancelAnimationFrame(raf); el.classList.remove('on'); el.hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
  }
  function toggleOpen(opener) { if (isOpen) close(); else opener(); }

  /* An answer that arrives after the orb was closed, or reopened for something else, is dropped. */
  function post(url, body) {
    var mine = runId;
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); })
      .then(function (m) { if (isOpen && mine === runId) play(m); })
      .catch(function (e) { if (!isOpen || mine !== runId) return; mode = 'done'; setStatus('Could not get the reply: ' + e.message); buttons(); });
  }
  function openReply(body) {
    show();
    if (!body || !body.response) { mode = 'done'; setStatus('There is no reply to play yet.'); buttons(); return; }
    if (actx && actx.state === 'suspended') actx.resume();
    setStatus('Getting the reply ready...');
    post('/api/chat/orb', body);
  }
  function openZip(file) {
    show();
    setStatus('Reading ' + (file && file.name ? file.name : 'the zip') + '...');
    var r = new FileReader();
    r.onload = function () { var s = String(r.result); post('/api/orb/zip', { zip: s.slice(s.indexOf(',') + 1) }); };
    r.onerror = function () { mode = 'done'; setStatus('Could not read that file.'); buttons(); };
    r.readAsDataURL(file);
  }

  return { openReply: openReply, openZip: openZip, close: close, isOpen: function () { return isOpen; }, toggleOpen: toggleOpen };
})();
`;
