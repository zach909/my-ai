# Net-Skill Routing (replaces the MoE)

NeuroClaw no longer has a Mixture-of-Experts router. Which parts of the network run on a tick is decided by **net-skill routing**: every skill and plugin is a named *region* of neurons inside the one mesh, and a tick switches on the regions whose meaning matches the input.

## Why the MoE went

The MoE (`MoERouter`) was a second network sitting in front of the first. It was a randomly initialised gate matrix whose top-k scores picked "experts", and each expert also carried its own weight matrix. The experts were named after skills, but nothing the skills actually *meant* went into scoring them. A net skill is already a region of the mesh, tuned to its meaning when it is grafted in (see [[Skills]]). So routing only needs to ask which regions the input is about.

## How it works

| Piece | File | What it does |
|---|---|---|
| `NetSkillRouter` | `models && skills/core/net-skill-router.ts` | Embeds each region's meaning with the same `embedText` the graft tunes neurons with. Scores the input (text or vector) against each region by cosine similarity and selects the best `topK` that are related at all. |
| `NetSkillMesh` | `models && skills/core/net-skill-mesh.ts` | Named skill regions in a shared all-to-all `NeuronMesh`, used by the plugin registry. `tick()` routes, then propagates with only the selected regions computing. Formerly `MixtureOfExperts`. |

```typescript
const router = new NetSkillRouter(2);
router.register({ id: 'email', name: 'Email', meaning: 'send and read email messages' });
router.select('check my inbox').ids;  // ['email']: its region is switched on this tick
router.getUsage();                     // how often each region has been selected
```

The selected ids become the tick's `activeGroups`. A neuron in a region nobody asked for holds its state and keeps every connection it had. Everything else stays as described in [[Neuron-Mesh]]: all-to-all, hyperdimensional, wave and quantum terms included.

Used by:
- `NeuroPipeline` (the live agent)
- `UnifiedBrain` / `NeuroclawLLM` (chat)
- the plugin registry

OneBrain is also one of these regions, with id `onebrain`.

## Elastic districts: who learns

Routing decides who *computes*. Elastic districts (`models && skills/core/elastic-district.ts`) use the same decision to decide who *learns*, and sit between the two scales the network already stretches at:

| Scale | What stretches | Where |
|---|---|---|
| Core | One zero-sum value budget over every neuron: points a neuron holds set how slowly it learns. | `ValueRangeAllocator` |
| Neuron | Each neuron's own rate from its own points, a fit within its district, and the network growing a neuron. | `growNetwork()`, the district's `fit` |
| District | An island of neurons with a subject: it opens when the input is about that subject, closes when it is not, and stiffens, stretches or grows with how it is doing. | `ElasticDistricts` |

A district is **defined** (a net skill's region is one already; neurons that belong to nothing and mean alike can be discovered), then **decided** (its members' meanings, taken together, are compared with the subjects the router knows: a match makes it that subject and its neurons take the region's label, no match gives it a subject of its own words, and an island that cannot say what it is is never gated), then **stretched**.

What a tick does with it:

1. The router picks regions, as above. The district hears that choice; it does not make a second one. Only a district whose subject is its own words scores the input itself.
2. `shape()` scales each neuron's learning rate from the value budget: neurons in an asked district rise (never past the budget's own maximum), neurons in every other district drop to `closedGain` (0.1), and neurons in no district keep their rate. If the router asked for nothing, nothing is gated, the same safe default the router uses.
3. After the tick, `observe()` reads how much each asked district's neurons moved **against that district's own recent level**. A spike stretches it back toward full elasticity, and recurring spikes grow one neuron. Movement that has fallen well below its own peak stiffens it, down to `minElasticity`. A steady level does neither.

It scales learning rates and nothing else: not the state gating, the wiring or the weights. `elasticDistricts: false` in the pipeline config puts every rate back exactly as the budget set it.

Limits, measured rather than hoped:

- **Discovery groups by shared words, not meaning.** The embedding compares character runs: descriptions that share a word score 0.1 to 0.3, unrelated ones up to 0.07, related ones with no word in common about zero. "rain forecast" and "storm wind cloud" would not be gathered.
- **A fresh budget leaves little room to speed up.** Every neuron starts near the maximum rate, so early on the effect is protecting the districts that were not asked. The boost has room once the budget has spread out.
- **The pipeline defines one district per expert and per grafted skill.** `discover()` and `rebalance()` are built and tested, but nothing in the live pipeline calls them yet: discovery needs each neuron's description in words, and the live engine keeps a neuron's definition only as a vector.
- **Districts are not saved between runs yet.** `toJSON()` and `load()` exist and round-trip; nothing writes the file.
- A district that has learned a subject from the questions people actually ask (the way the router's own experience does) is not built; its subject is fixed at the words it was defined with.

## Verifying it

`npm test` (`test/smoke.mjs`) covers this in three suites:
- `testNetSkillRouter`: routing picks the region whose meaning matches, deterministically.
- `testNetSkillMesh`: regions are fully wired, and unselected regions do not compute.
- `testExpertRegistrationCompleteness`: every plugin and skill category is a routable region.

Districts are covered by `test/core/elastic-district.test.ts` (opening and closing, settling and growing, discovery and deciding, releasing members, saving and loading).

## See Also

- [[Home]] - Main wiki page
- [[Skills]] - How a skill is grafted into the mesh as a region
- [[Neuron-Mesh]] - What the selected regions actually run against
- [[Plugins]] - The plugin/skill distinction this routing depends on
