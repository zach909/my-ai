# Format Converter

Converts a file from any format in the list to any other, so the network can be trained on pairs like
*picture → text drawing*, *picture → code that draws it*, *table → data*, *anything → anything*.
The truth is known both ways because the program makes both sides.

- **Code**: `models && skills/core/format-convert.ts` (the router), `format-registry.ts` (the list),
  `format-image.ts`, `format-data.ts`, `format-code.ts` (the codecs).
- **The list**: `training_data/file-formats/languages.yml`, the owner's file: 845 formats with their
  extensions, filenames, aliases and interpreters. Ten pictures-and-bytes formats are added by hand
  because that list has none (PNG, PPM, PGM, PBM, BMP, Text Twin, Hex Dump, Base64, Bit String, Binary).
  855 formats, 730,170 ordered pairs, and every pair has a route.
- **No third-party code.** The list is read by a small reader written for it; PNG compression is Node's
  own `zlib`; every parser and writer is in this repo.

## Use it

```bash
node scripts/build-backend.mjs                          # once
node scripts/convert.mjs picture.png picture.twin       # picture to a text drawing (exact, with a colour plane)
node scripts/convert.mjs picture.png picture.py         # picture to a Python program that draws it
node scripts/convert.mjs data.csv data.yaml             # table to data
node scripts/convert.mjs a.png b.txt --text-art         # plain brightness art instead of the exact twin
node scripts/convert.mjs --formats svg                  # search the list
node scripts/convert.mjs --coverage                     # what is read and written for real
```

```typescript
import { convert } from "models && skills/core/format-convert.js";
const r = convert(bytesOrText, "PNG", "Python");   // names, aliases, ".ext" or filenames all work
r.bytes; r.text; r.fidelity; r.route; r.notes;
```

## How any pair works

Every file is read into one of five plain shapes, bridged to the shape the target needs, and written.

| Shape | Read from | Written as |
|---|---|---|
| picture (RGB pixels, `docs/TRAINING_CURRICULUM.md`'s raw form) | PNG (all colour types, depths and filters; not interlaced), PPM/PGM/PBM, BMP, SVG (rect, circle, ellipse), Text Twin | PNG, PPM, PGM, PBM, BMP, SVG, Text Twin |
| table | CSV, TSV, Markdown table, HTML table, SQL `INSERT`s | CSV, TSV, Markdown, HTML, SQL |
| tree | JSON, YAML, TOML, XML, INI (the common subset of each) | the same five |
| bytes | Hex Dump, Base64, Bit String, Binary (then whatever the bytes are, by their first bytes) | the same four |
| text | every other format | the text, unchanged, under the new name |

Bridges: a picture becomes a **text twin** (one character per pixel from a fixed ramp, plus a colour plane,
exactly as the curriculum specifies), a list of pixel rows, or a field of data; text becomes a **picture of its
letters** drawn with `stroke-glyphs.ts` (and `lettersOf` reads it back exactly); records become a table and back;
anything becomes bytes.

**Into a programming language** the file's exact bytes are carried in a program that, when run, writes them out.
A picture is carried as its PPM file, one hex row per 32 bytes, so the program draws the picture.
Runnable templates: Python, JavaScript, TypeScript, C, C++, Java, Go, Rust, Ruby, Perl, PHP (the tests run
each one). Of the other 558 programming formats, 103 have a known comment mark and get the same rows inside
comments; the other 455 get plain rows. Those are not programs, and the notes say so.

Every file the converter wrote starts with a `NEUROCLAW-WRAP` marker, so converting it back, or on to a third
format, starts from the original.

## What `fidelity` means

| | |
|---|---|
| `lossless` | the output was read back and gave the same thing |
| `lossy` | something was dropped or changed; `notes` says what (grey, black and white, nulls in TOML, text art, text that is not printable ASCII ...) |
| `wrapped` | the exact original is inside a container: a program, comment rows, pixels, a data field |
| `relabelled` | content copied unchanged under a new name |

Anything dropped outranks the rest. These come from checking the output, not from a table of guesses.

## What it does not do

- **It does not translate code.** Python → JavaScript carries the Python inside a JavaScript program (`wrapped`)
  or copies it (`relabelled`). Rewriting the code in the other language is the network's job, which is what
  these pairs are for.
- It does not draw arbitrary SVG (paths, transforms); it says so and carries the file as text instead.
- No interlaced PNG, no compressed BMP, no multi-line TOML strings; each says so and carries the file as bytes.
- PGM/PBM drop colour, PNG transparency is laid over white, and text pictures only hold printable ASCII,
  at most 4096 characters; all of these are reported as `lossy`.

## Training pairs

```bash
node scripts/make-conversion-pairs.mjs --out pairs.jsonl --count 5200 --seed 1
```

Makes `{ from, to, fidelity, reversible, route, notes, input, output }` per line from samples generated by rules
in the script (16×16 pictures, tables, trees, code, prose, raw bytes). Each target format takes a turn with all
six kinds of source, so `--count` of 5124 or more covers every format as a target. `reversible` is true only when
converting the output back really gave the input back. Same seed, same file. Filter with
`--fidelity lossless,wrapped`, `--kinds image,code`, `--from PNG`, `--to Python`.

Tests: `test/core/format-convert.test.ts` (reads hand-built PNGs, runs every generated program, converts six
kinds of file to all 855 formats and checks what comes back).
