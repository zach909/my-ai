/**
 * training/repair/agent.mjs -- a repair agent that tries, runs, reads what happened, and fixes. It does not
 * remember answers.
 *
 * Why this exists: the character-level trainer scored 0 of 137 on the repair exam. Raising its context order
 * made it "fix" 73 of 137, but on task families it had never seen it fixed 0 of 50: that is memorising the
 * training text, not thinking. docs/TRAINING_FOCUS.md says only the model's own fix, run, passing counts, and
 * that held-out families are the test.
 *
 * What it does (train.md sections 8, 10, 11):
 *   1. Run the attempt against the checks. If every check passes, leave it ALONE (no second-guessing).
 *   2. Otherwise propose small generic edits (flip a comparison, nudge a constant, swap min/max, add or drop a
 *      method call or a term, add a guard, reorder two statements, ...), RUN each one, and keep the ones that
 *      pass more checks. Repeat (a fix can expose a second defect). A candidate counts only if it really runs.
 *   3. LEARNED part: `train()` replays training traces, finds which edit kinds really produced a verified fix,
 *      and ranks edit kinds by how often they verified. Ranking decides the order of tries; it never supplies
 *      an answer. Nothing task- or family-specific is stored: the table is keyed by edit kind only.
 *
 * Honest limits are in training/repair/README.md. Own code, Node built-ins only.
 */
import { runCall } from '../../scripts/drill-generators/repair.mjs'

const RELOPS = { '<': ['<=', '>', '>='], '<=': ['<', '>', '>='], '>': ['>=', '<', '<='], '>=': ['>', '<', '<='], '===': ['!=='], '!==': ['==='] }
const METHODS = ['.toLowerCase()', '.trim()', ".join('')"]

/** Every single-site edit of `src`, each tagged with its kind. Kinds are generic, not per family. */
export function candidateEdits(src, params = []) {
  const out = []
  const add = (kind, text) => { if (text !== src) out.push({ kind, src: text }) }
  const at = (i, len, rep) => src.slice(0, i) + rep + src.slice(i + len)

  for (const m of src.matchAll(/<=|>=|===|!==|<|>/g)) {
    if (src.slice(m.index - 1, m.index) === '=' || src[m.index + m[0].length] === '>') continue // skip => and similar
    for (const r of RELOPS[m[0]] ?? []) add('relop', at(m.index, m[0].length, r))
  }
  for (const m of src.matchAll(/\b\d+\b/g)) {
    const n = Number(m[0])
    for (const r of [n + 1, n - 1, 0, 1]) if (r !== n && r >= 0) add('const', at(m.index, m[0].length, String(r)))
  }
  for (const m of src.matchAll(/Math\.(min|max)/g)) add('minmax', at(m.index, m[0].length, m[1] === 'min' ? 'Math.max' : 'Math.min'))
  add('minmax', src.replace(/Math\.(min|max)/g, (_, k) => (k === 'min' ? 'Math.max' : 'Math.min')))
  for (const m of src.matchAll(/ [+-] \d+(?=[)\s;]|$)/g)) add('dropterm', at(m.index, m[0].length, ''))
  for (const meth of METHODS) {
    const esc = meth.replace(/[.()']/g, '\\$&')
    for (const m of src.matchAll(new RegExp(esc, 'g'))) add('dropcall', at(m.index, m[0].length, ''))
  }
  // add a method call to an assigned identifier (`= s` -> `= s.trim()`), or join after a reverse
  for (const m of src.matchAll(/(=\s*)([A-Za-z_]\w*)(?=\n)/g)) {
    for (const meth of METHODS) if (meth !== ".join('')") add('addcall', at(m.index + m[1].length + m[2].length, 0, meth))
  }
  for (const m of src.matchAll(/\.reverse\(\)(?=\n)/g)) add('addcall', at(m.index + m[0].length, 0, ".join('')"))
  // general classes of slip: the wrong logical connective, a missing or extra step in an index, a missing or
  // extra Math.abs / .reverse(), the wrong separator, first-vs-last element
  for (const m of src.matchAll(/&&|\|\|/g)) add('logic', at(m.index, 2, m[0] === '&&' ? '||' : '&&'))
  for (const m of src.matchAll(/\[(\w+(?:\.length)?)\]/g)) { add('step', at(m.index, m[0].length, `[${m[1]} - 1]`)); add('step', at(m.index, m[0].length, `[${m[1]} + 1]`)) }
  for (const m of src.matchAll(/(\w+)\[0\]/g)) add('endpoint', at(m.index, m[0].length, `${m[1]}[${m[1]}.length - 1]`))
  for (const m of src.matchAll(/(\w+)\[\1\.length - 1\]/g)) add('endpoint', at(m.index, m[0].length, `${m[1]}[0]`))
  for (const m of src.matchAll(/return (.+)\n/g)) if (!/^Math\.abs\(/.test(m[1])) add('wrapfn', at(m.index, m[0].length, `return Math.abs(${m[1]})\n`))
  for (const m of src.matchAll(/Math\.abs\(([^()]*)\)/g)) add('unwrapfn', at(m.index, m[0].length, m[1]))
  for (const m of src.matchAll(/\)(?=\.join\()/g)) add('addreverse', at(m.index + 1, 0, '.reverse()'))
  for (const m of src.matchAll(/\.reverse\(\)/g)) add('dropreverse', at(m.index, m[0].length, ''))
  for (const m of src.matchAll(/join\('(.*?)'\)/g)) for (const r of ['', ' ']) if (r !== m[1]) add('sepchar', at(m.index, m[0].length, `join('${r}')`))
  for (const m of src.matchAll(/return ([A-Za-z_]\w*)\n/g)) add('wrap', at(m.index, m[0].length, `return String(${m[1]})\n`))
  for (const m of src.matchAll(/String\(([A-Za-z_]\w*)\)/g)) add('unwrap', at(m.index, m[0].length, m[1]))
  for (const m of src.matchAll(/' '/g)) add('sep', at(m.index, m[0].length, '/\\s+/'))
  for (const m of src.matchAll(/if \(!(\w+)\)/g)) add('lengthtest', at(m.index, m[0].length, `if (${m[1]}.length === 0)`))
  // a condition that can never fire (`if (false)`): test a variable in scope for emptiness instead
  const names = [...params, ...[...src.matchAll(/(?:const|let) (\w+) =/g)].map((m) => m[1])]
  for (const m of src.matchAll(/if \((?:false|true)\)/g)) for (const v of names) add('cond', at(m.index, m[0].length, `if (${v} === '')`))
  for (const m of src.matchAll(/(let \w+ = )(-?\d+)(?=\n)/g)) for (const p of params) add('init', at(m.index + m[1].length, m[2].length, `${p}[0]`))
  for (const p of params) {
    const head = src.indexOf('{\n') + 2
    if (head > 1) add('guard', src.slice(0, head) + `  if (${p}.length === 0) return 0\n` + src.slice(head))
  }
  const lines = src.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*if /.test(lines[i]) && /^\s*if /.test(lines[i + 1])) {
      const l = [...lines]; [l[i], l[i + 1]] = [l[i + 1], l[i]]; add('reorder', l.join('\n'))
    }
  }
  return out
}

/** Run every check; returns how many pass and the first failure. Expected values are given, never computed here. */
export function grade(src, fn, checks) {
  let passed = 0, first = null
  for (const c of checks) {
    const got = runCall(src, fn, c.args)
    if (got.ok && got.text === c.expected) passed++
    else first ??= { call: c, got: got.text }
  }
  return { passed, total: checks.length, first }
}

export class RepairAgent {
  /** `prior`: edit kind -> verified successes seen in training. Empty prior = every kind tried equally. */
  constructor(prior = {}) { this.prior = { ...prior } }

  /** Learn from outcomes: for each training trace, which edit kinds produced a verified fix from its failing attempt. */
  train(traces) {
    const tally = {}, tried = {}
    for (const t of traces) {
      const g0 = grade(t.attempt, t.fn, t.checks)
      if (!g0.first) continue
      for (const e of candidateEdits(t.attempt, t.params)) {
        tried[e.kind] = (tried[e.kind] ?? 0) + 1
        if (grade(e.src, t.fn, t.checks).passed === t.checks.length) tally[e.kind] = (tally[e.kind] ?? 0) + 1
      }
    }
    // success rate per kind, smoothed so an unseen kind is still tried
    for (const k of new Set([...Object.keys(tried), ...Object.keys(this.prior)])) this.prior[k] = ((tally[k] ?? 0) + 1) / ((tried[k] ?? 0) + 2)
    return { prior: this.prior, traces: traces.length }
  }

  /** Try, run, read, fix. Returns the final source and every step it took (the trace). */
  /**
   * Best-first search with a budget: grade every state it reaches by running it, expand the most promising one
   * (more checks passing, then edit kinds that verified more often in training), stop at the first state that
   * passes everything. A state that is no better than its parent can still be expanded, so a fix that needs two
   * edits (the first one showing no gain) is reachable; a greedy climb would get stuck.
   */
  repair({ attempt, fn, checks, params = [] }, { budget = 30, maxDepth = 4 } = {}) {
    const g0 = grade(attempt, fn, checks)
    if (!g0.first) return { src: attempt, changed: false, steps: [{ note: 'every check passes; left alone' }], ok: true }
    const seen = new Set([attempt])
    let frontier = [{ src: attempt, g: g0, depth: 0, path: [], w: 0 }]
    let best = frontier[0]
    for (let n = 0; n < budget && frontier.length; n++) {
      frontier.sort((a, b) => b.g.passed - a.g.passed || b.w - a.w || a.depth - b.depth)
      const cur = frontier.shift()
      if (cur.depth >= maxDepth) continue
      for (const e of candidateEdits(cur.src, params)) {
        if (seen.has(e.src)) continue
        seen.add(e.src)
        const g = grade(e.src, fn, checks)
        const node = { src: e.src, g, depth: cur.depth + 1, path: [...cur.path, { kind: e.kind, passed: g.passed }], w: cur.w + Math.log(this.prior[e.kind] ?? 0.5) }
        if (!g.first) return { src: e.src, changed: true, steps: node.path, ok: true }
        if (g.passed > best.g.passed) best = node
        frontier.push(node)
      }
    }
    return { src: attempt, changed: false, steps: [{ note: `no verified fix within ${budget} expansions` }], ok: false, closest: best.g.passed }
  }
}

/** Parse one trace row (scripts/make-repair-data.mjs format) into { attempt, fn, checks, params }. */
export function parseTrace(row) {
  const t = row.text
  const checks = [...t.matchAll(/^(\w+)\((.*)\) == (.*)$/gm)].map((m) => ({ fn: m[1], args: JSON.parse(`[${m[2]}]`), expected: m[3] }))
  const attempt = t.match(/ATTEMPT 1\n([\s\S]*?)\nRUN/)?.[1]
  const final = [...t.matchAll(/ATTEMPT \d+\n([\s\S]*?)\nRUN/g)].pop()?.[1]
  const params = (t.match(/Write function \w+\(([^)]*)\)/)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return { attempt, final, fn: checks[0]?.fn, checks, params, family: row.meta.family, mode: row.meta.mode }
}
