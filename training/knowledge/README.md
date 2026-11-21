# Knowledge and training system

A modular, evaluated, versioned training pipeline built from the 41 sources in `sources/my_ai_training_sources.csv`.
Plain Node (built-ins only; repo rule: no packages, no third-party code, no learned tokenizer). Run from the repo root:

```bash
node training/knowledge/cli.mjs run        # sources -> collect -> validate -> extract -> train -> evaluate -> RESULTS.md
node --test test/training/knowledge.test.mjs
```

Other commands: `sources` `probe` `collect [id..]` `validate` `extract` `train [--no-tune]` `eval` `status` `rollback <component> <version>`
`compose [--seed N --mode M --bars N --bpm N]` `research "<question>"` `verify "<claim>"` `check "<text or request>"` `report`.

## Layout

| File | Stage / job |
|---|---|
| `sources/catalog.mjs`, `sources/index.mjs` | The 41-row investigation (licence, bulk access, size, format, how to download, limits, evidence URL), completeness check, `CITATIONS.md`, live link probe |
| `collect.mjs` | 1 Collection (licence-gated fetchers, SHA-256 manifest per source) and 2 Validation (re-hash raw files) |
| `text.mjs` | 3 Cleaning, 4 Tokenisation (UTF-8 byte view + plain word view for retrieval only), 6 De-duplication (exact + MinHash near-duplicate) |
| `safety.mjs` | 5 Classification: good / bad knowledge rules, code safety scan, request gate |
| `extract.mjs` | 7 Knowledge extraction -> `processed/collections` (documents), `processed/kb` (KL facts/rules), `processed/eval` |
| `reason/lang.mjs`, `kb/core_science.kb` | Compact reasoning language (FACT/RULE/COND/NOT/FUNC/EXCL/ASSUME), forward-chaining engine with proofs, contradiction detection |
| `retrieval.mjs`, `verify.mjs`, `research.mjs` | BM25 search, ranking metrics, claim verification, source comparison, cited extractive answers |
| `audio.mjs` | Recognise (features + kNN), classify (family), interpret (AudioSet ontology path): three separate capabilities |
| `compose.mjs` | Music from theory + a seeded randomizer: scales, diatonic triads, functional-harmony progression ending V-I, rule-constrained melody, MIDI + WAV output, and an analyzer that checks the result against the same rules |
| `train.mjs`, `registry.mjs` | 8 Training of independent components, 10 versioned checkpoints, promotion gate, rollback |
| `evaluate.mjs`, `eval/*.jsonl` | Benchmarks and labelled suites; `RESULTS.md` is generated from them |

Data lives in `training_data/knowledge/` (`raw/`, `processed/`, `checkpoints/` are git-ignored and rebuilt by `run`; `reports/` and `catalog.json` are small and committed).
`music.composer` is trained and versioned as its own component from synthetic data only (`processed/synthetic/`, never read by any other component), so it carries no licence restrictions and cannot contaminate real-data models.
Each domain is its own collection (`science`, `code`, `audio-text`, `symbols`, `music`), so one can be re-collected and retrained alone: `collect scifact && extract && train`.

## Rules the pipeline enforces

1. **Licence gate.** `use` in the catalogue decides what a source may do: `train`, `eval` (benchmarks only), `reference` (pointer), `none` (not ingested). No-Derivatives data is never trained on. Sources whose licence could not be verified are `none`.
2. **Licence propagation.** A checkpoint built from non-commercial or share-alike data is marked so in `registry.json`.
3. **Understanding is not approval.** Harm described in a defensive/educational frame stays as knowledge; instructions to harm are `train-negative-only`; unsupported claims are `quarantine`d. Code is scanned the same way. These are hand-written, inspectable rules, **not** a learned safety model.
4. **Facts need support.** In KL an `ASSUME`/`HYP` never becomes a premise; absence of proof is `UNKNOWN`, never `false` (only an explicit `NOT` refutes); unmet `COND`itions are reported; every conclusion has a proof that is re-checked independently.
5. **Held-out discipline.** Parameters are tuned on SciFact *train* claims and ESC-50 folds 1-4; reported on dev / fold 5.
6. **Never replace a working model with an unverified one.** A new version is saved as a candidate; it becomes current only if the primary metric improves by the margin and no guard metric regresses. Old versions are kept; `rollback` restores one.
7. **Reproducibility.** Each version records params, input sources and licences, code hash, node version, git commit, artifact SHA-256.

## Relationship to the rest of .my-ai

- The OneBrain engine reads raw bytes and the repo forbids a tokenizer; this pipeline never feeds it one. `text.mjs` offers the byte view and a word view used only by BM25.
- `train.md` says reasoning habits should be *learned*, not forced as fixed stages. KL is therefore a **target and verifier** (a way to write down, check and prove knowledge, and to generate training pairs), not a mandatory step inside `reason()`.
- **Not yet wired into the Kotlin/TypeScript runtime.** Nothing here changes `OneBrainEngine`, `model.json` or the app. Integration points that exist: `processed/kb/*.kb` and `processed/collections/*.jsonl` can be turned into NeuroLang `@input/@response` pairs or an extension corpus.
- Existing material (`train.md`, `training_data/open_corpus`, `training/simulation`) is untouched.

See `RESULTS.md` for measured results, `CITATIONS.md` for every source, licence and the evidence URL.
