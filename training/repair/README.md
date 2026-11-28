# training/repair/: a repair agent that thinks by trying, not by remembering

`docs/TRAINING_FOCUS.md` says the pass condition for "fix your own mistakes" is the model's own fix, run, passing, and
that held-out task families are the test, because fresh seeds of the same rules only test memory.

## Why this exists

The character-level trainer (`models && skills/trainer.ts`) fixed **0 of 137** held-out defects. Raising its context
order made it look much better and showed what that really was:

| Trainer setting | Families it trained on | Families it never saw |
|---|---|---|
| order 8 (the exam's default) | 0 / 137 | 0 / 50 |
| order 24 | 12 / 137 fixed | 0 / 50 |
| order 64 | 73 / 137 fixed (every one an exact copy of training text) | 0 / 50 |

That is memorising. A text predictor given more context copies what it saw. It does not repair anything new, so its
"73" is not reported as training anywhere in this repo.

## What the agent does (`agent.mjs`)

1. **Run the attempt against the checks.** If they all pass, leave the code alone.
2. Otherwise propose small **generic edits** found in the code in front of it (flip a comparison, nudge a constant,
   swap min/max, change `&&`/`||`, add or drop a method call or term, change an index, reorder two statements,
   test a variable for emptiness, ...). **Run every candidate.** A fix is accepted only when running it passes every
   check. If none does within the budget, the original is returned untouched, never a guess.
3. **Best-first search**, so a fix that needs two edits (the first showing no gain) is still reachable.
4. **Learned part (`train()`):** replay training traces, find which edit kinds really produced a verified fix, and rank
   kinds by how often they verified. The ranking only orders the tries. The table is keyed by edit kind, so it
   holds no task text, no function names, no answers (a test asserts this).

## Measured results (run these yourself)

Data: `scripts/make-repair-data.mjs`, see `CITATIONS.md`. The agent trained on the first 400 traces of seed 1.

| Test | Result |
|---|---|
| 7 generator families, 300 held-out traces (**development set; the edit kinds were written looking at them**) | 239/239 defective fixed, 61/61 clean left alone |
| **Sealed set 1**, 8 new families, run before adding any edit for them | **9 / 16** fixed, 8/8 clean left alone |
| **Sealed set 2**, 8 fresh families, written then run once, never tuned on | **10 / 15** fixed, 8/8 clean left alone |

```bash
node scripts/make-repair-data.mjs --count 400 --seed 1 --out train.jsonl
node scripts/make-repair-data.mjs --count 300 --seed 2 --out held.jsonl
node training/repair/run.mjs --train train.jsonl --held held.jsonl
node training/repair/sealed.mjs --train train.jsonl --families ./sealed-families-2.mjs
node --test test/training/repair-agent.test.mjs
```

## Honest limits

- **Not the mesh.** This is a separate component. It does not make `OneBrainEngine` or the character-level trainer
  better at anything, and the repo's repair exam (`scripts/repair-exam.mjs`) still scores that trainer at 0 of 137.
- **The edit vocabulary is hand-written.** What generalises is the search and the checking, not a learned
  understanding of code. What is learned is only the ordering of edit kinds. A defect kind with no matching edit is
  never fixed. The misses on the sealed sets show this: a swapped arithmetic operator (`i * i` written as `i + i`),
  a wrong separator character (`'-'` cannot be produced), a method call needed in the middle of a chain, and missing
  parentheses.
- **Each sealed set stops being a test once it is used to add edits.** Set 1 became development material the moment
  its misses drove new edit kinds, so its "never tuned on" figure is only the first-run number above. The 15/16 it
  now scores is not evidence. Set 2 is the clean measurement. Write a new set to measure again.
- **Only single-function JavaScript with runnable checks.** Nothing here reads prose, writes new code from a spec, or
  handles other languages.
- **Search budget.** 30 expansions, depth 4. Bigger budgets fix more and cost more runs.
- The checks run in `node:vm`, which is not a security boundary (same as the generator's note). Do not point this at
  untrusted code.
