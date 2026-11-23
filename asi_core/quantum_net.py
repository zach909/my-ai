"""
Quantum Neural Network (QNN) backend: an optional, switchable replacement for
the classical neuron activation in ``neural_core``.

Pure standard library. The "quantum hardware" is an exact state-vector
simulator written here (complex numbers in a list, 2**n amplitudes for n
qubits). Nothing is imported from outside the Python standard library.

What replaces what
------------------
classical neuron / scalar weight / matmul  ->  qubit / rotation gate angle / unitary

Pipeline (one forward pass of a ``QuantumBlock``)
-------------------------------------------------
1. State preparation: inputs become rotation angles (``angle`` / ``reupload``)
   or the amplitudes of the state itself (``amplitude``).
2. Unitary evolution: layers of trainable RY/RZ rotations followed by a ring of
   two-qubit gates (CZ by default, CNOT optional). Rotation angles are the
   learnable weights; the ring entangles. CZ is the default because it leaves
   Z-basis probabilities alone: at identity init each neuron reads out
   (1 + sin x) / 2, a sigmoid-like baseline. A CNOT ring XORs each qubit with
   its neighbour, which pins quiet circuits at 0.5 and masks single inputs.
3. Interference: amplitudes add as complex numbers, so paths reinforce or
   cancel. Nothing is added by hand, it falls out of the unitary maths.
4. Measurement: either the exact Born-rule probabilities (``shots=0``) or
   ``shots`` sampled bitstrings, which is what real hardware gives you.

Training: the parameter-shift rule, ``df/dtheta = (f(theta+pi/2) - f(theta-pi/2)) / 2``.
No intermediate state is stored or copied.

The four hard physical limits, and what this module does about each
--------------------------------------------------------------------
* Linearity. Quantum evolution is linear. The non-linearity here comes from
  (a) encoding: a value ``x`` enters as ``cos(x)``/``sin(x)`` of a rotation,
  (b) data re-uploading: the input is re-encoded every layer, and
  (c) measurement: expectation values are quadratic in the amplitudes.
  There is no ReLU. ``encoding="reupload"`` is the strongest.
* No-cloning. Unknown states cannot be copied, so activations are never cached
  for backprop. Gradients use parameter-shift, which re-runs the circuit.
* Barren plateaus. ``barren_plateau_probe`` measures gradient variance against
  width. Defaults that help: near-identity init (``init_scale`` small), shallow
  depth, local readout (one qubit's Z, not a global parity).
* Decoherence. ``noise`` is a per-qubit depolarising probability applied after
  every gate layer, averaged over ``trajectories`` runs. Raise it to see how
  quickly depth stops paying off.

Cost warning: simulating n qubits costs O(2**n) per gate, so ``max_qubits``
defaults to 6 and wider layers are split into independent blocks. A real QPU
is not subject to that cost; this simulator is.
"""

import math
import random
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Sequence, Tuple

__all__ = [
    "QuantumConfig",
    "QuantumBlock",
    "QuantumLayer",
    "amplitude_encode",
    "barren_plateau_probe",
    "limits",
]

ENCODINGS = ("angle", "reupload", "amplitude")
ENTANGLERS = ("cz", "cnot")


# --------------------------------------------------------------------------
# State-vector simulator
# --------------------------------------------------------------------------

def _zero_state(n: int) -> List[complex]:
    state = [0j] * (1 << n)
    state[0] = 1 + 0j
    return state


def _apply_1q(state: List[complex], n: int, q: int, m: Tuple[complex, complex, complex, complex]) -> None:
    """Apply a 2x2 unitary ``m = (a, b, c, d)`` to qubit ``q`` in place."""
    a, b, c, d = m
    bit = 1 << q
    for i in range(1 << n):
        if not i & bit:
            j = i | bit
            lo, hi = state[i], state[j]
            state[i] = a * lo + b * hi
            state[j] = c * lo + d * hi


def _apply_cnot(state: List[complex], n: int, control: int, target: int) -> None:
    cbit, tbit = 1 << control, 1 << target
    for i in range(1 << n):
        if i & cbit and not i & tbit:
            j = i | tbit
            state[i], state[j] = state[j], state[i]


def _apply_cz(state: List[complex], n: int, a: int, b: int) -> None:
    """Controlled-Z: flips the sign of amplitudes where both qubits are 1."""
    mask = (1 << a) | (1 << b)
    for i in range(1 << n):
        if i & mask == mask:
            state[i] = -state[i]


def _rx(t: float) -> Tuple[complex, complex, complex, complex]:
    c, s = math.cos(t / 2), math.sin(t / 2)
    return (c, -1j * s, -1j * s, c)


def _ry(t: float) -> Tuple[complex, complex, complex, complex]:
    c, s = math.cos(t / 2), math.sin(t / 2)
    return (c, -s, s, c)


def _rz(t: float) -> Tuple[complex, complex, complex, complex]:
    return (complex(math.cos(t / 2), -math.sin(t / 2)), 0j, 0j, complex(math.cos(t / 2), math.sin(t / 2)))


_PAULI_X = (0j, 1 + 0j, 1 + 0j, 0j)
_PAULI_Y = (0j, -1j, 1j, 0j)
_PAULI_Z = (1 + 0j, 0j, 0j, -1 + 0j)


def amplitude_encode(x: Sequence[float], n: int) -> List[complex]:
    """Load ``x`` as the amplitudes of an n-qubit state (zero-padded, L2-normalised).

    A simulator can do this for free. On real hardware it costs a deep circuit,
    which is why ``angle`` and ``reupload`` are the defaults.
    """
    dim = 1 << n
    if len(x) > dim:
        raise ValueError(f"{len(x)} values do not fit in {n} qubits (max {dim})")
    norm = math.sqrt(sum(v * v for v in x))
    if norm == 0.0:
        return _zero_state(n)
    state = [0j] * dim
    for i, v in enumerate(x):
        state[i] = complex(v / norm, 0.0)
    return state


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

@dataclass
class QuantumConfig:
    """Settings for the quantum backend. ``enabled`` is the on/off switch."""
    enabled: bool = False
    max_qubits: int = 6          # simulator width per block; layers wider than this are split
    depth: int = 2               # variational layers per block
    encoding: str = "reupload"   # "angle" | "reupload" | "amplitude"
    entangler: str = "cz"        # "cz" | "cnot": the ring of two-qubit gates after each layer
    shots: int = 0               # 0 = exact expectation values, >0 = sampled bitstrings
    noise: float = 0.0           # depolarising probability per qubit per gate layer
    trajectories: int = 8        # noisy runs averaged when noise > 0
    init_scale: float = 0.1      # std-dev of initial angles; small = near-identity = fewer plateaus
    angle_scale: float = 1.0     # input value -> rotation angle
    seed: Optional[int] = None

    def validate(self) -> "QuantumConfig":
        if self.encoding not in ENCODINGS:
            raise ValueError(f"encoding must be one of {ENCODINGS}, got {self.encoding!r}")
        if self.entangler not in ENTANGLERS:
            raise ValueError(f"entangler must be one of {ENTANGLERS}, got {self.entangler!r}")
        if not 1 <= self.max_qubits <= 12:
            raise ValueError("max_qubits must be between 1 and 12 (the simulator is O(2**n))")
        if self.depth < 1:
            raise ValueError("depth must be >= 1")
        if self.shots < 0:
            raise ValueError("shots must be >= 0")
        if not 0.0 <= self.noise <= 1.0:
            raise ValueError("noise must be between 0 and 1")
        if self.trajectories < 1:
            raise ValueError("trajectories must be >= 1")
        return self

    def updated(self, **changes) -> "QuantumConfig":
        data = asdict(self)
        unknown = set(changes) - set(data)
        if unknown:
            raise ValueError(f"unknown quantum settings: {sorted(unknown)}")
        data.update(changes)
        return QuantumConfig(**data).validate()


# --------------------------------------------------------------------------
# One parameterised quantum circuit
# --------------------------------------------------------------------------

class QuantumBlock:
    """A parameterised quantum circuit (PQC) over ``n_qubits`` qubits.

    Input size == output size == ``n_qubits`` for ``angle``/``reupload``.
    For ``amplitude`` the input may have up to 2**n_qubits values and the output
    is still one value per qubit.
    """

    def __init__(self, n_qubits: int, config: QuantumConfig, rng: Optional[random.Random] = None):
        config.validate()
        if n_qubits < 1:
            raise ValueError("n_qubits must be >= 1")
        self.n = n_qubits
        self.config = config
        self.rng = rng or random.Random(config.seed)
        # params[layer][qubit] = [ry, rz]
        self.params: List[List[List[float]]] = [
            [[self.rng.gauss(0.0, config.init_scale), self.rng.gauss(0.0, config.init_scale)]
             for _ in range(n_qubits)]
            for _ in range(config.depth)
        ]
        self.circuit_runs = 0

    # -- circuit -----------------------------------------------------------

    def _evolve(self, x: Sequence[float], params: List[List[List[float]]], noisy: bool) -> List[complex]:
        cfg, n = self.config, self.n
        if cfg.encoding == "amplitude":
            state = amplitude_encode(x, n)
        else:
            state = _zero_state(n)
        for layer in range(cfg.depth):
            # State preparation. The pi/2 offset centres the readout at 0.5 for x=0,
            # like the sigmoid neuron it replaces.
            if cfg.encoding == "reupload" or (cfg.encoding == "angle" and layer == 0):
                for q in range(n):
                    v = x[q] if q < len(x) else 0.0
                    _apply_1q(state, n, q, _rx(cfg.angle_scale * v + math.pi / 2))
            for q in range(n):
                ry, rz = params[layer][q]
                _apply_1q(state, n, q, _ry(ry))
                _apply_1q(state, n, q, _rz(rz))
            if n > 1:
                ring = _apply_cz if cfg.entangler == "cz" else _apply_cnot
                for q in range(n):
                    ring(state, n, q, (q + 1) % n)
            if noisy:
                self._depolarise(state)
        return state

    def _depolarise(self, state: List[complex]) -> None:
        p, n = self.config.noise, self.n
        for q in range(n):
            if self.rng.random() < p:
                _apply_1q(state, n, q, self.rng.choice((_PAULI_X, _PAULI_Y, _PAULI_Z)))

    # -- readout -----------------------------------------------------------

    def _probabilities(self, state: List[complex]) -> List[float]:
        return [a.real * a.real + a.imag * a.imag for a in state]

    def _readout_from_probs(self, probs: List[float]) -> List[float]:
        """P(qubit q reads 1) for each qubit, from basis-state probabilities."""
        out = [0.0] * self.n
        for i, p in enumerate(probs):
            if p:
                for q in range(self.n):
                    if i >> q & 1:
                        out[q] += p
        return out

    def _run(self, x: Sequence[float], params: List[List[List[float]]]) -> List[float]:
        cfg = self.config
        noisy = cfg.noise > 0.0
        runs = cfg.trajectories if noisy else 1
        self.circuit_runs += runs
        probs = [0.0] * (1 << self.n)
        for _ in range(runs):
            state = self._evolve(x, params, noisy)
            for i, p in enumerate(self._probabilities(state)):
                probs[i] += p / runs
        if cfg.shots > 0:
            probs = self._sample(probs, cfg.shots)
        return self._readout_from_probs(probs)

    def _sample(self, probs: List[float], shots: int) -> List[float]:
        """Collapse the wavefunction ``shots`` times; return empirical frequencies."""
        counts = [0] * len(probs)
        cdf, acc = [], 0.0
        for p in probs:
            acc += p
            cdf.append(acc)
        total = acc or 1.0
        for _ in range(shots):
            r = self.rng.random() * total
            lo, hi = 0, len(cdf) - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if cdf[mid] < r:
                    lo = mid + 1
                else:
                    hi = mid
            counts[lo] += 1
        return [c / shots for c in counts]

    # -- public API --------------------------------------------------------

    def forward(self, x: Sequence[float]) -> List[float]:
        """One activation in [0, 1] per qubit."""
        return self._run(x, self.params)

    def distribution(self, x: Sequence[float]) -> List[float]:
        """Probability of every n-bit string (index = bitstring, qubit 0 = lowest bit)."""
        cfg = self.config
        noisy = cfg.noise > 0.0
        runs = cfg.trajectories if noisy else 1
        probs = [0.0] * (1 << self.n)
        for _ in range(runs):
            for i, p in enumerate(self._probabilities(self._evolve(x, self.params, noisy))):
                probs[i] += p / runs
        return self._sample(probs, cfg.shots) if cfg.shots > 0 else probs

    def gradients(self, x: Sequence[float], upstream: Sequence[float]) -> List[List[List[float]]]:
        """dL/dtheta for every angle, given dL/d(output) = ``upstream``.

        Parameter-shift: every angle gets two extra circuit runs at +/- pi/2.
        Nothing from the forward pass is reused, which is what no-cloning forces.
        """
        grads = []
        for layer in range(self.config.depth):
            row = []
            for q in range(self.n):
                pair = []
                for k in range(2):
                    saved = self.params[layer][q][k]
                    self.params[layer][q][k] = saved + math.pi / 2
                    plus = self._run(x, self.params)
                    self.params[layer][q][k] = saved - math.pi / 2
                    minus = self._run(x, self.params)
                    self.params[layer][q][k] = saved
                    pair.append(sum(u * (a - b) / 2.0 for u, a, b in zip(upstream, plus, minus)))
                row.append(pair)
            grads.append(row)
        return grads

    def apply_gradients(self, grads: List[List[List[float]]], lr: float) -> None:
        for layer in range(self.config.depth):
            for q in range(self.n):
                for k in range(2):
                    self.params[layer][q][k] -= lr * grads[layer][q][k]

    def train(self, data: Sequence[Tuple[Sequence[float], Sequence[float]]],
              epochs: int = 20, lr: float = 0.2) -> List[float]:
        """Fit outputs to targets by mean-squared error. Returns the loss per epoch."""
        history = []
        for _ in range(epochs):
            total = 0.0
            for x, y in data:
                out = self.forward(x)
                diff = [o - t for o, t in zip(out, y)]
                total += sum(d * d for d in diff) / len(diff)
                self.apply_gradients(self.gradients(x, [2 * d / len(diff) for d in diff]), lr)
            history.append(total / max(1, len(data)))
        return history

    def to_dict(self) -> Dict:
        return {"n": self.n, "params": self.params}

    def load_dict(self, data: Dict) -> None:
        if data.get("n") != self.n:
            raise ValueError("saved circuit has a different qubit count")
        params = data["params"]
        if len(params) != self.config.depth:
            raise ValueError("saved circuit has a different depth")
        self.params = [[[float(v) for v in pair] for pair in layer] for layer in params]


# --------------------------------------------------------------------------
# A layer of any width
# --------------------------------------------------------------------------

class QuantumLayer:
    """Replacement for a row of classical neurons. Splits wide layers into blocks."""

    def __init__(self, width: int, config: QuantumConfig):
        config.validate()
        if width < 1:
            raise ValueError("width must be >= 1")
        self.width = width
        self.config = config
        rng = random.Random(config.seed)
        self.blocks: List[QuantumBlock] = []
        left = width
        while left > 0:
            size = min(config.max_qubits, left)
            self.blocks.append(QuantumBlock(size, config, rng))
            left -= size

    def forward(self, values: Sequence[float]) -> List[float]:
        if len(values) != self.width:
            raise ValueError(f"expected {self.width} values, got {len(values)}")
        out: List[float] = []
        pos = 0
        for block in self.blocks:
            out.extend(block.forward(values[pos:pos + block.n]))
            pos += block.n
        return out

    @property
    def circuit_runs(self) -> int:
        return sum(b.circuit_runs for b in self.blocks)

    def status(self) -> Dict:
        return {
            "width": self.width,
            "blocks": len(self.blocks),
            "qubits": sum(b.n for b in self.blocks),
            "circuit_runs": self.circuit_runs,
            "config": asdict(self.config),
        }


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

def barren_plateau_probe(qubit_counts: Sequence[int] = (2, 4, 6, 8),
                         depth: int = 4, samples: int = 20, cost: str = "local",
                         seed: int = 0) -> List[Dict]:
    """Variance of one gradient component over random initialisations, per width.

    Variance that shrinks quickly as qubits grow is a barren plateau.
    ``cost="local"`` reads one qubit; ``cost="global"`` reads P(all qubits = 1),
    which is the worse case. Initial angles are uniform in [0, 2*pi), the
    regime where plateaus show up.
    """
    if cost not in ("local", "global"):
        raise ValueError("cost must be 'local' or 'global'")
    rng = random.Random(seed)
    results = []
    for n in qubit_counts:
        cfg = QuantumConfig(max_qubits=max(n, 1), depth=depth, encoding="angle").validate()
        grads = []
        for _ in range(samples):
            block = QuantumBlock(n, cfg, random.Random(rng.random()))
            for layer in block.params:
                for pair in layer:
                    pair[0], pair[1] = rng.uniform(0, 2 * math.pi), rng.uniform(0, 2 * math.pi)
            x = [0.0] * n

            def f(params):
                state = block._evolve(x, params, False)
                probs = block._probabilities(state)
                if cost == "global":
                    return probs[-1]
                return block._readout_from_probs(probs)[0]

            saved = block.params[0][0][0]
            block.params[0][0][0] = saved + math.pi / 2
            plus = f(block.params)
            block.params[0][0][0] = saved - math.pi / 2
            minus = f(block.params)
            block.params[0][0][0] = saved
            grads.append((plus - minus) / 2.0)
        mean = sum(grads) / len(grads)
        var = sum((g - mean) ** 2 for g in grads) / len(grads)
        results.append({"qubits": n, "gradient_variance": var, "cost": cost, "depth": depth})
    return results


def limits() -> Dict[str, str]:
    """The hard physical limits and what this backend does about each (for the status API)."""
    return {
        "linearity": "No ReLU. Non-linearity comes from angle encoding, data re-uploading and measurement.",
        "no_cloning": "Activations are never cached. Gradients use the parameter-shift rule (two extra runs per angle).",
        "barren_plateaus": "Near-identity init, shallow depth, local readout. Measure with barren_plateau_probe().",
        "decoherence": "Set 'noise' to model depolarising error per gate layer; deeper circuits degrade first.",
        "simulation_cost": "O(2**n) per gate on a classical CPU; wide layers are split into blocks of max_qubits.",
    }
