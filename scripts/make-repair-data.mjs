#!/usr/bin/env node
/**
 * make-repair-data.mjs -- write retry-and-repair training traces (see scripts/drill-generators/repair.mjs).
 *
 *   node scripts/make-repair-data.mjs --count 2000 --seed 1 --out <file.jsonl> [--text <file.txt>]
 *
 * One JSON object per line: { text, meta } where meta = { family, mode, attempts, checks, seed, index }.
 * --text also writes the traces as plain text separated by a blank line and a row of "=" for the char-level trainer.
 * Reproducible: a trace is (generator, seed, index); the file is not meant to be committed (docs/TRAINING_CURRICULUM.md).
 * Node built-ins only.
 */
import { writeFileSync } from 'node:fs'
import { generateRepairTrace, makeRand } from './drill-generators/repair.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
  return acc
}, []))
const count = Number(args.count ?? 1000)
const seed = Number(args.seed ?? 1)
if (!args.out) { console.error('usage: --out <file.jsonl> [--count N] [--seed N] [--text <file.txt>]'); process.exit(1) }

const rows = []
const modes = {}
for (let i = 0; i < count; i++) {
  // One rand per trace, so trace i is reproducible from (seed, i) alone.
  const t = generateRepairTrace(makeRand(seed * 1000003 + i))
  rows.push({ text: t.text, meta: { ...t.meta, seed, index: i } })
  modes[t.meta.mode] = (modes[t.meta.mode] ?? 0) + 1
}
writeFileSync(args.out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
if (args.text) writeFileSync(args.text, rows.map((r) => r.text).join('\n' + '='.repeat(40) + '\n\n'))
console.log(`${count} traces -> ${args.out}`, modes)
