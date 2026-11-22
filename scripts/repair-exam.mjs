#!/usr/bin/env node
/**
 * repair-exam.mjs -- the exam for docs/TRAINING_FOCUS.md: can the model write the fix, and does the fix run?
 *
 *   node scripts/make-repair-data.mjs --count 2500 --seed 1 --out train.jsonl
 *   node scripts/make-repair-data.mjs --count 300  --seed 2 --out held.jsonl
 *   node scripts/repair-exam.mjs --train train.jsonl --held held.jsonl [--leave-out clamp,average] [--dist <dir>]
 *
 * Trains NeuroclawTrainer (character level, no tokenizer) on the training traces, then for every held-out
 * one-defect trace gives it the task, the checks, the failing attempt, the REAL failure and "FIX", lets it write the
 * diagnosis and the next attempt (greedy), and RUNS that attempt against the checks. Reported separately:
 *   wellFormed  it produced an "ATTEMPT 2 ... RUN" block at all
 *   fixed       that code passes every check
 *   exact       that code equals the reference attempt
 * --leave-out removes whole task families from training and scores only those families: held-out RULES, not just seeds.
 * Needs the backend built first (tsc -p tsconfig.backend.json). Node built-ins only.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCall } from './drill-generators/repair.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') && a.push([x.slice(2), all[i + 1]]), a), []))
if (!args.train || !args.held) { console.error('usage: --train <jsonl> --held <jsonl> [--leave-out fam1,fam2] [--dist <dir>]'); process.exit(1) }
const DIST = path.resolve(args.dist ?? path.join(ROOT, 'dist', 'models && skills'))
const { NeuroclawTrainer } = await import(path.join(DIST, 'trainer.js'))

const load = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const train = load(args.train), held = load(args.held)
const OUT = new Set((args['leave-out'] ?? '').split(',').filter(Boolean))
const trainRows = train.filter((r) => !OUT.has(r.meta.family))
const scored = held.filter((r) => r.meta.mode === 'fix1' && (OUT.size === 0 || OUT.has(r.meta.family)))

const text = trainRows.map((r) => r.text).join('\n====\n')
const chars = [...new Set(text + held.map((r) => r.text).join(''))].sort()
const c2i = new Map(), i2c = new Map()
chars.forEach((c, i) => { c2i.set(c, i + 4); i2c.set(i + 4, c) })
const V = chars.length + 4
const model = new NeuroclawTrainer(V, c2i, i2c, { epochs: 1 })
const t0 = Date.now()
await model.train(text)
console.log(`trained on ${trainRows.length} traces (${text.length} chars) in ${((Date.now() - t0) / 1000).toFixed(0)}s; left out: [${[...OUT]}]`)

function generate(prompt, stop, max = 700) {
  let ctx = prompt, out = ''
  while (out.length < max && !out.includes(stop)) {
    const p = model.predict(ctx.slice(-8))
    let best = 4
    for (let v = 5; v < V; v++) if (p[v] > p[best]) best = v
    const ch = i2c.get(best)
    ctx += ch; out += ch
  }
  return out
}
const parseChecks = (t) => [...t.matchAll(/^(\w+)\((.*)\) == (.*)$/gm)].map((m) => ({ fn: m[1], args: JSON.parse(`[${m[2]}]`), expected: m[3] }))
const attempt2 = (t) => t.match(/ATTEMPT 2\n([\s\S]*?)\nRUN/)?.[1]

const total = { n: 0, wellFormed: 0, fixed: 0, exact: 0 }, byFamily = {}
for (const r of scored) {
  const cut = r.text.indexOf('\nFIX\n')
  const wrote = attempt2(generate(r.text.slice(0, cut + 5), '\nRUN'))
  const fam = (byFamily[r.meta.family] ??= { n: 0, wellFormed: 0, fixed: 0, exact: 0 })
  total.n++; fam.n++
  if (wrote === undefined) continue
  total.wellFormed++; fam.wellFormed++
  if (wrote === attempt2(r.text)) { total.exact++; fam.exact++ }
  if (parseChecks(r.text).every((c) => { const x = runCall(wrote, c.fn, c.args); return x.ok && x.text === c.expected })) { total.fixed++; fam.fixed++ }
}
console.log(JSON.stringify(total))
for (const [f, v] of Object.entries(byFamily)) console.log(' ', f.padEnd(14), `fixed ${v.fixed}/${v.n}  wellFormed ${v.wellFormed}/${v.n}  exact ${v.exact}/${v.n}`)
