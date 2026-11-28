# training/tasks/: train on tasks, not prediction; audio and video, with live captions

Owner's request (2026-11-28): train on the audio and video material, then train **on tasks, not prediction**, and put
**live captions in every video**. Own code, Node built-ins only. No packages, no tokenizer, no speech-to-text.

```bash
node training/tasks/run.mjs                      # trains and scores everything, about 7 s, nothing is downloaded
node --test test/training/tasks.test.mjs         # 6 tests
```

## What "tasks, not prediction" means here

Every example is the task's input and the task's answer, and the loss is on that answer alone (`learn.mjs`, softmax
regression by gradient descent). Nothing predicts the next byte, sample or frame. Scores are exact-match on the task,
on combinations never trained on, next to two baselines (uniform chance, always the most common training answer).

| Task | Input | Answer | Exam (held out) |
|---|---|---|---|
| `note` | one 250 ms audio window | its MIDI note | keys and modes never trained on, and noisier clips |
| `tune` | a whole audio clip | every note, in order (exact) | same |
| `hue`, `direction`, `speed` | the video frames | each attribute | hue and direction pairs never seen together |
| `caption` | frames 0..t | the caption for frame t (exact string) | same |

## Live captions

- A caption track is **part of every video sample** (`packVideo`: the frame bytes, then one length-prefixed UTF-8
  caption per frame; `unpackVideo` reads it back).
- Captions are **generated from the truth the generator knows**, not transcribed. Speech-to-text is banned by the
  ground rules, so nothing here recognises speech and nothing outside the repo makes a label.
- **Live means causal.** The caption for frame *t* is computed from frames 0..*t* only. Frame 0 can say the colour;
  from frame 1 there is motion to read. `causalityCheck` rewrites every later frame with noise and confirms the
  caption at *t* does not change. The result is reported on every exam (60 of 60 videos).

## Measured results (`node training/tasks/run.mjs`)

| Test | Result |
|---|---|
| Audio, seen keys and modes (sanity) | 98.5% of notes, 93.3% of whole tunes exact |
| Audio, **unseen** keys and modes | **98.3%** of notes (chance 2.0%), **91.7%** of whole tunes exact |
| Audio, unseen, much noisier | 91.3% of notes, 58.3% of whole tunes exact |
| Video, **unseen** hue and direction pairs | hue, direction and speed all 100%; live caption exact 100% per frame and per video; causal 60 of 60 |
| Video, unseen pairs, much noisier | the same |

## Honest limits

- **The front ends are hand-written, not learned.** Audio uses a bank of one filter per semitone; video measures the
  lit square's colour and displacement. What is learned is the mapping from those features to the answer.
- **The video tasks are easy by construction.** A coloured square, four directions, two speeds. 100% on them proves
  the captions are exact and causal and that the held-out split works. It does not show the model handles real video.
- **Some held-out notes were never in training** (6 to 7 notes per exam). A classifier cannot output a class it never saw,
  so those are guaranteed misses and account for most of the 1.7% note error. A model that measures pitch rather than
  naming it would not have this limit.
- **Synthetic, one instrument.** Sine notes from the echo synth at 4 kHz. Real recordings, chords, rhythm and other
  timbres are not covered. Real video is not covered. The caption wording is a fixed template: the model chooses the
  words that fill it, it does not compose new sentences.
- **This is not the mesh.** The learner here is a separate, small model. Wiring task training into `OneBrainEngine`
  is not done.

## Files

| File | What it is |
|---|---|
| `learn.mjs` | softmax regression, standardiser, scoring with the two baselines |
| `audio.mjs` | filter-bank features, clip generator, `note` and `tune` tasks, held-out keys and modes |
| `video.mjs` | frame generator, caption track, causal features, `hue`/`direction`/`speed`/`caption`, causality check |
| `run.mjs` | trains and prints the exam |
