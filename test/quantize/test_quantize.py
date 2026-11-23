"""Run from the repo root: python3 test/quantize/test_quantize.py"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import http.server, json, os, tempfile, threading, unittest
import numpy as np

from quantize import classic, binary, littlebit, container, engine, fetch, pipeline
from quantize.bitpack import pack_uint, unpack_uint
from quantize.hardware import Hardware, detect_hardware
from quantize.planner import plan_model, TIERS
from quantize.__main__ import main as cli


def rel(a, b):
    return float(np.linalg.norm(a - b) / np.linalg.norm(a))


def lowrank(m=256, n=256, k=32, noise=0.05, seed=1):
    r = np.random.default_rng(seed)
    return (r.standard_normal((m, k)) @ r.standard_normal((k, n)) / 6
            + noise * r.standard_normal((m, n))).astype(np.float32)


def hw(mb, vram=0):
    return Hardware(os="Linux", arch="x86_64", cores=4, ram_total_mb=mb * 2,
                    ram_available_mb=int(mb / 0.6), gpu_vram_mb=vram)


class BitPack(unittest.TestCase):
    def test_roundtrip_all_widths(self):
        r = np.random.default_rng(0)
        for bits in range(1, 9):
            v = r.integers(0, 1 << bits, 1001)
            self.assertTrue(np.array_equal(unpack_uint(pack_uint(v, bits), bits, v.size), v))


class Classic(unittest.TestCase):
    def test_error_shrinks_with_bits(self):
        w = np.random.default_rng(0).standard_normal(4096).astype(np.float32)
        errs = [rel(w, classic.dequantize_bits(classic.quantize_bits(w, b))) for b in (2, 4, 8)]
        self.assertGreater(errs[0], errs[1]); self.assertGreater(errs[1], errs[2])
        self.assertLess(errs[2], 0.01)

    def test_values_are_integer_multiples_of_shared_step(self):
        w = np.random.default_rng(0).standard_normal(128).astype(np.float32)
        p = classic.quantize_bits(w, 4, group=64)
        d = classic.dequantize_bits(p).reshape(2, 64)
        steps = p["step"].astype(np.float32)
        ratio = d / steps[:, None]
        self.assertTrue(np.allclose(ratio, np.round(ratio), atol=1e-2))

    def test_decimals_mode_rounds_to_n_places(self):
        w = np.array([0.12345, -0.98765, 0.5], np.float32)
        d = classic.dequantize_decimals(classic.quantize_decimals(w, 2))
        self.assertTrue(np.allclose(d, [0.12, -0.99, 0.5], atol=1e-6))

    def test_odd_shapes(self):
        w = np.random.default_rng(0).standard_normal((7, 13)).astype(np.float32)
        self.assertEqual(classic.dequantize_bits(classic.quantize_bits(w, 8)).shape, (7, 13))


class Binary(unittest.TestCase):
    def test_one_bit_per_weight_and_sign_preserved(self):
        w = np.random.default_rng(0).standard_normal((10, 50)).astype(np.float32)
        p = binary.quantize_binary(w)
        d = binary.dequantize_binary(p)
        self.assertEqual(d.shape, w.shape)
        self.assertTrue(np.all(np.sign(d) == np.sign(w)))
        self.assertEqual(p["bits"].size, (w.size + 127) // 128 * 128 // 8)  # 1 bit each


class LittleBit(unittest.TestCase):
    def test_rotation_leaves_product_unchanged(self):
        w = lowrank()
        U, S, Vt = np.linalg.svd(w, full_matrices=False)
        s = np.sqrt(S[:20])
        Uf, Vf = U[:, :20] * s, Vt[:20].T * s
        R = littlebit._itq_rotation(np.vstack([Uf, Vf]), 20, np.random.default_rng(0))
        self.assertTrue(np.allclose(R @ R.T, np.eye(20), atol=1e-5))
        self.assertTrue(np.allclose((Uf @ R) @ (Vf @ R).T, Uf @ Vf.T, atol=1e-4))

    def test_rotation_reduces_error(self):
        w = lowrank()
        e_rot = rel(w, littlebit.dequantize_littlebit(littlebit.quantize_littlebit(w, 0.55, rotate=True)))
        e_no = rel(w, littlebit.dequantize_littlebit(littlebit.quantize_littlebit(w, 0.55, rotate=False)))
        self.assertLess(e_rot, e_no)

    def test_storage_respects_budget(self):
        for bpw in (0.55, 0.3, 0.1):
            bits = littlebit.est_bits_littlebit((2048, 2048), bpw)
            self.assertLessEqual(bits / 2048 ** 2, bpw)
            self.assertGreater(bits / 2048 ** 2, bpw * 0.9)

    def test_actual_arrays_match_estimate(self):
        w = lowrank()
        e = engine.quantize_tensor("w", w, "littlebit-0.55")
        actual = sum(a.size * a.itemsize * 8 for a in e["arrays"].values())
        self.assertLessEqual(actual, engine.est_bits("littlebit-0.55", "w", w.shape) + 7 * len(e["arrays"]))

    def test_small_matrix_falls_back_to_binary(self):
        self.assertEqual(engine.resolve_tier("littlebit-0.1", "w", (64, 64)), "binary")
        self.assertEqual(engine.resolve_tier("littlebit-0.1", "w", (100,)), "binary")
        self.assertEqual(engine.resolve_tier("littlebit-0.1", "w", (8192, 8192)), "littlebit-0.1")

    def test_norms_stay_fp16(self):
        self.assertEqual(engine.resolve_tier("binary", "layer.0.input_layernorm.weight", (4096,)), "fp16")


class Pipeline(unittest.TestCase):
    def test_container_roundtrip_exact(self):
        w = {"a": lowrank(), "b": np.random.default_rng(0).standard_normal(500).astype(np.float32)}
        ents = {k: engine.quantize_tensor(k, v, "classic4") for k, v in w.items()}
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.nqz")
            container.save(p, ents, {"x": 1})
            back, info = container.load(p)
        self.assertEqual(info, {"x": 1})
        for k in w:
            self.assertTrue(np.array_equal(engine.dequantize_tensor(back[k]), engine.dequantize_tensor(ents[k])))

    def test_pack_model_end_to_end(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "m.npz")
            w = lowrank(512, 512)
            np.savez(src, w=w)
            r = pipeline.pack_model(src, os.path.join(d, "o.nqz"), "littlebit-0.55", hw(10000))
            self.assertEqual(r["tier"], "littlebit-0.55")
            self.assertLess(r["payload_bytes"], w.nbytes / 20)
            self.assertLess(r["relative_error"], 0.8)
            back = pipeline.unpack_model(os.path.join(d, "o.nqz"))
            self.assertEqual(back["w"].shape, w.shape)


class Planner(unittest.TestCase):
    SEVEN_B = {f"l{i}.w": (4096, 4096) for i in range(32 * 4)}   # ~2.1B params

    def test_more_memory_never_picks_a_smaller_tier(self):
        order = [plan_model(self.SEVEN_B, hw(mb)).tier for mb in (40, 500, 1500, 3000, 6000, 12000, 80000)]
        idx = [TIERS.index(t) for t in order]
        self.assertEqual(idx, sorted(idx, reverse=True))
        self.assertEqual(order[-1], "fp16")
        self.assertEqual(order[0], "littlebit-0.1")

    def test_chosen_tier_actually_fits(self):
        for mb in (300, 1000, 4000):
            p = plan_model(self.SEVEN_B, hw(mb))
            if p.fits:
                self.assertLessEqual(p.model_mb, p.budget_mb)

    def test_reports_when_nothing_fits(self):
        p = plan_model(self.SEVEN_B, hw(10))
        self.assertFalse(p.fits)
        self.assertEqual(p.tier, "littlebit-0.1")

    def test_gpu_vram_is_the_budget_when_present(self):
        p = plan_model(self.SEVEN_B, hw(64000, vram=2000))
        self.assertAlmostEqual(p.budget_mb, 1700, delta=1)

    def test_forced_tier(self):
        self.assertEqual(plan_model(self.SEVEN_B, hw(64000), "binary").tier, "binary")
        with self.assertRaises(ValueError):
            plan_model(self.SEVEN_B, hw(64000), "nope")

    def test_detect_hardware_runs(self):
        h = detect_hardware()
        self.assertGreater(h.ram_total_mb, 0)
        self.assertGreaterEqual(h.cores, 1)


class Install(unittest.TestCase):
    def test_downloads_model_then_quantizes_it(self):
        src = os.path.join(os.path.dirname(__file__), "..", "..", "app", "src", "main", "assets", "onebrain")
        if not os.path.exists(os.path.join(src, "model.json")):
            self.skipTest("bundled model not present")

        class H(http.server.SimpleHTTPRequestHandler):
            def __init__(s, *a, **k): super().__init__(*a, directory=src, **k)
            def log_message(s, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                url = f"http://127.0.0.1:{srv.server_port}/model.json"
                os.environ["NEUROCLAW_MEM_MB"] = "1"        # tiny machine
                try:
                    self.assertEqual(cli(["install", "--url", url, "--out-dir", d]), 0)
                finally:
                    del os.environ["NEUROCLAW_MEM_MB"]
                with open(os.path.join(d, "quantization.json")) as fh:
                    rep = json.load(fh)
                self.assertEqual(rep["tier"], "littlebit-0.1")
                self.assertTrue(os.path.exists(os.path.join(d, "model.nqz")))
                with open(os.path.join(d, "model.json")) as fh:
                    exact = json.load(fh)
                with open(os.path.join(d, "model.quantized.json")) as fh:
                    q = json.load(fh)
                self.assertFalse(exact["savedWithQuantization"])      # exact copy untouched
                self.assertTrue(q["savedWithQuantization"])
                self.assertEqual(len(q["weights"]), len(exact["weights"]))
                self.assertEqual(q["neurons"], exact["neurons"])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_download_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(cli(["install", "--url", "http://127.0.0.1:1/x.json", "--out-dir", d]), 1)

    def test_sha256_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "a")
            with open(f, "w") as fh:
                fh.write("hi")
            with self.assertRaises(IOError):
                fetch.download("file://" + f, os.path.join(d, "b"), sha256="0" * 64)
            self.assertFalse(os.path.exists(os.path.join(d, "b")))

    def test_default_url_points_at_the_github_repo(self):
        self.assertTrue(fetch.default_url().startswith("https://raw.githubusercontent.com/zach909/my-ai/"))
        self.assertTrue(fetch.default_url().endswith("onebrain/model.json"))


if __name__ == "__main__":
    unittest.main()
