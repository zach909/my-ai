#!/usr/bin/env node
/**
 * Rate one job end to end, or measure a code tree.
 *
 *   node training/rating/run.mjs measure [dir]    static measurements of a tree (default: the repo)
 *   node training/rating/run.mjs demo             one sample job, rated; AI dimensions stay ungraded (no grader)
 *
 * The flow for one job (rateJob):
 *   1. the GENERATOR produces an output for the job's prompt
 *   2. deterministic checks run on that output               -> works, prompt_fit, composition, security, ...
 *   3. durability runs the generator again and again          -> durability (and stability if given)
 *   4. optional repo measurement of the code it produced      -> modifiability, organization, repo_hygiene
 *   5. a GRADER that is not the generator scores the rest     -> interface, honesty (only if calibrated)
 *   6. scoreReport combines it all; the ledger records it
 *
 * A dimension with no evidence is reported as ungraded. It is never filled in with a guess.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSIONS } from './dimensions.mjs';
import { scoreReport } from './score.mjs';
import { endurance } from './endurance.mjs';
import { measureTree } from './measure-repo.mjs';
import { openLedger, exportTraining, learnability } from './ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/**
 * @param {object} args
 * @param {object} args.job          { id, kind, prompt, checks?: [{dimension, run(output) -> {pass, detail}}],
 *                                     endure?: {runs, trial(i) -> generator output ok?}, repoRoot?: string }
 * @param {(prompt) => Promise<string>} args.generator
 * @param {object} [args.grader]     from createGrader(); omit to leave AI dimensions ungraded
 * @param {object} [args.ledger]     from openLedger(); omit to not record
 * @param {number} [args.round]
 */
export async function rateJob({ job, generator, grader, ledger, round = 0 }) {
  const evidence = [];
  const output = await generator(job.prompt, job);

  for (const c of job.checks ?? []) {
    const r = await c.run(output);
    evidence.push({ dimension: c.dimension, score: r.pass ? 1 : 0, source: 'check', detail: r.detail ?? '' });
  }

  if (job.endure) {
    const e = await endurance(async (i) => job.endure.trial(i, output), { runs: job.endure.runs });
    evidence.push({
      dimension: 'durability',
      score: e.score,
      source: 'endure',
      detail: `${e.survived}/${e.runs} ok; first failure at ${e.firstFailureAt ?? 'none'}; failure-rate 95% CI [${e.ci95.map((x) => x.toFixed(3)).join(', ')}]`,
    });
  }

  if (job.repoRoot) {
    const m = measureTree(job.repoRoot);
    for (const [id, score] of Object.entries(m.scores)) {
      evidence.push({ dimension: id, score, source: 'measure', detail: `${m.files} files, ${m.filesInCycles} in import cycles, ${m.filesOverSize} over ${m.thresholds.maxLinesPerFile} lines, ${m.thirdPartyImportCount} third-party imports` });
    }
  }

  if (grader) {
    if (!grader.calibration) await grader.calibrate();
    const aiDims = DIMENSIONS.filter((d) => d.source === 'ai');
    for (const d of aiDims) {
      evidence.push(await grader.grade({ job, output, dimension: d.id }));
    }
  }

  const report = scoreReport(evidence);
  const record = {
    job: { id: job.id, kind: job.kind, prompt: job.prompt },
    round,
    output,
    generatorId: job.generatorId ?? 'generator',
    graderId: grader?.graderId ?? null,
    graderCalibrated: grader?.calibration?.calibrated === true,
    report,
  };
  if (ledger) ledger.append(record);
  return record;
}

// ---- sample job for the demo: "write slugify(text)". The generator is a stand-in for the in-repo mesh.
const SLUG_TESTS = [
  ['Hello World', 'hello-world'],
  ['  Many   spaces ', 'many-spaces'],
  ['Already-slugged', 'already-slugged'],
];

const sampleJob = {
  id: 'slugify-1',
  kind: 'code.slugify',
  prompt: 'Write slugify(text) that lowercases text and joins words with hyphens.',
  checks: [
    {
      dimension: 'works',
      run: (out) => {
        const fn = new Function(`${out}; return slugify;`)();
        const bad = SLUG_TESTS.filter(([i, want]) => fn(i) !== want);
        return { pass: bad.length === 0, detail: bad.length ? `${bad.length} case(s) wrong` : `${SLUG_TESTS.length}/${SLUG_TESTS.length} cases` };
      },
    },
    {
      dimension: 'prompt_fit',
      run: (out) => ({ pass: /function\s+slugify|const\s+slugify/.test(out), detail: 'defines slugify' }),
    },
  ],
  endure: {
    runs: 50,
    trial: (i, out) => new Function(`${out}; return slugify;`)()(`Run ${i} of the test`) === `run-${i}-of-the-test`,
  },
};

// Stand-in generator for the demo only. Its output is run in-process by the demo's own checks; a real generator's
// output must be run in a sandbox the owner trusts before any check executes it.
const demoGenerator = async () => `function slugify(text) { return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }`;

async function demo() {
  const generator = demoGenerator;
  const ledger = openLedger(path.join(HERE, 'out'));
  const record = await rateJob({ job: { ...sampleJob, repoRoot: path.join(HERE) }, generator, ledger, round: 0 });
  console.log(JSON.stringify({ verdict: record.report.verdict, overall: record.report.overall, coverage: record.report.coverage }, null, 2));
  for (const [id, d] of Object.entries(record.report.dimensions)) {
    console.log(`${id.padEnd(15)} ${d.status.padEnd(9)} ${d.score === null ? '-' : d.score.toFixed(2)}`);
  }
  if (record.report.gatesUngraded.length) console.log(`\nWARNING: gates with no evidence: ${record.report.gatesUngraded.join(', ')}`);
  console.log(`\nledger: ${ledger.file}`);
}

async function measure(dir) {
  const m = measureTree(dir ?? REPO);
  console.log(JSON.stringify(m, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'measure') await measure(arg);
  else if (cmd === 'demo') await demo();
  else console.log('usage: node training/rating/run.mjs measure [dir] | demo');
}

export { exportTraining, learnability, sampleJob, demoGenerator };
