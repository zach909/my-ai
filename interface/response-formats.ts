/**
 * The reply in every file format the project's own converter knows: response/formats/.
 *
 * This is the converter (models && skills/core/format-convert.ts, the list in training_data/file-formats/languages.yml,
 * 855 formats) run on the reply text, once per format. It is NOT the mesh writing those files, and the mesh has not been
 * trained to: nothing here is learned. What each file really is depends on the format, and index.json says so for every
 * one instead of letting the file name suggest more:
 *
 *   lossless    the output was read back and gave the same reply
 *   lossy       something was dropped; notes say what
 *   wrapped     the exact reply is carried inside (a program that writes it out, comment rows, pixels, a data field)
 *   relabelled  the reply copied unchanged under the new name
 *
 * Most of the 855 are programming languages, and for those the reply is carried, not translated. That is what the
 * converter does and what its wiki page (wiki/Format-Converter.md) says it does.
 *
 * Limits, so one long reply cannot make an enormous zip: a reply over MAX_REPLY_CHARS gets no format files, the formats are
 * written until FORMATS_BUDGET_BYTES is used up, and a single file over MAX_FILE_BYTES is skipped. Everything left out is
 * listed in index.json with the reason. Same reply, same files, same order.
 */

import { convert, type Fidelity } from "../models && skills/core/format-convert.js";
import { formats, type FormatInfo } from "../models && skills/core/format-registry.js";
import type { ZipEntry } from "../models && skills/core/zip-archive.js";

/// The format the reply is read as.
export const SOURCE_FORMAT = "Markdown";
export const MAX_REPLY_CHARS = 20_000;
export const FORMATS_BUDGET_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface FormatRecord {
  format: string;
  file: string;
  fidelity: Fidelity;
  bytes: number;
  notes: string[];
}

export interface FormatSkip {
  format: string;
  reason: string;
}

export interface FormatsResult {
  entries: ZipEntry[];
  written: FormatRecord[];
  skipped: FormatSkip[];
  /** How many formats the list holds, so "855 of 855" or "3 of 855" is plain. */
  total: number;
}

/** Media and data first, then markup and prose, programming languages last: if the budget runs out, the loss is the least useful ones. */
const ORDER: Record<string, number> = { media: 0, data: 1, markup: 2, prose: 3, programming: 4 };

const clean = (s: string, n: number): string => s.replace(/[^A-Za-z0-9._+-]/g, "_").replace(/^[._]+/, "").slice(0, n);

/** The name of the file for one format: `<format>.<its first extension>`, built from a strict character set. */
export function fileNameFor(f: FormatInfo): string {
  const base = clean(f.name, 48) || "format";
  const ext = clean((f.extensions[0] ?? "").replace(/^\./, ""), 24) || "txt";
  return `${base}.${ext}`;
}

export function formatEntries(reply: string): FormatsResult {
  const reg = formats();
  const list = [...reg.all()].sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));
  const result: FormatsResult = { entries: [], written: [], skipped: [], total: list.length };
  if (reply.length > MAX_REPLY_CHARS) {
    result.skipped.push({ format: "all", reason: `The reply is over ${MAX_REPLY_CHARS} characters, so it is not converted to every format.` });
    return result;
  }
  const used = new Set<string>();
  let spent = 0;
  for (const f of list) {
    if (f.name === SOURCE_FORMAT) continue; // reply.md is already this one
    if (spent >= FORMATS_BUDGET_BYTES) { result.skipped.push({ format: f.name, reason: "Size budget for format files used up." }); continue; }
    let out;
    try {
      out = convert(reply, SOURCE_FORMAT, f.name, { registry: reg });
    } catch (err) {
      result.skipped.push({ format: f.name, reason: err instanceof Error ? err.message.slice(0, 200) : "Could not convert." });
      continue;
    }
    if (out.bytes.length > MAX_FILE_BYTES) { result.skipped.push({ format: f.name, reason: `The ${f.name} file would be over ${MAX_FILE_BYTES} bytes.` }); continue; }
    let name = fileNameFor(f);
    for (let n = 2; used.has(name); n++) name = `${fileNameFor(f).replace(/\.[^.]*$/, "")}-${n}.${name.split(".").pop()}`;
    used.add(name);
    const file = `response/formats/${name}`;
    result.entries.push({ name: file, data: Buffer.from(out.bytes) });
    result.written.push({ format: f.name, file, fidelity: out.fidelity, bytes: out.bytes.length, notes: out.notes.slice(0, 5).map(n => n.slice(0, 300)) });
    spent += out.bytes.length;
  }
  return result;
}
