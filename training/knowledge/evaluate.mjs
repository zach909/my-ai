// Benchmarks. Each function returns a flat {metric: number} object so the registry gate can compare versions.
// Held-out discipline: parameters are tuned on SciFact *train* claims / ESC-50 folds 1-4 and reported on *dev* / fold 5.
import { dir, path, existsSync, readFileSync, readJson, readJsonl, writeJson, today, HERE, sha256 } from './util.mjs';
import { buildIndex, search, metrics } from './retrieval.mjs';
import { verifyClaim } from './verify.mjs';
import { classifyText, classifyCode, gate } from './safety.mjs';
import { loadKB } from './reason/lang.mjs';
import { loadSources } from './sources/index.mjs';
import { validateRaw } from './collect.mjs';

const P = (...a) => path.join(dir('processed'), ...a);
export const evalFile = (n) => readJsonl(path.join(HERE, 'eval', n));
export const loadCollection = (n) => (existsSync(P('collections', n + '.jsonl')) ? readJsonl(P('collections', n + '.jsonl')) : []);
export const loadEval = (n) => readJson(P('eval', n + '.json'));

const evidenceIds = (c) => new Set(Object.keys(c.evidence).map((x) => 'scifact:' + x));

export function benchScifact(index, split = 'dev', k = 10) {
  const claims = loadEval('scifact_claims')[split].filter((c) => Object.keys(c.evidence).length);
  const m = metrics(claims.map((c) => search(index, c.claim, { k, source: 'scifact' }).map((h) => h.id)), claims.map(evidenceIds), k);
  return Object.fromEntries(Object.entries(m).map(([a, v]) => ['scifact.' + a, v]));
}

/** QASPER: given a question and the paragraphs of its own paper, does the ranking put a gold evidence paragraph near the top? */
export function benchQasper(params, split = 'dev', maxPapers = Infinity) {
  const papers = loadEval('qasper_evidence')[split].slice(0, maxPapers); const rk = [], rl = [];
  for (const p of papers) {
    const ix = buildIndex(p.paragraphs.map((t, i) => ({ id: String(i), text: t })), params);
    for (const q of p.qs) { rk.push(search(ix, q.q, { k: 5 }).map((h) => h.id)); rl.push(new Set(q.ev.map(String))); }
  }
  const m3 = metrics(rk, rl, 3), m5 = metrics(rk, rl, 5);
  return { 'qasper.recall@3': m3['recall@3'], 'qasper.mrr@5': m5['mrr@5'], 'qasper.n': m3.n };
}

export function benchCode(index) {
  const qs = evalFile('code_queries.jsonl');
  const rk = qs.map((q) => search(index, q.query, { k: 5 }).map((h) => h.id.split(':').pop())); const rl = qs.map((q) => new Set([q.relevant]));
  const m = metrics(rk, rl, 3), m5 = metrics(rk, rl, 5);
  return { 'code.recall@3': m['recall@3'], 'code.mrr@5': m5['mrr@5'], 'code.n': m.n };
}

const goldLabel = (c) => { const ls = Object.values(c.evidence).flat().map((e) => e.label); if (!ls.length) return 'NOT_ENOUGH_INFO'; const s = ls.filter((l) => l === 'SUPPORT').length; return s >= ls.length - s ? 'SUPPORT' : 'CONTRADICT'; };
export function benchVerify(index, params, split = 'dev') {
  const docs = loadCollection('science').filter((d) => d.source === 'scifact'); const byId = new Map(docs.map((d) => [d.id, d]));
  const claims = loadEval('scifact_claims')[split]; let ok = 0, sp = 0, sn = 0, base = 0; const counts = {};
  for (const c of claims) {
    const g = goldLabel(c); counts[g] = (counts[g] || 0) + 1;
    const r = verifyClaim(index, byId, c.claim, params); if (r.label === g) ok++;
    if (r.label === 'SUPPORT') { sn++; if (g === 'SUPPORT' && r.doc && c.cited_doc_ids.map((x) => 'scifact:' + x).includes(r.doc)) sp++; }
  }
  base = Math.max(...Object.values(counts)) / claims.length;
  return { 'verify.acc': +(ok / claims.length).toFixed(4), 'verify.majority_baseline': +base.toFixed(4), 'verify.support_precision': sn ? +(sp / sn).toFixed(4) : 0, 'verify.n': claims.length };
}

export function benchSafety() {
  const items = evalFile('safety.jsonl'); let ok = 0; const by = {}, wrong = [];
  let harmTotal = 0, harmRefused = 0, goodTotal = 0, goodRefused = 0;
  for (const it of items) {
    const r = it.mode === 'code' ? classifyCode(it.text) : classifyText(it.text);
    const hit = r.cls === it.cls; if (hit) ok++; else wrong.push({ text: it.text.slice(0, 60), want: it.cls, got: r.cls });
    (by[it.mode] ||= { n: 0, ok: 0 }).n++; if (hit) by[it.mode].ok++;
    if (it.mode === 'request') { const g = gate(it.text); const bad = ['MALICIOUS_INSTRUCTION', 'HARMFUL', 'DECEPTIVE'].includes(it.cls);
      if (bad) { harmTotal++; if (!g.allow) harmRefused++; } if (it.cls === 'GOOD') { goodTotal++; if (!g.allow) goodRefused++; } }
  }
  return { metrics: { 'safety.accuracy': +(ok / items.length).toFixed(4), 'safety.harm_refusal_recall': +(harmRefused / harmTotal).toFixed(4), 'safety.false_refusal_rate': +(goodRefused / goodTotal).toFixed(4), 'safety.n': items.length }, byMode: by, wrong };
}

export function benchReasoning() {
  const cases = evalFile('reasoning.jsonl'); const fails = []; let ok = 0;
  for (const c of cases) {
    let pass = false, got;
    try {
      const e = loadKB(c.kb); const r = e.ask(c.ask); got = r.status;
      pass = r.status === c.status && (c.conf === undefined || Math.abs(r.confidence - c.conf) < 1e-9) && (!c.unmet || c.unmet.every((u) => e.unmet.some((x) => x.condition === u)));
      if (pass && r.proof && !e.verifyProof(r.proof)) { pass = false; got += ' (proof failed re-check)'; }
    } catch (err) { got = 'ERROR'; pass = c.status === 'ERROR'; }
    if (pass) ok++; else fails.push({ name: c.name, want: c.status, got });
  }
  return { metrics: { 'reasoning.accuracy': +(ok / cases.length).toFixed(4), 'reasoning.n': cases.length }, fails };
}

export function benchFacts() {
  const e = loadKB(readFileSync(path.join(HERE, 'kb', 'core_science.kb'), 'utf8')); const items = evalFile('facts.jsonl'); let ok = 0; const fails = [];
  for (const it of items) { const r = e.ask(it.ask); if (r.status === it.status && (!r.proof || e.verifyProof(r.proof))) ok++; else fails.push({ ask: it.ask, want: it.status, got: r.status }); }
  return { metrics: { 'facts.accuracy': +(ok / items.length).toFixed(4), 'facts.n': items.length, 'facts.contradictions_in_seed_kb': e.contradictions.length }, fails };
}

/** Data quality + provenance: every document names its source, licence and URL; sources exist in the catalogue; raw files still match their hashes. */
export function benchDataQuality() {
  const sources = new Map(loadSources().map((s) => [s.id, s])); let docs = 0, missing = 0, badSource = 0, licMismatch = 0, ncFlagWrong = 0, empty = 0;
  const dupText = new Set(); let dup = 0;
  for (const name of ['science', 'code', 'audio-text', 'symbols', 'music']) for (const d of loadCollection(name)) {
    docs++; if (!d.source || !d.license || !d.url || !d.level) missing++;
    const s = sources.get(d.source); if (!s) badSource++; else { if (s.license !== d.license) licMismatch++; if (!!s.nc !== !!d.nc) ncFlagWrong++; if (s.use !== 'train') badSource++; }
    if (!d.text || d.text.length < 20) empty++; const h = sha256(Buffer.from(d.text)); if (dupText.has(h)) dup++; dupText.add(h);
  }
  const raw = validateRaw();
  return { metrics: { 'quality.docs': docs, 'quality.missing_provenance': missing, 'quality.unknown_or_untrainable_source': badSource, 'quality.license_mismatch': licMismatch, 'quality.nc_flag_wrong': ncFlagWrong, 'quality.empty_docs': empty, 'quality.exact_duplicates': dup, 'quality.raw_files_verified': raw.ok, 'quality.raw_hash_problems': raw.problems.length }, rawProblems: raw.problems };
}

/** Source verification: the pipeline must be able to say where a retrieved passage came from and that the source is licensed for this use. */
export function benchSourceVerification(index) {
  const sources = new Map(loadSources().map((s) => [s.id, s])); const hits = search(index, 'oxidative stress and neurodegeneration', { k: 10 }); let ok = 0;
  for (const h of hits) { const s = sources.get(h.source); if (s && h.url && h.license === s.license && s.use === 'train') ok++; }
  return { 'sourcecheck.citable_fraction': hits.length ? +(ok / hits.length).toFixed(4) : 0 };
}
