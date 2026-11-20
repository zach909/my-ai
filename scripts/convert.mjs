#!/usr/bin/env node
// Convert one file to any other format in the registry.
//
//   node scripts/convert.mjs <input> <output>              formats come from the file names (and the first bytes)
//   node scripts/convert.mjs <input> <output> --from PNG --to Python
//   node scripts/convert.mjs --formats [search]            list the formats, or search them
//   node scripts/convert.mjs --coverage                    what is read and written natively, and how many pairs are routable
//
// Options: --text-art (pictures to plain brightness art, not the exact twin), --max-cols N,
//          --ocr (read the letters in a picture of text), --sql-table NAME.
//
// Needs the backend built once:  node scripts/build-backend.mjs   (or set NEUROCLAW_DIST to a build's folder).
// The converter is models && skills/core/format-convert.ts; the format list is training_data/file-formats/languages.yml.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = process.env.NEUROCLAW_DIST ?? path.join(root, 'dist')
const core = (file) => pathToFileURL(path.join(dist, 'models && skills', 'core', file)).href

if (!existsSync(path.join(dist, 'models && skills', 'core', 'format-convert.js'))) {
  console.error('The backend is not built. Run: node scripts/build-backend.mjs')
  process.exit(2)
}

const { convert, coverage } = await import(core('format-convert.js'))
const { formats } = await import(core('format-registry.js'))
const { writeFileAtomic } = await import(core('atomic-write.js'))

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }

const listing = bool('--formats')
const showCoverage = bool('--coverage')
const from = flag('--from'), to = flag('--to'), maxCols = flag('--max-cols'), sqlTable = flag('--sql-table')
const textArt = bool('--text-art'), ocr = bool('--ocr')

const reg = formats()

if (showCoverage) {
  const c = coverage(reg)
  console.log(`${c.formats} formats, ${c.pairs.toLocaleString()} ordered pairs, every one with a route.`)
  console.log('read as :', JSON.stringify(c.reads))
  console.log('written as:', JSON.stringify(c.writes))
  console.log('real readers/writers:', JSON.stringify(c.native))
  process.exit(0)
}

if (listing) {
  const q = (args[0] ?? '').toLowerCase()
  const rows = reg.all().filter((f) => !q || f.name.toLowerCase().includes(q) || f.aliases.some((a) => a.toLowerCase().includes(q)) || f.extensions.some((e) => e.toLowerCase().includes(q)))
  for (const f of rows) console.log(`${f.name.padEnd(32)} ${f.type.padEnd(12)} ${f.extensions.slice(0, 4).join(' ')}`)
  console.log(`${rows.length} of ${reg.size} formats`)
  process.exit(0)
}

const [inPath, outPath] = args
if (!inPath || !outPath) {
  console.error('Usage: node scripts/convert.mjs <input> <output> [--from NAME] [--to NAME] [--text-art] [--ocr]\n       node scripts/convert.mjs --formats [search]   |   --coverage')
  process.exit(2)
}

if (!existsSync(inPath)) { console.error(`No such file: ${inPath}`); process.exit(2) }
const input = readFileSync(inPath)
const fromInfo = from ? reg.get(from) : reg.detect(inPath, input)
const toInfo = to ? reg.get(to) : reg.detect(outPath)
if (!fromInfo) { console.error(`Cannot tell the format of ${inPath}. Say it with --from NAME (see --formats).`); process.exit(2) }
if (!toInfo) { console.error(`Cannot tell the format of ${outPath}. Say it with --to NAME (see --formats).`); process.exit(2) }

let result
try {
  result = convert(input, fromInfo.name, toInfo.name, { textArt: textArt ? 'art' : 'twin', ocr, sqlTable, maxCols: maxCols ? Number(maxCols) : undefined })
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

writeFileAtomic(outPath, Buffer.from(result.bytes))
console.log(`${fromInfo.name} -> ${toInfo.name}: ${result.fidelity} (${input.length} bytes in, ${result.bytes.length} out)`)
for (const step of result.route) console.log(`  - ${step}`)
for (const note of result.notes) console.log(`  ! ${note}`)
