/**
 * The echo step: before a stage's real work, the model has to REPEAT what it is shown, exactly.
 * Written for this project from scratch (Node built-ins and our own modules only). No tokenizer: every sample is
 * raw bytes, and the network under test is just a function from bytes to bytes (in practice the Zip Loop).
 *
 * For each domain (domains.mjs) and level, in this order:
 *   1. echo        repeat the tune back, byte for byte.        <- the gate: nothing below counts until this is exact
 *   2. echo-raw    repeat the raw form back (the audio, the pixels), for domains that have one
 *   3. decode-raw  raw form -> the tune ("audio to notes", "picture to colours")
 *   4. next        given the start of a tune, what comes next? The answer only has to be RULE-LEGAL, because many
 *                  notes are legal; the rules, not one recording, are the answer key
 *   5. legal       given the start, list every symbol the rules allow (and can still finish), as a sorted byte list
 *   6. finish      given the first half, write the rest; graded by whether the whole thing obeys every rule
 *   7. label       tune -> the exact truth about it, got by running it (MIDI notes, truth table, result, final state)
 *
 * A sample is (generator version, domain, level, seed, index): store those, regenerate the bytes on demand.
 * Never commit the generated set. Train and exam on different seeds.
 */
import { Rng, hash32 } from '../simulation/random.mjs';
import { DOMAINS, byId } from './domains.mjs';

export const VERSION = 1;
export const TASKS = { echo: 1, 'echo-raw': 2, 'decode-raw': 3, next: 4, legal: 5, finish: 6, label: 7 };

/** Task names a domain supports, in teaching order (echo first). */
export function tasksFor(domain) {
  return ['echo', ...(domain.raw ? ['echo-raw', 'decode-raw'] : []), 'next', 'legal', 'finish', ...(domain.label ? ['label'] : [])];
}

const isEcho = (task) => task === 'echo' || task === 'echo-raw';
const bytes = (a) => Uint8Array.from(a);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Build one sample. `input` is what the network is shown: [task, domain tag, level] then the payload, all bytes.
 * `target` is a reference answer; `grade` is the real judge (several answers can be right).
 */
export function makeSample(domain, task, level, seed, index) {
  if (!(task in TASKS)) throw new Error(`unknown task ${task}`);
  const len = domain.levels[level];
  if (len === undefined) throw new Error(`${domain.id} has no level ${level}`);
  const rng = new Rng(hash32(seed | 0, index | 0, domain.tag * 16 + TASKS[task], level));
  const tune = domain.walk.random(len, rng);
  const head = [TASKS[task], domain.tag, level];
  const meta = { generator: 'echo', version: VERSION, domain: domain.id, task, level, seed, index };
  let payload = tune;
  let target = tune;
  switch (task) {
    case 'echo':
      break;
    case 'echo-raw':
      payload = target = domain.raw(tune);
      break;
    case 'decode-raw':
      payload = domain.raw(tune);
      break;
    case 'label':
      target = domain.label(tune);
      break;
    case 'next':
    case 'legal': {
      const cut = rng.int(len);
      const prefix = tune.slice(0, cut);
      meta.prefix = prefix;
      meta.legal = domain.walk.legalNext(prefix, len);
      payload = prefix;
      target = task === 'next' ? [tune[cut]] : meta.legal;
      break;
    }
    case 'finish': {
      const cut = Math.ceil(len / 2);
      meta.prefix = tune.slice(0, cut);
      payload = meta.prefix;
      target = tune.slice(cut);
      break;
    }
  }
  return { task, input: bytes([...head, ...payload]), target: bytes(target), meta };
}

/** Did `answer` (bytes) solve `sample`? Echo and the label are exact; next and finish only have to obey the rules. */
export function grade(domain, sample, answer) {
  const a = Array.from(answer ?? []);
  const { task, meta } = sample;
  const len = domain.levels[meta.level];
  switch (task) {
    case 'next':
      return a.length === 1 && meta.legal.includes(a[0]);
    case 'finish':
      return domain.walk.isLegal([...meta.prefix, ...a], len);
    default:
      return same(a, sample.target);
  }
}

/** Score a model on one stage. `model(inputBytes)` may be async. Returns the fraction right per task. */
export async function examStage(model, domain, level, { seed = 1, n = 32 } = {}) {
  const scores = {};
  let guess = 0;
  for (const task of tasksFor(domain)) {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const s = makeSample(domain, task, level, seed, i);
      if (task === 'next') guess += s.meta.legal.length / domain.alphabet.length;
      if (grade(domain, s, await model(s.input))) ok++;
    }
    scores[task] = ok / n;
  }
  // What a rule-blind guesser would score on `next`: the share of the alphabet that happens to be legal.
  return { domain: domain.id, level, scores, blind: { next: guess / n } };
}

/**
 * Walk the ladder. A stage is passed when the echo tasks are exact AND every other task reaches `pass` (and `next`
 * beats the blind guesser). Stops at the first stage that is not passed and says why.
 */
export async function runLadder(model, { domains = DOMAINS, seed = 1, n = 32, pass = 0.9, echoPass = 1 } = {}) {
  const report = [];
  for (const d of domains) {
    for (let level = 0; level < d.levels.length; level++) {
      const r = await examStage(model, d, level, { seed, n });
      const echoOk = Object.entries(r.scores).every(([t, v]) => !isEcho(t) || v >= echoPass);
      const restOk = Object.entries(r.scores).every(([t, v]) => isEcho(t) || v >= pass) && r.scores.next > r.blind.next;
      const status = !echoOk ? 'blocked: cannot repeat it exactly yet' : restOk ? 'passed' : 'not yet: repeats it, but does not follow the rules';
      report.push({ ...r, status });
      if (status !== 'passed') return { blockedAt: { domain: d.id, level, status }, report };
    }
  }
  return { blockedAt: null, report };
}

/** Samples for one stage in teaching order: all the echo samples first, then the rest, `per` of each task. */
export function* stageStream(domain, level, { seed = 1, per = 100 } = {}) {
  for (const task of tasksFor(domain)) for (let i = 0; i < per; i++) yield makeSample(domain, task, level, seed, i);
}

/**
 * One mixed batch (the curriculum's "mixing and forgetting" rule): about `currentShare` from the stage being
 * learned, the rest from earlier stages, weighted by `weight` (give a higher weight to stages whose exam slipped).
 * `done` is [{ domain, level, weight? }]. Every earlier sample still starts with its echo-or-task header.
 */
export function mixBatch({ current, done = [], seed = 1, size = 64, currentShare = 0.65 }) {
  const rng = new Rng(hash32(seed | 0, size, 0x6d1c));
  const total = done.reduce((a, d) => a + (d.weight ?? 1), 0);
  const out = [];
  for (let i = 0; i < size; i++) {
    let pick = current;
    if (done.length && !rng.chance(currentShare)) {
      let r = rng.next() * total;
      pick = done.find((d) => (r -= d.weight ?? 1) < 0) ?? done[done.length - 1];
    }
    const d = typeof pick.domain === 'string' ? byId(pick.domain) : pick.domain;
    const task = rng.pick(tasksFor(d));
    out.push(makeSample(d, task, pick.level, seed, i));
  }
  return out;
}
