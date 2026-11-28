# Hyper-Dimensional Thinking

Each neuron maintains multiple temporary internal states that change according to both its own input and the state of every other neuron — the design notes' "Higher-Dimensional Thinking": recognizing previous reasoning, avoiding repeated mistakes, and understanding how earlier thoughts influence future decisions.

## Overview

**Purpose**: Nonlinear, multi-dimensional communication across the mesh, so the system can examine and reason about its own internal thought process rather than only ever seeing a flattened scalar per neuron.

| Layer | File | What it is |
|---|---|---|
| TypeScript runtime backend | `models && skills/core/onebrain.ts` — `HyperDimensionalEngine` | A dedicated multi-ball neuron-state engine with novelty detection and live correction |

## `HyperDimensionalEngine` (TypeScript)

```typescript
const engine = new HyperDimensionalEngine({ neuronCount, dimensions, propagationSteps });
const result = engine.process(input);
engine.hasSeenPattern(patternHash);      // has this exact state pattern occurred before?
engine.getPatternNovelty(patternHash);   // how novel is it relative to history?
engine.isExclusiveInput(0.9);            // is one neuron dominating the input topography?
engine.traceNeuron(...);                 // inspect one neuron's own reasoning trace
```

`hasSeenPattern` / `getPatternNovelty` are the concrete mechanism behind "recognize previous reasoning, avoid repeating mistakes" — a state pattern the engine has already seen contributes less novelty-driven change than a genuinely new one. `traceNeuron` is the literal "the model can examine and reason about its own internal thought process": a single neuron's contribution across the propagation history can be inspected directly, not just its final output.

## Firing thresholds (power saving)

Without a threshold every neuron answers every input at once: a crowded room. A firing threshold makes a neuron speak only when what it heard is strong enough, and a neuron that does not speak is not computed, and does not learn from that tick.

Every neuron has its own threshold, and one dial scales all of them:

| Mode | Scale | What happens |
|---|---|---|
| `off` (default) | 0 | Nothing is gated. Byte-identical to the engine before thresholds existed (checked against the committed code over 30 comparisons), and the same speed within measurement noise (between 2% faster and 3% slower over three runs). |
| `balanced` | 0.5 | About half the neurons stay silent. No quality loss measured. |
| `saver` | 0.7 | About 70% stay silent. Measured benefit and cost below. |
| a number 0..1 | | Anything in between or beyond. 1 leaves only the loudest neuron speaking, which destroys recall. |

```typescript
new HyperDimensionalEngine({ ..., firingMode: 'balanced' });   // or firingScale: 0.6
engine.setFiringMode('saver');            // 'off' | 'balanced' | 'saver' | 0..1; false if not understood
engine.setNeuronThreshold(id, 0.5);       // this neuron needs more (or less, 0 = never silenced)
engine.getFiringStats();                  // { mode, scale, eligible, silent, silentFraction }
```

The live pipeline reads `PipelineConfig.firingMode`, else the `NEUROCLAW_FIRING_MODE` environment variable (`off`, `balanced`, `saver`, or a number).

**What it measures.** A neuron's input is the RMS of its pre-activation over its content dimensions (the same per-neuron measure of how hard a neuron is driven that learning already uses). With the default `rank` reference, neurons are put in order of what they heard this tick and the bar is the input at position `scale × threshold`; so scale 0.5 silences the quieter half on any network, loud or quiet. The loudest neuron always fires, so the mesh cannot go silent. `firingReference: 'absolute'` makes a threshold a plain input level instead, which only means something against one network's input scale (about 0.01 on a fresh engine).

**Decided once per tick.** Who fires is decided on the first settle iteration and held. Deciding again every iteration made near-tied neurons flip in and out and the mesh stopped settling (5.5 iterations became 12 to 20). Held, the later iterations compute only the neurons that fired, skip building the network term for the silent ones, and silent neurons skip the learning sweep. Neurons driven from outside, or held by an inactive expert group, are never gated. A silent neuron with vale keeps vale's share of its state.

**Measured** (live pipeline settings, 64 neurons for the quality probes, 336 neurons × 64 dimensions for the timings):

| Scale | Time per tick, read / learn (336×64) | Zip generalization: whole run | Hallucination on unanswerable questions | Recall (next-message replay) |
|---|---|---|---|---|
| off | 179 ms / 297 ms | 203 s | 20.0% | 96% |
| 0.5 | 94 ms / 163 ms (-47% / -45%) | 183 s | 22.7% | 100% |
| 0.7 | 73 ms / 119 ms (-59% / -60%) | 116 s | 25.3% | 100% |
| 0.9 | | 159 s | 31.3% | 100% (0.95: 100%, 0.97: 4%) |
| 1 | | | | 1% |

Three seeds for the zip run, five for recall; per-seed hallucination at a single setting ranges about 10 points, so differences under ~5 points are noise. Above 0.8 it gets slower again, not faster: with very few neurons speaking the wave term settles into a slow oscillation and the settle runs to its ceiling. The quality probes are small scripted tasks on a fresh mesh, not a trained agent; measure on your own network before relying on `saver`.

**Not done yet.** Only `HyperDimensionalEngine`, the live network, has thresholds. The plain `NeuronMesh`, `ElasticCoreBlock` and the Python `asi_core` reference mesh do not. The phone bundle (`mobile/brain/bundle`) is generated and needs `npm run build:phone-brain` to pick this up.

Engineering note: this is one of the hottest paths in the live pipeline, and its performance history is logged concretely in `.jules/bolt.md` — flattening from nested objects to interleaved `Float32Array` buffers with sequential (not strided) access cut processing time from ~38ms to ~28ms for a typical configuration, and pre-fetching `.subarray()` views outside the hot loop reduced GC pressure further.

## The Python mesh's native multi-dimensional state

The Python trainable mesh (see [[Neuron-Mesh]]) doesn't wrap this in a separate engine class — every neuron's state is natively `mesh_dims`-dimensional from the ground up (`ModelConfig(mesh_dims=4, ...)`), and `_last_settled` (once correctly populated — see [[Quantum-Net]] for the bug history) carries the full per-dimension state, not a flattened scalar. The design notes' "every neuron stores variables describing its relationship with every other neuron" is the mesh's D×D connection block per neuron pair (see [[Neuron-Mesh]]), applied natively rather than as an add-on layer.

## Verifying it

`npm test` (`test/smoke.mjs`)'s `testHyperdimensional` and `testInputFlagNoveltyLiveCorrection` cover novelty detection, the self-input flag, and live correction directly. `benchmarks/hyper_benchmark.ts` measures the engine's `process()` throughput (`npx tsx benchmarks/hyper_benchmark.ts`).

## See Also

- [[Home]] - Main wiki page
- [[Neuron-Mesh]] - The substrate this multi-dimensional state runs on
- [[RLM]] - How recognizing a repeated pattern feeds back into avoiding it
- [[Quantum-Net]] - The settled state this reasoning trace is read from

---

*Higher-dimensional thinking is what turns "the mesh produced an answer" into "the mesh can tell you which of its own prior states led there."*
