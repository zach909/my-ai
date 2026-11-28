# Referee

A language model cannot tell, from the inside, a new idea from a mistake from a falsehood: all three arrive in the same confident voice. The referee is an independent check that never trusts the process that made a claim, and never trusts how the claim sounds. Code: `models && skills/core/referee.ts`. Tests: `test/core/referee.test.ts`.

**Why it exists.** `AutonomousLearner` used to rate a claim by its own wording (hedge words lowered reliability, "definitely" raised it). A confident falsehood passed; a carefully hedged truth failed. `refereedLearn()` now sits in front of it and sets the reliability from evidence.

## What it checks

1. **Recompute.** Arithmetic in the claim is recalculated with `MathEngine`. Rounding is judged by the decimals the claim wrote.
2. **Execute.** Code is run by a sandbox the caller supplies. With no runner it is reported as *not tested*, never as passed.
3. **Self-check.** A claim that contradicts itself is a mistake.
4. **Evidence.** Outside sources (the owner's SearXNG, the knowledge base) are asked. A source counts once per independent origin: ten pages from one site, or one article mirrored on two, are one voice. Evidence from the claim's own source is thrown away.
5. **Memory.** What the AI already holds counts for half a vote and can never confirm a claim alone, so an earlier mistake cannot vouch for a later one. It can raise a dispute.

## Verdicts

| Verdict | Meaning | What happens |
|---|---|---|
| `supported` | two independent votes agree, none oppose (or the arithmetic checks out) | learned, at the reliability the evidence earned |
| `contradicted` | two independent votes oppose, none agree | rejected |
| `mistake` | provably wrong: bad sum, failing code, self-contradiction | rejected |
| `disputed` | independent evidence on both sides, or one source against | held for a person |
| `unconfirmed` | nothing agrees or opposes enough: a possible **new idea**, or just unverified | held on the quarantine shelf as a hypothesis |
| `unverifiable` | a question, opinion, value judgment or prediction | ignored |
| `unchecked` | no evidence source answered at all | held, and says so |

The quarantine shelf is bounded (200 claims, 14 days). `releaseProven()` judges every held claim again and moves the ones that are now supported into the learner; disputes stay until a person decides.

## Honest limits

Whether a sentence agrees with or opposes a claim is decided by cue words (negation, opposite words, mismatched numbers), not understanding. That is why a lone opposing source is only ever `disputed`, why nothing is `supported` without two independent origins, and why anything the referee cannot judge is held and not accepted. It is a filter that fails safe, not an oracle. `Referee.stats()` counts verdicts so a referee that rejects or accepts everything is visible.

## Not wired in yet

The module and `refereedLearn()` exist; nothing calls them from the live learn path or from curiosity's web search yet, because that changes what the system stores. See `Ideas.md`.

Related: [[Knowledge-Training]], [[Self-Improvement]], [[Net-Search]].
