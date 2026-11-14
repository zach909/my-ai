# Training curriculum: from music to chips

A plan for what the mesh is trained on, in what order, and how we know each step worked.
**This is a plan, not built code.** Nothing described under "Generators" exists yet except the
drill generators noted below. `train.md` is about how to train *reasoning*; this file is about
what *material* the mesh learns from.

The order, as the owner asked for it:

1. Music, made by a rule-following program
2. Art video, made by a rule-following program, played together with the music
3. Animal communication, simplest to most complex
4. Human noise that is not speech
5. Human speech
6. Voice to text (writing down what was said)
7. Math
8. 360° video, each frame paired with a text twin where every pixel is a letter
9. Simulations that teach science and math
10. Coding
11. Computer and chip design

## Ground rules (they decide how everything below is built)

- **No third-party code, no outside models, no tokenizer.** See `CLAUDE.md` and `AGENTS.md`. Every
  generator below is written with Node built-ins only. Every sample enters the mesh as raw bits
  through the Zip Loop. No Whisper, no Vosk, no outside embeddings, no pretrained audio or image
  model, and nothing that "just decodes a file for us". If a step seems to need a library (WAV,
  PNG, MP4 writing, FFT), we write the small piece we need ourselves, or we use raw bytes and skip
  the container format entirely.
- **Generated, not downloaded.** Music, art, animal calls, vocal noise, speech, math, 360 scenes,
  simulations, and code problems are all made by programs. That is the whole point of the design:
  the program that makes a sample also knows the truth about it (the notes, the word, the answer),
  so every sample comes with a free, exact label. No human labelling, no model labelling.
- **Same contract as `scripts/drill-generators/`.** That folder already does this for arithmetic,
  logic, coding and classical computers: novel problems, answers computed by the runtime, so a
  held-out batch is really held out. New generators follow it:
  `generate(level, seed) -> { input: bytes, target: bytes, meta: ground truth }`.
- **Seeded and reproducible.** A sample is `(generator, version, level, seed)`. Store those four
  things, not the bytes. Regenerate on demand. The training set is never committed.
- **Held-out means unseen seeds *and* unseen rule combinations.** Different seeds of the same rules
  only test memory. Each stage's exam also uses combinations of rules the network never saw
  together.
- **A stage is only "learned" when the exam says so.** Same standard as `train.md`: measure before
  and after (`benchmarks/`), and never call a stage done because the loss went down.

## The honest problem first: capacity

Look at what the repo says about the mesh today:

- `wiki/Task-Training.md`: a single net holds about 5 of 6 small arithmetic tasks.
- `test/core/zip-speech.test.ts`: the Zip Loop speaker holds about 16 questions.

This curriculum asks for audio, video, speech, math, code and chip design. **At today's size the mesh
cannot hold even stage 1.** That is not a reason to drop the plan; it is the reason each stage has an
exit exam and a capacity gate. The first real result of running this will be "the mesh runs out at
stage N, here is the curve". Do not paper over it. Concretely:

- Start every modality at a tiny resolution (below) and only raise it when the stage is passed.
- Track *how much is retained from earlier stages* (see "Mixing"), not just the new stage's score.
- If a stage cannot be passed at the smallest resolution, the answer is a bigger or better mesh, not
  a weaker exam.

## Sample format (all stages)

Everything is bytes. No file containers.

| Modality | Raw form | Smallest resolution to start | Raise to |
|---|---|---|---|
| Audio | unsigned 8-bit mono samples, no header | 4 kHz, 1-2 s | 8 kHz, then 16-bit at 16 kHz |
| Image / video frame | 3 bytes per pixel (R, G, B), row by row | 16×16, 8 frames | 32×32, 64×64, then 128×128 |
| 360° frame | 3 bytes per pixel, equirectangular (see stage 8) | 32×16 | 64×32, 128×64 |
| Text | UTF-8 bytes | n/a | n/a |
| Symbolic labels | small fixed binary records | n/a | n/a |

Why start tiny: next-byte prediction on raw audio is brutally long. One second of 16-bit 44.1 kHz audio
is 88,200 bytes. One second of 8-bit 4 kHz audio is 4,000. Pitch, rhythm and pulse are all still there at
4 kHz (about C7 is the top note you can represent below the Nyquist limit, far above melody range).
Raise fidelity only when the stage is passed.

Every stage uses the same three task shapes, because the generator knows the truth both ways:

1. **Continue it.** Given the first part, predict the rest (the next bytes).
2. **Decode it.** Given the sample, predict its label (the notes, the word, the situation).
3. **Make it.** Given the label, produce the sample (the notes to audio, the word to speech).

## Mixing and forgetting

Training strictly in order forgets the early stages. So from stage 2 onward every batch is a mix:

- about 60-70% the current stage,
- the rest drawn from earlier stages, weighted toward the ones whose exam scores slipped most.

`benchmarks/continual_learning.mjs` already measures forgetting, and `benchmarks/ablation.mjs` already
removes one ingredient and re-measures. Use both. A stage's exam is re-run after every later stage; a
drop is a failure of the later stage, not a footnote.

## Stage 1: Music from rules

**Generator:** a small music engine that knows the rules and rolls dice inside them. Plain code, no
music library, no sound library.

The rules (all of these are classical music theory, written by us as data tables and checks):

- **Key and mode.** Pick a tonic, then a mode (major, natural minor, dorian, mixolydian, pentatonic).
  Notes are scale degrees first, pitches second, so every key is the same piece in a different place.
- **Melody as a weighted walk.** The randomizer picks the next scale degree with weights: steps (±1, ±2)
  common, leaps rare, a leap is followed by a step back the other way, no more than three repeats, stay
  inside about an octave and a half. Strong beats favour notes in the current chord. A phrase ends on a
  stable degree (tonic, or dominant for a half-close).
- **Harmony.** Chords come from a transition table (I goes to IV, V or vi; V goes to I or vi; and so on),
  four bars at a time, ending in a cadence. The bass takes the chord root. Voice leading rule: each voice
  moves as little as it can.
- **Rhythm.** A meter (4/4, 3/4, 6/8), a tempo, and a bank of rhythm cells with a syncopation chance.
- **Form.** A motif, repeated and varied (transposed, inverted, rhythm changed), assembled into
  phrases (4 bars) and sections (AABA, ABAB).
- **Clash check.** Reject or repair a candidate that puts a minor second or tritone between voices on a
  strong beat.
- **Timbre.** The synth is a few hand-written oscillators (sine, saw, square, noise) with an
  attack-decay-sustain-release envelope. Writing PCM bytes is a loop over samples.

The "randomizer" the owner described is the seeded generator choosing among rule-legal options. Rules
make it music; the dice make it different every time. The repo has a small seeded `rng(seed)` inside
`models && skills/core/task-training.ts`; reuse that pattern (do not import a package for it).

**Levels:** (1) one repeated note, (2) scale runs, (3) melody over a fixed rhythm, (4) melody plus chords,
(5) full form, (6) several voices with different timbres.

**Labels (free):** the score. Every audio clip comes with its exact note list, so "audio to notes" is a
decode task with a perfect answer key.

**Exit exam (held-out seeds and unseen keys/modes):**
- Next-note accuracy on held-out pieces is well above the chance baseline for that level.
- Given a melody's first two bars, continuations stay in key and end on a stable degree at least X% of the
  time (X set from the generator's own baseline: what a rule-blind random walk scores).
- Audio-to-notes exact-match on level 3 or higher.

## Stage 2: Procedural art video, with the music

**Generator:** rules for pictures, no image model. Every one of these is plain arithmetic:

- Symmetry (mirror, rotational, kaleidoscope), grids and tilings.
- Colour harmony: a palette picker with rules (complementary, analogous, triadic) in hue/saturation/value.
- Iterated systems: fractal escape-time maps, plant-like branching from rewrite rules, spirographs and
  Lissajous curves.
- Cellular automata (simple neighbour rules that grow patterns).
- Flow fields and particles driven by a small noise function that we write.
- Animation: slide a few parameters smoothly over time (rotate, zoom, hue-shift, phase).

**Played with the music.** The owner said the video comes with the music. So one seed drives both:
the music's tempo sets the animation's pulse, its key sets the palette's hue, and its loudness sets the
size or brightness of what moves. The network can then learn that sound and picture are one event.
This is also the first cross-modal test: given the audio, predict the next frames, and the reverse.

**Levels:** (1) a still pattern, (2) one parameter moving, (3) several parameters, (4) iterated or
growing structure, (5) pattern locked to a real music clip from stage 1.

**Labels (free):** the parameters (symmetry order, palette, frequency, speed). Exit exam: continue a video,
predict its parameters, and given the audio alone choose which of several candidate videos belongs to it
better than chance.

## Stage 3: Animal communication, simplest to most complex

**The problem with the plan as stated:** there is no good "dumb to smart" ranking of species, and
we have no real animal recordings that are ours to use. Dogs, cats and elephants are not a clean ladder
(and a cat is not obviously a "dumber" communicator than a dog). So the ladder is built on **how
complex the signal system is**, using the standard list of what makes language more than calls:
*context-linked meaning, order, combination, displacement (talking about what is not here), productivity,
and learned transmission.* Species names are labels for each rung, as flavour. The owner can reorder them.

**Generator:** a small toy world with a few agents. Things happen in it (a threat appears, food is found,
a mate or a stranger arrives, a pup is lost). Each "species" is a signal system with its own rules for
turning a situation into sounds, and the audio is synthesised with the same hand-written synth as stage 1.
The truth (the situation) is known, so the meaning of every call is exact.

| Rung | Flavour | What the signal system does | New idea the network must get |
|---|---|---|---|
| A | dog | a handful of call types; how loud, high and fast carries intensity | meaning depends on sound shape; a gradient, not just a category |
| B | cat | calls plus a second channel (a posture or pulse pattern); the pair changes the meaning | two cues combine |
| C | elephant | long, low calls; every call carries an identity tag for who it is addressed to; call and response | who is speaking, who is addressed |
| D | monkey or bird | calls combine in a fixed order, and the order or an added suffix changes the meaning | syntax: order carries meaning |
| E | whale or songbird | long sequences with nested repeats, a dialect that drifts and is copied by others | structure inside structure; a vocabulary that is learned, not fixed |
| F | (toy only) | signals about things that are not present: "the food was by the river yesterday" | displacement |

Species behaviour in the real world is richer than these one-line summaries and the literature is still
moving. They are inspirations, not claims. We should read up before putting a species name on a rung in
the repo's docs.

**Labels:** the situation, who spoke, who was addressed, and the situation each sequence refers to.
**Tasks:** decode (sound to situation), make (situation to sound), reply (what does the other animal
say back), and, from rung C up, "who is being called".

**Exit exam per rung:** decode accuracy above a no-signal baseline on unseen seeds, then the same on
signal systems with *re-rolled* rules (a new made-up species), which tests whether it learned "how
signal systems work" rather than one system.

**The unproven bet:** that going through animal-like signal systems makes human language easier. Nobody
knows. Test it, do not assume it: train one copy of the mesh with stage 3 and one without it, then
compare how fast and how well they get through stages 5 and 6. If there is no gap, say so and shorten
the curriculum. This is the first thing the ablation benchmark should be pointed at.

## Stage 4: Humans making noise, not speaking

**Generator:** a source-filter voice built by hand: a pulse train (the vocal folds) pushed through a few
resonant filters (the throat and mouth), plus a noise source for breath. Both pieces are short loops of
arithmetic; no speech library.

Sounds to make, each with a few controls (pitch contour, loudness, duration, brightness, breathiness):

- Cries, laughs, sighs, gasps, coughs, hums, whistles, screams, grunts.
- Vowel-like cooing, then **babbling**: repeated consonant-vowel syllables with no meaning ("ba ba da da").
- Emotion contours: rising and falling pitch for question, excitement, alarm, comfort.

**Levels:** (1) single noises, (2) held vowels, (3) babble, (4) emotion on a vowel.
**Labels:** the type of noise and the emotion. **Exit exam:** classify type and emotion on unseen
voices (different base pitch and throat size), and tell babble from non-babble.

This is the human-baby order on purpose (noise, then cooing, then babble, then words), and the same
synth is reused in stage 5, so the vocal ground is shared.

## Stage 5: Humans speaking

**Generator:** the stage 4 voice plus rules for speech: a table of phonemes (vowel resonances, consonant
noise and bursts), a pronunciation table for a small vocabulary, and timing rules (syllable length, stress,
pauses). Many "speakers" come from changing base pitch, speed and throat size.

**Grounded words.** Where it can, words are tied to the toy worlds from stage 3 (a threat, food, a
direction), so a word means something in a situation and not only as a sound.

**Levels:** (1) vowels, (2) syllables, (3) single words, (4) two-word phrases, (5) short sentences,
(6) sentences in several voices and speeds.

**Real voices.** Synthetic speech is a narrow slice of human speech. For real voices, the owner records
their own voice reading known prompts, locally, with the app's mic (see `PRIVACY.md`). Because the
prompt is known, the text label is known: **no speech-to-text tool is ever used to make a label.**
The OS speech buttons the app already has are for typing into the chat box, and are not a training
label source.

**Exit exam:** word identification on unseen speakers and speeds, and on a few real recordings once the
owner has made some. Report the synthetic score and the real-voice score separately, because the gap
between them is the honest measure.

## Stage 6: Voice to text

The owner's wording was "train how to text using the voice to text". Read here as: **the network
itself learns to write the text of what it hears**, as raw bits in and raw bits out, with no outside
speech-to-text.

- **Pairs:** the stage 5 audio and the text it was made from. Because the generator wrote the text, the
  pair is exact.
- **Tasks:** (1) audio to text, (2) text to audio (so the same pair teaches speaking), (3) continue
  a spoken sentence, (4) fix a garbled transcript.
- **Text-only material** that is already in the repo and cited (`training_data/open_corpus/` with
  `CITATIONS.md`) feeds language learning on the text side. The existing char-level run in
  `scripts/train-open-corpus.mjs` is the baseline for text alone.
- **Levels:** letters, words, sentences, then whole paragraphs spoken in several voices and noise
  levels (add hiss, hum, a second voice, room echo from a simple delay).
- **Exit exam:** character error rate on unseen sentences and unseen voices, and a transfer test: a
  sentence the text side has seen but the audio side has never heard.

## Stage 7: Math

This stage mostly exists already. `scripts/drill-generators/arithmetic.mjs` and `logic.mjs` produce novel
problems whose answers are computed, and `wiki/Task-Training.md` already scores them with exact-match.
Extend, do not rebuild.

- **Ladder:** counting, add and subtract, multiply and divide, fractions and decimals, order of
  operations, algebra (solve for x, systems), geometry (area, angle, distance), probability and counting,
  sequences and series, functions and graphs, derivatives and integrals, then simple proofs where the
  checker is a program.
- **Three forms of the same problem:** written text, spoken audio (stage 6 voice reading it), and a
  picture of it (a graph or figure drawn by the stage 2 renderer). The answer is always computed by code.
- **Exit exam:** exact-match answers on unseen numbers *and* unseen problem shapes, plus "show your
  steps" where a program checks each step.

## Stage 8: 360° video with a text twin

Two videos of the same 360° scene:

- **Video A (normal):** the scene as RGB pixels.
- **Video B (text twin):** the same scene as text. Every pixel becomes one character, chosen so the
  character itself looks like the pixel, and each character carries its own colour.

**Where the scenes come from.** A small software renderer we write (ray casting a few shapes: spheres,
planes, boxes, lights) that outputs the full sphere around a camera point. Motion comes from moving the
camera or the objects. Real 360° footage is welcome only if the owner shoots their own, for the same
reason as real voices.

**How the text twin is made** (all rules, no model):

- **Which character:** one fixed, ordered ramp of characters from lightest to heaviest ink
  (for example blank, dot, colon, dash, equals, plus, star, hash, percent, at). Brightness of the pixel
  picks the character. Edges can pick direction characters (`/ \ | -`) from the local gradient, so lines
  look like lines. The ramp is an ordinary list we write; the mapping is a lookup. No font and no
  rendering library are needed.
- **Colour:** each character carries the pixel's own RGB, stored as a parallel colour plane (3 bytes per
  cell) rather than embedded escape codes, so every byte is a clean value. A terminal view can still
  draw it with truecolor escape codes for people.
- **One pixel, one character,** as the owner specified.

**Drawing the image back from the text.** The decoder is trivial for the program: look up the character,
use the stored colour. The task for the *network* is the harder one: given the text twin, regenerate the
pixels, and given the pixels, produce the text twin. Because the generator knows both, we get an exact
round trip and an exact error number (average pixel difference after the round trip).

**Things specific to 360°:**

- **Stretching.** The usual flat 360° layout (equirectangular) stretches the top and bottom rows
  hugely. Weight errors by how much sphere each row actually covers (cosine of latitude), or use six
  cube faces instead of one stretched strip. Start with equirectangular for simplicity, move to cube
  faces if the poles hurt.
- **The seam.** The left and right edges of the strip are neighbours in the real world. A free
  self-supervised test: cut the strip at a random column and ask the network to put it back, or to
  predict one edge from the other.
- **Rotation.** Spinning the camera in place is just a sideways shift of the strip. Teach it, then
  test: "this frame is that frame turned 90 degrees, which way did it turn?"

**Size.** A 64×32 frame is 2,048 cells: 6 KB of pixels, 8 KB of text twin with colour. A 30-frame clip
is a quarter of a megabyte. Fine for a generator, a real test of the mesh. Start at 32×16.

**Levels:** (1) one still shape on a flat background, (2) several shapes, (3) lighting and shadow,
(4) camera rotating, (5) things moving, (6) scenes drawn from the simulations in stage 9.
**Exit exam:** round-trip pixel error on unseen scenes, seam and rotation tests, and "caption" questions
answered in text ("how many spheres are there? what colour is the one on the left?") with computed answers.

## Stage 9: Simulation that teaches science and math

A world we write and can run forward in time, with known laws. It is shown through the stage 8 renderer
(normal video, text twin, both) and described through stage 6 (text and voice).

**Worlds, in order:**

1. Falling and bouncing (gravity, restitution, friction).
2. Projectiles and ramps (angle, speed, range).
3. Springs, pendulums, waves, resonance.
4. Orbits and collisions (momentum, energy conserved or lost).
5. Heat spreading, fluids as simple grids.
6. Chemistry-like reactions (a few species, rates, equilibrium) and population models.
7. Electric circuits (ties straight to stage 11).

**Tasks, in order of how much understanding they need:**

- predict the next frames (the network has to hold the physics),
- infer a hidden constant from the video (what is `g` in this world? what is the spring stiffness?),
- answer a question in text with a computed number ("how long until it lands?"),
- predict what happens if one thing is changed ("double the mass, what changes?"),
- find the law: given many runs, produce the formula that fits.

**Exam:** unseen constants and unseen combinations of effects, and *worlds with a rule changed* (gravity
that weakens with height), which tests whether it learned physics or one world. The existing
`scripts/exam-generators/` (astrophysics, chemistry, optics, quantum-computing, digital-logic) are the
place for science question sets, and the drill generators for the maths; reuse their shape.

(`models && skills/simulation.d.ts` is about intent analysis, not physics. This is a new generator.)

## Stage 10: Coding

- **Ladder:** expressions and conditions, functions, loops, strings and arrays, recursion, data
  structures, classic algorithms, small programs, reading and fixing a bug, writing tests, then using
  this project's own modules.
- **Problems are generated** (`scripts/drill-generators/coding.mjs` is the start) and **graded by running
  the code** in a sandboxed Node process against hidden tests. No model judges anything.
- **Sources of code.** Programs a generator writes, code the owner writes, and the AI's own output that
  passed its tests are all fine under the standing rule. **Code scraped from other people's projects is
  not**, and training on it is a grey area the rule does not clearly settle. Default is no. Ask the owner
  before ever using it.
- **Exam:** pass rate on held-out problems and on *bugs injected by a program into working code*.

## Stage 11: Building a computer, then a chip

The ladder follows how a computer is really built, and every rung is verified by simulation, which we
write. The network builds each thing as a description (a gate list, called a netlist), and a simulator
we write runs it and checks it.

| Rung | The network must produce | Verified by |
|---|---|---|
| 1 | AND, OR, NOT, NAND, XOR from NAND alone | every row of the truth table |
| 2 | half and full adder, multiplexer, decoder | exhaustive truth tables |
| 3 | latch, flip-flop, register, counter | a clocked simulation against a reference |
| 4 | N-bit adder and an ALU (add, sub, and, or, compare) | exhaustive for small N, random for large N |
| 5 | a small memory and a program counter | read and write sequences |
| 6 | a tiny CPU: fetch, decode, execute | runs test programs and matches a reference interpreter |
| 7 | an assembler and a few programs for it | output equals the reference |
| 8 | the CPU described as a netlist, then placed on a grid with wires routed | rule checker: no shorts, within a size, within a timing budget |

The reuse here is real: `scripts/exam-generators/digital-logic.mjs` and
`scripts/drill-generators/classical-computers.mjs` already generate problems of this kind.

**Where it ends.** The honest end of this ladder is a *verified design in our own format*, plus a toy
layout checked by our own rules. Making real silicon needs foundry design kits and commercial tools,
which are third-party and off the table. Say that to the owner plainly rather than promising a chip.

**Exam:** every circuit the network makes must pass its simulator; score the share that pass first try,
and the share it can repair after a failing test is shown to it.

## Measuring the whole thing

- **One exam file per stage,** each with: held-out seeds, held-out rule combinations, a chance baseline,
  a rule-blind baseline, and the pass line. All computed by code.
- **Run order each time:** train on the mix, run every exam so far, record the curve, then decide.
- **The three questions that matter:** Did the new stage get learned? Did the old ones survive? Did
  an earlier stage make a later one easier (the ablation)?
- **Results** go in `benchmarks/results/`, the same place the other benchmarks write, with the generator
  version and seeds so a number can be reproduced.

## Proposed layout

```
scripts/curriculum-generators/      (new; follows scripts/drill-generators/)
  index.mjs                         one registry: generate(stage, level, seed)
  rng.mjs                           small seeded random generator, written here
  music/    rules.mjs  synth.mjs
  art/      patterns.mjs  motion.mjs
  animals/  world.mjs  systems.mjs
  voice/    source-filter.mjs  noises.mjs  speech.mjs
  video360/ render.mjs  text-twin.mjs
  sim/      worlds.mjs
  chip/     gates.mjs  cpu.mjs  check.mjs
test/curriculum/                    exams and generator tests
```

All of it is Node built-ins and `node:test` or the existing vitest, nothing new installed, and
`node scripts/check-no-third-party.mjs` has to keep passing.

## Suggested build order

1. `rng.mjs`, the sample contract, and the exam harness (small, and everything depends on them).
2. Music rules and synth, plus its exam, and **run the mesh on it** to get the first capacity curve.
   If the mesh cannot do stage 1 at the smallest size, fix capacity before building more generators.
3. Voice source-filter (it is shared by stages 3, 4, 5 and 6), then animals, then noises, then speech.
4. The text-twin and 360° renderer, since it is the most unusual part and decides the byte budget.
5. Everything else in the stated order.

## Things I read into the request (please confirm)

The request was dictated, so I made these calls:

- "Training MD" means a curriculum document, so it lives at `docs/TRAINING_CURRICULUM.md` and
  `train.md` points to it, rather than extending `train.md`'s reasoning-only content.
- "3D pre 60 videos" is 360° videos.
- "Tax" video is a text video, and "every pixel is a letter" is one character per pixel with its own colour.
- "Voice to text" is the network learning transcription itself (no outside speech-to-text).
- "Computer ship and chip" is computer and chip design, ending at a verified design (see stage 11).
- "Run it into the A" is feed it to the AI.
- The art video plays together with the music.
- The animal rungs are ordered by signal-system complexity, not by how clever the species is.

## Risks, bluntly

- **Capacity** is the biggest. See above. Everything else is secondary until the mesh passes stage 1.
- **Raw bytes are long.** Audio and video as raw bits make very long sequences. The tiny-resolution
  start is not optional.
- **Synthetic is not real.** A network that is great on generated speech and animal calls may fall apart
  on real ones. Keep synthetic and real scores separate and always report both.
- **The animal and noise stages are the least proven part.** They might help, they might be a detour.
  The ablation decides, and I would be ready to cut them if it says no.
- **A tidy curriculum can hide a weak network.** Every stage has exams a lazy answer cannot pass, and they
  run on rules the network has not seen.
