/**
 * Converting a file from any format in the registry to any other.
 *
 * How it works (one route for every pair, so no pair is "unsupported"):
 *
 *   1. READ the source into one of five plain shapes:
 *        image (RGB pixels) | table | tree (JSON-like) | text | bytes
 *      PNG, PPM, PGM, PBM, BMP, SVG and Text Twin read as images; CSV/TSV as tables; JSON, YAML, TOML,
 *      XML and INI as trees; Hex Dump, Base64 and Bit String as bytes (and then as whatever the bytes
 *      are); every other format as text. A file this converter wrote earlier is recognised by its
 *      marker and read as the thing it carries.
 *   2. BRIDGE to the shape the target needs (a picture to a text twin, text to a picture of its letters,
 *      a list of records to a table, anything to bytes ...).
 *   3. WRITE the target. Pictures, tables, trees, Markdown, HTML and SQL have real writers. A language
 *      with a template becomes a runnable program that writes the original bytes. Anything else gets the
 *      same bytes in comments or plain rows.
 *
 * Nothing is claimed that was not checked. `fidelity` says what really happened:
 *   lossless   read the output back and got the same thing
 *   lossy      something was dropped or changed (see `notes`)
 *   wrapped    the exact original is inside a container (a program, comment rows, pixels, a JSON field)
 *   relabelled the content was copied unchanged; the file just got a new name and type. This is NOT a
 *              translation: Python to JavaScript does not rewrite the code (that is the network's job).
 *
 * Own code. Node built-ins only.
 */
import { FormatRegistry, formats, sniff, type FormatInfo } from "./format-registry.js";
import * as IMG from "./format-image.js";
import * as DATA from "./format-data.js";
import * as CODE from "./format-code.js";
import type { Raster } from "./format-image.js";
import type { Json, Table } from "./format-data.js";

export type Fidelity = "lossless" | "lossy" | "wrapped" | "relabelled";
export type Kind = "image" | "table" | "tree" | "text" | "bytes";

export interface ConvertOptions {
  registry?: FormatRegistry;
  /** Text art only: the widest the picture may be, in characters. Default 120. */
  maxCols?: number;
  /** "twin" (default) keeps a colour plane so the picture comes back exactly; "art" is brightness only. */
  textArt?: "twin" | "art";
  /** Name of the table in SQL output. Default "data". */
  sqlTable?: string;
  /** Pictures to text formats: read the letters in the picture (it must be 16x20 letter cells) instead of drawing it in characters. */
  ocr?: boolean;
}

export interface ConvertResult {
  bytes: Uint8Array;
  /** The output as text, when it is text. */
  text?: string;
  from: string;
  to: string;
  fromKind: Kind;
  toKind: Kind;
  fidelity: Fidelity;
  /** What happened, step by step. */
  route: string[];
  /** Everything that was dropped, changed or only approximated. */
  notes: string[];
}

type Doc =
  | { kind: "image"; img: Raster }
  | { kind: "table"; table: Table }
  | { kind: "tree"; tree: Json }
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array };

interface Source { doc: Doc; origin: { format: string; bytes: Uint8Array } }

interface Ctx {
  reg: FormatRegistry;
  opts: ConvertOptions;
  route: string[];
  notes: string[];
  lossy: boolean;
  wrapped: boolean;
  relabelled: boolean;
  /** True once the file turned out to carry another file (a wrapper, packed bytes, an encoding). */
  unwrapped: boolean;
}

const IMAGE_FORMATS = new Set(["PNG", "PPM", "PGM", "PBM", "BMP", "SVG", "Text Twin"]);
const TREE_FORMATS = new Set(["JSON", "YAML", "TOML", "XML", "INI"]);
const BYTE_TEXT_FORMATS = new Set(["Hex Dump", "Base64", "Bit String"]);
/** Formats whose text must actually parse (and parse to something) before we accept that a piece of text is one. */
const PARSED_FORMATS = new Set(["CSV", "TSV", "JSON", "YAML", "TOML", "XML", "INI"]);
const MAX_DRAW_CHARS = 4096;
const MAX_TABLE_PIXELS = 250_000;

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "utf8"));

function utf8(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

const sameRaster = (a: Raster, b: Raster): boolean =>
  a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.rgb), Buffer.from(b.rgb)) === 0;

const lossy = (ctx: Ctx, why: string): void => { ctx.lossy = true; ctx.notes.push(why); };

function kindOf(d: Doc): Kind { return d.kind; }

/** Is this text really a file of that format (not just text that a forgiving parser would swallow)? */
function textFitsFormat(name: string, text: string): boolean {
  try {
    const deep = (v: Json): boolean => v !== null && typeof v === "object" && Object.keys(v).length > 0;
    if (name === "CSV" || name === "TSV") {
      const d = name === "TSV" ? "\t" : ",";
      const t = DATA.parseDelimited(text, d);
      return t.header.length >= 2 && DATA.writeDelimited(t, d).replace(/\n$/, "") === text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    }
    if (name === "JSON") return deep(JSON.parse(text) as Json);
    if (name === "YAML") return deep(DATA.parseYaml(text));
    if (name === "TOML") return deep(DATA.parseToml(text));
    if (name === "XML") { DATA.parseXml(text); return true; }
    if (name === "INI") return deep(DATA.parseIni(text));
  } catch { return false; }
  return false;
}

// ================================================================ reading

function readImage(name: string, bytes: Uint8Array): Raster {
  switch (name) {
    case "PNG": return IMG.decodePng(bytes);
    case "PPM": case "PGM": case "PBM": return IMG.decodePnm(bytes);
    case "BMP": return IMG.decodeBmp(bytes);
    case "SVG": return IMG.decodeSvg(bytes);
    default: return IMG.decodeTwin(Buffer.from(bytes).toString("utf8"));
  }
}

const imgDoc = (img: Raster, ctx: Ctx, label: string): Doc => { ctx.route.push(`read ${label} as a ${img.width}x${img.height} picture`); return { kind: "image", img }; };

/** A picture, unless its pixels are bytes this converter packed there ("NCB1"): then those bytes. */
function imageSource(img: Raster, origin: Source["origin"], ctx: Ctx, depth: number, label: string): Source {
  const packed = CODE.unpackBytesFromRaster(img);
  if (packed) {
    ctx.route.push(`the pixels of the ${label} carry ${packed.length} packed bytes (NCB1)`);
    ctx.unwrapped = true;
    return readBytes(packed, "Binary", ctx, depth + 1);
  }
  return { doc: imgDoc(img, ctx, label), origin };
}

/** A tree that is really one of our own shapes goes back to what it carries. */
function treeDoc(tree: Json, ctx: Ctx, origin: Source["origin"], depth: number): Source {
  if (tree && typeof tree === "object" && !Array.isArray(tree)) {
    const o = tree as { [k: string]: Json };
    if (o.neuroclaw_wrap === 1 && typeof o.data === "string" && typeof o.format === "string" && o.encoding === "base64") {
      const inner = Uint8Array.from(Buffer.from(o.data, "base64"));
      ctx.route.push(`unpack the bytes carried in the ${origin.format} data (they are ${o.format})`);
      ctx.unwrapped = true;
      return readBytes(inner, o.format, ctx, depth + 1);
    }
    if (o.neuroclaw_image === 1 && typeof o.width === "number" && typeof o.height === "number" && typeof o.data === "string") {
      const rgb = Uint8Array.from(Buffer.from(o.data, "base64"));
      if (rgb.length === o.width * o.height * 3) return imageSource({ width: o.width, height: o.height, rgb }, origin, ctx, depth, `picture in the ${origin.format} data`);
    }
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "text" && typeof o.text === "string") {
      ctx.route.push(`read the text field of the ${origin.format} data`);
      ctx.unwrapped = true;
      return { doc: { kind: "text", text: o.text }, origin: { format: "Text", bytes: enc(o.text) } };
    }
  }
  return { doc: { kind: "tree", tree }, origin };
}

function tableDoc(table: Table, ctx: Ctx, origin: Source["origin"], depth: number): Source {
  const px = IMG.rowsToRaster(table.header, table.rows);
  if (px) return imageSource(px, origin, ctx, depth, "pixel table");
  if (table.header.join(",") === "line,text" && table.rows.length) {
    ctx.route.push("read the line/text table as text");
    ctx.unwrapped = true;
    const text = table.rows.map((r) => r[1] ?? "").join("\n") + "\n";
    return { doc: { kind: "text", text }, origin: { format: "Text", bytes: enc(text) } };
  }
  if (table.header.join(",") === "offset,hex" && table.rows.every((r) => /^[0-9a-f]*$/.test(r[1] ?? ""))) {
    ctx.route.push("read the offset/hex table as bytes");
    ctx.unwrapped = true;
    return readBytes(Uint8Array.from(Buffer.from(table.rows.map((r) => r[1]).join(""), "hex")), "Binary", ctx, depth + 1);
  }
  return { doc: { kind: "table", table }, origin };
}

/** Raw bytes: if they are a picture we know, read the picture; if they are text, read text; else keep bytes. */
function readBytes(bytes: Uint8Array, hint: string, ctx: Ctx, depth: number): Source {
  const origin = { format: hint, bytes };
  if (depth > 4) return { doc: { kind: "bytes", bytes }, origin };
  const magic = sniff(bytes);
  const info = hint !== "Binary" ? ctx.reg.get(hint) : null;
  if (info && info.name !== "Binary") return readAs(info, bytes, ctx, depth);
  if (magic) return readAs(ctx.reg.get(magic)!, bytes, ctx, depth);
  const text = utf8(bytes);
  if (text !== null) return { doc: { kind: "text", text }, origin: { format: "Text", bytes } };
  return { doc: { kind: "bytes", bytes }, origin };
}

function readAs(info: FormatInfo, bytes: Uint8Array, ctx: Ctx, depth: number): Source {
  const origin = { format: info.name, bytes };
  const fallbackBytes = (why: string): Source => { ctx.notes.push(`could not read as ${info.name} (${why}); carried as raw bytes`); return { doc: { kind: "bytes", bytes }, origin }; };
  const name = info.name;
  try {
    if (IMAGE_FORMATS.has(name) && name !== "SVG" && name !== "Text Twin") return imageSource(readImage(name, bytes), origin, ctx, depth, name);
    if (name === "Binary") { ctx.unwrapped = true; return readBytes(bytes, "Binary", ctx, depth + 1); }
    if (BYTE_TEXT_FORMATS.has(name)) {
      const t = Buffer.from(bytes).toString("utf8");
      const raw = name === "Hex Dump" ? CODE.readHexDump(t) : name === "Base64" ? CODE.readBase64(t) : CODE.readBitString(t);
      ctx.route.push(`decode ${name} to ${raw.length} bytes`);
      ctx.unwrapped = true;
      return readBytes(raw, "Binary", ctx, depth + 1);
    }
  } catch (e) { return fallbackBytes((e as Error).message); }

  const text = utf8(bytes);
  if (text === null) return fallbackBytes("not text");
  const marker = CODE.unwrapBytes(text);
  if (marker) {
    ctx.route.push(`unwrap ${marker.bytes.length} bytes of ${marker.src} from the ${name} file`);
    ctx.unwrapped = true;
    return readBytes(marker.bytes, marker.src, ctx, depth + 1);
  }
  try {
    if (/^TWIN 1 \d+ \d+\r?\n/.test(text) && name !== "Text Twin") return imageSource(IMG.decodeTwin(text), origin, ctx, depth, `text twin in the ${name} file`);
    switch (name) {
      case "SVG": return imageSource(IMG.decodeSvg(bytes), origin, ctx, depth, "SVG");
      case "Text Twin": return imageSource(IMG.decodeTwin(text), origin, ctx, depth, "Text Twin");
      case "CSV": return tableDoc(DATA.parseDelimited(text, ","), ctx, origin, depth);
      case "TSV": return tableDoc(DATA.parseDelimited(text, "\t"), ctx, origin, depth);
      case "JSON": return treeDoc(JSON.parse(text) as Json, ctx, origin, depth);
      case "YAML": return treeDoc(DATA.parseYaml(text), ctx, origin, depth);
      case "TOML": return treeDoc(DATA.parseToml(text), ctx, origin, depth);
      case "XML": return treeDoc(DATA.parseXml(text), ctx, origin, depth);
      case "INI": return treeDoc(DATA.parseIni(text), ctx, origin, depth);
      case "SQL": { const t = DATA.readSqlInserts(text); if (t) { ctx.route.push("read the SQL INSERT statements as a table"); return tableDoc(t, ctx, origin, depth); } break; }
      case "Markdown": {
        const fence = /```twin\n([\s\S]*?)```/.exec(text);
        if (fence) return imageSource(IMG.decodeTwin(fence[1]), origin, ctx, depth, "twin in the Markdown");
        const t = DATA.readMarkdownTable(text);
        if (t) { ctx.route.push("read the Markdown table"); return tableDoc(t, ctx, origin, depth); }
        const js = /^```json\n([\s\S]*)\n```\s*$/.exec(text);
        if (js) { ctx.route.push("read the JSON in the Markdown fence"); return treeDoc(JSON.parse(js[1]) as Json, ctx, origin, depth); }
        break;
      }
      case "HTML": {
        const svg = /<svg\b[\s\S]*<\/svg>/i.exec(text);
        if (svg && !/<table\b/i.test(text)) return imageSource(IMG.decodeSvg(enc(svg[0])), origin, ctx, depth, "SVG in the HTML");
        if (/<table\b/i.test(text)) { const t = DATA.readHtmlTable(text); if (t) { ctx.route.push("read the HTML table"); return tableDoc(t, ctx, origin, depth); } }
        const pre = /<!-- neuroclaw-text -->\s*<pre>\n([\s\S]*)<\/pre>/.exec(text);
        if (pre) return { doc: { kind: "text", text: pre[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&") }, origin };
        break;
      }
    }
  } catch (e) {
    ctx.notes.push(`could not read as ${name} (${(e as Error).message}); read as plain text`);
  }
  ctx.route.push(`read ${name} as text`);
  return { doc: { kind: "text", text }, origin };
}

// ================================================================ bridging

function textOfSource(src: Source): string | null {
  return utf8(src.origin.bytes);
}

function toImage(src: Source, ctx: Ctx): Raster {
  const d = src.doc;
  if (d.kind === "image") return d.img;
  if (d.kind === "bytes") { ctx.wrapped = true; ctx.route.push("pack the bytes into the pixels (NCB1 header, length, bytes)"); return CODE.packBytesAsRaster(d.bytes); }
  let text: string;
  if (d.kind === "text") text = d.text;
  else if (d.kind === "table") text = DATA.writeDelimited(d.table);
  else text = JSON.stringify(d.tree, null, 2) + "\n";
  if (d.kind !== "text") ctx.route.push(`write the ${d.kind} out as ${d.kind === "table" ? "CSV" : "JSON"} text first`);
  let drawn = text;
  if (drawn.length > MAX_DRAW_CHARS) { drawn = drawn.slice(0, MAX_DRAW_CHARS); lossy(ctx, `only the first ${MAX_DRAW_CHARS} characters were drawn`); }
  const pic = IMG.textToImage(drawn);
  if (pic.lossy) lossy(ctx, "characters that are not printable ASCII were drawn as '?', and long lines were wrapped");
  ctx.route.push(`draw the text in stroke letters (${pic.raster.width}x${pic.raster.height})`);
  if (/[ \t]$/m.test(drawn) || /\n\n+$/.test(drawn)) lossy(ctx, "trailing spaces and blank lines at the end cannot be seen in a picture");
  const back = IMG.imageToText(pic.raster);
  const expected = drawn.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n").map((l) => l.replace(/ +$/, "")).join("\n").replace(/\n+$/, "");
  if (!ctx.lossy && back !== expected) lossy(ctx, "reading the letters back did not give the same text");
  return pic.raster;
}

function toTable(src: Source, ctx: Ctx): Table {
  const d = src.doc;
  if (d.kind === "table") return d.table;
  if (d.kind === "tree") {
    const r = DATA.treeToTable(d.tree);
    ctx.route.push("turn the tree into a table");
    if (r.lossy) lossy(ctx, "tree to table: nested values became JSON text and types became strings");
    return r.table;
  }
  if (d.kind === "text") { ctx.route.push("split the text into line/text rows"); return { header: ["line", "text"], rows: d.text.replace(/\n$/, "").split("\n").map((l, i) => [String(i + 1), l]) }; }
  const bytes = d.kind === "bytes" ? d.bytes : IMG.encodePnm(d.img, "PPM");
  if (d.kind === "image" && d.img.width * d.img.height <= MAX_TABLE_PIXELS) { ctx.route.push("list every pixel as an x,y,r,g,b row"); return { header: ["x", "y", "r", "g", "b"], rows: IMG.rasterToRows(d.img) }; }
  ctx.wrapped = true;
  ctx.route.push(d.kind === "image" ? "picture too big to list per pixel: carry its PPM bytes as offset/hex rows" : "carry the bytes as offset/hex rows");
  const rows: string[][] = [];
  for (let o = 0; o < bytes.length; o += 16) rows.push([String(o), Buffer.from(bytes.subarray(o, o + 16)).toString("hex")]);
  return { header: ["offset", "hex"], rows };
}

function toTree(src: Source, ctx: Ctx): Json {
  const d = src.doc;
  if (d.kind === "tree") return d.tree;
  if (d.kind === "table") { ctx.route.push("turn the table into a list of records"); return DATA.tableToTree(d.table); }
  if (d.kind === "text") { ctx.route.push('put the text in a {"text": ...} field'); return { text: d.text }; }
  if (d.kind === "image") { ctx.route.push("put the pixels in a base64 field"); return { neuroclaw_image: 1, width: d.img.width, height: d.img.height, encoding: "rgb-base64", data: Buffer.from(d.img.rgb).toString("base64") }; }
  ctx.wrapped = true;
  ctx.route.push("put the bytes in a base64 field");
  return { neuroclaw_wrap: 1, format: src.origin.format, encoding: "base64", data: Buffer.from(d.bytes).toString("base64") };
}

/** The bytes to carry inside a program or a comment: a picture is carried as its PPM file (pixel rows), anything else as the original file. */
function payload(src: Source): { bytes: Uint8Array; format: string } {
  if (src.doc.kind === "image" && src.origin.format !== "PPM") return { bytes: IMG.encodePnm(src.doc.img, "PPM"), format: "PPM" };
  return { bytes: src.origin.bytes, format: src.origin.format };
}

// ================================================================ writing

function writeImageTarget(name: string, src: Source, ctx: Ctx): Uint8Array {
  const img = toImage(src, ctx);
  if (img.flattened) lossy(ctx, "transparency was laid over white");
  let out: Uint8Array;
  switch (name) {
    case "PNG": out = IMG.encodePngBytes(img); break;
    case "PPM": case "PGM": case "PBM": out = IMG.encodePnm(img, name); break;
    case "BMP": out = IMG.encodeBmp(img); break;
    case "SVG": out = IMG.encodeSvg(img); break;
    default: out = enc(IMG.encodeTwin(img, true));
  }
  ctx.route.push(`write ${name}`);
  try { if (!sameRaster(readImage(name, out), img)) lossy(ctx, name === "PGM" ? "colour was reduced to grey" : name === "PBM" ? "reduced to black and white" : `${name} cannot hold this picture exactly`); }
  catch (e) { lossy(ctx, `could not read the ${name} back to check it (${(e as Error).message})`); }
  return out;
}

function writeTableTarget(name: string, src: Source, ctx: Ctx): Uint8Array {
  const t = toTable(src, ctx);
  const out = enc(DATA.writeDelimited(t, name === "TSV" ? "\t" : ","));
  ctx.route.push(`write ${name}`);
  const back = DATA.parseDelimited(Buffer.from(out).toString("utf8"), name === "TSV" ? "\t" : ",");
  if (!DATA.deepEqual(back, t)) lossy(ctx, `${name} cannot hold this table exactly (blank lines, or a table with no header)`);
  return out;
}

function writeTreeTarget(name: string, src: Source, ctx: Ctx): Uint8Array {
  const v = toTree(src, ctx);
  let text: string, back: Json | undefined;
  switch (name) {
    case "JSON": text = JSON.stringify(v, null, 2) + "\n"; back = JSON.parse(text) as Json; break;
    case "YAML": text = DATA.writeYaml(v); back = DATA.parseYaml(text); break;
    case "TOML": text = DATA.writeToml(v); back = DATA.parseToml(text); break;
    case "XML": text = DATA.writeXml(v); back = DATA.parseXml(text); break;
    default: text = DATA.writeIni(v); back = DATA.parseIni(text);
  }
  ctx.route.push(`write ${name}`);
  if (!DATA.deepEqual(back, v)) {
    const why = name === "TOML" ? "TOML needs a table at the top and has no null, so those were reshaped or left out" : name === "INI" ? "INI is flat: nested values were joined with dots and types were guessed back" : `${name} cannot hold this exactly`;
    lossy(ctx, why);
  }
  return enc(text);
}

function writeMarkdown(src: Source, ctx: Ctx): Uint8Array {
  const d = src.doc;
  ctx.route.push("write Markdown");
  if (d.kind === "table") return enc(DATA.writeMarkdownTable(d.table));
  if (d.kind === "tree") return enc("```json\n" + JSON.stringify(d.tree, null, 2) + "\n```\n");
  if (d.kind === "image") return enc("```twin\n" + IMG.encodeTwin(d.img, true) + "```\n");
  if (d.kind === "text") { ctx.relabelled = true; return enc(d.text); }
  ctx.wrapped = true;
  return enc("```\n" + CODE.wrapBytes(src.origin.bytes, src.origin.format, "Text").text + "```\n");
}

function writeHtml(src: Source, ctx: Ctx): Uint8Array {
  const d = src.doc;
  const wrap = (inner: string): Uint8Array => enc(`<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n${inner}</body></html>\n`);
  ctx.route.push("write HTML");
  if (d.kind === "table") return wrap(DATA.writeHtmlTable(d.table));
  if (d.kind === "image") return wrap(Buffer.from(IMG.encodeSvg(d.img)).toString("utf8"));
  const text = d.kind === "text" ? d.text : d.kind === "tree" ? JSON.stringify(d.tree, null, 2) + "\n" : CODE.wrapBytes(src.origin.bytes, src.origin.format, "Text").text;
  if (d.kind === "bytes") ctx.wrapped = true; else if (d.kind === "text") ctx.relabelled = true; else lossy(ctx, "a tree is shown as JSON text inside <pre>");
  return wrap(`<!-- neuroclaw-text -->\n<pre>\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</pre>\n`);
}

function writeProgramTarget(info: FormatInfo, src: Source, ctx: Ctx): Uint8Array {
  if (src.doc.kind === "text" && src.origin.format === "Text") { // plain text with no language of its own: it is the code, just named
    ctx.relabelled = true;
    ctx.route.push(`write ${info.name}`);
    ctx.notes.push(`plain text taken as ${info.name} unchanged; nothing was translated`);
    return enc(src.doc.text);
  }
  const p = payload(src);
  const w = CODE.wrapBytes(p.bytes, p.format, info.name);
  ctx.wrapped = true;
  if (w.kind === "program") ctx.route.push(`write a ${info.name} program that prints the ${p.format === "PPM" && src.doc.kind === "image" ? "picture as a PPM file (one hex row per 32 bytes)" : `original ${p.format} bytes`}`);
  else if (w.kind === "comment") { ctx.route.push(`write the ${p.format} bytes as hex rows in ${info.name} comments`); ctx.notes.push(`no program template for ${info.name}: the bytes are in comments and the file is not runnable`); }
  else { ctx.route.push(`write the ${p.format} bytes as plain hex rows`); ctx.notes.push(`no program template or comment mark for ${info.name}: plain rows, not runnable`); }
  if (src.doc.kind === "text" && p.format !== "Text") ctx.notes.push(`the ${p.format} source is carried unchanged, not translated to ${info.name}`);
  else if (src.doc.kind === "text") ctx.notes.push(`the text is carried unchanged, not translated to ${info.name}`);
  const back = CODE.unwrapBytes(w.text);
  if (!back || Buffer.compare(Buffer.from(back.bytes), Buffer.from(p.bytes)) !== 0) lossy(ctx, "the wrapped bytes did not read back identically");
  return enc(w.text);
}

function writeGenericText(info: FormatInfo, src: Source, ctx: Ctx): Uint8Array {
  const d = src.doc;
  const originText = d.kind === "image" && src.origin.format !== "SVG" && src.origin.format !== "Text Twin" ? null : textOfSource(src);
  ctx.route.push(`write ${info.name}`);
  if (d.kind === "image" && ctx.opts.ocr) {
    try { const t = IMG.imageToText(d.img); ctx.route.push("read the letters out of the picture"); lossy(ctx, "letters were read from the picture; trailing spaces are dropped and a misread letter would not be reported"); return enc(t + "\n"); }
    catch (e) { ctx.notes.push(`could not read letters (${(e as Error).message}); drew the picture in characters instead`); }
  }
  if (originText !== null && d.kind !== "bytes") {
    ctx.relabelled = true;
    if (info.name !== src.origin.format) ctx.notes.push(`content copied unchanged from ${src.origin.format}; nothing was translated`);
    return enc(originText);
  }
  if (d.kind === "image") {
    if (ctx.opts.textArt === "art") {
      const small = IMG.shrink(d.img, ctx.opts.maxCols ?? 120);
      lossy(ctx, small === d.img ? "text art keeps brightness only, not colour" : `shrunk to ${small.width} columns and brightness only`);
      ctx.route.push("draw the picture as text art (one character per pixel, brightness only)");
      return enc(IMG.encodeTwin(small, false));
    }
    ctx.route.push("draw the picture as a text twin (one character per pixel + a colour plane)");
    return enc(IMG.encodeTwin(d.img, true));
  }
  const w = CODE.wrapBytes(src.origin.bytes, src.origin.format, info.name);
  ctx.wrapped = true;
  ctx.route.push(`carry the ${src.origin.format} bytes as ${w.kind === "comment" ? "hex rows in comments" : "plain hex rows"}`);
  return enc(w.text);
}

function writeByteTextTarget(name: string, src: Source, ctx: Ctx): Uint8Array {
  const bytes = src.origin.bytes;
  ctx.route.push(`encode the ${bytes.length} bytes of the original ${src.origin.format} file as ${name}`);
  return enc(name === "Hex Dump" ? CODE.writeHexDump(bytes) : name === "Base64" ? CODE.writeBase64(bytes) : CODE.writeBitString(bytes));
}

/** For targets that are not pictures: a picture that is exactly a drawing of text in our letters is that text. */
function effective(src: Source, ctx: Ctx): Source {
  if (src.doc.kind !== "image") return src;
  const t = IMG.lettersOf(src.doc.img);
  if (t === null) return src;
  ctx.route.push("the picture is exactly a drawing of text in the stroke letters: read the text");
  ctx.unwrapped = true;
  return { doc: { kind: "text", text: t }, origin: { format: "Text", bytes: enc(t) } };
}

function writeTarget(info: FormatInfo, src: Source, ctx: Ctx): Uint8Array {
  const name = info.name;
  if (IMAGE_FORMATS.has(name)) return writeImageTarget(name, src, ctx);
  if (name === "CSV" || name === "TSV") return writeTableTarget(name, src, ctx);
  if (TREE_FORMATS.has(name)) return writeTreeTarget(name, src, ctx);
  if (BYTE_TEXT_FORMATS.has(name)) return writeByteTextTarget(name, src, ctx);
  if (name === "Binary") { ctx.route.push("write the original bytes"); return src.origin.bytes; }
  if (name === "Markdown") return writeMarkdown(src, ctx);
  if (name === "HTML") return writeHtml(src, ctx);
  if (name === "SQL") {
    const t = toTable(src, ctx);
    ctx.route.push("write SQL (CREATE TABLE and INSERT statements)");
    const sql = DATA.writeSqlInserts(t, ctx.opts.sqlTable ?? "data");
    if (!DATA.deepEqual(DATA.readSqlInserts(sql), t)) lossy(ctx, "SQL cannot hold this table exactly");
    return enc(sql);
  }
  if (info.type === "programming") return writeProgramTarget(info, src, ctx);
  return writeGenericText(info, src, ctx);
}

// ================================================================ the public function

function resolve(reg: FormatRegistry, q: string): FormatInfo {
  const f = reg.get(q);
  if (f) return f;
  const low = q.toLowerCase();
  const near = reg.all().filter((x) => x.name.toLowerCase().includes(low) || low.includes(x.name.toLowerCase())).slice(0, 5).map((x) => x.name);
  throw new Error(`Unknown format ${JSON.stringify(q)}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
}

/**
 * Convert `input` (bytes, or text) from one format to another. Formats are named by name, alias,
 * extension (".png", "py") or exact filename. Throws only for an unknown format name.
 */
export function convert(input: Uint8Array | string, from: string, to: string, opts: ConvertOptions = {}): ConvertResult {
  const reg = opts.registry ?? formats();
  const src = resolve(reg, from), dst = resolve(reg, to);
  const bytes = typeof input === "string" ? enc(input) : input;
  const ctx: Ctx = { reg, opts, route: [], notes: [], lossy: false, wrapped: false, relabelled: false, unwrapped: false };

  if (src.name === dst.name) {
    const probe = readAs(src, bytes, { ...ctx, route: [], notes: [] }, 0);
    return { bytes, text: utf8(bytes) ?? undefined, from: src.name, to: dst.name, fromKind: kindOf(probe.doc), toKind: kindOf(probe.doc), fidelity: "lossless", route: ["already in that format: returned unchanged"], notes: [] };
  }

  const source = readAs(src, bytes, ctx, 0);
  const fromKind = kindOf(source.doc);

  const wantsFile = !IMAGE_FORMATS.has(dst.name) && !BYTE_TEXT_FORMATS.has(dst.name) && dst.name !== "Binary";
  const eff = wantsFile ? effective(source, ctx) : source;

  // A file that carried another file, asked for in that other file's format: hand back the original.
  const restore = (): ConvertResult => ({ bytes: eff.origin.bytes, text: utf8(eff.origin.bytes) ?? undefined, from: src.name, to: dst.name, fromKind, toKind: kindOf(eff.doc), fidelity: "lossless", route: [...ctx.route, `restore the original ${dst.name} file`], notes: ctx.notes });
  if (ctx.unwrapped && eff.origin.format === dst.name) return restore();
  // Bytes or letters that turned out to be plain text, asked for as a format that reads text: they are that file.
  if (ctx.unwrapped && wantsFile && eff.origin.format === "Text" && eff.doc.kind === "text") {
    if (!PARSED_FORMATS.has(dst.name) || textFitsFormat(dst.name, eff.doc.text)) { ctx.route.push(`take the text as the ${dst.name} file`); return restore(); }
  }

  const out = writeTarget(dst, eff, ctx);

  // Anything dropped outranks everything else: a wrapper that lost bytes is not "wrapped".
  const fidelity: Fidelity = ctx.lossy ? "lossy" : ctx.wrapped ? "wrapped" : ctx.relabelled ? "relabelled" : "lossless";
  const toKind: Kind = IMAGE_FORMATS.has(dst.name) ? "image" : dst.name === "CSV" || dst.name === "TSV" || dst.name === "SQL" ? "table" : TREE_FORMATS.has(dst.name) ? "tree" : BYTE_TEXT_FORMATS.has(dst.name) || dst.name === "Binary" ? "bytes" : "text";
  return { bytes: out, text: utf8(out) ?? undefined, from: src.name, to: dst.name, fromKind, toKind, fidelity, route: ctx.route, notes: ctx.notes };
}

// ================================================================ what is covered

export interface Coverage {
  formats: number;
  /** Every ordered pair of different formats has a route. */
  pairs: number;
  reads: Record<string, number>;
  writes: Record<string, number>;
  /** The formats with a real reader or writer of their own, by role. */
  native: { images: string[]; tables: string[]; trees: string[]; bytes: string[]; programs: string[] };
}

/** How each format is read and written, counted over the whole registry. */
export function coverage(reg: FormatRegistry = formats()): Coverage {
  const reads: Record<string, number> = { image: 0, table: 0, tree: 0, bytes: 0, text: 0 };
  const writes: Record<string, number> = { image: 0, table: 0, tree: 0, bytes: 0, markdown: 0, html: 0, sql: 0, program: 0, "comment rows": 0, "plain rows": 0, "text (unchanged)": 0 };
  for (const f of reg.all()) {
    const n = f.name;
    reads[IMAGE_FORMATS.has(n) ? "image" : n === "CSV" || n === "TSV" ? "table" : TREE_FORMATS.has(n) ? "tree" : BYTE_TEXT_FORMATS.has(n) || n === "Binary" ? "bytes" : "text"]++;
    if (IMAGE_FORMATS.has(n)) writes.image++;
    else if (n === "CSV" || n === "TSV") writes.table++;
    else if (TREE_FORMATS.has(n)) writes.tree++;
    else if (BYTE_TEXT_FORMATS.has(n) || n === "Binary") writes.bytes++;
    else if (n === "Markdown") writes.markdown++;
    else if (n === "HTML") writes.html++;
    else if (n === "SQL") writes.sql++;
    else if (f.type === "programming") writes[CODE.PROGRAM_LANGUAGES.includes(n) ? "program" : CODE.commentMark(n) ? "comment rows" : "plain rows"]++;
    else writes["text (unchanged)"]++;
  }
  return {
    formats: reg.size,
    pairs: reg.size * (reg.size - 1),
    reads, writes,
    native: { images: [...IMAGE_FORMATS], tables: ["CSV", "TSV", "Markdown", "HTML", "SQL"], trees: [...TREE_FORMATS], bytes: [...BYTE_TEXT_FORMATS, "Binary"], programs: CODE.PROGRAM_LANGUAGES },
  };
}
