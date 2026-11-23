// Stages: cleaning, tokenisation, de-duplication.
// Tokenisation note: the repository forbids a learned tokenizer (OneBrain reads raw UTF-8 bytes). So the pipeline offers
// (1) `bytes()` - the raw UTF-8 byte view the engine consumes, and (2) `words()` - a plain lower-cased word split used ONLY
// by the retrieval index and the lexical classifiers. Neither is learned and neither has a vocabulary file.
import { sha256 } from './util.mjs';

export function clean(s) {
  return String(s ?? '').normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')   // control chars
    .replace(/[​-‍﻿]/g, '')                              // zero-width
    .replace(/<[^>]{1,200}>/g, ' ')                                      // stray html tags
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
export const bytes = (s) => Buffer.from(s, 'utf8');
const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the to was were will with this these those which who whom not no do does did can could may might than then there their they we you i he she his her our your but if so such into over under about also been being'.split(' '));
export function words(s, { stop = true } = {}) {
  const w = String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+(?:[._'-][\p{L}\p{N}]+)*/gu) || [];
  return stop ? w.filter((x) => !STOP.has(x)) : w;
}
/** Light suffix stemmer (Porter-lite): good enough for lexical retrieval, deterministic, no data files. */
export function stem(w) {
  if (w.length < 5) return w;
  let r = w;
  for (const [suf, rep] of [['ational', 'ate'], ['ization', 'ize'], ['iveness', 'ive'], ['fulness', 'ful'], ['ations', 'ate'], ['ation', 'ate'], ['ities', 'ity'], ['ments', 'ment'], ['ingly', ''], ['edly', ''], ['ing', ''], ['ies', 'y'], ['ed', ''], ['es', ''], ['s', ''], ['ly', '']])
    if (w.endsWith(suf) && w.length - suf.length >= 3) { r = w.slice(0, -suf.length) + rep; break; }
  return r.length > 4 && r.endsWith('e') ? r.slice(0, -1) : r;   // increase / increases / increased -> increas
}
export const terms = (s) => words(s).map(stem);

/** Exact + near duplicate removal. Near = Jaccard of 5-word shingles >= threshold, found via MinHash-bucket (LSH-lite). */
export function dedup(records, { key = (r) => r.text, threshold = 0.85, shingle = 5, bands = 8, rows = 4 } = {}) {
  const seen = new Set(), kept = [], dropped = { exact: 0, near: 0 };
  const buckets = new Map(); const sigs = [];
  const H = bands * rows;
  const hash = (str, seed) => { let h = 2166136261 ^ seed; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  for (const r of records) {
    const t = key(r); const norm = words(t, { stop: false }).join(' ');
    const ex = sha256(norm); if (seen.has(ex)) { dropped.exact++; continue; } seen.add(ex);
    const w = norm.split(' '); const sh = new Set();
    if (w.length < shingle) sh.add(norm); else for (let i = 0; i + shingle <= w.length; i++) sh.add(w.slice(i, i + shingle).join(' '));
    const sig = new Array(H).fill(0xffffffff);
    for (const s of sh) for (let k = 0; k < H; k++) { const v = hash(s, k * 0x9e3779b1); if (v < sig[k]) sig[k] = v; }
    let dup = false; const cand = new Set(); const bk = [];
    for (let b = 0; b < bands; b++) { const id = b + ':' + sig.slice(b * rows, (b + 1) * rows).join(','); bk.push(id); for (const c of buckets.get(id) || []) cand.add(c); }
    for (const c of cand) { let eq = 0; for (let k = 0; k < H; k++) if (sigs[c][k] === sig[k]) eq++; if (eq / H >= threshold) { dup = true; break; } }
    if (dup) { dropped.near++; continue; }
    const idx = sigs.push(sig) - 1; for (const id of bk) { if (!buckets.has(id)) buckets.set(id, []); buckets.get(id).push(idx); }
    kept.push(r);
  }
  return { kept, dropped };
}
