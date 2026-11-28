"""Classic quantization: snap weights to multiples of a shared step.

Two ways to choose the step ("the closest common factor"):

* bits mode: per group of weights, search the step that minimises the squared
  error for the given bit width, so every weight in the group becomes
  `integer * step`.
* decimals mode: one global step of 10**-decimals ("round to N decimal
  places"); the integer width needed is whatever the data requires.
"""
from __future__ import annotations
import numpy as np
from .bitpack import pack_uint, unpack_uint

GROUP = 64


def _groups(w: np.ndarray, group: int):
    flat = w.reshape(-1).astype(np.float32)
    pad = (-flat.size) % group
    if pad:
        flat = np.concatenate([flat, np.zeros(pad, np.float32)])
    return flat.reshape(-1, group), pad


def quantize_bits(w: np.ndarray, bits: int, group: int = GROUP) -> dict:
    if not 2 <= bits <= 8:
        raise ValueError("classic bits must be in 2..8")
    g, pad = _groups(w, group)
    qmax = (1 << (bits - 1)) - 1
    amax = np.abs(g).max(axis=1, keepdims=True)
    amax[amax == 0] = 1.0
    best_step = amax / qmax
    best_err = np.full((g.shape[0], 1), np.inf, np.float32)
    # Search clip factors: a slightly smaller step clips outliers but rounds
    # the bulk more finely, which often lowers total error at low bit widths.
    for f in np.linspace(0.55, 1.0, 19):
        step = amax * f / qmax
        q = np.clip(np.round(g / step), -qmax, qmax)
        err = ((q * step - g) ** 2).sum(axis=1, keepdims=True)
        better = err < best_err
        best_err = np.where(better, err, best_err)
        best_step = np.where(better, step, best_step)
    q = np.clip(np.round(g / best_step), -qmax, qmax).astype(np.int32) + qmax
    return {
        "q": pack_uint(q, bits),
        "step": best_step.astype(np.float16).reshape(-1),
        "meta": {"bits": bits, "group": group, "shape": list(w.shape), "pad": pad},
    }


def dequantize_bits(p: dict) -> np.ndarray:
    m = p["meta"]
    bits, group = m["bits"], m["group"]
    n = int(np.prod(m["shape"])) + m["pad"]
    qmax = (1 << (bits - 1)) - 1
    q = unpack_uint(p["q"], bits, n).astype(np.int32) - qmax
    out = q.reshape(-1, group).astype(np.float32) * p["step"].astype(np.float32)[:, None]
    return out.reshape(-1)[: int(np.prod(m["shape"]))].reshape(m["shape"])


def quantize_decimals(w: np.ndarray, decimals: int) -> dict:
    step = 10.0 ** (-decimals)
    q = np.round(w.astype(np.float64) / step).astype(np.int64)
    lo = int(q.min()) if q.size else 0
    span = int(q.max()) - lo if q.size else 0
    bits = max(1, int(span).bit_length())
    return {
        "q": pack_uint(q - lo, bits),
        "meta": {"decimals": decimals, "bits": bits, "offset": lo, "shape": list(w.shape)},
    }


def dequantize_decimals(p: dict) -> np.ndarray:
    m = p["meta"]
    n = int(np.prod(m["shape"]))
    q = unpack_uint(p["q"], m["bits"], n).astype(np.int64) + m["offset"]
    return (q * 10.0 ** (-m["decimals"])).astype(np.float32).reshape(m["shape"])


def est_bits_classic(shape, bits: int, group: int = GROUP) -> int:
    n = int(np.prod(shape))
    return n * bits + ((n + group - 1) // group) * 16
