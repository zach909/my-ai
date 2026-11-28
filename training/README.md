# training/

Everything that is only for training lives here, apart from the product code.

| Folder | What it is |
|---|---|
| [`knowledge/`](knowledge/README.md) | The knowledge and training pipeline for the 41 catalogued data sources: licence-gated collection, cleaning, good/bad-knowledge rules, a compact reasoning language, BM25 retrieval and claim checking, audio recognition, versioned checkpoints with a promotion gate. |
| [`echo/`](echo/README.md) | The echo step: before each stage's real work (music, art, animals, speech, text, chips, code, simulation, research, NeuroLang) the model must repeat what it is shown, exactly; then it learns each stage's rules by predicting what comes next, with a randomizer that can visit every rule-legal tune once. |
| [`simulation/`](simulation/README.md) | A Minecraft-like physical world where AIs live together. Harm to another AI is punished, kindness is never punished, and the AIs build a society (farms, walls, courts, jail). Written from scratch with Node built-ins. |
| [`physics/`](physics/README.md) | A blank flat plane with gravity and friction, and a four-legged creature that learns to walk to goal markers and turn. Plain physics, no rules about people. Its own solver, neural network and evolution-strategies learner; Node built-ins only. |

Run it:

```bash
npm run train:sim -- --agents 10 --ticks 6000 --map
npm run train:echo -- plan          # every echo stage and how many legal tunes it has
npm run train:walk                  # teach the creature to walk (about 8 minutes), then: npm run play:walk
```

Test it:

```bash
npm run test:training
node --test test/training/knowledge.test.mjs   # knowledge pipeline
```

Same rules as the rest of the repo (see `AGENTS.md`): no third-party code, no packages, no tokenizer.
Existing training material stays where it is: `train.md`, `docs/TRAINING_CURRICULUM.md`,
`docs/TRAINING_FOCUS.md`, `training_data/`.
