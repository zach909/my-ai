"""Read model weights from the formats we meet: .npz, .npy, .safetensors,
and the OneBrain model.json (flat `weights` array)."""
from __future__ import annotations
import json, os, struct
import numpy as np


def _bf16(raw: bytes) -> np.ndarray:
    u = np.frombuffer(raw, dtype=np.uint16).astype(np.uint32) << 16
    return u.view(np.float32)


def _safetensors(path):
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(n))
        base = 8 + n
        out = {}
        for name, h in header.items():
            if name == "__metadata__":
                continue
            s, e = h["data_offsets"]
            f.seek(base + s)
            raw = f.read(e - s)
            dt = h["dtype"]
            if dt == "BF16":
                a = _bf16(raw)
            elif dt in ("F32", "F16", "F64"):
                a = np.frombuffer(raw, dtype={"F32": "<f4", "F16": "<f2", "F64": "<f8"}[dt]).astype(np.float32)
            else:
                continue  # integer tensors are not weights we can quantize
            out[name] = a.reshape(h["shape"])
        return out


class LoadedModel:
    def __init__(self, kind, tensors, raw=None):
        self.kind, self.tensors, self.raw = kind, tensors, raw

    def shapes(self):
        return {k: v.shape for k, v in self.tensors.items()}

    def export(self, path: str, tensors: dict, info: dict) -> None:
        """Write quantized-then-expanded weights back in the original format."""
        if self.kind == "onebrain-json":
            d = dict(self.raw)
            d["weights"] = [float(x) for x in tensors["weights"].reshape(-1)]
            d["savedWithQuantization"] = True
            d["quantization"] = info
            with open(path, "w") as f:
                json.dump(d, f, separators=(",", ":"))
        elif path.endswith(".npy"):
            np.save(path, next(iter(tensors.values())))
        else:
            np.savez(path if path.endswith(".npz") else path + ".npz", **tensors)


def load_model(path: str) -> LoadedModel:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".npz":
        with np.load(path, allow_pickle=False) as z:
            return LoadedModel("npz", {k: z[k].astype(np.float32) for k in z.files})
    if ext == ".npy":
        return LoadedModel("npy", {"array": np.load(path, allow_pickle=False).astype(np.float32)})
    if ext == ".safetensors":
        return LoadedModel("safetensors", _safetensors(path))
    if ext == ".json":
        with open(path) as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("weights"), list):
            return LoadedModel("onebrain-json", {"weights": np.asarray(d["weights"], dtype=np.float32)}, d)
        raise ValueError("JSON model has no flat `weights` array")
    raise ValueError(f"unsupported model format {ext!r} (use .npz .npy .safetensors or OneBrain .json)")
