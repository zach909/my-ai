# Wake-Sleep Islands

How the on-device OneBrain mesh **learns by growing new neurons** instead of overwriting old ones, and keeps a small model of what it contains (a "sense of self").

> Honest scope: this is a small hyperdimensional mesh running in pure Kotlin on the phone. It borrows the *shape* of wake/sleep consolidation into spare mixture-of-experts capacity. It is **not** language-model distillation (no GKD/LTI, no teacher model), and it does not hold 10M tokens. Written with no third-party code and no tokenizer: text enters as raw bytes. Everything below was measured on this code; the numbers are in [What was measured](#what-was-measured), including the parts that did not help.

## The problem it fixes

Before this, a new skill or correction was **blended into an existing neuron** (`hash(name) % 32`), and every chat message was mixed into *every* neuron that looked a bit similar. New knowledge slowly overwrote old knowledge, and the mesh could never be bigger than 32 neurons.

## The shape

| Phase | What happens | Code |
|---|---|---|
| **Wake** | Chat only *reads*. The message is routed to the islands that recognise it. **No weight changes.** If nothing learned recognises it, it waits in a short-term buffer. | `IslandMesh.wake()` |
| **Base frozen** | The 32 pretrained core neurons form an island that is never trained, so nothing learned later can erase them. | `IslandKind.CORE` |
| **Sleep 1: spare experts** | Waiting experiences are clustered. A cluster nothing already knows gets a **new island** of fresh neurons (2 to 6), born from that content and trained only on it. A cluster an island already knows strengthens that island instead of duplicating it. | `IslandMesh.sleep()` |
| **Pruning** | Neurons that duplicate a sibling are dropped. At the 256-neuron cap, memory islands unused for 20+ cycles are forgotten (skills, core and self never are). | `prune()`, `ensureRoom()` |
| **Sleep 2: dreaming** | It invents cues from its own islands (a slice, dropped words, a question form, a shuffled slice), rehearses them, and measures recall on a *separate* set of cues it never rehearsed. **Measured gain: none yet** (see below). | `dream()` |
| **Self** | Two neurons are trained on a map of every other island. `describeSelf()` reads it back. | `IslandKind.SELF` |

New skills (a grafted extension) and corrections skip the waiting room: deliberate teaching gets its island immediately (`learnNow`). Re-grafting an unchanged skill (every app start) does nothing; an edited one retrains its own island in place.

## When does it want to sleep?

Each unfamiliar experience adds its novelty (1 minus how well the best island recognised it, so anything under 0.42 similarity counts as new) to a pressure counter. At **3.0** it sleeps on its own, which is roughly three fully new messages, and the reply ends with `[slept] ...`. Familiar messages add nothing. You can also say **"sleep"** (or "go to sleep" / "consolidate") in chat, or call `OneBrainEngine.sleepNow()`.

## The sense of self

Ask "who are you", "what have you learned" or "describe yourself". It answers from its own state: how many neurons and islands, how many are frozen base, the newest and oldest thing it learned and why, what it reaches for most, how it last slept (and its dream recall), what is waiting for sleep, and how up to date its self island is. Example:

> I have 58 neurons in 14 islands: 32 frozen base neurons that learning never touches, 0 skill island(s), 12 memory island(s) and my self island. Newest: "Avogadro's number counts the particles i" (cycle 13, slept on 1 novel experience(s), novelty 0.76). Oldest: "The Schwarzschild radius of a black hole" (cycle 4). Slept at cycle 13: consolidated 3 experience(s) into 3 new island(s) (+6 neurons). Dreamed 24 rehearsals; held-out recall 100% -> 100%. Mesh is now 58 neurons. 0 new experience(s) are waiting for sleep (pressure 0.0/3.0). Average surprise 0.30; my self-model is 99% up to date with what I contain. This is a readout of my own state, not a claim to be aware.

It is a readout of real state, not awareness, and says so. The history (sleep count and the last sleep) is saved, so it is still the same self after a restart.

## Per-island dials (soft, not on/off)

Each learned island has three dials, set on the **Metrics screen (Telemetry tab, "Island Dials")** and saved with the island. The defaults (x1, +0, x1) change nothing.

| Dial | Range | What it does |
|---|---|---|
| **Link x** (`gain`) | 0 to 4 | Multiplies how strongly a message connects to this island. x2 doubles it; 0 mutes it. |
| **Link +/-** (`bias`) | -1 to +1 | Adds to that link. Negative pushes the island down; positive lets it answer to messages that only loosely match. |
| **Weights x** (`influence`) | 0 to 4 | Scales how much this island's neuron weights count in the self-model's map of the mesh. |

Link strength is `match x gain + bias`, and an island answers once that clears `ROUTE_MIN` (0.42), so a dial moves an island across the line gradually instead of flipping it. It feeds routing (`route()`) and novelty (`novelty()`), so an island turned up also makes its subject count as familiar sooner and an island turned down makes it novel again. Sleep, clustering and dreaming keep using the raw match, so the dials never skew learning, and a dial never changes a neuron or a vale (a check asserts it; only the self island is refreshed). The frozen core and the self island have no dials.

Honest limit: the Kotlin mesh has no neuron-to-neuron links inside an island, so "Weights x" cannot scale internal wiring. It scales the island's weight in the self-model only. Scaling real internal wiring existed only in the deleted TypeScript compute islands.

## The vale budget

Still zero-sum, now **one point per neuron**, so the budget grows with the mesh. A newborn neuron keeps half its point (plastic, learns fast) and the other half goes to the existing neurons in proportion (what they know hardens a little). Pruning retires a point. Nothing else changes the total, and a test checks it after growth, pruning and use. Use moves vale only, never a weight.

## The encoder

Islands recognise content with their own encoder (`IslandEncoder`). It follows the Zip Loop rule: **raw UTF-8 bytes in, no tokenizer, no word list**. Every overlapping 4-byte window is hashed to a signed position in a 64-dimension vector (ASCII letters folded to lower case at the byte level). It is position-independent, so dropping or reordering words barely moves it. The legacy `HDVector.encodeBytes` and its 32-D vectors are unchanged for regions, yes/no doorways and memory traces.

Why a new one: with the old encoder a sentence barely resembled itself minus two words, so real facts were judged "already known" and never learned. Measured on 12 unrelated sentences:

| | old byte encoder, 32-D | island encoder, 64-D |
|---|---|---|
| unrelated pairs, mean similarity | 0.24 (max 0.56) | **0.03 (max 0.26)** |
| same sentence minus 2 words | 0.30 | **0.88** (min 0.75) |
| keyword-only query vs its own sentence | not measured | 0.46 or more (best wrong island 0.35 or less) |

At 32-D the keyword case overlapped the unrelated range, which is why the mesh is 64-D. `FAMILIAR_SIM` and `ROUTE_MIN` (0.42) sit in that measured gap. (An earlier version split text into words and dropped stop-words; it tested slightly better on keyword queries but is a word tokenizer, so it was removed.)

## Saved state

Learned islands (every trained neuron, its vale, use and reinforcement counts) and the sleep history are written to `onebrain_islands.json` in the app's files folder whenever the mesh sleeps or a skill or correction is learned, and reloaded at start. **Short-term experiences waiting for sleep are not saved**: like a context window, they are gone if the app closes before it sleeps. Mesh deltas (`neuroclaw-mesh-delta-v2`) now carry islands and *add* the ones you don't have; an island you already have is never replaced, so importing twice changes nothing. A v1 delta (ledger and regions only) still imports.

## What was measured

Run on the final code (no third-party libraries; the checks are plain Kotlin).

**12 unrelated facts, 4 wake/sleep rounds, from a fresh mesh:**

- Growth: 34 to 58 neurons, 12 memory islands, one per fact.
- Exact-fact recall 12/12. Keyword-query recall (never seen verbatim) 12/12. Off-topic questions routed to an island: 0 of 9.
- The self island ends 99% up to date with what the mesh contains (a cosine between the self neuron and the weighted map of every island, so this one is partly by construction).

**10 closely related facts (all about one topic, sharing most of their words):** the limit shows. Related experiences cluster, so 10 facts became about 7 islands, and on a fixed set of held-out queries (the first half of each sentence, and a keyword version) the right island came back **70% of the time**. A lexical encoder confuses sentences that share vocabulary. A paraphrase that shares no words with what was learned will not be recognised at all.

**Dreaming, A/B on those same fixed held-out queries (same mesh, slept with and without dreaming, 8 seeds):**

| | no dreaming | with dreaming |
|---|---|---|
| 12 unrelated facts | 100% | 100% |
| 10 related facts | 70% | 70% (identical on all 8 seeds) |

**Dreaming shows no measurable gain, and no harm.** On the unrelated set recall was already saturated. The reason is plausible: the reported gains for language models come from the model inventing *new* inferences about a fact, while here the synthetic cues are only slices and shuffles of the island's own text, so there is no new information to rehearse. It stays because it is deterministic, touches only learned islands, and its held-out recall number is real. Do not expect jumps like 32% to 49%.

**Isolation (asserted by tests):** the core is bit-identical after any amount of learning, and learning island B leaves island A bit-identical. Wake changes no weight and no vale. Vale sums to exactly one point per neuron after growth, pruning and use.

## What is not built

- No sleep button in the UI yet: chat command, auto-sleep and `sleepNow()` only. The Metrics screen shows islands, sleeps and experiences awaiting sleep.
- The TypeScript desktop mesh (`NeuronMesh`, `ElasticCoreBlock`) is not part of this change; this is the Android OneBrain engine.
- "Distillation" is the stored experience pulling its island's neurons toward it. There is no teacher model.
- The app itself was not built or run on a device: the Android SDK was not available. The island mesh and the real `OneBrainEngine`/`OneBrainModel` were compiled and exercised on a plain JVM with a stand-in for the Android `Context` and `DeviceTools`; the Compose screens (`MetricsScreen`) were edited but not compiled.

## Checks

- `app/src/test/java/com/example/engine/IslandMeshChecks.kt`: 25 dependency-free checks, with the command to run them in the file header. (No JUnit: the project takes no third-party code.)

## See Also

- [[Elastic-Value-Budget]] - the zero-sum plasticity idea this budget follows
- [[Neuron-Mesh]] - the all-to-all mesh on the desktop side
- [[Auto-Route]] - *compute* islands (switching parts of a network off), a different thing
- [[Memory-Topics]] - the plain-text notes memory, separate from the neuron mesh
