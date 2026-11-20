/**
 * The reply in every format the project's converter knows: response/formats/.
 */
import { describe, it, expect } from 'vitest'
import { formatEntries, fileNameFor, MAX_REPLY_CHARS, SOURCE_FORMAT } from '../../interface/response-formats.js'
import { buildResponseBundle } from '../../interface/response-bundle.js'
import { formats } from '../../models && skills/core/format-registry.js'
import { readZip } from '../../models && skills/core/zip-archive.js'

const files = (zip: Buffer) => Object.fromEntries(readZip(zip).map(e => [e.name, e.data]))

describe('reply in every format', () => {
  const r = formatEntries('# Hello\n\nThe answer is 42.\n')

  it('makes a file for every format in the list, or says why not', () => {
    expect(r.total).toBe(formats().size)
    expect(r.written.length + r.skipped.length).toBe(r.total - 1) // the source format is reply.md itself
    expect(r.written.length).toBeGreaterThan(800)
    expect(r.entries.length).toBe(r.written.length)
  })
  it('names files from a strict character set, all inside response/formats/, no duplicates', () => {
    const names = r.entries.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(/^response\/formats\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(n)).toBe(true)
  })
  it('records what each file really is', () => {
    for (const w of r.written) expect(['lossless', 'lossy', 'wrapped', 'relabelled']).toContain(w.fidelity)
    const py = r.written.find(w => w.format === 'Python')!
    expect(py.fidelity).toBe('wrapped')
    const txt = Buffer.from(r.entries.find(e => e.name === py.file)!.data).toString('utf8')
    expect(txt).toContain('NEUROCLAW-WRAP')
  })
  it('is the same files in the same order for the same reply', () => {
    const again = formatEntries('# Hello\n\nThe answer is 42.\n')
    expect(again.entries.map(e => e.name)).toEqual(r.entries.map(e => e.name))
    expect(Buffer.from(again.entries[5].data).equals(Buffer.from(r.entries[5].data))).toBe(true)
  })
  it('does not convert a very long reply, and says so', () => {
    const long = formatEntries('x'.repeat(MAX_REPLY_CHARS + 1))
    expect(long.entries).toEqual([])
    expect(long.skipped[0].format).toBe('all')
  })
  it('builds a file name from the first extension', () => {
    expect(fileNameFor({ name: 'Python', type: 'programming', extensions: ['.py'], filenames: [], aliases: [], interpreters: [], source: 'languages.yml' })).toBe('Python.py')
    expect(fileNameFor({ name: 'A b/c', type: 'data', extensions: [], filenames: [], aliases: [], interpreters: [], source: 'languages.yml' })).toBe('A_b_c.txt')
    expect(SOURCE_FORMAT).toBe('Markdown')
  })
})

describe('in the zip', () => {
  it('puts them in response/formats/ with an index, and keeps the manifest short', () => {
    const f = files(buildResponseBundle({ response: 'Hello there.' }))
    const index = JSON.parse(f['response/formats/index.json'].toString())
    expect(index.written).toBeGreaterThan(800)
    expect(index.files.length).toBe(index.written)
    expect(Object.keys(f).filter(n => n.startsWith('response/formats/')).length).toBe(index.written + 1)
    const manifest = JSON.parse(f['manifest.json'].toString())
    expect(manifest.formatFiles).toBe(index.written)
    expect(manifest.files.length).toBeLessThan(40)
    expect(f['response/reply.md'].toString()).toBe('Hello there.\n')
  })
  it('can be left out', () => {
    const f = files(buildResponseBundle({ response: 'Hello there.', formats: false }))
    expect(Object.keys(f).some(n => n.startsWith('response/formats/'))).toBe(false)
    expect(JSON.parse(f['manifest.json'].toString()).formatFiles).toBe(0)
  })
  it('converts the reply after definitions and approved edits, not the raw text', () => {
    const f = files(buildResponseBundle({ response: 'Say {{w}}.', definitions: { w: 'hello' } }))
    const index = JSON.parse(f['response/formats/index.json'].toString())
    const json = index.files.find((x: { format: string }) => x.format === 'JSON')
    expect(f[json.file].toString()).toContain('hello')
    expect(f[json.file].toString()).not.toContain('{{w}}')
  })
})
