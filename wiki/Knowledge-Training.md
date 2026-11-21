# Knowledge Training

A staged, evaluated training pipeline for 41 open data sources. Code: `training/knowledge/` (see its `README.md`). Tests: `test/training/knowledge.test.mjs`. Results: `training/knowledge/RESULTS.md`. Citations: `training/knowledge/CITATIONS.md`.

- **Sources** are investigated one by one (licence, bulk access, size, format, limits, evidence URL). Only sources whose licence allows it are trained on; non-commercial and share-alike terms follow the checkpoint.
- **Good vs bad knowledge** is a set of inspectable rules: understanding harm in a defensive frame is allowed, instructions to harm are only ever negative examples, unsupported claims are quarantined.
- **Reasoning language (KL):** `FACT`, `RULE`, `COND`, `NOT`, `FUNC`, `EXCL`, `ASSUME`. Absence of proof is "unknown", assumptions are never premises, every conclusion has a re-checkable proof.
- **Research:** BM25 retrieval, claim verification and source comparison; answers quote retrieved sentences with citations.
- **Audio:** recognise, classify and interpret are separate.
- **Improvement:** each component is versioned; a candidate replaces the current model only if it improves the primary metric and no guard metric regresses. Old versions are kept.

Related: [[Task-Training]], [[Self-Improvement]].
