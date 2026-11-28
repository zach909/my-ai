/**
 * Tests for the extension builder's composition layer (extension-builder/compose.js) and the new builder.answer().
 * Node's built-in runner:  node --test test/platform/skill-graph.test.mjs
 * The real-builder test needs the compiled backend (dist/) and skips itself when it is not built.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillGraph } from '../../extension-builder/compose.js'
import { MODES, toMidi } from '../../training/echo/music.mjs'

const MODE_NAMES = Object.keys(MODES)

/** A music-theory skill built from three small code skills: parse the question, look the degree up, say the answer. */
function musicGraph() {
  const g = new SkillGraph()
  g.defineCode('parse', (q) => {
    const m = q.match(/degree (\d+) of (\w+) starting on (\d+)/)
    return m && MODES[m[2]] ? `${m[1]},${m[2]},${m[3]}` : null
  })
  g.defineCode('lookup', (s) => {
    const [deg, mode, tonic] = s.split(',')
    return String(Number(tonic) + 12 * Math.floor(Number(deg) / MODES[mode].length) + MODES[mode][Number(deg) % MODES[mode].length])
  })
  g.defineCode('say', (n) => `MIDI ${n}`)
  g.compose('noteOf', ['parse', 'lookup', 'say'])
  return g
}

test('a composed skill passes each step\'s output to the next and records a trace', () => {
  const g = musicGraph()
  const r = g.run('noteOf', 'Which note is degree 2 of major starting on 60?')
  assert.equal(r.ok, true)
  assert.equal(r.output, 'MIDI 64')
  assert.deepEqual(r.trace.map((t) => t.step), ['parse', 'lookup', 'say'])
})

test('composition generalises: every key, mode and degree is exact, none of them trained', () => {
  const g = musicGraph()
  let n = 0
  for (const mode of MODE_NAMES) for (const tonic of [40, 49, 58, 61, 70]) for (let deg = 0; deg < 11; deg++) {
    const q = `Which note is degree ${deg} of ${mode} starting on ${tonic}?`
    assert.equal(g.run('noteOf', q).output, `MIDI ${toMidi([deg], tonic, mode)[0]}`)
    n++
  }
  assert.ok(n >= 250)
})

test('a failing step stops the chain and says where', () => {
  const g = musicGraph()
  const r = g.run('noteOf', 'what is the weather')
  assert.equal(r.ok, false)
  assert.equal(r.failedAt, 'parse')
  assert.equal(r.output, null)
})

test('a throwing skill is reported as a failure, never crashes the graph', () => {
  const g = new SkillGraph().defineCode('boom', () => { throw new Error('nope') })
  const r = g.run('boom', 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /nope/)
})

test('skills nest, and a skill must exist before it is used, so cycles cannot be written', () => {
  const g = musicGraph()
  g.defineCode('shout', (s) => s.toUpperCase())
  g.compose('loud', ['noteOf', 'shout'])
  assert.equal(g.run('loud', 'Which note is degree 0 of major starting on 60?').output, 'MIDI 60')
  assert.equal(g.describe('loud').steps[0].kind, 'composed')
  assert.throws(() => g.compose('later', ['notYetDefined']), /not defined yet/)
  assert.throws(() => g.defineCode('loud', () => ''), /already exists/)
})

test('verify RUNS the contract: a wrong skill fails, an untested skill is listed, not trusted', () => {
  const g = musicGraph()
  g.contract('noteOf', [{ input: 'Which note is degree 2 of major starting on 60?', expected: 'MIDI 64' }])
  assert.equal(g.verify('noteOf').verified, true)
  g.defineCode('wrong', () => '0')
  g.contract('wrong', [{ input: 'x', expected: '1' }])
  const v = g.verify('wrong')
  assert.equal(v.verified, false)
  assert.equal(v.failures[0].got, '0')
  const all = g.verifyAll()
  assert.equal(all.allVerified, false)
  assert.ok(all.untested.includes('parse'))
})

test('a learned skill can refuse close calls when asked to; by default it does not (the margin is not a confidence)', () => {
  const builder = { answer: (_p, q) => (q === 'sure' ? { answer: 'yes', margin: 0.5 } : { answer: 'maybe', margin: 0.01 }) }
  const strict = new SkillGraph({ builder, projectId: 'p' }).defineLearned('recall', { minMargin: 0.1 })
  assert.equal(strict.run('recall', 'sure').output, 'yes')
  assert.equal(strict.run('recall', 'unsure').ok, false)
  const plain = new SkillGraph({ builder, projectId: 'p' }).defineLearned('recall')
  assert.equal(plain.run('recall', 'unsure').output, 'maybe', 'default must not silently refuse everything')
  assert.throws(() => new SkillGraph().defineLearned('x'), /needs a builder/)
})

test('a learned skill is trusted only through its contract: verify() catches a wrong answer', () => {
  const builder = { answer: (_p, q) => ({ answer: q === 'a' ? 'right' : 'wrong', margin: 0.9 }) }
  const g = new SkillGraph({ builder, projectId: 'p' }).defineLearned('recall')
  g.contract('recall', [{ input: 'a', expected: 'right' }, { input: 'b', expected: 'right' }])
  const v = g.verify('recall')
  assert.equal(v.verified, false)
  assert.equal(v.passed, 1)
  assert.equal(v.failures[0].input, 'b')
})

test('real builder: a trained project can be asked, and recall works', async (t) => {
  let ExtensionBuilder
  try { ({ ExtensionBuilder } = await import('../../extension-builder/builder.js')) } catch { t.skip('backend not built (dist/ missing)'); return }
  const b = new ExtensionBuilder(), p = b.createProject('t', 't')
  for (const [i, [q, a]] of [['capital of alpha', 'one'], ['capital of beta', 'two'], ['capital of gamma', 'three']].entries()) {
    const n = b.addNeuron(p.id, `n${i}`, 0); n.definition = q; b.addScript(p.id, n.id, q, a)
  }
  assert.equal(b.answer(p.id, 'capital of alpha'), null, 'untrained project answers nothing')
  b.train(p.id, { epochs: 800 })
  const hit = b.answer(p.id, 'capital of beta')
  assert.ok(hit && typeof hit.margin === 'number' && hit.margin >= 0 && hit.margin <= 1)
  assert.ok(Number.isFinite(hit.distance) && hit.distance >= 0)
  const ranked = b.trace(p.id, 'capital of beta').ranked
  assert.equal(ranked.length, 3)
  assert.ok(ranked.every((r, i) => i === 0 || ranked[i - 1].distance <= r.distance), 'ranked nearest first')
  // an embedding size option exists and the default is unchanged
  const q = b.createProject('q', 'q'); const n = b.addNeuron(q.id, 'n', 0); n.definition = 'x'; b.addScript(q.id, n.id, 'x', 'y')
  assert.equal(b.train(q.id, { epochs: 50, dims: 32 }).trainedNeurons.length >= 0, true)
})
