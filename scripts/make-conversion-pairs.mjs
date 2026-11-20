#!/usr/bin/env node
// Make training pairs for file-format conversion: (input file, output file) for any format to any other.
//
//   node scripts/make-conversion-pairs.mjs --out pairs.jsonl [--count 500] [--seed 1]
//        [--fidelity lossless,wrapped,relabelled,lossy] [--kinds image,table,tree,code,text,bytes]
//        [--from NAME] [--to NAME]
//
// Each line is one pair, with the truth known both ways because this program made it:
//   { id, from, to, fidelity, reversible, route, notes, input: {encoding, data}, output: {encoding, data} }
//   encoding is "utf8" for text and "base64" for anything else; the network sees the raw bytes either way.
//   reversible is true only when converting the output back really gave the input back (checked here).
//
// The samples are generated from rules written in this file (small pictures at the curriculum's 16x16
// start size, tables, trees, code, prose, raw bytes). Nothing is downloaded and no model is used.
// Same --seed, same file. Every format in the registry is a target in turn, so all of them get covered.
//
// Needs the backend built once:  node scripts/build-backend.mjs   (or set NEUROCLAW_DIST).

import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = process.env.NEUROCLAW_DIST ?? path.join(root, 'dist')
const core = (file) => pathToFileURL(path.join(dist, 'models && skills', 'core', file)).href
if (!existsSync(path.join(dist, 'models && skills', 'core', 'format-convert.js'))) {
  console.error('The backend is not built. Run: node scripts/build-backend.mjs')
  process.exit(2)
}
const { convert } = await import(core('format-convert.js'))
const { formats } = await import(core('format-registry.js'))
const IMG = await import(core('format-image.js'))
const DATA = await import(core('format-data.js'))
const { makeRng } = await import(core('stroke-glyphs.js'))

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1] }
const out = opt('--out')
if (!out) { console.error('Usage: node scripts/make-conversion-pairs.mjs --out pairs.jsonl [--count 500] [--seed 1] [--fidelity ...] [--kinds ...] [--from NAME] [--to NAME]'); process.exit(2) }
const count = Number(opt('--count', '500'))
const seed = Number(opt('--seed', '1'))
const keepFidelity = new Set(opt('--fidelity', 'lossless,wrapped,relabelled,lossy').split(','))
const kinds = opt('--kinds', 'image,table,tree,code,text,bytes').split(',')
const onlyFrom = opt('--from'), onlyTo = opt('--to')

const rand = makeRng(seed)
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

// ---- samples, all from rules written here ----

const WORDS = 'amber basket candle dune ember falcon garden harbor island jungle kettle lantern meadow nectar orchard pebble quartz river saddle timber umbra violet willow yonder zephyr anchor beacon cobble drift echo fable glade haven ivory jasper kernel ledger marble nimbus opal prism quill ripple summit tundra vessel'.split(' ')
const NAMES = ['id', 'name', 'qty', 'price', 'city', 'ok', 'score', 'tag']

function imageSample() {
  const w = 16, h = 16, rgb = new Uint8Array(w * h * 3)
  const bg = [int(0, 255), int(0, 255), int(0, 255)]
  for (let i = 0; i < w * h; i++) rgb.set(bg, i * 3)
  for (let s = int(1, 3); s > 0; s--) {
    const c = [int(0, 255), int(0, 255), int(0, 255)]
    if (rand() < 0.5) { // rectangle
      const x0 = int(0, 10), y0 = int(0, 10), x1 = x0 + int(3, 6), y1 = y0 + int(3, 6)
      for (let y = y0; y < Math.min(h, y1); y++) for (let x = x0; x < Math.min(w, x1); x++) rgb.set(c, (y * w + x) * 3)
    } else { // disc
      const cx = int(3, 12), cy = int(3, 12), r = int(2, 5)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) rgb.set(c, (y * w + x) * 3)
    }
  }
  const img = { width: w, height: h, rgb }
  const fmt = pick(['PNG', 'PNG', 'PPM', 'BMP', 'SVG', 'Text Twin'])
  const bytes = fmt === 'PNG' ? IMG.encodePngBytes(img) : fmt === 'PPM' ? IMG.encodePnm(img, 'PPM') : fmt === 'BMP' ? IMG.encodeBmp(img) : fmt === 'SVG' ? IMG.encodeSvg(img) : Buffer.from(IMG.encodeTwin(img, true))
  return { format: fmt, bytes }
}

function tableSample() {
  const cols = shuffle(NAMES).slice(0, int(2, 4)), rows = int(2, 6)
  const cell = (c) => c === 'id' || c === 'qty' || c === 'score' ? String(int(0, 999)) : c === 'price' ? (int(1, 9999) / 100).toFixed(2).replace(/\.?0+$/, '') : c === 'ok' ? String(rand() < 0.5) : pick(WORDS)
  const t = { header: cols, rows: Array.from({ length: rows }, () => cols.map(cell)) }
  return { format: pick(['CSV', 'CSV', 'TSV']), bytes: null, table: t }
}

function treeSample() {
  const leaf = () => pick([() => pick(WORDS), () => int(-50, 500), () => rand() < 0.5, () => `${pick(WORDS)} ${pick(WORDS)}`])()
  const node = (d) => {
    const o = {}
    for (let i = int(1, 3); i > 0; i--) o[pick(WORDS)] = d < 2 && rand() < 0.35 ? node(d + 1) : d < 2 && rand() < 0.2 ? Array.from({ length: int(1, 3) }, leaf) : leaf()
    return o
  }
  return { format: 'JSON', bytes: Buffer.from(JSON.stringify(node(0), null, 2) + '\n'), tree: true }
}

function codeSample() {
  const f = pick(WORDS), a = pick(WORDS), b = pick(WORDS), n = int(2, 20)
  const py = [
    `def ${f}(${a}, ${b}):\n    return ${a} + ${b}\n\nprint(${f}(${int(1, 9)}, ${int(1, 9)}))\n`,
    `def ${f}(limit):\n    total = 0\n    for i in range(limit):\n        if i % ${n % 5 + 2} == 0:\n            total += i\n    return total\n\nprint(${f}(${n}))\n`,
  ]
  const js = [
    `function ${f}(${a}, ${b}) {\n  return ${a} * ${b};\n}\n\nconsole.log(${f}(${int(1, 9)}, ${int(1, 9)}));\n`,
    `const ${f} = (xs) => xs.filter((x) => x > ${n}).map((x) => x * 2);\n\nconsole.log(${f}([${n - 1}, ${n + 1}, ${n + 5}]));\n`,
  ]
  const c = [`#include <stdio.h>\n\nint ${f}(int ${a}, int ${b}) {\n    return ${a} - ${b};\n}\n\nint main(void) {\n    printf("%d\\n", ${f}(${n}, ${int(1, 9)}));\n    return 0;\n}\n`]
  const lang = pick(['Python', 'Python', 'JavaScript', 'JavaScript', 'C'])
  return { format: lang, bytes: Buffer.from(pick(lang === 'Python' ? py : lang === 'JavaScript' ? js : c)) }
}

function textSample() {
  const lines = Array.from({ length: int(1, 4) }, () => `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}, ${pick(WORDS)} ${pick(WORDS)}.`.replace(/^./, (m) => m.toUpperCase()))
  return { format: 'Text', bytes: Buffer.from(lines.join('\n') + '\n') }
}

function bytesSample() {
  return { format: 'Binary', bytes: Uint8Array.from({ length: int(24, 120) }, () => int(0, 255)) }
}

const MAKE = { image: imageSample, table: tableSample, tree: treeSample, code: codeSample, text: textSample, bytes: bytesSample }
const make = (kind) => {
  const s = MAKE[kind]()
  if (s.table) s.bytes = Buffer.from(DATA.writeDelimited(s.table, s.format === 'TSV' ? '\t' : ','))
  return s
}

// ---- is the reverse conversion really the same file? ----

const READ_IMAGE = { PNG: IMG.decodePng, PPM: IMG.decodePnm, BMP: IMG.decodeBmp, SVG: IMG.decodeSvg, 'Text Twin': (b) => IMG.decodeTwin(Buffer.from(b).toString('utf8')) }
function same(format, a, b) {
  const text = (x) => Buffer.from(x).toString('utf8')
  if (READ_IMAGE[format]) { const x = READ_IMAGE[format](a), y = READ_IMAGE[format](b); return x.width === y.width && x.height === y.height && Buffer.compare(Buffer.from(x.rgb), Buffer.from(y.rgb)) === 0 }
  if (format === 'JSON') return DATA.deepEqual(JSON.parse(text(a)), JSON.parse(text(b)))
  if (format === 'CSV' || format === 'TSV') { const d = format === 'TSV' ? '\t' : ','; return DATA.deepEqual(DATA.parseDelimited(text(a), d), DATA.parseDelimited(text(b), d)) }
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

const isText = (b) => { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return !b.includes(0) } catch { return false } }
const pack = (b) => isText(b) ? { encoding: 'utf8', data: Buffer.from(b).toString('utf8') } : { encoding: 'base64', data: Buffer.from(b).toString('base64') }

// ---- every format is a target in turn ----

const reg = formats()
let targets = shuffle(reg.all().map((f) => f.name))
if (onlyTo) targets = [reg.get(onlyTo)?.name ?? onlyTo]

const lines = []
const tally = {}
let attempts = 0
while (lines.length < count && attempts < count * 20) {
  const kind = kinds[attempts % kinds.length]
  const to = targets[Math.floor(attempts / kinds.length) % targets.length]
  attempts++
  const s = make(kind)
  if (onlyFrom && reg.get(onlyFrom)?.name !== s.format) continue
  if (s.format === to) continue
  const r = convert(s.bytes, s.format, to)
  if (!keepFidelity.has(r.fidelity)) continue
  let reversible = false
  try { reversible = same(s.format, convert(r.bytes, to, s.format).bytes, s.bytes) } catch { reversible = false }
  lines.push(JSON.stringify({ id: lines.length, from: s.format, to, fidelity: r.fidelity, reversible, route: r.route, notes: r.notes, input: pack(s.bytes), output: pack(r.bytes) }))
  tally[r.fidelity] = (tally[r.fidelity] ?? 0) + 1
}

writeFileSync(out, lines.join('\n') + '\n')
console.log(`wrote ${lines.length} pairs to ${out} (seed ${seed}); by fidelity: ${JSON.stringify(tally)}`)
