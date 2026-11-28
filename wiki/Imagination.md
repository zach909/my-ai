# Imagination

Two things a brain does, built into the one [[Neuron-Mesh|mesh]]:

1. **Recalling is rebuilding.** A memory is not played back from one place. It is put together again from pieces, and each time different neurons carry it, so each rebuild lands a little differently.
2. **Imagining is the same machinery on things that never happened together.** Take pieces of memories chosen at random and put them together.

Code: `models && skills/core/imagination.ts` (`Imagination`). Tests: `test/core/imagination.test.ts`.

## How a memory is held

A memory is spread over a pool of the mesh's neurons (every neuron from id 8 up, clear of the Zip Loop doorway). No neuron holds all of it. Each holds a **partial, slightly wrong view**: a random quarter of the memory's dimensions, each with a little error.

## Recalling

`recall(id)` drives a fresh random half of the pool with its views (`setNeuronState`), reads the memory back off those neurons (`readNeuronContent`), and averages. Then it puts every neuron back exactly as it was.

- The set of neurons is different every time, and **never the same as that memory's last recall**.
- Every recall says which neurons carried it, how far it is from the clean memory (`error`), and how many dimensions no driven neuron covered (`gaps`, left at 0, not guessed).

Measured (6 memories, 48-neuron mesh, 32 dimensions, 200 recalls): error 0.002 to 0.041 and never exactly 0, so no recall is an exact replay; two recalls in a row share about a third of their neurons (0.34, what two random halves give); a recall left 0 to 2 of 32 dimensions uncovered.

## Imagining

`imagine({ parents })` recalls 2 to 6 **real** memories chosen at random, each through its own random neurons, and cuts them together one dimension at a time (each dimension comes from one parent; averaging would wash all of them out). It returns the pattern, the parents with the share each gave, the neurons used, and a `novelty` score (1 minus the cosine to the nearest memory held). It tries again if the result is too close to something held.

Measured on the same setup: novelty 0.10 to 0.65 over 100 imaginations, mean 0.40.

## What keeps it honest

- **An imagination is never taken for a memory.** Nothing is kept unless you call `keep`, and a kept one stays tagged `imagined`, lists its parents, and shows `source: "imagined"` when found or recalled.
- **It does not feed on itself.** Imagination draws only from real memories unless you pass `includeImagined`.
- **It never pushes a real memory out.** Bounded at `capacity` (256); imagined ones go first, and when the store is full of real memories `keep` keeps nothing and returns null.
- **The mesh is left as found.** Pool neurons are restored exactly; no weight and no connection is changed. A test checks the whole mesh before and after.
- Held in memory only. Nothing is written to disk.

## Limits

- The trace lives in the layer, and the mesh carries it only while it is read. The live mesh forgets a neuron's state within a few ticks, so the mesh's own dynamics are not run on the result.
- An imagination is a **pattern plus its parents' labels**. The mesh has not been taught to write, so it cannot say what it imagined in words.
- Nothing calls it yet: there is no chat or API route, and nothing dreams on a timer. It is the machinery, tested on the real engine (toy and live-sized).
- It models the two facts above. It is not a model of a brain.
