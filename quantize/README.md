# quantize

Install-time quantization that **downloads the model from GitHub and picks the technique for the machine it is installed on**.

```
python3 -m quantize hardware                 # what this machine can hold
python3 -m quantize plan  model.npz          # which tier would be chosen, and why
python3 -m quantize pack  model.npz out.nqz  # quantize (--tier auto|fp16|classic8|...)
python3 -m quantize install                  # download from GitHub + choose + quantize
```

`scripts/install.sh` runs `install` as the **Model** step. `NEUROCLAW_SKIP_QUANTIZE=1` skips it, `NEUROCLAW_QUANT_TIER=binary` forces a tier, `NEUROCLAW_MODEL_REPO` / `NEUROCLAW_MODEL_REF` change where the model comes from. The exact model is always kept as `.neuroclaw/model/model.json`; the quantized result goes next to it (`model.nqz`, `model.quantized.json`, `quantization.json`) - "save exact, install quantized".

## The tiers (gentlest to smallest)

| tier | what it does | bits/weight |
|---|---|---|
| `fp16` | nothing | 16 |
| `classic8` / `classic4` / `classic2` | every weight snapped to an integer multiple of a shared step, per group of 64. The step is searched to minimise error (the "closest common factor"). `classic.quantize_decimals` is the "round to N decimal places" variant | 8.25 / 4.25 / 2.25 |
| `binary` | every weight becomes one bit (1 = +, 0 = -) times a per-group scale | 1.1 |
| `littlebit-0.55` / `-0.3` / `-0.1` | below 1 bit: see below | 0.55 / 0.3 / 0.1 |

### LittleBit (the sub-1-bit tier)

`W ~ diag(h) . Ub . diag(l) . Vb^T . diag(g)`

1. **Low rank**: W is replaced by two thin factors (SVD), so far fewer numbers need storing. The rank is solved from the bits-per-weight target.
2. **Binarise**: every entry of the thin factors `Ub`, `Vb` becomes +1/-1 (1 bit).
3. **Scales + residual**: fp16 row (`h`), column (`g`) and latent (`l`) scale vectors rebuild magnitude; they are fitted by alternating least squares. A second binarised **residual path** can fix what the first got wrong. Both options are fitted and the lower-error one kept, because at tiny budgets one deeper path often beats two shallow ones.
4. **LittleBit-2 rotation**: SVD factors are spiky (many values near 0), so sign flips are noisy. One orthogonal rotation `R` is applied to both factors, `(UR)(VR)^T = UV^T`, so the product is unchanged but `R` is chosen by Joint Iterative Quantization so the values sit away from zero before the sign is taken.

Matrices too small for the scales to pay for themselves (the scales alone cost more than the budget) fall back to `binary`. Norm/bias tensors always stay fp16.

## How the tier is chosen

`hardware.py` reads RAM (or NVIDIA free VRAM, or Apple unified memory) with no torch dependency. The memory the model may use is 60% of free RAM (40% on Android), or 85% of free VRAM. `planner.py` computes the exact stored size of the model under every tier (x1.25 runtime overhead) and picks the gentlest tier that fits. If none fits it picks the smallest and says so.

## Measured (1024x1024 low-rank + noise matrix, post-training)

| tier | bits/weight | relative error |
|---|---|---|
| classic8 | 8.25 | 0.006 |
| classic4 | 4.25 | 0.100 |
| classic2 | 2.25 | 0.454 |
| binary | 1.13 | 0.600 |
| littlebit-0.55 | 0.55 | 0.492 |
| littlebit-0.3 | 0.30 | 0.644 |
| littlebit-0.1 | 0.10 | 0.868 |

## Limits - read before trusting it

* **Post-training only.** The LittleBit papers recover accuracy by *training* (QAT / distillation) after this initialisation. This package does the initialisation and closed-form scale fitting but no training, so at 0.3 and 0.1 bits/weight the reconstruction error is large. Use those tiers when memory forces them, and expect a quality drop until training is added.
* Error here is weight-reconstruction error on a synthetic matrix, not model accuracy. It has not been run against a real LLM.
* The bundled OneBrain `model.json` has only 338 weights, so quantizing it saves bytes but is mostly a pipeline demonstration; the Android app does not yet read `.nqz`.
* No fused kernel: packed weights are expanded to float32 to use them.

Tests: `python3 test/quantize/test_quantize.py` (needs numpy).
