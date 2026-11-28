/**
 * Tests for the rule-based composer (training/knowledge/compose.mjs): music theory decides what is allowed,
 * a seeded random generator decides what is chosen.  node --test test/training/compose.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, analyze, rng, toMidi, readMidi, toWav, SCALES, degreeToMidi, triadDegrees, TRANSITIONS } from '../../training/knowledge/compose.mjs';
import { readWav, features } from '../../training/knowledge/audio.mjs';

test('same seed gives the identical piece and identical MIDI bytes; different seeds differ', () => {
  const a = compose({ seed: 5 }), b = compose({ seed: 5 }), c = compose({ seed: 6 });
  assert.deepEqual(a, b); assert.ok(toMidi(a).equals(toMidi(b))); assert.ok(!toMidi(a).equals(toMidi(c)));
});
test('the randomizer is uniform enough and reproducible', () => {
  const r = rng(1), r2 = rng(1); const xs = Array.from({ length: 4000 }, () => r.next());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => r2.next()));
  assert.ok(xs.every((x) => x >= 0 && x < 1)); const mean = xs.reduce((s, v) => s + v, 0) / xs.length; assert.ok(Math.abs(mean - 0.5) < 0.03);
});
test('theory helpers: major triad on I is root-major third-fifth; minor triad on i is minor', () => {
  const tri = (scale, deg) => triadDegrees(deg).map((d) => degreeToMidi(60, scale, d) - 60);
  assert.deepEqual(tri(SCALES.major, 0), [0, 4, 7]); assert.deepEqual(tri(SCALES.major, 1), [2, 5, 9]); assert.deepEqual(tri(SCALES.minor, 0), [0, 3, 7]);
  assert.deepEqual(tri(SCALES.harmonicMinor, 4), [7, 11, 14]);   // V in minor is major (leading tone), vii is diminished
  assert.deepEqual(tri(SCALES.major, 6), [11, 14, 17]);
});
test('harmony: every transition in the table points at a real degree and weights are positive', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) for (const [to, w] of tos) { assert.ok(to >= 0 && to <= 6 && w > 0); assert.notEqual(Number(from), 99); }
  assert.deepEqual(TRANSITIONS[6], [[0, 10]]);   // the leading-tone chord resolves to tonic
});
test('every generated piece obeys its own theory rules (3 lengths x 400 seeds)', () => {
  for (let seed = 1; seed <= 400; seed++) for (const bars of [4, 8, 16]) {
    const p = compose({ seed, bars }); const a = analyze(p);
    assert.equal(a.ok, true, `seed ${seed} bars ${bars}: ${JSON.stringify(a)}`);
    assert.equal(p.progression[0], 'I'); assert.deepEqual(p.progression.slice(-2), ['V', 'I']);   // authentic cadence
    assert.equal(a.inKey, 1); assert.equal(a.unresolvedLeaps, 0); assert.equal(a.endsOnTonic, true);
  }
});
test('the analyzer actually catches rule violations (it is not a rubber stamp)', () => {
  const p = compose({ seed: 3 });
  const off = structuredClone(p); off.melody[2].pitch += 1; assert.ok(analyze(off).inKey < 1 || analyze(off).ok === false);
  const noCad = structuredClone(p); noCad.chords.at(-2).degree = 3; assert.equal(analyze(noCad).cadenceVI, false);
  const wrongEnd = structuredClone(p); wrongEnd.melody.at(-1).pitch += 1; assert.equal(analyze(wrongEnd).endsOnTonic, false);
  const leap = structuredClone(p); leap.melody[5].pitch += 12; leap.melody[6].pitch += 12; leap.melody[7].pitch += 0; assert.equal(analyze(leap).ok, false);
});
test('the randomizer really varies the music: many seeds give many distinct melodies, keys, modes and progressions', () => {
  const ps = Array.from({ length: 200 }, (_, i) => compose({ seed: i + 1 }));
  assert.ok(new Set(ps.map((p) => p.melody.map((n) => n.pitch).join(','))).size > 190);
  assert.ok(new Set(ps.map((p) => p.mode)).size >= 4); assert.ok(new Set(ps.map((p) => p.tonic % 12)).size >= 10); assert.ok(new Set(ps.map((p) => p.progression.join())).size > 30);
});
test('options are honoured: mode, bar count, tempo', () => {
  const p = compose({ seed: 9, mode: 'minor', bars: 12, bpm: 100 }); assert.equal(p.mode, 'minor'); assert.equal(p.tempo, 100); assert.equal(p.bars, 12); assert.equal(p.chords.length, 12);
  assert.throws(() => compose({ bars: 2 }), /at least 4/);
});
test('MIDI output is a valid format-1 file whose notes match the piece', () => {
  const p = compose({ seed: 11 }); const m = readMidi(toMidi(p));
  assert.equal(m.format, 1); assert.equal(m.ticksPerQuarter, 480); assert.equal(m.tracks.length, 4);
  assert.deepEqual(m.tracks[1].map((n) => n.pitch), p.melody.map((n) => n.pitch));
  assert.equal(m.tracks[2].length, p.chords.length * 3); assert.equal(m.tracks[3].length, p.bass.length);
  assert.ok(m.tracks[1].every((n, i) => n.tick === Math.round(p.melody[i].start * 480)));
});
test('WAV rendering is audible, normalised and has the expected length', () => {
  const p = compose({ seed: 12, bars: 4, bpm: 120 }); const w = readWav(toWav(p, 16000));
  assert.equal(w.sr, 16000); assert.ok(w.samples.length >= 16000 * 8 && w.samples.length < 16000 * 11);
  let peak = 0; for (const v of w.samples) peak = Math.max(peak, Math.abs(v)); assert.ok(peak > 0.6 && peak <= 0.81);
  const f = features(w.samples, w.sr); assert.ok(f.every(Number.isFinite));
});

test('music.composer is a separate registered component; its synthetic data is never in the real collections', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const reg = JSON.parse(fs.readFileSync('training/knowledge/registry.json', 'utf8')).components['music.composer'];
  assert.ok(reg && reg.current); const v = reg.versions.find((x) => x.version === reg.current);
  assert.deepEqual(v.inputs, []); assert.equal(v.restrictions.nonCommercial, false); assert.ok(v.metrics['music.first_try_pass_rate'] >= 0.9);
  const root = 'training_data/knowledge/processed/collections';
  if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) for (const l of fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(Boolean)) assert.ok(!JSON.parse(l).synthetic);
});

test('training on composer output teaches key and mode recognition (unseen seeds, far above chance and above theory-only)', async () => {
  const M = await import('../../training/knowledge/musicmodel.mjs');
  const tr = Array.from({ length: 80 }, (_, i) => M.example(i + 1, 8000, 4)), te = Array.from({ length: 40 }, (_, i) => M.example(5000 + i, 8000, 4));
  const model = M.trainKeyModel(tr); const r = M.evaluateKeyModel(model, te), base = M.evaluateKeyModel(M.theoryModel(), te);
  assert.ok(r.accuracy > 0.5, JSON.stringify(r)); assert.ok(r.accuracy > base.accuracy + 0.2);        // chance for 48 key/mode pairs is 2%
  const ch = M.chroma(Float32Array.from({ length: 8000 * 2 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 8000)), 8000);   // a pure A: all energy on pitch class 9
  assert.equal(ch.indexOf(Math.max(...ch)), 9);
});
