# Auto Route

For each message the AI picks three things itself, instead of you turning dials:

| It picks | How | Where |
|---|---|---|
| **Effort** (0-100) | from how big and how careful the job looks (length, code, several steps, "prove", "carefully", "briefly"). The same dial as [[Zip-IO]]'s `effort`, so it rides the Zip Loop exactly like a hand-set one. | `models && skills/core/auto-route.ts` |
| **Where to answer** | `local-quantized`, `local-full`, or `remote` (a bigger computer you added, or your hosted server). "Cloud" means that remote engine; no outside service is used. | `engine-chooser.ts` (unchanged), called by auto-route |
| **How much processor** | how many *islands* of the network run (below). More effort runs more; a busy or low-battery device runs fewer; an island the message needs always runs. | `weight-islands.ts` |

Two switches beside the chat box:

- **Instant**: answer fast. Effort 5, the lightest local engine, only the single most relevant island, no prompt tidy-up.
- **Optimize prompt**: tidy the message before it is sent. It only takes things out (filler at the start, a word typed twice, a repeated sentence or line, extra spaces and blank lines, `???`). It never adds anything, and leaves code exactly as typed. `prompt-optimizer.ts`.

**Auto** (on by default in the page) turns the picking on. A dial you set by hand (`effort` in the request) always wins over the estimate; Instant wins over both. The three-dots panel under a reply shows what was picked and why.

API: `POST /api/chat` takes `auto`, `instant`, `optimize` (only a real `true` counts) and answers with `details.autoRoute`. `NEUROCLAW_AUTO_ROUTE=1` turns Auto on for the whole install.

## Islands

Imagine every weight is only a 0 or a 1: a connection is there or it is not. Most strong connections run between neurons that work together, so once the weak ones are rounded down to 0 the network falls apart into groups wired to each other and to nothing else. Each group is an island, and an island nobody needs for this message can be switched off. It is a mixture of experts that makes itself.

`partitionIslands()` picks the threshold itself (just above the steepest fall in link strength), finds the islands (union-find), and measures how much of all the weight lies inside them (`insideMass`). Below 60% the split is not real and **the whole network runs**. `planIslands()` then chooses which run. Islands are named as group labels (`applyIslandLabels()` -> `setNeuronGroup`), which the engine already gates on with `activeGroups`.

It never changes a weight: the 0/1 view is a copy, and labelling a neuron changes no wiring.

### What is real today

- Effort, where to answer, Instant, Optimize prompt, the page switches and the details panel: real and tested.
- **The live mesh has no islands.** Measured on a fresh build: 213 neurons, fully dense (45,156 connections), 2% of the weight inside the best split. So nothing is switched off yet and the panel says "whole network (no islands found yet)". Islands only appear where training makes some connections far stronger than others; making the weights sparse and clustered is a training step that is not built.
- The island plan is computed, but the live generate path does not take `activeGroups` yet, so even with islands it would not switch compute off until `llm.generate` passes them to the engine.

## Privacy

Auto never sends a message to another computer unless borrowing is already on (`NEUROCLAW_CHOOSER=1`, see [[Privacy-Policy]]), and a message that looks like it holds a secret never leaves the device. Everything else runs on this device.

## See Also

- [[MoE]] - net-skill routing, which this sits beside
- [[Zip-IO]] - the effort port
- [[Neuron-Mesh]] - the all-to-all mesh the islands are cut from
