"""Bit packing helpers (numpy only)."""
from __future__ import annotations
import numpy as np


def pack_uint(vals: np.ndarray, bits: int) -> np.ndarray:
    """Pack non-negative integers < 2**bits into a dense uint8 byte stream."""
    v = np.asarray(vals).reshape(-1).astype(np.uint32)
    if v.size and int(v.max()) >= (1 << bits):
        raise ValueError(f"value does not fit in {bits} bits")
    shifts = np.arange(bits, dtype=np.uint32)
    bitmat = ((v[:, None] >> shifts) & 1).astype(np.uint8)
    return np.packbits(bitmat.reshape(-1), bitorder="little")


def unpack_uint(packed: np.ndarray, bits: int, count: int) -> np.ndarray:
    flat = np.unpackbits(packed, bitorder="little")[: count * bits]
    bitmat = flat.reshape(count, bits).astype(np.uint32)
    return (bitmat << np.arange(bits, dtype=np.uint32)).sum(axis=1)


def pack_signs(x: np.ndarray) -> np.ndarray:
    """1 bit per entry: 1 for >= 0 (+1), 0 for < 0 (-1)."""
    return np.packbits((np.asarray(x).reshape(-1) >= 0).astype(np.uint8), bitorder="little")


def unpack_signs(packed: np.ndarray, shape: tuple) -> np.ndarray:
    n = int(np.prod(shape))
    bits = np.unpackbits(packed, bitorder="little")[:n]
    return (bits.astype(np.float32) * 2.0 - 1.0).reshape(shape)
