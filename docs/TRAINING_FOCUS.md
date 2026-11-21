# Training focus: research, code, skills, extensions and plugins, and fixing its own mistakes

Direction from the owner, 2026-11-14. This narrows `docs/TRAINING_CURRICULUM.md` and builds on `train.md`.
It is a plan plus the first piece of data that exists for it. Claims about the repo cite a file; claims
about results cite the command that produced them.

## What the owner asked for

Be really good at:

1. **Research.**
2. **Writing code**, all code, AI code included.
3. **Writing skills for itself.**
4. **The extension builder and making plugins.**

And, across all four: **reasoning, trying again, making mistakes and fixing them.** Not general knowledge:
"I don't want it to be good at stuff."

## What that changes

| Existing plan | Now |
|---|---|
| `docs/TRAINING_CURRICULUM.md` stages 1-9 (music, art video, animal calls, human noise, speech, voice-to-text, math, 360 video, simulation) and 11 (chips) | **Not the priority.** Kept on file, not deleted; nothing in this focus depends on them. Maths stays only as far as code needs it. |
| Curriculum stage 10 (coding), `train.md` sections 3, 4, 5, 7, 10, 11 (recall, know the gap, look it up, remember mistakes, self-correct, verify) | **The core.** Everything below is these stages made concrete. |
| `training_data/open_corpus/` (Gutenberg philosophy and science, Wikipedia) | General knowledge, so it is **not a training goal**. It stays as the cited source material for research tasks (below), where the skill taught is "find it and cite it", not "know it". `training_data/open_corpus/RESULTS.md` measured it only as next-character prediction. |

## The one idea that ties it together

Every example is **try, run, read what really happened, fix**, with the check coming from running something,
never from a score somebody wrote down (`train.md`, "How to turn these into training"). Where the first try was
fine the right move is to leave it alone, so it does not learn to second-guess everything (`train.md` §10).

## What exists, what is only designed

| Focus area | Status | Where |
|---|---|---|
| Retry and repair on code | **Built.** 7 task families, 4 trace modes (first try fine / one defect / two defects, the second exposed by the first fix / a plausible wrong fix that fails differently). Every failure message is the real output of running the attempt; every expected value comes from running the correct version; the culprit defect is found by running. | `scripts/drill-generators/repair.mjs`, `scripts/make-repair-data.mjs`, `scripts/repair-exam.mjs`, `test/platform/repair-generator.test.mjs` |
| Writing code | Drill generators with answers computed by running them (`scripts/drill-generators/coding.mjs`), an execution-grounded coding trainer (`extension-builder/train-coding-skills.mjs`), and the run-and-revise loop (`models && skills/core/code-iteration.ts`). The repair traces add the missing piece: the revise step as training data. **Next:** write-from-spec tasks with hidden checks, many more families, and languages beyond JS. | files named |
| Research | **Designed, not built.** See below. | `docs/NET_SEARCH_SPEC.md`, `docs/SHARED_WIKI_SYSTEM.md` |
| Writing skills for itself | **Designed, not built.** See below. | `docs/SKILL_ACQUISITION_LOOP.md`, `models && skills/core/neuro-lang.ts` |
| Extension builder and plugins | **Designed, not built.** See below. | `docs/EXTENSION_BUILDER_SPEC.md`, `extension-builder/builder.js`, `plugin_manager/types.ts` |

### Research (to build)

A task is a question plus passages from the cited corpus (`training_data/open_corpus/manifest.json`, or the
knowledge extension built from it by `extension-builder/build-corpus-extension.mjs`). The model must answer
with a quote and its citation. The check is mechanical: the quote must appear **verbatim** in the cited source
file, and the citation must match that file's manifest entry. Include questions the passages cannot answer; the
right reply is "not in these sources" or a further lookup, never an invention (`train.md` §4-5). Score by
whether it was right about its own gap. The retry loop applies: a quote that is not in the source is a failure
the trace shows, then fixes.

### Writing skills for itself (to build)

A task is a described behaviour; the answer is a skill the existing NeuroLang interpreter accepts and whose
contract is satisfied. `extension-builder/train-coding-skills.mjs` already trains and checks NeuroLang
contracts by execution, so the check exists; the generator of varied tasks and the failed-then-fixed traces do not.

### Extension builder and plugins (to build)

A task is a capability to add; the answer is the builder call sequence or the `PluginDefinition` /
`SkillDefinition` (`plugin_manager/types.ts`). The checks are the builder's own: it validates, trains until
the constraint loss converges, and the plugin registers (`docs/EXTENSION_BUILDER_SPEC.md`). A failed build
or registration is the failure text in the trace.

## Measured baseline (2026-11-14)

Commands: `node scripts/make-repair-data.mjs --count 2500 --seed 1 --out train.jsonl`, the same with
`--count 300 --seed 2 --out held.jsonl`, then `node scripts/repair-exam.mjs --train train.jsonl --held held.jsonl`.
Training is the repo's character-level `NeuroclawTrainer` (2,009,034 characters, 70 s). For each of the 137
held-out one-defect traces the model is given the task, checks, failing attempt, the real failure and the word
`FIX`, writes the next attempt, and that code is run against the checks.

**Result: 0 of 137 fixed, 0 exact matches, and 0 of 137 even produced a well-formed next attempt.** The same
for every family, including families it trained on. With two whole families (`clamp`, `average`) left out of
training (`--leave-out clamp,average`, 1,800 traces): 0 of 50. Typical output: `The failing check shows it: the fallback
return total }`. It learns the shape of the text and none of the logic.

What this means, plainly:

- The current character-level trainer cannot learn to repair code from these examples. This is the "capacity"
  warning in `docs/TRAINING_CURRICULUM.md` showing up in the first stage tested. It is a finding, not a reason to
  lower the exam.
- The data is still the right data: it is true, executable and checkable. It is what a mesh that can do this
  would be trained on and scored against. It is not a reason to claim the model "learned" anything.
- Do not run a longer training and report a lower loss as progress. The only pass condition is the exam above:
  the model's own fix, run, passing.

## Exams (the only way a stage counts as learned)

1. **Repair exam**: given the failure, write the fix; run it. Report fixed / well-formed / exact separately for
   one-defect, two-defect and decoy traces, and report the "first try was fine, leave it alone" cases as a
   separate rate so over-correction is visible.
2. **Held-out families, not just held-out seeds.** Fresh seeds of the same rules only test memory. Leave whole
   task families out of training (`scripts/repair-exam.mjs --leave-out <families>`) and test on them.
3. Research: quote-exists-verbatim rate, citation-matches-manifest rate, and honesty on unanswerable questions.
4. Skills, extensions, plugins: the builder's own convergence and registration checks, on unseen requests.

## Open items for the owner

- **`ALIGNMENT.md` is not in this repository.** `scripts/fetch-open-corpus.mjs` and
  `training_data/open_corpus/RESULTS.md` cite it (sections 7, 8.1, 8.2), but it is in none of the 3,174
  commits on any branch fetched on 2026-11-14 (`git log --all -- ALIGNMENT.md` is empty). Its requirements could
  not be read, so none are reflected here. The safety gate stays code, not a trained behaviour (`train.md`, "What
  was deliberately kept"). Please add the file or tell me where it is.
- `train.md`'s open questions are still open: whether the agent loop (`models && skills/core/agent-loop.ts`)
  gets the same treatment, and what to do with the dead approach-bias bookkeeping in `NeuroclawSystem`.
- Whether to register the repair generator in `scripts/drill-generators/index.mjs` (`DRILL_CATEGORIES`) so the
  drill agent trains on it. I did not, because it changes what the drill agent does for the `coding` topic.
