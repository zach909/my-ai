# Training ideas: how the AI should learn to reason

These are ideas for how reasoning should be **trained**, not rules the code enforces.

Until now `ReasoningEngine.reason()` (`models && skills/core/reasoning-engine.ts`) forced every
message through the same fixed stages, in the same order, whether the message needed them or not.
That has been removed. `reason()` now recalls what memory holds for the problem and hands the
problem to the hive / neural runner. Whatever shape the thinking takes is meant to come from the
network.

The old code is still in git history if you want to read it:
`git show 878d95d9:"models && skills/core/reasoning-engine.ts"`.

## The principle

- A stage the code runs is a stage the network never has to understand. It can be removed without
  the network noticing, and it cannot be adapted to the problem in front of it.
- A habit the network learned shows up when it helps and stays out of the way when it does not.
- So each old stage below is written as **a behaviour to teach**, with an idea for the examples and
  the signal that would teach it. None of it is to be turned back into a fixed sequence.

## The stages that were removed

For each one: what it did, what it was for, and how it could be taught instead.

### 1. Understand the problem

- **Did:** pushed the raw text through unchanged and logged it.
- **For:** making sure the question is read before it is answered.
- **Teach it:** examples where the right reply restates or asks about an ambiguous request first,
  next to examples where a clear request is simply answered. The network has to learn which is
  which; give it both kinds in roughly the proportion real chats have.

### 2. Fix the objective

- **Did:** stripped a leading "how do I / what is / explain / build..." and kept the rest as "the
  objective".
- **For:** knowing what a good answer would have to deliver.
- **Teach it:** pairs of (request, one-line statement of what the person actually wants) as an
  auxiliary prediction target. Train the network to predict the one-liner, but never require it to
  be produced before an answer.

### 3. Gather available information

- **Did:** looked up the top 5 long-term-memory items for every message.
- **For:** answering from what is already known instead of guessing.
- **Teach it:** make recall something the network chooses to do. Reward answers that were grounded
  in a memory that really applied, and penalise confident answers that ignored a relevant memory.
  (Recall is still available as a tool; it is only the forced call on every message that went away.)

### 4. Notice what is missing

- **Did:** took the words of the problem that no memory covered and listed them as "missing".
- **For:** knowing the edge of its own knowledge.
- **Teach it:** calibration training. Include questions the network cannot know, and reward "I don't
  know X" or "I would need X" over a confident invention. Score by whether it was right about its
  own gap, not by whether it mentioned gaps.

### 5. Go and find what is missing

- **Did:** searched the knowledge graph for each missing word, one hop out.
- **For:** closing a gap before answering rather than reporting it.
- **Teach it:** examples where the right move after "I don't know X" is to look it up (graph, wiki,
  Net Search) and then answer using what came back. Reward the full loop, and reward stopping early
  when the lookup returns nothing.

### 6. Try a creative combination

- **Did:** when two or more words were still unknown, asked the discovery engine to blend the first
  two into a new "X-Y hybrid" concept, marked unverified.
- **For:** generating new ideas from concepts that had not been connected before.
- **Teach it:** this was a training-time discovery mechanism that kept leaking into chat. Keep it in
  training: generate combinations offline, check them, and only fold the ones that held up into the
  graph. Never run it live on a user message.

### 7. Remember past mistakes

- **Did:** pulled up to 5 prevention notes from the mistake tracker and subtracted 0.15 from every
  approach's score per note.
- **For:** not repeating the same failure.
- **Teach it:** turn each recorded mistake into a training pair: the situation, the wrong move, the
  better move. The network then carries the prevention in its weights. Keep recording mistakes
  (`solve()` still does); stop applying them as a flat penalty.

### 8. Generate several approaches, predict their consequences, pick one

- **Did:** always offered the same candidates (decompose, analogy, first-principles, plus a transfer
  option), scored them with fixed numbers, demoted any whose predicted consequence looked dangerous,
  scaled scores by a learned bias, and took the top one.
- **For:** not committing to the first idea; avoiding a risky approach.
- **Teach it:** the strategies are not a menu. Train on worked solutions that use different
  strategies on different problems and let the network learn which fits what. The signal is
  outcome: verified results reward the strategy that was used, failures discourage it. That is what
  the approach-bias bookkeeping in `NeuroclawSystem` was trying to approximate with a hand-set
  table. For danger, keep the safety gate (it is not a reasoning step, see below) and also train on
  examples where the safe route wins.

### 9. Break it into subproblems and delegate each

- **Did:** split the text on "and", "then", commas and semicolons, or, if there was nothing to
  split, made two copies of the same question ("analyze: ..." and "solve: ...").
- **For:** handling big tasks in parts.
- **Teach it:** splitting on punctuation is not decomposition. Train on examples where a large task
  is broken up in a way that fits the task, and on examples where a task that looks compound is
  answered whole. Delegation to the hive is still there for the network to use.

### 10. Detect that a piece failed, then revise it

- **Did:** looked for `[error:]`, `[unsolved:]` or `[base:]` markers in the output; for each, split
  the failed piece again on connectives and retried once.
- **For:** recovering from a wrong or empty step instead of reporting it.
- **Teach it:** self-correction examples: an attempt, a visible problem with it, a fixed attempt.
  Include cases where the first attempt was fine and should be left alone, so it does not learn to
  second-guess everything. Real failures the system hit (from the mistake tracker) are the best
  source.

### 11. Verify the result

- **Did:** called the answer verified when no piece carried an error marker, then derived a
  confidence number from fixed bonuses and penalties.
- **For:** not claiming certainty it had not earned.
- **Teach it:** that check only looked for marker strings, so it said very little about whether the
  answer was true. Verification should be trained against real checks: tests that run, facts that
  can be looked up, an independent reviewer (the critic already exists for this). Reward answers
  whose stated confidence matched how often that kind of answer turned out right.

### 12. Keep a trace of the steps

- **Did:** wrote each stage's name and detail into a list, kept the last 20 passes.
- **For:** being able to see what it had already tried.
- **Teach it:** now that no stage list exists there is nothing to record. If the network reasons in
  steps, those steps are part of its own output and can be logged like any other text. A single
  `answer` entry is still written per solve so `reasoningHistory()` keeps working.

## What was deliberately kept

- **The safety gate in `solve()`** (`AlignmentVeto` plus the danger prediction). It stops a dangerous
  request before anything runs. It is a guard, not a way of thinking, so it stays code.
- **Recording mistakes after a failed answer**, and the self-model, memory reinforcement and critic
  review that follow an answer. Those produce the data that training needs.
- **`decompose()`** as a tool the agent loop can offer to prompting skills. A skill may choose to
  call it; nothing calls it for you.

## How to turn these into training

- Write the behaviours as examples in the format the project already trains on (see
  `wiki/Task-Training.md` and `docs/CONVERSATION_TRAINING_LOG.md`), not as new code paths.
- Feed them in as raw bits through the Zip Loop like everything else. No tokenizer, no outside
  model.
- Prefer a signal from what actually happened (did it verify, did the person correct it, did the
  mistake come back) over a score somebody wrote down by hand.
- Measure before and after on the benchmarks in `benchmarks/` so a stage is only called learned when
  the numbers say so.

## Open questions for the owner

- Should the agent loop's `perceive -> think -> act -> observe -> iterate` cycle
  (`models && skills/core/agent-loop.ts`) get the same treatment? It is a fixed sequence too, but it
  drives tool use, so I left it alone.
- The approach-bias bookkeeping in `NeuroclawSystem` (`approachBiasMap`, `refreshApproachBias()`)
  no longer influences anything, because there are no approaches to choose between. Remove it, or
  repurpose it as a training signal?
