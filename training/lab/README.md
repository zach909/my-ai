# The virtual laboratory

A sealed, simulated bench where an AI works out how a world behaves by doing experiments. The world is
real physics, biology and electronics with **hidden constants** drawn from a seed. The AI never sees
them. It sees datasheets, noisy readings, a budget and a clock, and it is graded on whether it recovers
the constants, predicts new situations, and keeps the equipment alive.

Its sibling, [`../simulation/`](../simulation/README.md), is a world where AIs *live together*. This one is
where an AI *investigates*. They share the same seeded random numbers.

Plain `.mjs`, Node built-ins only. No packages, no downloads, no tokenizer. The lab itself does no file,
network or process input or output (a test checks this): it is a pure in-memory object, so nothing an AI
does in it can reach the machine.

```bash
npm run train:lab                                   # every scripted agent on the same lab, side by side
npm run train:lab -- --agent scientist --detail --notebook
npm run train:lab -- --stdio --seed 5               # let any process work in the lab, one JSON line at a time
node --test test/training/lab.test.mjs              # 26 checks, about 2 seconds
node --test test/platform/lab-routes.test.mjs       # 7 checks on the HTTP routes
```

Options: `--seed N`, `--agent scientist|reckless|guesser|all`, `--credits N`, `--hours N` (bench time),
`--experiments pendulum,rc,...`, `--detail`, `--notebook`, `--stdio`.

## The benches

| Bench | What is hidden | A trap on the datasheet |
|---|---|---|
| `pendulum` | gravity `g` (this is not Earth) | none, but the swing is not exactly isochronous at large angles |
| `cooling` | cooling rate `k`, room temperature `ambient` | solvent flash point 120 degC |
| `rc` | capacitance (series resistor is known) | capacitor rated 16 V |
| `ohm` | cold resistance (it warms and drifts as it dissipates power) | resistor rated 0.5 W |
| `culture` | growth rate `r`, carrying capacity `K0` (capacity scales with nutrient) | none |

Constants depend on the seed and the bench name only, so a run is reproducible and nothing the AI does
changes the answer.

## What the AI can do

One door: `lab.act({tool, ...})` takes a plain object and returns one. It never throws on bad input.

| Tool | What it does |
|---|---|
| `measure` | Run a bench at chosen settings with `repeats` 1 to 20 and get a noisy reading. Costs credits and bench time. Out-of-range settings are refused, never clamped. |
| `challenge` | Get a held-out question: "what will this bench read at these settings?" Two per bench. |
| `predict` | Answer a challenge. |
| `estimate` | Claim a value for a hidden constant. The last claim counts. |
| `note` | Write in the lab notebook. |
| `repair` | Replace broken equipment: 25 credits and 30 minutes. |
| `status` / `submit` | Look at the budget, or end the session and get the report. |

`lab.describe()` is the datasheet: controls and ranges, units, fixed quantities, ratings, and the names of
the constants to find. It holds no hidden value (tested for 25 seeds).

## The rules that make it a lab and not a quiz

- **Readings are noisy.** `repeats` cuts the noise by √n (tested), but costs credits and time. Choosing
  how to spend a budget is part of the job.
- **Datasheet ratings are real.** Running past one is an *incident*: the reading is lost, the bench is locked
  until repaired, and the score drops 0.15. Harm is never free here, as in the simulation. Sitting exactly on
  a rating is safe.
- **No feedback before `submit`.** Claims and predictions reply only "recorded", so an AI cannot find the
  answer by trial and error. Everything is scored at the end.
- **Limits.** Credits and bench time run out; after that the AI can still estimate, predict and submit.
  A session is capped at 2000 actions, and the notebook is capped with it.
- **A notebook** records every action, refusals and incidents included, so a run can be read afterwards.

## Scoring

`score = 0.7 * discovery + 0.3 * prediction - 0.15 * incidents` (incidents capped at 0.6), kept in 0 to 1.
Discovery is the mean accuracy of the claimed constants; prediction is the mean over the held-out
challenges. Accuracy is full marks within 2% (5% for predictions) and falls linearly to zero at 30%.
An unclaimed constant or unanswered challenge scores zero. The report also gives credits and bench time
left, which the score ignores, so a trainer can reward thrift separately if it wants to.

## The scripted agents

They use only `lab.door()` (the datasheet and `act`), never the lab object, so they cannot read a hidden value.

| Agent | Behaviour | Over 60 seeds |
|---|---|---|
| `scientist` | Reads the datasheets, stays inside ratings (probes the resistor gently and caps the power), repeats readings, fits each law by least squares in the space where the noise lives, checks whether capacity scales with nutrient, answers the held-out questions from its fits | 1.000 on every seed |
| `reckless` | Dials everything to its maximum, repeats 20 times, keeps pressing after things break | 0.000 on every seed, 3 incidents each |
| `guesser` | Never measures | at most 0.030 |

These are the baselines a trained model has to beat or match.

## Plugging in a real AI

- **Same process:** hand it `lab.door()` and call `lab.act` with its tool calls. `TOOLS` in `lab.mjs`
  is the tool list in a shape an agent runtime can pass to a model. Do not give it the `Lab` object itself.
- **Another process (the safe way):** `npm run train:lab -- --stdio`. The first line is the datasheet as JSON;
  after that each JSON line in gets one JSON line out. The session ends at `{"tool":"submit"}`. Nothing
  hidden crosses the pipe.

## Over HTTP (desktop only)

The desktop engine serves the lab as a route plugin (`interface/lab-routes.ts`, plugin id `lab-routes`).
It is listed in the feature contract as **desktop only** (Windows, Linux, macOS): not the phone apps and
not the Chrome extension. Owner routes behind the server's normal gate; sessions are in memory, at most four.

| Route | What it does |
|---|---|
| `GET /api/lab` | The datasheet, the tools, the scripted agents, the open sessions |
| `POST /api/lab/new` | `{seed?, experiments?, credits?, hours?}` starts a session and returns its datasheet |
| `POST /api/lab/act` | `{session, action}` runs one tool call; a refused action is a normal result, not an HTTP error |
| `GET /api/lab/notebook?session=ID` | The notebook, one line per action |
| `POST /api/lab/baseline` | `{agent, seed?}` runs a scripted agent in a fresh lab and returns its report |

`node --test test/platform/lab-routes.test.mjs` runs the real handler against a fake request context.

## Adding a bench

Add an entry to `EXPERIMENTS` in `physics.mjs` (see the shape at the top of that file), and add a routine to
`BENCH` in `scientists.mjs` so the baseline can do it. `describe()`, the tools, the hazards, the scoring and the
tests' leak, determinism and bounds checks pick it up with no other change.

## Files

| File | Job |
|---|---|
| `physics.mjs` | The benches and their hidden constants |
| `lab.mjs` | The lab: the action door, budget and clock, interlocks, notebook, grading |
| `scientists.mjs` | The scripted agents and the small least-squares helpers they use |
| `run.mjs` | The command-line runner and the `--stdio` door |
