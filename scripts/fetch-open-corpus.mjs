#!/usr/bin/env node
/**
 * fetch-open-corpus.mjs -- download freely licensed training text and write the
 * citations for it (ALIGNMENT.md §7 step 5, §8.1: every source with link, licence
 * and access date; only openly licensed data).
 *
 * Sources (data only -- no code is fetched or vendored):
 *   - Project Gutenberg: books in the public domain in the USA.
 *     https://www.gutenberg.org  (licence: public domain; the PG licence boilerplate
 *     is stripped, as the PG terms permit for public-domain texts)
 *   - Wikipedia article summaries via the REST API, CC BY-SA 4.0.
 *     https://en.wikipedia.org  (attribution recorded: title, revision, URL)
 *
 * Output (training_data/open_corpus/):
 *   gutenberg/<id>.txt, wikipedia/<slug>.txt   the text
 *   manifest.json                              machine-readable citations
 *   CITATIONS.md                               human-readable citations
 *
 * Usage: node scripts/fetch-open-corpus.mjs
 * Node built-ins only (fetch, fs, path).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'training_data', 'open_corpus')
const UA = 'NeuroClaw-open-corpus-fetch/0.1 (https://github.com/zach909/.my-ai)'
const TODAY = new Date().toISOString().slice(0, 10)

/** Gutenberg ebook numbers: ethics, science and plain prose. */
const BOOKS = [
  1342, // Pride and Prejudice - Austen
  84, // Frankenstein - Shelley
  11, // Alice's Adventures in Wonderland - Carroll
  2009, // On the Origin of Species - Darwin
  30155, // Relativity: The Special and General Theory - Einstein
  1497, // The Republic - Plato
  2680, // Meditations - Marcus Aurelius
  34901, // On Liberty - Mill
  11224, // Utilitarianism - Mill
]

const WIKI = [
  'Photosynthesis', 'Black hole', 'Quantum computing', 'Logic gate', 'Periodic table',
  'Thermodynamics', 'Machine learning', 'Neuron', 'DNA', 'Plate tectonics',
  'Prime number', 'Ethics', 'Scientific method', 'Electromagnetism', 'Evolution',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, asJson = false) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return asJson ? await res.json() : await res.text()
    } catch (err) {
      if (attempt === 4) throw new Error(`${url}: ${err.message}`)
      await sleep(2000 * 2 ** (attempt - 1))
    }
  }
}

function stripGutenberg(raw) {
  const text = raw.replace(/\r\n/g, '\n')
  const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i)
  const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i)
  if (start < 0 || end < 0) throw new Error('PG start/end markers not found')
  const body = text.slice(text.indexOf('\n', start) + 1, end).trim()
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? 'unknown'
  return { body, title: field('Title'), author: field('Author') }
}

const manifest = { generated: TODAY, gutenberg: [], wikipedia: [] }
mkdirSync(path.join(OUT, 'gutenberg'), { recursive: true })
mkdirSync(path.join(OUT, 'wikipedia'), { recursive: true })

for (const id of BOOKS) {
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`
  try {
    const { body, title, author } = stripGutenberg(await get(url))
    writeFileSync(path.join(OUT, 'gutenberg', `${id}.txt`), body + '\n')
    manifest.gutenberg.push({
      id, title, author, url, page: `https://www.gutenberg.org/ebooks/${id}`,
      licence: 'Public domain in the USA (Project Gutenberg)', accessed: TODAY, chars: body.length,
    })
    console.log(`gutenberg ${id}: ${title} (${body.length} chars)`)
  } catch (err) {
    console.error(`gutenberg ${id}: SKIPPED -- ${err.message}`)
  }
  await sleep(1500)
}

for (const title of WIKI) {
  const slug = title.replace(/ /g, '_')
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`
  try {
    const j = await get(url, true)
    const extract = String(j.extract ?? '').trim()
    if (!extract) throw new Error('empty extract')
    writeFileSync(path.join(OUT, 'wikipedia', `${slug}.txt`), `${j.title}\n\n${extract}\n`)
    manifest.wikipedia.push({
      title: j.title, url: j.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`,
      revision: j.revision ?? null, timestamp: j.timestamp ?? null,
      licence: 'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); text by Wikipedia contributors',
      accessed: TODAY, chars: extract.length,
    })
    console.log(`wikipedia ${title} (rev ${j.revision})`)
  } catch (err) {
    console.error(`wikipedia ${title}: SKIPPED -- ${err.message}`)
  }
  await sleep(500)
}

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const md = [
  '# Open training corpus -- citations',
  '',
  `Fetched by \`scripts/fetch-open-corpus.mjs\`, accessed ${TODAY}. Only openly licensed text.`,
  '',
  '## Project Gutenberg (public domain in the USA)',
  'Texts from Project Gutenberg (https://www.gutenberg.org). The Project Gutenberg licence header/footer',
  'was removed; the underlying works are public domain in the USA. Check your own jurisdiction before',
  'redistributing outside the USA.',
  '',
  ...manifest.gutenberg.map((b) => `- ${b.author}. *${b.title}*. Project Gutenberg ebook #${b.id}. ${b.page} (text: ${b.url}). Accessed ${b.accessed}.`),
  '',
  '## Wikipedia (CC BY-SA 4.0)',
  'Article summaries by Wikipedia contributors, licensed CC BY-SA 4.0. Attribution is given per item;',
  'ShareAlike applies to adaptations of this text, so keep it separate from other data and keep this',
  'file with it.',
  '',
  ...manifest.wikipedia.map((w) => `- "${w.title}", Wikipedia contributors, revision ${w.revision ?? 'n/a'} (${w.timestamp ?? 'n/a'}). ${w.url}. CC BY-SA 4.0. Accessed ${w.accessed}.`),
  '',
].join('\n')
writeFileSync(path.join(OUT, 'CITATIONS.md'), md)
console.log(`\nwrote ${manifest.gutenberg.length} books, ${manifest.wikipedia.length} wiki summaries -> ${path.relative(ROOT, OUT)}`)
