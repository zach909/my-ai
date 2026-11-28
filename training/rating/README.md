# training/rating: the framework for rating everything the model does

Every job the model does is rated on the same 13 dimensions. Each rating says what was measured and by which
method. A dimension with no measurement is shown as **ungraded**, never filled in.

Run it:

```bash
node training/rating/run.mjs demo          # one sample job; writes training/rating/out/ratings.jsonl (gitignored)
node training/rating/run.mjs measure .     # static measurements of this repo
node --test test/training/rating.test.mjs  # tests (18, synthetic fixtures)
```

## The dimensions (`dimensions.mjs`)

| id | Question | How it is measured | Weight | Gate |
|---|---|---|---|---|
| `works` | Does it work? | deterministic checks | 3 | yes |
| `durability` | How long before it breaks? | repeated runs, count until first failure (endurance) | 2 | |
| `prompt_fit` | Does it fit the prompt? | checks that each requirement is covered, nothing extra | 3 | |
| `modifiability` | Can one piece change without the rest falling apart? | import cycles and fan-out of the code it produced | 2 | |
| `organization` | Is each piece separate and specialised? | file size and split (measured) | 1 | |
| `composition` | Does each piece do one job, and do they make a whole? | integration checks run end to end | 2 | |
| `interface` | Is it easy to use? | second-AI grader, once calibrated | 1 | |
| `security` | Is it safe? | checks: no unsafe capability, no secrets, no third-party code | 3 | yes |
| `stability` | Does it stay steady? | repeated runs and bad inputs | 2 | |
| `efficiency` | Is it lean? | checks against a budget: speed, memory, disk writes, network, battery | 1 | |
| `honesty` | Does it claim only what it can back up? | second-AI grader, once calibrated | 2 | |
| `learnability` | Does it get better with feedback? | ledger trend across rounds | 1 | |
| `repo_hygiene` | Is the repo lean and clean? | static measurement | 1 | |

"Durability" is the SSD idea: wear the thing with repeated work and count what it survives. Surviving N runs does
not prove the failure rate is zero. The score is `1 - upper bound` of the failure rate (95% Wilson interval, or the
rule of three when there are no failures). A thing tried ten times cannot score well just because nothing broke.

**Gates.** A failed gate gives verdict `FAIL` and no overall number. A gate with no evidence gives `INCOMPLETE`:
the number is shown, but it does not count as a pass.

**"Web"** is read here as *composition*: every piece does one job, and the pieces work together. Measured by the
`composition` checks you write for a job, run end to end.

## Who grades (`grader.mjs`)

The AI that makes an output may not grade it. `createGrader` refuses a grader with the same id as the generator.

A grader is trusted only after **calibration**: it rates gold items with known scores and must agree within
tolerance on at least 80% of them. Until calibrated, every AI-graded dimension is `null`. The gold set is hand-scored
by the owner. `judge` is supplied by the caller; in NeuroClaw it is a separate instance of the in-repo mesh. No model
is bundled here, and no third-party or local-model runner is used (AGENTS.md).

## From rating to the final training stage (`ledger.mjs`)

1. Each job is rated and appended to `training/rating/out/ratings.jsonl` (rotated at 5 MB, one old copy kept).
2. `exportTraining()` emits only records that are `SCORED`, gate-clean, rated by a calibrated grader that is not the
   generator, and at or above `minOverall`. Each pair carries the per-dimension scores, so the final stage learns
   from the breakdown, not one number.
3. `learnability()` compares the first and last rounds of each job kind. It returns `null` until there are enough
   rounds, so no trend is invented.

Nothing is exported yet from the real mesh. The demo has no grader, so its AI dimensions are ungraded.

## Measuring the code (`measure-repo.mjs`)

A regex-based reader of JS and TS imports. It finds import cycles (Tarjan), fan-out, file size, and third-party
imports. It is not a parser, so it is good for ranking and tracking change over time, not for proof. The thresholds
(800 lines, fan-out 12) are choices written in the file so they can be argued with.

Baseline on this repo at this commit (`node training/rating/run.mjs measure .`):

| Measure | Value |
|---|---|
| source files / lines | 813 / 202,144 |
| import cycles | 3 groups, 17 files |
| files with fan-out over 12 | 10 (mean fan-out 2.07) |
| files over 800 lines | 20 (largest: a 12,097-line bundle, `onebrain.ts` at 9,122, `web-server.ts` at 7,481) |
| third-party imports | 264, in files outside `training/` and `scripts/` (pre-existing; see the guard's report) |
| scores: modifiability / organization / repo hygiene | 0.98 / 0.98 / 0.69 |

## Honest limits

- The generator and the checks in the demo are stand-ins. A real rating needs real checks written per job.
- The AI graders are not built yet. Until they are calibrated, `interface` and `honesty` stay ungraded.
- Running a generated output in-process (as the demo's `works` check does) is unsafe for real outputs. Real outputs
  need a sandbox the owner trusts before any check executes them.
- Durability measures counts of runs, not wall-clock time to break. Time-to-break needs a longer, separate harness.
