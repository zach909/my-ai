from __future__ import annotations
import json, os
import numpy as np
from . import container, engine
from .model_io import load_model
from .planner import plan_model
from .hardware import detect_hardware


def error_report(orig: dict, deq: dict) -> dict:
    num = sum(float(((orig[k] - deq[k]) ** 2).sum()) for k in orig)
    den = sum(float((orig[k] ** 2).sum()) for k in orig) or 1.0
    return {"relative_error": round((num / den) ** 0.5, 5)}


def pack_model(src: str, out_nqz: str, tier: str = "auto", hw=None, expanded_out: str | None = None) -> dict:
    """Quantize `src` for this machine. Returns a report dict."""
    hw = hw or detect_hardware()
    model = load_model(src)
    plan = plan_model(model.shapes(), hw, tier)
    entries, deq = {}, {}
    for name, w in model.tensors.items():
        e = engine.quantize_tensor(name, w, plan.tier)
        entries[name] = e
        deq[name] = engine.dequantize_tensor(e)
    orig_bytes = sum(w.size * 4 for w in model.tensors.values())
    info = {"tier": plan.tier, "reason": plan.reason, "hardware": hw.to_dict(),
            "tiers_used": sorted({e["tier"] for e in entries.values()})}
    container.save(out_nqz, entries, info)
    if expanded_out:
        model.export(expanded_out, deq, {"tier": plan.tier, "tiers_used": info["tiers_used"]})
    size = os.path.getsize(out_nqz)
    payload = sum(a.nbytes for e in entries.values() for a in e["arrays"].values())
    params = sum(w.size for w in model.tensors.values())
    return {**info, "params": params, "fp32_bytes": orig_bytes, "packed_bytes": size, "payload_bytes": payload,
            "bits_per_weight_est": round(sum(engine.est_bits(plan.tier, n, w.shape)
                                             for n, w in model.tensors.items()) / max(params, 1), 3),
            "fits": plan.fits, "plan": plan.table, **error_report(model.tensors, deq)}


def unpack_model(nqz: str) -> dict:
    entries, _ = container.load(nqz)
    return {n: engine.dequantize_tensor(e) for n, e in entries.items()}
