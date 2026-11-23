"""NeuroClaw quantization: classic -> binary -> LittleBit, chosen per machine.

Tiers, from highest quality / biggest to lowest quality / smallest:

  fp16        no quantization
  classic8/4/2  every weight snapped to a multiple of a shared step (group-wise)
  binary      every weight becomes one bit (0/1 = -/+) times a group scale
  littlebit   low-rank factorisation, factors binarised, tiny fp16 scales,
              optional residual path, SVD + orthogonal rotation (LittleBit-2)
              at 0.55 / 0.3 / 0.1 bits per weight

`planner.choose_tier` picks the gentlest tier that fits this machine.
"""
from .planner import TIERS, choose_tier, plan_model  # noqa: F401
from .hardware import detect_hardware  # noqa: F401
from .engine import quantize_tensor, dequantize_tensor  # noqa: F401

__version__ = "0.1.0"
