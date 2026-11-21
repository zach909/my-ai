# Benchmarks

## Self-changing math exam

```bash
node benchmarks/math_exam.mjs --solver reference      # the exam checking itself: exact answers, must score 100%
node benchmarks/math_exam.mjs --solver memorise       # canary: knows only the taught facts, must score about 0% on fresh problems
node benchmarks/math_exam.mjs --solver path/to/solver.mjs   # your own model (see below)
node scripts/model-change-test.mjs --solver path/to/solver.mjs   # run it only if the model code changed a lot since the last test
node scripts/model-change-test.mjs --watch --solver path/to/solver.mjs   # stay running; test whenever a big change has settled
node --test test/training/mutating-tests.test.mjs     # unit tests for the generator, ledger and self-checks
```

The exam is randomly generated, so the AI cannot pass it by remembering it:

- **New every run.** A fresh seed picks a random 60% of the small-number facts to teach, then draws problems the AI was never taught (unseen pairs, bigger numbers, chains, worded questions, negative answers). Answers are computed exactly from the parts.
- **Never repeats.** Every problem served is kept as a hash in `.neuroclaw/mutating-tests/math.json` (git-ignored, capped at 20,000) and is never served again.
- **Changes itself.** A kind the AI passes (85%+) gets harder next run; one it fails (35% or less) gets easier. Kinds it fails are drawn more often, kinds it passes less often.
- **Checks itself.** The exact reference solver must score 100% or the exam aborts. A memoriser that knows only the taught facts must score about 0%. The report also gives the gap between taught and fresh problems.
- **Two tracks.** *Anchor* problems always use level 1 and equal weights, so the anchor score is comparable between runs and is the number to watch across model changes. *Adaptive* problems follow the current level and weights and show where the AI is weak now.
- **Replay.** `--seed N` replays a seed; `--recipe report.json` replays a whole earlier exam and changes nothing.
- **Your own solver.** `--solver path/to/solver.mjs`, a module whose default export is `({ train, T, seed, dist }) => ({ name, solve(problem) })`. `solve` returns a number, or `null` for "no answer".

The built-in `mesh` and `zip` solvers ran the compiled TypeScript backend (`dist/`). This repo is now the Android app and no longer builds that backend, so they stop with an explanatory error. The Kotlin engine (`app/src/main/java/com/example/engine/`) is not callable from Node; a solver that reaches it (for example over the sync server) is the missing piece for scoring the real model.

`scripts/model-change-test.mjs` is the trigger. "The model" is `app/src/main/java/com/example/engine/`, `app/src/main/assets/onebrain/` and `training/`. A change is big at 20 changed lines (`--min-lines`), counting uncommitted edits, and small edits add up. It runs the exam, saves the anchor score with the git state to `.neuroclaw/mutating-tests/history.jsonl`, and reports a regression only when the anchor score falls below the median of the last 5 runs by more than chance (about 2.5 standard errors). It is not hooked into git commits or pushes.
