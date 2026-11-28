# The walking simulation

A blank, flat, endless plane with gravity, and one creature that has to learn to walk on it. No blocks,
no water, no other agents, no rules about right and wrong: just physics, a body, and a goal marker. This
is the plain physics counterpart to [`../simulation/`](../simulation/README.md) (the voxel world with a
society in it).

Everything here is plain `.mjs` using only Node built-ins (including the worker threads that use all the
CPU cores). No packages, no downloads, no physics engine, no ML library. The solver, the body, the
neural network and the learner were all written for this folder.

```bash
npm run train:walk                       # teach it, about 8 minutes on 4 cores; saves out/walker.json
npm run train:walk -- --generations 60 --pairs 16     # a quick try (about a minute)
npm run play:walk                        # watch the saved walker as text: path on the plane, footfalls, audit
npm run play:walk -- --seed 7 --gait     # another episode, with the footfall chart
npm run play:walk -- --untrained         # the network before learning: it just stands
NEUROCLAW_SLOW_TESTS=1 node --test test/training/physics.test.mjs   # also run the learns-to-walk check
```

The checkpoint is rebuilt by training, so `out/` is not committed (see `.gitignore`).

## Files

| File | Job |
|---|---|
| `world.mjs` | The physics: points, rigid bones, muscles, gravity, the ground plane, Coulomb friction |
| `body.mjs` | The creature: torso, four legs with hip and knee hinges, 8 muscles, how to read its pose |
| `env.mjs` | The task: goal markers, what it senses, reward, falling, and the raw-byte form of senses and commands |
| `policy.mjs` | The brain being trained: a small neural network in one flat weight array |
| `es.mjs` | The learner: evolution strategies (try small changes, move toward what worked) |
| `eval-pool.mjs`, `eval-worker.mjs` | Run the learner's rollouts on several CPU cores |
| `train.mjs`, `play.mjs` | Command line to train and to watch and audit |

## The physics

Units are metres, seconds, kilograms and newtons. Y is up and the ground is the plane `y = 0`.

The solver is position-based dynamics with 8 small substeps per control step (1/240 s each). Each substep
moves every point by its velocity and gravity, pulls connected points back to their rest lengths, pushes
points out of the ground, applies friction there, and reads the new velocity from how far each point
actually moved.

What is real, and each of these is checked by a test:

- **Gravity** is 9.81 m/s². A dropped point matches the analytic fall to within half a solver substep and
  rests exactly on the plane.
- **Friction is Coulomb friction.** A foot sticks while the sideways push is below `mu` times the push
  into the ground, and slides when it is above. A sliding point with friction 0.2, 0.5, 0.8 and 1.2 stops
  within 1% of the `v² / (2 mu g)` distance. Feet grip more (1.1) than the body (0.6).
- **The ground only pushes.** Nothing goes below the plane, however hard the muscles pull.
- **Bones are rigid.** A standing creature keeps every bone within 1% of its length for 20 s.
- **Muscles are limited like muscles.** Each has a maximum force (250 N), a maximum shortening speed
  (0.9 m/s), and a 60 ms activation lag, so a command moves the real activation over about that long.
  A muscle cannot lift more than it is strong enough for and cannot twitch faster than a real one.
- **No free energy.** A creature dropped onto the plane never has more energy than it started with.
- **Same run every time.** The same seed and policy give identical results, on one thread or many.

What is simplified, so you do not mistake it for more: the body is made of point masses (no rotational
inertia of its own), the ground is perfectly flat and rigid, there is no air flow (only a small linear
drag), and a landing is perfectly inelastic.

## The body

A four-legged creature, about 14 kg, 0.6 m long, 0.44 m wide and 0.4 m tall at the belly. A rigid box
torso, and four legs that each have a hip hinge and a knee hinge. A hinge is made the way a real one
works: the knee is held at fixed distances from two hip points that lie along the hinge axis, so it can
only swing around that axis. Each leg has two muscles, so there are **8 controls in all**: one number in
[-1, 1] per muscle. 20 points, 68 constraints; one control step costs about 35 microseconds.

Why four legs and not two: balancing on two legs from scratch is a much harder learning problem (the
body is unstable at rest). Four legs get walking working first. A two-legged body is another builder
function next to `buildCreature`; the world, task and learner do not care what the body is.

## The task

The creature starts standing. A goal marker is on the ground a few metres away. When it arrives, a new
marker appears 2.5-4.5 m away in a new direction, so "walking around" means walking, turning and walking
again. If it falls over (body lower than 14 cm or tilted past about 63°), the episode ends.

**Senses (27 numbers, each already scaled to about [-1, 1])**: which way is down in its own axes, its
velocity and spin in its own axes, the goal's direction and distance, how long each muscle is, which feet
touch the ground, its height, and a slow clock. It is **not** told where it is in the world or which way
north is, and a test shifts the whole scene and checks that nothing it feels changes.

**Reward per step**: metres gained toward the goal, plus 3 on arrival, minus a small cost for effort,
minus a small cost for jerky commands, minus 2 for falling. Nothing in it describes how to walk.

## The learner

A 27-32-8 neural network (1,128 weights) in one flat array. Training is **evolution strategies**: perturb
the weights with random noise, score both the noise and its mirror image on the same episodes, rank the
scores, and move the weights toward the noise that helped, using Adam's step scaling. No backpropagation.
A noise vector is rebuilt from its seed, so the worker threads only exchange numbers. The goal starts
straight ahead and widens to a full circle over the first 60% of training, so it learns to walk before it
learns to turn. The saved checkpoint is whichever network did best on **held-out episodes** (seeds it
never trained on, goals in every direction).

## Results

One training run (500 generations, 80 rollouts each, 468 s on 4 cores, seed 1), judged on 6 episodes it
never trained on (seeds 9001-9006, 20 s each, goals in every direction):

| | Untrained network | After training |
|---|---|---|
| Falls | 0 of 6 (it just stands) | 0 of 6 |
| Metres gained toward goals | 0 | 8.1, 12.7, 17.7, 19.7, 16.4, 18.4 (mean 15.5, about 0.78 m/s) |
| Goals reached in 20 s | 0 | 2, 4, 5, 5, 5, 6 (mean 4.5) |
| Bones stretched at most | 1.5% | 5.8% to 10.2% |
| All feet off the ground | under 3% | 13.5% to 17.0% of the time |
| Foot slide while planted | 0 | 0.58 to 0.74 m/s |

The footfall chart (`play.mjs --gait`) shows real stance and swing phases lasting several frames each,
with some flicker, and one foot is lifted most of the time. A different seed gives a different gait; the
numbers above are one run, not an average over runs.

## Putting a different brain in

Any object with `act(obs, out)` that fills `out[0..7]` with numbers in [-1, 1] can drive the creature:

```js
import { WalkEnv, rollout } from './training/physics/env.mjs';
const stats = rollout({ act: (obs, out) => { /* write 8 numbers */ } }, new WalkEnv(), 1234);
```

**Raw bytes, no tokenizer.** `encodeObservation` turns the 27 senses into 27 bytes, and `decodeAction`
turns 8 bytes into muscle commands (`encodeAction` and `decodeObservation` go the other way), the same
idea as `training/simulation/observe.mjs`. A test drives the creature with a brain that only reads and
writes bytes.

**Not built: the connection to NeuroClaw's neural mesh.** The byte form and the policy interface are
ready, but the mesh's entry points are Python and TypeScript and I did not wire them in or verify an
observation-in, action-out loop against it. Until that exists, the walker is the small network in
`policy.mjs`, trained by `es.mjs`. It is not the mesh learning to walk.

## Honest limits

- **The gait is functional, not elegant.** The audit in `play.mjs` is there so this stays visible: it
  walks and turns and does not fall, but it often favours three legs, lifts a foot while another skates a
  little, and stretches a bone by up to about 10% under load (the sanity limit that ends an episode is 25%).
- **The first version found a trick, and this is how it was fixed.** With instant muscles the learner
  settled on buzzing one hip back and forth every control step (15 Hz, the fastest possible). The
  footfall chart showed it as `#.#.#.#.`; a spectrum of the commands confirmed it. The fix was physical:
  real muscles lag, so activation now follows the command with a 60 ms time constant, plus a small cost
  on jerky commands. Run `play.mjs --gait` after any change to the body or reward and look at the feet.
- **A short training run does not prove learning.** 14 generations looked flat in testing, so no unit
  test claims it. The test suite checks the optimizer on a problem with a known answer, and the real
  learns-to-walk check is the opt-in slow test.
- **One body, one flat plane.** No slopes, steps, pushes or noise in the senses, so a walker trained here
  will not cope with them without being trained for them.
- **The solver trades exactness for speed.** Position-based dynamics with a few passes lets bones stretch
  a little under violent loads; the audit reports how much.

## Settings

`new WalkEnv(options)`; all optional. Defaults are in `DEFAULTS` in `env.mjs`.

| Option | Default | Meaning |
|---|---|---|
| `seconds` | 20 | episode length |
| `goalRadius` | 0.45 | metres: close enough counts as arrived |
| `goalMin`, `goalMax` | 2.5, 4.5 | metres from the body when a goal is placed |
| `goalAngle` | π | new goals appear within ± this angle of straight ahead |
| `goalBonus`, `fallPenalty` | 3, 2 | reward on arrival, penalty on falling |
| `effortCost`, `jerkCost` | 0.02, 0.03 | cost of strong and of jerky commands |
| `strength` | 250 | muscle force limit, newtons |
| `maxStretch` | 0.25 | a bone stretched past this ends the episode as a broken world |
