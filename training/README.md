# training/

Everything that is only for training lives here, apart from the product code.

| Folder | What it is |
|---|---|
| [`knowledge/`](knowledge/README.md) | The knowledge and training pipeline for the 41 catalogued data sources: licence-gated collection, cleaning, good/bad-knowledge rules, a compact reasoning language, BM25 retrieval and claim checking, audio recognition, versioned checkpoints with a promotion gate. |
| [`echo/`](echo/README.md) | The echo step: before each stage's real work (music, art, animals, speech, text, chips, code, simulation, research, NeuroLang) the model must repeat what it is shown, exactly; then it learns each stage's rules by predicting what comes next, with a randomizer that can visit every rule-legal tune once. |
| [`repair/`](repair/README.md) | A repair agent that tries a fix, runs it against the checks and keeps only what passes; leaves working code alone. It generalises by search and verification, not by remembering (the character-level trainer only memorised: 0 of 50 on unseen families). Sealed fresh-family tests report the honest number. |
| [`simulation/`](simulation/README.md) | A Minecraft-like physical world where AIs live together. Harm to another AI is punished, kindness is never punished, and the AIs build a society (farms, walls, courts, jail). Written from scratch with Node built-ins. |

Run it:

```bash
npm run train:sim -- --agents 10 --ticks 6000 --map
npm run train:echo -- plan          # every echo stage and how many legal tunes it has
```

Test it:

```bash
npm run test:training
node --test test/training/knowledge.test.mjs   # knowledge pipeline
```

Same rules as the rest of the repo (see `AGENTS.md`): no third-party code, no packages, no tokenizer.
Existing training material stays where it is: `train.md`, `docs/TRAINING_CURRICULUM.md`,
`docs/TRAINING_FOCUS.md`, `training_data/`.
