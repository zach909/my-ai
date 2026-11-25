/**
 * repair.mjs -- drill generator for "try, fail, read the failure, fix it".
 *
 * docs/TRAINING_FOCUS.md and train.md section 10 ask for self-correction examples: an attempt, a visible
 * problem with it, a fixed attempt, plus cases where the first attempt was fine and must be left alone so
 * the network does not learn to second-guess everything.
 *
 * What makes these examples honest rather than invented:
 *   - Every failure message in a trace is what really happened when the attempt was run against the checks
 *     (node:vm, the same sandbox idea as models && skills/core/code-iteration.ts). Nothing is written by hand.
 *   - Every expected value comes from RUNNING the correct version, not from a formula.
 *   - Which defect a failure points at is found by running too: the culprit is the one flag whose removal
 *     makes the first failing check pass.
 *   - The generator refuses to emit a family whose "bug" does not actually fail a check, or whose correct
 *     version does not pass them all.
 * The one hand-written part is the short plain-words note about WHAT KIND of mistake each defect is
 * ("off by one", "forgot the empty case"). Those notes are the lesson; the failures are the evidence.
 *
 * Trace modes (weights in MODES):
 *   clean  the first attempt already passes -> say so, change nothing
 *   fix1   one defect: attempt, real failure, fix, pass
 *   fix2   two defects: the first fix exposes a second, different failure, then pass
 *   decoy  a plausible but wrong fix fails differently, and only the next fix passes
 *
 * Pure and deterministic given a rand() source. No external API, no third-party code.
 */
import vm from 'node:vm'

/** Small seeded random source (own code): same seed, same sequence. */
export function makeRand(seed) {
  let s = (seed >>> 0) || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return ((s >>> 8) & 0xffffff) / 0x1000000
  }
}

const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)]
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const fmt = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(v))

/** Run `fn(...args)` from `source` in a fresh, prototype-less context with a time limit. Not a security boundary. */
export function runCall(source, fn, args) {
  const ctx = vm.createContext(Object.create(null))
  try {
    vm.runInContext(source, ctx, { timeout: 200 })
    const value = vm.runInContext(`${fn}(...${JSON.stringify(args)})`, ctx, { timeout: 200 })
    return { ok: true, text: fmt(value) }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    return { ok: false, text: `${e && e.name ? e.name : 'Error'}: ${msg}` }
  }
}

const call = (fn, args) => `${fn}(${args.map(fmt).join(', ')})`

/**
 * Families. `build(on)` returns the source with the defects whose flags are in `on` switched on.
 * A flag `x` is the real defect; `x~` is a plausible-but-wrong repair of it (the decoy).
 */
function families(rand) {
  const k = int(rand, 2, 6)
  const m = int(rand, 2, 5)
  const a = pick(rand, [2, 3]), b = pick(rand, [5, 7])
  const lo = int(rand, -5, 2), hi = lo + int(rand, 4, 12)
  return [
    {
      name: 'sumMultiples', params: 'n, k',
      spec: `Return the sum of the multiples of k from 1 up to and including n.`,
      tests: [[k * m, k], [k * m + 1, k], [k - 1, k], [0, k], [k * 3, 1]],
      bugs: {
        off: { note: 'the loop stops one short, so n itself is never included; use <= n', decoy: 'i <= n + 1', decoyNote: 'it overshoots: it now includes a value past n; the bound should be exactly n' },
        rem: { note: 'the divisibility test checks the wrong remainder; a multiple of k leaves remainder 0' },
      },
      build: (on) => `function sumMultiples(n, k) {
  let total = 0
  for (let i = 1; i ${on.has('off') ? '< n' : on.has('off~') ? '<= n + 1' : '<= n'}; i++) {
    if (i % k === ${on.has('rem') ? '1' : '0'}) total += i
  }
  return total
}`,
    },
    {
      name: 'maxOf', params: 'xs',
      spec: `Return the largest number in a non-empty array.`,
      tests: [[[3, 9, 4]], [[-4, -9, -2]], [[7]], [[-1, 0, -1]], [[5, 5, 2]]],
      bugs: {
        init: { note: 'the running maximum starts at 0, so an array of only negatives can never beat it; start from the first element', decoy: '-1', decoyNote: 'starting at -1 only moves the problem: an array whose values are all below -1 still never beats the start; start from the first element instead' },
        cmp: { note: 'the comparison is reversed, so this keeps the smallest value; keep x when x is greater' },
      },
      build: (on) => `function maxOf(xs) {
  let m = ${on.has('init') ? '0' : on.has('init~') ? '-1' : 'xs[0]'}
  for (const x of xs) {
    if (x ${on.has('cmp') ? '<' : '>'} m) m = x
  }
  return m
}`,
    },
    {
      name: 'average', params: 'xs',
      spec: `Return the mean of an array of numbers, and 0 for an empty array.`,
      tests: [[[2, 4, 6]], [[]], [[5]], [[1, 2]], [[-3, 3, 9]]],
      bugs: {
        empty: { note: 'the empty array was not handled: dividing 0 by 0 gives NaN; return 0 first', decoy: 'if (!xs) return 0', decoyNote: 'it only guards against a missing array, not an empty one; test xs.length === 0 and return 0 before dividing' },
        div: { note: 'it divides by one fewer than the count; divide by xs.length' },
      },
      build: (on) => `function average(xs) {
${on.has('empty') ? '' : on.has('empty~') ? '  if (!xs) return 0\n' : '  if (xs.length === 0) return 0\n'}  let sum = 0
  for (const x of xs) sum += x
  return sum / (xs.length${on.has('div') ? ' - 1' : ''})
}`,
    },
    {
      name: 'isPalindrome', params: 's',
      spec: `Return true when the string reads the same forwards and backwards, ignoring upper/lower case.`,
      tests: [['racecar'], ['Racecar'], ['abca'], [''], ['Aa']],
      bugs: {
        casing: { note: 'case is not ignored, so "Racecar" fails; lower-case the string before comparing' },
        cmp: { note: 'it compares a string with an array, which is never equal; join the reversed characters back into a string' },
      },
      build: (on) => `function isPalindrome(s) {
  const t = ${on.has('casing') ? 's' : 's.toLowerCase()'}
  const r = t.split('').reverse()${on.has('cmp') ? '' : ".join('')"}
  return t === r
}`,
    },
    {
      name: 'clamp', params: 'x, lo, hi',
      spec: `Return x limited to the range from lo to hi, inclusive.`,
      tests: [[lo - 3, lo, hi], [hi + 3, lo, hi], [lo, lo, hi], [hi, lo, hi], [Math.floor((lo + hi) / 2), lo, hi]],
      bugs: {
        swap: { note: 'min and max are applied in the wrong order, so the range collapses to one end; raise to lo first, then cap at hi' },
      },
      build: (on) => on.has('swap')
        ? `function clamp(x, lo, hi) {\n  return Math.max(Math.min(x, lo), hi)\n}`
        : `function clamp(x, lo, hi) {\n  return Math.min(Math.max(x, lo), hi)\n}`,
    },
    {
      name: 'countWords', params: 's',
      spec: `Return how many words a string has. Words are separated by any run of whitespace. Blank text has 0 words.`,
      tests: [['one two three'], ['  padded  text '], [''], ['   '], ['a  b   c']],
      bugs: {
        trim: { note: 'leading and trailing spaces produce empty pieces that get counted; trim first and return 0 when nothing is left' },
        sep: { note: 'it splits on a single space, so runs of spaces make empty pieces; split on any run of whitespace' },
      },
      build: (on) => `function countWords(s) {
  const t = ${on.has('trim') ? 's' : 's.trim()'}
  if (${on.has('trim') ? 'false' : "t === ''"}) return 0
  return t.split(${on.has('sep') ? "' '" : '/\\s+/'}).length
}`,
    },
    {
      name: 'labelFor', params: 'n',
      spec: `Return "fizz" when n is divisible by ${a}, "buzz" when divisible by ${b}, "fizzbuzz" when divisible by both, otherwise n as a string.`,
      tests: [[a], [b], [a * b], [1], [a * b * 2 + 1]],
      bugs: {
        order: { note: `the "both" case is checked after the single cases, so it can never be reached; test divisibility by both first` },
        type: { note: 'the fallback returns the number itself, but the spec wants a string; wrap it in String()' },
      },
      build: (on) => {
        const both = `  if (n % ${a} === 0 && n % ${b} === 0) return 'fizzbuzz'\n`
        const single = `  if (n % ${a} === 0) return 'fizz'\n  if (n % ${b} === 0) return 'buzz'\n`
        const tail = `  return ${on.has('type') ? 'n' : 'String(n)'}\n}`
        return `function labelFor(n) {\n${on.has('order') ? single + both : both + single}${tail}`
      },
    },
  ]
}

/** Run every check; returns the first failure (or null) and the counts. */
function grade(src, fam, expected) {
  let passed = 0, first = null
  fam.tests.forEach((args, i) => {
    const got = runCall(src, fam.name, args)
    if (got.ok && got.text === expected[i]) passed++
    else if (!first) first = { call: call(fam.name, args), expected: expected[i], got: got.text, ok: got.ok, index: i }
  })
  return { passed, total: fam.tests.length, first }
}

const MODES = [['clean', 0.2], ['fix1', 0.3], ['fix2', 0.3], ['decoy', 0.2]]
function pickMode(rand) {
  let r = rand()
  for (const [m, w] of MODES) { if ((r -= w) < 0) return m }
  return 'fix1'
}

const failLine = (f) => f.ok
  ? `FAIL ${f.call}: expected ${f.expected}, got ${f.got}`
  : `FAIL ${f.call}: ${f.got}`

/**
 * One full trace. Returns { text, meta, firstFailure, finalSource }.
 * Throws if the family is unsound (a defect that fails nothing, or a correct version that fails).
 */
export function generateRepairTrace(rand = Math.random, forceMode) {
  const fam = pick(rand, families(rand))
  const ids = Object.keys(fam.bugs)
  const expected = fam.tests.map((args) => runCall(fam.build(new Set()), fam.name, args).text)
  if (expected.some((e) => /^[A-Za-z]*Error:/.test(e))) throw new Error(`${fam.name}: the correct version errors on a check`)
  if (grade(fam.build(new Set()), fam, expected).passed !== fam.tests.length) throw new Error(`${fam.name}: correct version fails its own checks`)
  for (const id of ids) {
    if (!grade(fam.build(new Set([id])), fam, expected).first) throw new Error(`${fam.name}: defect "${id}" fails no check`)
    if (fam.bugs[id].decoy && !grade(fam.build(new Set([id + '~'])), fam, expected).first) throw new Error(`${fam.name}: decoy of "${id}" fails no check`)
  }

  let mode = forceMode ?? pickMode(rand)
  if (mode === 'fix2' && ids.length < 2) mode = 'fix1'
  const decoyable = ids.filter((id) => fam.bugs[id].decoy)
  if (mode === 'decoy' && decoyable.length === 0) mode = 'fix1'

  let state = new Set()
  if (mode === 'fix1') state.add(pick(rand, ids))
  if (mode === 'fix2') ids.forEach((id) => state.add(id))
  if (mode === 'decoy') state.add(pick(rand, decoyable))

  const lines = []
  lines.push('TASK', `${fam.spec}`, `Write function ${fam.name}(${fam.params}).`, '', 'CHECKS')
  fam.tests.forEach((args, i) => lines.push(`${call(fam.name, args)} == ${expected[i]}`))

  const attempts = []
  let firstFailure = null
  let decoyUsed = false
  let finalSource = ''
  for (let n = 1; n <= 6; n++) {
    const src = fam.build(state)
    const g = grade(src, fam, expected)
    attempts.push({ flags: [...state], passed: g.passed })
    lines.push('', `ATTEMPT ${n}`, src, 'RUN')
    if (!g.first) {
      lines.push(`PASS (${g.total} of ${g.total})`, '')
      lines.push(n === 1
        ? 'DONE: the first attempt passes every check, so nothing needs to change.'
        : `DONE: every check passes after ${n} attempts.`)
      finalSource = src
      break
    }
    if (!firstFailure) firstFailure = { n, line: failLine(g.first), src }
    lines.push(failLine(g.first), `(passed ${g.passed} of ${g.total})`)

    // Culprit: the flag whose removal makes the first failing check pass (found by running).
    let culprit = null
    for (const f of state) {
      const without = new Set(state); without.delete(f)
      const r = runCall(fam.build(without), fam.name, fam.tests[g.first.index])
      if (r.ok && r.text === g.first.expected) { culprit = f; break }
    }
    culprit ??= [...state][0]
    const baseId = culprit.replace('~', '')
    const bug = fam.bugs[baseId]
    lines.push('FIX', culprit.endsWith('~') ? `That change was not right: ${bug.decoyNote}.` : `The failing check shows it: ${bug.note}.`)
    state = new Set(state); state.delete(culprit)
    if (mode === 'decoy' && !decoyUsed && bug.decoy && !culprit.endsWith('~')) { state.add(baseId + '~'); decoyUsed = true }
  }
  if (!finalSource) throw new Error(`${fam.name}: did not converge`)

  return {
    text: lines.join('\n') + '\n',
    firstFailure,
    finalSource,
    meta: { family: fam.name, mode, attempts: attempts.length, checks: fam.tests.length, flagsPerAttempt: attempts.map((a) => a.flags) },
  }
}

/**
 * Drill contract (same as arithmetic.mjs / coding.mjs): [{ problem, answer }].
 * The problem is the task, the checks, the failing attempt and its real failure; the answer is the corrected
 * function, or "NO CHANGE" for a first attempt that already passes. Decoy traces are left out here because the
 * single correct next step is not the decoy.
 */
export function generateRepairBatch(count, rand = Math.random) {
  const out = []
  while (out.length < count) {
    let mode
    do { mode = pickMode(rand) } while (mode === 'decoy')
    const t = generateRepairTrace(rand, mode)
    const cut = t.text.indexOf('\nFIX\n')
    if (cut === -1) {
      out.push({ problem: t.text.slice(0, t.text.indexOf('\nDONE')) + '\nShould anything change?', answer: 'NO CHANGE' })
    } else {
      out.push({ problem: t.text.slice(0, cut) + '\nWrite the corrected function.', answer: t.finalSource })
    }
  }
  return out
}
