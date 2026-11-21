/**
 * Structured data: tables (CSV, TSV, Markdown, HTML, SQL) and trees (JSON, YAML, TOML, XML, INI).
 *
 * Two plain shapes carry everything:
 *   Table  header + rows of strings
 *   Json   null, boolean, number, string, array, object
 *
 * Every parser here is written for this project and reads the common subset of its format, not
 * the whole specification. Where something is outside the subset the parser throws and says what,
 * rather than guessing. The writers only produce what their own reader (or a standard reader) takes.
 *
 * Own code. No libraries.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Table { header: string[]; rows: string[][] }

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => k in (b as object) && deepEqual((a as never)[k], (b as never)[k]));
  }
  return false;
}

// ================================================================ delimited text (CSV / TSV)

export function parseDelimited(text: string, delim = ","): Table {
  const rows: string[][] = [];
  let row: string[] = [], field = "", i = 0, quoted = false, any = false;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; any = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; any = true; i++; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      i++;
      row.push(field); field = ""; rows.push(row); row = []; any = false; continue;
    }
    field += c; any = true; i++;
  }
  if (quoted) throw new Error("CSV: a quoted field is never closed");
  if (any || field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  const width = header.length;
  // A blank line is not a row, unless the table has one column (then it is a row holding an empty value).
  const body = rows.slice(1).filter((r) => !(r.length === 1 && r[0] === "" && width > 1))
    .map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
  return { header, rows: body };
}

export function writeDelimited(t: Table, delim = ","): string {
  const q = (v: string): string => (v.includes(delim) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [t.header, ...t.rows].map((r) => (r.length === 1 && r[0] === "" ? '""' : r.map(q).join(delim))).join("\n") + "\n";
}

// ================================================================ table <-> tree

const numberLike = (s: string): boolean => s !== "" && /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(s) && String(Number(s)) === s && Number.isFinite(Number(s));

/** Rows become objects. Only values that print back exactly (numbers, true, false) change type. */
export function tableToTree(t: Table): Json {
  const seen = new Map<string, number>();
  const keys = t.header.map((h, i) => {
    let k = h === "" ? `column_${i + 1}` : h;
    const n = (seen.get(k) ?? 0) + 1; seen.set(k, n);
    return n > 1 ? `${k}_${n}` : k;
  });
  return t.rows.map((r) => {
    const o: { [k: string]: Json } = {};
    keys.forEach((k, i) => {
      const v = r[i] ?? "";
      o[k] = numberLike(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    });
    return o;
  });
}

const cell = (v: Json): string => (v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

function flattenPaths(v: Json, prefix: string, out: string[][]): void {
  if (Array.isArray(v)) { if (!v.length) out.push([prefix, "[]"]); v.forEach((x, i) => flattenPaths(x, `${prefix}[${i}]`, out)); }
  else if (isObj(v)) { const ks = Object.keys(v); if (!ks.length) out.push([prefix, "{}"]); ks.forEach((k) => flattenPaths(v[k], prefix ? `${prefix}.${k}` : k, out)); }
  else out.push([prefix, cell(v)]);
}

/** A list of records becomes a table with one column per key. Anything else becomes path / value rows. */
export function treeToTable(v: Json): { table: Table; lossy: boolean } {
  if (Array.isArray(v) && v.length && v.every(isObj)) {
    const header: string[] = [];
    for (const o of v as Array<{ [k: string]: Json }>) for (const k of Object.keys(o)) if (!header.includes(k)) header.push(k);
    let lossy = false;
    const rows = (v as Array<{ [k: string]: Json }>).map((o) => header.map((k) => {
      const x = o[k];
      if (x === undefined) { lossy = true; return ""; }
      if (typeof x === "object" && x !== null) lossy = true;
      if (x === null) lossy = true;
      return cell(x);
    }));
    return { table: { header, rows }, lossy };
  }
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
    return { table: { header: ["value"], rows: v.map((x) => [cell(x)]) }, lossy: v.some((x) => x === null || typeof x !== "string") };
  }
  const rows: string[][] = [];
  flattenPaths(v, "", rows);
  return { table: { header: ["path", "value"], rows }, lossy: true };
}

// ================================================================ tables as markup

export function writeMarkdownTable(t: Table): string {
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const line = (r: string[]): string => "| " + r.map(esc).join(" | ") + " |";
  return [line(t.header), "| " + t.header.map(() => "---").join(" | ") + " |", ...t.rows.map(line)].join("\n") + "\n";
}

export function readMarkdownTable(text: string): Table | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || !lines.every((l) => l.trim().startsWith("|"))) return null;
  const split = (l: string): string[] => {
    const cells: string[] = []; let cur = "";
    const body = l.trim().replace(/^\|/, "").replace(/\|$/, (m, off, s) => (s[off - 1] === "\\" ? m : ""));
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && (body[i + 1] === "|" || body[i + 1] === "\\")) { cur += body[i + 1]; i++; }
      else if (body[i] === "|") { cells.push(cur.trim()); cur = ""; }
      else cur += body[i];
    }
    cells.push(cur.trim());
    return cells.map((c) => c.replace(/<br>/g, "\n"));
  };
  const header = split(lines[0]);
  if (!split(lines[1]).every((c) => /^:?-{3,}:?$/.test(c))) return null;
  return { header, rows: lines.slice(2).map((l) => { const r = split(l); while (r.length < header.length) r.push(""); return r; }) };
}

const htmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const htmlUnesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function writeHtmlTable(t: Table): string {
  const tr = (tag: string, r: string[]): string => `<tr>${r.map((c) => `<${tag}>${htmlEsc(c)}</${tag}>`).join("")}</tr>`;
  return ["<table>", "<thead>", tr("th", t.header), "</thead>", "<tbody>", ...t.rows.map((r) => tr("td", r)), "</tbody>", "</table>", ""].join("\n");
}

export function readHtmlTable(text: string): Table | null {
  const tm = /<table\b[\s\S]*?<\/table>/i.exec(text);
  if (!tm) return null;
  const rows = [...tm[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => htmlUnesc(c[1].replace(/<[^>]+>/g, ""))));
  if (!rows.length) return null;
  const width = rows[0].length;
  return { header: rows[0], rows: rows.slice(1).map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r)) };
}

export function writeSqlInserts(t: Table, name = "data"): string {
  const id = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const lit = (v: string): string => (numberLike(v) ? v : `'${v.replace(/'/g, "''")}'`);
  const out = [`CREATE TABLE ${id(name)} (${t.header.map((h) => `${id(h)} TEXT`).join(", ")});`];
  for (const r of t.rows) out.push(`INSERT INTO ${id(name)} (${t.header.map(id).join(", ")}) VALUES (${t.header.map((_, i) => lit(r[i] ?? "")).join(", ")});`);
  return out.join("\n") + "\n";
}

/** Read back what `writeSqlInserts` wrote: one CREATE TABLE and its INSERT statements. Null for any other SQL. */
export function readSqlInserts(text: string): Table | null {
  const create = /^CREATE TABLE "(?:[^"]|"")*" \(((?:"(?:[^"]|"")*" TEXT(?:, )?)*)\);\n/.exec(text);
  if (!create) return null;
  const header = [...create[1].matchAll(/"((?:[^"]|"")*)" TEXT/g)].map((m) => m[1].replace(/""/g, '"'));
  const rows: string[][] = [];
  let i = create[0].length;
  while (i < text.length) {
    const head = /^INSERT INTO "(?:[^"]|"")*" \((?:"(?:[^"]|"")*"(?:, )?)*\) VALUES \(/.exec(text.slice(i));
    if (!head) return null;
    i += head[0].length;
    const row: string[] = [];
    for (;;) {
      let v = "";
      if (text[i] === "'") {
        i++;
        for (;;) {
          if (i >= text.length) return null;
          if (text[i] === "'") { if (text[i + 1] === "'") { v += "'"; i += 2; continue; } i++; break; }
          v += text[i++];
        }
      } else { const m = /^[^,)]*/.exec(text.slice(i))!; v = m[0]; i += m[0].length; }
      row.push(v);
      if (text[i] === ",") { i += text[i + 1] === " " ? 2 : 1; continue; }
      if (text[i] === ")") break;
      return null;
    }
    if (text.slice(i, i + 3) !== ");\n") return null;
    i += 3;
    if (row.length !== header.length) return null;
    rows.push(row);
  }
  return { header, rows };
}

// ================================================================ YAML

const YAML_RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const yamlPlainOk = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_ ./()-]*$/.test(s) && !/\s$/.test(s) && !YAML_RESERVED.test(s);
const yamlStr = (s: string): string => (yamlPlainOk(s) ? s : JSON.stringify(s));

function yamlScalar(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "string") return yamlStr(v);
  return String(v);
}

function yamlLines(v: Json, pad: string): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (Array.isArray(item) && item.length || isObj(item) && Object.keys(item).length) {
        const sub = yamlLines(item, pad + "  ");
        sub[0] = pad + "- " + sub[0].slice(pad.length + 2);
        out.push(...sub);
      } else out.push(`${pad}- ${Array.isArray(item) ? "[]" : isObj(item) ? "{}" : yamlScalar(item)}`);
    }
    return out;
  }
  if (isObj(v)) {
    const out: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      const key = yamlPlainOk(k) ? k : JSON.stringify(k);
      if (Array.isArray(x) && x.length || isObj(x) && Object.keys(x).length) { out.push(`${pad}${key}:`); out.push(...yamlLines(x, pad + "  ")); }
      else out.push(`${pad}${key}: ${Array.isArray(x) ? "[]" : isObj(x) ? "{}" : yamlScalar(x)}`);
    }
    return out;
  }
  return [pad + yamlScalar(v)];
}

export function writeYaml(v: Json): string {
  if (Array.isArray(v) && !v.length) return "[]\n";
  if (isObj(v) && !Object.keys(v).length) return "{}\n";
  return yamlLines(v, "").join("\n") + "\n";
}

function stripYamlComment(line: string): string {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; }
    else if (c === '"' || c === "'") { if (i === 0 || /[\s\[{,:-]/.test(line[i - 1])) q = c; }
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function yamlSplitKey(t: string): { key: string; rest: string } | null {
  if (t[0] === '"' || t[0] === "'") {
    let i = 1;
    for (; i < t.length; i++) { if (t[i] === "\\" && t[0] === '"') i++; else if (t[i] === t[0]) { if (t[0] === "'" && t[i + 1] === "'") i++; else break; } }
    if (i >= t.length) return null;
    const after = t.slice(i + 1);
    if (!/^\s*:(\s|$)/.test(after)) return null;
    return { key: String(yamlScalarIn(t.slice(0, i + 1))), rest: after.replace(/^\s*:\s*/, "") };
  }
  if (t[0] === "[" || t[0] === "{" || t[0] === "|" || t[0] === ">" || t[0] === "&" || t[0] === "*") return null;
  const m = /^(.*?)(?::\s+|:$)(.*)$/.exec(t);
  if (!m || m[1] === "") return null;
  return { key: m[1].trim(), rest: m[2] };
}

function yamlScalarIn(s: string): Json {
  const t = s.trim();
  if (t === "" || t === "~" || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (t[0] === '"') { try { return JSON.parse(t) as string; } catch { throw new Error(`YAML: cannot read string ${t}`); } }
  if (t[0] === "'") return t.slice(1, t.lastIndexOf("'")).replace(/''/g, "'");
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  return t;
}

/** One flow value ("[1, 2]", "{a: 1}", a scalar) starting at `pos`; returns the value and where it ended. */
function yamlFlow(s: string, pos: number): { v: Json; end: number } {
  const ws = (): void => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
  ws();
  if (s[pos] === "[") {
    pos++; const arr: Json[] = [];
    for (;;) {
      ws();
      if (s[pos] === "]") { pos++; break; }
      const r = yamlFlow(s, pos); arr.push(r.v); pos = r.end; ws();
      if (s[pos] === ",") pos++; else if (s[pos] === "]") { pos++; break; } else throw new Error("YAML: bad flow list");
    }
    return { v: arr, end: pos };
  }
  if (s[pos] === "{") {
    pos++; const obj: { [k: string]: Json } = {};
    for (;;) {
      ws();
      if (s[pos] === "}") { pos++; break; }
      const k = yamlFlow(s, pos); pos = k.end; ws();
      let v: Json = null;
      if (s[pos] === ":") { pos++; const r = yamlFlow(s, pos); v = r.v; pos = r.end; ws(); }
      obj[String(k.v)] = v;
      if (s[pos] === ",") pos++; else if (s[pos] === "}") { pos++; break; } else throw new Error("YAML: bad flow map");
    }
    return { v: obj, end: pos };
  }
  if (s[pos] === '"' || s[pos] === "'") {
    const q = s[pos]; let i = pos + 1;
    for (; i < s.length; i++) { if (s[i] === "\\" && q === '"') i++; else if (s[i] === q) { if (q === "'" && s[i + 1] === "'") i++; else break; } }
    return { v: yamlScalarIn(s.slice(pos, i + 1)), end: i + 1 };
  }
  let i = pos;
  while (i < s.length && !",]}".includes(s[i]) && !(s[i] === ":" && (s[i + 1] === " " || i + 1 === s.length))) i++;
  return { v: yamlScalarIn(s.slice(pos, i)), end: i };
}

export function parseYaml(src: string): Json {
  const raw = src.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const blank = (l: string): boolean => { const t = stripYamlComment(l).trim(); return t === "" || t === "---" || t === "..."; };
  const skip = (): void => { while (i < raw.length && blank(raw[i])) i++; };
  const content = (l: string): string => stripYamlComment(l).trim();
  const balanced = (s: string): boolean => {
    let d = 0, q = "";
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === "\\" && q === '"') k++; else if (c === q) q = ""; }
      else if (c === '"' || c === "'") q = c;
      else if (c === "[" || c === "{") d++;
      else if (c === "]" || c === "}") d--;
    }
    return d <= 0;
  };

  // A value that sits on the same line as its key or dash: scalar, flow collection or block scalar header.
  const inlineValue = (rest: string, parentIndent: number): Json => {
    if (/^[|>][-+0-9]*$/.test(rest)) return blockScalar(rest, parentIndent);
    let text = rest;
    if ((text[0] === "[" || text[0] === "{") && !balanced(text)) {
      while (!balanced(text) && i + 1 < raw.length) { i++; text += " " + content(raw[i]); }
    }
    i++;
    if (text[0] === "[" || text[0] === "{") { const r = yamlFlow(text, 0); if (text.slice(r.end).trim()) throw new Error("YAML: text after a flow value"); return r.v; }
    return yamlScalarIn(text);
  };

  const blockScalar = (head: string, parentIndent: number): string => {
    i++;
    const lines: string[] = [];
    let ind = -1;
    while (i < raw.length) {
      const l = raw[i];
      if (l.trim() === "") { lines.push(""); i++; continue; }
      const n = indentOf(l);
      if (n <= parentIndent) break;
      if (ind < 0) ind = n;
      if (n < ind) break;
      lines.push(l.slice(ind)); i++;
    }
    let trailing = 0;
    while (lines.length && lines[lines.length - 1] === "") { lines.pop(); trailing++; }
    let body = head[0] === "|" ? lines.join("\n") : lines.reduce((acc, l, k) => (k === 0 ? l : l === "" ? acc + "\n" : acc.endsWith("\n") ? acc + l : acc + " " + l), "");
    const chomp = head.includes("-") ? "strip" : head.includes("+") ? "keep" : "clip";
    if (chomp === "clip" && lines.length) body += "\n";
    else if (chomp === "keep") body += "\n".repeat(Math.max(1, trailing + (lines.length ? 1 : 0)));
    return body;
  };

  const parseBlock = (ind: number): Json => {
    const t = content(raw[i]);
    if (t === "-" || t.startsWith("- ")) return parseSeq(ind);
    if (yamlSplitKey(t)) return parseMap(ind);
    return inlineValue(t, ind - 1);
  };

  const nested = (ind: number): Json => { // the value under "key:" or "-" with nothing after it
    skip();
    if (i >= raw.length) return null;
    const n = indentOf(raw[i]), t = content(raw[i]);
    if (n > ind) return parseBlock(n);
    if (n === ind && (t === "-" || t.startsWith("- "))) return parseSeq(n);
    return null;
  };

  const parseSeq = (ind: number): Json => {
    const arr: Json[] = [];
    for (;;) {
      skip();
      if (i >= raw.length || indentOf(raw[i]) !== ind) break;
      const t = content(raw[i]);
      if (!(t === "-" || t.startsWith("- "))) break;
      const rest = t.slice(1).trimStart();
      const col = raw[i].indexOf("-", ind) + 1 + (t.slice(1).length - rest.length);
      if (rest === "") { i++; arr.push(nested(ind)); }
      else if (rest === "-" || rest.startsWith("- ") || yamlSplitKey(rest)) { raw[i] = " ".repeat(col) + rest; arr.push(parseBlock(col)); }
      else arr.push(inlineValue(rest, ind));
    }
    return arr;
  };

  const parseMap = (ind: number): Json => {
    const obj: { [k: string]: Json } = {};
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const n = indentOf(raw[i]);
      if (n < ind) break;
      if (n > ind) throw new Error(`YAML line ${i + 1}: unexpected indent`);
      const t = content(raw[i]);
      if (t === "-" || t.startsWith("- ")) break;
      const kv = yamlSplitKey(t);
      if (!kv) throw new Error(`YAML line ${i + 1}: expected "key: value" but got ${JSON.stringify(t)}`);
      if (kv.rest === "") { i++; obj[kv.key] = nested(ind); }
      else obj[kv.key] = inlineValue(kv.rest, ind);
    }
    return obj;
  };

  skip();
  if (i >= raw.length) return null;
  const v = parseBlock(indentOf(raw[i]));
  skip();
  if (i < raw.length) throw new Error(`YAML line ${i + 1}: more than one document or stray text`);
  return v;
}

// ================================================================ TOML

const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlInline(v: Json): string | null {
  if (v === null) return null;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(v)) : null;
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map((x) => tomlInline(x) ?? '""').join(", ") + "]";
  return "{ " + Object.entries(v).flatMap(([k, x]) => { const s = tomlInline(x); return s === null ? [] : [`${tomlKey(k)} = ${s}`]; }).join(", ") + " }";
}

function tomlTable(obj: { [k: string]: Json }, path: string[], out: string[]): void {
  const subs: Array<[string, Json]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isObj(v) && Object.keys(v).length) subs.push([k, v]);
    else if (Array.isArray(v) && v.length && v.every((x) => isObj(x) && Object.keys(x).length)) subs.push([k, v]);
    else { const s = tomlInline(v); if (s !== null) out.push(`${tomlKey(k)} = ${s}`); }
  }
  for (const [k, v] of subs) {
    const p = [...path, k], name = p.map(tomlKey).join(".");
    if (Array.isArray(v)) for (const item of v) { out.push("", `[[${name}]]`); tomlTable(item as { [k: string]: Json }, p, out); }
    else { out.push("", `[${name}]`); tomlTable(v as { [k: string]: Json }, p, out); }
  }
}

/** TOML needs a table at the top; anything else is put under a "value" key. TOML has no null, so nulls are left out. */
export function writeToml(v: Json): string {
  const out: string[] = [];
  tomlTable(isObj(v) ? v : { value: v }, [], out);
  return out.join("\n").replace(/^\n/, "") + "\n";
}

function tomlStripComment(line: string): string {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function tomlValue(s: string, pos: number): { v: Json; end: number } {
  const ws = (): void => { while (pos < s.length && /\s/.test(s[pos])) pos++; };
  ws();
  const c = s[pos];
  if (c === '"') {
    if (s.startsWith('"""', pos)) throw new Error("TOML: multi-line strings are not supported");
    let i = pos + 1;
    for (; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
    if (i >= s.length) throw new Error("TOML: string is not closed");
    return { v: JSON.parse(s.slice(pos, i + 1)) as string, end: i + 1 };
  }
  if (c === "'") {
    if (s.startsWith("'''", pos)) throw new Error("TOML: multi-line strings are not supported");
    const j = s.indexOf("'", pos + 1);
    if (j < 0) throw new Error("TOML: string is not closed");
    return { v: s.slice(pos + 1, j), end: j + 1 };
  }
  if (c === "[") {
    pos++; const arr: Json[] = [];
    for (;;) {
      ws();
      if (s[pos] === "]") { pos++; break; }
      const r = tomlValue(s, pos); arr.push(r.v); pos = r.end; ws();
      if (s[pos] === ",") pos++; else if (s[pos] === "]") { pos++; break; } else throw new Error("TOML: bad array");
    }
    return { v: arr, end: pos };
  }
  if (c === "{") {
    pos++; const obj: { [k: string]: Json } = {};
    for (;;) {
      ws();
      if (s[pos] === "}") { pos++; break; }
      const k = tomlKeyPath(s, pos); pos = k.end; ws();
      if (s[pos] !== "=") throw new Error("TOML: inline table needs key = value");
      const r = tomlValue(s, pos + 1); setPath(obj, k.path, r.v); pos = r.end; ws();
      if (s[pos] === ",") pos++; else if (s[pos] === "}") { pos++; break; } else throw new Error("TOML: bad inline table");
    }
    return { v: obj, end: pos };
  }
  let i = pos;
  while (i < s.length && !",]}".includes(s[i]) && !/\s/.test(s[i])) i++;
  const t = s.slice(pos, i);
  if (t === "true") return { v: true, end: i };
  if (t === "false") return { v: false, end: i };
  if (/^[-+]?(0|[1-9][\d_]*)$/.test(t)) return { v: Number(t.replace(/_/g, "")), end: i };
  if (/^[-+]?(\d[\d_]*)(\.\d[\d_]*)?([eE][-+]?\d+)?$/.test(t)) return { v: Number(t.replace(/_/g, "")), end: i };
  if (/^0x[0-9a-fA-F_]+$/.test(t)) return { v: parseInt(t.replace(/_/g, ""), 16), end: i };
  if (/^\d{4}-\d\d-\d\d/.test(t)) { // a date or time: keep the text, extend over a space-separated time
    let e = i; const m = /^\s+\d\d:\d\d:\d\d[^\s,\]}]*/.exec(s.slice(i)); if (m) e = i + m[0].length;
    return { v: s.slice(pos, e), end: e };
  }
  throw new Error(`TOML: cannot read value ${JSON.stringify(t)}`);
}

function tomlKeyPath(s: string, pos: number): { path: string[]; end: number } {
  const path: string[] = [];
  for (;;) {
    while (s[pos] === " " || s[pos] === "\t") pos++;
    if (s[pos] === '"') { let i = pos + 1; for (; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++; path.push(JSON.parse(s.slice(pos, i + 1)) as string); pos = i + 1; }
    else if (s[pos] === "'") { const j = s.indexOf("'", pos + 1); path.push(s.slice(pos + 1, j)); pos = j + 1; }
    else { const m = /^[A-Za-z0-9_-]+/.exec(s.slice(pos)); if (!m) throw new Error(`TOML: bad key near ${JSON.stringify(s.slice(pos, pos + 12))}`); path.push(m[0]); pos += m[0].length; }
    while (s[pos] === " " || s[pos] === "\t") pos++;
    if (s[pos] === ".") pos++; else break;
  }
  return { path, end: pos };
}

function setPath(obj: { [k: string]: Json }, path: string[], v: Json): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (next === undefined) cur[path[i]] = {};
    else if (Array.isArray(next)) { const last = next[next.length - 1]; if (!isObj(last)) throw new Error("TOML: key path crosses a non-table"); cur = last; continue; }
    else if (!isObj(next)) throw new Error("TOML: key path crosses a value");
    cur = cur[path[i]] as { [k: string]: Json };
  }
  cur[path[path.length - 1]] = v;
}

export function parseToml(src: string): Json {
  const root: { [k: string]: Json } = {};
  let cur = root;
  const lines = src.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    let line = tomlStripComment(lines[n]).trim();
    if (!line) continue;
    if (line.startsWith("[[")) {
      const end = line.indexOf("]]");
      if (end < 0) throw new Error(`TOML line ${n + 1}: bad table header`);
      const { path } = tomlKeyPath(line.slice(2, end), 0);
      const parent = path.slice(0, -1).reduce<{ [k: string]: Json }>((o, k) => {
        const x = o[k]; if (x === undefined) { o[k] = {}; return o[k] as { [k: string]: Json }; }
        return Array.isArray(x) ? (x[x.length - 1] as { [k: string]: Json }) : (x as { [k: string]: Json });
      }, root);
      const last = path[path.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      const fresh: { [k: string]: Json } = {};
      (parent[last] as Json[]).push(fresh);
      cur = fresh;
    } else if (line.startsWith("[")) {
      const end = line.indexOf("]");
      if (end < 0) throw new Error(`TOML line ${n + 1}: bad table header`);
      const { path } = tomlKeyPath(line.slice(1, end), 0);
      cur = root;
      for (const k of path) {
        const x = cur[k];
        if (x === undefined) cur[k] = {};
        cur = Array.isArray(cur[k]) ? ((cur[k] as Json[])[(cur[k] as Json[]).length - 1] as { [k: string]: Json }) : (cur[k] as { [k: string]: Json });
      }
    } else {
      const k = tomlKeyPath(line, 0);
      const eq = line.indexOf("=", k.end);
      if (eq < 0) throw new Error(`TOML line ${n + 1}: expected key = value`);
      let rest = line.slice(eq + 1);
      for (let depth = (rest.match(/\[/g)?.length ?? 0) - (rest.match(/\]/g)?.length ?? 0); depth > 0 && n + 1 < lines.length;) { // array across lines
        n++; rest += " " + tomlStripComment(lines[n]).trim();
        depth = (rest.match(/\[/g)?.length ?? 0) - (rest.match(/\]/g)?.length ?? 0);
      }
      const r = tomlValue(rest, 0);
      if (rest.slice(r.end).trim()) throw new Error(`TOML line ${n + 1}: text after the value`);
      setPath(cur, k.path, r.v);
    }
  }
  return root;
}

// ================================================================ XML

const xmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r/g, "&#13;");
const xmlNameOk = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) && !/^xml/i.test(s);

function xmlEl(name: string, v: Json, pad: string, key?: string): string[] {
  const ka = key !== undefined ? ` key="${xmlEsc(key)}"` : "";
  if (v === null) return [`${pad}<${name}${ka} t="null"/>`];
  if (typeof v === "boolean" || typeof v === "number") return [`${pad}<${name}${ka} t="${typeof v}">${v}</${name}>`];
  if (typeof v === "string") return [`${pad}<${name}${ka}>${xmlEsc(v)}</${name}>`];
  const items: string[] = [];
  if (Array.isArray(v)) for (const x of v) items.push(...xmlEl("item", x, pad + "  "));
  else for (const [k, x] of Object.entries(v)) items.push(...(xmlNameOk(k) ? xmlEl(k, x, pad + "  ") : xmlEl("entry", x, pad + "  ", k)));
  const t = Array.isArray(v) ? "array" : "object";
  return items.length ? [`${pad}<${name}${ka} t="${t}">`, ...items, `${pad}</${name}>`] : [`${pad}<${name}${ka} t="${t}"/>`];
}

export function writeXml(v: Json, root = "root"): string {
  // A bare top-level string still needs t="string", or a reader cannot tell our file from foreign XML.
  const body = typeof v === "string" ? [`<${root} t="string">${xmlEsc(v)}</${root}>`] : xmlEl(root, v, "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body.join("\n")}\n`;
}

interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string; hasText: boolean }

const xmlUnesc = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
  e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

function xmlTree(src: string): XNode {
  const top: XNode = { name: "#document", attrs: {}, children: [], text: "", hasText: false };
  const stack: XNode[] = [top];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s\/>!?][^\s\/>]*)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  const text = src.replace(/^\uFEFF/, "");
  while ((m = re.exec(text))) {
    if (m.index !== consumed) throw new Error(`XML: cannot read near character ${consumed}`);
    consumed = re.lastIndex;
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) { cur.text += m[1]; cur.hasText = true; }
    else if (m[2] !== undefined) {
      if (stack.length < 2 || cur.name !== m[2]) throw new Error(`XML: </${m[2]}> does not close <${cur.name}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrsOut: Record<string, string> = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrsOut[a[1]] = xmlUnesc(a[2] ?? a[3]);
      const node: XNode = { name: m[3], attrs: attrsOut, children: [], text: "", hasText: false };
      cur.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      if (m[6].trim() || cur.name !== "#document") { cur.text += xmlUnesc(m[6]); cur.hasText = true; }
    }
  }
  if (consumed !== text.length) throw new Error(`XML: cannot read near character ${consumed}`);
  if (stack.length !== 1) throw new Error(`XML: <${stack[stack.length - 1].name}> is never closed`);
  if (top.children.length !== 1) throw new Error("XML: expected exactly one root element");
  return top.children[0];
}

function xmlValue(n: XNode): Json {
  const t = n.attrs.t;
  if (t === "null") return null;
  if (t === "number") return Number(n.text);
  if (t === "boolean") return n.text === "true";
  if (t === "string") return n.text;
  if (t === "array") return n.children.map(xmlValue);
  if (t === "object") { const o: { [k: string]: Json } = {}; for (const c of n.children) o[c.attrs.key ?? c.name] = xmlValue(c); return o; }
  if (!n.children.length) {
    const attrKeys = Object.keys(n.attrs).filter((k) => k !== "key" && k !== "t");
    if (!attrKeys.length) return n.text;
    const o: { [k: string]: Json } = {};
    for (const k of attrKeys) o["@" + k] = n.attrs[k];
    if (n.text.trim()) o["#text"] = n.text;
    return o;
  }
  const o: { [k: string]: Json } = {};
  for (const k of Object.keys(n.attrs)) if (k !== "key" && k !== "t") o["@" + k] = n.attrs[k];
  const repeated = new Set<string>(); // names that appear more than once become arrays
  for (const c of n.children) {
    const key = c.attrs.key ?? c.name, v = xmlValue(c);
    if (!(key in o)) o[key] = v;
    else if (repeated.has(key)) (o[key] as Json[]).push(v);
    else { o[key] = [o[key], v]; repeated.add(key); }
  }
  return o;
}

/** Our own dialect comes back exactly. Foreign XML comes back as {rootName: ...}, with attributes as "@name" keys. */
export function parseXml(src: string): Json {
  const root = xmlTree(src);
  const v = xmlValue(root);
  return root.attrs.t ? v : { [root.name]: v };
}

// ================================================================ INI

function iniScalar(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[]";
  if (isObj(v)) return "{}";
  const bare = v !== "" && !/^\s|\s$|[;#="\\\n\r\t]/.test(v) && !/^(true|false|null|\[\]|\{\})$/.test(v) && !(Number.isFinite(Number(v)) && String(Number(v)) === v);
  return bare ? v : JSON.stringify(v);
}

function iniFlatten(v: Json, prefix: string, out: Array<[string, Json]>): void {
  if (Array.isArray(v) && v.length) v.forEach((x, i) => iniFlatten(x, `${prefix}[${i}]`, out));
  else if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) iniFlatten(x, prefix ? `${prefix}.${k}` : k, out);
  else out.push([prefix, v]);
}

export function writeIni(v: Json): string {
  const top = isObj(v) ? v : { value: v };
  const global: Array<[string, Json]> = [], sections: Array<[string, Array<[string, Json]>]> = [];
  for (const [k, x] of Object.entries(top)) {
    if (isObj(x) && Object.keys(x).length) { const e: Array<[string, Json]> = []; iniFlatten(x, "", e); sections.push([k, e]); }
    else iniFlatten(x, k, global);
  }
  const out: string[] = global.map(([k, x]) => `${k} = ${iniScalar(x)}`);
  for (const [name, e] of sections) { if (out.length) out.push(""); out.push(`[${name}]`, ...e.map(([k, x]) => `${k} = ${iniScalar(x)}`)); }
  return out.join("\n") + "\n";
}

function iniPathSet(obj: { [k: string]: Json }, path: string, v: Json): void {
  const parts = [...path.matchAll(/[^.\[\]]+|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? Number(m[1]) : m[0]));
  if (!parts.length) throw new Error(`INI: empty key`);
  let cur: Json = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], last = i === parts.length - 1;
    const container = cur as never as Record<string | number, Json>;
    if (last) { container[p] = v; return; }
    if (container[p] === undefined) container[p] = typeof parts[i + 1] === "number" ? [] : {};
    cur = container[p];
  }
}

export function parseIni(src: string): Json {
  const root: { [k: string]: Json } = {};
  let section = "";
  const lines = src.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line || line[0] === ";" || line[0] === "#") continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1].trim(); if (!(section in root)) root[section] = {}; continue; }
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`INI line ${n + 1}: expected key = value`);
    const key = line.slice(0, eq).trim(), raw = line.slice(eq + 1).trim();
    let v: Json;
    if (raw[0] === '"') { try { v = JSON.parse(raw) as string; } catch { throw new Error(`INI line ${n + 1}: bad quoted value`); } }
    else if (raw === "true") v = true; else if (raw === "false") v = false; else if (raw === "null") v = null;
    else if (raw === "[]") v = []; else if (raw === "{}") v = {};
    else if (raw !== "" && Number.isFinite(Number(raw)) && String(Number(raw)) === raw) v = Number(raw);
    else v = raw;
    if (section) iniPathSet(root[section] as { [k: string]: Json }, key, v); else iniPathSet(root, key, v);
  }
  return root;
}
