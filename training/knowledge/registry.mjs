// Versioned checkpoints with a promotion gate. Rules (from the brief):
//   * a trained component is saved as a NEW immutable version; old versions are never overwritten or deleted
//   * a candidate becomes `current` only if the gate passes: primary metric improves by at least minDelta AND no guard metric
//     drops by more than its tolerance. Otherwise it stays `candidate` and `current` is untouched
//   * every version records what produced it (params, data hashes, licences, code hash, node version, git commit)
//   * licence terms propagate: a checkpoint built from non-commercial / share-alike data is marked so
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HERE, REPO, dir, path, existsSync, readFileSync, writeFileSync, readJson, writeJson, sha256, today, readdirSync } from './util.mjs';

export const REGISTRY = process.env.MYAI_REGISTRY || path.join(HERE, 'registry.json');
export const load = () => (existsSync(REGISTRY) ? readJson(REGISTRY) : { schema: 1, components: {} });
const save = (r) => writeJson(REGISTRY, r);

export function codeHash() {
  const h = createHash('sha256');
  for (const f of readdirSync(HERE).filter((x) => x.endsWith('.mjs')).sort()) h.update(f).update(readFileSync(path.join(HERE, f)));
  for (const f of readdirSync(path.join(HERE, 'reason')).sort()) h.update(readFileSync(path.join(HERE, 'reason', f)));
  return h.digest('hex').slice(0, 16);
}
function gitCommit() { try { return execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } }

/** Save a candidate version. Returns its record. Does NOT change `current`. */
export function registerCandidate(component, artifact, { metrics, params, inputs = [], note = '' }) {
  const reg = load(); const c = (reg.components[component] ||= { current: null, versions: [] });
  const n = c.versions.length + 1, version = 'v' + n;
  const body = JSON.stringify(artifact); const file = path.join(dir('checkpoints', component), version + '.json'); writeFileSync(file, body);
  const rec = {
    version, status: 'candidate', created: today(), params, metrics, note,
    artifact: path.relative(REPO, file), artifactSha256: sha256(Buffer.from(body)), artifactBytes: body.length,
    inputs, restrictions: { nonCommercial: inputs.some((i) => i.nc), shareAlike: inputs.some((i) => i.sa) },
    provenance: { codeHash: codeHash(), node: process.version, commit: gitCommit(), parent: c.current },
  };
  c.versions.push(rec); save(reg); return rec;
}

/** gate: {primary:'ndcg@10', minDelta:0.005, guards:{'qasper_recall@3':0.01}, floor?:0.5}. Metrics are "higher is better". */
export function evaluateGate(cand, cur, gate) {
  const reasons = []; const g = gate || {};
  const p = g.primary, cv = cand.metrics[p];
  if (cv === undefined) return { pass: false, reasons: [`candidate has no metric ${p}`] };
  if (!cur) { if (g.floor !== undefined && cv < g.floor) return { pass: false, reasons: [`${p}=${cv} below floor ${g.floor}`] }; return { pass: true, reasons: [`first version: ${p}=${cv} meets floor ${g.floor ?? 'none'}`] }; }
  const pv = cur.metrics[p]; const delta = +(cv - pv).toFixed(6);
  if (delta < (g.minDelta ?? 0.001)) reasons.push(`${p} ${pv} -> ${cv} (delta ${delta}) is below the required +${g.minDelta ?? 0.001}`);
  for (const [m, tol] of Object.entries(g.guards || {})) {
    const a = cand.metrics[m], b = cur.metrics[m]; if (a === undefined || b === undefined) continue;
    if (a < b - tol) reasons.push(`guard ${m} regressed ${b} -> ${a} (allowed ${tol})`);
  }
  return reasons.length ? { pass: false, reasons } : { pass: true, reasons: [`${p} ${pv} -> ${cv} (+${delta}); guards held`] };
}

export function tryPromote(component, version, gate) {
  const reg = load(); const c = reg.components[component]; if (!c) throw new Error('unknown component ' + component);
  const cand = c.versions.find((v) => v.version === version); if (!cand) throw new Error('unknown version ' + version);
  const cur = c.versions.find((v) => v.version === c.current);
  const res = evaluateGate(cand, cur, gate);
  cand.gate = { ...res, checked: today(), against: cur?.version || null };
  if (res.pass) { if (cur) cur.status = 'superseded'; cand.status = 'current'; c.current = cand.version; } else cand.status = 'rejected';
  save(reg); return { ...res, version: cand.version, current: c.current };
}
export function rollback(component, version) {
  const reg = load(); const c = reg.components[component]; const v = c.versions.find((x) => x.version === version);
  if (!v || v.status === 'rejected') throw new Error('cannot roll back to ' + version);
  for (const x of c.versions) if (x.status === 'current') x.status = 'superseded'; v.status = 'current'; c.current = version; save(reg); return c.current;
}
export function currentRecord(component) { const c = load().components[component]; return c && c.versions.find((v) => v.version === c.current); }
export function loadArtifact(component, version) {
  const c = load().components[component]; const v = c?.versions.find((x) => x.version === (version || c.current)); if (!v) return null;
  const f = path.join(REPO, v.artifact); if (!existsSync(f)) return null; const b = readFileSync(f);
  if (sha256(b) !== v.artifactSha256) throw new Error(`checkpoint ${component}/${v.version} was modified after it was registered`);
  return JSON.parse(b);
}
export function verifyRegistry() {
  const problems = []; const reg = load();
  for (const [name, c] of Object.entries(reg.components)) {
    if (c.current && !c.versions.some((v) => v.version === c.current && v.status === 'current')) problems.push(`${name}: current points at a non-current version`);
    for (const v of c.versions) { const f = path.join(REPO, v.artifact); if (existsSync(f) && sha256(readFileSync(f)) !== v.artifactSha256) problems.push(`${name}/${v.version}: artifact hash mismatch`); }
  }
  return problems;
}
