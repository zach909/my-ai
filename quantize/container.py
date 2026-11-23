"""On-disk format (.nqz): a numpy .npz holding every packed array plus JSON metadata."""
from __future__ import annotations
import json
import numpy as np

FORMAT = "neuroclaw-quantized-v1"


def save(path: str, entries: dict, info: dict) -> None:
    arrays, index = {}, {}
    for name, e in entries.items():
        index[name] = {"tier": e["tier"], "meta": e["meta"], "fields": list(e["arrays"])}
        for f, a in e["arrays"].items():
            arrays[f"{name}::{f}"] = a
    meta = {"format": FORMAT, "info": info, "tensors": index}
    arrays["__meta__"] = np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8)
    with open(path, "wb") as fh:
        np.savez(fh, **arrays)


def load(path: str):
    with np.load(path, allow_pickle=False) as z:
        meta = json.loads(bytes(z["__meta__"]).decode())
        if meta.get("format") != FORMAT:
            raise ValueError("not a NeuroClaw quantized file")
        entries = {}
        for name, t in meta["tensors"].items():
            entries[name] = {"tier": t["tier"], "meta": t["meta"],
                             "arrays": {f: z[f"{name}::{f}"] for f in t["fields"]}}
    return entries, meta["info"]
