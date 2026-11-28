/**
 * Tests for the repair agent (training/repair/). Node's built-in runner:
 *   node --test "test/training/*.test.mjs"
 * Offline and generated: no data download, no model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RepairAgent, candidateEdits, grade } from '../../training/repair/agent.mjs'
import { SEALED as SET1 } from '../../training/repair/sealed-families.mjs'
import { SEALED as SET2 } from '../../training/repair/sealed-families-2.mjs'
import { runCall } from '../../scripts/drill-generators/repair.mjs'

const checksFor = (fam) => fam.tests.map((args) => ({ fn: fam.name, args, expected: runCall(fam.correct, fam.name, args).text }))

test('every sealed family is sound: the correct version passes and each defect fails a check', () => {
  for (const fam of [...SET1, ...SET2]) {
    const checks = checksFor(fam)
    assert.equal(grade(fam.correct, fam.name, checks).first, null, `${fam.name}: correct version fails`)
    for (const [bug, src] of Object.entries(fam.bugs)) assert.ok(grade(src, fam.name, checks).first, `${fam.name}/${bug} fails nothing`)
  }
})

test('code that already passes is left exactly as it is', () => {
  const agent = new RepairAgent()
  for (const fam of [...SET1, ...SET2]) {
    const res = agent.repair({ attempt: fam.correct, fn: fam.name, checks: checksFor(fam), params: fam.params })
    assert.equal(res.changed, false, fam.name)
    assert.equal(res.src, fam.correct)
  }
})

test('a returned fix always really passes every check (verified by running, never assumed)', () => {
  const agent = new RepairAgent()
  let fixed = 0
  for (const fam of SET1) for (const src of Object.values(fam.bugs)) {
    const checks = checksFor(fam)
    const res = agent.repair({ attempt: src, fn: fam.name, checks, params: fam.params })
    if (res.ok) { fixed++; assert.equal(grade(res.src, fam.name, checks).first, null) } else assert.equal(res.src, src, 'a failed repair must return the original, not a guess')
  }
  assert.ok(fixed >= 10, `expected most of set 1 to be repaired, got ${fixed}`)
})

test('training stores only edit kinds, never task text, so it cannot memorise answers', () => {
  const agent = new RepairAgent()
  const fam = SET1[0]
  const out = agent.train([{ attempt: fam.bugs.bound, fn: fam.name, checks: checksFor(fam), params: fam.params }])
  assert.ok(Object.keys(out.prior).every((k) => /^[a-z]+$/.test(k)), 'prior keys are edit kinds')
  assert.ok(!JSON.stringify(agent.prior).includes('sumTo'))
})

test('edits are generic: they come from the code in front of it, not a per-family table', () => {
  const kinds = new Set(candidateEdits('function f(x) {\n  return x < 3 && x > 0\n}', ['x']).map((e) => e.kind))
  for (const k of ['relop', 'const', 'logic']) assert.ok(kinds.has(k), k)
})
