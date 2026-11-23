"""1-bit quantization: every weight becomes a bit (1 = +, 0 = -) times a scale.

The scale per group is mean(|w|), the least-squares optimal value for sign
quantization.
"""
from __future__ import annotations
import numpy as np
from .bitpack import pack_signs, unpack_signs

GROUP = 128


def quantize_binary(w: np.ndarray, group: int = GROUP) -> dict:
    flat = w.reshape(-1).astype(np.float32)
    pad = (-flat.size) % group
    if pad:
        flat = np.concatenate([flat, np.zeros(pad, np.float32)])
    g = flat.reshape(-1, group)
    return {
        "bits": pack_signs(g),
        "scale": np.abs(g).mean(axis=1).astype(np.float16),
        "meta": {"group": group, "shape": list(w.shape), "pad": pad},
    }


def dequantize_binary(p: dict) -> np.ndarray:
    m = p["meta"]
    n = int(np.prod(m["shape"])) + m["pad"]
    s = unpack_signs(p["bits"], (n // m["group"], m["group"]))
    out = s * p["scale"].astype(np.float32)[:, None]
    return out.reshape(-1)[: int(np.prod(m["shape"]))].reshape(m["shape"])


def est_bits_binary(shape, group: int = GROUP) -> int:
    n = int(np.prod(shape))
    return n + ((n + group - 1) // group) * 16
