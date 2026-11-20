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

Arithmetic tasks (the hardest kind: the answers are short numbers, which the project's text embedding barely tells apart), team score after 3 rounds, 60 epochs:

| Tasks | Agents | single | hive | separate | silent |
|---|---|---|---|---|---|
| 6 | 3 | 0.83 | 0.83 | 0.83 | 0.83 |
| 14 | 3 | 0.57 | 0.57 | 0.57 | 0.86 |
| 20 | 8 | 0.65 | 0.65 | 0.70 | 0.95 |
| 40 | 4 | 0.43 | 0.53 | 0.43 | 0.72 |

Time for the largest run (40 tasks): 3 s (single), 15 s (separate), 12 s (silent), 23 s (hive).

**Read these with care.**

- **Silent scores highest mostly because each agent holds few answers.** That is a capacity effect, not evidence that working without talking beats working alone.
- **Hive did not beat a single agent** except at 40 tasks (0.53 against 0.43). Every hive agent ends up holding most of the tasks, so each net faces the same wall. In hive mode the agents also know 5 or 6 of 6, not all: a task nobody could do is never posted.
- **More rounds barely help.** A net is fitted in closed form, so a second round mostly repeats the first.
- **Most of what looked like a capacity limit was a measurement problem and the data.** An earlier version of this page said one net holds "about 5 of 6" tasks. Two things were wrong with that: (1) the recall check compared answer vectors by object identity, so two tasks with the same answer (say "15" and "15") counted as a miss; (2) the answers were short numbers, whose embeddings are nearly identical. With distinct, word-like answers the same kind of net got 12 of 12, 18 of 20 and about 31 of 40.
- **How a net learns changed.** The output neuron's weights are now fitted in closed form (ridge least squares, per dimension, a few passes), trying four regularisation strengths and keeping the best, plus the delta rule for up to 12 responses. Before, only the delta rule ran, and it got 5 of 6, 8 of 12, 12 of 20 and 11 of 40 on distinct answers, however many dimensions or hidden neurons it had. Task-training agents also get one extra hidden neuron per task.
- A net's "converged" now needs every response within tolerance **and** every input landing on its own response. At a loose tolerance an output merely near the average of the answers used to count as converged.

## Limits

There are **no caps** on the number of tasks, agents, rounds or epochs, or on the length or content of the text. Task text is held on the neurons directly and never goes through the program parser, so quotes, line breaks and `--` are fine.

What is still true, because it is how the nets work and not a rule:

- **Cost grows fast.** The nets are all-to-all, so training cost grows roughly with the square of the tasks, times the agents, rounds and epochs.
- **One training step runs to the end before anything else in the process can run.** The loop yields between agents, not inside one. A very large run holds up whatever else the server is serving until each step finishes.
- **Answers that look alike cannot be told apart.** If the answers are short numbers, a net cannot reliably say which one it means. Distinct answers do much better (see above). This is a property of the project's text embedding, not of any mode.
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
