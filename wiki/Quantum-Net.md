# Quantum Neural Net

Every neuron carries a unique wave signature; a neuron's input determines its wave amplitude, and the signature identifies it during interference calculations — the design notes' example is literal: "Neuron 2 has a wave signature of 4.5 and an amplitude of 10." This is §5 / the Quantum Neural Network background system, and it runs on ordinary hardware today while leaving a natural path to real quantum backends later.

## Overview

**Purpose**: Let phase-aligned neurons reinforce each other and discordant ones cancel — a genuine complex-arithmetic consensus mechanism, not a metaphor — used both as an answer-selection strategy and (in the TypeScript mesh) as a gate inside the forward pass itself.

| Layer | File | What it is |
|---|---|---|
| TypeScript runtime backend | `models && skills/core/onebrain.ts` — `QuantumNeuralNet` | Signature/phase computation, pairwise and group interference, Born-rule (`amplitude²`) probabilistic collapse |

## `QuantumNeuralNet` (TypeScript)

```typescript
qnn.addNeuron(neuronId, inputValue);                 // computes the wave signature internally (Neuron 2 -> 4.5, per the design example)
qnn.createSuperposition(neuronId, possibleInputs);    // one candidate state per possible input
const combined = qnn.interfere(neuronIdA, neuronIdB); // genuine complex addition: |zA + zB|
const consensus = qnn.phaseConsensus(neuronIds);       // group-level agreement, can genuinely cancel
qnn.groverAmplify(neuronIds, targetId);               // amplify one candidate's amplitude
const collapsed = qnn.collapse(neuronId);             // Born rule: P ∝ amplitude², not uniform
```

Interference is implemented as real complex arithmetic (`zA + zB`, magnitude of the sum), not a cosine-similarity approximation — a corrected bug in this project's history was `phaseDiff` always being `0`, which made every interference computation destructive by default regardless of actual phase alignment. `collapse()` samples proportional to amplitude², matching the Born rule rather than a flat average across candidates.

## `select_by_interference` (Python)

Each of the `n` generated candidates gets an amplitude (its rescaled confidence) and a phase — the network's own settled-state phase right after generating that candidate. Candidates whose settled state agrees in phase with the group's consensus reinforce each other; a lone outlier phase gets cancelled toward zero even if its raw confidence looked good — Grover-style amplification of a rare-but-correct answer over several confident-but-wrong ones. This only activates for `arch="mesh"` models (it falls back to plain confidence ranking otherwise), and it shares the [[RLM]] ledger's repeat-discounting with `best_of_n`.

**A previously-hidden bug** in this project's history: `NeuronMesh._last_settled` was declared but never actually assigned during `forward()`, so `state_phase()` always returned phase `0.0` for every candidate — silently degrading interference selection down to plain amplitude weighting with no real phase consensus happening at all. Fixed at the source in `mesh.py`; `select_by_interference` has worked as designed since.

## Full QNN backend (switchable, Python `asi_core/quantum_net.py`)

An optional replacement for the classical neuron activation, **off by default**. Pure standard library: the "quantum hardware" is an exact state-vector simulator in this repo (complex numbers in a list, `2**n` amplitudes).

| Classical | Quantum backend |
|---|---|
| neuron | qubit |
| scalar weight | rotation-gate angle (RY, RZ) |
| matrix multiply | unitary evolution + entangling ring |
| activation function | measurement (Born rule, exact or sampled `shots`) |
| backprop | parameter-shift rule (two extra circuit runs per angle) |

```python
core = NeuralCore()
core.set_quantum(True, max_qubits=6, depth=2, encoding="reupload", shots=0, noise=0.0)
core.quantum_status()           # which layers, circuit runs, and the physical limits
core.set_quantum(False)         # back to the classical activations
core.set_quantum(True, layers=["hidden1"])   # one layer only
```

Other switches: `NeuralLayer.set_quantum(...)`, a `"quantum": {"enabled": true, ...}` key in the core config, or `NEUROCLAW_QUANTUM=1`. Bad settings raise `ValueError` before anything changes. Membrane integration, refractory period, threshold adaptation and spiking stay classical; only the scalar activation is replaced.

**Pipeline.** Inputs are encoded as rotation angles (`angle`, or `reupload` which re-encodes every layer) or as state amplitudes (`amplitude`, via `QuantumBlock.distribution`). Trainable RY/RZ rotations plus a ring of two-qubit gates (CZ by default, `entangler="cnot"` optional) evolve the state; amplitudes interfere; qubits are read out as `P(qubit = 1)` in [0, 1]. Wider layers are split into independent blocks of `max_qubits`, because simulating n qubits costs `O(2**n)` per gate.

**The four physical limits, and what the code does**

| Limit | Handling |
|---|---|
| Linearity | No ReLU. Non-linearity comes from angle encoding (`sin`/`cos`), data re-uploading and measurement. |
| No-cloning | Activations are never cached. `QuantumBlock.gradients` uses parameter-shift; `train` fits by MSE. |
| Barren plateaus | Near-identity init (`init_scale`), shallow depth, local readout. `barren_plateau_probe()` measures gradient variance against width (global cost shrinks fastest). |
| Decoherence | `noise` = depolarising probability per qubit per gate layer, averaged over `trajectories` runs. |

**Entangler choice.** A CNOT ring XORs each qubit with its neighbour; at rest every qubit reads 0.5, so a single neuron's input is masked. CZ leaves Z-basis probabilities alone, so at identity init each neuron reads `(1 + sin x) / 2`, a sigmoid-like baseline, and entanglement acts through later rotations.

**Cost** (default 352-neuron core, per `update`): classical 30 ms; quantum 4 qubits/depth 1 33 ms; 6 qubits/depth 2 62 ms; with 256 shots 80 ms; with `noise=0.01` (8 trajectories) 197 ms. Keep it off when idle or on battery unless you want it.

Tests: `python3 -m pytest asi_core/test_quantum_net.py`.

## Using it

```bash
python core.py --ckpt checkpoints/gpt.pt --select interference
```

`core.py`'s session banner confirms which strategy is active ("§5 interference" vs. plain confidence), and it's one of the mechanisms `python main.py demo` (`test_integration.py`, §5) verifies is genuinely active in a real scripted session, not just parsed and ignored.

## See Also

- [[Home]] - Main wiki page
- [[Neuron-Mesh]] - Where the wave signatures and settled-state phase actually come from
- [[RLM]] - The repeat-discounting ledger shared with confidence-based selection
- [[Elastic-Value-Budget]] - How a neuron's amplitude interacts with its vale during learning

---

*The quantum layer runs in the canonical mesh today, on classical hardware, with no external dependency — a bridge to future quantum backends, not a requirement for one.*
