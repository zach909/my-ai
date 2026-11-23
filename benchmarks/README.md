# Performance Benchmarks

This directory contains performance benchmarks for the core neural network components.

## Running Benchmarks

### All Benchmarks
```bash
bun run bench
```

### Individual Benchmarks

#### HyperDimensional Engine
```bash
bun run bench:hyper
```
Benchmarks the hyperdimensional neural engine with configurable neuron count, dimensions, and propagation steps.

#### NeuronMesh
```bash
bun run bench:mesh
```
Benchmarks the neuron mesh propagation with all-to-all connectivity.

#### NeuronMesh — parallel (worker_threads)
```bash
bun run bench:mesh-parallel
```
Compares the same dense propagate() step run serially against
`MeshWorkerPool`, a multi-core `node:worker_threads` backend that shards
the O(n²) weighted-sum across threads via `SharedArrayBuffer` + `Atomics`
(see `mesh-worker-pool.ts` / `mesh-worker-thread.ts`, wired in through
`NeuronMesh.setParallelBackend()`). Node-only (Bun works too, since both
support `worker_threads` + shared memory); not available in a browser
bundle. Uses a 1,000–2,000 node mesh rather than `bench:mesh`'s 200,
because that's the range where the parallel win actually shows up —
below `parallelMinNodes` the coordination overhead exceeds what
parallelizing saves, which `bench:mesh`'s smaller mesh deliberately
stays under.

#### MoE Router
```bash
bun run bench:moe
```
Benchmarks the Mixture-of-Experts router with configurable expert count and dimensions.

## Optimization Techniques Applied

The codebase implements several performance optimizations:

1. **Typed Arrays**: Using `Float32Array` instead of regular arrays for better memory locality and SIMD potential
2. **Loop Unrolling**: Manual 4x-8x loop unrolling in hot paths to reduce branch overhead
3. **Cache-Friendly Memory Layout**: Row-major storage for weight matrices to enable sequential memory access
4. **Pre-allocated Buffers**: Reusing scratch buffers instead of allocating on every iteration
5. **Branchless Operations**: Using ternary operators instead of `Math.abs()` for performance
6. **JIT Warmup**: Including warmup iterations to ensure optimal JIT compilation
7. **Sparse Computation Fast-paths**: Skipping zero-value multiplications in sparse operations
8. **Specialized Code Paths**: Different optimized loops for common configurations (e.g., top-K=1,2,4)

## Metrics Reported

Each benchmark reports:
- Average execution time per operation (ms)
- Operations per second (throughput)
- Configuration details
- Total iterations run

## Self-changing math exam (`bench:math`)

```bash
node scripts/build-backend.mjs
npm run bench:math                    # one exam: fresh random problems, the arithmetic mesh is taught then examined
npm run test:model-change             # run it only if the model code changed a lot since the last test
npm run watch:model                   # stay running; test whenever a big change has settled
```

The exam is randomly generated, so the AI cannot pass it by remembering it:

- **New every run.** A fresh seed picks a random 60% of the small-number facts to teach, then draws problems the AI was never taught (unseen pairs, bigger numbers, chains, worded questions, negative answers). Answers are computed exactly from the parts.
- **Never repeats.** Every problem served is kept as a hash in `.neuroclaw/mutating-tests/math.json` (git-ignored, capped at 20,000) and is never served again.
- **Changes itself.** A kind the AI passes (85%+) gets harder next run; one it fails (35% or less) gets easier. Kinds it fails are drawn more often, kinds it passes less often.
- **Checks itself.** The exact reference solver must score 100% or the exam aborts. A memoriser that knows only the taught facts must score about 0%. The report also gives the gap between taught and fresh problems.
- **Two tracks.** *Anchor* problems always use level 1 and equal weights, so the anchor score is comparable between runs and is the number to watch across model changes. *Adaptive* problems follow the current level and weights and show where the AI is weak now.
- **Replay.** `--seed N` replays a seed; `--recipe report.json` replays a whole earlier exam and changes nothing.
- **Your own solver.** `--solver path/to/solver.mjs`, a module whose default export is `({ train, T, seed, dist }) => ({ name, solve(problem) })`. `solve` returns a number, or `null` for "no answer".

`scripts/model-change-test.mjs` is the trigger. "The model" is `asi_core/`, `models && skills/`, `model && skills manager/` and `training/`. A change is big at 20 changed lines (`--min-lines`), counting uncommitted edits, and small edits add up. It rebuilds the backend first so the exam never measures a stale `dist/`, runs the exam, saves the anchor score with the git state to `.neuroclaw/mutating-tests/history.jsonl`, and reports a regression only when the anchor score falls below the median of the last 5 runs by more than chance (about 2.5 standard errors). `npm test` runs it too.

It is not hooked into git commits or pushes: `.githooks/` and `.claude/settings.json` are guard files only the owner may edit.
