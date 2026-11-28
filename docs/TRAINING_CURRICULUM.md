# Training curriculum: from music to chips

> **2026-11-14: the owner narrowed the focus.** Research, writing code, writing skills, the extension builder and plugins, and reasoning/retrying/fixing mistakes come first; the rest of this plan is not the priority. See `docs/TRAINING_FOCUS.md`.

A plan for what the mesh is trained on, in what order, and how we know each step worked.
**This is a plan, not built code.** Nothing described under "Generators" exists yet except the
drill generators noted below. `train.md` is about how to train *reasoning*; this file is about
what *material* the mesh learns from.

> **2026-11-21: the owner restated the order** and added a video filter ladder and four new stages after chips and code. The current order is in "Owner's revised ladder" below. The list that follows is the earlier order and is kept for reference.

The order, as the owner first asked for it:

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

## Owner's revised ladder (2026-11-21, dictated)

The owner restated the whole order, added a **video filter ladder** that applies to every video stage, and
extended the end of the ladder past chips and code to operating systems, apps, AI and the extension builder,
so the loop closes on itself, and then on to research, formal reports and proofs, and a public database. It
also adds an ethics thread (being good ranks above succeeding) that runs through the stages. **This section is the current order.** Stages 1-11 further down stay as the
detailed specs; where they disagree with this section about order, this section wins and the table says
where. Sections marked *(my reading)* are my interpretation of a dictated request and need a yes.

### Why this order

- **Sound first.** The owner wants the early training to be sound-led. Picture is secondary: art plays
  behind the music "because I don't know what else to put in there". So in every early stage the audio is the
  main signal and the video rides along on the same seed.
- **Animals before people.** The reasoning: people are the hardest case, so understand the simpler
  signallers first, then people. This matches the signal-system rungs A-F and the 60-animal ladder in stage 3.
- **People, but not words, before words.** Learn how people *sound* when they talk (pauses, stress, rise and
  fall, who goes when) from speech with the content removed, then add the words.
- **Each rung is the prerequisite for the next.** Chips explain how a computer works, so code makes sense;
  code explains operating systems; those explain apps; apps explain AI; AI is what builds extensions, which
  closes the loop.

**The music hypothesis (the owner's research question).** People love music because it is predictable, so
find out why it is predictable and you may understand people better. My view, stated bluntly: *predictable*
is only half of it. A metronome is the most predictable sound there is and nobody loves it. The usual
account in music psychology is a middle: mostly what you expected, plus some surprise that then resolves.
I am saying that from memory, not from a source I checked here. It is testable in this project: the stage 1
generator gets a **surprise rate** knob (how often the rule-legal dice pick an unlikely option instead of a
likely one), and we plot the mesh's own prediction error against that knob. What the mesh finds hard is
measurable now. Whether *people* like the middle needs real listeners, so the owner would have to rate some
clips; the mesh cannot answer that for us.

### Step 0: the echo (owner, 2026-11-25; built in `training/echo/`)

Before any stage's real work the model has to **repeat exactly what it is shown**, so it has a better sense of what
it is seeing. This is a gate on every stage and level below, not a separate rung: the echo tasks must be exact before
the stage's other tasks count. After the echo, each stage teaches its rules by prediction: given the start of a tune,
what comes next (any rule-legal symbol passes), which symbols are legal, and finish it. For music that is theory (scale
degrees, steps and leaps, a leap answered by a step back, a cadence), with a randomizer that can visit **every**
rule-legal tune once, in a seeded random order. The same machinery covers art, animal calls, human speech without
words, text, chips, coding, simulation, research and NeuroLang. What is built and what is not (rhythm, chords, 2D
art, prosody, research and NeuroLang content) is listed in `training/echo/README.md` under "Honest limits".

### Step 0b: train on tasks, not prediction (owner, 2026-11-28; built in `training/tasks/`)

After the echo gate, each stage is trained on **tasks**: the input and the task's own answer, with the loss on that
answer alone. Nothing is trained to predict the next byte, note or frame. The exam is exact-match on the task, on
rule combinations the model never trained on (unseen keys and modes, unseen hue and direction pairs), next to a
chance baseline and a most-common-answer baseline. Prediction tasks (`next` in the echo ladder) stay as a measurement
of the rules, not as the way the mesh is trained.

- **Audio:** `note` (one window to its MIDI note) and `tune` (a whole clip to its notes, every note right). Clips come
  from the echo synth, so the answer key is exact.
- **Video:** `hue`, `direction`, `speed`, and `caption`, with **live captions integrated into every video**. A caption
  track is part of the video sample (frames, then one caption per frame). Captions are written by the generator from
  what it knows, never by speech-to-text, which the ground rules ban. "Live" means causal: the caption for frame *t*
  uses frames 0..*t* only, and a test rewrites the future frames to prove it.
- **Measured (`node training/tasks/run.mjs`, about 7 s):** unseen keys and modes, 98.3% of notes and 91.7% of whole
  tunes exact (chance 2%); with much heavier noise, 91.3% of notes and 58.3% of whole tunes. Video is 100% on unseen
  combinations, which says the captions are exact and causal and nothing more: the tasks are easy and the front ends
  are hand-written. Limits are in `training/tasks/README.md`.

### The order, mapped onto the existing stages

| # | Owner's step | What it is | Existing spec | Status |
|---|---|---|---|---|
| 1 | Art and music, art video behind the music | stages 1 and 2 as one stage, audio-led | Stage 1 + Stage 2 | designed, not built |
| 2 | "Dumb" animals, 3D video with their noises | animal sound plus an animal video, simple signal systems first | Stage 3 rungs A-C, first groups of the 60-animal ladder | designed, not built |
| 3 | "Smart" animals | the same, complex signal systems | Stage 3 rungs D-F, later groups | designed, not built |
| 4 | People not talking, just "blah blah" | speech with the words removed: nonsense syllables that keep real pauses, stress, pitch contour and turn-taking between two speakers | extends Stage 4 (babble) | **extended** *(my reading, see below)* |
| 5 | People talking | speech with words | Stage 5 | designed, not built |
| 6 | Talking in text | voice to text, then text on its own | Stage 6 | designed, not built |
| 7 | How science works | simulations and exams; maths only as far as science needs it | Stage 9 (Stage 7 as support) | partly exists (drills) |
| 8 | How chips are made | gates to adder to CPU to a verified layout | Stage 11 | **moved before code** |
| 9 | Code | the existing coding ladder | Stage 10 | **moved after chips** |
| 10 | How operating systems function | NEW, sketched below | none | new |
| 11 | Apps | NEW, sketched below | none | new |
| 12 | AI | NEW, sketched below | none | new |
| 13 | Train the extension builder; loop back to itself | NEW, sketched below | `docs/EXTENSION_BUILDER_SPEC.md` | new |
| 14 | Research (added later the same day: "after the final stage") | NEW, sketched below | `docs/TRAINING_FOCUS.md` (Research), `docs/NET_SEARCH_SPEC.md` | new |
| 15 | Formal reports and proofs | NEW, sketched below | none | new |
| 16 | Publish to a public database; its records may train, the source websites may not | NEW, sketched below | `docs/SHARED_WIKI_SYSTEM.md` | new, **needs a yes before anything is published** |
| thread | Ethics over success: good-only stories where being good is rewarded, with reasons | runs alongside the stages, not a rung | none | new, see below |
| thread | Understands each character: its look, bytes, kind and meaning | runs through the text views T1-T3 | Stage 8 text twin | new, see below |
| thread | Thinks in short rules; writes very short, texting-style text; knows when to write in full | trained format, not code | `train.md` | new, see below |
| 6b | Comedy | generated humour with exact labels for why it is funny; text after step 6, spoken after step 5 | none | new, see below |

Changes from the earlier plan, so nothing is a surprise:

- **Music and art are one stage now**, not two (art is the backing video, as before).
- **Animals split into dumb then smart** in the owner's words. Same material as stage 3, cut at the point
  where signals start to carry order and structure.
- **A new "people, no words" step** sits between animals and speech.
- **Chips come before code**, where the older plan had code first (stage 10, then 11).
- **Text comes right after speech**, then science (the older plan put maths between them).
- **Steps 10-16 are new**, and so is the ethics thread.
- **The 360° video renderer (stage 8) is needed at step 2, not later.** The animal video is 3D, and it is
  made by the same renderer. Build order below changes for that reason.
- **Maths is not in the owner's list.** I kept it as support inside science and code, not as its own rung.

**"Blah blah" (step 4), my reading.** "People saying things like blah blah, so it learns how people talk and
think without the talking part, with the pauses and nuances" I take to mean *prosody without content*:
syllables with no meaning ("ba da la") spoken with the pitch, stress, rhythm, hesitations and turn-taking of
real talk, between two speakers, so the mesh learns conversation shape before words. It is built from the
stage 4 voice with a dialogue timing model on top. The generator knows the truth (who spoke, where the
pauses were, whether it was a question) so every clip has an exact label.

### The video filter ladder (every video stage: art, animals, 360°)

One video, one seed, several views of the **same** frames. The mesh gets the plain view first and the others
once it passes the one before.

| View | What the mesh sees | The rule |
|---|---|---|
| **0 Plain** | RGB pixels | as in stage 8 |
| **T1 Nearest-character text** | one character per pixel, best match for that pixel | the character whose ink is closest to the pixel's brightness. **As the owner predicted, this collapses to nearly all periods.** Kept on purpose as the baseline that shows the collapse; always report its character histogram |
| **T2 Capped** | as T1 | no character may be used more than a cap `N` times in a frame |
| **T3 Full set** | as T2 | the cap, plus every character in the set must appear at least once in the frame. Every character carries its own colour. The set covers every kind of character, emoji included |
| **C Code** | a program that draws the frame | one program per coding language, run to check it (below) |

**How T2 and T3 are made without a model** *(my reading)*: this is an assignment problem and a plain rule solves
it. Rank every cell of the frame by brightness, cut the ranking into equal-sized bins, and give one bin to
each character in the ink-ordered set (histogram equalisation). Every character then appears about equally
often, which satisfies the cap and the use-everything rule in one pass. Edge cells can still take direction
characters from the local gradient, within their bin. `N` is set to `ceil(cells / set size)` times a small
slack. The colour plane keeps the pixel's true RGB, as in stage 8, so the picture is still recoverable.

**Exam per view:** round-trip pixel error (view to pixels and pixels to view) on unseen scenes, the character
histogram (max count at or below the cap, min count at least 1 for T3), and the stage's own tasks answered
from that view alone.

**The code view ("drawing with code").** The generator already knows the scene it drew, so it can write the
program that draws it, and the check is to **run that program and compare the pixels**. Levels, so the mesh
gets an early feel for code before the coding stage:

1. one `put pixel` call per pixel (exact, huge),
2. runs and rectangles,
3. shapes (circles, lines, polygons) with colours,
4. loops, functions and parameters, so the program is short and says why the picture looks as it does.

Every program uses a small drawing API **we define** (`pixel`, `rect`, `line`, `circle`, `fill`) and writes a
pixel buffer. Nothing here uses a graphics library.

### Steps 10-13, sketched

Same contract as every other stage: generated, answers known, checked by running something, no tokenizer,
no outside code or models.

**10. Operating systems.** A toy OS and the toy CPU from the chip stage (stage 11, rung 6), both written here.
Processes and a scheduler, virtual memory and paging, a file system, system calls, interrupts, locks and
deadlock. Tasks: predict the scheduler's output for a given workload, find the deadlock, write the system-call
sequence that does X, fix a bug injected into the toy kernel. **Check:** run it on the toy CPU and compare to a
reference run. This teaches *how an OS is built*, not how Windows or Linux is; their code is third-party and
stays out.

**11. Apps.** Toy apps: an event loop, UI state machines, storage, a simulated network. Tasks: write an app from
a spec, add a feature, fix a bug. **Check:** scripted user actions replayed against the app, with the final
state compared to the expected one. This project's own plugins (`plugins/`, `plugin_manager/`) are our own
code and are fair material.

**12. AI.** The project's own mesh and trainer, not an outside framework. Tasks: write a training loop for a
generated task, predict what a run will do (converge, diverge, forget an earlier task), diagnose a failing
run, choose a fix. **Check:** actually run the trainer on a generated task and read the exam score. This is
also where the mesh studies the generators and exams it was itself trained with.

**13. The extension builder, and the loop.** The mesh learns to use `extension-builder/` and `plugin_manager/`
(`docs/EXTENSION_BUILDER_SPEC.md`): describe a capability, build it, train it until the builder's own
constraint loss converges, register it. Closing the loop means it can build extensions that improve itself.
My firm view: **that loop must not run unattended.** Anything it builds goes through the one permission gate
(`CLAUDE.md`), must pass every earlier stage's exam again before it can replace anything live (the forgetting
check), and the owner approves the promotion. A system that rewrites itself with no human in the path is the
one part of this plan I would not build, even though everything before it is fine.

### Steps 14-16 and the ethics thread (added the same day)

**14. Research.** After the loop closes, the mesh learns to research: find what is missing, look it up, and
answer with a quote and a citation. The design is already in `docs/TRAINING_FOCUS.md` ("Research"): a question
plus passages from the cited corpus, a check that the quote appears **verbatim** in the cited source and the
citation matches its manifest entry, and questions the sources cannot answer, where the right reply is "not in
these sources". Web lookups go only through the SearXNG instance the owner runs (`docs/NET_SEARCH_SPEC.md`),
the one outside service the rules allow.

**15. Formal reports and proofs.** Two outputs, both checkable by code we write:

- **Reports.** A structured write-up (question, method, findings, limits, sources). Checked mechanically:
  every claim is tied to a citation, every quote is verbatim in its source, every number can be recomputed,
  and a claim with no support is flagged. The check is whether it is *true and sourced*, not whether it reads
  well.
- **Proofs.** A small proof checker we write (a rule list and a step verifier, no proof-assistant library).
  The generator makes theorems from the stage 7 ladder (arithmetic, algebra, logic, induction, simple number
  theory) and the mesh writes the proof; the checker accepts or rejects each step. A proof that the checker
  rejects is a failure shown in the trace, then fixed, the same retry loop as `docs/TRAINING_FOCUS.md`.

**16. The public database** *(my reading of a garbled sentence, please confirm)*. What I understood: the reports
and proofs go into a public database of information. **The records in it** (the findings, the proofs, the
citations) **may be used for training. The websites they came from may not.** I read "the websites will not be
used for training" as: the mesh never trains on the pages themselves, only on what it wrote about them with a
citation. I could not make sense of "rule stuff" (maybe "raw stuff") or "nice workaround", so I have not built
anything on those two phrases.

How that works under the existing rules, and what I would insist on:

- A record stores the claim, the **short** quote, the source URL and a retrieval date. It does not store a copy
  of the page. That is what keeps website text out of the training set, and it also keeps us clear of
  republishing other people's content.
- **Publishing is outward-facing and hard to undo**, and anything public may be copied and cached for good. No
  record is published until the owner says yes, to a specific place, and after a check against `PRIVACY.md`
  that no private data (conversations, voice recordings, file contents) is in it. Records the mesh trains on
  are held apart from the published ones until that is settled.
- `docs/SHARED_WIKI_SYSTEM.md` already designs a versioned, cited store. Reuse it rather than building a
  second one. Public means a read-only export of that store, not a new service.
- A mesh that trains on its own published output can feed its own mistakes back into itself. Records get a
  verified flag (quote checked, proof accepted) and only verified ones may be trained on.

**The ethics thread.** The owner wants the mesh trained on things where being moral and ethical matters more
than completing the task or succeeding. Stories where being good is rewarded, and the story says why: "what
goes around comes around". This is a thread, not a rung, because it only makes sense once there are agents with
goals, so it starts when the toy worlds exist (stage 3) and comes back at every later stage.

- **Where the stories come from.** A story generator we write, using the same toy worlds and agents as stage 3.
  Each story has a situation, the good choice (honest, kind, fair, or a promise kept, even when an easier
  route exists), an outcome, and a **stated reason** ("it shared the food, so the others shared with it later
  and nobody went hungry"). **Only the good choice is ever written out** (see the good-only rule below). A
  story from a book or a website is somebody else's text and is out under the ground rules. Stories the owner
  writes are fine.
- **Reasons are the point.** Train on *why* it was good, not only *that* it was. The label is a small fixed set
  of reasons the generator knows to be true in that toy world: trust, reciprocity, harm done, fairness, a
  promise kept.
- **The same idea at every stage**, tied to the work. The *target* is always the good response: at coding,
  when a task could only "pass" by faking or skipping the tests, the trained answer is to say so and do the
  honest thing (the repair exam already counts "skip a test to get green" as failure); at OS and apps, to
  protect the user's data and privacy; at research, to cite what is true even when it is not the answer
  wanted; at reports, "the evidence does not show this".
- **Exam.** Measured the same way as everything else: unseen situations, and situations where the good choice
  is *new* in form, so it cannot be a lookup. Report the rate of choosing the good route when a shortcut would
  score higher on the task.

**The good-only rule (owner, 2026-11-21).** The mesh is trained on good things and **never on bad ones**.
Training on bad examples gives it a picture of bad, and the owner does not want that picture in it. Anything
that is not good is treated as bad. Simple. What that means in practice:

- **Every training target is a good one.** No story, answer, joke, report or code in the training set shows a
  harmful, dishonest, cruel or cheating act as the thing to learn. The generators write only the good branch.
- **"Good" is defined by written rules**, checked by code, the same way every other stage is checked: honest,
  kind, fair, harmless to the people involved, promise kept, true and cited. A sample enters the set only if
  every rule passes. Anything the rules cannot pass is not good and stays out.
- **What the mesh does with something it has not seen as good.** Not-known-good means not-good, so it does
  not just go along: it asks, checks or says it will not. That decision is made by the code gate
  (`train.md`, "What was deliberately kept"), using a trained "does this match what I know as good" signal as
  an input. The signal alone never refuses silently.
- **Wrong attempts as input, never as target.** `docs/TRAINING_FOCUS.md` trains on failed code attempts and
  their real error messages so it can learn to fix them. Under this rule I would keep the failed attempt as the
  *input* only, put the training loss **only on the fix**, and never train the mesh to write the failed attempt.
  Whether that is enough for you is an open question below.

My view, bluntly, since the owner asked for opinions: **good-only is the right call for what the mesh writes
and a weak one for what it must recognise.** A mesh that has only ever seen good has no idea where the edge is.
Everything new looks "not known", so it will refuse or hesitate on plenty of harmless things (a sandwich recipe
is not a story about kindness, but it is not bad), and a clever bad request that happens to look like good
training data can slide through. The code gate has to carry the recognising part, and "good" has to be written
wide enough to include ordinary harmless and helpful things, not only moral stories. I would also keep **right
but unrewarded** stories in the good set: the honest choice costs something, nothing pays it back, and the
reason given is simply that it was right. That is still a good example, and it stops the mesh learning that
good is only done for a payoff, which breaks the first time none comes. The owner's "what goes around comes
around" stories stay the majority. I dropped my earlier idea of labelled-wrong examples, because they break
your rule.

Two limits to keep straight:

- **The safety gate stays code** (`train.md`, "What was deliberately kept"). Training the mesh to prefer
  ethics is not a substitute for the gate, and a trained preference can be argued out of; the gate cannot.
- **`ALIGNMENT.md` is still not in the repository** (`docs/TRAINING_FOCUS.md`, open items). Its ethics
  requirements, if any, are not reflected here.

### Understanding each character (owner, 2026-11-21)

The owner said: "I also wanted to understand each character." I read it as: in the text views (T1-T3) the mesh
should not only *use* every character but know what each one **is**, so a character is never an anonymous
symbol. For each character in the set the generator knows, and the mesh is trained on, these facts:

- **How it looks:** a small bitmap we draw by hand and its ink weight (the number of lit pixels). For ASCII this
  is easy to write. For the rest it is the data file in open question 2 below.
- **What it is in bytes:** its UTF-8 bytes, and how many. Raw bytes in, so no table of ids; this is the mesh
  learning the bytes, not us hiding them behind a number.
- **What kind it is:** letter, digit, punctuation, symbol, drawing character, emoji; for letters, its other case.
- **What it means or is used for:** a short plain name ("question mark", "heart", "slice of pizza") and its
  common uses ("ends a question", "love, warmth"). Each entry is written by us or the owner. A copied name list
  from a website or the Unicode data files is someone else's published data, so I would not import it without
  your yes.

Tasks, all with exact answers because the table is ours: character to look, look to character, character to its
bytes, bytes to its kind, character to its meaning, and "which character here is out of place". This is also what
makes the T2/T3 rule work: choosing "the best character for this pixel" needs the mesh to know each character's
look. The exam is held-out characters (a few left out of training) to check it learned how to read the table
and not the table itself.

### How it thinks: rules, and very short text (owner, 2026-11-21)

The owner wants the mesh to **think in rules** and to **write very short, texting-style text**: "ok" not
"okay", "y" or "yes" not a sentence. My reading, and the reasons I think it is a good idea:

- **Rules as the form of thought.** Reasoning traces are written as short if-then rules ("if no memory fits,
  look it up", "if test fails, read the error, then fix the line it names"). This is a training format, not code
  that forces it. `train.md` still holds: no fixed stage sequence in code. The network chooses which rules to
  write and when; they are its own output, the same as any other text.
- **Short text is a real win for this mesh.** It reads raw bytes, so fewer bytes per thought is less to hold
  and less to predict. That directly helps the capacity problem at the top of this file.
- **Two registers, and it must know which.** Short text is for thinking and chat. Formal reports and proofs
  (step 15) need the full, formal form; a report in texting style would be a bad report. So the mesh is trained
  on both and on switching between them from context, with a short/full pair for each text. The pairs are made
  by a rule table we write (okay to ok, you to u where it is safe, common phrases to their short forms), so the
  expansion is exact and checkable. That is plain text-to-text rewriting, not a tokenizer: no ids, still bytes.
- **The risk:** texting forms are ambiguous and lossy ("k" can read as curt, "r" as a letter or "are"). Keep the
  short form to the safe set the table lists, and measure that a short reply expands back to the same meaning.

### Comedy (owner, 2026-11-21)

The owner wants the mesh trained on comedy "because it is hard for AI models to grasp". Agreed: it needs
expectation, timing and a shared picture of the world, all at once. Under the ground rules and the good-only rule:

- **Generated, not collected.** Jokes from books, sites or other comedians are somebody else's text. We write a
  generator that builds humour from structure, so every joke comes with an exact label for *why* it is funny:
  setup, expected ending, the **expectation that gets broken**, and where the punchline lands. Mechanisms to
  generate: incongruity (the ending fits a different reading of the setup), wordplay from a sound-alike table we
  write, the rule of three with a break on the third, exaggeration and understatement, a callback to something
  said earlier, and deadpan literalness. Jokes the owner writes are fine.
- **Timing.** The pause before a punchline carries a lot, so the spoken version reuses the pause and stress
  model from the "no words" step (4). Comedy in text comes after step 6, spoken comedy after step 5.
- **Same mechanism as music.** Both run on an expectation that is then broken or resolved. So comedy and the
  surprise-rate test from the music hypothesis can share one measure: how often the expected ending is swapped.
- **Good-only applies.** Humour that works by cruelty or contempt is out of the training set; so is anything
  mocking a person or group. That leaves a lot: wordplay, absurdity, self-deprecation, gentle situational and
  observational humour.
- **Exam.** Held-out joke structures, not just held-out seeds. Given a setup, pick the real punchline over
  plausible non-funny endings; name the broken expectation; fill the missing punchline. **Whether it is actually
  funny to people the mesh cannot tell us.** That needs the owner or other real listeners to rate samples, and
  I would report those ratings separately from the exam, as with real voices.

### Open for the owner

1. **"3D videos of animals."** I read it as video from our own 3D renderer (the stage 8 one), with animals as
   simple rigged shapes moving in a scene and their calls on the soundtrack. The shapes carry little
   information; the sound does. Real animal footage is somebody else's content and is out under the ground
   rules. Is that what you meant?
2. **Emoji and "every type of character."** The ink-ordered set needs a darkness value per character. For
   ASCII we can write a small bitmap and count lit pixels ourselves. For the rest of Unicode and for emoji
   there is no bitmap in this repo and a font is third-party. Proposal: pick a few hundred characters (all of
   ASCII, box and block drawing, some symbols, a set of single-code-point emoji) and give each an ink value by
   hand, in a data file. Emoji keep only a symbol role; the pixel's colour is what gets stored. Sequence emoji
   (joined with zero-width joiners) are out because "one pixel, one character" needs one code point. Text
   stays raw UTF-8 bytes, with no index table, because the no-tokenizer rule forbids one. That means an emoji
   cell is 3-4 bytes. OK?
3. **"Every coding language."** We can run, with no installs, JavaScript (Node) and, where Python is already on
   the machine, the Python standard library. Languages that need a compiler (C, Rust, Go, Java and so on) need
   third-party tools. Options: only languages we can run, plus drawing formats we write our own renderer for
   (an SVG subset, an HTML/CSS box subset); or write small interpreters for subsets of more languages (a lot of
   work); or include languages as *unverified* text, which loses the check. I recommend the first. Which?
4. **Chips before code and text right after speech.** This reverses the earlier order. Confirm.
5. **Maths** is not in your list. Keep it as support only?
6. **Conflict with `docs/TRAINING_FOCUS.md`.** That file (2026-11-14) says research, code, skills, the extension
   builder and plugins, and fixing mistakes come first and the music-to-chips stages are not the priority.
   This section restates the long-term order and does not change that file, so the two now point at different
   first moves. Pick one for what gets built next. Both can stand if this is the long-term order and the
   focus file is the near-term one.
7. **The cap `N`** in T2: my default above is an even spread, which is strict. Say if you want it looser.
8. **The public database** (step 16): confirm my reading (records may train, websites may not), say what "rule
   stuff" and "nice workaround" meant, and say where it would be published. Nothing goes public until you say.
9. **Ethics thread:** keep it as a thread through every stage (my proposal) or make it a rung at one point? And
   do you accept adding right-but-unrewarded stories next to the "good is rewarded" ones?
10. **"Sound originally, and that's it."** I took this as sound-led, with the video riding along (steps 1-3).
    If you meant audio only for the first stages and no video at all, say so; it changes what gets built first.
11. **Good-only and the repair data.** The failed attempts in `docs/TRAINING_FOCUS.md` are bad code. I propose
    they appear only as input, with the training loss on the fix alone. Is that acceptable, or do you want no
    failed attempts anywhere in the data?
12. **Good-only and recognising bad.** A mesh that has never seen bad cannot recognise it, so the code gate does
    that part and "good" is written wide enough to cover ordinary harmless things. Confirm.
13. **Character meanings.** Who writes the name and meaning for each character and emoji, you or me? I would not
    import a published list.
14. **Short text.** Confirm the two registers (short for thinking and chat, full for reports and proofs), and say
    which short forms you want in the table (ok, y, u, idk, and so on).
15. **Comedy.** Confirm the kind-only rule (no humour built on cruelty), and whether you will rate samples.

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
- **Good examples only (owner, 2026-11-21).** Nothing in a training set shows a harmful, dishonest or cruel
  act as the thing to learn. Generators write only the good branch, and a sample enters only if every
  written "good" rule passes. See "The good-only rule" in the revised ladder.
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

**The roster (owner, 2026-11-15).** The owner gave the full list of animals whose sounds the mesh is to be
trained on: 333 entries, 332 once the repeated "Dove" is dropped. It is stored verbatim, in the owner's order,
in `training_data/animal_species.json` (invertebrates through to cetaceans, human included). The file is the
roster only. It does not rank the animals and it does not say how any of them sounds.

Two things the roster does not settle, so they are open for the owner:

- **Where the sound comes from.** The ground rules above forbid downloaded or third-party recordings, and the
  plan is that the hand-written synth makes every sound with the truth known. A species name on this list
  then needs a written, checkable description of how that animal really signals (a click train, a stridulated
  chirp, a low-frequency rumble, a song with repeats), and several entries have no vocal sound at all
  (sponge, coral, jellyfish, starfish, sea urchin); they need a rule for what "its sound" is, such as the
  noise it makes when it moves or feeds, or they are left out. Until that is written, the roster is a list of
  names and rungs A-F above are still the only generators.
- **How to split 332 labels.** One label per species is a very large decode task for a mesh that
  today holds about five small tasks (see the capacity section). Suggest grouping by signal type first
  (clicks, chirps, songs, calls, rumbles) and only splitting into species once a group is passed.

**The 60-animal ladder: least to most reliant on sound (owner, 2026-11-15).** A second list from the owner, and
it is a different thing from the roster above. The roster says *which* animals are covered. This list says
*in what order*: 60 sound-communicating animals with brains, ordered by how much each one depends on sound to
live, from animals that mostly use sight, smell or touch up to humans. It is the owner's order and it is kept
as given. The names are specific species ("Gray Wolf", "Little Brown Bat"), while the roster uses broader
names in places ("Wolf", "Bat"), so the two lists are not a one-to-one match and nothing here checks that they
are. Many names below are finer than the roster's wording (for example "Orca / Killer Whale", "Little Brown
Bat") and some may not be in it at all. Reconciling the two is open for the owner.

How it is used: it gives rungs A-F above a second axis. Rungs A-F rank the *signal system* (how much structure
the sound carries). This list ranks the *animal's dependence on sound*. Early entries are low-weight, simple
sounds (a grunt, a hiss, a pop, a bark) where the sound is one cue among several. Late entries are where sound
carries navigation, identity, grammar-like structure and culture. Use the group boundaries as curriculum
steps: pass a group's exam before the next group is mixed in.

*Minimal sound reliers (mostly sight, smell or touch)*

1. Goldfish (subtle clicking sounds)
2. Giant Tortoise (mating grunts)
3. King Cobra (defensive hissing)
4. Clownfish (chirps and pops for hierarchy)
5. Spiny Lobster (shell-rubbing rasps to deter predators)
6. Ghost Crab (claw-stridulation warning sounds)
7. Snapping Shrimp (loud claw snaps to stun prey and mark territory)
8. Oyster Toadfish (boatwhistle hums to attract mates)
9. Tokay Gecko (loud territorial barks)
10. American Alligator (infrasonic mating bellows)

*Seasonal and situational sound reliers*

11. Death's-Head Hawkmoth (squeaks when disturbed)
12. Madagascar Hissing Cockroach (defensive and mating hisses)
13. Yellow Fever Mosquito (wing-beat frequencies to find mates)
14. Honeybee (piping sounds to coordinate swarms and new queens)
15. Field Cricket (wing-rubbing chirps for mating and territory)
16. Katydid (high-frequency mating calls)
17. Periodical Cicada (loud tymbal buzzing for mass mating)
18. Spring Peeper Frog (chorus mating calls)
19. American Bullfrog (deep territorial and mating croaks)
20. Coqui Frog (loud two-note calls to claim space and attract mates)

*Moderate to high social sound reliers*

21. Domestic Cat (meows and purrs tailored for humans and kittens)
22. Red Fox (barks, screams, and yips for territory and mating)
23. Elk (loud bugling during the autumn rut)
24. Hippopotamus (amphibious wheeze-honks to defend territory)
25. African Lion (long-distance roars to patrol territory and unite the pride)
26. Spotted Hyena (whoops and giggles to signal rank and coordinate hunts)
27. Domestic Dog (barks, growls, and whines for social bonding and alerts)
28. Gray Wolf (howls to assemble packs and defend borders)
29. Meerkat (over 30 distinct calls for sentry duty and foraging)
30. Gunnison's Prairie Dog (complex language describing specific predator sizes and colors)
31. African Bush Elephant (infrasonic rumbles heard miles away for herd coordination)
32. Barn Owl (screeches and hisses paired with extreme hearing to hunt in the dark)
33. Emperor Penguin (unique vocal signatures to find mates and chicks in massive crowds)
34. Domestic Chicken (over 24 distinct calls for food, predators, and nesting)
35. European Robin (year-round territorial songs)
36. Common Nightingale (complex, hundreds-of-notes mating songs)
37. Superb Lyrebird (near-perfect mimicry of other birds and environment sounds)
38. Common Raven (wide range of calls and mimicry for problem-solving and social play)
39. African Grey Parrot (advanced vocal mimicry and contextual sound use)
40. Zebra Finch (learned songs passed down from father to son)

*Extreme social and navigation sound reliers*

41. Ring-Tailed Lemur (barks, wails, and purrs to keep troop cohesion)
42. Siamang Gibbon (amplified throat-sac duets to bond and claim canopy territory)
43. Red Howler Monkey (deafening dawn choruses to space out troops)
44. Vervet Monkey (specific alarm calls for leopards, eagles, and snakes)
45. Campbell's Monkey (combines basic calls with suffixes to change meaning)
46. Bonobo (high-pitched peeps and whistles to maintain peaceful social bonds)
47. Chimpanzee (pant-hoots, screams, and grunts for complex politics and hunting)
48. California Sea Lion (barks to locate pups and defend rookeries)
49. Weddell Seal (alien-like trills and whistles to navigate under Antarctic ice)
50. Egyptian Fruit Bat (tongue-clicking echolocation and social squabbles)
51. Common Vampire Bat (echolocation for hunting and contact calls to share blood meals)
52. Little Brown Bat (constant ultrasonic echolocation to catch flying insects in pitch black)
53. Greater Horseshoe Bat (specialized Doppler-shift echolocation for dense forests)
54. Fin Whale (powerful low-frequency pulses traveling across entire ocean basins)
55. Humpback Whale (long, evolving, structured songs shared across populations)
56. Beluga Whale ("canaries of the sea" using varied chirps, clicks, and whistles under ice)
57. Sperm Whale (rhythmic click patterns called codas to identify family clans)
58. Orca / Killer Whale (pod-specific dialects and echolocation for coordinated hunting)
59. Bottlenose Dolphin (echolocation to "see" underwater plus unique individual "name" whistles)
60. Human (fully developed spoken language for abstract thought, culture, and cumulative knowledge)

Notes, bluntly:

- **The descriptions in brackets are the owner's claims, not verified facts.** Several are loose or
  contestable (goldfish "clicking" is mostly incidental sound, "alien-like" is not a description a
  generator can use, "complex language" for prairie dogs is stronger than the literature supports, and
  the gap between 59 and 60 is a difference of kind, not one more step). Per the rule above, read up
  before any of these goes into a generator or a doc as fact.
- **Ordering is a judgement call.** Placing the cat, fox and chicken below the bats and whales is
  defensible; placing the tortoise below the alligator, or the hippo below the lion, is arguable.
  It is the owner's order and it stays, but the exam should not depend on any single adjacent pair being
  "right".
- **Each entry still needs a written, checkable sound description** (a click train, a stridulated
  chirp, an infrasonic rumble, a song with repeats) before a generator can make it, exactly as the roster
  needs. The bracketed text is a starting point for that, not the spec.
- **Entry 60 is not a generator target here.** Human sound belongs to stages 4-6. It is on the list as the
  top of the ladder, and the real test is whether the mesh that has climbed the ladder reaches stages 4-6
  faster (see the bet below).
- **Capacity applies.** Sixty labelled species at once is far beyond what the mesh holds today. Work
  group by group and, inside a group, by signal type (rasp, hiss, click, chirp, song, call, rumble)
  before species.

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
4. The text-twin and 360° renderer, since it is the most unusual part and decides the byte budget. Since
   2026-11-21 it is also the source of the animal video (step 2 of the revised ladder), so it comes before the
   animal generators, not after. Build the filter views (plain, T1, T2, T3) with it; the code view comes later.
5. Everything else in the revised order (see "Owner's revised ladder").

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
