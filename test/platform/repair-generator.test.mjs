/**
 * The repair generator is only worth training on if its traces are TRUE. This test does not trust the
 * generator: it re-parses each trace's text, re-runs every attempt against the checks in the text, and
 * confirms that every FAIL line is a real failure, every PASS is a real pass, and the last attempt passes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateRepairTrace, generateRepairBatch, makeRand, runCall } from '../../scripts/drill-generators/repair.mjs'

function parse(text) {
  const checks = [...text.matchAll(/^(\w+)\((.*)\) == (.*)$/gm)].map((m) => ({ fn: m[1], args: JSON.parse(`[${m[2]}]`), expected: m[3] }))
  const attempts = [...text.matchAll(/ATTEMPT (\d+)\n([\s\S]*?)\nRUN\n([^\n]*)\n/g)].map((m) => ({ n: Number(m[1]), src: m[2], first: m[3] }))
  return { checks, attempts }
}
const grade = (src, checks) => {
  const res = checks.map((c) => { const r = runCall(src, c.fn, c.args); return { ...c, got: r.text, ok: r.ok && r.text === c.expected } })
  return { passed: res.filter((r) => r.ok).length, firstBad: res.find((r) => !r.ok) }
}

test('500 traces: every FAIL/PASS claim is reproduced by re-running the text', () => {
  const seen = { clean: 0, fix1: 0, fix2: 0, decoy: 0 }
  for (let i = 0; i < 500; i++) {
    const t = generateRepairTrace(makeRand(1000 + i))
    seen[t.meta.mode]++
    const { checks, attempts } = parse(t.text)
    assert.equal(attempts.length, t.meta.attempts)
    attempts.forEach((a, idx) => {
      const g = grade(a.src, checks)
      const last = idx === attempts.length - 1
      if (last) { assert.equal(g.passed, checks.length, `last attempt must pass (trace ${i})`); assert.match(a.first, /^PASS/) }
      else {
        assert.ok(g.firstBad, `non-final attempt must really fail (trace ${i})`)
        const shown = g.firstBad.args.map((v) => (typeof v === 'number' ? String(v) : JSON.stringify(v))).join(', ')
        assert.equal(a.first, `FAIL ${g.firstBad.fn}(${shown}): expected ${g.firstBad.expected}, got ${g.firstBad.got}`, `failure text must be the real one (trace ${i})`)
      }
    })
    if (t.meta.mode === 'clean') { assert.equal(attempts.length, 1); assert.ok(!t.text.includes('\nFIX\n')) }
    else assert.ok(attempts.length >= 2)
    if (t.meta.mode === 'decoy') assert.ok(attempts.length >= 3, 'a decoy needs at least two failures before the pass')
  }
  for (const m of Object.keys(seen)) assert.ok(seen[m] > 20, `mode ${m} should appear (got ${seen[m]})`)
})

test('deterministic from the seed, different across seeds', () => {
  assert.equal(generateRepairTrace(makeRand(5)).text, generateRepairTrace(makeRand(5)).text)
  const texts = new Set(Array.from({ length: 40 }, (_, i) => generateRepairTrace(makeRand(i + 1)).text))
  assert.ok(texts.size > 25)
})

test('drill batch: the answer passes the checks in the problem, or the first attempt was already right', () => {
  for (const { problem, answer } of generateRepairBatch(60, makeRand(9))) {
    const { checks } = parse(problem)
    if (answer === 'NO CHANGE') assert.equal(grade(parse(problem + '\nRUN\n').attempts[0]?.src ?? '', checks).passed, checks.length)
    else assert.equal(grade(answer, checks).passed, checks.length)
  }
})

test('the sandbox reports a runaway loop as a failure instead of hanging', () => {
  const r = runCall('function f() { while (true) {} }', 'f', [])
  assert.equal(r.ok, false)
  assert.match(r.text, /timed out/i)
})
