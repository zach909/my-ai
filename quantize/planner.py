"""Pick the gentlest tier whose model fits this machine."""
from __future__ import annotations
from dataclasses import dataclass
from .engine import TIER_SPECS, est_bits, resolve_tier
from .hardware import Hardware, detect_hardware

TIERS = list(TIER_SPECS)          # gentlest -> smallest
RUNTIME_OVERHEAD = 1.25           # activations, caches, app: model must fit in budget/1.25


@dataclass
class Plan:
    tier: str
    model_mb: float
    budget_mb: float
    fits: bool
    table: list                    # (tier, est_mb, fits)
    reason: str


def model_bytes(tier: str, shapes: dict) -> int:
    return sum(est_bits(tier, n, s) for n, s in shapes.items()) // 8


def plan_model(shapes: dict, hw: Hardware | None = None, forced: str | None = None) -> Plan:
    hw = hw or detect_hardware()
    budget = hw.usable_mb()
    table = []
    for t in TIERS:
        mb = model_bytes(t, shapes) * RUNTIME_OVERHEAD / (1024 * 1024)
        table.append((t, round(mb, 3), mb <= budget))
    if forced and forced != "auto":
        if forced not in TIERS:
            raise ValueError(f"unknown tier {forced!r}; choose from {TIERS} or 'auto'")
        mb, fits = next((m, f) for t, m, f in table if t == forced)
        return Plan(forced, mb, budget, fits, table, "forced by user" + ("" if fits else " (does NOT fit this machine)"))
    for t, mb, fits in table:
        if fits:
            why = "fits unquantized" if t == "fp16" else f"gentlest tier that fits {budget} MB"
            return Plan(t, mb, budget, True, table, why)
    t, mb, _ = table[-1]
    return Plan(t, mb, budget, False, table, f"even the smallest tier ({mb} MB) exceeds {budget} MB")


def choose_tier(shapes: dict, hw: Hardware | None = None) -> str:
    return plan_model(shapes, hw).tier
