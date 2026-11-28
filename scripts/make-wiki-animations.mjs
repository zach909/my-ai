#!/usr/bin/env node
/**
 * make-wiki-animations.mjs -- one animated SVG per wiki page, plus the
 * "wiki in motion" section of README.md.
 *
 *   node scripts/make-wiki-animations.mjs           write docs/media/wiki/*.svg and the README section
 *   node scripts/make-wiki-animations.mjs --check   exit 1 if a file or the README section is stale
 *
 * Node built-ins only. Each animation is a plain SVG with CSS keyframes:
 * no scripts, no images, no fonts, no external requests. Colours are the
 * house palette from AGENTS.md (coral on warm dark, no blue). Everything
 * stops under prefers-reduced-motion. The script refuses to run if a wiki
 * page has no entry here, or an entry has no page, so the set stays whole.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_DIR = path.join(ROOT, 'wiki');
const OUT_DIR = path.join(ROOT, 'docs', 'media', 'wiki');
const README = path.join(ROOT, 'README.md');
const START = '<!-- wiki-animations:start -->';
const END = '<!-- wiki-animations:end -->';
const ANCHOR = '## Run it from source';
const CHECK = process.argv.includes('--check');

// ---- one entry per wiki page -------------------------------------------------
// [file, group, motif, title, labels, caption]
const PAGES = [
  ['Home.md', 'Start here', 'hub', 'Home', ['NeuroClaw', 'Skills', 'Plugins', 'Sharing', 'Privacy'], 'Every wiki page branches from one hub'],
  ['Quick-Start.md', 'Start here', 'fill', 'Quick Start', ['Install', 'Connect', 'Chat', 'Build'], 'Install, connect, chat, then build your own'],
  ['Architecture.md', 'Start here', 'stack', 'Architecture', ['Chat and tools', 'Skills', 'Neuron mesh', 'Quantized weights'], 'Layers stacked from the chat down to the weights'],
  ['AI-OS-Mode.md', 'Start here', 'flow', 'AI OS mode', ['Sign in', 'Engine starts', 'Window opens'], 'The engine is already running before you open a window'],
  ['Visuals.md', 'Start here', 'split', 'Visuals', ['AI answer', 'Visual panel', 'Button asks AI'], 'The AI is the back end; the panel is the front end'],

  ['Quantization.md', 'Background', 'bars', 'Quantization', ['float weights', '4-bit weights'], 'Trained weights are compressed for fast, small deployment'],
  ['Elastic-Value-Budget.md', 'Background', 'dial', 'Elastic Value Budget', ['stable', 'adaptive'], 'Important neurons change less; the total budget stays fixed'],
  ['Wake-Sleep-Islands.md', 'Background', 'grow', 'Wake-Sleep Islands', ['wake', 'sleep', 'new neurons'], 'Learning grows new neurons instead of overwriting old ones'],
  ['Grow-Prune-Quantize.md', 'Background', 'cycle', 'Grow, Prune, Quantize', ['Grow', 'Prune', 'Quantize'], 'Design note: the mesh grows, trims and compresses in turns'],
  ['Extensions.md', 'Background', 'grow', 'Self-Built Extensions', ['memory', 'logic', 'code', 'skill'], 'The AI adds modules that keep what it learned'],
  ['RLM.md', 'Background', 'cycle', 'RLM', ['Try a step', 'Score it', 'Remember', 'Skip repeats'], 'Try candidate steps, remember them, stop repeating'],
  ['Empathy-Engine.md', 'Background', 'dial', 'Empathy Engine', ['Valence', 'Arousal', 'Dominance'], 'Reads the emotional trend from your own words (VAD)'],
  ['Imagination.md', 'Background', 'assemble', 'Imagination', ['memory', 'random mix'], 'Recall rebuilds a memory; imagining mixes random pieces'],

  ['MoE.md', 'Foreground', 'split', 'Net-Skill Routing', ['Input', 'Skill A', 'Skill B', 'Skill C'], 'Only the regions that match the input switch on'],
  ['Auto-Route.md', 'Foreground', 'dial', 'Auto Route', ['Instant', 'Optimize'], 'Picks effort, where to answer and how many islands run'],
  ['Neuron-Mesh.md', 'Foreground', 'mesh', 'Neuron Mesh', ['every neuron'], 'Every neuron can reach every other in a few settle ticks'],
  ['Hyperdimensional.md', 'Foreground', 'wave', 'Hyper-Dimensional Thinking', ['state A', 'state B', 'state C'], 'Each neuron carries several internal states at once'],
  ['Zip-IO.md', 'Foreground', 'cycle', 'Zip I/O Loop', ['zipped in', 'mesh', 'zipped out'], 'Compressed input and output run as circular buffers'],
  ['Quantum-Net.md', 'Foreground', 'wave', 'Quantum Neural Net', ['wave 1', 'wave 2', 'interference'], 'Phase-aligned neurons reinforce each other'],
  ['Prompt-Memory.md', 'Foreground', 'shrink', 'Prompt Memory', ['big archive', 'stand-in'], 'A small stand-in makes the mesh say the same thing'],
  ['Zip-Workspace.md', 'Foreground', 'bits', 'Zip Workspace (draft)', ['three output neurons', '0 · 1 · ramp'], 'Design draft: the agent works through the Zip Loop doorway'],
  ['Yes-No-Questions.md', 'Foreground', 'sort', 'Yes/No Questions', ['Your text', 'yes', 'no'], 'Teach examples, then answer yes or no with a probability'],
  ['Net-Search.md', 'Foreground', 'sort', 'Net Search', ['definition', 'match', 'no match'], 'Search the mesh, then train a small net to reproduce it'],
  ['Referee.md', 'Foreground', 'gate', 'Referee', ['claim in', 'verified out'], 'An independent check that never trusts the wording'],

  ['Builder.md', 'Extension system', 'flow', 'Extension Builder', ['Spec', 'Train', 'Save', 'Quantize', 'Install'], 'Save without quantization, install with it'],
  ['Plugins.md', 'Extension system', 'hub', 'Plugins', ['Plugins', 'Hardware', 'Apps', 'Data', 'Services'], 'API connections that drop in without rewiring the mesh'],
  ['Skills.md', 'Extension system', 'grow', 'Skills', ['Coding', 'Math', 'Writing', 'Search'], 'Expert modules that join the mixture when they are needed'],
  ['Code-to-Net.md', 'Extension system', 'typing', 'Code-to-Net', ['for (i) sum += x', 'learn the function', 'a neuron to call'], 'Code is learned as a function, then called like a neuron'],
  ['Net-Maker.md', 'Extension system', 'flow', 'Net Maker', ['NeuroLang', 'Build net', 'Edit weights', 'Compile'], 'Write a short program, get a net, then tune its weights'],
  ['Map-Maker.md', 'Extension system', 'hub', 'Map Maker', ['Map', 'Components', 'Data flow', 'Bottlenecks'], 'The always-on map of parts, flows and waste (design)'],
  ['Task-Training.md', 'Extension system', 'split', 'Task Training', ['task', 'agent 1', 'agent 2', 'agent 3'], 'Agents learn their part, then are scored on the tasks'],
  ['Knowledge-Training.md', 'Extension system', 'fill', 'Knowledge Training', ['Investigate', 'Filter', 'Train', 'Evaluate', 'Cite'], 'A staged, evaluated pipeline across 41 open sources'],
  ['Format-Converter.md', 'Extension system', 'flow', 'Format Converter', ['picture', 'text', 'code', 'table'], 'Any format to any other, with both sides known'],
  ['Memory-Topics.md', 'Extension system', 'tree', 'Memory Topics', ['memory', 'people', 'projects', 'preferences'], 'Notes filed in a folder tree the AI searches itself'],
  ['Chrome-Apps.md', 'Extension system', 'hub', 'Chrome Apps', ['Chrome app', 'Local data', 'System', 'Services'], 'Local services only, never an outside network call'],

  ['NeuroLang.md', 'Reference', 'typing', 'NeuroLang', ['name="x"', '"x"@value="0.7"', '"x"@connections=".y"'], 'A small language that defines the neurons, line by line'],
  ['Syntax.md', 'Reference', 'typing', 'NeuroLang Syntax', ['name="x"', '"x"@value="n"', '"x"@definition="d"'], 'The directive grammar, one line per directive'],
  ['Languages.md', 'Reference', 'typing', 'Supported Languages', ['PROGRAMMING_SKILLS', '{ name: "C", ext: [".c"] }', '500+ languages'], 'A real, queryable catalog of programming languages'],
  ['Pipeline.md', 'Reference', 'flow', 'Pipeline Flow', ['Embed', 'Route', 'Mesh ticks', 'Decode'], 'Input moves through each timed stage in order'],

  ['Platforms.md', 'System and safety', 'hub', 'Platform Support', ['Local', 'macOS', 'Windows', 'Linux'], 'The same local engine on every desktop system'],
  ['System-Access.md', 'System and safety', 'hub', 'System Access', ['AI desktop', 'Terminal', 'Files', 'Virtual mouse'], 'Acts on the machine without taking over your own screen'],
  ['Multi-Input.md', 'System and safety', 'hub', 'Multi-Input Support', ['Inputs', 'Your desk', 'AI desk', 'Mouse 2', 'Keyboard 2'], 'Separate identities, so AI input never reaches your screen'],
  ['Privacy.md', 'System and safety', 'gate', 'Privacy and Security', ['encrypted', 'stays local'], 'Encrypted at rest; no external API in the pipeline'],
  ['Privacy-Policy.md', 'System and safety', 'gate', 'Privacy Policy', ['your data', 'stays home'], 'What leaves your machine, in plain language'],
  ['Terms.md', 'System and safety', 'fill', 'Terms', ['Read', 'Understand', 'Agree'], 'Plain-language terms of use for running this software'],

  ['Self-Improvement.md', 'Operations', 'cycle', 'Self-Improvement', ['Train', 'Measure', 'Share', 'Repeat'], 'A background loop improves the skill networks over time'],
  ['Bots.md', 'Operations', 'cycle', 'Automated Bots', ['Bolt', 'Sentinel', 'Palette', 'Jules'], 'The PR bots that work on this repository, and their overlaps'],

  ['Sharing.md', 'Sharing and community', 'hub', 'Sharing', ['Sharing', 'Apps', 'Compute', 'Data donor'], 'Off until you act: apps, spare compute and the data donor'],
  ['Commons.md', 'Sharing and community', 'hub', 'Commons', ['Commons', 'Points', 'Projects', 'Hive', 'Trading'], 'Share compute, earn points, finish projects as a team'],
];

const GROUP_ORDER = ['Start here', 'Background', 'Foreground', 'Extension system', 'Reference', 'System and safety', 'Operations', 'Sharing and community'];

// ---- helpers -----------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
const rad = (d) => (d * Math.PI) / 180;
const slugOf = (file) => file.replace(/\.md$/, '').toLowerCase();
/** CSS animation shorthand that holds the first keyframe during any delay, and loops forever. */
const A = (name, dur, delay = 0, timing = 'ease-in-out') => `animation:${name} ${r1(dur)}s ${timing} ${r1(delay)}s infinite both`;
const pillW = (t, size = 13) => Math.max(60, Math.round(t.length * size * 0.6 + 26));

function pill(cx, cy, text, o = {}) {
  const size = o.size ?? 13;
  const w = o.w ?? pillW(text, size);
  const h = o.h ?? 30;
  // The opaque backing stops lines from showing through the label's glass.
  const geo = `x="${r1(cx - w / 2)}" y="${r1(cy - h / 2)}" width="${r1(w)}" height="${h}" rx="${h / 2}"`;
  return `<rect ${geo} fill="#1a1215"/>`
    + `<rect class="pill" ${geo}${o.style ? ` style="${o.style}"` : ''}/>`
    + `<text class="lbl" style="font-size:${size}px" x="${r1(cx)}" y="${r1(cy)}">${esc(text)}</text>`;
}
const legend = (items, sep = '  ·  ') => `<text class="cap" x="240" y="62" text-anchor="middle">${esc(items.join(sep))}</text>`;

// ---- motifs: each returns { css, body } --------------------------------------
const MOTIFS = {
  /** A row of labelled stages; a signal runs from each stage to the next. */
  flow(L) {
    const n = L.length, gap = 16, pw = (440 - gap * (n - 1)) / n, cy = 140, ph = 58, size = n >= 5 ? 12 : 13;
    let body = '';
    for (let i = 0; i < n; i++) {
      const x = 20 + i * (pw + gap);
      body += `<rect class="pill" x="${r1(x)}" y="${cy - ph / 2}" width="${r1(pw)}" height="${ph}" rx="${ph / 2}" style="${A('lit', 2.4, i * 0.8)}"/>`
        + `<text class="lbl" style="font-size:${size}px" x="${r1(x + pw / 2)}" y="${cy}">${esc(L[i])}</text>`;
      if (i < n - 1) {
        const sx = x + pw + 4, ex = 20 + (i + 1) * (pw + gap) - 4;
        body += `<line class="ln" x1="${r1(x + pw)}" y1="${cy}" x2="${r1(x + pw + gap)}" y2="${cy}"/>`
          + `<circle class="dot" cx="${r1(sx)}" cy="${cy}" r="4.5" style="--dx:${r1(ex - sx)}px;--dy:0px;${A('go', 2.4, i * 0.8, 'linear')}"/>`;
      }
    }
    return { css: '', body };
  },

  /** Every neuron linked to every other; signals hop between them. */
  mesh(L) {
    const N = 6, cx = 240, cy = 143, R = 90;
    const P = Array.from({ length: N }, (_, k) => {
      const a = rad(-90 + (k * 360) / N);
      return [cx + R * Math.cos(a), cy + R * Math.sin(a) * 0.9];
    });
    let body = '';
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      body += `<line class="ln" x1="${r1(P[i][0])}" y1="${r1(P[i][1])}" x2="${r1(P[j][0])}" y2="${r1(P[j][1])}"/>`;
    }
    const pairs = [[0, 2], [1, 4], [3, 5], [0, 4], [2, 5], [1, 3], [4, 0], [5, 1]];
    pairs.forEach(([i, j], k) => {
      body += `<circle class="dot" cx="${r1(P[i][0])}" cy="${r1(P[i][1])}" r="4" style="--dx:${r1(P[j][0] - P[i][0])}px;--dy:${r1(P[j][1] - P[i][1])}px;${A('go', 2.6, k * 0.45, 'linear')}"/>`;
    });
    P.forEach((p, k) => {
      body += `<circle class="node fb" cx="${r1(p[0])}" cy="${r1(p[1])}" r="7" style="${A('pulse', 3, k * 0.5)}"/>`;
    });
    body += pill(cx, cy, L[0], { h: 30 });
    return { css: '', body };
  },

  /** Nodes appear one at a time and wire themselves into a small network. */
  grow(L) {
    const P = [[240, 150], [190, 124], [290, 124], [190, 176], [290, 176], [240, 104], [240, 200], [160, 150], [320, 150], [215, 216], [265, 216]];
    const parent = [null, 0, 0, 1, 2, 0, 0, 3, 4, 1, 2];
    let body = legend(L);
    P.forEach((p, i) => {
      if (parent[i] !== null) {
        const q = P[parent[i]];
        body += `<line class="ln" x1="${q[0]}" y1="${q[1]}" x2="${p[0]}" y2="${p[1]}" style="${A('appear', 9, i * 0.6)}"/>`;
      }
    });
    P.forEach((p, i) => {
      body += `<circle class="node fb" cx="${p[0]}" cy="${p[1]}" r="6.5" style="${A('pop', 9, i * 0.6)}"/>`;
    });
    return { css: '', body };
  },

  /** Tall full-precision bars snap onto a coarse grid of steps. */
  bars(L) {
    const n = 12, base = 222, step = 440 / n, bw = 20;
    let body = legend(L, ' → ');
    for (let k = 0; k < n; k++) {
      const h = 70 + ((k * 53) % 7) * 12;
      const q = (Math.round(h / 16) * 16) / h;
      const x = 20 + k * step + (step - bw) / 2;
      body += `<rect class="bar" x="${r1(x)}" y="${base - h}" width="${bw}" height="${h}" rx="6" style="--q:${r1(q)};${A('quant', 6, k * 0.1)}"/>`;
    }
    return { css: '', body };
  },

  /** Stations on a ring with one dot orbiting the middle. */
  cycle(L) {
    const m = L.length, cx = 240, cy = 146, R = 82;
    let body = `<circle class="ln" cx="${cx}" cy="${cy}" r="${R}"/>`;
    body += `<circle cx="${cx}" cy="${cy}" r="18" fill="rgba(227,169,157,.12)" stroke="rgba(255,228,218,.22)"/>`;
    L.forEach((t, k) => {
      const a = rad(-90 + (k * 360) / m);
      body += pill(cx + R * Math.cos(a), cy + R * Math.sin(a), t, { style: A('lit', 7, (k * 7) / m) });
    });
    body += `<g style="transform-origin:${cx}px ${cy}px;${A('spin', 7, 0, 'linear')}"><circle class="dot" style="opacity:1" cx="${cx}" cy="${cy - R}" r="5.5"/></g>`;
    return { css: '', body };
  },

  /** One input splits into several outputs; the signal picks a route. */
  split(L) {
    const m = L.length - 1, cy = 145, inX = 24, inW = 104, outX = 324, outW = 132, outH = 34;
    let body = pill(24 + inW / 2, cy, L[0], { w: inW, h: 40 });
    for (let k = 0; k < m; k++) {
      const oy = cy + (k - (m - 1) / 2) * 56;
      body += `<line class="ln" x1="${inX + inW}" y1="${cy}" x2="${outX}" y2="${r1(oy)}"/>`
        + `<circle class="dot" cx="${inX + inW + 6}" cy="${cy}" r="4.5" style="--dx:${r1(outX - inX - inW - 12)}px;--dy:${r1(oy - cy)}px;${A('go', 2.4, k * 0.9, 'linear')}"/>`
        + pill(outX + outW / 2, oy, L[k + 1], { w: outW, h: outH, style: A('lit', 4.8, k * 0.9) });
    }
    return { css: '', body };
  },

  /** A hub with spokes; a signal goes out to each spoke and draws its line. */
  hub(L) {
    const cx = 240, cy = 145, spokes = L.slice(1), m = spokes.length;
    let body = '';
    spokes.forEach((t, k) => {
      const a = rad(-90 + (k * 360) / m);
      const sx = cx + 165 * Math.cos(a), sy = cy + 72 * Math.sin(a);
      body += `<path class="draw" pathLength="1" d="M${cx} ${cy} L${r1(sx)} ${r1(sy)}" style="animation-delay:${r1(k * 0.4)}s"/>`
        + `<circle class="dot" cx="${cx}" cy="${cy}" r="4.5" style="--dx:${r1(sx - cx)}px;--dy:${r1(sy - cy)}px;${A('go', 2.4, k * 0.6, 'linear')}"/>`
        + pill(sx, sy, t, { style: A('lit', 4.8, k * 0.6) });
    });
    body += pill(cx, cy, L[0], { w: pillW(L[0]) + 16, h: 36, style: 'fill:rgba(227,169,157,.2)' });
    return { css: '', body };
  },

  /** Stages light up one by one while a progress bar runs across them. */
  fill(L) {
    const n = L.length, dur = 8;
    const xs = (i) => 60 + (i * 360) / (n - 1);
    let css = '';
    let body = `<line class="ln" x1="60" y1="130" x2="420" y2="130"/>`
      + `<rect class="prog" x="60" y="128.5" width="360" height="3" rx="1.5" style="${A('prog', dur, 0, 'linear')}"/>`;
    for (let i = 0; i < n; i++) {
      const p = Math.round((i / (n - 1)) * 100);
      css += `@keyframes st${i}{0%{fill:rgba(255,240,232,.08)}${p}%{fill:rgba(255,240,232,.08)}${Math.min(p + 1, 100)}%,100%{fill:#e3a99d}}`;
      body += `<circle class="stage" cx="${r1(xs(i))}" cy="130" r="12" style="animation:st${i} ${dur}s linear infinite both"/>`
        + `<text class="cap" x="${r1(xs(i))}" y="172" text-anchor="middle">${esc(L[i])}</text>`;
    }
    return { css, body };
  },

  /** A gauge with a needle that sweeps between its ends. */
  dial(L) {
    const cx = 240, cy = 178, R = 120;
    let body = `<path d="M${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="rgba(255,228,218,.22)" stroke-width="14" stroke-linecap="round"/>`
      + `<path d="M${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="#c98476" stroke-width="14" stroke-linecap="round" opacity=".55"/>`
      + `<g style="transform-origin:${cx}px ${cy}px;${A('sweep', 6, 0)}"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 100}" stroke="#efd0c8" stroke-width="3" stroke-linecap="round"/></g>`
      + `<circle cx="${cx}" cy="${cy}" r="8" fill="#e3a99d"/>`
      + `<text class="cap" x="${cx - R}" y="${cy + 26}" text-anchor="middle">${esc(L[0])}</text>`
      + `<text class="cap" x="${cx + R}" y="${cy + 26}" text-anchor="middle">${esc(L[L.length - 1])}</text>`;
    if (L.length === 3) body += `<text class="cap" x="${cx}" y="${cy + 26}" text-anchor="middle">${esc(L[1])}</text>`;
    return { css: '', body };
  },

  /** Layers stacked top to bottom, with a bead running down a side rail. */
  stack(L) {
    const n = L.length, h = 30, gap = 12, x = 100, w = 280;
    const top = 66, total = n * h + (n - 1) * gap;
    let body = '';
    L.forEach((t, k) => {
      const y = top + k * (h + gap);
      body += `<rect class="pill" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" style="${A('lit', n * 1.2, k * 0.8)}"/>`
        + `<text class="lbl" x="${x + w / 2}" y="${y + h / 2}">${esc(t)}</text>`;
    });
    body += `<line class="ln" x1="412" y1="${top}" x2="412" y2="${top + total}"/>`
      + `<circle class="dot" cx="412" cy="${top}" r="5" style="--dx:0px;--dy:${total}px;${A('go', 3.2, 0, 'linear')}"/>`;
    return { css: '', body };
  },

  /** Lines of code type out, one after another, by a cover that wipes away. */
  typing(L) {
    let body = '', defs = '';
    L.forEach((t, k) => {
      const y = 92 + k * 40;
      defs += `<clipPath id="reveal${k}"><rect x="56" y="${y - 16}" width="0" height="30" style="${A('reveal', 7, k * 0.9)}"/></clipPath>`;
      body += `<text class="code" clip-path="url(#reveal${k})" x="60" y="${y}">${esc(t)}</text>`;
    });
    return { css: '', body: `<defs>${defs}</defs>${body}` };
  },

  /** A grid of binary digits that keep flipping, with the two labels above. */
  bits(L) {
    let body = legend(L, ' → ');
    const cols = 12, rows = 4;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const x = 60 + c * 32.7, y = 104 + r * 32;
      const d = -((idx * 0.37) % 4);
      body += `<text class="code" x="${r1(x)}" y="${y}" text-anchor="middle" style="${A('flip', 4, d, 'steps(1,end)')}">0</text>`
        + `<text class="code" x="${r1(x)}" y="${y}" text-anchor="middle" style="${A('flipB', 4, d, 'steps(1,end)')}">1</text>`;
    }
    return { css: '', body };
  },

  /** A big block squeezes down to a small stand-in; a dot marks the handover. */
  shrink(L) {
    let body = `<rect class="pill" x="50" y="86" width="230" height="130" rx="28" style="transform-origin:165px 151px;${A('shrink', 6, 0)}"/>`
      + `<text class="lbl" style="font-size:15px" x="165" y="151">${esc(L[0])}</text>`
      + pill(385, 151, L[1], { w: 110, h: 60 });
    for (let k = 0; k < 3; k++) {
      body += `<circle class="dot" cx="290" cy="151" r="4.5" style="--dx:36px;--dy:0px;${A('go', 2.4, k * 0.8, 'linear')}"/>`;
    }
    return { css: '', body };
  },

  /** Two sine waves drift; where they meet they add up. */
  wave(L) {
    const rows = [
      { cy: 110, A: 18, ph: 0, col: '#e3a99d', dur: 3.6 },
      { cy: 145, A: 24, ph: 1.7, col: '#efd0c8', dur: 4.6 },
      { cy: 180, A: 14, ph: 3.1, col: '#c98476', dur: 5.8 },
    ];
    let body = legend(L);
    for (const row of rows) {
      let d = '';
      for (let x = 0; x <= 600; x += 6) {
        const y = row.cy + row.A * Math.sin((2 * Math.PI * x) / 120 + row.ph);
        d += `${x === 0 ? 'M' : 'L'}${x} ${r1(y)} `;
      }
      body += `<g style="${A('drift', row.dur, 0, 'linear')}"><path d="${d.trim()}" fill="none" stroke="${row.col}" stroke-width="2.5" stroke-linecap="round" opacity=".85"/></g>`;
    }
    return { css: '', body };
  },

  /** A root branches into several leaves, drawing its branches and sending a dot out along each. */
  tree(L) {
    const kids = L.slice(1), m = kids.length;
    let body = pill(240, 96, L[0], { w: 130 });
    kids.forEach((t, k) => {
      const x = 240 + (k - (m - 1) / 2) * 150, y = 190;
      body += `<path class="draw" pathLength="1" d="M240 112 C240 150 ${r1(x)} 150 ${r1(x)} ${y - 16}" style="animation-delay:${r1(k * 0.5)}s"/>`
        + `<circle class="dot" cx="240" cy="112" r="3.5" style="--dx:${r1(x - 240)}px;--dy:${r1(y - 16 - 112)}px;${A('go', 3, k * 0.5, 'linear')}"/>`
        + pill(x, y, t, { style: A('lit', 6, k * 0.5 + 1.2) });
    });
    return { css: '', body };
  },

  /** Notes that arrive at a central point from scattered spots, then scatter and reform. */
  assemble(L) {
    const cols = 4, cell = 34, gap = 8, sx = 240 - (cols * cell + (cols - 1) * gap) / 2, sy = 108;
    let body = legend(L, '  +  ');
    for (let k = 0; k < 8; k++) {
      const c = k % cols, r = Math.floor(k / cols);
      const x = sx + c * (cell + gap), y = sy + r * (cell + gap);
      const dx = ((k * 53) % 7 - 3) * 38, dy = ((k * 29) % 5 - 2) * 22;
      body += `<rect class="${k % 2 ? 'pieceA' : 'pieceB'}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="10" style="--dx:${dx}px;--dy:${dy}px;${A('gather', 6, -k * 0.3)}"/>`;
    }
    return { css: '', body };
  },

  /** A gate in the middle: most items stop at it, a few get through. */
  gate(L) {
    let body = `<text class="lbl" x="84" y="100">${esc(L[0])}</text>`
      + `<text class="lbl" x="396" y="100">${esc(L[1])}</text>`
      + `<rect x="226" y="72" width="28" height="150" rx="14" fill="rgba(227,169,157,.16)" stroke="rgba(227,169,157,.5)" stroke-width="1.5"/>`
      + `<text class="cap" x="240" y="240" text-anchor="middle">gate</text>`;
    [120, 140, 160, 180].forEach((y, k) => {
      body += `<circle class="dot" cx="60" cy="${y}" r="4.5" style="--dx:164px;${A('block', 3.2, k * 0.8, 'linear')}"/>`;
    });
    [130, 160].forEach((y, k) => {
      body += `<circle class="dot" cx="254" cy="${y}" r="4.5" style="--dx:180px;--dy:0px;${A('go', 3.2, 1.6 + k * 1.6, 'linear')}"/>`;
    });
    return { css: '', body };
  },

  /** Items fall from one slot and drop into one of two bins. */
  sort(L) {
    let body = pill(240, 84, L[0], { w: 150 })
      + pill(130, 214, L[1], { w: 120 })
      + pill(350, 214, L[2], { w: 120 });
    for (let k = 0; k < 8; k++) {
      const side = k % 2 ? 1 : -1;
      body += `<circle class="dot" cx="240" cy="112" r="4.5" style="--dx:${side * 110}px;--dy:102px;${A('go', 3, k * 0.45, 'linear')}"/>`;
    }
    return { css: '', body };
  },
};

// ---- the shared stylesheet, in the house palette -----------------------------
const BASE_CSS = `
text{font-family:ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'Segoe UI',sans-serif;fill:#f8ede9}
.ttl{font-size:15px;font-weight:600;fill:#efd0c8}
.cap{font-size:12px;fill:rgba(248,237,233,.62)}
.lbl{font-size:13px;text-anchor:middle;dominant-baseline:central}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;fill:#efd0c8}
.pill{fill:rgba(255,240,232,.08);stroke:rgba(255,228,218,.22);stroke-width:1.5}
.ln{fill:none;stroke:rgba(255,228,218,.22);stroke-width:1.5}
.draw{fill:none;stroke:rgba(255,228,218,.34);stroke-width:1.6;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;${A('draw', 6, 0)}}
.dot{fill:#efd0c8;opacity:0}
.node{fill:#c98476}
.stage{fill:rgba(255,240,232,.08);stroke:rgba(255,228,218,.3);stroke-width:1.5}
.bar{fill:rgba(227,169,157,.55);transform-box:fill-box;transform-origin:50% 100%}
.prog{fill:#e3a99d;transform-box:fill-box;transform-origin:0 50%}
.pieceA{fill:#c98476}
.pieceB{fill:#efd0c8}
.fb{transform-box:fill-box;transform-origin:center}
@keyframes go{0%{opacity:0;transform:translate(0,0)}12%{opacity:1}80%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy))}}
@keyframes block{0%{opacity:0;transform:translate(0,0)}15%{opacity:1}70%{opacity:1;transform:translate(var(--dx),0)}85%,100%{opacity:0;transform:translate(var(--dx),0)}}
@keyframes lit{0%,100%{fill:rgba(255,240,232,.08)}12%,30%{fill:rgba(227,169,157,.26)}55%{fill:rgba(255,240,232,.08)}}
@keyframes pulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.3)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes draw{0%{stroke-dashoffset:1}40%,75%{stroke-dashoffset:0}100%{stroke-dashoffset:1}}
@keyframes appear{0%{opacity:0}20%,80%{opacity:1}100%{opacity:0}}
@keyframes pop{0%{opacity:0;transform:scale(.2)}15%,80%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1)}}
@keyframes drift{to{transform:translateX(-120px)}}
@keyframes prog{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes sweep{0%{transform:rotate(-70deg)}50%{transform:rotate(70deg)}100%{transform:rotate(-70deg)}}
@keyframes reveal{0%{width:0}15%,85%{width:380px}100%{width:0}}
@keyframes flip{0%,45%{opacity:1}50%,100%{opacity:0}}
@keyframes flipB{0%,45%{opacity:0}50%,100%{opacity:1}}
@keyframes quant{0%,30%{transform:scaleY(1)}60%,100%{transform:scaleY(var(--q))}}
@keyframes shrink{0%,20%{transform:scale(1)}55%,100%{transform:scale(.45)}}
@keyframes gather{0%{transform:translate(var(--dx),var(--dy))}40%,60%{transform:translate(0,0)}100%{transform:translate(var(--dx),var(--dy))}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

// ---- build -------------------------------------------------------------------
function buildSvg(entry, motif) {
  const [file, , , title, , caption] = entry;
  const id = slugOf(file);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" width="480" height="270" role="img" aria-labelledby="t-${id}">
<title id="t-${id}">${esc(title)}: ${esc(caption)}</title>
<defs><linearGradient id="bg-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1216"/><stop offset="1" stop-color="#110c0e"/></linearGradient></defs>
<style>${BASE_CSS}${motif.css}</style>
<rect width="480" height="270" rx="32" fill="url(#bg-${id})"/>
<rect x=".75" y=".75" width="478.5" height="268.5" rx="31.5" fill="none" stroke="rgba(255,228,218,.2)"/>
<text class="ttl" x="26" y="38">${esc(title)}</text>
${motif.body}
<text class="cap" x="240" y="257" text-anchor="middle">${esc(caption)}</text>
</svg>
`;
}

function readmeSection() {
  let out = `## The wiki in motion\n\nEvery page in the [wiki](wiki/Home.md) has its own animation. Click one to open the page. The animations are generated by [scripts/make-wiki-animations.mjs](scripts/make-wiki-animations.mjs) and live in [docs/media/wiki/](docs/media/wiki/).\n`;
  for (const group of GROUP_ORDER) {
    const items = PAGES.filter((p) => p[1] === group);
    if (!items.length) continue;
    out += `\n### ${group}\n\n<table>\n`;
    for (let i = 0; i < items.length; i += 2) {
      out += '<tr>\n';
      for (const [file, , , title, , caption] of items.slice(i, i + 2)) {
        out += `<td><a href="wiki/${file}"><img src="docs/media/wiki/${slugOf(file)}.svg" alt="${esc(title)}: ${esc(caption)}" width="400"></a><br><sub><b>${esc(title)}</b></sub></td>\n`;
      }
      if (items.length - i === 1) out += '<td></td>\n';
      out += '</tr>\n';
    }
    out += '</table>\n';
  }
  return out;
}

function withReadme(text, section) {
  const block = `${START}\n${section}${END}`;
  if (text.includes(START)) {
    return text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block);
  }
  if (!text.includes(ANCHOR)) throw new Error(`README has no "${ANCHOR}" anchor to place the section before`);
  return text.replace(ANCHOR, () => `${block}\n${ANCHOR}`);
}

// Coverage: every wiki page must have an entry, and every entry a page.
const pages = readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md') && f !== '_Sidebar.md').sort();
const listed = PAGES.map((p) => p[0]).sort();
const missing = pages.filter((f) => !listed.includes(f));
const extra = listed.filter((f) => !pages.includes(f));
if (missing.length || extra.length) {
  console.error(`coverage mismatch. no animation for: ${missing.join(', ') || '(none)'}; no page for: ${extra.join(', ') || '(none)'}`);
  process.exit(1);
}

const outputs = new Map();
for (const entry of PAGES) {
  const [file, , motifName, , labels, caption] = entry;
  const motif = MOTIFS[motifName];
  if (!motif) throw new Error(`${file}: unknown motif ${motifName}`);
  if (caption.length > 66) console.warn(`${file}: caption is ${caption.length} characters, may not fit`);
  outputs.set(path.join(OUT_DIR, `${slugOf(file)}.svg`), buildSvg(entry, motif(labels)));
}

const readmeText = readFileSync(README, 'utf8');
outputs.set(README, withReadme(readmeText, readmeSection()));

if (CHECK) {
  const stale = [];
  for (const [p, content] of outputs) {
    let current = null;
    try { current = readFileSync(p, 'utf8'); } catch { /* missing */ }
    if (current !== content) stale.push(path.relative(ROOT, p));
  }
  if (stale.length) {
    console.error(`stale or missing (run node scripts/make-wiki-animations.mjs): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log(`ok: ${PAGES.length} animations and the README section are up to date`);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [p, content] of outputs) writeFileSync(p, content);
  console.log(`wrote ${PAGES.length} animations to docs/media/wiki/ and updated README.md`);
}
