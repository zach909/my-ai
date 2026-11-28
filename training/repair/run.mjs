#!/usr/bin/env node
/**
 * Train and score the repair agent.
 *   node training/repair/run.mjs --train train.jsonl --held held.jsonl [--leave-out clamp,average,...]
 * Data comes from scripts/make-repair-data.mjs. A family named in --leave-out is removed from training, so its
 * rows measure whether the agent THINKS (generalises) rather than remembers. Exact-match is also reported:
 * the agent never copies training text, so exact matches only happen when the fix is the one correct program.
 */
import { readFileSync } from 'node:fs'
import { RepairAgent, parseTrace, grade } from './agent.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
if (!args.train || !args.held) { console.error('usage: --train <jsonl> --held <jsonl> [--leave-out fam1,fam2]'); process.exit(1) }
const load = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => parseTrace(JSON.parse(l)))
const OUT = new Set((args['leave-out'] ?? '').split(',').filter(Boolean))
const trainRows = load(args.train).filter((t) => !OUT.has(t.family))
const held = load(args.held)

const agent = new RepairAgent()
const t0 = Date.now()
const learned = agent.train(trainRows)
console.log(`trained on ${learned.traces} traces from families [${[...new Set(trainRows.map((t) => t.family))]}] in ${Date.now() - t0} ms`)
console.log('edit-kind prior (verified success rate):', Object.fromEntries(Object.entries(agent.prior).map(([k, v]) => [k, +v.toFixed(3)])))

const zero = () => ({ n: 0, fixed: 0, changed: 0 })
const by = {}
const bump = (key, f) => { const r = (by[key] ??= zero()); r.n++; f(r) }
for (const t of held) {
  const res = agent.repair({ attempt: t.attempt, fn: t.fn, checks: t.checks, params: t.params })
  const ok = !grade(res.src, t.fn, t.checks).first
  const split = OUT.size === 0 ? 'all' : OUT.has(t.family) ? 'unseen-family' : 'seen-family'
  for (const key of [`${split}/${t.mode}`, `${split}/ALL-DEFECTIVE`, ...(t.mode === 'clean' ? [] : [`family ${t.family}`])]) {
    if (key.endsWith('ALL-DEFECTIVE') && t.mode === 'clean') continue
    bump(key, (r) => { if (ok) r.fixed++; if (res.changed) r.changed++ })
  }
}
for (const [k, r] of Object.entries(by).sort()) {
  const clean = k.endsWith('/clean')
  console.log(k.padEnd(28), clean ? `left alone ${r.n - r.changed}/${r.n}  (wrongly changed ${r.changed})` : `fixed ${r.fixed}/${r.n}`)
}
