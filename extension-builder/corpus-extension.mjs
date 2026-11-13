/**
 * corpus-extension.mjs -- turn a CITED data set into an installable "knowledge extension" for the AI.
 *
 * The data side is scripts/fetch-open-corpus.mjs, which writes training_data/open_corpus/ (text files plus
 * manifest.json with a link, licence, access date, revision and SHA-256 for every file). This module is the
 * Extension Builder side: it refuses any text that is not fully cited, cuts the text into passages that each
 * keep an exact pointer back into their source, and writes one versioned, content-addressed file
 * (extension-builder/extensions/<name>.kx.json). Nothing can come back out of that file without its citation:
 * searchKnowledgeExtension() returns the passage and the formatted citation together.
 *
 * Rules this file keeps (see CLAUDE.md / AGENTS.md):
 *   - Node built-ins only (node:crypto, node:fs, node:path). No third-party code.
 *   - No tokenizer. Passages are exact slices of the source text; search compares character 3-grams of the
 *     raw string. No word or subword vocabulary anywhere.
 *   - Only openly licensed data (see LICENCES). An unknown licence is an error, not a warning.
 *
 * File shape (follows the common envelope of docs/EXTENSION_BUILDER_SPEC.md §8.1; `kind` is new):
 *   { $schema, formatVersion: 1, kind: 'knowledge-extension', id, name, version, description, builtAt,
 *     chunking: { maxChars }, licences: [...], attribution, sources: [...], chunks: [...] }
 *
 * The suffix is `.kx.json` on purpose: the server loads every `*.ext.json` in extension-builder/extensions
 * at boot and grafts its `neurons`; a multi-megabyte text file with that suffix would only be read for nothing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const FORMAT_VERSION = 1
export const KIND = 'knowledge-extension'
export const SCHEMA = 'https://internal/schemas/extension-builder/v1/knowledge-extension.json'
export const DEFAULT_MAX_CHARS = 1200

/** The only licences accepted. `test` is matched against the licence text in the corpus manifest. */
export const LICENCES = {
  'PD-US': {
    name: 'Public domain in the USA',
    test: /public domain/i,
    obligations: 'No licence conditions in the USA. Check your own jurisdiction before redistributing elsewhere. Keep the source citation anyway.',
  },
  'CC-BY-SA-4.0': {
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    test: /CC BY-SA 4\.0/i,
    obligations: 'Attribution is required (title, link, authors via the history link, licence). Adaptations must be shared under CC BY-SA 4.0, so this extension must travel with its attribution text and its source list.',
  },
}

export class CitationError extends Error {
  constructor(problems) {
    super(`The corpus is not fully cited (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n - ${problems.join('\n - ')}`)
    this.name = 'CitationError'
    this.problems = problems
  }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** manifest.json section -> how one entry becomes a source. Only these sections are read. */
const SECTIONS = [
  ['gutenberg', 'book', (e) => ({ id: `gutenberg:${e.id}`, author: e.author ?? null, page: e.page ?? null })],
  ['wikipedia', 'article-summary', (e) => ({ id: `wikipedia-summary:${e.title}`, author: 'Wikipedia contributors', page: null })],
  ['wikipediaFull', 'article', (e) => ({ id: `wikipedia:${e.title}`, author: 'Wikipedia contributors', page: null, history: e.history ?? null })],
]

const licenceIdOf = (text) => Object.keys(LICENCES).find((id) => LICENCES[id].test.test(String(text ?? ''))) ?? null

/**
 * Read a corpus folder written by fetch-open-corpus.mjs and check every citation. Throws CitationError listing
 * ALL problems at once (missing field, unknown licence, file missing, hash mismatch, text file with no citation).
 * @returns {{ dir: string, generated: string|null, sources: Array<object & { text: string }> }}
 */
export function loadCitedCorpus(dir) {
  const root = path.resolve(dir)
  const manifestPath = path.join(root, 'manifest.json')
  if (!existsSync(manifestPath)) throw new CitationError([`${manifestPath} does not exist: data without a manifest has no citations`])
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (err) { throw new CitationError([`manifest.json is not valid JSON: ${err.message}`]) }

  const problems = []
  const sources = []
  const seenIds = new Set()
  const citedFiles = new Set()

  for (const [section, kind, shape] of SECTIONS) {
    for (const entry of Array.isArray(manifest[section]) ? manifest[section] : []) {
      const meta = shape(entry)
      const label = `${section}: ${meta.id}`
      const missing = ['title', 'url', 'licence', 'accessed', 'file', 'sha256'].filter((f) => !String(entry[f] ?? '').trim())
      if (missing.length) { problems.push(`${label} is missing ${missing.join(', ')}`); continue }
      if (!/^https:\/\//.test(entry.url)) problems.push(`${label}: url must be an https link`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.accessed)) problems.push(`${label}: accessed must be YYYY-MM-DD`)
      if (!/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${label}: sha256 is not a 64-digit hex string`)
      const licenceId = licenceIdOf(entry.licence)
      if (!licenceId) problems.push(`${label}: licence "${entry.licence}" is not one of ${Object.keys(LICENCES).join(', ')}; only openly licensed data is accepted`)
      if (seenIds.has(meta.id)) { problems.push(`${label}: listed twice`); continue }
      seenIds.add(meta.id)

      const abs = path.resolve(root, entry.file)
      if (abs !== root && !abs.startsWith(root + path.sep)) { problems.push(`${label}: file "${entry.file}" is outside the corpus folder`); continue }
      citedFiles.add(path.relative(root, abs).split(path.sep).join('/'))
      if (!existsSync(abs)) { problems.push(`${label}: file "${entry.file}" does not exist`); continue }
      const bytes = readFileSync(abs)
      if (sha256(bytes) !== entry.sha256) { problems.push(`${label}: file "${entry.file}" does not match its recorded SHA-256 (changed since it was cited)`); continue }

      sources.push({
        id: meta.id, kind, title: entry.title, author: meta.author, url: entry.url, page: meta.page ?? null,
        history: meta.history ?? null, licence: entry.licence, licenceId, accessed: entry.accessed,
        revision: entry.revision ?? null, timestamp: entry.timestamp ?? null, file: entry.file, sha256: entry.sha256,
        chars: bytes.toString('utf8').length, text: bytes.toString('utf8'),
      })
    }
  }

  // A text file nobody cited must not slip in beside the cited ones.
  for (const sub of readdirSync(root).filter((d) => statSync(path.join(root, d)).isDirectory())) {
    for (const f of readdirSync(path.join(root, sub)).filter((n) => n.endsWith('.txt'))) {
      if (!citedFiles.has(`${sub}/${f}`)) problems.push(`${sub}/${f} has no citation in manifest.json`)
    }
  }
  if (sources.length === 0 && problems.length === 0) problems.push('manifest.json lists no sources')
  if (problems.length) throw new CitationError(problems)
  sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { dir: root, generated: manifest.generated ?? null, sources }
}

const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f'

function trimSpan(text, a, b) {
  while (a < b && isSpace(text[a])) a++
  while (b > a && isSpace(text[b - 1])) b--
  return [a, b]
}

/** Cut a paragraph longer than `max` at the last sentence end, else the last space, else hard (never inside a surrogate pair). */
function splitLong(text, a, b, max) {
  const out = []
  let s = a
  while (s < b) {
    let e = Math.min(s + max, b)
    if (e < b) {
      const win = text.slice(s, e)
      let cut = 0
      for (const m of win.matchAll(/[.!?]["')\]”’]*\s/g)) cut = m.index + m[0].length
      if (cut < max * 0.5) cut = win.lastIndexOf(' ') + 1
      if (cut < max * 0.5) cut = win.length
      e = s + cut
      const code = text.charCodeAt(e - 1)
      if (code >= 0xd800 && code <= 0xdbff) e--
    }
    const [x, y] = trimSpan(text, s, e)
    if (y > x) out.push([x, y])
    s = e
  }
  return out
}

/**
 * Cut text into passages as exact [start, end) spans: whole paragraphs packed up to `maxChars`, a paragraph
 * that is longer than that split at sentence ends. text.slice(start, end) IS the passage; nothing is rewritten.
 */
export function chunkSpans(text, maxChars = DEFAULT_MAX_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new RangeError('maxChars must be an integer of at least 100')
  const paras = []
  let last = 0
  for (const m of text.matchAll(/\n[ \t]*\n/g)) { paras.push([last, m.index]); last = m.index + m[0].length }
  paras.push([last, text.length])

  const spans = []
  let cur = null
  for (const [pa, pb] of paras) {
    const [a, b] = trimSpan(text, pa, pb)
    if (a >= b) continue
    if (b - a > maxChars) {
      if (cur) { spans.push(cur); cur = null }
      spans.push(...splitLong(text, a, b, maxChars))
    } else if (cur && b - cur[0] <= maxChars) {
      cur[1] = b
    } else {
      if (cur) spans.push(cur)
      cur = [a, b]
    }
  }
  if (cur) spans.push(cur)
  return spans
}

/** One-line citation for a source (and, when given, the passage's character offset in the source file). */
export function formatCitation(source, chunk) {
  const parts = []
  if (source.author) parts.push(`${source.author}.`)
  parts.push(`${source.kind === 'book' ? `*${source.title}*` : `"${source.title}"`}.`)
  if (source.id.startsWith('gutenberg:')) parts.push(`Project Gutenberg ebook #${source.id.slice('gutenberg:'.length)}.`)
  else parts.push('Wikipedia.')
  parts.push(`${source.url}.`)
  if (source.revision) parts.push(`Revision ${source.revision}${source.timestamp ? ` (${source.timestamp})` : ''}.`)
  parts.push(`${LICENCES[source.licenceId]?.name ?? source.licence}.`)
  parts.push(`Accessed ${source.accessed}.`)
  if (chunk) parts.push(`Passage at character ${chunk.o} of ${source.file}.`)
  return parts.join(' ')
}

function attributionText(sources, licences) {
  return [
    'This extension contains text from the sources below. Keep this notice with any copy.',
    '',
    ...licences.map((l) => `${l.id} (${l.name}): ${l.obligations}`),
    '',
    ...sources.map((s) => `- ${formatCitation(s)}${s.history ? ` Authors: ${s.history}.` : ''} SHA-256 ${s.sha256}.`),
    '',
  ].join('\n')
}

const contentId = (sources, maxChars) => 'kx-' + sha256(JSON.stringify({
  formatVersion: FORMAT_VERSION, maxChars, sources: sources.map((s) => [s.id, s.sha256]).sort(),
})).slice(0, 16)

/**
 * Build the knowledge extension from a corpus loadCitedCorpus() returned.
 * The id is a hash of the cited sources and the chunk size, so the same data always gives the same id.
 */
export function buildKnowledgeExtension(corpus, opts = {}) {
  const name = opts.name ?? 'open-corpus-knowledge'
  const version = opts.version ?? '1.0.0'
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error(`extension name "${name}" must be lowercase letters, digits, . _ - (max 64)`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version "${version}" must look like 1.2.3`)

  const chunks = []
  const sources = corpus.sources.map(({ text, ...meta }) => {
    let n = 0
    for (const [a, b] of chunkSpans(text, maxChars)) {
      const t = text.slice(a, b)
      chunks.push({ id: `${meta.id}#${n}`, s: meta.id, o: a, n: b - a, h: sha256(t).slice(0, 16), t })
      n++
    }
    return { ...meta, chunks: n }
  })

  const licences = Object.keys(LICENCES)
    .filter((id) => sources.some((s) => s.licenceId === id))
    .map((id) => ({ id, name: LICENCES[id].name, obligations: LICENCES[id].obligations, sources: sources.filter((s) => s.licenceId === id).length }))

  return {
    $schema: SCHEMA,
    formatVersion: FORMAT_VERSION,
    kind: KIND,
    id: contentId(sources, maxChars),
    name,
    version,
    description: opts.description ?? `Cited open-licence text (${sources.length} sources, ${chunks.length} passages) for the AI to look things up in, with the source of every passage.`,
    builtAt: new Date(opts.now ?? Date.now()).toISOString(),
    chunking: { maxChars },
    licences,
    attribution: attributionText(sources, licences),
    sources,
    chunks,
  }
}

/**
 * Check a knowledge extension on its own (no corpus folder needed). Returns { ok, errors }.
 * Rejects an unknown formatVersion instead of guessing.
 */
export function verifyKnowledgeExtension(ext) {
  const errors = []
  if (!ext || typeof ext !== 'object') return { ok: false, errors: ['not an object'] }
  if (ext.kind !== KIND) return { ok: false, errors: [`kind is "${ext.kind}", expected "${KIND}"`] }
  if (ext.formatVersion !== FORMAT_VERSION) return { ok: false, errors: [`formatVersion ${ext.formatVersion} is not supported (this builder reads ${FORMAT_VERSION}); upgrade your builder`] }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(ext.name ?? '')) errors.push('name is missing or not a safe name')
  if (!/^\d+\.\d+\.\d+$/.test(ext.version ?? '')) errors.push('version is missing or not semver')
  if (!Array.isArray(ext.sources) || !Array.isArray(ext.chunks) || ext.sources.length === 0) return { ok: false, errors: [...errors, 'sources/chunks missing or empty'] }

  const byId = new Map()
  for (const s of ext.sources) {
    for (const f of ['id', 'title', 'url', 'licence', 'licenceId', 'accessed', 'file', 'sha256']) {
      if (!String(s[f] ?? '').trim()) errors.push(`source ${s.id ?? '?'} is missing ${f}`)
    }
    if (!LICENCES[s.licenceId]) errors.push(`source ${s.id} has unaccepted licence id "${s.licenceId}"`)
    else if (!LICENCES[s.licenceId].test.test(s.licence ?? '')) errors.push(`source ${s.id}: licence text does not match its licence id`)
    if (byId.has(s.id)) errors.push(`source ${s.id} is listed twice`)
    byId.set(s.id, { ...s, seen: 0 })
    if (typeof s.url === 'string' && !(ext.attribution ?? '').includes(s.url)) errors.push(`attribution text does not mention ${s.url}`)
  }
  for (const l of ext.licences ?? []) if (!LICENCES[l.id]) errors.push(`licence table lists unknown licence ${l.id}`)
  for (const id of new Set(ext.sources.map((s) => s.licenceId))) {
    if (!(ext.licences ?? []).some((l) => l.id === id)) errors.push(`licence table is missing ${id}`)
  }
  for (const c of ext.chunks) {
    const src = byId.get(c.s)
    if (!src) { errors.push(`passage ${c.id} cites unknown source ${c.s}`); continue }
    src.seen++
    if (typeof c.t !== 'string' || c.t.length !== c.n) errors.push(`passage ${c.id} length does not match n`)
    else if (sha256(c.t).slice(0, 16) !== c.h) errors.push(`passage ${c.id} does not match its hash`)
    if (!Number.isInteger(c.o) || c.o < 0 || c.o + c.n > src.chars) errors.push(`passage ${c.id} points outside ${c.s}`)
  }
  for (const s of byId.values()) if (s.seen !== s.chunks) errors.push(`source ${s.id} says ${s.chunks} passages but ${s.seen} are present`)
  if (ext.id !== contentId(ext.sources, ext.chunking?.maxChars)) errors.push('id does not match the content hash of the sources')
  return { ok: errors.length === 0, errors: errors.slice(0, 50) }
}

/**
 * Check a knowledge extension against the corpus folder it claims to come from: every source still has the
 * recorded SHA-256, and every passage is character-for-character the slice it points at.
 */
export function verifyAgainstCorpus(ext, corpusDir) {
  const errors = []
  const corpus = loadCitedCorpus(corpusDir)
  const text = new Map(corpus.sources.map((s) => [s.id, s]))
  for (const s of ext.sources) {
    const live = text.get(s.id)
    if (!live) errors.push(`source ${s.id} is no longer in the corpus`)
    else if (live.sha256 !== s.sha256) errors.push(`source ${s.id} changed since this extension was built`)
  }
  for (const c of ext.chunks) {
    const live = text.get(c.s)
    if (live && live.text.slice(c.o, c.o + c.n) !== c.t) errors.push(`passage ${c.id} is not the text at its offset`)
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 50) }
}

/** Write atomically (temp file then rename) so a crash never leaves half an extension. */
export function writeKnowledgeExtension(ext, outPath) {
  const check = verifyKnowledgeExtension(ext)
  if (!check.ok) throw new Error(`refusing to write an extension that fails verification:\n - ${check.errors.join('\n - ')}`)
  const abs = path.resolve(outPath)
  mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ext))
  renameSync(tmp, abs)
  return { path: abs, bytes: statSync(abs).size }
}

export function readKnowledgeExtension(file) {
  const ext = JSON.parse(readFileSync(file, 'utf8'))
  const check = verifyKnowledgeExtension(ext)
  if (!check.ok) throw new Error(`${file} failed verification:\n - ${check.errors.join('\n - ')}`)
  return ext
}

const lowerCache = new WeakMap()

/**
 * Look something up. Scoring is character 3-gram overlap on the raw lower-cased text, weighted by how rare each
 * 3-gram is across the passages (no word list, no tokenizer). Every result carries its citation: there is no way
 * to get a passage out of this function without it.
 * @returns {Array<{ score: number, text: string, source: string, offset: number, citation: string }>}
 */
export function searchKnowledgeExtension(ext, query, opts = {}) {
  const k = opts.k ?? 5
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!q) return []
  let lower = lowerCache.get(ext.chunks)
  if (!lower) { lower = ext.chunks.map((c) => c.t.toLowerCase()); lowerCache.set(ext.chunks, lower) }

  const grams = new Set()
  if (q.length < 3) grams.add(q)
  else for (let i = 0; i + 3 <= q.length; i++) { const g = q.slice(i, i + 3); if (/[\p{L}\p{N}]/u.test(g)) grams.add(g) }
  if (grams.size === 0) return []

  const N = ext.chunks.length
  const score = new Float64Array(N)
  let total = 0
  for (const g of grams) {
    const hits = []
    for (let i = 0; i < N; i++) if (lower[i].includes(g)) hits.push(i)
    if (hits.length === 0) continue
    const idf = Math.log(1 + N / (1 + hits.length))
    total += idf
    for (const i of hits) score[i] += idf
  }
  if (total === 0) return []
  const kindFilter = opts.sourceKind
  const sourceById = new Map(ext.sources.map((s) => [s.id, s]))
  const ranked = []
  for (let i = 0; i < N; i++) {
    if (score[i] === 0) continue
    if (kindFilter && sourceById.get(ext.chunks[i].s)?.kind !== kindFilter) continue
    const phrase = q.length >= 3 && lower[i].includes(q) ? 0.5 : 0
    ranked.push([i, score[i] / total + phrase])
  }
  ranked.sort((a, b) => b[1] - a[1])
  return ranked.slice(0, k).map(([i, s]) => {
    const c = ext.chunks[i]
    const src = sourceById.get(c.s)
    return { score: +s.toFixed(4), text: c.t, source: c.s, offset: c.o, citation: formatCitation(src, c) }
  })
}

/**
 * Put the extension's sources into a live ExtensionBuilder (extension-builder/builder.js) through its public
 * methods: one project, one `netsearch` neuron per source whose corpus lines are that source's passages, and a
 * label on each neuron carrying the licence and link. `builder` is any object with createProject / addNetSearch /
 * dragLabel as in builder.d.ts, so this file does not import the engine (which needs the compiled backend).
 * @returns {{ projectId: string, neurons: number, lines: number }}
 */
export function applyToBuilder(builder, ext, opts = {}) {
  const perSource = opts.linesPerSource ?? 100
  const project = builder.createProject(ext.name, `${ext.description} [${ext.id}]`)
  const bySource = new Map()
  for (const c of ext.chunks) {
    if (!bySource.has(c.s)) bySource.set(c.s, [])
    bySource.get(c.s).push(c)
  }
  let neurons = 0
  let lines = 0
  const columns = Math.max(1, Math.ceil(Math.sqrt(ext.sources.length)))
  for (const [index, s] of ext.sources.entries()) {
    const all = bySource.get(s.id) ?? []
    const step = Math.max(1, Math.ceil(all.length / perSource))
    // One line per passage (newlines are the engine's line separator): its opening, so the line is a query.
    const picked = all.filter((_, i) => i % step === 0).map((c) => c.t.replace(/\s+/g, ' ').slice(0, 160))
    const neuron = builder.addNetSearch(project.id, s.title, picked.join('\n'), '', '', { x: (index % columns) * 160, y: Math.floor(index / columns) * 120 })
    if (!neuron) continue
    builder.dragLabel(project.id, neuron.id, `${s.licenceId} ${s.url}`)
    neurons++
    lines += picked.length
  }
  return { projectId: project.id, neurons, lines }
}
