# Training results on the open corpus (2026-10-31)

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
