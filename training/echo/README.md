# training/echo/: repeat everything first, then learn the rules

Owner's request (2026-11-25): add a training step where the AI has to **repeat everything** it is shown, so it has a
better sense of what it is seeing; then it does music and art by music theory, seeing each note and what comes after
it, using a randomizer that goes through **every possible tune**; and the same for art, animals, human speech, text,
chips, coding, simulation, research, and NeuroLang.

Written from scratch with Node built-ins. No packages, no tokenizer (every sample is raw bytes). See `AGENTS.md`.

## What a stage looks like

For each domain and level, in this order (`echo.mjs`, `tasksFor`):

| # | Task | The network is shown | It must produce | Judged by |
|---|---|---|---|---|
| 1 | `echo` | the tune | the same bytes | **exact match. This is the gate.** |
| 2 | `echo-raw` | the raw form (audio, pixels), where there is one | the same bytes | exact match, also gating |
| 3 | `decode-raw` | the raw form | the tune ("audio to notes") | exact match |
| 4 | `next` | the start of a tune | the next symbol | the rules: any legal symbol passes |
| 5 | `legal` | the start of a tune | every symbol the rules allow next | exact set |
| 6 | `finish` | the first half | the second half | the whole thing obeys every rule |
| 7 | `label` | the tune | the exact truth, got by running it | exact match |

A stage is **passed** only when both echoes are exact (`echoPass`, default 1.0) and every other task reaches `pass`
(default 0.9) with `next` beating a rule-blind guesser. `runLadder` stops at the first stage that is not passed and says
whether the model cannot repeat yet ("blocked") or repeats but does not follow the rules ("not yet").

## The randomizer that goes through every tune

Each domain's rules are a small state machine (`rules.mjs`, `Walk`). Because they are finite, the engine can count the
legal tunes without trying them, build the i-th one from its number, and visit all of them once in a seeded random
order (a Feistel permutation, cycle-walked into range):

```bash
npm run train:echo -- tunes --domain music --level 1 --shuffle --seed 7 --limit 10   # 3,895 legal tunes, random order, no repeats
npm run train:echo -- tunes --domain art --level 2                                    # all 36, in order
npm run train:echo -- samples --domain chips --task label --level 1 --count 3         # JSON lines, bytes in hex
```

The dice (`walk.random`) pick uniformly among legal tunes; `walk.shuffled` guarantees coverage. Small levels can be
exhausted completely (music level 0 is 120 tunes); big ones (music level 4 is 141,714,080) are sampled lazily and
never held in memory.

## The ten domains (`domains.mjs`)

| # | Domain | The rules the randomizer stays inside | Raw form / label |
|---|---|---|---|
| 1 | music | scale degrees; start on the tonic triad; steps 1-2, leaps 3-4; a leap is followed by a step back the other way; at most 3 equal notes; range 0-10; end on tonic or dominant, never off a leap. Key and mode are applied afterwards (`toMidi`), so every key is the same tune | raw: 8-bit 4 kHz audio. label: MIDI notes |
| 2 | art | six-step hue wheel; neighbours must be the same (at most twice), analogous or complementary; start and end on the home colour | raw: mirrored strip, 3 bytes per pixel |
| 3 | animal | one or two different calls, an optional suffix ("here" or "gone"), stop, then silence: order carries meaning | |
| 4 | speech | no words: consonant-vowel syllables, 1-3 per word, pauses between, ends on a pause | |
| 5 | text | short sentences typed byte by byte from word slots | |
| 6 | chips | two-input gate netlists over inputs a, b; each gate reads two different earlier signals | label: truth table by simulation |
| 7 | coding | stack programs over the digits 1-4; stack depth never goes wrong; ends with one value | label: the result, by running it |
| 8 | simulation | 3x3 world: harvest the food, give it to the friend. Only good actions exist (no attack or steal) | label: final state |
| 9 | research | search before answering; quote only what was found; cite only a quote; or say "not in these sources" | |
| 10 | neurolang | the line forms in `wiki/Syntax.md` (`kind`, `neurons`, `@input`, `@response`, `train`) | |

## Honest limits

- **Rule sets, not the real thing.** These are small, real rule sets for the *shape* of each domain. Music is the
  melody rules only: rhythm, chords, voice leading, clash checks and form (all in `docs/TRAINING_CURRICULUM.md`
  Stage 1) are not modelled yet. Art is a one-row strip, not a 2D picture or video. Animal is one signal-system rung
  (order carries meaning), not the whole A-F ladder. Speech is syllable babble with pauses, not prosody (pitch,
  stress). Research and NeuroLang here carry only the order and line forms; their content generators are still to
  write. NeuroLang output was checked against the line forms in the wiki, not run through the real interpreter.
- **Nothing here trains the mesh yet.** This builds the data, the exams and the gate. The network under test is a
  function from bytes to bytes (in practice the Zip Loop); wiring it to `OneBrainEngine` is a separate step. The tests
  use a lookup table and a blind guesser, which prove the harness, not any intelligence.
- **Capacity.** `docs/TRAINING_CURRICULUM.md` already says today's mesh cannot hold even stage 1. The gate makes that
  visible: expect `blockedAt` to be an early stage until the mesh grows.
- **Exam seeds.** Train and exam on different seeds. Unseen rule combinations (held out by key, mode or template) are
  not split out yet.

## Files

| File | What it is |
|---|---|
| `rules.mjs` | `Walk` (count, enumerate, unrank, random, shuffled, legalNext) and the permutation |
| `music.mjs` | the theory rules, modes, MIDI mapping and the 8-bit synth |
| `domains.mjs` | the ten domains |
| `echo.mjs` | sample building, grading, `examStage`, `runLadder`, `stageStream`, `mixBatch` |
| `run.mjs` | command line: `plan`, `tunes`, `samples` |

Tests: `node --test test/training/echo.test.mjs` (also part of `npm run test:training`).
