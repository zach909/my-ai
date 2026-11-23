"""python3 -m quantize <command>

  hardware                       show what this machine can hold
  plan MODEL [--tier T]          show which tier would be chosen
  pack MODEL OUT.nqz [--tier T]  quantize a model file
  unpack IN.nqz OUT.npz          expand back to float32 arrays
  install [--url U | --file F] [--out-dir D] [--tier T]
                                 download the model from GitHub, pick the
                                 tier for this hardware, write the result
"""
from __future__ import annotations
import argparse, json, os, shutil, sys
import numpy as np
from . import fetch, pipeline
from .hardware import detect_hardware
from .model_io import load_model
from .planner import plan_model, TIERS


def _print_plan(plan, hw):
    print(f"memory budget: {plan.budget_mb} MB  ({'GPU VRAM' if hw.gpu_vram_mb and not hw.unified_memory else 'RAM'})")
    for t, mb, fits in plan.table:
        mark = "<-- chosen" if t == plan.tier else ""
        print(f"  {t:15s} {mb:12.3f} MB  {'fits' if fits else 'too big':7s} {mark}")
    print(f"=> {plan.tier}: {plan.reason}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="quantize")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hardware")
    for name in ("plan", "pack"):
        p = sub.add_parser(name)
        p.add_argument("model")
        if name == "pack":
            p.add_argument("out")
            p.add_argument("--expanded", help="also write the dequantized model here")
        p.add_argument("--tier", default="auto", choices=["auto"] + TIERS)
    u = sub.add_parser("unpack"); u.add_argument("src"); u.add_argument("out")
    i = sub.add_parser("install")
    i.add_argument("--url", default=None)
    i.add_argument("--file", default=None, help="use a local file instead of downloading")
    i.add_argument("--out-dir", default=os.path.join(".neuroclaw", "model"))
    i.add_argument("--tier", default="auto", choices=["auto"] + TIERS)
    a = ap.parse_args(argv)

    hw = detect_hardware()
    if a.cmd == "hardware":
        print(json.dumps(hw.to_dict(), indent=2))
        return 0
    if a.cmd == "plan":
        _print_plan(plan_model(load_model(a.model).shapes(), hw, a.tier), hw)
        return 0
    if a.cmd == "pack":
        r = pipeline.pack_model(a.model, a.out, a.tier, hw, a.expanded)
        print(json.dumps({k: v for k, v in r.items() if k not in ("hardware", "plan")}, indent=2))
        return 0
    if a.cmd == "unpack":
        np.savez(a.out, **pipeline.unpack_model(a.src))
        return 0

    # install
    os.makedirs(a.out_dir, exist_ok=True)
    exact = os.path.join(a.out_dir, "model.json")
    if a.file:
        shutil.copyfile(a.file, exact)
        print(f"using local model {a.file}")
    else:
        url = a.url or fetch.default_url()
        print(f"downloading model from {url}")
        try:
            fetch.download(url, exact)
        except Exception as e:  # noqa: BLE001
            print(f"download failed: {e}", file=sys.stderr)
            return 1
    r = pipeline.pack_model(exact, os.path.join(a.out_dir, "model.nqz"), a.tier, hw,
                            os.path.join(a.out_dir, "model.quantized.json"))
    with open(os.path.join(a.out_dir, "quantization.json"), "w") as f:
        json.dump(r, f, indent=2)
    print(f"hardware: {hw.cores} cores, {hw.ram_available_mb} MB free RAM"
          + (f", GPU {hw.gpu_name} {hw.gpu_vram_mb} MB" if hw.gpu_name else ", no GPU"))
    print(f"chosen tier: {r['tier']}  ({r['reason']})")
    print(f"{r['params']} weights: {r['fp32_bytes']} B fp32 -> {r['payload_bytes']} B of packed data "
          f"({r['packed_bytes']} B file incl. container), "
          f"relative error {r['relative_error']}")
    if not r["fits"]:
        print("warning: this model does not fit this machine even at the smallest tier", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
