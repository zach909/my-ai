#!/usr/bin/env node
/**
 * joint-tune.mjs -- tune the harness, the tools and the learned side as ONE
 * optimization, and say honestly how much each part contributed.
 *
 * The idea being tested: "tuning the product, the harness, the tools and the
 * model system all as one optimization". Tuned separately, each part is fitted
 * to the others as they happen to be today, and the combination is never
 * measured. Here the three groups are searched together against one score.
 *
 * What counts as which group, in this project:
 *
 *   harness  the router's own numbers (RouterTuning: how much a matching term
 *            is worth, how far remembered success can push a plugin).
 *   tools    what each plugin is worth when two genuinely overlap (a per-plugin
 *            weight offset on top of what the plugin declares).
 *   model    the learned routing memory (RoutingMemory): the part that is
 *            trained from examples rather than set by hand.
 *
 * The score is how often the right plugin is ranked first for a message typed
 * the way a person would type it. It is a proxy, and it is only about routing:
 * it says nothing about whether the chosen plugin then does the job well.
 *
 * Why this is honest rather than flattering:
 *   - Every number reported as "test" is on messages the search never saw.
 *     Train accuracy is shown next to it, so overfitting is visible, not hidden.
 *   - Two folds are run in both directions and averaged, because on a case
 *     list this small a single split is mostly luck.
 *   - The joint result is then ablated: each group is put back to its default
 *     and the held-out score re-measured, so the report says what each group
 *     was actually worth inside the combination, not just on its own.
 *   - Nothing is written to the repo. The tuning is printed (and with
 *     --out <file> saved as JSON) for the owner to look at and decide on.
 *
 * Needs a built backend (`node scripts/build-backend.mjs`). Node built-ins only.
 *
 * Usage: node scripts/joint-tune.mjs [--json] [--out file.json] [--passes N]
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const load = (rel) => import(path.join(ROOT, 'dist', rel))

const args = process.argv.slice(2)
const passesArg = args.indexOf('--passes')
const PASSES = passesArg >= 0 ? Math.max(1, Number(args[passesArg + 1]) || 3) : 3
const outArg = args.indexOf('--out')
const OUT_FILE = outArg >= 0 ? args[outArg + 1] : null

/**
 * Hand-labelled messages, written the way a person would type them rather
 * than in a plugin's own command syntax (routing a plugin's literal command to
 * itself proves nothing). Some are deliberately the kind the router is likely
 * to miss -- a score that cannot go down is not measuring anything.
 */
const CASES = [
  ['where am I right now', 'location'],
  ['share my gps coordinates', 'location'],
  ['am I near the office', 'location'],
  ['take a photo', 'camera'],
  ['snap a picture of this', 'camera'],
  ['turn on the camera', 'camera'],
  ['record some audio', 'microphone'],
  ['start listening through the mic', 'microphone'],
  ['dictate a note for me', 'microphone'],
  ['what is on my calendar tomorrow', 'calendar'],
  ['add a meeting to my calendar for friday', 'calendar'],
  ['am I free on monday afternoon', 'calendar'],
  ['send an email to my brother', 'email'],
  ['check my inbox for new email', 'email'],
  ['reply to that email from work', 'email'],
  ['look up a phone number in my contacts', 'contacts'],
  ['find sarah in my address book', 'contacts'],
  ['add a new contact', 'contacts'],
  ['add a task to buy milk', 'tasks'],
  ['show my task list', 'tasks'],
  ['mark that task as done', 'tasks'],
  ['send a message to mum', 'messaging'],
  ['read my new messages', 'messaging'],
  ['show my notifications', 'notifications'],
  ['clear all my notifications', 'notifications'],
  ['read a file off the disk', 'file-system'],
  ['save this to a file', 'file-system'],
  ['open the downloads folder', 'file-system'],
  ['open a browser and go to the news', 'browser'],
  ['browse to that website', 'browser'],
  ['control the robot arm', 'robotics'],
  ['move the robot forward', 'robotics'],
  ['this code has a bug in it', 'coding'],
  ['debug my program', 'coding'],
  ['refactor this function', 'coding'],
  ['generate an image of a castle', 'image'],
  ['make an image of a cat', 'image'],
  ['generate a video of waves', 'video'],
  ['find out about a topic for me', 'research'],
  ['research the history of rome', 'research'],
  ['investigate this on the web', 'research'],
  ['write a page about neural meshes in the wiki', 'wiki'],
  ['add this to the wiki', 'wiki'],
  ['run a shell command for me', 'terminal'],
  ['open a terminal', 'terminal'],
  ['put this in the shared catalogue so other people can get it', 'store'],
  ['what have I got installed from the catalogue', 'store'],
  ['install something from the store', 'store'],
  ['stop the agent touching my desktop', 'computer-access'],
  ['what permissions does it currently have', 'computer-access'],
  ['ask the team what they think', 'hive'],
  ['delegate this to another agent', 'hive'],
  ['schedule a job for tomorrow morning', 'schedule'],
  ['take a screenshot', 'screenshots'],
  ['record my screen', 'screenshots'],
  ['publish this to github', 'github-publish'],
  ['push this repo to github', 'github-publish'],
  ['calculate 15 percent of 80', 'tools'],
  ['hash this string for me', 'tools'],
  ['remember that I like tea', 'memory-topics'],
  ['recall what we said about the project', 'memory-topics'],
  ['create a passkey for this site', 'passkeys'],
  ['make a phone call', 'phone-calls'],
  ['show my call history', 'call-history'],
  ['turn on the radio', 'radios'],
  ['make a new skill that summarises text', 'skill-maker'],
  ['make a plugin for my music player', 'plugin-maker'],
  ['heal yourself, that module is broken', 'self-heal'],
  ['run the app diagnostics', 'app-diagnostics'],
  ['show my account info', 'account-info'],
  ['turn on voice activation', 'voice-activation'],
  ['show the running processes', 'os-commands'],
]

// ---- measuring ----------------------------------------------------------

const DEFAULTS = { overlapWeight: 4, intentPriorMax: 6, learnedCap: 12 }

/** A candidate = the three groups. `memoryRepeats` 0 means the memory is empty. */
const blank = () => ({
  harness: { overlapWeight: DEFAULTS.overlapWeight, learnedCap: DEFAULTS.learnedCap },
  tools: {}, // pluginId -> integer offset
  memoryRepeats: 0,
})
const copy = (c) => ({
  harness: { ...c.harness },
  tools: { ...c.tools },
  memoryRepeats: c.memoryRepeats,
})

function makeScorer(router, ids) {
  const known = new Set(ids)
  const apply = (candidate) => {
    router.tuning = {
      overlapWeight: candidate.harness.overlapWeight,
      intentPriorMax: DEFAULTS.intentPriorMax,
      learnedCap: candidate.harness.learnedCap,
      weightOffsets: { ...candidate.tools },
    }
  }
  const trainMemory = (candidate, examples) => {
    // Always start from an empty memory so a run does not depend on whatever
    // this machine happened to learn, then train it only from `examples`.
    router.memory.import({ evidence: {}, records: 0 })
    for (let r = 0; r < candidate.memoryRepeats; r++) {
      for (const [msg, id] of examples) if (known.has(id)) router.memory.recordSuccess(msg, id)
    }
  }
  const tally = (evalSet) => {
    let top1 = 0
    let top3 = 0
    for (const [msg, id] of evalSet) {
      const ranked = router.rank(msg, [])
      if (ranked[0]?.id === id) top1++
      if (ranked.slice(0, 3).some(r => r.id === id)) top3++
    }
    return { top1, top3 }
  }

  /** Memory trained on trainSet, scored on a different evalSet (held-out). */
  function score(candidate, trainSet, evalSet) {
    apply(candidate)
    trainMemory(candidate, trainSet)
    return { ...tally(evalSet), n: evalSet.length }
  }

  /**
   * Score on the TRAIN set without letting the memory see the case it is being
   * scored on (leave-one-out). Scoring the memory on the very examples it was
   * just trained on makes it look perfect, which lets it soak up every miss
   * and leaves nothing for the harness or the tools to be credited with -- the
   * first version of this search did exactly that and reported "joint" as
   * worse than tools alone.
   */
  function scoreLeaveOneOut(candidate, trainSet) {
    apply(candidate)
    if (candidate.memoryRepeats === 0) {
      trainMemory(candidate, trainSet)
      return { ...tally(trainSet), n: trainSet.length }
    }
    let top1 = 0
    let top3 = 0
    trainSet.forEach((one, i) => {
      trainMemory(candidate, trainSet.filter((_, j) => j !== i))
      const t = tally([one])
      top1 += t.top1
      top3 += t.top3
    })
    return { top1, top3, n: trainSet.length }
  }

  return { score, scoreLeaveOneOut }
}

// ---- searching ----------------------------------------------------------

const l1 = (c) => Object.values(c.tools).reduce((n, v) => n + Math.abs(v), 0)
/** Lexicographic: more top-1, then more top-3, then the smaller change. */
const better = (a, b) =>
  a.top1 !== b.top1 ? a.top1 > b.top1
    : a.top3 !== b.top3 ? a.top3 > b.top3
      : a.cost < b.cost

/**
 * Coordinate descent over the groups named in `groups`, scored on the train
 * set only. Groups not named stay at their defaults, which is how the
 * single-group and ablated runs are produced with the same code.
 */
function search(scoreFn, train, groups, candidateIds) {
  let best = blank()
  const trainScore = (c) => ({ ...scoreFn.scoreLeaveOneOut(c, train), cost: l1(c) })
  let bestScore = trainScore(best)

  const tryAccept = (cand) => {
    const s = trainScore(cand)
    if (better(s, bestScore)) { best = cand; bestScore = s; return true }
    return false
  }

  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false

    if (groups.has('model')) {
      for (const r of [0, 1, 2, 3]) {
        const cand = copy(best); cand.memoryRepeats = r
        if (r !== best.memoryRepeats && tryAccept(cand)) moved = true
      }
    }
    if (groups.has('harness')) {
      for (const w of [2, 3, 4, 5, 6, 8]) {
        const cand = copy(best); cand.harness.overlapWeight = w
        if (w !== best.harness.overlapWeight && tryAccept(cand)) moved = true
      }
      for (const cap of [0, 4, 8, 12, 16, 24]) {
        const cand = copy(best); cand.harness.learnedCap = cap
        if (cap !== best.harness.learnedCap && tryAccept(cand)) moved = true
      }
    }
    if (groups.has('tools')) {
      for (const id of candidateIds) {
        for (const delta of [+1, -1, +2, -2]) {
          const cand = copy(best)
          const next = (cand.tools[id] ?? 0) + delta
          if (Math.abs(next) > 8) continue
          if (next === 0) delete cand.tools[id]; else cand.tools[id] = next
          if (tryAccept(cand)) moved = true
        }
      }
    }
    if (!moved) break
  }
  return best
}

// ---- main ---------------------------------------------------------------

const { getNeuroclawSystem } = await load('src/index.js')
const registry = (await getNeuroclawSystem()).pluginRegistry
const router = registry.getRouter()
const ids = router.index.map(e => e.id)
const known = new Set(ids)

const cases = CASES.filter(([, id]) => known.has(id))
const dropped = CASES.length - cases.length
const scoreFn = makeScorer(router, ids)
const candidateIds = [...new Set(cases.map(([, id]) => id))]

// Two folds, both directions. Alternating keeps every plugin in both halves
// where it has more than one example.
const foldA = cases.filter((_, i) => i % 2 === 0)
const foldB = cases.filter((_, i) => i % 2 === 1)
const splits = [
  { train: foldA, test: foldB },
  { train: foldB, test: foldA },
]

const ALL = new Set(['harness', 'tools', 'model'])
const RUNS = [
  ['defaults (no tuning)', new Set()],
  ['harness only', new Set(['harness'])],
  ['tools only', new Set(['tools'])],
  ['model only', new Set(['model'])],
  ['JOINT (all three)', ALL],
]

const results = []
const jointConfigs = []
for (const [label, groups] of RUNS) {
  let train = 0, test = 0, test3 = 0, nTrain = 0, nTest = 0
  const configs = []
  for (const sp of splits) {
    const cfg = search(scoreFn, sp.train, groups, candidateIds)
    configs.push(cfg)
    const tr = scoreFn.scoreLeaveOneOut(cfg, sp.train)
    const te = scoreFn.score(cfg, sp.train, sp.test)
    train += tr.top1; nTrain += tr.n
    test += te.top1; test3 += te.top3; nTest += te.n
  }
  if (label.startsWith('JOINT')) jointConfigs.push(...configs)
  results.push({ label, train: train / nTrain, test: test / nTest, test3: test3 / nTest, configs })
}

// Ablation inside the joint solution: put one group back to default, keep the
// rest as the joint search found them, and re-measure on the held-out half.
const ablations = []
for (const group of ['harness', 'tools', 'model']) {
  let test = 0, nTest = 0
  splits.forEach((sp, i) => {
    const cfg = copy(jointConfigs[i])
    if (group === 'harness') cfg.harness = blank().harness
    if (group === 'tools') cfg.tools = {}
    if (group === 'model') cfg.memoryRepeats = 0
    const te = scoreFn.score(cfg, sp.train, sp.test)
    test += te.top1; nTest += te.n
  })
  ablations.push({ group, test: test / nTest })
}

// Final tuning: search once on ALL cases for the owner to look at. There is no
// held-out data left for this one, so it is reported as a candidate, not a score.
const finalConfig = search(scoreFn, cases, ALL, candidateIds)
const finalOnAll = scoreFn.scoreLeaveOneOut(finalConfig, cases)

const pct = (x) => `${(x * 100).toFixed(1)}%`
const base = results[0]
const joint = results[results.length - 1]

console.log('\n--- joint tuning: harness + tools + model as one optimization ---')
console.log(`  ${cases.length} labelled messages${dropped ? ` (${dropped} dropped: plugin not registered here)` : ''}, ${ids.length} plugins, 2 folds in both directions, ${PASSES} passes max\n`)
console.log('  search                  train (LOO)   held-out top-1   held-out top-3')
for (const r of results) {
  console.log(`  ${r.label.padEnd(22)}  ${pct(r.train).padStart(10)}   ${pct(r.test).padStart(14)}   ${pct(r.test3).padStart(14)}`)
}

console.log('\n  What each group was worth INSIDE the joint solution (held-out top-1):')
console.log(`    joint            ${pct(joint.test)}`)
for (const a of ablations) {
  const d = joint.test - a.test
  console.log(`    without ${a.group.padEnd(8)} ${pct(a.test)}   (${d >= 0 ? '-' : '+'}${Math.abs(d * 100).toFixed(1)} pts when removed)`)
}

const sumSeparate = ['harness only', 'tools only', 'model only']
  .map(l => results.find(r => r.label === l).test - base.test)
  .reduce((a, b) => a + b, 0)
const jointGain = joint.test - base.test
console.log('\n  Interaction check:')
console.log(`    gains of the three groups tuned separately, added up: ${(sumSeparate * 100).toFixed(1)} pts`)
console.log(`    gain of tuning them together:                         ${(jointGain * 100).toFixed(1)} pts`)
console.log(`    -> ${jointGain > sumSeparate + 0.005 ? 'together beats the sum: the groups interact' : jointGain < sumSeparate - 0.005 ? 'together is worth LESS than the sum: the gains overlap (they fix the same cases)' : 'no measurable interaction on this data'}`)

const overfit = joint.train - joint.test
console.log(`\n  Train-vs-held-out gap for the joint search: ${(overfit * 100).toFixed(1)} pts${overfit > 0.15 ? '  <- large; the search is fitting noise in the training half' : ''}`)

console.log('\n  Candidate tuning fitted on all cases (no held-out data left; a proposal, not a score):')
console.log(`    harness: overlapWeight=${finalConfig.harness.overlapWeight}, learnedCap=${finalConfig.harness.learnedCap}`)
console.log(`    model:   memory trained from the labelled cases x${finalConfig.memoryRepeats}`)
const toolEntries = Object.entries(finalConfig.tools).sort()
console.log(`    tools:   ${toolEntries.length ? toolEntries.map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(', ') : 'no weight offsets'}`)
console.log(`    leave-one-out on those cases: ${finalOnAll.top1}/${finalOnAll.n} (top-3: ${finalOnAll.top3}/${finalOnAll.n})`)

console.log('\n  Limits: routing only; ~' + cases.length + ' cases is a small sample; labels are one person\'s judgement;')
console.log("  'train (LOO)' never lets the memory see the message it is scoring.")

const report = {
  cases: cases.length,
  plugins: ids.length,
  results: results.map(({ configs, ...r }) => r),
  ablations,
  interaction: { separateSum: sumSeparate, joint: jointGain },
  candidate: finalConfig,
}
if (OUT_FILE) {
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2))
  console.log(`\n  wrote ${OUT_FILE}`)
}
if (args.includes('--json')) console.log(JSON.stringify(report))
process.exit(0)
