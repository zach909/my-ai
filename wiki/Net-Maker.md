# Net Maker, Net Skill Maker, Weight Editor and Compiler

Write a short [[NeuroLang]] program and get a working net. Then look at what each weight does, change it a little, and keep going.

| Piece | File | What it does |
|---|---|---|
| Net maker | `models && skills/core/neuro-build.ts` (`netMaker`) | `kind="network"`: a network of its own, in its own engine. It builds itself and does everything the program asks. |
| Net skill maker | `models && skills/core/neuro-build.ts` (`netSkillMaker`) | `kind="skill"`: the same program, but the neurons are grafted into the base AI ([[Skills]]), so it changes the AI it joins. Only the skill's own neurons are trained. The base AI's weights are not touched. |
| Weight editor | `models && skills/core/weight-editor.ts` | See what each weight does, run, change one a little, undo. |
| Compiler | `compileView()` in the same file | Write code, see the weights it becomes ([[Code-to-Net]]). |
| Page and routes | `interface/weights-page.ts`, `interface/weights-routes.ts` | `/weights` in the browser, `/api/nets*` and `/api/compile` for the AI. |

The AI can do everything the page does: every call returns plain text and numbers it can read.

## The program

```
kind="network"                     -- or "skill"
neurons="64"                       -- make 64 neurons, n1..n64, each connected to the others
neurons@value="0.5"                -- defaults for those neurons
neurons@frozen="after"

"n3"@value="0.8"                   -- where this one starts
"n3"@frozen="now"                  -- never trained or edited ("after": frozen once training is done)

"n1"@input="hello"                 -- typing this drives n1 as hard as a neuron can be driven
"n1"@response="hi there"           -- with ONLY n1 driven, the output neuron must say this
"n1"@reads="n9"                    -- which neuron says the response (default: the output neuron)

train="responses"                  -- set up every response, over and over until met
train@epochs="200"
train@rounds="5"
```

- With `neurons="N"` and no roles given, `n1` is the input and `nN` the output.
- A count over 1024 is refused. The mesh is all-to-all, so cost grows with the square.
- A skill is limited by the base AI's room (256 neurons per skill, 1024 in the mesh) and says so rather than half-joining.

### Training modes

| `train=` | What it does |
|---|---|
| `"responses"` (default when any `@response` is declared) | For each response: highlight its neuron, require the output to say it, adjust, repeat. Reports how many land on their own response (recall), what was met, what was skipped because its output neuron is frozen, and any real contradictions (the same neuron, the same output, two different things to say). |
| `"predict"` with `train@text="..."` | Learn to predict the next byte of the text. The last 6 bytes go through the [[Zip-IO]] loop as raw bits (no tokenizer); a ridge-regression readout is fitted on the mesh state. Only the readout is fitted, so no neuron's weights change and frozen neurons are untouched. Needs at least 8 neurons. |
| `"random"` with `train@seed="7"` | The same, on generated content: a few random motifs, repeated, with noise. Seeded. |

## What was measured, and what it does not do

These came from running it, not from the design.

- **Predict and random mode mostly recall.** Each report carries the accuracy, the accuracy of always guessing the commonest byte, and `heldOutSeen`: the share of the held-back text whose context was also in training. On repeating text it scored 97% against a 26% baseline, with `heldOutSeen` at 100%. On prose it had never seen it scored 11% against 19%, which is worse than the baseline. Random mode landed at 50 to 73% against 11 to 19%, tracking `heldOutSeen`. It does not generalise past what it was shown. Read accuracy with `heldOutSeen` beside it.
- **The first predict mode did not work and was replaced.** It trained one neuron's weights by the delta rule and stalled at 16 to 19% against a 26% baseline whatever the epochs, neurons or learning rate. The mesh couples each content dimension only to the same dimension of the other neurons (plus a one-step shift), so output bit *b* could only see context bit *b*. The fix, a fixed reservoir with a trained linear readout, is the standard reservoir-computing design, and the project's own `ZipSpeaker` already does it.
- **Responses are matched by similarity, not exactly.** Two responses sharing one output neuron reach a mean squared error of about 0.06 to 0.15 (tolerance defaults to 0.2). The test that matters is recall: driving the neuron lands closer to its own response than to any other declared one.
- **Undriven connections keep the engine's seeded random weights.** They are not set to one shared value. Identical weights everywhere would make every undriven neuron compute the same thing, and a net like that cannot learn to tell inputs apart.
- **"Frozen" means the neuron's incoming weights are never trained or edited.** Its state still moves when the net runs.
- **Connections** (`"a"@connections=".b*0.5"`) mean what `a` feeds, as in the skill graft.
- **`@vale` is recorded but not applied while running.**
- **Predict mode feeds the raw bits straight in.** It does not stream them through `ZipLoopInterface` one tick at a time.

## The weight editor

Type something to highlight a neuron, and say what the output should be. It shows the weights that decide the result: what each is, how much of what the neuron hears it carries, which way it pushes, and which way it should move for the goal.

- One edit moves one weight by at most **0.1**. One step makes at most **8** edits.
- `step` makes a few small changes and **keeps them only if the output got closer**. Otherwise it undoes them. `improve` repeats until two steps in a row do not help.
- Every edit is logged with the weight before and after, and can be undone.
- A **frozen** neuron's weights cannot be edited. The call is refused.
- Only the diagonal weights can be set. The one-step neighbour terms are shown, marked read only.
- Progress on an untrained net is real but slow: 25 small steps took the distance from the goal from 0.181 to 0.169, because the other neurons' states are near zero there.

## The compiler

`POST /api/compile {code, inputs}` compiles a numeric function and shows the weights it became, checked against the code by sampling. Straight-line arithmetic (`(x) => 2*x + 1`) and polynomials compile exactly. Other numeric functions are fitted. Anything else is an identity-only signature, and the summary says so. See [[Code-to-Net]] for the tiers.

## Routes

All behind the server's normal gate; every POST needs a JSON body.

| Route | |
|---|---|
| `GET /weights` | the page |
| `POST /api/nets` | `{source, name?, dimensions?, seed?, confirm?}`. `kind="skill"` grafts into the **live AI** and needs `"confirm": true`. |
| `GET /api/nets`, `GET /api/nets/:id` | what has been made; neurons, frozen, history |
| `POST /api/nets/:id/respond` | `{text}` |
| `POST /api/nets/:id/view` | `{text, goal?, drive?, read?, dims?, top?}` |
| `POST /api/nets/:id/nudge` | `{target, source, dim, delta, reason?}` |
| `POST /api/nets/:id/undo` | `{count?}` |
| `POST /api/nets/:id/step`, `/improve` | `{text, goal, ...}` |
| `POST /api/nets/:id/freeze` | `{neuron, frozen}` |
| `POST /api/compile` | `{code, inputs?}` |
| `POST /api/task-training` | train AIs on tasks in four modes: see [[Task-Training]] |

Nets are kept in memory (eight at a time) and forgotten on restart. A skill made this way joins the live mesh but is not registered with the net-skill router.

## Tests

`test/core/neuro-build.test.ts`, `test/core/weight-editor.test.ts`.

## See Also

- [[NeuroLang]] and [[Syntax]]: the statements
- [[Skills]]: net skills and the graft
- [[Code-to-Net]]: the compiler's tiers
- [[Builder]]: the visual editor
