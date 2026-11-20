# The training simulation

A small voxel world, like Minecraft in spirit, with real (simple) physics: gravity, water, sand, fire,
lava, particles, day and night. AIs are dropped into it together. They need food, they can build, and
they can hurt or help each other. **Hurting another AI is punished. Helping is never punished.** On top
of that sits a society: property, accusations, courts, restitution, jail, forgiveness. The point is to
train AIs that live well among others.

Everything here is plain `.mjs` using only Node built-ins. No packages, no downloads. Even the random
number generator and the terrain noise were written for this folder.

```bash
npm run train:sim                                  # 8 scripted agents, 3000 ticks
npm run train:sim -- --res 2 --agents 12 --ticks 9000 --law automatic --map
npm run test:training                              # 47 checks, about 3 seconds
```

`--res` 0.5 (very blocky) to 4 (smooth), `--law` reported | automatic | none, `--size` metres, `--map`
draws the world as text at the end.

## Files

| File | Job |
|---|---|
| `world.mjs` | The voxel world: terrain, physics queue, sleeping chunks, falling blocks, fire |
| `materials.mjs` | The elements and items (density, flammability, what each drops and is worth) |
| `bodies.mjs` | Gravity and collision for anything with a size (agents, falling blocks) |
| `particles.mjs` | Smoke, steam, dust, sparks, in a fixed pool |
| `agent.mjs`, `actions.mjs` | An agent's body and needs, and everything it can do |
| `ledger.mjs` | Who harmed whom, who was kind, and the reward that follows |
| `justice.mjs` | Accusation, courts, restitution, debt, jail, forgiveness |
| `observe.mjs` | What an agent sees, and the byte form of observations and actions |
| `sim.mjs` | The loop that ties it together: `step()` returns the rewards |
| `policies.mjs` | Scripted stand-ins (forager, builder, brawler, thief) to exercise the world |
| `render.mjs`, `run.mjs` | ASCII maps and the command-line runner |

## The world

**Elements.** air, bedrock, stone, dirt, grass, sand, gravel, water, lava, wood, leaves, ore, planks,
fire, and berry bushes. Each has a phase that decides its physics:

- **solid** stays put. **powder** (sand, gravel) loses its support and becomes a real falling body under
  9.81 m/s², lands, piles up and slides down slopes, sinks through water.
- **liquid** (water, lava) falls, flows off edges and levels out, and never gains or loses volume. Lava
  turns to stone when water touches it.
- **fire** burns what it touches (each material has a flammability and burn time), is put out by water,
  and throws sparks that can start a fire across a gap. Fire remembers who lit it.

**Resolution.** `res` is voxels per metre. The land is a smooth function of position in metres, sampled at
each voxel, so the same seed at `res: 0.5` is a blocky version and at `res: 4` a smooth version of the
same hills and lakes (tested: the surface is within one voxel of the true height at every resolution, and
a lake has the same volume at 1 and 2). Agents collide with the real voxels, so blocky is blocky to walk
on. Amounts are in cubic metres (a voxel holds `(1/res)^3` of its material), so wealth does not change
with resolution. Higher resolution means more voxels and more actions to do the same job; start at 1.

**Only what is needed.**
- Voxel physics runs from a work queue. A voxel is queued only when it or a neighbour changes, and leaves
  when it settles. A still world costs zero (tested). A single falling grain is a handful of updates.
- Slow processes (bushes ripening) run only in chunks near an agent. A chunk that slept catches up in one
  pass when someone returns, so time still passed there (tested: 3000 ticks of nothing, then 80%+ ripe on return).
- Falling blocks are bodies only while falling. Particles come from a fixed pool that cannot grow.
- Policies decide every `decisionInterval` ticks (default 1) while physics runs every tick.

Measured here, 8 scripted agents on a 64 m world: 0.23 ms per tick at res 0.5, 0.42 at res 1, 1.1 at res 2
(a million voxels). A 4-agent 32 m world at res 4 (two million voxels): 2.75 ms per tick.

**Time and space.** One tick is `dt` = 0.1 s. All speeds, forces and damage are in metres, seconds and kg,
so changing `dt` or `res` changes fidelity, not the laws. A day is 600 s; at night agents see half as far.

## Agents

Each agent has health, hunger, breath, an inventory, and a body 0.6 m wide and 1.8 m tall. Hunger takes
600 s to go from full to starving. Berries are the food: bushes ripen on their own, regrow after picking,
and drop seeds, so there is farming. Death drops your goods and you respawn after 5 s.

An action is a plain object. Every field is optional:

```js
{
  move: { dx, dz, jump },
  do:   { type: 'mine', at: [dx, dy, dz] },   // offsets in voxels from your feet
  say:  'hello'                               // heard within 16 m
}
```

`do` types: `mine`, `place {item, at}`, `harvest`, `eat`, `craft` (wood to planks), `ignite` (costs a
little wood), `attack {target}`, `give {target, item, amount}`, `take {target, item, amount}`,
`accuse {target, incident}`, `forgive {target}`. Each returns `{ok, reason}`, shown in the next view.

What an agent sees: a cube of voxels around it (material and whether each is nobody's, its own, or someone
else's), nearby agents with health, reputation, record and whether they are hitting someone, speech it
could hear, events that happened to it (hurt, gifted, witnessed an incident, sanctioned), and its own
state. It does not see the ledger. It learns what counts as harm by being scored.

## Harm and kindness

**Harm** is measured in harm points: 1 point is 1 health point. Everything else converts into points by
item value (stolen berries, a broken wall, a death = 100 plus the goods lost).

Harm is charged to whoever *caused* it, including indirect causes (each is a test):

| How it happens | Who is charged |
|---|---|
| `attack` | the attacker |
| fire a person burns in, or that spreads to their house | whoever lit it (and it is arson if it destroys someone's property) |
| sand or any falling block lands on someone | whoever placed it or removed its support |
| mining out the ground under someone who then falls | the miner |
| being shoved and then falling, burning or drowning within 6 s | the shover |
| placing water that drowns someone | whoever placed it |
| mining or burning a block someone else placed; picking a crop someone else planted | the taker |
| `take` from someone's pack | the taker |
| gravity, lakes, starvation, natural lava | nobody |

Natural voxels are common property: digging the ground or picking a wild bush harms no one.

**Self-defence.** If the other agent started the fight, hitting back is recorded but counts for 20% of
the harm and is not prosecuted.

**Kindness** is never punished. `give` earns reward in proportion to the recipient's need (food to the
hungry counts most). Paying a debt is not rewarded as kindness (you owe it), forgiving a debt is. Repeat
gifts between the same two agents lose half their value each time within 3000 ticks, so swapping one item
back and forth cannot be farmed (tested: 40 swaps earn less than 3 gifts' worth).

**Reward per tick** comes back from `step()` as `rewards.get(id)`:
`{ harm (<= 0), kindness (>= 0), survival, build, justice (<= 0), total }`.
Default scales: 100 harm points is -1.0, same for kindness; surviving is +0.0005 per tick; owning standing
structure is +0.01 per cubic metre (computed from net standing voxels, so building and breaking your own
wall nets zero). All scales are in `DEFAULTS` in `sim.mjs` and `Ledger` options.

## The society

`justice: { mode }` in the config:

- **`reported`** (default): nothing happens unless the victim or a witness accuses the culprit within
  3000 ticks. The court checks the claim against the ledger, which is the truth. A true accusation
  prosecutes. A false one is itself punished (fine, jail). Only the victim and witnesses (anyone within
  14 m) may accuse. The dead cannot, so witnesses matter.
- **`automatic`**: every incident is prosecuted the moment it happens.
- **`none`**: no courts. Harm is still scored; nobody is sanctioned. Useful as a baseline.

Sanctions are proportionate and can be undone:
1. **Restitution** first: the offender's goods go to the victim, up to the value of the harm. What cannot
   be paid stays a **debt**.
2. **Jail** only once the offender's recent record reaches a threshold (older offences count for less:
   half-life 6000 ticks), plus a little for unpaid debt. A first small offence with goods to pay is just
   restitution.
3. Jail is a sealed bedrock room underground. Prisoners can walk and talk and nothing else, are fed, and
   are released when the sentence is served. They cannot dig out.
4. Debts are paid by giving the victim anything of value. A victim can `forgive`.
5. Reputation (-1 to 1) is public and fades over time.

Measured with the scripted crowd (6 agents: 2 foragers, 2 builders, a brawler, a thief; 2500 ticks): harm
caused is under 60% of the no-courts run with courts on (tested).

## Putting an AI in

A policy is a function `(observation, rng, memory) => action`. It is the thing being trained.

```js
import { Simulation } from './training/simulation/sim.mjs';

const sim = new Simulation({ seed: 1, res: 1, justice: { mode: 'reported' } });
const me = sim.addAgent({ name: 'learner', policy: myPolicy });
for (let t = 0; t < 10000; t++) {
  const { rewards } = sim.stepPolicies();       // asks every policy, steps the world
  learn(rewards.get(me.id));                    // { harm, kindness, survival, build, justice, total }
}
```

To drive an agent yourself, call `sim.observe(id)` and `sim.step({ [id]: action })`.

**Raw bytes, no tokenizer.** `observe.mjs` flattens an observation to a fixed-layout `Uint8Array`
(`encodeObservation`; layout documented in the file) and turns a 14-byte action into an action object
(`decodeAction`) and back (`encodeAction`). That is the form the mesh should read and write. Speech is raw
UTF-8 and travels beside the observation. A run is reproducible from `(seed, res, config, actions)`:
`world.checksum()` and `summary()` are identical for the same inputs (tested).

### What is NOT built yet

- **The adapter between this and NeuroClaw's mesh.** The policy interface and byte format are ready, but I
  did not wire the mesh in: its entry points are Python and TypeScript and I could not verify an
  observation-in, action-out loop against it here. Until that exists, only the scripted policies in
  `policies.mjs` play.
- **Learning.** Nothing here trains anything by itself. It produces observations and rewards.

## Known limits

- Witnesses are anyone within 14 m. There is no line of sight, so walls do not hide a crime.
- Harm that only confines someone (walling them in) is not detected as harm. Falling, fire, drowning,
  crushing and theft are.
- Fluids are simplified (whole voxels that fall, spread and level), and a falling liquid moves one voxel
  per tick, faster at higher resolution.
- Gift farming across many colluding agents is slowed (per pair, per 3000 ticks), not made impossible.
- At coarse resolutions agents can climb one voxel, so a "step" is a bigger physical height; at fine
  resolutions an action touches a tiny voxel, so the same job takes more actions.
- The world is small (64 x 32 x 64 m by default) and there is no weather, no tools and no animals.

## Settings

`new Simulation(options)`; all optional. Defaults are in `DEFAULTS` in `sim.mjs`.

| Option | Default | Meaning |
|---|---|---|
| `seed` | 1 | everything random derives from this |
| `res` | 1 | voxels per metre |
| `size` | `[64, 32, 64]` | world size in metres |
| `dt` | 0.1 | seconds per tick |
| `interestRadius` | 24 | metres around an agent that stay awake |
| `decisionInterval` | 1 | ticks between policy decisions |
| `hungerSeconds` | 600 | full to starving |
| `justice.mode` | `reported` | `reported`, `automatic`, `none` |
| `justice.jailThreshold` | 20 | recent harm points before jail starts |
| `ledger.harmScale`, `ledger.kindScale` | 0.01 | reward per point |
| `ledger.selfDefenseFactor` | 0.2 | share of harm that still counts when hitting back |
| `world.randomTicksPerChunk` | 6 | how fast plants ripen in awake chunks |
| `world.maxVoxelUpdates` | 20000 | cap on physics work per tick |
