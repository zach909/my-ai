"""Detect what this machine can hold, without needing torch or root."""
from __future__ import annotations
import os, platform, shutil, subprocess, sys
from dataclasses import dataclass, asdict, field

MB = 1024 * 1024


@dataclass
class Hardware:
    os: str
    arch: str
    cores: int
    ram_total_mb: int
    ram_available_mb: int
    gpu_name: str | None = None
    gpu_vram_mb: int = 0
    unified_memory: bool = False   # Apple silicon: GPU shares RAM
    mobile: bool = False
    simd: list = field(default_factory=list)
    notes: list = field(default_factory=list)

    @property
    def accelerated(self) -> bool:
        return self.gpu_vram_mb > 0 or self.unified_memory

    def usable_mb(self) -> int:
        """Memory we are willing to give the model, leaving room for the OS,
        activations and the app itself."""
        if self.gpu_vram_mb > 0 and not self.unified_memory:
            return int(self.gpu_vram_mb * 0.85)
        frac = 0.40 if self.mobile else 0.60
        return int(self.ram_available_mb * frac)

    def to_dict(self):
        d = asdict(self)
        d["usable_mb"] = self.usable_mb()
        return d


def _meminfo():
    total = avail = 0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                if k == "MemTotal":
                    total = int(v.split()[0]) // 1024
                elif k == "MemAvailable":
                    avail = int(v.split()[0]) // 1024
    except OSError:
        pass
    return total, avail


def _sysctl(name):
    try:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def _windows_mem():
    try:
        import ctypes

        class MS(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("tot", ctypes.c_ulonglong),
                        ("av", ctypes.c_ulonglong), ("a", ctypes.c_ulonglong), ("b", ctypes.c_ulonglong),
                        ("c", ctypes.c_ulonglong), ("d", ctypes.c_ulonglong), ("e", ctypes.c_ulonglong)]
        s = MS(); s.l = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
        return s.tot // MB, s.av // MB
    except Exception:
        return 0, 0


def _simd():
    flags = set()
    try:
        with open("/proc/cpuinfo") as f:
            txt = f.read().lower()
        for key in ("avx512f", "avx2", "avx", "neon", "asimd", "sve", "fma"):
            if key in txt.split():
                flags.add("neon" if key == "asimd" else key)
    except OSError:
        pass
    if platform.machine().lower() in ("arm64", "aarch64"):
        flags.add("neon")
    return sorted(flags)


def _nvidia():
    if not shutil.which("nvidia-smi"):
        return None, 0
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        best = None
        for line in out:
            name, _, free = line.rpartition(",")
            free = int(free.strip())
            if best is None or free > best[1]:
                best = (name.strip(), free)
        return best if best else (None, 0)
    except Exception:
        return None, 0


def detect_hardware() -> Hardware:
    """Environment overrides (for tests and for forcing a tier on purpose):
    NEUROCLAW_MEM_MB = pretend usable-memory pool, NEUROCLAW_GPU_VRAM_MB."""
    system = platform.system()
    arch = platform.machine().lower()
    notes = []
    if system == "Windows":
        total, avail = _windows_mem()
    elif system == "Darwin":
        total = int(_sysctl("hw.memsize") or 0) // MB
        avail = total * 6 // 10
        notes.append("macOS: available RAM estimated as 60% of total")
    else:
        total, avail = _meminfo()
    mobile = "ANDROID_ROOT" in os.environ or "ANDROID_DATA" in os.environ or hasattr(sys, "getandroidapilevel")
    unified = system == "Darwin" and arch in ("arm64", "aarch64")
    gpu, vram = _nvidia()
    if unified:
        gpu = gpu or "Apple silicon GPU (unified memory)"
    hw = Hardware(os=system, arch=arch, cores=os.cpu_count() or 1, ram_total_mb=total,
                  ram_available_mb=avail, gpu_name=gpu, gpu_vram_mb=vram,
                  unified_memory=unified, mobile=mobile, simd=_simd(), notes=notes)
    env_vram = os.environ.get("NEUROCLAW_GPU_VRAM_MB")
    if env_vram:
        hw.gpu_vram_mb, hw.gpu_name = int(env_vram), hw.gpu_name or "override"
        hw.notes.append("GPU VRAM overridden by NEUROCLAW_GPU_VRAM_MB")
    env_mem = os.environ.get("NEUROCLAW_MEM_MB")
    if env_mem:
        hw.ram_available_mb = int(int(env_mem) / (0.40 if mobile else 0.60)) if hw.gpu_vram_mb == 0 else hw.ram_available_mb
        hw.notes.append("memory overridden by NEUROCLAW_MEM_MB")
    if hw.ram_total_mb == 0:
        hw.notes.append("could not read RAM size; assuming 2048 MB")
        hw.ram_total_mb = hw.ram_available_mb = 2048
    return hw
