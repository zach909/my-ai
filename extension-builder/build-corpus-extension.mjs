#!/usr/bin/env node
/**
 * build-corpus-extension.mjs -- build, check or query a cited knowledge extension.
 *
 *   node scripts/fetch-open-corpus.mjs                       # get the data and its citations first
 *   node extension-builder/build-corpus-extension.mjs        # build -> extension-builder/extensions/<name>.kx.json
 *   node extension-builder/build-corpus-extension.mjs --verify extension-builder/extensions/<name>.kx.json
 *   node extension-builder/build-corpus-extension.mjs --search "second law of thermodynamics" [--file <kx.json>]
 *
 * Options: --corpus <dir> (default training_data/open_corpus)  --out <file>  --name <name>  --version <1.2.3>
 *          --max-chars <n> (default 1200)  --k <n> (search results, default 5)
 * The build refuses to run if any text in the corpus is uncited, has an unaccepted licence, or no longer
 * matches its recorded SHA-256. Node built-ins only.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CitationError, buildKnowledgeExtension, loadCitedCorpus, readKnowledgeExtension,
  searchKnowledgeExtension, verifyAgainstCorpus, writeKnowledgeExtension,
} from './corpus-extension.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT_DIR = path.join(ROOT, 'extension-builder', 'extensions')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`)
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`)
    out[key] = next
    i++
  }
  return out
}

function newestKx() {
  if (!existsSync(EXT_DIR)) return null
  const files = readdirSync(EXT_DIR).filter((f) => f.endsWith('.kx.json'))
    .map((f) => path.join(EXT_DIR, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0] ?? null
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.verify) {
    const ext = readKnowledgeExtension(path.resolve(args.verify))
    console.log(`${args.verify}: structure and hashes OK (${ext.sources.length} sources, ${ext.chunks.length} passages, id ${ext.id})`)
    if (args.corpus || existsSync(path.join(ROOT, 'training_data', 'open_corpus'))) {
      const r = verifyAgainstCorpus(ext, args.corpus ?? path.join(ROOT, 'training_data', 'open_corpus'))
      if (!r.ok) { console.error(`NOT in sync with the corpus:\n - ${r.errors.join('\n - ')}`); process.exit(1) }
      console.log('every source and passage matches the corpus folder')
    }
    return
  }

  if (args.search) {
    const file = args.file ? path.resolve(args.file) : newestKx()
    if (!file) { console.error('no .kx.json found; build one first'); process.exit(1) }
    const ext = readKnowledgeExtension(file)
    const hits = searchKnowledgeExtension(ext, args.search, { k: Number(args.k ?? 5) })
    if (hits.length === 0) console.log('no passages matched')
    for (const h of hits) console.log(`\n[${h.score}] ${h.text.replace(/\s+/g, ' ').slice(0, 400)}\n  cite: ${h.citation}`)
    return
  }

  const corpusDir = path.resolve(args.corpus ?? path.join(ROOT, 'training_data', 'open_corpus'))
  const corpus = loadCitedCorpus(corpusDir)
  const ext = buildKnowledgeExtension(corpus, {
    name: args.name, version: args.version, maxChars: args['max-chars'] ? Number(args['max-chars']) : undefined,
  })
  const out = path.resolve(args.out ?? path.join(EXT_DIR, `${ext.name}.kx.json`))
  const { path: written, bytes } = writeKnowledgeExtension(ext, out)
  const sync = verifyAgainstCorpus(ext, corpusDir)
  if (!sync.ok) throw new Error(`built file does not match the corpus:\n - ${sync.errors.join('\n - ')}`)
  console.log(`${ext.name} ${ext.version} (${ext.id})`)
  console.log(`  ${ext.sources.length} cited sources, ${ext.chunks.length} passages, ${(bytes / 1e6).toFixed(2)} MB -> ${path.relative(ROOT, written)}`)
  for (const l of ext.licences) console.log(`  ${l.id}: ${l.sources} sources`)
  console.log('  every passage verified against its source file')
}

try {
  main()
} catch (err) {
  console.error(err instanceof CitationError ? err.message : `error: ${err.message}`)
  process.exit(1)
}
