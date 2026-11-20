/**
 * Pictures: read and write PNG, PPM / PGM / PBM, BMP and SVG, plus the project's own "text twin",
 * and turn text into a picture of its letters and back.
 *
 * Everything here works on one plain shape, `Raster`: width, height and 3 bytes per pixel (R, G, B),
 * row by row, exactly the raw form docs/TRAINING_CURRICULUM.md uses for images.
 *
 * Own code. PNG compression is Node's own zlib; the PNG writer is the project's `desktop/png.ts`;
 * the letter pictures use the project's own stroke glyphs and pixel reader.
 */
import { inflateSync } from "node:zlib";
import { encodePng } from "./desktop/png.js";
import { GLYPH_W, GLYPH_H, PRINTABLE, makeRng, renderGlyph } from "./stroke-glyphs.js";
import { PixelReader } from "./image-reader.js";

export interface Raster {
  width: number;
  height: number;
  /** width * height * 3 bytes, R G B, row by row. */
  rgb: Uint8Array;
  /** True when the source had transparency that was flattened onto white. */
  flattened?: boolean;
}

/** Refuse pictures bigger than this many pixels; a hostile header could otherwise ask for gigabytes. */
export const MAX_PIXELS = 16_000_000;

function checkSize(w: number, h: number, what: string): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error(`${what}: bad size ${w}x${h}`);
  if (w * h > MAX_PIXELS) throw new Error(`${what}: ${w}x${h} is over the ${MAX_PIXELS} pixel limit`);
}

export const luma = (r: number, g: number, b: number): number => (r * 299 + g * 587 + b * 114) / 1000;

// ---------------------------------------------------------------- PNG

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf: Uint8Array): Raster {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || PNG_SIG.some((v, i) => b[i] !== v)) throw new Error("PNG: missing signature");
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (pos + 8 <= b.length && !sawEnd) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > b.length) throw new Error("PNG: chunk runs past the end of the file");
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = Uint8Array.from(data);
    else if (type === "tRNS") trns = Uint8Array.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") sawEnd = true;
    pos += 12 + len;
  }
  if (!width) throw new Error("PNG: no IHDR");
  checkSize(width, height, "PNG");
  if (interlace) throw new Error("PNG: interlaced files are not supported");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`PNG: colour type ${ctype} at depth ${depth} is not valid`);
  if (ctype === 3 && !palette) throw new Error("PNG: palette picture without a palette");

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG: not enough picture data");

  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const up = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) throw new Error(`PNG: unknown filter ${f}`);
      px[dst + x] = v & 255;
    }
  }

  const sample = (row: number, index: number): number => { // the index-th sample of a row, raw value
    if (depth === 8) return px[row * stride + index];
    if (depth === 16) return (px[row * stride + index * 2] << 8) | px[row * stride + index * 2 + 1];
    const bit = index * depth;
    return (px[row * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const max = (1 << depth) - 1;
  const to8 = (v: number): number => (depth === 8 ? v : Math.round((v * 255) / max));
  const out = new Uint8Array(width * height * 3);
  let flattened = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number, g: number, bl: number, a = 255;
      if (ctype === 0) { r = g = bl = to8(sample(y, x)); }
      else if (ctype === 2) { r = to8(sample(y, x * 3)); g = to8(sample(y, x * 3 + 1)); bl = to8(sample(y, x * 3 + 2)); }
      else if (ctype === 3) {
        const i = sample(y, x);
        r = palette![i * 3] ?? 0; g = palette![i * 3 + 1] ?? 0; bl = palette![i * 3 + 2] ?? 0;
        if (trns && i < trns.length) a = trns[i];
      } else if (ctype === 4) { r = g = bl = to8(sample(y, x * 2)); a = to8(sample(y, x * 2 + 1)); }
      else { r = to8(sample(y, x * 4)); g = to8(sample(y, x * 4 + 1)); bl = to8(sample(y, x * 4 + 2)); a = to8(sample(y, x * 4 + 3)); }
      if (a < 255) { // lay the pixel over white
        flattened = true;
        r = Math.round((r * a + 255 * (255 - a)) / 255); g = Math.round((g * a + 255 * (255 - a)) / 255); bl = Math.round((bl * a + 255 * (255 - a)) / 255);
      }
      const o = (y * width + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = bl;
    }
  }
  return { width, height, rgb: out, flattened };
}

export function encodePngBytes(img: Raster): Uint8Array {
  return Uint8Array.from(encodePng(img.width, img.height, Buffer.from(img.rgb)));
}

// ---------------------------------------------------------------- Netpbm

export type PnmKind = "PPM" | "PGM" | "PBM";

export function decodePnm(buf: Uint8Array): Raster {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < b.length && /\s/.test(String.fromCharCode(b[pos]))) pos++;
      if (b[pos] === 0x23) { while (pos < b.length && b[pos] !== 0x0a) pos++; } else break;
    }
    const start = pos;
    while (pos < b.length && !/\s/.test(String.fromCharCode(b[pos]))) pos++;
    return b.toString("latin1", start, pos);
  };
  const magic = token();
  if (!/^P[1-6]$/.test(magic)) throw new Error("PNM: bad magic number");
  const n = Number(magic[1]);
  const width = Number(token()), height = Number(token());
  checkSize(width, height, "PNM");
  const bitmap = n === 1 || n === 4;
  const maxval = bitmap ? 1 : Number(token());
  if (!bitmap && !(maxval >= 1 && maxval <= 65535)) throw new Error("PNM: bad maximum value");
  const channels = n === 3 || n === 6 ? 3 : 1;
  const out = new Uint8Array(width * height * 3);
  const put = (i: number, c: number[]): void => { out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; };
  const scale = (v: number): number => Math.round((v * 255) / maxval);
  if (n >= 4) {
    pos++; // exactly one whitespace byte after the header
    if (n === 4) {
      const rowBytes = Math.ceil(width / 8);
      if (b.length - pos < rowBytes * height) throw new Error("PNM: file is shorter than its header says");
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const bit = (b[pos + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 0 : 255; put(y * width + x, [v, v, v]);
      }
    } else {
      const wide = maxval > 255, size = wide ? 2 : 1;
      if (b.length - pos < width * height * channels * size) throw new Error("PNM: file is shorter than its header says");
      for (let i = 0; i < width * height; i++) {
        const get = (k: number): number => { const o = pos + (i * channels + k) * size; return scale(wide ? (b[o] << 8) | b[o + 1] : b[o]); };
        if (channels === 3) put(i, [get(0), get(1), get(2)]); else { const v = get(0); put(i, [v, v, v]); }
      }
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      const vals: number[] = [];
      for (let k = 0; k < channels; k++) {
        let v: number;
        if (bitmap) { // plain P1 may run its digits together ("0101"), so read one character at a time
          while (pos < b.length && /\s/.test(String.fromCharCode(b[pos]))) pos++;
          if (pos >= b.length) throw new Error("PNM: file is shorter than its header says");
          v = b[pos++] === 0x31 ? 0 : 255;
        } else {
          const t = token();
          if (t === "") throw new Error("PNM: file is shorter than its header says");
          v = scale(Number(t));
        }
        vals.push(v);
      }
      if (channels === 3) put(i, vals); else put(i, [vals[0], vals[0], vals[0]]);
    }
  }
  return { width, height, rgb: out };
}

export function encodePnm(img: Raster, kind: PnmKind = "PPM"): Uint8Array {
  const head = (magic: string, max: boolean): Buffer => Buffer.from(`${magic}\n${img.width} ${img.height}\n${max ? "255\n" : ""}`, "latin1");
  const n = img.width * img.height;
  if (kind === "PPM") return Uint8Array.from(Buffer.concat([head("P6", true), Buffer.from(img.rgb)]));
  if (kind === "PGM") {
    const g = Buffer.alloc(n);
    for (let i = 0; i < n; i++) g[i] = Math.round(luma(img.rgb[i * 3], img.rgb[i * 3 + 1], img.rgb[i * 3 + 2]));
    return Uint8Array.from(Buffer.concat([head("P5", true), g]));
  }
  const rowBytes = Math.ceil(img.width / 8);
  const bits = Buffer.alloc(rowBytes * img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 3;
    if (luma(img.rgb[o], img.rgb[o + 1], img.rgb[o + 2]) < 128) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Uint8Array.from(Buffer.concat([head("P4", false), bits]));
}

// ---------------------------------------------------------------- BMP

export function decodeBmp(buf: Uint8Array): Raster {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) throw new Error("BMP: missing 'BM'");
  const offset = b.readUInt32LE(10), dib = b.readUInt32LE(14);
  if (dib < 40) throw new Error("BMP: old-style header is not supported");
  const width = b.readInt32LE(18); let height = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28), compression = b.readUInt32LE(30);
  const topDown = height < 0; height = Math.abs(height);
  checkSize(width, height, "BMP");
  if (compression !== 0 && !(compression === 3 && bpp === 32)) throw new Error(`BMP: compression ${compression} is not supported`);
  if (![8, 24, 32].includes(bpp)) throw new Error(`BMP: ${bpp}-bit pictures are not supported`);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  if (b.length < offset + stride * height) throw new Error("BMP: file is shorter than its header says");
  let pal: number[][] = [];
  if (bpp === 8) {
    const colours = b.readUInt32LE(46) || 256;
    for (let i = 0; i < colours; i++) { const o = 14 + dib + i * 4; pal.push([b[o + 2], b[o + 1], b[o]]); }
  }
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (bpp === 8) { const c = pal[b[row + x]] ?? [0, 0, 0]; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; }
      else { const p = row + x * (bpp >> 3); out[o] = b[p + 2]; out[o + 1] = b[p + 1]; out[o + 2] = b[p]; }
    }
  }
  return { width, height, rgb: out };
}

export function encodeBmp(img: Raster): Uint8Array {
  const stride = Math.ceil((img.width * 24) / 32) * 4;
  const size = 54 + stride * img.height;
  const b = Buffer.alloc(size);
  b.write("BM", 0, "latin1"); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(img.width, 18); b.writeInt32LE(img.height, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(stride * img.height, 34);
  b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < img.height; y++) {
    const row = 54 + (img.height - 1 - y) * stride;
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 3, p = row + x * 3;
      b[p] = img.rgb[o + 2]; b[p + 1] = img.rgb[o + 1]; b[p + 2] = img.rgb[o];
    }
  }
  return Uint8Array.from(b);
}

// ---------------------------------------------------------------- SVG (drawing as code)

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
const colourOf = (r: Raster, i: number): string => "#" + hex2(r.rgb[i * 3]) + hex2(r.rgb[i * 3 + 1]) + hex2(r.rgb[i * 3 + 2]);

/** The picture as an SVG: one background rectangle, then one rectangle per run of same-coloured pixels. */
export function encodeSvg(img: Raster): Uint8Array {
  const n = img.width * img.height;
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) { const c = colourOf(img, i); counts.set(c, (counts.get(c) ?? 0) + 1); }
  let bg = "#ffffff", best = -1;
  for (const [c, k] of counts) if (k > best) { best = k; bg = c; }
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}" viewBox="0 0 ${img.width} ${img.height}" shape-rendering="crispEdges">`,
    `<rect width="${img.width}" height="${img.height}" fill="${bg}"/>`,
  ];
  for (let y = 0; y < img.height; y++) {
    let x = 0;
    while (x < img.width) {
      const c = colourOf(img, y * img.width + x);
      let e = x + 1;
      while (e < img.width && colourOf(img, y * img.width + e) === c) e++;
      if (c !== bg) out.push(`<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="${c}"/>`);
      x = e;
    }
  }
  out.push("</svg>", "");
  return Uint8Array.from(Buffer.from(out.join("\n"), "utf8"));
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080",
  grey: "#808080", orange: "#ffa500", purple: "#800080", cyan: "#00ffff", magenta: "#ff00ff", lime: "#00ff00", pink: "#ffc0cb",
};

function parseColour(s: string | undefined): [number, number, number] | null {
  if (!s) return null;
  let v = s.trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  if (NAMED[v]) v = NAMED[v];
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)) as [number, number, number];
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (m) return [Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3])];
  throw new Error(`SVG: colour ${JSON.stringify(s)} is not supported`);
}

const attrs = (tag: string): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = m[2] ?? m[3];
  return o;
};

/** Read an SVG made of rectangles, circles and ellipses with plain fills. Anything else is refused, not guessed. */
export function decodeSvg(buf: Uint8Array): Raster {
  const text = Buffer.from(buf).toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
  const root = /<svg\b[^>]*>/i.exec(text);
  if (!root) throw new Error("SVG: no <svg> element");
  const ra = attrs(root[0]);
  let vb = ra.viewBox ? ra.viewBox.trim().split(/[\s,]+/).map(Number) : null;
  const num = (s: string | undefined): number | null => { const m = s ? /^\s*(-?[\d.]+)(px)?\s*$/.exec(s) : null; return m ? Number(m[1]) : null; };
  const width = Math.round(num(ra.width) ?? (vb ? vb[2] : NaN)), height = Math.round(num(ra.height) ?? (vb ? vb[3] : NaN));
  checkSize(width, height, "SVG");
  const sx = vb ? width / vb[2] : 1, sy = vb ? height / vb[3] : 1, ox = vb ? vb[0] : 0, oy = vb ? vb[1] : 0;
  const out = new Uint8Array(width * height * 3).fill(255);
  const body = text.slice(root.index + root[0].length);
  for (const m of body.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*?)\/?>/g)) {
    const tag = m[1].toLowerCase();
    if (tag === "svg" || tag === "g" || tag === "title" || tag === "desc") continue;
    const a = attrs(m[2]);
    if (a.transform) throw new Error("SVG: transforms need a rasteriser, which this converter does not have");
    const fill = parseColour(a.fill ?? (a.style ? /fill:\s*([^;]+)/.exec(a.style)?.[1] : undefined) ?? "#000000");
    const N = (k: string, d = 0): number => num(a[k]) ?? d;
    let test: ((x: number, y: number) => boolean) | null = null;
    if (tag === "rect") {
      const x0 = (N("x") - ox) * sx, y0 = (N("y") - oy) * sy, x1 = x0 + N("width", width / sx) * sx, y1 = y0 + N("height", height / sy) * sy;
      const rx0 = Math.round(x0), rx1 = Math.round(x1), ry0 = Math.round(y0), ry1 = Math.round(y1);
      test = (x, y) => x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
    } else if (tag === "circle" || tag === "ellipse") {
      const cx = (N("cx") - ox) * sx, cy = (N("cy") - oy) * sy;
      const rx = (tag === "circle" ? N("r") : N("rx")) * sx, ry = (tag === "circle" ? N("r") : N("ry")) * sy;
      test = (x, y) => rx > 0 && ry > 0 && ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
    } else throw new Error(`SVG: <${tag}> needs a rasteriser, which this converter does not have (only rect, circle and ellipse)`);
    if (!fill) continue;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (test(x, y)) {
      const o = (y * width + x) * 3; out[o] = fill[0]; out[o + 1] = fill[1]; out[o + 2] = fill[2];
    }
  }
  return { width, height, rgb: out };
}

// ---------------------------------------------------------------- text twin

/** Lightest to heaviest. Brightness picks the character, so on a dark page bright pixels look heavy. */
export const RAMP = " .:-=+*#%@";

const rampIndex = (r: number, g: number, b: number): number => Math.min(RAMP.length - 1, Math.floor((luma(r, g, b) / 256) * RAMP.length));

/** Shrink by averaging boxes so the text is at most `maxCols` wide. Only used for the picture-to-text-art direction. */
export function shrink(img: Raster, maxCols: number): Raster {
  if (img.width <= maxCols) return img;
  const f = Math.ceil(img.width / maxCols);
  const w = Math.ceil(img.width / f), h = Math.ceil(img.height / f);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = [0, 0, 0]; let n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const px = x * f + dx, py = y * f + dy;
      if (px >= img.width || py >= img.height) continue;
      const o = (py * img.width + px) * 3; s[0] += img.rgb[o]; s[1] += img.rgb[o + 1]; s[2] += img.rgb[o + 2]; n++;
    }
    for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = Math.round(s[k] / n);
  }
  return { width: w, height: h, rgb: out };
}

/**
 * The text twin: one character per pixel, plus (when `colour` is true) a parallel colour plane so the
 * picture comes back exactly. Without the colour plane it is plain text art and only brightness survives.
 */
export function encodeTwin(img: Raster, colour = true): string {
  const lines: string[] = [`TWIN 1 ${img.width} ${img.height}`];
  for (let y = 0; y < img.height; y++) {
    let row = "";
    for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 3; row += RAMP[rampIndex(img.rgb[o], img.rgb[o + 1], img.rgb[o + 2])]; }
    lines.push(row);
  }
  if (colour) {
    lines.push("COLOUR");
    for (let y = 0; y < img.height; y++) {
      let row = "";
      for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 3; row += hex2(img.rgb[o]) + hex2(img.rgb[o + 1]) + hex2(img.rgb[o + 2]); }
      lines.push(row);
    }
  }
  return lines.join("\n") + "\n";
}

export function decodeTwin(text: string): Raster {
  const lines = text.split(/\r?\n/);
  const m = /^TWIN 1 (\d+) (\d+)$/.exec(lines[0] ?? "");
  if (!m) throw new Error("Text twin: first line must be 'TWIN 1 <width> <height>'");
  const width = Number(m[1]), height = Number(m[2]);
  checkSize(width, height, "Text twin");
  const grid = lines.slice(1, 1 + height);
  if (grid.length < height || grid.some((l) => l.length !== width)) throw new Error("Text twin: the character grid does not match the size in the header");
  const out = new Uint8Array(width * height * 3);
  const ci = lines.indexOf("COLOUR", 1 + height);
  if (ci >= 0) {
    for (let y = 0; y < height; y++) {
      const row = lines[ci + 1 + y] ?? "";
      if (row.length !== width * 6 || /[^0-9a-f]/.test(row)) throw new Error("Text twin: colour plane does not match the size in the header");
      for (let i = 0; i < width * 3; i++) out[y * width * 3 + i] = parseInt(row.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const k = RAMP.indexOf(grid[y][x]);
      if (k < 0) throw new Error(`Text twin: ${JSON.stringify(grid[y][x])} is not on the ramp`);
      const v = Math.round(((k + 0.5) / RAMP.length) * 255);
      const o = (y * width + x) * 3; out[o] = out[o + 1] = out[o + 2] = v;
    }
  }
  return { width, height, rgb: out };
}

// ---------------------------------------------------------------- text <-> a picture of its letters

const CLEAN = { shift: 0, scale: 0, tilt: 0, width: [1.6, 1.6] as [number, number], speckle: 0 };
const glyphCache = new Map<string, Uint8Array>();
const glyph = (ch: string): Uint8Array => {
  let g = glyphCache.get(ch);
  if (!g) { g = renderGlyph(ch, makeRng(1), CLEAN); glyphCache.set(ch, g); }
  return g;
};

export const CELL_W = GLYPH_W, CELL_H = GLYPH_H;

export interface TextPicture { raster: Raster; lossy: boolean }

/** Draw the text in the project's own stroke letters, black on white. Tabs become 4 spaces; anything that is not printable ASCII becomes "?" and marks the result lossy. */
export function textToImage(text: string, maxCols = 64): TextPicture {
  let lossy = false;
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const ch of raw.replace(/\t/g, "    ")) {
      if (ch >= " " && ch <= "~") line += ch; else { line += "?"; lossy = true; }
    }
    if (line.length > maxCols) lossy = true; // wrapped lines read back as separate lines
    do { lines.push(line.slice(0, maxCols)); line = line.slice(maxCols); } while (line.length);
  }
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const cols = Math.max(1, ...lines.map((l) => l.length));
  const width = cols * CELL_W, height = lines.length * CELL_H;
  checkSize(width, height, "Text picture");
  const rgb = new Uint8Array(width * height * 3).fill(255);
  lines.forEach((line, row) => {
    for (let c = 0; c < line.length; c++) {
      const g = glyph(line[c]);
      for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) if (g[y * CELL_W + x]) {
        const o = ((row * CELL_H + y) * width + c * CELL_W + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 0;
      }
    }
  });
  return { raster: { width, height, rgb }, lossy };
}

let reader: PixelReader | null = null;
const getReader = (): PixelReader => {
  if (!reader) {
    reader = new PixelReader();
    reader.train(PRINTABLE.map((c) => ({ char: c, bits: glyph(c) })));
  }
  return reader;
};

/** Read letters back out of a picture laid out in 16x20 cells (what `textToImage` draws). Trailing spaces on a line are dropped. */
export function imageToText(img: Raster): string {
  if (img.width % CELL_W || img.height % CELL_H) throw new Error(`Reading text needs a picture a whole number of ${CELL_W}x${CELL_H} letter cells across and down; this one is ${img.width}x${img.height}`);
  const rd = getReader();
  const lines: string[] = [];
  for (let row = 0; row < img.height / CELL_H; row++) {
    let line = "";
    for (let c = 0; c < img.width / CELL_W; c++) {
      const bits = new Uint8Array(CELL_W * CELL_H);
      for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) {
        const o = ((row * CELL_H + y) * img.width + c * CELL_W + x) * 3;
        bits[y * CELL_W + x] = luma(img.rgb[o], img.rgb[o + 1], img.rgb[o + 2]) < 128 ? 1 : 0;
      }
      line += rd.classify(bits);
    }
    lines.push(line.replace(/ +$/, ""));
  }
  return lines.join("\n");
}

let glyphKeys: Map<string, string> | null = null;

/**
 * If the picture is exactly a drawing of text in the project's stroke letters (every 16x20 cell is
 * one letter, pixel for pixel, and at least one is not blank), the text. Otherwise null. A photo or a
 * plain graphic never matches, so this is safe to try on any picture. Trailing spaces and blank lines
 * cannot be seen in a picture and come back as one final newline.
 */
export function lettersOf(img: Raster): string | null {
  if (img.width % CELL_W || img.height % CELL_H) return null;
  if (!glyphKeys) glyphKeys = new Map(PRINTABLE.map((c) => [Array.from(glyph(c)).join(""), c]));
  const lines: string[] = [];
  let ink = false;
  for (let row = 0; row < img.height / CELL_H; row++) {
    let line = "";
    for (let c = 0; c < img.width / CELL_W; c++) {
      const bits = new Array<number>(CELL_W * CELL_H);
      for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) {
        const o = ((row * CELL_H + y) * img.width + c * CELL_W + x) * 3;
        const r = img.rgb[o], g = img.rgb[o + 1], b = img.rgb[o + 2];
        if (!((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255))) return null; // only pure black ink on pure white
        bits[y * CELL_W + x] = r === 0 ? 1 : 0;
      }
      const ch = glyphKeys.get(bits.join(""));
      if (ch === undefined) return null;
      if (ch !== " ") ink = true;
      line += ch;
    }
    lines.push(line.replace(/ +$/, ""));
  }
  if (!ink) return null;
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- pixels as a table

/** Rows of x, y, r, g, b. */
export function rasterToRows(img: Raster): string[][] {
  const rows: string[][] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 3;
    rows.push([String(x), String(y), String(img.rgb[o]), String(img.rgb[o + 1]), String(img.rgb[o + 2])]);
  }
  return rows;
}

export function rowsToRaster(header: string[], rows: string[][]): Raster | null {
  if (header.join(",") !== "x,y,r,g,b" || !rows.length) return null;
  let w = 0, h = 0;
  for (const r of rows) { w = Math.max(w, Number(r[0]) + 1); h = Math.max(h, Number(r[1]) + 1); }
  if (!(w > 0 && h > 0) || w * h !== rows.length) return null;
  checkSize(w, h, "Pixel table");
  const rgb = new Uint8Array(w * h * 3);
  for (const r of rows) {
    const x = Number(r[0]), y = Number(r[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) return null;
    for (let k = 0; k < 3; k++) { const v = Number(r[2 + k]); if (!(v >= 0 && v <= 255)) return null; rgb[(y * w + x) * 3 + k] = v; }
  }
  return { width: w, height: h, rgb };
}
