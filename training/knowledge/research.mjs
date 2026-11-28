// Evidence-first answering: retrieve, cite, compare sources, flag conflicts and uncertainty. Extractive only: it quotes
// retrieved sentences with citations and never writes an answer that is not in a source.
import { loadArtifact } from './registry.mjs';
import { deserialize, search } from './retrieval.mjs';
import { loadCollection } from './evaluate.mjs';
import { bestSentences, compareSources, verifyClaim } from './verify.mjs';
import { currentRecord } from './registry.mjs';

let cache = null;
function state() {
  if (cache) return cache;
  const art = loadArtifact('retriever.science'); if (!art) throw new Error('no promoted retriever.science checkpoint: run `node training/knowledge/cli.mjs run` first');
  const docs = loadCollection('science'); cache = { index: deserialize(art), byId: new Map(docs.map((d) => [d.id, d])), ver: currentRecord('retriever.science').version }; return cache;
}
export function research(question, { k = 5 } = {}) {
  const { index, byId, ver } = state(); const hits = search(index, question, { k });
  const results = hits.map((h) => { const d = byId.get(h.id); const s = d.sentences ? bestSentences(question, d, 1)[0] : null;
    return { citation: { id: h.id, title: h.title, source: h.source, url: h.url, license: h.license, level: h.level }, score: +h.score.toFixed(2), passage: s ? s.t : d.text.slice(0, 280) }; });
  const cmp = compareSources(question, byId, hits);
  const strength = hits.length ? (hits[0].score >= 15 ? 'strong lexical match' : hits[0].score >= 8 ? 'partial match' : 'weak match') : 'nothing found';
  const preprint = results.every((r) => /preprint/.test(r.citation.level));
  return { question, retriever: 'retriever.science@' + ver, evidence: results, conflict: cmp.conflict ? cmp : null, confidence: strength,
    caveats: [...(strength !== 'strong lexical match' ? ['retrieval match is not strong: treat as a lead, not an answer'] : []), ...(preprint ? ['all evidence is from unreviewed preprints'] : []), ...(cmp.conflict ? ['sources disagree (cue-based): needs human review'] : [])] };
}
export function verify(claim, params) { const { index, byId } = state(); return verifyClaim(index, byId, claim, params); }
