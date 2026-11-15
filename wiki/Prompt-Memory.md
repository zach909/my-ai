# Prompt Memory

A big archive fed through the [[Zip-IO|Zip Loop]] costs the same minutes every time (about a second per input byte on the live mesh). Prompt memory keeps, for each such archive, a **much smaller archive that makes the mesh say the same thing**, and hands that one out instead.

```
big archive  ──Zip Loop──▶  output
stand-in     ──Zip Loop──▶  the same output (or as close as you asked for)
```

The stand-in is an ordinary archive: the same `ZipTree` that `packZip` turns into the gzip the doorway always takes, so it looks like a zip to the loop and nothing downstream has to know. It is made **only by removing** things from the big archive, never by writing new text, so everything in it was in the original.

You can add to it ("extra talking"), but the stored stand-in never changes: `use` gives you a fresh copy with your extra files added, and refuses to overwrite a file the stand-in already has.

## How it finds one

By trying, on the real mesh. A candidate only counts if the mesh, run on it, gives the output the big archive gave. The search is delta debugging, in three passes:

1. **Whole files**, biggest first (does it need `memory/old-chat.txt` at all?).
2. **Each remaining file back to its tail.** The mesh hears the end of a message best, so this is where the big wins are: halving then bisecting, a handful of trials per file however long it is. Measured on a toy mesh that only hears the last 30 characters: a 411 KB archive became 71 bytes in 21 runs.
3. **Runs of lines** inside what is left.

Each trial is a real run (slow), so the search is capped (`maxTrials`, default 120; `maxMs`, default 30 minutes), caches trials it has already made, and keeps the best stand-in found so far whenever it stops. `exhausted: true` on a result means the cap stopped it and a smaller one may exist.

## It can refuse, and that is the point

A stand-in that "matches" proves nothing if the mesh ignores its input. So before searching it checks, and stores nothing when:

| Refusal | Meaning |
|---|---|
| `blind` | A **scrambled copy** of the archive (same size, every file written backwards) got an output just as close as a stand-in would. The mesh is not reacting to what is in the archive, so any stand-in would match. With the Zip Loop's memory off the mesh forgets all but the last few bits within about 6 ticks, which makes every long input look alike; this is the same trap `context-replay.ts` guards against. |
| `unrepeatable` | The big archive was run twice and the outputs disagreed by more than 15%. |
| `no-shorter` | Nothing could be removed without changing the output. |
| `empty` | Nothing in the archive. |

If the mesh does not repeat itself exactly, a stand-in only has to match as well as the big archive matches itself (`threshold` is lowered to that, and recorded).

## What a match does and does not prove

- It was checked **on the archive alone**, and on any `probes` you gave (extra file sets such as a question, appended to both). Anything you add later that was not a probe was not checked. Give probes for the kinds of thing you will add.
- It matches **from the starting state the runner uses for every trial**: the mesh as it was when the search began, put back after each run (a run learns from its input, so a trial that was not undone would move the weights; this was checked on the real engine class: a bare run changes the weights, a trial through the runner leaves the whole snapshot identical).
- It matches **the mesh it was checked against**. Each stand-in carries that mesh's fingerprint (a digest of the learned weights, not of what the mesh holds this tick) and `stale` is true once the mesh has learned something since. `refresh` makes it again, but only from the original, which is kept only if you recorded with `keepOriginal`.

## Honest status

- Proven on a toy mesh in `test/core/prompt-memory.test.ts` (keeps what is read, drops the rest, never adds text, tails, refusals, noise, probes, never changes a stand-in, stale, path safety), and the runner is proven against the real `HyperDimensionalEngine` and `ZipLoopInterface` for putting the mesh back.
- **Not yet run against a trained mesh.** An untrained mesh, at the toy size and at the live 336 x 64 size, sends no output bytes at all for any input, so the search correctly refuses it as `blind`. Whether the trained live mesh gives stand-ins that are worth having is the open question.
- With the Zip Loop's memory on, the end of every packed archive is a CRC-32 of the *whole* content (gzip's trailer), so deleting content changes the last bytes the mesh hears. That makes exact matches harder when memory is on. A candidate that keeps the original's last bytes is a possible next step and is not built.

## Using it

Over HTTP (behind the normal sign-in, per person; the `prompt-memory-routes` plugin):

| Route | What it does |
|---|---|
| `POST /api/prompt-memory/record` | `{files, binary?, name?, threshold?, maxTrials?, maxMs?, probes?, keepOriginal?}`. Answers **202** at once; the search runs in the background and **holds the doorway while it works, so chat waits its turn**. One at a time. |
| `GET /api/prompt-memory/job` | What it is doing now, or did last: stage, mesh runs, smallest size so far, and the outcome or why it refused. |
| `GET /api/prompt-memory` | Every stand-in without its text. `?stale=1` also asks the mesh whether each is still current. |
| `GET /api/prompt-memory/standin?id=` | One stand-in with its files. |
| `POST /api/prompt-memory/use` | `{id, extra?}`. Returns `files`, `binary`, `packedBytes` and `stale`, the shape `POST /api/zip-loop/run` takes. |
| `POST /api/prompt-memory/refresh` | `{id}`. Makes it again on the mesh as it is now (needs the kept original). |
| `DELETE /api/prompt-memory?id=` | Forget one. |

Stand-ins are plain JSON files, one each, in `prompt-memory/` inside your NeuroClaw data folder; the kept original, if any, sits beside it as `<id>.big`. **Delete all memory** in Settings clears them.

In code: `models && skills/core/prompt-memory.ts` (`shrinkPrompt`, `PromptMemory`, `doorwayRunner`). The mesh is reached through the small `PromptRunner` seam, so the search is tested without one.
