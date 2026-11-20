# Training results on the open corpus (2026-10-31)

> The figures below were measured on the 2026-10-31 corpus (9 books, 15 summaries). On 2026-11-13 the corpus
> grew (14 books, 15 summaries, 18 full Wikipedia articles under `wikipedia_full/`); these numbers have not
> been re-measured. `train-open-corpus.mjs` still reads only `gutenberg/` and `wikipedia/`.

Trainer: `NeuroclawTrainer` (`models && skills/trainer.ts`), character-level n-gram/embedding prose
predictor, order 8, 1 epoch. No tokenizer; no third-party code. Data and licences: `CITATIONS.md`.
Re-run: `node scripts/fetch-open-corpus.mjs` then `node scripts/train-open-corpus.mjs 1500000`.

Next-character prediction on text the model never saw (8,060 characters from two book openings and
three Wikipedia summaries; 138-symbol vocabulary; chance top-1 is 0.75%):

| Training text | Train time | Top-1 before | Top-1 after | Perplexity before | Perplexity after |
|---|---|---|---|---|---|
| 100,020 chars | 4.3 s | 16.4% | 49.5% | 88 | 7.8 |
| 1,233,391 chars | 71.8 s | 16.4% | 56.7% | 134 | 5.3 |

Limits, stated plainly:
- This is a statistics model of text, not a reasoning model. Lower perplexity means better character
  prediction, not understanding or alignment.
- The "before" row is an untrained model's uniform output; its 16% top-1 is a tie-break artefact.
- The trainer keeps weights in memory only. The server teaches it live via `POST /api/train`
  (`learnText`, corpus capped at 200,000 chars); nothing here is saved as a model file.
- Gutenberg texts are public domain in the USA only. Wikipedia summaries are CC BY-SA 4.0 (ShareAlike).
- The corpus has no refusal/pressure-test examples (ALIGNMENT.md §8.2); those still need writing.

## Re-measured 2026-11-14 (corpus of 2026-11-13)

Corpus: the 47 cited files listed in `manifest.json` and `CITATIONS.md` (14 Project Gutenberg books, public domain
in the USA; 15 Wikipedia summaries and 18 full articles, CC BY-SA 4.0, revision ids in the manifest). Every file's
SHA-256 was re-checked against `manifest.json` before this run, and the knowledge extension built from them
(`open-corpus-knowledge 1.0.0`, id `kx-66eff051e3e8703d`, 10,101 passages) verified against the same files with
`node extension-builder/build-corpus-extension.mjs --verify`.

Run: `node scripts/train-open-corpus.mjs <chars> "<absolute path to dist/models && skills>"` (the default relative
`dist` path is read by Node as a package name and fails). `train-open-corpus.mjs` still reads only `gutenberg/` and
`wikipedia/`; `wikipedia_full/` is cited and in the extension but not trained on. Company and brand names are blanked
by `scrubNames` before training. Same held-out set as above (8,060 characters).

| Training text | Train time | Top-1 before | Top-1 after (other / same books) | Perplexity before | Perplexity after (other / same books) |
|---|---|---|---|---|---|
| 300,013 chars | 12.8 s | 16.9% | 53.5% / 61.0% | 96 | 6.03 / 4.07 |
| 1,381,669 chars | 75.6 s | 16.9% | 58.0% / 63.5% | 134 | 4.90 / 3.49 |

Same limits as above: a character-prediction score, not reasoning or alignment; weights are kept in memory only.
