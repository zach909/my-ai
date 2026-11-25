// Model training + the continuous-improvement loop. Components are independent: each has its own data, trainer,
// benchmark and gate, and is versioned separately in registry.json.
//   collect -> validate -> extract -> train (candidate) -> evaluate -> gate -> promote or keep the old version
import { dir, path, existsSync, readFileSync, writeFileSync, readJson, writeJson, csvObjects, readJsonl } from './util.mjs';
import { buildIndex, serialize, deserialize } from './retrieval.mjs';
import { loadCollection, benchScifact, benchQasper, benchCode, benchVerify, loadEval } from './evaluate.mjs';
import { registerCandidate, tryPromote, currentRecord, loadArtifact, load as loadRegistry } from './registry.mjs';
import { features, readWav, trainAudio, predictAudio, confusion } from './audio.mjs';
import { loadSources } from './sources/index.mjs';

const BASELINE = { k1: 1.2, b: 0.75, stem: false, titleBoost: 1 };
const inputsOf = (docs) => { const S = new Map(loadSources().map((s) => [s.id, s])); return [...new Set(docs.map((d) => d.source))].map((id) => ({ source: id, license: S.get(id).license, nc: !!S.get(id).nc, sa: !!S.get(id).sa })); };
const log = (...a) => console.log('[train]', ...a);

// ---------- retriever.science ----------
function sciMetrics(index, params, split) {
  return { ...benchScifact(index, split), ...benchQasper(params, split, 120) };
}
export function trainRetriever(name, params) { const docs = loadCollection(name); return { index: buildIndex(docs, params), inputs: inputsOf(docs), docs: docs.length }; }

/** Grid-search on SciFact TRAIN claims, then report the winner on DEV (never tuned on dev). */
export function tuneRetriever() {
  const docs = loadCollection('science'); let best = null; const tried = [];
  for (const stem of [false, true]) for (const titleBoost of [1, 2]) for (const k1 of [0.9, 1.2, 1.6]) for (const b of [0.5, 0.75, 0.9]) {
    const p = { k1, b, stem, titleBoost }; const ix = buildIndex(docs, p); const s = benchScifact(ix, 'train')['scifact.ndcg@10'];
    tried.push({ ...p, trainNdcg: s }); if (!best || s > best.s) best = { p, s };
  }
  return { best: best.p, trainNdcg: best.s, tried };
}

// ---------- audio ----------
export function audioDataset() {
  const cache = path.join(dir('processed'), 'audio_features.json'); const root = dir('raw', 'esc50');
  if (!existsSync(path.join(root, 'esc50.csv'))) return null;
  const have = new Set(existsSync(path.join(root, 'audio')) ? require_ls(path.join(root, 'audio')) : []);
  const rows = csvObjects(readFileSync(path.join(root, 'esc50.csv'), 'utf8')).filter((r) => have.has(r.filename));
  const c = existsSync(cache) ? readJson(cache) : {}; let dirty = false;
  for (const r of rows) if (!c[r.filename]) { const w = readWav(readFileSync(path.join(root, 'audio', r.filename))); c[r.filename] = features(w.samples, w.sr); dirty = true; }
  if (dirty) writeJson(cache, c);
  return rows.map((r) => ({ f: c[r.filename], y: r.category, fold: Number(r.fold), file: r.filename }));
}
import { readdirSync } from 'node:fs';
const require_ls = (d) => readdirSync(d);

export function trainAudioComponent() {
  const data = audioDataset(); if (!data) return null;
  const tr = data.filter((d) => d.fold < 5), te = data.filter((d) => d.fold === 5);
  // model selection by leave-one-fold-out CV on folds 1-4 only
  const cands = [{ mode: 'centroid' }, { mode: 'knn', k: 3 }, { mode: 'knn', k: 5 }, { mode: 'knn', k: 7 }]; const cv = [];
  for (const c of cands) { let ok = 0, n = 0; for (const f of [1, 2, 3, 4]) { const a = tr.filter((d) => d.fold !== f), b = tr.filter((d) => d.fold === f); const m = trainAudio(a.map((d) => d.f), a.map((d) => d.y), c); for (const d of b) { n++; if (predictAudio(m, d.f).label === d.y) ok++; } } cv.push({ ...c, cvAcc: ok / n }); }
  const best = cv.sort((a, b) => b.cvAcc - a.cvAcc)[0];
  const model = trainAudio(tr.map((d) => d.f), tr.map((d) => d.y), best);
  const pred = te.map((d) => predictAudio(model, d.f).label); const acc = pred.filter((p, i) => p === te[i].y).length / te.length;
  const chance = 1 / model.classes.length;
  return { model, params: best, cv, metrics: { 'audio.accuracy': +acc.toFixed(4), 'audio.chance': +chance.toFixed(4), 'audio.n_test': te.length, 'audio.n_train': tr.length }, confusion: confusion(te.map((d) => d.y), pred, model.classes), inputs: [{ source: 'esc50', license: 'CC BY-NC 3.0', nc: true, sa: false }] };
}

// ---------- orchestration ----------
const GATES = {
  'retriever.science': { primary: 'scifact.ndcg@10', minDelta: 0.003, guards: { 'qasper.recall@3': 0.01, 'scifact.recall@10': 0.01 }, floor: 0.5 },
  'retriever.code': { primary: 'code.mrr@5', minDelta: 0.001, guards: {}, floor: 0.3 },
  'verifier.claims': { primary: 'verify.acc', minDelta: 0.005, guards: {}, floor: 0.0 },
  'audio.recognizer': { primary: 'audio.accuracy', minDelta: 0.01, guards: {}, floor: 0.4 },
};
export const gateFor = (c) => GATES[c];

function submit(component, artifact, info) {
  const rec = registerCandidate(component, artifact, info);
  const res = tryPromote(component, rec.version, GATES[component]);
  log(`${component} ${rec.version}: ${res.pass ? 'PROMOTED' : 'REJECTED'} - ${res.reasons.join('; ')}`);
  return { rec, res };
}

export function trainAll({ tune = true } = {}) {
  const out = {};
  // 1. retriever.science: baseline first (so there is always a verified fallback), then the tuned candidate
  if (loadCollection('science').length) {
    if (!currentRecord('retriever.science')) {
      const t = trainRetriever('science', BASELINE);
      out['retriever.science:baseline'] = submit('retriever.science', serialize(t.index), { params: BASELINE, metrics: sciMetrics(t.index, BASELINE, 'dev'), inputs: t.inputs, note: 'untuned BM25 baseline' });
    }
    if (tune) {
      const tuned = tuneRetriever(); const t = trainRetriever('science', tuned.best);
      out['retriever.science:tuned'] = submit('retriever.science', serialize(t.index), { params: tuned.best, metrics: sciMetrics(t.index, tuned.best, 'dev'), inputs: t.inputs, note: `grid search of ${tuned.tried.length} settings on SciFact train claims (train nDCG@10 ${tuned.trainNdcg.toFixed(4)}); reported on dev` });
      out.tuning = tuned.tried;
    }
  }
  // 2. retriever.code
  if (loadCollection('code').length && !currentRecord('retriever.code')) {
    const p = { ...BASELINE, stem: true }; const t = trainRetriever('code', p);
    out['retriever.code'] = submit('retriever.code', serialize(t.index), { params: p, metrics: benchCode(t.index), inputs: t.inputs, note: 'BM25 over xv6 functions' });
  }
  // 3. verifier thresholds (tuned on train claims, reported on dev) - needs the current science retriever
  const sci = currentRecord('retriever.science');
  const sciArtifact = sci ? loadArtifact('retriever.science') : null;
  if (sci && !sciArtifact) out['verifier.claims'] = 'skipped: current retriever.science artifact is not on disk (checkpoints are git-ignored); run collect/extract/train from a clean registry or restore it';
  if (sci && sciArtifact) {
    const index = deserialize(sciArtifact); let best = null;
    for (const minScore of [4, 8, 12, 16, 20, 25]) { const a = benchVerify(index, { minScore, k: 5 }, 'train')['verify.acc']; if (!best || a > best.a) best = { a, minScore }; }
    const params = { minScore: best.minScore, k: 5 };
    out['verifier.claims'] = submit('verifier.claims', params, { params, metrics: { ...benchVerify(index, params, 'dev'), 'verify.train_acc': +best.a.toFixed(4) }, inputs: sci.inputs.filter((i) => i.source === 'scifact'), note: `NEI threshold chosen on train claims; retriever ${sci.version}` });
  }
  // 4. audio
  const au = trainAudioComponent();
  if (au) { out['audio.recognizer'] = submit('audio.recognizer', au.model, { params: au.params, metrics: au.metrics, inputs: au.inputs, note: `6 ESC-50 classes, train folds 1-4, test fold 5; model chosen by fold-CV (${au.cv.map((c) => `${c.mode}${c.k || ''}=${c.cvAcc.toFixed(2)}`).join(', ')})` }); out.audioConfusion = au.confusion; }
  return out;
}

export function status() {
  const reg = loadRegistry(); return Object.entries(reg.components).map(([name, c]) => ({ name, current: c.current, versions: c.versions.map((v) => ({ v: v.version, status: v.status, metrics: v.metrics, params: v.params, restrictions: v.restrictions, gate: v.gate?.reasons })) }));
}
