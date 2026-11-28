#!/usr/bin/env node
/**
 * Score the repair agent on families it was never trained on and was never tuned against (sealed-families.mjs).
 *   node training/repair/sealed.mjs --train train.jsonl
 * Training uses only the generator's families. Every sealed family is therefore unseen. A family is dropped from
 * the score (and reported) if it is unsound: correct version fails its own checks, or a defect fails no check.
 */
import { readFileSync } from 'node:fs'
import { RepairAgent, parseTrace, grade } from './agent.mjs'
import { runCall } from '../../scripts/drill-generators/repair.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
if (!args.train) { console.error('usage: --train <jsonl> [--families sealed-families-2.mjs]'); process.exit(1) }
const { SEALED } = await import(new URL(args.families ?? './sealed-families.mjs', import.meta.url).href)
const trainRows = readFileSync(args.train, 'utf8').trim().split('\n').map((l) => parseTrace(JSON.parse(l)))
const agent = new RepairAgent()
agent.train(trainRows)

let n = 0, fixed = 0, cleanN = 0, cleanKept = 0
const rows = []
for (const fam of SEALED) {
  const expected = fam.tests.map((a) => runCall(fam.correct, fam.name, a).text)
  const checks = fam.tests.map((args, i) => ({ fn: fam.name, args, expected: expected[i] }))
  if (grade(fam.correct, fam.name, checks).first) { console.log(`DROPPED ${fam.name}: correct version fails its own checks`); continue }
  // clean: the correct source must be left exactly as it is
  const clean = agent.repair({ attempt: fam.correct, fn: fam.name, checks, params: fam.params })
  cleanN++; if (!clean.changed) cleanKept++
  for (const [bug, src] of Object.entries(fam.bugs)) {
    if (!grade(src, fam.name, checks).first) { console.log(`DROPPED ${fam.name}/${bug}: defect fails no check`); continue }
    const res = agent.repair({ attempt: src, fn: fam.name, checks, params: fam.params })
    const ok = !grade(res.src, fam.name, checks).first
    n++; if (ok) fixed++
    rows.push({ family: fam.name, bug, ok, steps: res.steps.map((s) => s.kind ?? s.note).join(' > ') })
  }
}
for (const r of rows) console.log(`${r.ok ? 'FIXED ' : 'missed'}  ${r.family}/${r.bug}  ${r.steps}`)
console.log(`\nsealed families (never trained on, never tuned on): fixed ${fixed}/${n}`)
console.log(`already-correct code left alone: ${cleanKept}/${cleanN}`)
