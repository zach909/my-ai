# Task Training

AIs get a task and are trained until they can do it. A task is an input and what the answer should be (an answer can have several parts). Code: `models && skills/core/task-training.ts`. Route: `POST /api/task-training` (see [[Net-Maker]]). Tests: `test/core/task-training.test.ts`.

The agents are nets made by the net maker ([[Net-Maker]]), each in an engine of its own. A round is: every agent learns what it is responsible for, then everyone is scored on the tasks.

## The four modes

| Mode | Who gets what | Can they talk? | The team's answer |
|---|---|---|---|
| `single` | One AI gets every task. | n/a | That AI's answer. |
| `hive` | Several AIs inside a HiveMind (`hive-mind.ts`). Each starts with its own share. | **Yes.** An agent posts the tasks it can verifiably do to the shared blackboard; the others learn them from there. Trust moves with who was right (zero-sum, the total stays 100). | Trust-weighted vote. |
| `separate` | Several AIs, each given **every** task, each trained alone from its own random start. | **No**, and nothing is shared. | Majority vote taken from outside by the harness. The agents never see each other. |
| `silent` | Several AIs that **cannot talk** and work together. | **No channel exists**: no blackboard, no messages, no shared net. | Joint: a task counts only if every responsible agent got its part right. |

Silent agents cooperate through an agreement made before the run, not through anything said during it: a fixed rule says who is responsible for which task and, for an answer with several parts, which part (task *i*, part *p* belongs to agent `(i + p) mod agents`). A task with 3 parts needs at least 3 agents, and the run is refused otherwise.

## What the scores mean

- A score is the share of tasks answered **exactly right**. The grader is exact string equality with the stored answer. No model judges anything, and the arithmetic tasks are computed by the code.
- An agent can only give an answer it has been taught, so a task it was never given is not answerable by it. The scores say whether a mode ends with agents (or a team) that can do the tasks. **They do not measure doing a task nobody taught them.**
- `messages` counts reads and writes between agents. It is 0 for single, separate and silent.

## What was measured

Six arithmetic tasks, three agents, three rounds of 120 epochs, 16-dimension nets:

| Mode | Team score after rounds 0 / 1 / 2 / 3 | Messages |
|---|---|---|
| single | 0.00 / 0.83 / 0.83 / 0.83 | 0 |
| hive | 0.00 / 0.83 / 0.83 / 0.83 | 23 to 29 |
| separate | 0.00 / 0.83 / 0.83 / 0.83 | 0 |
| silent | 0.00 / 0.83 / 1.00 / 1.00 (plain), 0.00 / 1.00 / 1.00 / 1.00 (two-part tasks) | 0 |

**Read these with care.**

- One agent has a limited capacity. A single net holds about 5 of 6 of these tasks, and the further rounds do not raise that. Silent reaches 100% mostly because each agent holds only 2 to 4 of the answers. That is a capacity effect, not evidence that working without talking beats working alone.
- In hive mode the agents end up knowing 5 or 6 tasks, not all of them: a task nobody could do is never posted, so nobody learns it from the others.
- A first version used the net maker's default tolerance (0.2) and got 1 of 6 tasks right: training stopped after a few milliseconds, once every output was merely near the average of the answers. Task training uses 0.01, which gave 5 of 6. Do not read "converged" as success at a loose tolerance. Recall is the measure.

## Limits

There are **no caps** on the number of tasks, agents, rounds or epochs, or on the length or content of the text. Task text is held on the neurons directly and never goes through the program parser, so quotes, line breaks and `--` are fine.

What is still true, because it is how the nets work and not a rule:

- **Cost grows fast.** The nets are all-to-all, so training cost grows roughly with the square of the tasks, times the agents, rounds and epochs.
- **One training step runs to the end before anything else in the process can run.** The loop yields between agents, not inside one. A very large run holds up whatever else the server is serving until each step finishes.
- **A big task set does not get done well by one net.** Measured with the caps lifted (all four modes, 60 epochs per round):

| Run | single | hive | separate | silent |
|---|---|---|---|---|
| 20 tasks, 8 agents, 2 rounds | 0.45 | 0.35 | 0.50 | 0.90 |
| 14 tasks, 3 agents, 10 rounds | 0.43 | 0.43 | 0.43 | 0.71 |

  Past about six tasks a single net drops to roughly half right, and ten rounds does not fix it. Hive was **worse** than a single agent at 20 tasks: every agent ends up holding most of the tasks, so each net hits the same capacity wall, and a trust-weighted vote does not repair that. Silent scores highest again for the same reason as before (each agent holds few answers), not because working silently is smarter.
- The task-training agents are made with the neuron cap lifted (`maxNeurons: Infinity`). The net maker and the program parser keep their default cap of 1024 for everyone else, since those also parse source from other callers; pass `maxNeurons` to change it.
- Silent mode's "who is responsible" rule is fixed, not learned. Agents do not learn to coordinate; they are given a way to.
- A task needs an id nobody else has, a non-empty input no other task shares, and at least one non-empty answer part. Without those there is no single answer to grade.

## Route

```
POST /api/task-training
{ "mode": "hive", "agents": 3, "rounds": 3, "epochs": 120,
  "generate": { "count": 6, "composite": false, "seed": 1 } }
```

or pass `"tasks": [{"id": "t1", "input": "7 + 5", "parts": ["12"]}]` instead of `generate`. The request body has no size cap. The reply has the team score after each round, each agent's score, the messages, the tasks still missed, and notes.
