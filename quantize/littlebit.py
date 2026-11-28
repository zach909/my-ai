"""LittleBit: sub-1-bit weights via binarised low-rank factors.

    W (m x n)  ~  diag(h) . Ub . diag(l) . Vb^T . diag(g)

    Ub (m x r), Vb (n x r)   entries +1 / -1       1 bit each
    h (m), g (n), l (r)      fp16 scales           row / column / latent

A second "residual" path of the same form is fitted to what the first path
got wrong, and the two outputs are added.

Initialisation (LittleBit-2): truncated SVD gives U, V with W ~ U V^T. Both
are spiky (many values near 0) so binarising them flips signs at random. We
find ONE orthogonal r x r rotation R and use U R and V R instead; since
(U R)(V R)^T = U V^T the product is unchanged, but R is chosen (Joint
Iterative Quantization) so entries of U R and V R sit close to +-1 scale
before the sign is taken.

This module is *post-training*: scales are fitted in closed form by
alternating least squares. The paper additionally trains (QAT/distillation);
that recovers far more accuracy and is not done here.
"""
from __future__ import annotations
import numpy as np
from .bitpack import pack_signs, unpack_signs

SCALE_BITS = 16
MIN_RANK = 1


def path_bits(m: int, n: int, r: int) -> int:
    return r * (m + n) + SCALE_BITS * (m + n + r)


def rank_for_bpw(m: int, n: int, bpw: float, paths: int = 2) -> int:
    """Largest rank per path so total storage <= bpw * m * n. 0 if infeasible."""
    budget = bpw * m * n / paths
    r = int((budget - SCALE_BITS * (m + n)) // (m + n + SCALE_BITS))
    return max(r, 0)


def est_bits_littlebit(shape, bpw: float, residual: bool | None = None) -> int | None:
    """Upper bound on storage for this matrix over the allowed path counts
    (residual=None: whichever of 1 or 2 paths `quantize_littlebit` may pick).
    Returns None when not even one path fits the budget."""
    if len(shape) != 2:
        return None
    m, n = shape
    opts = (2, 1) if residual is None else ((2,) if residual else (1,))
    sizes = []
    for paths in opts:
        r = rank_for_bpw(m, n, bpw, paths)
        if r >= MIN_RANK:
            sizes.append(paths * path_bits(m, n, r))
    return max(sizes) if sizes else None


def _itq_rotation(Z: np.ndarray, iters: int, rng: np.random.Generator) -> np.ndarray:
    """Orthogonal R minimising ||sign(Z R) - Z R||_F (ITQ / Procrustes)."""
    r = Z.shape[1]
    R, _ = np.linalg.qr(rng.standard_normal((r, r)))
    for _ in range(iters):
        B = np.where(Z @ R >= 0, 1.0, -1.0)
        P, _, Qt = np.linalg.svd(Z.T @ B)
        R = P @ Qt
    return R


def _fit_scales(W, Ub, Vb, h, g, l, iters=6):
    for _ in range(iters):
        # l: linear least squares. M_k = (h*Ub_k)(g*Vb_k)^T, solve sum_k l_k M_k ~ W
        P = Ub * h[:, None]
        Q = Vb * g[:, None]
        A = (P.T @ P) * (Q.T @ Q)
        b = np.einsum("ik,ik->k", P, W @ Q)
        l = np.linalg.solve(A + 1e-8 * np.eye(A.shape[0]) * max(float(np.trace(A)), 1e-12) / A.shape[0], b)
        M = (Ub * l[None, :]) @ Vb.T
        Mg = M * g[None, :]
        h = (W * Mg).sum(1) / np.maximum((Mg ** 2).sum(1), 1e-20)
        Mh = M * h[:, None]
        g = (W * Mh).sum(0) / np.maximum((Mh ** 2).sum(0), 1e-20)
        # Remove the scale ambiguity between h, g, l so fp16 never overflows.
        sh = max(float(np.abs(h).mean()), 1e-12)
        sg = max(float(np.abs(g).mean()), 1e-12)
        h, g, l = h / sh, g / sg, l * sh * sg
    return h, g, l


def _fit_path(W: np.ndarray, r: int, rotate: bool, itq_iters: int, rng) -> dict:
    m, n = W.shape
    r = min(r, m, n)
    U, S, Vt = np.linalg.svd(W, full_matrices=False)
    s = np.sqrt(S[:r])
    Uf, Vf = U[:, :r] * s, Vt[:r].T * s
    if rotate and r > 1:
        R = _itq_rotation(np.vstack([Uf, Vf]), itq_iters, rng)
        Uf, Vf = Uf @ R, Vf @ R
    Ub = np.where(Uf >= 0, 1.0, -1.0).astype(np.float32)
    Vb = np.where(Vf >= 0, 1.0, -1.0).astype(np.float32)
    h = np.abs(Uf).mean(1) + 1e-12
    g = np.abs(Vf).mean(1) + 1e-12
    l = np.ones(r)
    h, g, l = _fit_scales(W.astype(np.float64), Ub.astype(np.float64), Vb.astype(np.float64),
                          h.astype(np.float64), g.astype(np.float64), l)
    return {
        "Ub": pack_signs(Ub), "Vb": pack_signs(Vb),
        "h": h.astype(np.float16), "g": g.astype(np.float16), "l": l.astype(np.float16),
        "rank": r,
    }


def _path_matrix(p: dict, m: int, n: int) -> np.ndarray:
    r = p["rank"]
    Ub = unpack_signs(p["Ub"], (m, r))
    Vb = unpack_signs(p["Vb"], (n, r))
    h, g, l = (p[k].astype(np.float32) for k in ("h", "g", "l"))
    return ((Ub * h[:, None]) * l[None, :]) @ (Vb * g[:, None]).T


def _quantize_once(W, bpw, residual, rotate, itq_iters, seed):
    m, n = W.shape
    paths = 2 if residual else 1
    r = rank_for_bpw(m, n, bpw, paths)
    rng = np.random.default_rng(seed)
    out = {"meta": {"shape": [m, n], "bpw": bpw, "residual": residual, "rotate": rotate}}
    p0 = _fit_path(W, r, rotate, itq_iters, rng)
    out["p0"] = p0
    if residual:
        out["p1"] = _fit_path(W - _path_matrix(p0, m, n), r, rotate, itq_iters, rng)
    return out


def quantize_littlebit(w: np.ndarray, bpw: float, residual="auto",
                       rotate: bool = True, itq_iters: int = 30, seed: int = 0) -> dict:
    """residual: True / False / "auto" (fit both and keep the lower error;
    at very small budgets one deeper path often beats two shallow ones)."""
    if w.ndim != 2:
        raise ValueError("littlebit needs a 2-D matrix")
    m, n = w.shape
    W = w.astype(np.float32)
    can = [res for res in (True, False) if rank_for_bpw(m, n, bpw, 2 if res else 1) >= MIN_RANK]
    if residual != "auto":
        can = [c for c in can if c == residual]
    if not can:
        raise ValueError(f"{m}x{n} is too small for {bpw} bits/weight (scales alone cost more)")
    best = None
    for res in can:
        cand = _quantize_once(W, bpw, res, rotate, itq_iters, seed)
        err = float(np.linalg.norm(W - dequantize_littlebit(cand)))
        if best is None or err < best[0]:
            best = (err, cand)
    return best[1]


def dequantize_littlebit(p: dict) -> np.ndarray:
    m, n = p["meta"]["shape"]
    out = _path_matrix(p["p0"], m, n)
    if "p1" in p:
        out = out + _path_matrix(p["p1"], m, n)
    return out
