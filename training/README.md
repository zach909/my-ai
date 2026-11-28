# training/

Everything that is only for training lives here, apart from the product code.

| Folder | What it is |
|---|---|
| [`knowledge/`](knowledge/README.md) | The knowledge and training pipeline for the 41 catalogued data sources: licence-gated collection, cleaning, good/bad-knowledge rules, a compact reasoning language, BM25 retrieval and claim checking, audio recognition, versioned checkpoints with a promotion gate. |
| [`echo/`](echo/README.md) | The echo step: before each stage's real work (music, art, animals, speech, text, chips, code, simulation, research, NeuroLang) the model must repeat what it is shown, exactly; then it learns each stage's rules by predicting what comes next, with a randomizer that can visit every rule-legal tune once. |
| [`repair/`](repair/README.md) | A repair agent that tries a fix, runs it against the checks and keeps only what passes; leaves working code alone. It generalises by search and verification, not by remembering (the character-level trainer only memorised: 0 of 50 on unseen families). Sealed fresh-family tests report the honest number. |
| [`tasks/`](tasks/README.md) | Train on tasks, not prediction: audio (note, whole tune) and video (hue, direction, speed, and a caption for every frame). **Live captions are part of every video**, generated from the truth and causal (frame t uses frames 0..t only). Scored exact-match on key/mode and hue/direction combinations never trained on. |
| [`simulation/`](simulation/README.md) | A Minecraft-like physical world where AIs live together. Harm to another AI is punished, kindness is never punished, and the AIs build a society (farms, walls, courts, jail). Written from scratch with Node built-ins. |
| [`physics/`](physics/README.md) | A blank flat plane with gravity and friction, and a four-legged creature that learns to walk to goal markers and turn. Plain physics, no rules about people. Its own solver, neural network and evolution-strategies learner; Node built-ins only. |
| [`lab/`](lab/README.md) | A virtual laboratory where an AI investigates a world it cannot see into: five benches with hidden constants, noisy readings, a budget and a clock, datasheet safety ratings that break equipment if ignored, and a score for recovering the constants and predicting new cases. Scripted baselines included. Node built-ins only. |

Run it:

```bash
npm run train:sim -- --agents 10 --ticks 6000 --map
npm run train:lab                   # the virtual laboratory: every scripted agent on one lab
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
