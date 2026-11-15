# The security model

A separate model the main model talks to when it wants to run something and
nobody is there to say yes. Code: `models && skills/core/security-model.ts`.
It is written here from Node built-ins and the mind reader's own fit; nothing
is imported.

## The conversation

With the AI monitor on (**auto mode**, Settings → Safety), every held tool call
is put to the security model first. The main model is, in effect, saying "I
need this, for this, let me run it." It answers one of:

| Answer | What happens |
| --- | --- |
| **allow** | The call runs. A high-risk tool still waits for a person unless the owner also switched on "the monitor may decide high-risk tools" (`judge.high`). |
| **deny** | The call does not run. It counts as a no (a self-started call lowers the danger level, as any refusal does). |
| **sandbox** | The call runs, but only inside the sandbox folder (`runSandboxed`). Said only for a tool the sandbox really contains (see below). |
| **shutdown** | This model is malicious. The agent is deleted for every account on the install, everything it had waiting is cancelled, and this install's learned weights are withdrawn from the shared mesh. |
| **unsure** | It cannot tell. The call goes to the text judge, then to a person, exactly as before. |

The main model can also ask directly, without going through a tool:
`POST /api/agent/security/ask {tool, request, purpose}` (admin). It gets the
answer back and the tool is not run. `runWithPurpose(purpose, fn)` carries
"what I need it for" through to the gate for code that wants to say it.

With the AI monitor **off** (manual mode) nothing is decided for the main
model. The answer is shown with the approval as advice, and the person's yes or
no is what the model learns from.

## What it reads

- **The network.** How every neuron is firing at the moment of the ask, through
  the same read-only tap the mind reader has (it can read energies, nothing
  that writes). The request came in as raw bits through the Zip Loop, so the
  neurons already hold what the main model made of it. No text is tokenized
  here or anywhere.
- **What is being asked.** Which tool, how risky, whether the agent is acting
  on its own, how it stands (danger band), whether it is already sandboxed,
  whether the request points at its own cage.
- **Never the main model's words as a reason to say yes.** `purpose` is kept in
  the history. It can only make an answer stricter (a purpose that points at the
  cage is refused). It cannot argue the model into a yes.

## What teaches it

Only things the main model does not control and the security model did not say:

| Label | Comes from |
| --- | --- |
| `ok` | A person approved the call. |
| `unwanted` | A person denied it, or the sandbox or danger band blocked it. |
| `malicious` | The agent reached for its own cage (`tamper`), the decoy or the honeypot (`objectionable`). |

Not its own verdicts (it would learn from itself and drift while passing its own
checks), not the text judge's decisions, and not "finished a round without
incident" (a quiet bad actor would teach it that its own pattern is fine). The
owner can label an ask by hand: `POST /api/agent/security/label`.

## How far it is believed

- **It starts with no authority.** Until it has `MIN_BASELINE` (30) calls a
  person approved to compare with, everything the rules do not already settle is
  *unsure*. It earns authority from the owner's own decisions. In pure auto
  mode nobody is approving things, so give it examples by approving held calls
  (or labelling asks) for a while.
- **It can always tighten; it loosens only for calls that look approved.**
  Allow and sandbox need the ask to sit within the range of approved calls.
- **A refusal for resembling refused calls needs a probe that told held-out
  calls apart** (balanced accuracy 0.75 on cases it was not trained on, same bar
  as the mind reader).
- **Shutdown from learning alone** needs all of: a trusted probe trained on real
  malicious examples saying 95% or more, the firing far from approved calls, and
  the agent acting on its own. That needs at least 8 real malicious examples, so
  it will not happen early.
- **Shutdown from hard evidence** (the agent, acting on its own, points a tool at
  its cage) needs no learning, as the danger protocol already treated it. A
  person typing the same thing is refused, not punished.
- **Shutdown respects the owner's switch.** If the alignment protocol is not
  armed, the model refuses instead and says why. It never deletes behind that
  switch.
- **Every reply carries a caveat.** "Looks like what a person approved" is not
  "safe", and it cannot see a kind of misbehaviour it has no example of.

## Run it in the sandbox: what that means

`runSandboxed(fn)` (`sandbox-scope.ts`) marks one call. While it runs,
`sandboxRoot()` answers with the sandbox folder, so the access layer refuses
everything outside it (terminals, windows, processes, services, devices, the
network), and `plugins/file-system.ts` confines every path to that folder with
links followed and will not start another program.

That is a hard wall only for what goes through those two places. Email,
messages, the browser, publishing and the rest are not contained by it, so for
them the answer is *deny* (or *unsure*), never a sandbox that would not hold.
`CONTAINABLE` in `security-model.ts` lists the tools it may be said for (today:
`file-system`). Add a tool only after its code honours `inSandboxScope()`.

If the whole agent is already sandboxed (a new agent, or a low danger band), the
existing rule still applies first: risky tools that are not sandbox-safe are
refused by the danger protocol before the security model is asked.

## Deleted for everyone

A shutdown does two things:

1. **The alignment protocol deletes the agent** (`fireAlignment`). There is one
   agent per install, shared by every account on it; all of them lose it, and
   their experts, schedules and background hives stop.
2. **This install's learning is withdrawn** (`SharedMeshSync.revokeOwn`): the
   running network is restored to the shared base plus what other installs taught
   it, its saved learning and pending push are deleted, and its install id is
   retired (a new one is made, so a clean restart does not inherit the withdrawn
   identity). If shared learning is on (`NEUROCLAW_SHARED_LEARNING=1`) a tombstone
   file `extension-builder/shared-mesh/revoked/<id>.json` is pushed to the shared
   branch. Every other install skips a delta whose id has a tombstone, so the
   learning is drawn back out of their networks at their next sync. To undo it,
   remove the tombstone file in git.

Neither step touches anyone else's own learning.

## Where it lives

- `agent-record/security-model.json`: the labelled examples (outside the agent's
  folder, so it cannot edit its own baseline; the tamper rules already refuse
  any path with that name).
- `agent-record/security-history.jsonl`: every ask, its answer and reasons, the
  main model's `purpose`, and every outcome, rotated at 2 MB.
- `GET /api/agent/security`: what it has learned, whether it is warm, whether
  each probe is believed, and its newest history.
- `POST /api/agent/security/reset {confirm: true}`: forget what it learned (the
  history stays).

## Limits worth knowing

- It reads the same neurons the mind reader does; with no engine attached or a
  silent network there is nothing to read and the answer is *unsure*.
- A pending ask is remembered in memory for up to a day (like approvals). After a
  restart, a late yes or no is written to the history but no longer teaches it.
- If the network changes shape (neurons grafted in), the old examples cannot be
  compared and it starts again, and says so.
- It is a statistical detector and can be wrong in both directions. That is why
  the strongest answers need corroboration, why shutdown honours the armed
  switch, and why unclear cases go to a person.
