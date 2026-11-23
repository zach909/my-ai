# training/

Everything that is only for training lives here, apart from the product code.

| Folder | What it is |
|---|---|
| [`knowledge/`](knowledge/README.md) | The knowledge and training pipeline for the 41 catalogued data sources: licence-gated collection, cleaning, good/bad-knowledge rules, a compact reasoning language, BM25 retrieval and claim checking, audio recognition, versioned checkpoints with a promotion gate. |
| [`simulation/`](simulation/README.md) | A Minecraft-like physical world where AIs live together. Harm to another AI is punished, kindness is never punished, and the AIs build a society (farms, walls, courts, jail). Written from scratch with Node built-ins. |

Run it:

```bash
npm run train:sim -- --agents 10 --ticks 6000 --map
```

Test it:

```bash
npm run test:training
node --test test/training/knowledge.test.mjs   # knowledge pipeline
```

Same rules as the rest of the repo (see `AGENTS.md`): no third-party code, no packages, no tokenizer.
Existing training material stays where it is: `train.md`, `docs/TRAINING_CURRICULUM.md`,
`docs/TRAINING_FOCUS.md`, `training_data/`.
