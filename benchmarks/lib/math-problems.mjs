// Randomly generated math exam. Every run builds a new one from a new seed.
//
//   TEACHING SET   a random 60% of the facts a op b for a, b in 0..T (T = 12) and op in + - *.
//                  Which 60% changes every run. This is all a solver is ever shown.
//   EXAM           problems drawn fresh from kinds, none of them a taught fact:
//     interp     an unseen pair inside the taught range          (generalise within the range)
//     extrap     an operand beyond T                              (generalise outside the range)
//     chain      three or more numbers, left to right, in symbols or in steps  (compose answers)
//     worded     an unseen pair asked in words                    (read the question)
//     negative   a - b with a < b                                 (answers below zero)
//     identity   an unseen pair with 0 or 1 in it, from level 2   (edge cases)
// The answer is always computed here, exactly, from the parts. A solver gets the problem as both text
// and structured parts and may use either.
//
// ANCHOR items are fixed-recipe (level 1, equal weights). ADAPTIVE items use the family's current
// level and tag weights (see mutating-tests.mjs). A problem already served in any earlier run is
// never served again (run.claim()).
import { int, pick, shuffled, weightedPick, ANCHOR_SHARE } from './mutating-tests.mjs';

export const FAMILY = 'math';
export const T = 12;
const OPS = ['+', '-', '*'];
const apply = (a, b, op) => (op === '+' ? a + b : op === '-' ? a - b : a * b);
export const evalParts = ({ operands, ops }) => operands.slice(1).reduce((acc, x, i) => apply(acc, x, ops[i]), operands[0]);

const WORDINGS = {
  '+': ['{a} + {b} = ?', 'What is {a} plus {b}?', 'Add {b} to {a}.', 'What do you get when you add {a} and {b}?', 'Sum of {a} and {b}?', 'You have {a} apples and get {b} more. How many apples now?', 'Total of {a} and {b}, please.'],
  '-': ['{a} - {b} = ?', 'What is {a} minus {b}?', 'Subtract {b} from {a}.', 'What is {a} take away {b}?', 'Take {b} away from {a}. What is left?', 'You have {a} apples and give away {b}. How many are left?', 'Start at {a} and count back {b}.'],
  '*': ['{a} * {b} = ?', 'What is {a} times {b}?', 'Multiply {a} by {b}.', 'Product of {a} and {b}?', '{a} groups of {b}: how many in total?', 'What is {a} multiplied by {b}?', '{a} rows of {b} seats. How many seats?'],
};
const STEP = { '+': (x) => `add ${x}`, '-': (x) => `subtract ${x}`, '*': (x) => `multiply by ${x}` };
const PREFIX = ['Quick one: ', 'Hey, ', 'Okay so ', 'Please work this out. ', 'Question: ', 'Try this: '];
const SUFFIX = [' Thanks.', ' Show only the number.', ' Take your time.', ' Be exact.'];

function decorate(text, r, level) {
  const tags = [];
  if (level >= 2 && r() < 0.3 + 0.1 * level) { text = pick(r, PREFIX) + text; tags.push('noise:prefix'); }
  if (level >= 3 && r() < 0.3) { text += pick(r, SUFFIX); tags.push('noise:suffix'); }
  if (level >= 4 && r() < 0.15) { text = text.toLowerCase(); tags.push('noise:lower'); }
  return { text, tags };
}
function binaryText(a, b, op, r, level, allowWords) {
  const list = WORDINGS[op], usable = allowWords ? list.slice(0, Math.min(list.length, 2 + level)) : [list[0]];
  const i = int(r, 0, usable.length - 1);
  return { text: usable[i].replace('{a}', a).replace('{b}', b), tags: [i === 0 ? 'style:symbols' : 'style:words'] };
}
function chainText(operands, ops, r, level) {
  if (level >= 2 && r() < 0.5) {
    const t = `Start with ${operands[0]}, ${ops.map((op, i) => STEP[op](operands[i + 1])).join(', then ')}. What do you end with?`;
    return { text: t, tags: ['style:steps'] };
  }
  let s = String(operands[0]);
  ops.forEach((op, i) => { s = `(${s} ${op} ${operands[i + 1]})`; });
  return { text: `Compute ${s.slice(1, -1)}.`, tags: ['style:symbols'] };
}

const KINDS = [['interp', 1], ['extrap', 1], ['chain', 1], ['worded', 1], ['negative', 1], ['identity', 2]];
const ANCHOR_KINDS = KINDS.filter(([, lv]) => lv === 1).map(([k]) => k);

/** The teaching set and the held-out pool for this run. */
export function teachingSet(run, { trainFraction = 0.6 } = {}) {
  const r = run.rngFor('teaching-set');
  const all = [];
  for (const op of OPS) for (let a = 0; a <= T; a++) for (let b = 0; b <= T; b++) all.push({ a, b, op });
  const order = shuffled(r, all), cut = Math.round(order.length * trainFraction);
  const train = order.slice(0, cut).map((f) => ({ ...f, result: apply(f.a, f.b, f.op), text: `${f.a} ${f.op} ${f.b} = ?` }));
  const heldOut = order.slice(cut);
  return { train, heldOut };
}

/**
 * Build the exam. Returns { T, train, seen, test }. `test` problems:
 *   { id, kind, text, parts: { operands, ops }, answer, track, tags }
 * `seen` is a sample of taught problems, used only to measure the gap between remembered and fresh.
 */
export function buildExam(run, { n = 200 } = {}) {
  const { train, heldOut } = teachingSet(run);
  const r = run.rngFor('exam-items');
  const test = [];
  const pairOk = (f) => heldOut.some((h) => h.a === f.a && h.b === f.b && h.op === f.op);
  const heldBy = (pred) => heldOut.filter(pred);

  const make = (kind, track) => {
    const level = run.level(FAMILY, track);
    const allowWords = kind === 'worded';
    let parts, base;
    if (kind === 'interp' || kind === 'worded' || kind === 'negative' || kind === 'identity') {
      const pool = kind === 'negative' ? heldBy((f) => f.op === '-' && f.a < f.b)
        : kind === 'identity' ? heldBy((f) => f.a <= 1 || f.b <= 1) : heldOut;
      if (!pool.length) return null;
      const f = pick(r, pool);
      parts = { operands: [f.a, f.b], ops: [f.op] };
      base = binaryText(f.a, f.b, f.op, r, level, allowWords || level >= 3);
    } else if (kind === 'extrap') {
      const span = 4 * level, hi = T + span;
      const op = pick(r, OPS);
      let a = int(r, 0, hi), b = int(r, 0, hi);
      if (a <= T && b <= T) { if (r() < 0.5) a = int(r, T + 1, hi); else b = int(r, T + 1, hi); }
      parts = { operands: [a, b], ops: [op] };
      base = binaryText(a, b, op, r, level, level >= 3);
    } else {                                                           // chain
      const len = track === 'anchor' ? 3 : Math.min(5, 2 + level);
      const operands = Array.from({ length: len }, () => int(r, 0, T)), ops = Array.from({ length: len - 1 }, () => pick(r, OPS));
      parts = { operands, ops };
      base = chainText(operands, ops, r, track === 'anchor' ? 1 : level);
    }
    const { text, tags: noise } = track === 'anchor' ? { text: base.text, tags: [] } : decorate(base.text, r, level);
    const answer = evalParts(parts);
    const size = Math.max(...parts.operands) > T ? 'size:beyond' : 'size:inside';
    const tags = [`kind:${kind}`, ...parts.ops.map((o) => `op:${o}`), size, ...base.tags, ...noise];
    return { kind, text, parts, answer, track, tags };
  };

  let guard = 0;
  while (test.length < n && guard++ < n * 60) {
    const track = r() < ANCHOR_SHARE ? 'anchor' : 'adaptive';
    const level = run.level(FAMILY, track);
    const kinds = (track === 'anchor' ? ANCHOR_KINDS : KINDS.filter(([, lv]) => lv <= level).map(([k]) => k));
    const kind = weightedPick(r, kinds.map((k) => [k, run.weight(FAMILY, `kind:${k}`, track)]));
    const p = make(kind, track);
    if (!p) continue;
    if (p.kind !== 'extrap' && p.kind !== 'chain' && p.parts.ops.length === 1 && !pairOk({ a: p.parts.operands[0], b: p.parts.operands[1], op: p.parts.ops[0] })) continue;
    if (!run.claim(p.text)) continue;                                   // never served before
    test.push({ id: `m${test.length}`, ...p });
  }
  // sample of taught problems (asked as taught), to measure remembered vs fresh
  const seen = shuffled(run.rngFor('seen-sample'), train).slice(0, 60).map((f, i) => ({ id: `s${i}`, kind: 'seen', text: f.text, parts: { operands: [f.a, f.b], ops: [f.op] }, answer: f.result, track: 'seen', tags: [] }));

  // leakage guard: no exam problem may equal a taught fact
  const taught = new Set(train.map((f) => `${f.a}|${f.op}|${f.b}`));
  for (const p of test) if (p.parts.ops.length === 1 && taught.has(`${p.parts.operands[0]}|${p.parts.ops[0]}|${p.parts.operands[1]}`)) throw new Error(`leak: exam problem "${p.text}" is a taught fact`);
  return { T, train, seen, test };
}
