# Grow, Prune, Quantize (and why the mesh is neither fully connected nor split apart)

> **Status: design note.** This page records an idea about how the AI should develop over time. It is not a spec, and nothing here is claimed to be implemented beyond what the "Where this already exists" table says.

## The idea

The AI is not meant to be a fixed thing. It is meant to be **driven by complexity**: it goes through stages, and the stages repeat as the problem in front of it demands.

1. **Grow** - add neurons, connections and tools when the work needs more than the mesh can currently do.
2. **Prune** - remove what is redundant, unused or harmful, so the mesh stays small enough to think.
3. **Quantize** - compress what survived into a cheaper form so it can run on small hardware.

These are stages of a life cycle, not a one-time pipeline. A mesh that has been quantized can still be grown again where it hit its limits, then pruned, then re-quantized. How far it grows is set by how complex the task is, not by a number picked in advance.

## Why: the brain argument (from a book)

The point came from a book about the brain. It is a loose analogy, not a claim that the AI is a brain.

- **If every neuron were connected to every other neuron, it would not work.** Everything would influence everything, there would be no structure, and signals would drown in each other. Connectivity has to be selective.
- **If the brain were split into separate, isolated pieces, it would also not work.** Each piece would be one tool for one job with nothing merging them. Thinking that matters happens where the pieces talk to each other.

So the target is the middle: **structured, selective connectivity, with the parts merged into one system.** Grow and prune are how the AI finds that middle for itself instead of being handed it.

A correction to keep the note honest: real neurons are not "all positive". The brain has both excitatory and inhibitory neurons, and the inhibition is a large part of why full connectivity does not collapse into noise. That is a useful hint for this design (see the open questions).

## Every tool does two things

Applying the same principle to tools: no tool should be a lone single-purpose part, and no tool should do everything. **Each tool should do (at least) two jobs**, so tools overlap and merge instead of sitting in isolated boxes.

- A tool with two uses is worth keeping through pruning, because dropping it costs more.
- Two-job tools give the mesh natural bridges between regions, which is the "merged together" half of the brain argument.
- It keeps the tool count down as the system grows, which helps the quantize stage.

Examples of the shape of this (illustrative, not decided): a tool that both *recalls* and *checks* what it recalled; a tool that both *reads* a file and *summarises* it into memory.

## Where this already exists in the repo

| Stage | What already exists | Where |
|---|---|---|
| Grow | The on-device mesh learns by adding new neurons instead of overwriting old ones; the extension mesh has `addNeuron` | [[Wake-Sleep-Islands]], [[Neuron-Mesh]] |
| Prune | Duplicate neurons are dropped; unused memory islands are forgotten at the 256-neuron cap (skills, core and self never are); poor performers are demoted by Vale so they can be repurposed | [[Wake-Sleep-Islands]], [[Elastic-Value-Budget]] |
| Quantize | Trained meshes are compressed for installation; the Python mesh trains with quantization-aware fake-quantization | [[Quantization]], `quantize/` |
| Auto-edit and reconnect | The AI edits its own extensions and regrows connections through hubs | [[Self-Improvement]], [[Wake-Sleep-Islands]] |

What is missing is the part that makes it one idea: nothing yet decides *when* to move between the stages based on complexity. Today each stage is its own mechanism.

## Open questions

1. **This conflicts with the current mesh docs.** [[Neuron-Mesh]] says connectivity is genuinely all-to-all (every neuron one hop from every other). This note says full connectivity is the failure case. One of them has to give: either prune is what turns the dense mesh into a structured one over time, or the all-to-all description needs softening.
2. **What signals complexity?** Candidates: Vale pressure (many neurons locked, little plasticity left), failed or slow answers on a task, how often the same region is overloaded.
3. **Inhibition.** If the brain needs negative connections to stay stable, does the mesh need an explicit inhibitory mechanism, or does zero-sum Vale already play that role?
4. **What counts as "two things" for a tool?** Needs a rule that can be checked, otherwise it becomes a slogan.
5. **Order and cadence.** Does each stage run continuously, on a sleep cycle, or only when triggered?
6. **Protect the core.** Whatever prunes and quantizes must keep the existing guarantees: the core stays bit-identical, skills and self are never forgotten, and the Vale total stays zero-sum.

## See also

- [[Wake-Sleep-Islands]] - growth and pruning as they exist today
- [[Neuron-Mesh]] - the all-to-all substrate
- [[Elastic-Value-Budget]] - the zero-sum plasticity budget
- [[Quantization]] - compressing the result
