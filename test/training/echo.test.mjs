/**
 * Tests for the echo step (training/echo/): rule walks, the ladder's domains, the echo gate and the exam.
 * Node's built-in runner:  node --test "test/training/*.test.mjs"
 * Offline, no data download: everything here is generated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E = '../../training/echo/';
const { Walk, permutation } = await import(E + 'rules.mjs');
const { toMidi, renderPcm8, musicWalk } = await import(E + 'music.mjs');
const { DOMAINS, byId } = await import(E + 'domains.mjs');
const echo = await import(E + 'echo.mjs');
const { Rng } = await import('../../training/simulation/random.mjs');

const hex = (u8) => Buffer.from(u8).toString('hex');
const key = (t) => t.join(',');

// ---------- the engine ----------

test('count agrees with listing every tune, and unrank is the same list in order', () => {
  for (const [id, level] of [['music', 0], ['music', 1], ['art', 3], ['animal', 2], ['speech', 1], ['simulation', 1], ['chips', 1]]) {
    const d = byId(id);
    const len = d.levels[level];
    const all = [...d.walk.enumerate(len)];
    assert.equal(BigInt(all.length), d.walk.total(len), `${id} level ${level}`);
    if (all.length <= 500) all.forEach((t, i) => assert.deepEqual(d.walk.unrank(len, i), t));
    assert.equal(new Set(all.map(key)).size, all.length, 'no tune listed twice');
  }
});

test('the shuffled order is a fair permutation: every index once, same seed same order, other seed other order', () => {
  for (const n of [1n, 2n, 3n, 7n, 100n, 1000n, (1n << 20n) + 3n]) {
    const p = permutation(n, 5);
    const seen = new Set();
    const lim = n > 5000n ? 5000n : n;
    for (let i = 0n; i < n && i < lim; i++) {
      const v = p(i);
      assert.ok(v >= 0n && v < n);
      seen.add(v);
    }
    assert.equal(BigInt(seen.size), lim, `n=${n}: a repeated value inside the first ${lim}`);
  }
  const full = new Set();
  for (let i = 0n; i < 1000n; i++) full.add(permutation(1000n, 9)(i));
  assert.equal(full.size, 1000, 'covers every index exactly once');
  assert.notDeepEqual([0n, 1n, 2n, 3n, 4n, 5n].map(permutation(1000n, 1)), [0n, 1n, 2n, 3n, 4n, 5n].map(permutation(1000n, 2)));
});

test('shuffled visits every legal tune exactly once, in a different order from the listing', () => {
  for (const [id, level] of [['art', 4], ['animal', 3], ['speech', 1], ['music', 1]]) {
    const d = byId(id);
    const len = d.levels[level];
    const listed = [...d.walk.enumerate(len)].map(key);
    const shuf = [...d.walk.shuffled(len, 42)].map(key);
    assert.equal(shuf.length, listed.length);
    assert.deepEqual([...shuf].sort(), [...listed].sort(), `${id}: same set of tunes`);
    assert.notDeepEqual(shuf, listed, `${id}: not the listing order`);
    assert.deepEqual([...d.walk.shuffled(len, 42)].map(key), shuf, 'deterministic');
  }
});

test('rules must be deterministic: a symbol that leads two places is refused', () => {
  const w = new Walk({ init: 'a', next: () => [[1, 'a'], [1, 'b']], accept: () => true });
  assert.throws(() => w.count(2), /not deterministic/);
});

// ---------- music theory ----------

test('every music tune obeys the theory rules (checked by a separate re-implementation)', () => {
  const len = 6;
  let n = 0;
  for (const t of musicWalk.enumerate(len)) {
    n++;
    assert.ok([0, 2, 4].includes(t[0]), 'starts on a tonic-triad degree');
    assert.ok([0, 4].includes(t[len - 1] % 7), 'ends on tonic or dominant');
    t.forEach((d) => assert.ok(d >= 0 && d <= 10, 'inside the range'));
    const iv = t.slice(1).map((d, i) => d - t[i]);
    iv.forEach((x) => assert.ok(Math.abs(x) <= 4, 'no leap bigger than 4'));
    iv.forEach((x, i) => {
      if (Math.abs(x) >= 3) {
        assert.ok(i + 1 < iv.length, 'never ends hanging off a leap');
        const back = iv[i + 1];
        assert.ok(Math.abs(back) === 1 || Math.abs(back) === 2, 'a leap is followed by a step');
        assert.ok(Math.sign(back) === -Math.sign(x), '...back the other way');
      }
    });
    for (let i = 0; i + 3 < t.length; i++) assert.ok(!(t[i] === t[i + 1] && t[i] === t[i + 2] && t[i] === t[i + 3]), 'no 4 equal notes');
  }
  assert.equal(BigInt(n), musicWalk.total(len));
  assert.equal(musicWalk.total(6), 3895n);
});

test('modes and keys move the same tune; the audio has the right pitch', () => {
  assert.deepEqual(toMidi([0, 2, 4]), [60, 64, 67]);
  assert.deepEqual(toMidi([0, 2, 4], 60, 'minor'), [60, 63, 67]);
  assert.deepEqual(toMidi([0, 7], 62), [62, 74], 'degree 7 is the octave');
  assert.deepEqual(toMidi([0, 5], 60, 'pentatonic'), [60, 72]);
  assert.throws(() => toMidi([0], 60, 'nope'));
  const pcm = renderPcm8([69]); // A4 = 440 Hz, 250 ms at 4 kHz
  assert.equal(pcm.length, 1000);
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 128) !== (pcm[i] < 128)) crossings++;
  assert.ok(crossings >= 200 && crossings <= 240, `about 220 zero crossings for 440 Hz, got ${crossings}`);
  assert.ok(pcm[0] >= 120 && pcm[0] <= 136, 'starts near silence (no click)');
});

// ---------- every domain ----------

test('every level of every domain has legal tunes, and random ones obey the rules', () => {
  assert.equal(DOMAINS.length, 10);
  assert.deepEqual(DOMAINS.map((d) => d.id), ['music', 'art', 'animal', 'speech', 'text', 'chips', 'coding', 'simulation', 'research', 'neurolang']);
  assert.equal(new Set(DOMAINS.map((d) => d.tag)).size, 10, 'tags are unique');
  const rng = new Rng(3);
  for (const d of DOMAINS) {
    d.levels.forEach((len) => {
      assert.ok(d.walk.total(len) > 0n, `${d.id}: ${len}`);
      for (let k = 0; k < 8; k++) {
        const t = d.walk.random(len, rng);
        assert.ok(d.walk.isLegal(t, len), `${d.id} produced an illegal tune`);
        t.forEach((s) => assert.ok(d.alphabet.includes(s), `${d.id}: symbol ${s} not in the alphabet`));
      }
    });
  }
});

test('legalNext is exactly the set of symbols that can still be finished', () => {
  for (const [id, level] of [['art', 3], ['animal', 3], ['speech', 1], ['simulation', 0]]) {
    const d = byId(id);
    const len = d.levels[level];
    const all = [...d.walk.enumerate(len)];
    const prefixes = new Map();
    for (const t of all) for (let c = 0; c < len; c++) {
      const k = key(t.slice(0, c));
      if (!prefixes.has(k)) prefixes.set(k, new Set());
      prefixes.get(k).add(t[c]);
    }
    for (const [k, nexts] of prefixes) {
      const prefix = k === '' ? [] : k.split(',').map(Number);
      assert.deepEqual(d.walk.legalNext(prefix, len), [...nexts].sort((a, b) => a - b), `${id} after [${k}]`);
    }
  }
  assert.deepEqual(byId('music').walk.legalNext([0, 0, 0], 8).includes(0), false, 'a fourth equal note is illegal');
});

test('labels come from running the thing', () => {
  const bytes = (s) => [...s].map((c) => c.charCodeAt(0));
  const coding = byId('coding');
  assert.equal(Buffer.from(coding.label(bytes('12+'))).toString(), '3');
  assert.equal(Buffer.from(coding.label(bytes('34*'))).toString(), '12');
  assert.equal(Buffer.from(coding.label(bytes('12-'))).toString(), '-1');
  assert.equal(Buffer.from(coding.label(bytes('123*+'))).toString(), '7');
  const chips = byId('chips');
  assert.deepEqual([...chips.label([0, 0, 1])], [0, 0, 0, 1], 'AND');
  assert.deepEqual([...chips.label([2, 0, 1])], [0, 1, 1, 0], 'XOR');
  assert.deepEqual([...chips.label([3, 0, 1])], [1, 1, 1, 0], 'NAND');
  assert.deepEqual([...chips.label([0, 0, 1, 2, 1, 2])], [0, 1, 0, 0], 'XOR(b, AND(a,b)) is b AND NOT a');
  const sim = byId('simulation');
  const run = bytes('eehwwssg');
  assert.ok(sim.walk.isLegal(run, 8), 'harvest at the food, walk to the friend, give');
  assert.equal(Buffer.from(sim.label(run)).toString(), '0,2,0,1');
  assert.equal(sim.walk.isLegal(bytes('eeeeeeee'), 8), false);
  assert.equal(sim.walk.isLegal(bytes('gggggggg'), 8), false, 'cannot give with nothing in hand');
  assert.equal(sim.alphabet.includes('a'.charCodeAt(0)), false, 'no attack action exists');
  assert.deepEqual([...byId('music').label([0, 2, 4])], [60, 64, 67]);
});

test('research order: no answer without a search, no quote without a find', () => {
  const r = byId('research');
  const t = (s) => [...s].map((c) => c.charCodeAt(0));
  assert.ok(r.walk.isLegal(t('QSFqc'), 5));
  assert.ok(r.walk.isLegal(t('QSNu.'), 5));
  assert.equal(r.walk.isLegal(t('QFqc.'), 5), false, 'skipped the search');
  assert.equal(r.walk.isLegal(t('QSNqc'), 5), false, 'quoted although nothing was found');
});

test('the NeuroLang and text domains only produce well-formed lines', () => {
  const neuro = byId('neurolang');
  for (const t of neuro.walk.shuffled(neuro.levels[2], 1)) {
    const lines = Buffer.from(t).toString().replace(/\n+$/, '').split('\n');
    assert.equal(lines[0], 'kind="network"');
    assert.match(lines[1], /^neurons="[24]"$/);
    assert.match(lines[2], /^"n1"@input="[a-z ]+"$/);
    assert.match(lines[3], /^"n1"@response="[a-z ]+"$/);
    assert.equal(lines[4], 'train="responses"');
  }
  const text = byId('text');
  for (const t of text.walk.enumerate(text.levels[2])) {
    assert.match(Buffer.from(t).toString().replace(/\n+$/, ''), /^(the|a) (small |red )?(cat|dog|bird) (sat|ran|slept)\.$/, 'short sentences are padded with newlines to the level length');
  }
});

// ---------- samples, grading, the gate ----------

test('echo samples: header, then the exact payload; the target is the payload', () => {
  for (const d of DOMAINS) {
    const s = echo.makeSample(d, 'echo', 0, 11, 4);
    assert.deepEqual([...s.input.slice(0, 3)], [echo.TASKS.echo, d.tag, 0]);
    assert.deepEqual([...s.input.slice(3)], [...s.target]);
    assert.ok(echo.grade(d, s, s.target));
    assert.equal(echo.grade(d, s, s.target.slice(0, -1)), false, 'a truncated echo fails');
    const bad = Uint8Array.from(s.target);
    bad[0] ^= 1;
    assert.equal(echo.grade(d, s, bad), false, 'one wrong byte fails');
  }
  const m = byId('music');
  const raw = echo.makeSample(m, 'echo-raw', 1, 1, 0);
  assert.equal(raw.target.length, 6 * 1000, 'six notes of 250 ms at 4 kHz');
  assert.deepEqual([...raw.input.slice(3)], [...raw.target]);
  const dec = echo.makeSample(m, 'decode-raw', 1, 1, 0);
  assert.equal(dec.input.length, 3 + 6000);
  assert.ok(m.walk.isLegal([...dec.target], 6), 'audio decodes to a legal tune');
  const art = echo.makeSample(byId('art'), 'echo-raw', 0, 1, 0);
  assert.equal(art.target.length, 3 * 2 * 3, 'a mirrored strip, 3 bytes per pixel');
});

test('samples are reproducible from (domain, task, level, seed, index) alone', () => {
  const a = echo.makeSample(byId('chips'), 'next', 2, 7, 3);
  const b = echo.makeSample(byId('chips'), 'next', 2, 7, 3);
  assert.equal(hex(a.input), hex(b.input));
  assert.equal(hex(a.target), hex(b.target));
  const c = echo.makeSample(byId('chips'), 'next', 2, 8, 3);
  assert.notEqual(hex(a.input) + hex(a.target), hex(c.input) + hex(c.target));
  assert.equal(a.meta.version, echo.VERSION);
});

test('next, legal and finish are graded by the rules, not by one recording', () => {
  const d = byId('music');
  const len = d.levels[1];
  const s = echo.makeSample(d, 'next', 1, 5, 2);
  const legal = s.meta.legal;
  const illegal = d.alphabet.find((x) => !legal.includes(x));
  assert.ok(legal.every((x) => echo.grade(d, s, [x])), 'any rule-legal note passes');
  if (illegal !== undefined) assert.equal(echo.grade(d, s, [illegal]), false);
  assert.equal(echo.grade(d, s, []), false);
  assert.equal(echo.grade(d, s, [legal[0], legal[0]]), false, 'one note, not several');
  const l = echo.makeSample(d, 'legal', 1, 5, 2);
  assert.ok(echo.grade(d, l, l.target));
  assert.equal(echo.grade(d, l, l.target.slice(1)), false, 'must list every legal note');
  const f = echo.makeSample(d, 'finish', 1, 5, 2);
  assert.ok(echo.grade(d, f, f.target));
  const alt = [...d.walk.enumerate(len)].find((t) => key(t.slice(0, 3)) === key(f.meta.prefix) && key(t.slice(3)) !== key([...f.target]));
  assert.ok(alt, 'this prefix has more than one legal ending');
  assert.ok(echo.grade(d, f, alt.slice(3)), 'a different legal ending passes too');
  assert.equal(echo.grade(d, f, [0, 0, 0]), false, 'breaks the rules');
  assert.equal(echo.grade(d, f, f.target.slice(1)), false, 'wrong length');
});

/** A lookup model that knows every answer (tests the harness, not intelligence). */
function lookup(domains, seed, n, { breakEcho = false } = {}) {
  const table = new Map();
  for (const d of domains) for (let lv = 0; lv < d.levels.length; lv++) for (const task of echo.tasksFor(d)) for (let i = 0; i < n; i++) {
    const s = echo.makeSample(d, task, lv, seed, i);
    const ans = breakEcho && (task === 'echo' || task === 'echo-raw') ? Uint8Array.from(s.target, (v) => v ^ 1) : s.target;
    table.set(hex(s.input), ans);
  }
  return async (input) => table.get(hex(input)) ?? new Uint8Array(0);
}

test('the ladder passes a model that echoes and follows every rule', async () => {
  const doms = [byId('animal'), byId('art'), byId('research')];
  const r = await echo.runLadder(lookup(doms, 1, 8), { domains: doms, seed: 1, n: 8 });
  assert.equal(r.blockedAt, null);
  assert.ok(r.report.every((x) => x.status === 'passed'));
  assert.ok(r.report.every((x) => x.scores.echo === 1));
});

test('the gate: a model that cannot repeat exactly is blocked, even if it gets everything else right', async () => {
  const doms = [byId('animal'), byId('art')];
  const r = await echo.runLadder(lookup(doms, 1, 8, { breakEcho: true }), { domains: doms, seed: 1, n: 8 });
  assert.equal(r.blockedAt.domain, 'animal');
  assert.equal(r.blockedAt.level, 0);
  assert.match(r.blockedAt.status, /^blocked/);
  assert.equal(r.report.length, 1, 'it never got to the later stages');
});

test('a model that only repeats is stopped at the rules, not at the echo', async () => {
  const doms = [byId('animal')];
  const echoOnly = async (input) => (input[0] === echo.TASKS.echo ? input.slice(3) : new Uint8Array([255]));
  const r = await echo.runLadder(echoOnly, { domains: doms, seed: 1, n: 8 });
  assert.match(r.blockedAt.status, /^not yet/);
  assert.equal(r.report[0].scores.echo, 1);
  assert.equal(r.report[0].scores.next, 0);
});

test('a rule-blind guesser scores about its baseline on next', async () => {
  const d = byId('music');
  const rng = new Rng(1);
  const blind = async () => Uint8Array.of(rng.int(d.alphabet.length));
  const r = await echo.examStage(blind, d, 1, { seed: 2, n: 400 });
  assert.ok(Math.abs(r.scores.next - r.blind.next) < 0.1, `${r.scores.next} vs baseline ${r.blind.next}`);
  assert.ok(r.blind.next < 0.9);
  assert.ok(r.scores.echo < 0.01);
});

test('stages start with the echo, and mixed batches keep revisiting earlier stages', () => {
  const first = [...echo.stageStream(byId('music'), 0, { per: 3 })];
  assert.deepEqual(first.slice(0, 3).map((s) => s.task), ['echo', 'echo', 'echo']);
  assert.equal(first.length, 3 * echo.tasksFor(byId('music')).length);
  const done = [{ domain: 'music', level: 4 }, { domain: 'art', level: 2, weight: 3 }];
  const batch = echo.mixBatch({ current: { domain: 'animal', level: 1 }, done, seed: 5, size: 400 });
  assert.equal(batch.length, 400);
  const cur = batch.filter((s) => s.meta.domain === 'animal').length / 400;
  assert.ok(cur > 0.55 && cur < 0.75, `about 65% current, got ${cur}`);
  const art = batch.filter((s) => s.meta.domain === 'art').length;
  const mus = batch.filter((s) => s.meta.domain === 'music').length;
  assert.ok(art > mus, 'the stage with the bigger weight appears more');
  assert.deepEqual(batch.map((s) => hex(s.input)), echo.mixBatch({ current: { domain: 'animal', level: 1 }, done, seed: 5, size: 400 }).map((s) => hex(s.input)));
});

test('no third-party code and no tokenizer in training/echo/ (imports are node: built-ins or our own files)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'training', 'echo');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../') || m[1].startsWith('node:'), `${f} imports ${m[1]}`);
    }
    assert.ok(!/tokeniz/i.test(src.replace(/no tokenizer|never words or tokens/gi, '')), `${f} mentions a tokenizer`);
  }
});
