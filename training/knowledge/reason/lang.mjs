// A compact symbolic reasoning language ("KL") and a small forward-chaining engine with proofs.
//
//   FACT f1: freezes_at(water, 0C) @0.99 src=nist:webbook ev=measurement
//   FACT f2: pressure(sample1, std)
//   RULE r1: IF is_a(X,Y) & is_a(Y,Z) THEN is_a(X,Z) @1
//   RULE r2: IF pressure(S,std) & temp_reached(S,freezing) & COND water(S) THEN solid(S) @0.95
//   DEF  d1: freezing point of water is 0C       (a named definition, kept for lookup)
//   NOT  n1: flat(earth) @0.99 src=...           (a negative fact)
//   FUNC freezes_at/2                            (single-valued: two different values contradict)
//   EXCL solid/1 liquid/1                        (mutually exclusive for the same subject)
//   ASSUME a1: heavier_than_air(x)               (stated, NOT usable as a premise; never counted as fact)
//   HYP  h1: ...                                 (hypothesis: stored, never used as a premise)
//
// Variables start with an upper-case letter or '_'. `COND` marks premises that are conditions (standard pressure ...):
// the engine reports an unmet condition instead of silently skipping it. Confidence of a derived fact = rule confidence
// x the minimum confidence of its premises. Every derived fact carries its proof; verifyProof() re-checks it independently.
// Negation is only ever an explicit NOT fact: absence of proof is UNKNOWN, never "false".

const isVar = (t) => /^[A-Z_]/.test(t);
export function parseAtom(s) {
  s = s.trim(); let neg = false;
  if (s.startsWith('!') || /^NOT\s/.test(s)) { neg = true; s = s.replace(/^(!|NOT\s+)/, '').trim(); }
  const m = s.match(/^([A-Za-z_][\w.:-]*)\s*\(([^()]*)\)$/); if (!m) throw new Error('bad atom: ' + s);
  const args = m[2].trim() === '' ? [] : m[2].split(',').map((x) => x.trim());
  return { pred: m[1], args, neg };
}
const keyOf = (a) => (a.neg ? '!' : '') + a.pred + '(' + a.args.join(',') + ')';
const posKey = (a) => a.pred + '(' + a.args.join(',') + ')';
export const fmt = keyOf;

export function parseKB(text) {
  const kb = { facts: [], rules: [], funcs: new Set(), excl: [], assumptions: [], defs: [], errors: [] };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim(); if (!line || line.startsWith('#') || line.startsWith('//')) return;
    try {
      let m;
      const meta = (s) => {
        const conf = (s.match(/@([0-9.]+)/) || [])[1]; const src = (s.match(/\bsrc=(\S+)/) || [])[1]; const ev = (s.match(/\bev=(\S+)/) || [])[1];
        return { conf: conf === undefined ? 1 : Number(conf), src, ev, body: s.replace(/@[0-9.]+/, '').replace(/\bsrc=\S+/, '').replace(/\bev=\S+/, '').trim() };
      };
      if ((m = line.match(/^(FACT|NOT)\s+([\w.-]+)\s*:\s*(.*)$/))) {
        const x = meta(m[3]); const a = parseAtom((m[1] === 'NOT' ? '!' : '') + x.body);
        if (a.args.some(isVar)) throw new Error('fact has a variable');
        kb.facts.push({ id: m[2], atom: a, conf: x.conf, src: x.src, ev: x.ev });
      } else if ((m = line.match(/^(ASSUME|HYP)\s+([\w.-]+)\s*:\s*(.*)$/))) {
        const x = meta(m[3]); kb.assumptions.push({ id: m[2], kind: m[1], atom: parseAtom(x.body), conf: x.conf, src: x.src });
      } else if ((m = line.match(/^RULE\s+([\w.-]+)\s*:\s*IF\s+(.*?)\s+THEN\s+(.*)$/))) {
        const x = meta(m[3]);
        const prem = m[2].split('&').map((p) => { p = p.trim(); const cond = /^COND\s+/.test(p); return { atom: parseAtom(p.replace(/^COND\s+/, '')), cond }; });
        const head = parseAtom(x.body); const bound = new Set(prem.filter((p) => !p.atom.neg).flatMap((p) => p.atom.args.filter(isVar)));
        for (const v of head.args.filter(isVar)) if (!bound.has(v)) throw new Error('unbound head variable ' + v);
        kb.rules.push({ id: m[1], prem, head, conf: x.conf, src: x.src });
      } else if ((m = line.match(/^FUNC\s+(.*)$/))) m[1].split(/\s+/).forEach((p) => kb.funcs.add(p.replace(/\/\d+$/, '')));
      else if ((m = line.match(/^EXCL\s+(.*)$/))) kb.excl.push(m[1].split(/\s+/).map((p) => p.replace(/\/\d+$/, '')));
      else if ((m = line.match(/^DEF\s+([\w.-]+)\s*:\s*(.*)$/))) kb.defs.push({ id: m[1], text: m[2] });
      else throw new Error('unknown statement');
    } catch (e) { kb.errors.push(`line ${i + 1}: ${e.message}`); }
  });
  return kb;
}

/** Unify a pattern atom with a ground atom under bindings b; returns new bindings or null. */
function match(pat, ground, b) {
  if (pat.pred !== ground.pred || pat.args.length !== ground.args.length) return null;
  const nb = { ...b };
  for (let i = 0; i < pat.args.length; i++) {
    const p = pat.args[i], g = ground.args[i];
    if (isVar(p)) { if (p === '_') continue; if (nb[p] === undefined) nb[p] = g; else if (nb[p] !== g) return null; } else if (p !== g) return null;
  }
  return nb;
}
const subst = (a, b) => ({ pred: a.pred, neg: a.neg, args: a.args.map((x) => (isVar(x) ? b[x] : x)) });

export class Engine {
  constructor(kb) { this.kb = kb; this.known = new Map(); this.byPred = new Map(); this.contradictions = []; this.unmet = []; this.run(); }
  _add(atom, conf, proof) {
    const k = keyOf(atom); const old = this.known.get(k);
    if (old && old.conf >= conf) return false;
    this.known.set(k, { atom, conf, proof });
    if (!old) { if (!this.byPred.has(atom.pred)) this.byPred.set(atom.pred, []); this.byPred.get(atom.pred).push(k); }
    return true;
  }
  run() {
    for (const f of this.kb.facts) this._add(f.atom, f.conf, { type: 'fact', id: f.id, src: f.src, ev: f.ev });
    let changed = true, rounds = 0;
    while (changed && rounds++ < 50) {
      changed = false;
      for (const r of this.kb.rules) {
        let sols = [{ b: {}, used: [], conf: r.conf }];
        for (const p of r.prem) {
          const next = [];
          for (const s of sols) {
            if (p.atom.neg) {
              const g = subst(p.atom, s.b); if (g.args.some(isVar)) continue;
              const e = this.known.get(keyOf(g)); if (e) next.push({ ...s, used: [...s.used, keyOf(g)], conf: Math.min(s.conf, e.conf) });
              continue;
            }
            let any = false;
            for (const k of this.byPred.get(p.atom.pred) || []) {
              const e = this.known.get(k); if (e.atom.neg) continue; const nb = match(p.atom, e.atom, s.b);
              if (nb) { any = true; next.push({ b: nb, used: [...s.used, k], conf: Math.min(s.conf, e.conf) }); }
            }
            if (!any && p.cond && !p.atom.args.some((x) => isVar(x) && s.b[x] === undefined)) {
              const c = { rule: r.id, condition: keyOf(subst(p.atom, s.b)) };
              if (!this.unmet.some((u) => u.rule === c.rule && u.condition === c.condition)) this.unmet.push(c);
            }
          }
          sols = next; if (!sols.length) break;
        }
        for (const s of sols) { const h = subst(r.head, s.b); if (this._add(h, s.conf, { type: 'rule', id: r.id, src: r.src, from: s.used })) changed = true; }
      }
    }
    this._contradictions();
  }
  _contradictions() {
    const out = [];
    for (const [k, e] of this.known) if (e.atom.neg && this.known.has(posKey(e.atom))) out.push({ type: 'negation', a: posKey(e.atom), b: k });
    for (const f of this.kb.funcs) {
      const vals = new Map();
      for (const k of this.byPred.get(f) || []) {
        const a = this.known.get(k).atom; if (a.neg || !a.args.length) continue;
        const subj = a.args.slice(0, -1).join(','); const v = a.args.at(-1);
        if (!vals.has(subj)) vals.set(subj, new Set()); vals.get(subj).add(v);
      }
      for (const [s, v] of vals) if (v.size > 1) out.push({ type: 'functional', pred: f, subject: s, values: [...v] });
    }
    for (const grp of this.kb.excl) {
      const subj = new Map();
      for (const p of grp) for (const k of this.byPred.get(p) || []) {
        const a = this.known.get(k).atom; if (a.neg) continue; const s = a.args.join(',');
        if (!subj.has(s)) subj.set(s, new Set()); subj.get(s).add(p);
      }
      for (const [s, ps] of subj) if (ps.size > 1) out.push({ type: 'exclusive', subject: s, preds: [...ps] });
    }
    this.contradictions = out;
  }
  /** Ask a ground atom. Status: PROVEN | REFUTED | CONTRADICTORY | UNKNOWN. Assumptions never count as evidence. */
  ask(text) {
    const a = parseAtom(text); const pos = posKey(a), neg = '!' + pos;
    const p = this.known.get(pos), n = this.known.get(neg);
    const subj = a.args.slice(0, -1).join(',');
    const involved = this.contradictions.some((c) => c.a === pos || c.b === pos || (c.pred === a.pred && c.subject === subj) || (c.type === 'exclusive' && c.preds.includes(a.pred) && c.subject === a.args.join(',')));
    let status = p && n ? 'CONTRADICTORY' : p ? 'PROVEN' : n ? 'REFUTED' : 'UNKNOWN';
    if (status === 'PROVEN' && involved) status = 'CONTRADICTORY';
    const asm = this.kb.assumptions.find((x) => keyOf(x.atom) === keyOf(a) || keyOf(x.atom) === pos);
    const e = status === 'PROVEN' ? p : status === 'REFUTED' ? n : null;
    const res = { status, confidence: e ? e.conf : 0, proof: e ? this.proof(e === p ? pos : neg) : null };
    if (status === 'UNKNOWN' && asm) res.note = `only an ${asm.kind.toLowerCase()} (${asm.id}), not evidence: not treated as fact`;
    return res;
  }
  proof(key, depth = 0) {
    const e = this.known.get(key); if (!e || depth > 20) return null; const pr = e.proof;
    return pr.type === 'fact' ? { atom: key, by: 'fact ' + pr.id, src: pr.src, ev: pr.ev, conf: e.conf }
      : { atom: key, by: 'rule ' + pr.id, conf: e.conf, premises: pr.from.map((k) => this.proof(k, depth + 1)) };
  }
  /** Independent re-check of a proof tree against the KB source (not the engine's tables). */
  verifyProof(proof) {
    if (!proof) return false;
    if (proof.by.startsWith('fact ')) return this.kb.facts.some((f) => 'fact ' + f.id === proof.by && keyOf(f.atom) === proof.atom);
    const r = this.kb.rules.find((x) => 'rule ' + x.id === proof.by); if (!r) return false;
    if (!proof.premises || proof.premises.length !== r.prem.length || !proof.premises.every((p) => this.verifyProof(p))) return false;
    let b = {};
    for (let i = 0; i < r.prem.length; i++) { const g = parseAtom(proof.premises[i].atom); const nb = match({ ...r.prem[i].atom, neg: g.neg }, g, b); if (!nb) return false; b = nb; }
    return keyOf(subst(r.head, b)) === proof.atom;
  }
  explain(proof, ind = '') {
    if (!proof) return '';
    return `${ind}${proof.atom}  [${proof.by}${proof.src ? ' src=' + proof.src : ''} @${proof.conf}]\n` + (proof.premises || []).map((p) => this.explain(p, ind + '  ')).join('');
  }
  /** List substitutions for a pattern containing variables. */
  query(text) {
    const pat = parseAtom(text), out = [];
    for (const k of this.byPred.get(pat.pred) || []) { const e = this.known.get(k); if (e.atom.neg !== pat.neg) continue; const b = match(pat, e.atom, {}); if (b) out.push({ bindings: b, confidence: e.conf, atom: k }); }
    return out;
  }
}
export const loadKB = (text) => { const kb = parseKB(text); if (kb.errors.length) throw new Error(kb.errors.join('\n')); return new Engine(kb); };
