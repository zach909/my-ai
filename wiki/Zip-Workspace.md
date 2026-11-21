# Zip Workspace (design draft)

> **Status: design only. Nothing here is built.** Written from a design conversation. Where a point is a guess about what was meant, it says **Open**. The core TypeScript sources (`models && skills/core/*`) are not in this checkout, so what is said below about existing code comes from this wiki and `test/smoke.mjs`, not from reading the source.

The agent does everything through the [[Zip-IO|Zip Loop]] doorway: **three output neurons, `0`, `1` and the ramp**. This page describes (1) the folder tree the agent works in, (2) a small language, written entirely in those bits, that lets it jump around, leave holes and link things, and (3) how the Hive Mind uses it.

## Goals

1. **As many steps as possible before an output.** Every step is a chance to notice a mistake and fix it. So the language has tiny steps, a way to undo one, and feedback after each.
2. **Parallelism**, even though one agent emits one bit at a time (see Superposition and the Hive Mind below).
3. **Everything is bits.** Jumping, linking, spawning and voting are written in `0`/`1` like any data.

## The archive

```
agent.zip
├── prompt/
│   ├── prompt
│   ├── skills/
│   └── chat_history/            new; one file per turn, append-only
├── response/                    notes and the other required output files
├── tools/
│   └── <tool-name>/
│       ├── ...whatever the tool needs to work
│       └── response/            the tool's result lands here (written by the harness)
├── prediction/
│   └── prediction.zip           one zip: what the response is expected to be
└── mods/<name>/                 plugins/mods may add files and folders
```

- The doorway takes a gzip of a `ZipTree` (`packZip`, see [[Prompt-Memory]]); "the zip" here means that tree.
- The existing dial folders (`neurons/`, `effort/`, `questions/`) are part of the input tree already; this layout sits beside them.
- **Manifests.** Every folder says which files it requires and whether new children are allowed. `FINAL` is refused while a required file is missing.
- **Mods** write under `mods/<name>/` by default and may extend a manifest to add files or folders elsewhere. Paths are canonicalized (no `..`) and sizes are capped, because a mod writing arbitrary paths into an archive is an attack surface.
- **Tool flow.** The agent calls a tool, the harness runs it, and the result is written into `tools/<tool>/response/`. The agent reads it and cannot write there.
- **Chat history** is one file per turn so two agents never write the same file.

**Open:** what `prediction/` is for. Current guess: the agent writes what it expects the response to be *before* it arrives, and the difference between prediction and response is a surprise signal. Is it a zip nested inside the zip, as the layout says?
**Open:** the top-level `response/` is read here as the agent's own output (notes and required files), separate from each tool's `response/`.

## Writing in bits: the op language

The agent does not write the zip. It writes **ops**; a deterministic **materializer** replays them into the tree and packs it. This is what makes "jump around" possible with only `0`, `1` and the ramp.

- A **message is one op**. The doorway already ends a message when the ramp stops flipping (3 read ticks), so no extra "send" symbol is needed.
- Opcodes are a short prefix code. Numbers are self-delimiting (Elias-gamma style). The live mesh is slow (about a second per input byte, per [[Zip-IO]]), so ops must be tiny.
- **Address by path + hole id, never by bit offset.** An insert would shift every later offset. Bit positions are used only inside one file.

| Op | Effect |
|---|---|
| `SEEK` | Move the cursor to a path or hole |
| `DATA` | Write bits at the cursor |
| `HOLE` | Reserve a named empty slot, to be defined later |
| `FILL` | Define a hole |
| `LINK` | Link two cells and say what the link is (below) |
| `COLLAPSE` | Resolve a link |
| `DELEGATE` | Give a hole to another agent, with a comment as its brief |
| `COMMENT` | Ephemeral note, **never saved**: stripped when the zip is packed |
| `RETRACT` | Undo an earlier op (the log is append-only, so this is cheap) |
| `FINAL` | Ship the zip. Refused with open holes, unresolved links or missing required files |
| `SPAWN` / `MOTION` / `VOTE` | Hive Mind ops (below) |

**Feedback after every op.** The materializer feeds the new state, a diff or an error back in through the input side. Many small steps only give self-correction if each step is *observed*; otherwise they are just many blind steps.

Forward references are the point of holes: leave something empty and define it later, the way an assembler backpatches. A zip's own offsets and CRCs are exactly this kind of reference, and the materializer computes them.

## Superposition (`LINK`)

One agent emits one bit at a time, so it cannot literally write two places at once. `LINK` is the substitute: **the agent links two cells and says what the link is**, and from then on the one stream of bits fills both.

Relations (a first list, to be settled):

| Relation | Meaning |
|---|---|
| `MIRROR` | Both cells always hold the same bits |
| `INVERT` | The second is the bitwise opposite of the first |
| `EITHER` | The two are **alternatives**, both kept open until collapsed |

`EITHER` is the superposition proper: both candidates exist, later steps can build on either, and a `COLLAPSE` picks one. A collapse can come from the agent, from a vote, or from the validator. The existing `QuantumNeuralNet` already has `createSuperposition`, `collapse` (Born rule), `interfere` and `groverAmplify` ([[Quantum-Net]]); whether to reuse it for this is undecided.

It is a constraint-linked cell (a propagator network), not parallel hardware. Guards: a cap on live links, and unresolved links block `FINAL`.

**Open:** "link two things together and say what they are" is read here as *a link with a declared relation*. If it means something else, this section changes.

## The Hive Mind as a tool

The Hive Mind is a tool the agent can run, one of many. Review, delegation and voting are patterns built on it, not hard-wired into the core.

What already exists (per [[Commons]], [[Task-Training]] and `test/smoke.mjs`): `HiveMind` with a zero-sum trust budget of 100, default-deny capabilities, `delegate()` by capability, a shared blackboard with conflict detection, and a vote where **every agent has exactly one vote, votes are counted not weighed, a motion needs a strict majority of everyone allowed to vote, and whoever a removal is about does not vote on it.** Trust does not buy a vote; it weights how much an agent's learning counts in the merge.

Agent kinds this design needs:

| Kind | Votes | Talks to | Permissions |
|---|---|---|---|
| **Peer** (democracy) | one vote each | everyone | by grant |
| **Sub-agent, private** | none | its parent only | at most its parent's |
| **Sub-agent, mesh** | none | its parent and its siblings | at most its parent's |

- A peer can move to **shut down** any other agent, to change permissions, or to ship. Each is a motion decided by vote.
- **Creating a voter is itself a motion.** A sub-agent has no vote, so spawning cannot buy votes.
- A child's permissions are at most its parent's, so a sub-agent can never exceed whoever created it. Bigger permissions need a motion.
- When an agent is shut down, its write leases are released.
- All of this is written in bits with `SPAWN`, `MOTION` and `VOTE`.

**Open:** [[Commons]] says the hive adds "sub-AIs (helpers)" for busy folders. This page assumes helpers have **no vote**. Does that match?
**Open:** can a sub-agent ever hold *more* permission than its parent, or only fewer? The wording was "less permissions, bigger permissions".

### Review is a recipe, not a primitive

A writer is biased toward what it wrote; a fresh reader is not. **The difference is context, not weights.** So a review is: spawn a sub-agent with a **fresh context** and give it the artifact and the spec, but **not** the author's history or comments (comments are never saved, so it sees a clean artifact), then swap write permission.

- Reviewer makes no edits: it passes. Reviewer edits: the edit goes back, and the loop continues until nobody edits.
- **Swap** is an atomic exchange of the write lease on a region, so exactly one agent writes at a time and conflicts cannot occur.
- Guards: a maximum number of rounds, and a hash of the region after each round so two agents undoing each other's edits are caught, then escalated by a vote.
- Run deterministic checks (required files present, no open holes, legal paths) **before** any agent reviews.

## Permissions

| Region | Agent | Harness | Mods |
|---|---|---|---|
| `prompt/`, `skills/` | read | - | by grant |
| `chat_history/` | append | append | by grant |
| `response/` | write | - | by grant |
| `tools/<t>/response/` | **read only** | write | - |
| `prediction/` | write | - | - |
| `mods/<name>/` | by grant | - | write |

## Open questions

1. What `prediction/` is for (above).
2. What the top-level `response/` holds (above).
3. Do sub-agents/helpers vote? Can a child exceed its parent?
4. Exactly what `LINK` should mean.
5. Which relations `LINK` needs beyond `MIRROR`, `INVERT`, `EITHER`.
6. Whether to reuse `QuantumNeuralNet` for `EITHER`.
7. Where the materializer lives, given the TypeScript core is not in this checkout.

## See Also

- [[Zip-IO]] - the doorway's three output neurons and the ramp
- [[Quantum-Net]] - superposition, interference, collapse
- [[Commons]] - the hive's votes, reviews and trust
- [[Task-Training]] - the `hive` mode and the shared blackboard
- [[Prompt-Memory]] - `ZipTree` and `packZip`
- [[Plugins]] - the plugin systems mods would extend
