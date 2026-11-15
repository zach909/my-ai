/**
 * The file-format converter: the registry read from the owner's languages.yml, the picture, data and
 * program codecs, and conversion between any two formats.
 *
 * Programs the converter writes are RUN here (when the language is installed) and must print the
 * original bytes exactly. Pictures are built by hand with every PNG filter and colour type so the
 * decoder is checked against files it did not write itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { FormatRegistry, formats, parseLanguagesYaml, BUILT_IN_FORMATS } from '../../models && skills/core/format-registry.js'
import * as IMG from '../../models && skills/core/format-image.js'
import * as DATA from '../../models && skills/core/format-data.js'
import * as CODE from '../../models && skills/core/format-code.js'
import { convert, coverage } from '../../models && skills/core/format-convert.js'
import { crc32 } from '../../models && skills/core/desktop/png.js'

const raster = (w: number, h: number, seed = 7): IMG.Raster => {
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 53 + seed * 11) % 256
  return { width: w, height: h, rgb }
}
const sameRaster = (a: IMG.Raster, b: IMG.Raster): boolean =>
  a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.rgb), Buffer.from(b.rgb)) === 0

/** A tiny seeded generator so the random trees are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

// ---------------------------------------------------------------- registry

describe('format registry', () => {
  const reg = formats()

  it('reads every entry of the owner\'s languages.yml, plus the media formats added by hand', () => {
    expect(reg.size).toBe(845 + BUILT_IN_FORMATS.length)
    expect(reg.all().filter((f) => f.source === 'languages.yml')).toHaveLength(845)
    expect(reg.get('Python')?.type).toBe('programming')
    expect(reg.get('Gerber Image')?.type).toBe('data')
    expect(reg.get('Cairo Zero')?.group).toBe('Cairo')
  })

  it('finds a format from a name, an alias, an extension or a filename', () => {
    expect(reg.get('python')?.name).toBe('Python')
    expect(reg.get('c#')?.name).toBe('C#')
    expect(reg.get('.py')?.name).toBe('Python')
    expect(reg.get('rs')?.name).toBe('Rust')
    expect(reg.get('.blade.php')?.name).toBe('Blade')
    expect(reg.get('Dockerfile')?.name).toBe('Dockerfile')
    expect(reg.get('png')?.name).toBe('PNG')
    expect(reg.get('no such format at all')).toBeNull()
  })

  it('picks the likely format when an extension is shared', () => {
    expect(reg.get('.txt')?.name).toBe('Text')
    expect(reg.get('.h')?.name).toBe('C')
    expect(reg.get('.md')?.name).toBe('Markdown')
    expect(reg.candidatesForExtension('.txt').length).toBeGreaterThan(1)
  })

  it('detects from a filename, the longest extension first, a shebang or picture bytes', () => {
    expect(reg.detect('src/page.blade.php')?.name).toBe('Blade')
    expect(reg.detect('Makefile')?.name).toBe('Makefile')
    expect(reg.detect('run', Buffer.from('#!/usr/bin/env python3\nprint(1)\n'))?.name).toBe('Python')
    expect(reg.detect('mystery', IMG.encodePngBytes(raster(2, 2)))?.name).toBe('PNG')
  })

  it('says which line is wrong when the list is malformed', () => {
    expect(() => parseLanguagesYaml('Ok:\n  type: data\n  nonsense line\n')).toThrow(/line 3/)
    expect(() => parseLanguagesYaml('  - orphan\n')).toThrow(/line 1/)
  })

  it('reads quoted names, quotes and escapes', () => {
    const [f] = parseLanguagesYaml('Odd Name:\n  type: markup\n  extensions:\n  - ".a\\"b"\n  - \'.it\'\'s\'\n  aliases:\n  - plain\n')
    expect(f.extensions).toEqual(['.a"b', ".it's"])
    expect(f.aliases).toEqual(['plain'])
  })

  it('can be built from a file path', () => {
    expect(FormatRegistry.load().size).toBe(reg.size)
  })
})

// ---------------------------------------------------------------- pictures

/** Build a PNG by hand, filtering every row with the given filter, so the decoder meets a file it did not write. */
function handPng(w: number, h: number, ctype: number, depth: number, samples: number[], filter: number, extra: Buffer[] = []): Buffer {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype]
  const bpp = Math.max(1, (channels * depth) >> 3)
  const stride = Math.ceil((w * channels * depth) / 8)
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride)
    for (let i = 0; i < w * channels; i++) { // pack samples
      const v = samples[y * w * channels + i]
      if (depth === 16) { row[i * 2] = v >> 8; row[i * 2 + 1] = v & 255 }
      else if (depth === 8) row[i] = v
      else { const bit = i * depth; row[bit >> 3] |= v << (8 - depth - (bit & 7)) }
    }
    rows.push(row)
  }
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[y][x - bpp] : 0, b = y > 0 ? rows[y - 1][x] : 0, c = x >= bpp && y > 0 ? rows[y - 1][x - bpp] : 0
      let pred = 0
      if (filter === 1) pred = a; else if (filter === 2) pred = b; else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      raw[y * (stride + 1) + 1 + x] = (rows[y][x] - pred) & 255
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const o = Buffer.alloc(12 + data.length)
    o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8)
    o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length)
    return o
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ctype
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra.map((e) => e), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

describe('pictures', () => {
  it('round-trips PNG, PPM, BMP, SVG and the text twin without changing a pixel', () => {
    const img = raster(13, 9)
    expect(sameRaster(IMG.decodePng(IMG.encodePngBytes(img)), img)).toBe(true)
    expect(sameRaster(IMG.decodePnm(IMG.encodePnm(img, 'PPM')), img)).toBe(true)
    expect(sameRaster(IMG.decodeBmp(IMG.encodeBmp(img)), img)).toBe(true)
    expect(sameRaster(IMG.decodeSvg(IMG.encodeSvg(img)), img)).toBe(true)
    expect(sameRaster(IMG.decodeTwin(IMG.encodeTwin(img, true)), img)).toBe(true)
  })

  it('reads a PNG written with each of the five filters', () => {
    const w = 5, h = 4
    const samples = Array.from({ length: w * h * 3 }, (_, i) => (i * 37 + 5) % 256)
    const want: IMG.Raster = { width: w, height: h, rgb: Uint8Array.from(samples) }
    for (const f of [0, 1, 2, 3, 4]) expect(sameRaster(IMG.decodePng(handPng(w, h, 2, 8, samples, f)), want), `filter ${f}`).toBe(true)
  })

  it('reads grey, palette, grey+alpha, RGBA and 16-bit PNGs', () => {
    const grey = IMG.decodePng(handPng(3, 1, 0, 8, [0, 128, 255], 1))
    expect(Array.from(grey.rgb)).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255])
    const bits = IMG.decodePng(handPng(8, 1, 0, 1, [1, 0, 1, 0, 1, 1, 0, 0], 0))
    expect(Array.from(bits.rgb.filter((_, i) => i % 3 === 0))).toEqual([255, 0, 255, 0, 255, 255, 0, 0])
    const plte = Buffer.alloc(12 + 6); plte.writeUInt32BE(6, 0); plte.write('PLTE', 4, 'latin1'); Buffer.from([255, 0, 0, 0, 0, 255]).copy(plte, 8)
    plte.writeUInt32BE(crc32(plte.subarray(4, 14)), 14)
    const pal = IMG.decodePng(handPng(2, 1, 3, 8, [1, 0], 0, [plte]))
    expect(Array.from(pal.rgb)).toEqual([0, 0, 255, 255, 0, 0])
    const alpha = IMG.decodePng(handPng(2, 1, 4, 8, [0, 0, 0, 255], 2)) // black fully transparent, black opaque
    expect(Array.from(alpha.rgb)).toEqual([255, 255, 255, 0, 0, 0])
    expect(alpha.flattened).toBe(true)
    const rgba = IMG.decodePng(handPng(1, 1, 6, 8, [200, 100, 50, 255], 3))
    expect(Array.from(rgba.rgb)).toEqual([200, 100, 50])
    const wide = IMG.decodePng(handPng(1, 1, 2, 16, [0xffff, 0x8000, 0x0000], 0))
    expect(Array.from(wide.rgb)).toEqual([255, 128, 0])
  })

  it('refuses a damaged or oversized PNG instead of guessing', () => {
    expect(() => IMG.decodePng(Buffer.from('not a png at all'))).toThrow(/signature/)
    const big = handPng(1, 1, 2, 8, [1, 2, 3], 0)
    big.writeUInt32BE(100000, 16) // claims 100000 x 1: under the pixel limit, but the data is not there
    expect(() => IMG.decodePng(big)).toThrow(/not enough picture data/)
    big.writeUInt32BE(100000, 20) // claims 100000 x 100000: over the limit, refused before anything is allocated
    expect(() => IMG.decodePng(big)).toThrow(/limit/)
  })

  it('reads plain and binary Netpbm, with comments, and writes grey and black-and-white', () => {
    const p3 = IMG.decodePnm(Buffer.from('P3\n# a comment\n2 1\n255\n255 0 0  0 0 255\n'))
    expect(Array.from(p3.rgb)).toEqual([255, 0, 0, 0, 0, 255])
    const p1 = IMG.decodePnm(Buffer.from('P1\n4 1\n0101\n'))
    expect(Array.from(p1.rgb.filter((_, i) => i % 3 === 0))).toEqual([255, 0, 255, 0])
    const img = raster(9, 3)
    const pbm = IMG.decodePnm(IMG.encodePnm(img, 'PBM'))
    expect(pbm.width).toBe(9)
    expect(Array.from(IMG.decodePnm(IMG.encodePnm(img, 'PGM')).rgb).every((v, i, a) => i % 3 !== 0 || (v === a[i + 1] && v === a[i + 2]))).toBe(true)
    expect(() => IMG.decodePnm(Buffer.from('P6\n2 2\n255\nshort'))).toThrow(/shorter/)
  })

  it('reads rectangles, circles and ellipses of an SVG, and refuses what it cannot draw', () => {
    const svg = '<svg width="6" height="4"><rect width="6" height="4" fill="#ffffff"/><rect x="1" y="1" width="2" height="2" fill="red"/></svg>'
    const r = IMG.decodeSvg(Buffer.from(svg))
    expect(Array.from(r.rgb.subarray((1 * 6 + 1) * 3, (1 * 6 + 1) * 3 + 3))).toEqual([255, 0, 0])
    expect(Array.from(r.rgb.subarray(0, 3))).toEqual([255, 255, 255])
    const c = IMG.decodeSvg(Buffer.from('<svg width="9" height="9"><circle cx="4.5" cy="4.5" r="3" fill="#000"/></svg>'))
    expect(Array.from(c.rgb.subarray((4 * 9 + 4) * 3, (4 * 9 + 4) * 3 + 3))).toEqual([0, 0, 0])
    expect(() => IMG.decodeSvg(Buffer.from('<svg width="4" height="4"><path d="M0 0L4 4"/></svg>'))).toThrow(/rasteriser/)
    expect(() => IMG.decodeSvg(Buffer.from('<svg width="4" height="4"><rect width="2" height="2" transform="rotate(5)"/></svg>'))).toThrow(/transform/)
  })

  it('the text twin keeps colour exactly, and the plain art keeps only brightness', () => {
    const img = raster(6, 3)
    const twin = IMG.encodeTwin(img, true)
    expect(twin.startsWith('TWIN 1 6 3\n')).toBe(true)
    expect(sameRaster(IMG.decodeTwin(twin), img)).toBe(true)
    const art = IMG.decodeTwin(IMG.encodeTwin(img, false))
    expect(sameRaster(art, img)).toBe(false)
    expect(IMG.encodeTwin(IMG.shrink(raster(300, 10), 100), false).split('\n')[0]).toBe('TWIN 1 100 4')
    expect(() => IMG.decodeTwin('TWIN 1 3 1\nab\n')).toThrow(/does not match/)
  })

  it('draws text in stroke letters and reads it back exactly', () => {
    const text = 'Hello, World!\nline two  {x: [1, 2]}\n~`|\\ "q" \'z\' <a> 100%'
    const pic = IMG.textToImage(text)
    expect(pic.lossy).toBe(false)
    expect(IMG.imageToText(pic.raster)).toBe(text)
    expect(IMG.lettersOf(pic.raster)).toBe(text + '\n')
  })

  it('says so when the text cannot be drawn exactly', () => {
    expect(IMG.textToImage('café').lossy).toBe(true)
    expect(IMG.textToImage('x'.repeat(100)).lossy).toBe(true)
  })

  it('only treats a picture as letters when every cell is exactly a letter', () => {
    expect(IMG.lettersOf(raster(32, 40))).toBeNull() // noise
    expect(IMG.lettersOf({ width: 32, height: 40, rgb: new Uint8Array(32 * 40 * 3).fill(255) })).toBeNull() // blank
    expect(IMG.lettersOf(raster(10, 10))).toBeNull() // wrong size
    const pic = IMG.textToImage('ab').raster
    pic.rgb[(5 * pic.width + 5) * 3] ^= 255 // flip one pixel
    expect(IMG.lettersOf(pic)).toBeNull()
  })

  it('turns a picture into x,y,r,g,b rows and back', () => {
    const img = raster(4, 3)
    const rows = IMG.rasterToRows(img)
    expect(rows).toHaveLength(12)
    expect(sameRaster(IMG.rowsToRaster(['x', 'y', 'r', 'g', 'b'], rows)!, img)).toBe(true)
    expect(IMG.rowsToRaster(['a', 'b'], rows)).toBeNull()
  })
})

// ---------------------------------------------------------------- tables and trees

describe('tables', () => {
  it('reads and writes CSV with quotes, commas, doubled quotes and newlines inside a field', () => {
    const text = 'a,b,c\n1,"x, y","say ""hi"""\n"two\nlines",,3\n'
    const t = DATA.parseDelimited(text)
    expect(t.header).toEqual(['a', 'b', 'c'])
    expect(t.rows[0]).toEqual(['1', 'x, y', 'say "hi"'])
    expect(t.rows[1]).toEqual(['two\nlines', '', '3'])
    expect(DATA.parseDelimited(DATA.writeDelimited(t))).toEqual(t)
    expect(() => DATA.parseDelimited('a,b\n"open')).toThrow(/never closed/)
  })

  it('reads CRLF files and ignores blank lines in a table with several columns', () => {
    expect(DATA.parseDelimited('a,b\r\n1,2\r\n\r\n3,4\r\n').rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('round-trips Markdown, HTML and SQL tables, including awkward cells', () => {
    const t: DATA.Table = { header: ['name', 'note'], rows: [['a|b', 'x\ny'], ["it's", '<b> & "q"'], ['', '12']] }
    expect(DATA.readMarkdownTable(DATA.writeMarkdownTable(t))).toEqual(t)
    expect(DATA.readHtmlTable(DATA.writeHtmlTable(t))).toEqual(t)
    expect(DATA.readSqlInserts(DATA.writeSqlInserts(t, 'my "table"'))).toEqual(t)
    expect(DATA.readSqlInserts('SELECT 1;')).toBeNull()
  })

  it('turns records into a table and back, changing only values that print back exactly', () => {
    const tree = DATA.tableToTree({ header: ['id', 'ok', 'zip', 'name'], rows: [['1', 'true', '01234', 'x'], ['2.5', 'false', '9', '']] })
    expect(tree).toEqual([{ id: 1, ok: true, zip: '01234', name: 'x' }, { id: 2.5, ok: false, zip: 9, name: '' }])
    const back = DATA.treeToTable(tree as DATA.Json)
    expect(back.table.header).toEqual(['id', 'ok', 'zip', 'name'])
    expect(DATA.treeToTable({ a: { b: [1, 2] } }).table.rows).toEqual([['a.b[0]', '1'], ['a.b[1]', '2']])
  })
})

describe('trees', () => {
  const strs = ['hello', 'hello world', '', '  pad ', 'a: b', '# not comment', 'line\nbreak', 'quote"s', "it's", 'true', 'null', '123', '1.50', '-', '[x]', '{y}', 'ünï©ode 🙂', 'tab\there', 'a,b', 'x = y', '<tag>&amp;', 'back\\slash', '- dash', '2024-01-01', 'yes', '~', 'a #b']
  const keys = ['a', 'b', 'name', 'with space', 'k-1', 'ünï', 'a:b', 'q"r', 'x_y']
  function gen(r: () => number, depth: number, nulls: boolean): DATA.Json {
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]
    const x = r()
    if (depth > 3 || x < 0.45) {
      const t = r()
      if (t < 0.3) return pick(strs)
      if (t < 0.5) return Math.floor(r() * 2000 - 1000)
      if (t < 0.6) return Math.round(r() * 1e4) / 100
      if (t < 0.75) return r() < 0.5
      if (nulls && t < 0.8) return null
      return pick(strs)
    }
    if (x < 0.72) return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, depth + 1, nulls))
    const o: { [k: string]: DATA.Json } = {}
    for (let i = Math.floor(r() * 4); i > 0; i--) o[pick(keys)] = gen(r, depth + 1, nulls)
    return o
  }

  it('JSON and YAML hold any tree: null, empty containers, multi-line and awkward strings', () => {
    const r = rng(12345)
    for (let n = 0; n < 600; n++) {
      const v = gen(r, 0, true)
      expect(DATA.parseYaml(DATA.writeYaml(v)), JSON.stringify(v)).toEqual(v)
    }
  })

  it('TOML, XML and INI hold a tree when the format can represent it', () => {
    const r = rng(777)
    for (let n = 0; n < 600; n++) {
      let v = gen(r, 0, false)
      if (typeof v !== 'object' || Array.isArray(v) || v === null) v = { top: v }
      expect(DATA.parseToml(DATA.writeToml(v)), 'toml ' + JSON.stringify(v)).toEqual(v)
      expect(DATA.parseXml(DATA.writeXml(v)), 'xml ' + JSON.stringify(v)).toEqual(v)
      expect(DATA.parseIni(DATA.writeIni(v)), 'ini ' + JSON.stringify(v)).toEqual(v)
    }
  })

  it('reads YAML written by hand: comments, flow lists, block scalars, nested lists of maps', () => {
    const v = DATA.parseYaml(`# config
name: demo   # trailing comment
tags: [a, "b c", 3]
inline: {x: 1, y: [true, null]}
text: |
  line one
  line two
folded: >-
  one
  two
items:
  - id: 1
    sub:
      - p
      - q
  - id: 2
empty:
`)
    expect(v).toEqual({ name: 'demo', tags: ['a', 'b c', 3], inline: { x: 1, y: [true, null] }, text: 'line one\nline two\n', folded: 'one two', items: [{ id: 1, sub: ['p', 'q'] }, { id: 2 }], empty: null })
  })

  it('reads TOML written by hand: tables, arrays of tables, dotted keys, inline tables', () => {
    const v = DATA.parseToml(`title = "x" # note
n = 1_000
pi = 3.14
on = true
list = [1, 2,
  3]
[owner]
name = 'Tom'
dob = 1979-05-27T07:32:00Z
[[products]]
name = "a"
[[products]]
name = "b"
point = { x = 1, y = 2 }
a.b.c = 5
`)
    expect(v).toEqual({ title: 'x', n: 1000, pi: 3.14, on: true, list: [1, 2, 3], owner: { name: 'Tom', dob: '1979-05-27T07:32:00Z' }, products: [{ name: 'a' }, { name: 'b', point: { x: 1, y: 2 }, a: { b: { c: 5 } } }] })
  })

  it('reads XML written by hand, with attributes, repeats, CDATA and entities', () => {
    const v = DATA.parseXml('<?xml version="1.0"?><!-- c --><lib id="7"><book>A &amp; B</book><book><![CDATA[<raw>]]></book><n/></lib>')
    expect(v).toEqual({ lib: { '@id': '7', book: ['A & B', '<raw>'], n: '' } })
  })

  it('says what it cannot read, with a place, and does not guess', () => {
    expect(() => DATA.parseYaml('a: 1\n   b: 2\n')).toThrow(/YAML/)
    expect(() => DATA.parseToml('a = """x"""')).toThrow(/multi-line/)
    expect(() => DATA.parseXml('<a><b></a>')).toThrow(/XML/)
    expect(() => DATA.parseIni('no equals here')).toThrow(/line 1/)
  })
})

// ---------------------------------------------------------------- bytes, wrappers and programs

describe('bytes as text and inside pictures', () => {
  const bytes = Uint8Array.from([0, 255, 10, 13, 0, 26, 128, ...Array.from({ length: 150 }, (_, i) => (i * 91 + 7) & 255)])
  it('hex, base64 and bit strings round-trip', () => {
    for (const [w, r] of [[CODE.writeHexDump, CODE.readHexDump], [CODE.writeBase64, CODE.readBase64], [CODE.writeBitString, CODE.readBitString]] as const) {
      expect(Buffer.compare(Buffer.from(r(w(bytes))), Buffer.from(bytes))).toBe(0)
    }
    expect(() => CODE.readHexDump('xyz')).toThrow(/hexadecimal/)
    expect(() => CODE.readBitString('0102')).toThrow(/0 and 1/)
  })
  it('packs bytes into pixels and gets them back, and ignores pictures that carry nothing', () => {
    const pic = CODE.packBytesAsRaster(bytes)
    expect(Buffer.compare(Buffer.from(CODE.unpackBytesFromRaster(pic)!), Buffer.from(bytes))).toBe(0)
    expect(CODE.unpackBytesFromRaster(raster(5, 5))).toBeNull()
  })
  it('every language in the comment table is a real registry name, and the program languages are too', () => {
    for (const n of [...CODE.COMMENT_LANGUAGES, ...CODE.PROGRAM_LANGUAGES]) expect(formats().get(n)?.name, n).toBe(n)
    expect(CODE.commentMark('Haskell')).toBe('--')
    expect(CODE.commentMark('No Such Language')).toBeNull()
  })
  it('wraps and unwraps in every kind of language, and rejects a truncated wrapper', () => {
    for (const lang of ['Python', 'Haskell', 'Brainfuck', 'SQL', 'Batchfile', 'Text']) {
      const w = CODE.wrapBytes(bytes, 'PNG', lang)
      const back = CODE.unwrapBytes(w.text)!
      expect(Buffer.compare(Buffer.from(back.bytes), Buffer.from(bytes)), lang).toBe(0)
      expect(back.src).toBe('PNG')
    }
    expect(CODE.wrapBytes(bytes, 'X', 'Python').kind).toBe('program')
    expect(CODE.wrapBytes(bytes, 'X', 'Haskell').kind).toBe('comment')
    expect(CODE.wrapBytes(bytes, 'X', 'Brainfuck').kind).toBe('plain')
    expect(CODE.unwrapBytes('just text')).toBeNull()
    const cut = CODE.wrapBytes(bytes, 'X', 'Python').text.split('\n').filter((l, i) => i !== 5).join('\n')
    expect(() => CODE.unwrapBytes(cut)).toThrow(/bytes/)
    expect(CODE.unwrapBytes(CODE.wrapBytes(new Uint8Array(0), 'X', 'Python').text)!.bytes).toHaveLength(0)
  })
})

describe('programs the converter writes actually run', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fmt-run-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const have = (cmd: string): boolean => spawnSync('which', [cmd]).status === 0
  const bytes = Uint8Array.from([0, 255, 10, 13, 0, 0, 26, 128, ...Array.from({ length: 150 }, (_, i) => (i * 91 + 7) & 255)])

  const runners: Array<{ lang: string; ext: string; need: string[]; run: (f: string, d: string) => ReturnType<typeof spawnSync>[] }> = [
    { lang: 'Python', ext: 'py', need: ['python3'], run: (f) => [spawnSync('python3', [f])] },
    { lang: 'JavaScript', ext: 'js', need: ['node'], run: (f) => [spawnSync('node', [f])] },
    { lang: 'C', ext: 'c', need: ['gcc'], run: (f, d) => [spawnSync('gcc', ['-Wall', '-Werror', '-o', `${d}/c.out`, f]), spawnSync(`${d}/c.out`)] },
    { lang: 'C++', ext: 'cpp', need: ['g++'], run: (f, d) => [spawnSync('g++', ['-Wall', '-Werror', '-o', `${d}/cpp.out`, f]), spawnSync(`${d}/cpp.out`)] },
    { lang: 'Java', ext: 'java', need: ['java'], run: (f) => [spawnSync('java', [f])] },
    { lang: 'Go', ext: 'go', need: ['go'], run: (f) => [spawnSync('go', ['run', f])] },
    { lang: 'Rust', ext: 'rs', need: ['rustc'], run: (f, d) => [spawnSync('rustc', ['-o', `${d}/rs.out`, f]), spawnSync(`${d}/rs.out`)] },
    { lang: 'Ruby', ext: 'rb', need: ['ruby'], run: (f) => [spawnSync('ruby', [f])] },
    { lang: 'Perl', ext: 'pl', need: ['perl'], run: (f) => [spawnSync('perl', [f])] },
    { lang: 'PHP', ext: 'php', need: ['php'], run: (f) => [spawnSync('php', [f])] },
  ]

  for (const r of runners) {
    it(`${r.lang}: running the program prints the original bytes`, () => {
      if (!r.need.every(have)) return // that language is not installed on this machine
      const f = path.join(dir, `prog.${r.ext}`)
      writeFileSync(f, CODE.wrapBytes(bytes, 'PNG', r.lang).text)
      const steps = r.run(f, dir)
      for (const s of steps) expect(s.status, `${r.lang}: ${String(s.stderr).slice(0, 300)}`).toBe(0)
      expect(Buffer.compare(Buffer.from(steps[steps.length - 1].stdout as Buffer), Buffer.from(bytes))).toBe(0)
    }, 120_000)
  }

  it('an image becomes a program that prints its PPM file', () => {
    if (!have('python3')) return
    const img = raster(6, 4)
    const out = convert(IMG.encodePngBytes(img), 'PNG', 'Python')
    const f = path.join(dir, 'draw.py')
    writeFileSync(f, out.bytes)
    const run = spawnSync('python3', [f])
    expect(run.status).toBe(0)
    expect(sameRaster(IMG.decodePnm(run.stdout), img)).toBe(true)
  })
})

// ---------------------------------------------------------------- conversion

describe('convert', () => {
  const img = raster(12, 8)
  const png = IMG.encodePngBytes(img)

  it('draws a picture as text, as code, as a table, as data and as SVG, and each comes back identical', () => {
    for (const mid of ['Text Twin', 'Python', 'Haskell', 'SVG', 'JSON', 'YAML', 'TOML', 'XML', 'INI', 'CSV', 'SQL', 'Markdown', 'HTML', 'Base64', 'Hex Dump', 'Bit String', 'BMP', 'PPM', 'Text', 'Java', 'Binary']) {
      const there = convert(png, 'PNG', mid)
      expect(there.bytes.length, mid).toBeGreaterThan(0)
      const back = convert(there.bytes, mid, 'PNG')
      expect(sameRaster(IMG.decodePng(back.bytes), img), `${mid}: ${back.route.join(' | ')}`).toBe(true)
    }
  })

  it('says exactly what it did, and tells the truth about loss', () => {
    expect(convert(png, 'PNG', 'BMP').fidelity).toBe('lossless')
    const grey = convert(png, 'PNG', 'PGM')
    expect(grey.fidelity).toBe('lossy')
    expect(grey.notes.join(' ')).toMatch(/grey/)
    expect(convert(png, 'PNG', 'Python').fidelity).toBe('wrapped')
    const hs = convert(png, 'PNG', 'Haskell')
    expect(hs.fidelity).toBe('wrapped')
    expect(hs.notes.join(' ')).toMatch(/not runnable/)
    const art = convert(png, 'PNG', 'Text', { textArt: 'art' })
    expect(art.fidelity).toBe('lossy')
    expect(art.text!.startsWith('TWIN 1 12 8\n')).toBe(true)
    expect(art.text!.includes('COLOUR')).toBe(false)
  })

  it('does not pretend to translate code: one language to another is carried, not rewritten', () => {
    const src = 'def add(a, b):\n    return a + b\n'
    const toJs = convert(src, 'Python', 'JavaScript')
    expect(toJs.fidelity).toBe('wrapped')
    expect(toJs.notes.join(' ')).toMatch(/not translated/)
    expect(toJs.text).toContain('NEUROCLAW-WRAP 1 src=Python')
    expect(convert(toJs.bytes, 'JavaScript', 'Python').text).toBe(src)
    const toText = convert(src, 'Python', 'Text')
    expect(toText.fidelity).toBe('relabelled')
    expect(toText.text).toBe(src)
  })

  it('converts between tables and trees', () => {
    const csv = 'name,qty\nwidget,3\ngadget,12\n'
    const json = convert(csv, 'CSV', 'JSON')
    expect(JSON.parse(json.text!)).toEqual([{ name: 'widget', qty: 3 }, { name: 'gadget', qty: 12 }])
    expect(convert(json.bytes, 'JSON', 'CSV').text).toBe(csv)
    expect(convert(csv, 'CSV', 'YAML').text).toContain('- name: widget')
    expect(convert(csv, 'CSV', 'Markdown').text).toContain('| name | qty |')
    expect(convert(csv, 'CSV', 'SQL').text).toContain('INSERT INTO "data"')
    const lossy = convert('{"a":{"b":1}}', 'JSON', 'CSV')
    expect(lossy.fidelity).toBe('lossy')
  })

  it('draws text as a picture of its letters, reads it back, and restores the original format', () => {
    const csv = 'a,b\n1,2\n3,4\n'
    const pic = convert(csv, 'CSV', 'PNG')
    expect(pic.fidelity).toBe('lossless')
    expect(IMG.decodePng(pic.bytes).width % 16).toBe(0)
    expect(convert(pic.bytes, 'PNG', 'CSV').text).toBe(csv)
    expect(convert(pic.bytes, 'PNG', 'Text').text).toBe(csv)
    const sourceCode = 'x = [1, 2]\nprint(x)\n'
    expect(convert(convert(sourceCode, 'Python', 'PNG').bytes, 'PNG', 'Python').text).toBe(sourceCode)
  })

  it('gives the original back when a file that carried another file is asked for in that format', () => {
    const orig = new TextEncoder().encode('{"k": [1, 2]}')
    const hexed = convert(orig, 'JSON', 'Hex Dump')
    expect(hexed.text!.trim()).toBe(Buffer.from(orig).toString('hex'))
    expect(Buffer.compare(Buffer.from(convert(hexed.bytes, 'Hex Dump', 'JSON').bytes), Buffer.from(orig))).toBe(0)
    const prog = convert(png, 'PNG', 'Ruby')
    expect(sameRaster(IMG.decodePnm(convert(prog.bytes, 'Ruby', 'PPM').bytes), img)).toBe(true)
  })

  it('carries bytes it cannot read as anything: raw data survives any target and comes back', () => {
    const blob = Uint8Array.from({ length: 97 }, (_, i) => (i * 131 + 17) & 255)
    for (const mid of ['PNG', 'JSON', 'CSV', 'YAML', 'XML', 'Rust', 'Haskell', 'HTML', 'Markdown', 'SQL', 'Text Twin']) {
      const there = convert(blob, 'Binary', mid)
      expect(there.fidelity, mid).toBe('wrapped')
      expect(Buffer.compare(Buffer.from(convert(there.bytes, mid, 'Binary').bytes), Buffer.from(blob)), mid).toBe(0)
    }
  })

  it('a file it cannot read as its own format is carried as bytes, with a note, not rejected', () => {
    const r = convert('this is not a PNG', 'PNG', 'Python')
    expect(r.fidelity).toBe('wrapped')
    expect(r.notes.join(' ')).toMatch(/could not read as PNG/)
    expect(convert(r.bytes, 'Python', 'PNG').text).toBe('this is not a PNG') // asking for the PNG back gives the exact bytes it was given
  })

  it('returns a same-format conversion unchanged and refuses an unknown format with suggestions', () => {
    expect(convert('x', 'Python', 'Python').route[0]).toMatch(/already/)
    expect(() => convert('x', 'Python', 'Pythn')).toThrow(/Unknown format "Pythn"/)
    expect(() => convert('x', 'Pyth', 'Python')).toThrow(/Did you mean: Python/)
  })

  it('accepts names, aliases, extensions and filenames for either side', () => {
    expect(convert('a,b\n1,2\n', '.csv', 'json').to).toBe('JSON')
    expect(convert('a,b\n1,2\n', 'csv', 'yml').to).toBe('YAML')
  })

  it('every format is reachable from every kind of source: no exception, no empty result, and what comes back is the same', () => {
    const reg = formats()
    const samples: Record<string, Uint8Array> = {
      PNG: png,
      CSV: Buffer.from('name,qty,note\nwidget,3,"has, comma"\ngadget,12,plain\n'),
      JSON: Buffer.from(JSON.stringify({ a: 1, b: [true, null, 'x'], c: { d: 'e' } }, null, 2)),
      Python: Buffer.from('def add(a, b):\n    return a + b  # sum\n\nprint(add(1, 2))\n'),
      Text: Buffer.from('Hello there.\nSecond line with é.\n'),
      Binary: Uint8Array.from({ length: 97 }, (_, i) => (i * 131 + 17) & 255),
    }
    const same = (kind: string, a: Uint8Array, b: Uint8Array): boolean => {
      if (kind === 'PNG') return sameRaster(IMG.decodePng(a), IMG.decodePng(b))
      if (kind === 'JSON') return DATA.deepEqual(JSON.parse(Buffer.from(a).toString()), JSON.parse(Buffer.from(b).toString()))
      if (kind === 'CSV') return DATA.deepEqual(DATA.parseDelimited(Buffer.from(a).toString()), DATA.parseDelimited(Buffer.from(b).toString()))
      return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
    }
    const readable = new Set(['PNG', 'PPM', 'BMP', 'SVG', 'Text Twin', 'CSV', 'TSV', 'JSON', 'YAML', 'TOML', 'XML', 'INI', 'Markdown', 'HTML', 'SQL', 'Hex Dump', 'Base64', 'Bit String', 'Binary'])
    let total = 0, checked = 0
    for (const [from, bytes] of Object.entries(samples)) {
      for (const f of reg.all()) {
        if (f.name === from) continue
        total++
        const r = convert(bytes, from, f.name)
        expect(r.bytes.length > 0 || from === 'Binary', `${from} -> ${f.name} is empty`).toBe(true)
        if ((r.fidelity === 'lossless' || r.fidelity === 'wrapped') && (r.fidelity === 'wrapped' || readable.has(f.name))) {
          checked++
          const back = convert(r.bytes, f.name, from)
          expect(same(from, back.bytes, bytes), `${from} -> ${f.name} -> ${from}: ${back.route.join(' | ')}`).toBe(true)
        }
      }
    }
    expect(total).toBe(Object.keys(samples).length * (reg.size - 1))
    expect(total).toBeGreaterThan(5000)
    expect(checked).toBeGreaterThan(3000)
  }, 120_000)

  it('counts what is covered: every ordered pair of formats has a route', () => {
    const c = coverage()
    expect(c.formats).toBe(formats().size)
    expect(c.pairs).toBe(c.formats * (c.formats - 1))
    expect(c.writes.program).toBe(CODE.PROGRAM_LANGUAGES.length)
    expect(c.native.programs).toHaveLength(11)
    expect(Object.values(c.reads).reduce((a, b) => a + b, 0)).toBe(c.formats)
    expect(Object.values(c.writes).reduce((a, b) => a + b, 0)).toBe(c.formats)
  })
})
