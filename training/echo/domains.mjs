/**
 * The ladder's domains, in the owner's order: music, art, animal, human speech, text, chips, coding, simulation,
 * research, NeuroLang. Each one is a rule set (see rules.mjs) written for this project from scratch.
 *
 * A domain is:
 *   id, tag        a name and the one byte that marks it in a sample's header
 *   walk           the rules, as a `Walk` (count / enumerate / shuffle / random / legal-next)
 *   alphabet       every symbol (byte) the domain can use, for the "random guess" baseline
 *   levels         tune lengths, shortest first; level N means `levels[N]` symbols
 *   show(tune)     a readable form, for people only
 *   label(tune)    optional: the exact truth about a tune, got by RUNNING it (truth table, result, final state)
 *   raw(tune)      optional: the raw bytes the network would really see (audio, pixels)
 *
 * Honest limits: music, art, animal, speech, chips, coding and simulation carry real rules for their structure.
 * Research and NeuroLang here are the SHAPE rules only (research: search before you answer, quote only what was
 * found, say "not in these sources" when nothing was; NeuroLang: the line forms in wiki/Syntax.md). The content
 * generators for those two come later. Simulation is good-only: harvest and give exist, attack and steal do not
 * (see "Good examples only" in docs/TRAINING_CURRICULUM.md).
 */
import { Walk } from './rules.mjs';
import { musicSpec, musicWalk, DEGREES, toMidi, renderPcm8 } from './music.mjs';

const code = (ch) => ch.charCodeAt(0);
const codes = (s) => [...s].map(code);
const bytesOf = (s) => Uint8Array.from(codes(s));
const chars = (tune) => String.fromCharCode(...tune);
const range = (n) => Array.from({ length: n }, (_, i) => i);

function domain(d) {
  return { show: (t) => t.join(' '), label: null, raw: null, ...d };
}

// ---------- 1. music ----------
const music = domain({
  id: 'music',
  tag: 1,
  name: 'Music from theory rules',
  walk: musicWalk,
  alphabet: range(DEGREES),
  levels: [4, 6, 8, 10, 12],
  label: (tune) => Uint8Array.from(toMidi(tune, 60, 'major')),
  raw: (tune) => renderPcm8(toMidi(tune, 60, 'major')),
});

// ---------- 2. art: a strip of colours on a six-step hue wheel ----------
// Harmony rule: next to a colour you may put the same colour (at most twice running), a neighbour on the wheel
// (analogous) or the opposite colour (complementary). The strip starts and ends on the home colour 0.
const HARMONY = new Set([1, 5, 3]);
const art = domain({
  id: 'art',
  tag: 2,
  name: 'Art: colour harmony and symmetry',
  walk: new Walk({
    init: 'S',
    next: (st) => {
      if (st === 'S') return [[0, '0:1']];
      const [c, runS] = st.split(':').map(Number);
      const out = [];
      for (let d = 0; d < 6; d++) {
        const diff = (d - c + 6) % 6;
        if (diff === 0) { if (runS < 2) out.push([d, `${d}:${runS + 1}`]); } else if (HARMONY.has(diff)) out.push([d, `${d}:1`]);
      }
      return out;
    },
    accept: (st) => st !== 'S' && st.split(':')[0] === '0',
  }),
  alphabet: range(6),
  levels: [3, 4, 5, 6, 7, 8],
  // The picture the network really sees: the strip mirrored (a symmetric row), 3 bytes per pixel (R, G, B).
  raw: (tune) => {
    const row = [...tune, ...tune.slice().reverse()];
    const out = new Uint8Array(row.length * 3);
    row.forEach((c, i) => out.set(hueToRgb(c * 60), i * 3));
    return out;
  },
});

function hueToRgb(h) {
  const s = 0.8;
  const v = 0.9;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

// ---------- 3. animal: a signal system where order carries meaning (rung D of the animal ladder) ----------
// Calls: 0 alarm, 1 food, 2 contact. Suffixes: 3 "here", 4 "gone" (a call about something not present).
// 5 stop, 6 silence. Rule: one or two DIFFERENT calls, then optionally one suffix, then stop, then silence.
const ANIMAL = ['alarm', 'food', 'contact', 'here', 'gone', 'stop', 'silence'];
const animal = domain({
  id: 'animal',
  tag: 3,
  name: 'Animal calls: order carries meaning',
  walk: new Walk({
    init: 'S',
    next: (st) => {
      if (st === 'S') return [0, 1, 2].map((c) => [c, `A1${c}`]);
      if (st.startsWith('A1')) {
        const first = Number(st[2]);
        return [...[0, 1, 2].filter((c) => c !== first).map((c) => [c, 'A2']), [3, 'X'], [4, 'X'], [5, 'E']];
      }
      if (st === 'A2') return [[3, 'X'], [4, 'X'], [5, 'E']];
      if (st === 'X') return [[5, 'E']];
      return [[6, 'E']];
    },
    accept: (st) => st === 'E',
  }),
  alphabet: range(7),
  levels: [2, 3, 4, 5, 6],
  show: (t) => t.map((s) => ANIMAL[s]).join(' '),
});

// ---------- 4. human speech without words: "blah blah" (consonant-vowel babble with pauses) ----------
// Rule: every syllable is a consonant then a vowel, a word has one to three syllables, a pause ends a word, and the
// clip ends on a pause.
const speech = domain({
  id: 'speech',
  tag: 4,
  name: 'People talking, no words: babble with pauses',
  walk: new Walk({
    init: 'S',
    next: (st) => {
      const cons = codes('bdlm');
      const vows = codes('aiu');
      if (st === 'S' || st === 'P') return cons.map((c) => [c, 'V0']);
      const n = Number(st[1]);
      if (st[0] === 'V') return vows.map((v) => [v, `W${n + 1}`]);
      return [...(n < 3 ? cons.map((c) => [c, `V${n}`]) : []), [code('_'), 'P']];
    },
    accept: (st) => st === 'P',
  }),
  alphabet: codes('bdlmaiu_'),
  levels: [3, 5, 7, 9, 11],
  show: chars,
});

// ---------- 5 and 10. phrase grammars at byte level: text and NeuroLang ----------
// Templates are lists of slots; a slot is words joined by "|". The machine types the bytes one at a time, so the
// network sees raw bytes, never words or tokens. Several templates can be alive at once (subset construction).
const J = '\u0001';
const F = '\u0002';

function phraseSpec(templates, { sep = ' ', end = '.', pad = '\n' } = {}) {
  const slots = templates.map((t) => t.map((s) => s.split('|')));
  const all = [];
  for (const w of slots.flat(2)) for (const ch of w) all.push(ch);
  all.push(...sep, ...end, ...pad);
  if (all.some((ch) => code(ch) > 255)) throw new Error('phrase text must be single-byte');
  const init = slots.map((_, t) => `${t}${F}0${F}`).join(J);
  const next = (key) => {
    const moves = new Map();
    const add = (sym, cfg) => (moves.get(sym) ?? moves.set(sym, new Set()).get(sym)).add(cfg);
    for (const cfg of key.split(J)) {
      if (cfg === 'END') { add(code(pad), 'END'); continue; }
      const [t, slotS, typed] = cfg.split(F);
      const slot = Number(slotS);
      for (const w of slots[t][slot]) {
        if (!w.startsWith(typed)) continue;
        if (w.length > typed.length) add(code(w[typed.length]), `${t}${F}${slot}${F}${typed}${w[typed.length]}`);
        else if (slot === slots[t].length - 1) add(code(end), 'END');
        else add(code(sep), `${t}${F}${slot + 1}${F}`);
      }
    }
    return [...moves].map(([sym, set]) => [sym, [...set].sort().join(J)]);
  };
  const lens = templates.map((t, i) => {
    const per = slots[i].map((ws) => ws.map((w) => w.length));
    const gaps = (t.length - 1) * sep.length + end.length;
    return [per.reduce((a, l) => a + Math.min(...l), gaps), per.reduce((a, l) => a + Math.max(...l), gaps)];
  });
  const lo = Math.min(...lens.map((l) => l[0]));
  const hi = Math.max(...lens.map((l) => l[1]));
  return {
    walk: new Walk({ init, next, accept: (k) => k === 'END' }),
    alphabet: [...new Set(all.map(code))].sort((a, b) => a - b),
    levels: [...new Set([lo, Math.floor((lo + hi) / 2), hi])],
  };
}

const textSpec = phraseSpec([
  ['the|a', 'cat|dog|bird', 'sat|ran|slept'],
  ['the|a', 'small|red', 'cat|dog|bird', 'sat|ran|slept'],
]);
const text = domain({ id: 'text', tag: 5, name: 'Text as raw bytes: short sentences', ...textSpec, show: chars });

// ---------- 6. chips: a netlist of two-input gates over inputs a (0) and b (1) ----------
// A gate is three symbols: op (0 AND, 1 OR, 2 XOR, 3 NAND), then two DIFFERENT earlier signals, lower first. The
// last gate is the output. Label: the truth table, got by simulating the netlist.
const GATE = [(x, y) => x & y, (x, y) => x | y, (x, y) => x ^ y, (x, y) => 1 - (x & y)];
const chips = domain({
  id: 'chips',
  tag: 6,
  name: 'Chips: gate netlists, verified by simulation',
  walk: new Walk({
    init: 'O:2',
    next: (st) => {
      const [ph, nS, a, b] = st.split(':');
      const n = Number(nS);
      if (ph === 'O') return range(4).map((op) => [op, `A:${n}:${op}`]);
      if (ph === 'A') return range(n - 1).map((s) => [s, `B:${n}:${a}:${s}`]);
      return range(n).filter((s) => s > Number(b)).map((s) => [s, `O:${n + 1}`]);
    },
    accept: (st) => st.startsWith('O:'),
  }),
  alphabet: range(5),
  levels: [3, 6, 9],
  show: (t) => {
    const names = ['AND', 'OR', 'XOR', 'NAND'];
    const g = [];
    for (let i = 0; i < t.length; i += 3) g.push(`${names[t[i]]}(${t[i + 1]},${t[i + 2]})`);
    return g.join(' ');
  },
  label: (tune) => {
    const out = [];
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const sig = [a, b];
      for (let i = 0; i < tune.length; i += 3) sig.push(GATE[tune[i]](sig[tune[i + 1]], sig[tune[i + 2]]));
      out.push(sig[sig.length - 1]);
    }
    return Uint8Array.from(out);
  },
});

// ---------- 7. coding: tiny stack programs (reverse Polish) over the digits 1..4 ----------
// Rule: push a digit while the stack holds fewer than 3; an operator needs two on the stack; end with exactly one.
// Label: the result, got by running the program.
const coding = domain({
  id: 'coding',
  tag: 7,
  name: 'Coding: stack programs, verified by running',
  walk: new Walk({
    init: 'd0',
    next: (st) => {
      const k = Number(st.slice(1));
      return [...(k < 3 ? codes('1234').map((c) => [c, `d${k + 1}`]) : []), ...(k >= 2 ? codes('+-*').map((c) => [c, `d${k - 1}`]) : [])];
    },
    accept: (st) => st === 'd1',
  }),
  alphabet: codes('1234+-*'),
  levels: [3, 5, 7, 9],
  show: chars,
  label: (tune) => {
    const st = [];
    for (const c of tune) {
      const ch = String.fromCharCode(c);
      if (ch >= '1' && ch <= '4') st.push(Number(ch));
      else {
        const y = st.pop();
        const x = st.pop();
        st.push(ch === '+' ? x + y : ch === '-' ? x - y : x * y);
      }
    }
    return bytesOf(String(st[0]));
  },
});

// ---------- 8. simulation: a 3x3 world where an agent gathers food and gives it to a friend ----------
// n s w e move (inside the grid). h harvests when standing on the food (2,0) with empty hands. g gives when standing
// by the friend (0,2) while holding food. The run must end after the gift. Only good actions exist here.
const simulation = domain({
  id: 'simulation',
  tag: 8,
  name: 'Simulation: harvest and give, good actions only',
  walk: new Walk({
    init: '0,0,0,0',
    next: (st) => {
      const [x, y, h, k] = st.split(',').map(Number);
      const out = [];
      if (y > 0) out.push([code('n'), `${x},${y - 1},${h},${k}`]);
      if (y < 2) out.push([code('s'), `${x},${y + 1},${h},${k}`]);
      if (x > 0) out.push([code('w'), `${x - 1},${y},${h},${k}`]);
      if (x < 2) out.push([code('e'), `${x + 1},${y},${h},${k}`]);
      if (x === 2 && y === 0 && h === 0) out.push([code('h'), `${x},${y},1,${k}`]);
      if (x === 0 && y === 2 && h === 1) out.push([code('g'), `${x},${y},0,1`]);
      return out;
    },
    accept: (st) => st.endsWith(',1'),
  }),
  alphabet: codes('nswehg'),
  levels: [8, 9, 10, 11, 12],
  show: chars,
  label(tune) {
    return bytesOf(this.walk.after(tune));
  },
});

// ---------- 9. research: the order of a trustworthy answer ----------
// Q a question, S search, then EITHER F found + q quote + c cite, OR N nothing found + u "not in these sources".
// No answer without a search, no quote without a find, no citation without a quote. "." is silence.
const research = domain({
  id: 'research',
  tag: 9,
  name: 'Research: search, quote and cite, or say not found',
  walk: new Walk({
    init: 'a',
    next: (st) =>
      ({
        a: [[code('Q'), 'b']],
        b: [[code('S'), 'c']],
        c: [[code('F'), 'd'], [code('N'), 'g']],
        d: [[code('q'), 'e']],
        e: [[code('c'), 'E']],
        g: [[code('u'), 'E']],
        E: [[code('.'), 'E']],
      })[st],
    accept: (st) => st === 'E',
  }),
  alphabet: codes('QSFNqcu.'),
  levels: [5, 6, 7, 8],
  show: chars,
});

// ---------- 10. NeuroLang: the line forms in wiki/Syntax.md and wiki/NeuroLang.md ----------
const neuroSpec = phraseSpec(
  [
    [
      'kind="network"',
      'neurons="2"|neurons="4"',
      '"n1"@input="hello"\n"n1"@response="hi there"|"n1"@input="bye"\n"n1"@response="see you"',
      'train="responses"',
    ],
  ],
  { sep: '\n', end: '\n', pad: '\n' },
);
const neurolang = domain({ id: 'neurolang', tag: 10, name: 'NeuroLang: nets written as text', ...neuroSpec, show: chars });

export const DOMAINS = [music, art, animal, speech, text, chips, coding, simulation, research, neurolang];
export const byId = (id) => DOMAINS.find((d) => d.id === id);
export { musicSpec };
