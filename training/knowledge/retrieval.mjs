// BM25 retrieval over a document collection, with optional title boost and stemming. In-memory, no dependencies,
// serialisable to JSON, so an index is a versionable checkpoint. Each hit keeps the source, licence and evidence level.
import { terms, words } from './text.mjs';

export const DEFAULTS = { k1: 1.2, b: 0.75, stem: false, titleBoost: 1 };

export function buildIndex(docs, params = {}) {
  const p = { ...DEFAULTS, ...params }; const tk = p.stem ? terms : (s) => words(s);
  const post = new Map(), meta = []; let total = 0;
  docs.forEach((d, i) => {
    const t = [...tk(d.text)]; for (let r = 1; r < p.titleBoost; r++) t.push(...tk(d.title || ''));
    const tf = new Map(); for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
    for (const [w, c] of tf) { let a = post.get(w); if (!a) post.set(w, (a = [])); a.push(i, c); }
    meta.push({ id: d.id, len: t.length, source: d.source, title: d.title, level: d.level, license: d.license, nc: d.nc, url: d.url });
    total += t.length;
  });
  return { params: p, n: docs.length, avgdl: total / Math.max(1, docs.length), meta, post };
}

export function search(index, query, { k = 10, source, filter } = {}) {
  const p = index.params; const q = [...new Set((p.stem ? terms : (s) => words(s))(query))]; const sc = new Map();
  for (const w of q) {
    const a = index.post.get(w); if (!a) continue; const df = a.length / 2;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (let j = 0; j < a.length; j += 2) {
      const i = a[j], tf = a[j + 1], m = index.meta[i];
      if (source && m.source !== source) continue; if (filter && !filter(m)) continue;
      sc.set(i, (sc.get(i) || 0) + idf * (tf * (p.k1 + 1)) / (tf + p.k1 * (1 - p.b + p.b * m.len / index.avgdl)));
    }
  }
  return [...sc].sort((x, y) => y[1] - x[1]).slice(0, k).map(([i, s]) => ({ ...index.meta[i], score: s }));
}

export const serialize = (index) => ({ params: index.params, n: index.n, avgdl: index.avgdl, meta: index.meta, post: [...index.post] });
export const deserialize = (o) => ({ ...o, post: new Map(o.post) });

// ---- ranking metrics ----
export function metrics(rankings, rels, k = 10) {
  // rankings: [[docId,...]], rels: [Set(docId)]
  let rec = 0, mrr = 0, ndcg = 0, n = 0;
  rankings.forEach((r, i) => {
    const rel = rels[i]; if (!rel.size) return; n++; const top = r.slice(0, k);
    rec += top.filter((d) => rel.has(d)).length / rel.size;
    const first = top.findIndex((d) => rel.has(d)); if (first >= 0) mrr += 1 / (first + 1);
    let dcg = 0; top.forEach((d, j) => { if (rel.has(d)) dcg += 1 / Math.log2(j + 2); });
    let idcg = 0; for (let j = 0; j < Math.min(rel.size, k); j++) idcg += 1 / Math.log2(j + 2);
    ndcg += dcg / idcg;
  });
  return { n, [`recall@${k}`]: +(rec / n).toFixed(4), [`mrr@${k}`]: +(mrr / n).toFixed(4), [`ndcg@${k}`]: +(ndcg / n).toFixed(4) };
}
