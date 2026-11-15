/**
 * Carrying bytes inside other formats, and getting them back.
 *
 *  - raw bytes written as text: hex, base64, a string of 0 and 1 bits
 *  - a program in one of 11 languages that, when run, writes the original bytes to its output
 *    (an image becomes a program that draws it: it prints the PPM file, one hex row per 32 bytes)
 *  - for every other language we know the comment mark of: the same rows inside comments
 *  - for anything else: the rows as plain text
 *  - bytes packed into the pixels of a picture, and back
 *
 * Every wrapper starts with one marker line, `NEUROCLAW-WRAP 1 src=<format> bytes=<n> ...`, so the
 * file can be unwrapped later and conversion can carry on from the original format.
 *
 * Own code. No templates taken from anywhere else.
 */
import type { Raster } from "./format-image.js";

// ---------------------------------------------------------------- bytes as text

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function writeHexDump(b: Uint8Array): string {
  const h = toHex(b), rows: string[] = [];
  for (let i = 0; i < h.length; i += 64) rows.push(h.slice(i, i + 64));
  return rows.join("\n") + "\n";
}
export function readHexDump(text: string): Uint8Array {
  const h = text.replace(/\s+/g, "");
  if (/[^0-9a-fA-F]/.test(h) || h.length % 2) throw new Error("Hex dump: expected pairs of hexadecimal digits");
  return Uint8Array.from(Buffer.from(h, "hex"));
}
export function writeBase64(b: Uint8Array): string {
  return (Buffer.from(b).toString("base64").match(/.{1,76}/g) ?? []).join("\n") + "\n";
}
export function readBase64(text: string): Uint8Array {
  const s = text.replace(/\s+/g, "");
  if (/[^A-Za-z0-9+/=]/.test(s) || s.length % 4) throw new Error("Base64: not valid base64");
  return Uint8Array.from(Buffer.from(s, "base64"));
}
export function writeBitString(b: Uint8Array): string {
  let all = "";
  for (const v of b) all += v.toString(2).padStart(8, "0");
  return (all.match(/.{1,64}/g) ?? []).join("\n") + "\n";
}
export function readBitString(text: string): Uint8Array {
  const s = text.replace(/\s+/g, "");
  if (/[^01]/.test(s) || s.length % 8) throw new Error("Bit string: expected only 0 and 1, a multiple of 8 of them");
  const out = new Uint8Array(s.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 8, i * 8 + 8), 2);
  return out;
}

// ---------------------------------------------------------------- bytes in a picture

const PACK_MAGIC = Buffer.from("NCB1", "latin1");

/** Put the bytes into the pixels of a picture: "NCB1", a 4-byte length, the bytes, then zeros. Exact, and detectable on the way back. */
export function packBytesAsRaster(b: Uint8Array): Raster {
  const n = 8 + b.length;
  const pixels = Math.max(1, Math.ceil(n / 3));
  const width = Math.max(1, Math.ceil(Math.sqrt(pixels))), height = Math.ceil(pixels / width);
  const rgb = new Uint8Array(width * height * 3);
  rgb.set(PACK_MAGIC, 0);
  new DataView(rgb.buffer).setUint32(4, b.length, false);
  rgb.set(b, 8);
  return { width, height, rgb };
}

export function unpackBytesFromRaster(img: Raster): Uint8Array | null {
  if (img.rgb.length < 8 || Buffer.compare(Buffer.from(img.rgb.subarray(0, 4)), PACK_MAGIC) !== 0) return null;
  const len = new DataView(img.rgb.buffer, img.rgb.byteOffset, img.rgb.byteLength).getUint32(4, false);
  if (8 + len > img.rgb.length) return null;
  return img.rgb.slice(8, 8 + len);
}

// ---------------------------------------------------------------- comment marks

const LINE_COMMENTS: Record<string, string[]> = {
  "//": ["C#", "Swift", "Kotlin", "Scala", "Dart", "Groovy", "Objective-C", "Objective-C++", "Zig", "V", "Solidity", "Haxe", "GLSL", "HLSL",
    "Verilog", "SystemVerilog", "Vala", "ActionScript", "Apex", "Cuda", "Protocol Buffer", "Thrift", "Odin", "Gleam", "Carbon", "Hack", "Ceylon",
    "F#", "D", "Jsonnet", "Processing", "Pascal", "Objective-J", "Dafny", "Game Maker Language"],
  "#": ["Raku", "Shell", "Makefile", "R", "Julia", "Nim", "Crystal", "Elixir", "YAML", "TOML", "Tcl", "CoffeeScript", "PowerShell", "Awk",
    "CMake", "Nix", "Gnuplot", "Cython", "Mojo", "Starlark", "GDScript", "HCL", "Just", "Meson", "Elvish", "Nushell", "Puppet",
    "Cap'n Proto", "Dotenv", "Gherkin", "Janet", "Dockerfile"],
  "--": ["Haskell", "Lua", "SQL", "Elm", "Ada", "VHDL", "Eiffel", "Idris", "Agda", "PureScript", "AppleScript", "PLpgSQL", "Cabal Config", "Lean",
    "Dhall", "Luau", "MoonScript", "PLSQL", "SQLPL", "TSQL"],
  ";": ["Common Lisp", "Clojure", "Scheme", "Emacs Lisp", "Racket", "AutoHotkey", "Hy", "Fennel", "INI"],
  "%": ["Erlang", "TeX", "MATLAB", "Prolog", "PostScript", "Mercury", "BibTeX", "Logtalk"],
  "'": ["Visual Basic .NET", "VBA", "VBScript", "Visual Basic 6.0", "Classic ASP"],
  "REM": ["Batchfile"],
  "!": ["Fortran", "Fortran Free Form"],
  '"': ["Vim script"],
};
/** Every language the comment table names (each must be an exact name in the registry; a test checks). */
export const COMMENT_LANGUAGES: string[] = Object.values(LINE_COMMENTS).flat();
const COMMENT_OF = new Map<string, string>();
for (const [mark, names] of Object.entries(LINE_COMMENTS)) for (const n of names) COMMENT_OF.set(n.toLowerCase(), mark);

/** The line-comment mark of a language, or null when we do not know it. */
export function commentMark(language: string): string | null {
  return COMMENT_OF.get(language.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------- programs

const rows = (b: Uint8Array): string[] => {
  const h = toHex(b), out: string[] = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
};

type Template = (data: string, head: string) => string;
const body = (lines: string[], ind: string): string => lines.map((l) => `${ind}"${l}",`).join("\n");

const TEMPLATES: Record<string, { mark: string; build: Template }> = {
  Python: { mark: "#", build: (d, h) => `# ${h}\n# Run it: python3 file.py > out. It writes the original bytes to standard output.\nimport sys\n\nD = [\n${d}\n]\n\nsys.stdout.buffer.write(bytes.fromhex("".join(D)))\n` },
  JavaScript: { mark: "//", build: (d, h) => `// ${h}\n// Run it: node file.js > out. It writes the original bytes to standard output.\nconst D = [\n${d}\n];\n\nprocess.stdout.write(Buffer.from(D.join(""), "hex"));\n` },
  TypeScript: { mark: "//", build: (d, h) => `// ${h}\n// Run it with a TypeScript runner. It writes the original bytes to standard output.\nconst D: string[] = [\n${d}\n];\n\nprocess.stdout.write(Buffer.from(D.join(""), "hex"));\n` },
  C: { mark: "//", build: (d, h) => `// ${h}\n// Build: cc file.c -o run && ./run > out. It writes the original bytes to standard output.\n#include <stdio.h>\n#include <stdlib.h>\n\nstatic const char *D[] = {\n${d}\n};\n\nint main(void) {\n  for (size_t i = 0; i < sizeof D / sizeof D[0]; i++) {\n    for (const char *s = D[i]; s[0] && s[1]; s += 2) {\n      char h[3] = { s[0], s[1], 0 };\n      putchar((int)strtol(h, NULL, 16));\n    }\n  }\n  return 0;\n}\n` },
  "C++": { mark: "//", build: (d, h) => `// ${h}\n// Build: c++ file.cpp -o run && ./run > out. It writes the original bytes to standard output.\n#include <cstdio>\n#include <cstdlib>\n\nstatic const char *D[] = {\n${d}\n};\n\nint main() {\n  for (const char *row : D) {\n    for (const char *s = row; s[0] && s[1]; s += 2) {\n      char h[3] = { s[0], s[1], 0 };\n      std::putchar(static_cast<int>(std::strtol(h, nullptr, 16)));\n    }\n  }\n  return 0;\n}\n` },
  Java: { mark: "//", build: (d, h) => `// ${h}\n// Run it: java file.java > out. It writes the original bytes to standard output.\nclass Main {\n  static final String[] D = {\n${d}\n  };\n\n  public static void main(String[] args) throws Exception {\n    java.io.OutputStream out = System.out;\n    for (String s : D) {\n      for (int i = 0; i + 1 < s.length(); i += 2) out.write(Integer.parseInt(s.substring(i, i + 2), 16));\n    }\n    out.flush();\n  }\n}\n` },
  Go: { mark: "//", build: (d, h) => `// ${h}\n// Run it: go run file.go > out. It writes the original bytes to standard output.\npackage main\n\nimport (\n\t"encoding/hex"\n\t"os"\n\t"strings"\n)\n\nvar d = []string{\n${d}\n}\n\nfunc main() {\n\tb, err := hex.DecodeString(strings.Join(d, ""))\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tos.Stdout.Write(b)\n}\n` },
  Rust: { mark: "//", build: (d, h) => `// ${h}\n// Build: rustc file.rs && ./file > out. It writes the original bytes to standard output.\nuse std::io::Write;\n\nconst D: &[&str] = &[\n${d}\n];\n\nfn main() {\n    let s: String = D.concat();\n    let out: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();\n    std::io::stdout().write_all(&out).unwrap();\n}\n` },
  Ruby: { mark: "#", build: (d, h) => `# ${h}\n# Run it: ruby file.rb > out. It writes the original bytes to standard output.\nD = [\n${d}\n]\n\n$stdout.binmode\n$stdout.write([D.join].pack("H*"))\n` },
  Perl: { mark: "#", build: (d, h) => `# ${h}\n# Run it: perl file.pl > out. It writes the original bytes to standard output.\nuse strict;\nuse warnings;\n\nmy @d = (\n${d}\n);\n\nbinmode(STDOUT);\nprint pack("H*", join("", @d));\n` },
  PHP: { mark: "//", build: (d, h) => `<?php\n// ${h}\n// Run it: php file.php > out. It writes the original bytes to standard output.\n$d = [\n${d}\n];\n\nfwrite(STDOUT, hex2bin(implode("", $d)));\n` },
};

/** Languages we can write a runnable program in. */
export const PROGRAM_LANGUAGES: string[] = Object.keys(TEMPLATES);

export interface Wrapped { text: string; kind: "program" | "comment" | "plain" }

function markerLine(src: string, n: number, lang: string, form: string, extra = ""): string {
  return `NEUROCLAW-WRAP 1 src=${encodeURIComponent(src)} bytes=${n} lang=${encodeURIComponent(lang)} form=${form}${extra}`;
}

/**
 * Put bytes into a text file of the target language.
 * A language with a template becomes a runnable program; one whose comment mark we know becomes rows in
 * comments; anything else becomes plain rows. `kind` says which, so callers can report it.
 */
export function wrapBytes(bytes: Uint8Array, srcFormat: string, language: string): Wrapped {
  const tpl = TEMPLATES[language];
  const hexRows = rows(bytes);
  if (tpl) {
    const head = markerLine(srcFormat, bytes.length, language, "program");
    const ind = language === "Go" ? "\t" : "  ";
    return { text: tpl.build(body(hexRows.length ? hexRows : [""], ind), head), kind: "program" };
  }
  const mark = commentMark(language);
  const head = markerLine(srcFormat, bytes.length, language, "rows");
  if (mark) {
    const sep = mark === "REM" ? " " : " ";
    return { text: [`${mark}${sep}${head}`, `${mark}${sep}This file holds the original bytes as hexadecimal rows. It is not a program.`, ...hexRows.map((r) => `${mark}${sep}${r}`)].join("\n") + "\n", kind: "comment" };
  }
  return { text: [head, ...hexRows].join("\n") + "\n", kind: "plain" };
}

/** Get the bytes and the format they came from out of anything `wrapBytes` wrote. Null when the text carries no marker. */
export function unwrapBytes(text: string): { bytes: Uint8Array; src: string; lang: string } | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes("NEUROCLAW-WRAP 1 "));
  if (at < 0) return null;
  const line = lines[at];
  const prefix = line.slice(0, line.indexOf("NEUROCLAW-WRAP 1 "));
  const kv: Record<string, string> = {};
  for (const m of line.slice(line.indexOf("NEUROCLAW-WRAP 1 ") + 17).matchAll(/(\w+)=(\S*)/g)) kv[m[1]] = decodeURIComponent(m[2]);
  const n = Number(kv.bytes);
  if (!kv.src || !Number.isInteger(n)) return null;
  const hex: string[] = [];
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowRe = kv.form === "program" ? /^\s*"([0-9a-f]+)",\s*$/ : new RegExp(`^${esc}([0-9a-f]+)\\s*$`);
  for (let i = at + 1; i < lines.length; i++) { const m = rowRe.exec(lines[i]); if (m) hex.push(m[1]); }
  const bytes = Uint8Array.from(Buffer.from(hex.join(""), "hex"));
  if (bytes.length !== n) throw new Error(`Wrapped file says ${n} bytes but carries ${bytes.length}`);
  return { bytes, src: kv.src, lang: kv.lang ?? "" };
}
