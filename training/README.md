# training/

Everything that is only for training lives here, apart from the product code.

| Folder | What it is |
|---|---|
| [`simulation/`](simulation/README.md) | A Minecraft-like physical world where AIs live together. Harm to another AI is punished, kindness is never punished, and the AIs build a society (farms, walls, courts, jail). Written from scratch with Node built-ins. |

Run it:

```bash
npm run train:sim -- --agents 10 --ticks 6000 --map
```

Test it:

```bash
npm run test:training
```

Same rules as the rest of the repo (see `AGENTS.md`): no third-party code, no packages, no tokenizer.
Existing training material stays where it is: `train.md`, `docs/TRAINING_CURRICULUM.md`,
`docs/TRAINING_FOCUS.md`, `training_data/`.
