"""Per-tensor dispatch: one tier name in, packed arrays out (and back)."""
from __future__ import annotations
import re
import numpy as np
from . import classic, binary, littlebit

# Name -> (kind, parameter). Ordered gentlest -> smallest.
TIER_SPECS = {
    "fp16": ("fp16", None),
    "classic8": ("classic", 8),
    "classic4": ("classic", 4),
    "classic2": ("classic", 2),
    "binary": ("binary", None),
    "littlebit-0.55": ("littlebit", 0.55),
    "littlebit-0.3": ("littlebit", 0.3),
    "littlebit-0.1": ("littlebit", 0.1),
}
# Tiny, precision-critical tensors (norm scales, biases) stay fp16 in every tier.
KEEP_FP16 = re.compile(r"(norm|bias|\bln_|layernorm)", re.I)


def resolve_tier(tier: str, name: str, shape) -> str:
    """The tier actually used for this tensor (handles fallbacks)."""
    if tier not in TIER_SPECS:
        raise ValueError(f"unknown tier {tier!r}")
    kind, param = TIER_SPECS[tier]
    if kind == "fp16" or KEEP_FP16.search(name):
        return "fp16"
    if kind == "littlebit":
        if littlebit.est_bits_littlebit(tuple(shape), param) is None:
            return "binary"  # matrix too small/thin: scales alone would cost more
    return tier


def est_bits(tier: str, name: str, shape) -> int:
    t = resolve_tier(tier, name, shape)
    kind, param = TIER_SPECS[t]
    n = int(np.prod(shape))
    if kind == "fp16":
        return n * 16
    if kind == "classic":
        return classic.est_bits_classic(shape, param)
    if kind == "binary":
        return binary.est_bits_binary(shape)
    return littlebit.est_bits_littlebit(tuple(shape), param)


def quantize_tensor(name: str, w: np.ndarray, tier: str) -> dict:
    """Returns {'tier': used_tier, 'arrays': {...}, 'meta': {...}}."""
    w = np.asarray(w, dtype=np.float32)
    used = resolve_tier(tier, name, w.shape)
    kind, param = TIER_SPECS[used]
    if kind == "fp16":
        return {"tier": used, "arrays": {"w": w.astype(np.float16)}, "meta": {"shape": list(w.shape)}}
    if kind == "classic":
        p = classic.quantize_bits(w, param)
    elif kind == "binary":
        p = binary.quantize_binary(w)
    else:
        p = littlebit.quantize_littlebit(w, param)
    return _flatten(used, p)


def dequantize_tensor(entry: dict) -> np.ndarray:
    kind, _ = TIER_SPECS[entry["tier"]]
    if kind == "fp16":
        return entry["arrays"]["w"].astype(np.float32)
    p = _unflatten(entry)
    if kind == "classic":
        return classic.dequantize_bits(p)
    if kind == "binary":
        return binary.dequantize_binary(p)
    return littlebit.dequantize_littlebit(p)


def _flatten(tier, p):
    arrays, meta = {}, {}
    for k, v in p.items():
        if k == "meta":
            meta.update(v)
        elif isinstance(v, dict):  # littlebit paths
            for kk, vv in v.items():
                if isinstance(vv, np.ndarray):
                    arrays[f"{k}.{kk}"] = vv
                else:
                    meta[f"{k}.{kk}"] = vv
        else:
            arrays[k] = v
    return {"tier": tier, "arrays": arrays, "meta": meta}


def _unflatten(entry):
    p = {"meta": dict(entry["meta"])}
    for k, v in entry["arrays"].items():
        if "." in k:
            a, b = k.split(".", 1)
            p.setdefault(a, {})[b] = v
        else:
            p[k] = v
    for k, v in entry["meta"].items():
        if "." in k:
            a, b = k.split(".", 1)
            p.setdefault(a, {})[b] = v
    return p
