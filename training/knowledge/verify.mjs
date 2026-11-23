// Claim verification and source comparison on top of retrieval.
// verifyClaim(): retrieve candidate abstracts -> pick the best sentences -> stance (SUPPORT / CONTRADICT) by lexical cues
//               -> NOT_ENOUGH_INFO when the best match is weak. Honest limits: stance is a cue heuristic, not language understanding.
// compareSources(): given hits for one claim, flag when different sources point in opposite directions.
import { search } from './retrieval.mjs';
import { terms, words, stem } from './text.mjs';
const toks = (s) => words(s, { stop: false }).map(stem);   // negations are stop words in retrieval, so polarity needs the unfiltered view

const NEG = new Set(['no', 'not', 'without', 'fail', 'fails', 'failed', 'absent', 'lack', 'lacks', 'neither', 'nor', 'never', 'unchanged', 'ineffective', 'nonsignificant', 'insignificant']);
const ANTONYMS = [['increase', 'decrease'], ['higher', 'lower'], ['more', 'less'], ['improve', 'worsen'], ['enhance', 'reduce'], ['up', 'down'], ['promote', 'inhibit'], ['activate', 'suppress'], ['upregulate', 'downregulate'], ['gain', 'loss'], ['positive', 'negative'], ['risk', 'protect'], ['benefit', 'harm'], ['induce', 'prevent'], ['elevate', 'lower']];
const stemw = (w) => stem(w);
const ANT = new Map(); for (const [a, b] of ANTONYMS) { ANT.set(stemw(a), stemw(b)); ANT.set(stemw(b), stemw(a)); }
const stemNeg = new Set([...NEG].map(stemw));

/** polarity score: > 0 means the sentence agrees with the claim, < 0 means it opposes it (by cue words only). */
export function stance(claim, sentence) {
  const c = toks(claim), s = new Set(toks(sentence)); let flip = 0;
  const cneg = c.filter((w) => stemNeg.has(w)).length % 2, sneg = [...s].filter((w) => stemNeg.has(w)).length % 2;
  if (cneg !== sneg) flip++;
  for (const w of c) { const a = ANT.get(w); if (a && s.has(a) && !s.has(w)) flip++; }
  return flip % 2 ? -1 : 1;
}

export function bestSentences(claim, doc, n = 2) {
  const cw = new Set(terms(claim));
  return (doc.sentences || []).map((t, i) => ({ i, t, s: terms(t).filter((w) => cw.has(w)).length / Math.sqrt(1 + terms(t).length) })).sort((a, b) => b.s - a.s).slice(0, n);
}

export function verifyClaim(index, docsById, claim, { k = 5, minScore = 8, source = 'scifact' } = {}) {
  const hits = search(index, claim, { k, source }); const top = hits[0];
  if (!top || top.score < minScore) return { label: 'NOT_ENOUGH_INFO', reason: 'no retrieved document matches the claim strongly enough', hits };
  const doc = docsById.get(top.id); const sents = bestSentences(claim, doc);
  const pol = stance(claim, sents.map((x) => x.t).join(' '));
  return { label: pol > 0 ? 'SUPPORT' : 'CONTRADICT', doc: top.id, evidence: sents.map((x) => ({ sentence: x.i, text: x.t })), citation: { id: top.id, source: top.source, url: top.url, license: top.license, level: top.level }, score: top.score, hits };
}

export function compareSources(claim, docsById, hits, { minOverlap = 0.25 } = {}) {
  const cw = new Set(terms(claim)); const votes = [];
  for (const h of hits) {
    const d = docsById.get(h.id); if (!d) continue; const best = bestSentences(claim, d, 1)[0]; if (!best || best.s < minOverlap) continue;
    votes.push({ id: h.id, source: h.source, stance: stance(claim, best.t) > 0 ? 'agrees' : 'disagrees', sentence: best.t });
  }
  const agree = votes.filter((v) => v.stance === 'agrees'), dis = votes.filter((v) => v.stance === 'disagrees');
  return { conflict: agree.length > 0 && dis.length > 0, agree, disagree: dis, note: 'cue-based stance: a flagged conflict is a prompt for human review, not a verdict' };
}
