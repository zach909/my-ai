"""Tests for the switchable quantum neural network backend."""

import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from asi_core import (
    NeuralCore, NeuralLayer, QuantumBlock, QuantumConfig, QuantumLayer,
    amplitude_encode, barren_plateau_probe,
)
from asi_core import quantum_net as qn


def cfg(**kw):
    kw.setdefault("seed", 1)
    return QuantumConfig(enabled=True, **kw).validate()


class SimulatorTests(unittest.TestCase):
    def test_state_stays_normalised(self):
        block = QuantumBlock(4, cfg(depth=3))
        state = block._evolve([0.3, -1.2, 0.7, 2.0], block.params, False)
        self.assertAlmostEqual(sum(abs(a) ** 2 for a in state), 1.0, places=12)

    def test_hadamard_like_superposition_and_born_rule(self):
        state = qn._zero_state(1)
        qn._apply_1q(state, 1, 0, qn._ry(math.pi / 2))
        self.assertAlmostEqual(abs(state[0]) ** 2, 0.5)
        self.assertAlmostEqual(abs(state[1]) ** 2, 0.5)

    def test_cnot_entangles_bell_state(self):
        state = qn._zero_state(2)
        qn._apply_1q(state, 2, 0, qn._ry(math.pi / 2))
        qn._apply_cnot(state, 2, 0, 1)
        probs = [abs(a) ** 2 for a in state]
        self.assertAlmostEqual(probs[0], 0.5)
        self.assertAlmostEqual(probs[3], 0.5)
        self.assertAlmostEqual(probs[1] + probs[2], 0.0)

    def test_interference_cancels(self):
        # RY(t) then RY(-t) returns to |0>: amplitudes cancel destructively.
        state = qn._zero_state(1)
        qn._apply_1q(state, 1, 0, qn._ry(1.234))
        qn._apply_1q(state, 1, 0, qn._ry(-1.234))
        self.assertAlmostEqual(abs(state[1]) ** 2, 0.0, places=12)

    def test_amplitude_encoding(self):
        state = amplitude_encode([3.0, 4.0], 2)
        self.assertAlmostEqual(abs(state[0]), 0.6)
        self.assertAlmostEqual(abs(state[1]), 0.8)
        with self.assertRaises(ValueError):
            amplitude_encode([1.0] * 5, 2)


class BlockTests(unittest.TestCase):
    def test_rest_input_reads_half(self):
        block = QuantumBlock(3, cfg(depth=1, init_scale=0.0, encoding="angle"))
        for v in block.forward([0.0, 0.0, 0.0]):
            self.assertAlmostEqual(v, 0.5, places=9)

    def test_outputs_are_probabilities(self):
        block = QuantumBlock(5, cfg())
        for v in block.forward([random.uniform(-3, 3) for _ in range(5)]):
            self.assertTrue(0.0 <= v <= 1.0)

    def test_identity_init_is_sinusoidal_activation(self):
        block = QuantumBlock(2, cfg(depth=1, init_scale=0.0, encoding="angle"))
        for x in (-2.0, -0.5, 0.0, 0.9, 2.5):
            self.assertAlmostEqual(block.forward([x, 0.0])[0], (1 + math.sin(x)) / 2, places=9)

    def test_cnot_entangler_works_and_validates(self):
        block = QuantumBlock(3, cfg(entangler="cnot"))
        self.assertEqual(len(block.forward([0.1, 0.2, 0.3])), 3)
        state = block._evolve([0.1, 0.2, 0.3], block.params, False)
        self.assertAlmostEqual(sum(abs(a) ** 2 for a in state), 1.0, places=12)
        with self.assertRaises(ValueError):
            QuantumConfig(entangler="swap").validate()

    def test_entanglement_changes_the_result(self):
        # With nonzero rotations, CZ vs no interaction must differ: the ring does something.
        a = QuantumBlock(3, cfg(depth=2, init_scale=0.8, seed=5))
        out_ring = a.forward([0.5, -0.3, 0.8])
        saved = qn._apply_cz
        qn._apply_cz = lambda *args: None
        try:
            out_none = a.forward([0.5, -0.3, 0.8])
        finally:
            qn._apply_cz = saved
        self.assertNotEqual(out_ring, out_none)

    def test_output_is_nonlinear_in_input(self):
        block = QuantumBlock(2, cfg(depth=1, init_scale=0.0, encoding="angle"))
        f = lambda x: block.forward([x, 0.0])[0]
        self.assertNotAlmostEqual(f(2.0) - f(1.0), f(1.0) - f(0.0), places=3)

    def test_shots_converge_to_exact(self):
        exact = QuantumBlock(2, cfg(shots=0)).forward([0.8, -0.4])
        sampled = QuantumBlock(2, cfg(shots=20000)).forward([0.8, -0.4])
        for a, b in zip(exact, sampled):
            self.assertAlmostEqual(a, b, delta=0.03)

    def test_few_shots_are_noisy_but_valid(self):
        out = QuantumBlock(2, cfg(shots=4)).forward([0.8, -0.4])
        for v in out:
            self.assertTrue(0.0 <= v <= 1.0)

    def test_distribution_sums_to_one(self):
        dist = QuantumBlock(3, cfg()).distribution([0.1, 0.2, 0.3])
        self.assertEqual(len(dist), 8)
        self.assertAlmostEqual(sum(dist), 1.0, places=9)

    def test_amplitude_encoding_block(self):
        block = QuantumBlock(3, cfg(encoding="amplitude", depth=1, init_scale=0.0))
        dist = block.distribution([1, 2, 3, 4, 5, 6, 7, 8])
        self.assertAlmostEqual(sum(dist), 1.0, places=9)

    def test_parameter_shift_matches_finite_difference(self):
        block = QuantumBlock(3, cfg(depth=2, init_scale=0.5))
        x = [0.4, -0.7, 1.1]
        upstream = [0.3, -0.5, 0.9]
        grads = block.gradients(x, upstream)
        eps = 1e-5
        for layer, q, k in [(0, 0, 0), (0, 2, 1), (1, 1, 0), (1, 2, 1)]:
            saved = block.params[layer][q][k]
            block.params[layer][q][k] = saved + eps
            hi = sum(u * o for u, o in zip(upstream, block.forward(x)))
            block.params[layer][q][k] = saved - eps
            lo = sum(u * o for u, o in zip(upstream, block.forward(x)))
            block.params[layer][q][k] = saved
            self.assertAlmostEqual(grads[layer][q][k], (hi - lo) / (2 * eps), places=6)

    def test_training_reduces_loss(self):
        block = QuantumBlock(2, cfg(depth=2, init_scale=0.3))
        data = [([0.0, 0.0], [0.2, 0.8]), ([1.0, -1.0], [0.9, 0.1]), ([-1.0, 1.0], [0.1, 0.6])]
        history = block.train(data, epochs=40, lr=0.6)
        self.assertLess(history[-1], history[0] * 0.5)

    def test_noise_pulls_toward_mixed(self):
        clean = QuantumBlock(2, cfg(depth=4, init_scale=0.0, encoding="angle")).forward([1.2, 1.2])
        noisy_cfg = cfg(depth=4, init_scale=0.0, encoding="angle", noise=0.6, trajectories=400)
        noisy = QuantumBlock(2, noisy_cfg).forward([1.2, 1.2])
        self.assertLess(sum(abs(v - 0.5) for v in noisy), sum(abs(v - 0.5) for v in clean))

    def test_save_and_load(self):
        a = QuantumBlock(3, cfg(seed=1))
        b = QuantumBlock(3, cfg(seed=2))
        self.assertNotEqual(a.forward([0.5, 0.5, 0.5]), b.forward([0.5, 0.5, 0.5]))
        b.load_dict(a.to_dict())
        self.assertEqual(a.forward([0.5, 0.5, 0.5]), b.forward([0.5, 0.5, 0.5]))

    def test_invalid_config_rejected(self):
        for bad in ({"encoding": "bogus"}, {"max_qubits": 0}, {"max_qubits": 40},
                    {"depth": 0}, {"shots": -1}, {"noise": 2.0}, {"trajectories": 0}):
            with self.assertRaises(ValueError):
                QuantumConfig(**bad).validate()
        with self.assertRaises(ValueError):
            QuantumConfig().updated(nonsense=1)


class LayerTests(unittest.TestCase):
    def test_wide_layer_is_split_into_blocks(self):
        layer = QuantumLayer(14, cfg(max_qubits=6))
        self.assertEqual([b.n for b in layer.blocks], [6, 6, 2])
        self.assertEqual(len(layer.forward([0.1] * 14)), 14)

    def test_width_mismatch(self):
        with self.assertRaises(ValueError):
            QuantumLayer(4, cfg()).forward([0.0] * 3)


class BarrenPlateauTests(unittest.TestCase):
    def test_global_cost_variance_shrinks_with_width(self):
        res = barren_plateau_probe(qubit_counts=(2, 6), depth=4, samples=40, cost="global")
        self.assertLess(res[1]["gradient_variance"], res[0]["gradient_variance"])


class ToggleTests(unittest.TestCase):
    CORE = {"layers": [{"id": "a", "size": 8, "type": "SENSORY"}, {"id": "b", "size": 8, "type": "INTERNEURON"}],
            "connection_probability": 0.3, "recurrent_connections": False}

    def drive(self, core, steps=30):
        for _ in range(steps):
            core.update({"a": {f"a_n{i}": 1.0 for i in range(8)}}, dt=0.001)

    def test_off_by_default(self):
        os.environ.pop("NEUROCLAW_QUANTUM", None)
        core = NeuralCore(dict(self.CORE))
        self.assertFalse(core.quantum_status()["enabled"])
        self.assertTrue(all(l.quantum is None for l in core.layers.values()))

    def test_classical_path_unchanged_by_refactor(self):
        from asi_core import Neuron
        n = Neuron(id="x")
        n.activate(0.7, 0.001)
        expected = 1.0 / (1.0 + math.exp(-n.membrane_potential))
        self.assertAlmostEqual(n.activation, expected)

    def test_turn_on_and_off(self):
        core = NeuralCore(dict(self.CORE))
        status = core.set_quantum(True, max_qubits=4, depth=1, seed=3)
        self.assertTrue(status["enabled"])
        self.assertEqual(set(status["layers"]), {"a", "b"})
        self.drive(core)
        self.assertGreater(core.layers["b"].quantum.circuit_runs, 0)
        for layer in core.layers.values():
            for neuron in layer.neurons.values():
                self.assertTrue(0.0 <= neuron.activation <= 1.0)
        status = core.set_quantum(False)
        self.assertFalse(status["enabled"])
        self.drive(core)  # classical path runs again without error

    def test_single_layer_toggle(self):
        core = NeuralCore(dict(self.CORE))
        core.set_quantum(True, layers=["b"], max_qubits=4)
        self.assertIsNone(core.layers["a"].quantum)
        self.assertIsNotNone(core.layers["b"].quantum)

    def test_bad_settings_change_nothing(self):
        core = NeuralCore(dict(self.CORE))
        with self.assertRaises(ValueError):
            core.set_quantum(True, noise=5.0)
        with self.assertRaises(ValueError):
            core.set_quantum(True, layers=["nope"])
        self.assertFalse(core.quantum_status()["enabled"])

    def test_config_and_env_switch(self):
        core = NeuralCore({**self.CORE, "quantum": {"enabled": True, "max_qubits": 4}})
        self.assertTrue(core.quantum_status()["enabled"])
        os.environ["NEUROCLAW_QUANTUM"] = "1"
        try:
            self.assertTrue(NeuralCore(dict(self.CORE)).quantum_status()["enabled"])
        finally:
            del os.environ["NEUROCLAW_QUANTUM"]


if __name__ == "__main__":
    unittest.main()
