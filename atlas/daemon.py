"""The always-on mapper: ``neuroclaw-atlas daemon`` and ``neuroclaw-atlas autostart``.

Why it exists: an AI that is not running knows nothing about what happened while it was off. The map is its memory of
that time. This loop runs on its own (started at boot by ``autostart on``), so a car that drives past, a file that
changed or a room that got warmer is already in the map when the AI is asked about it later.

What it maps, each on its own timer (all standard library, all written into the same map):

* **sensors**: this computer's plain sensors (``sensors.py``), every ``sense_every`` seconds;
* **vitals**: load, memory, battery and charger state, from ``/proc`` and ``/sys``, every ``sense_every`` seconds;
* **files**: every folder in ``roots`` (default: the home folder), every ``files_every`` seconds. Only files that
  changed since the last pass are read again; hidden folders, symlinks and secret-looking names are skipped;
* **cameras**: only if ``capture`` is on in ``config.json`` AND ``cams`` names them, every ``look_every`` seconds.
  Pictures are never written to disk, only the marks made from them (that something of some size moved, where, when).
  It records that something moved, never what it was or who.

It is polite: low CPU and I/O priority, longer gaps on battery, a bounded map (``digest`` runs on a timer), and it stops
cleanly on SIGTERM. It needs no network. Settings live in ``config.json`` in the atlas folder.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import atlas_core as core
from . import cli, vision
from .store import open_store

DEFAULTS = {"sense_every": 60, "files_every": 3600, "look_every": 30, "digest_every": 21600}
MINIMUM = {"sense_every": 10, "files_every": 300, "look_every": 5, "digest_every": 600}
ON_BATTERY_SLOWER = 4          # gaps are this many times longer on battery
FILES_LIMIT = 20000            # entries per folder per pass
UNIT = "neuroclaw-atlas.service"
DESKTOP = "neuroclaw-atlas.desktop"


def settings(home: Path) -> dict:
    """Timers and choices from ``config.json``, each clamped to a sane minimum so a typo cannot spin the CPU."""
    cfg = cli._config(home)
    s = {}
    for k, d in DEFAULTS.items():
        v = cfg.get(k, d)
        s[k] = max(MINIMUM[k], v) if type(v) is int else d
    roots = cfg.get("roots")
    s["roots"] = [r for r in roots if isinstance(r, str)] if isinstance(roots, list) and roots else [str(Path.home())]
    s["capture"] = cfg.get("capture") is True
    s["cams"] = cfg.get("cams") if isinstance(cfg.get("cams"), str) else ""
    for k, d in (("xs", "0,60"), ("pose", "0,0,0,0")):
        s[k] = cfg.get(k) if isinstance(cfg.get(k), str) else d
    s["focal"] = cfg.get("focal") if type(cfg.get("focal")) is int else 120
    return s


# ---- the machine's own state --------------------------------------------------------------------------------------

POWER = Path("/sys/class/power_supply")


def power_state(root: Path = POWER):
    """``(on_battery, percent or None)``. A desktop with no battery is never "on battery"."""
    pct, mains, has_bat = None, None, False
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return False, None
    for n in names:
        try:
            kind = (root / n / "type").read_text().strip()
            if kind == "Battery":
                has_bat = True
                pct = int((root / n / "capacity").read_text().strip())
            elif kind == "Mains":
                mains = (root / n / "online").read_text().strip() == "1"
        except (OSError, ValueError):
            continue
    return bool(has_bat and mains is not True), pct


def vitals(t: int, proc: Path = Path("/proc"), power: Path = POWER) -> list:
    """Marks for how the computer itself is doing: load (milli), memory used (percent), battery (percent)."""
    out = []
    try:
        load = float((proc / "loadavg").read_text().split()[0])
        out.append(core.mark("load", None, v=int(load * 1000), t=t, ref="host", unit="mload", space="host"))
    except (OSError, ValueError, IndexError):
        pass
    try:
        mem = {}
        for line in (proc / "meminfo").read_text().splitlines():
            k, _, rest = line.partition(":")
            if k in ("MemTotal", "MemAvailable"):
                mem[k] = int(rest.split()[0])
        if mem.get("MemTotal"):
            used = 100 - (100 * mem["MemAvailable"]) // mem["MemTotal"]
            out.append(core.mark("memory", None, v=int(used), t=t, ref="host", unit="%", space="host"))
    except (OSError, ValueError, KeyError, IndexError):
        pass
    _, pct = power_state(power)
    if pct is not None:
        out.append(core.mark("battery", None, v=pct, t=t, ref="host", unit="%", space="host"))
    return out


# ---- the loop -----------------------------------------------------------------------------------------------------

class Stop(Exception):
    pass


def _grab():
    return cli.GRAB or vision.grab_opencv


def run(home: Path, out=print, once: bool = False, now=None, sleep=None, power=POWER, proc=Path("/proc")) -> int:
    """Map until stopped (SIGTERM or Ctrl-C), or one round of everything with ``once``. Returns 0."""
    now = now or cli.NOW
    sleep = sleep or cli.SLEEP
    store = open_store(home)
    bg = core.Background(keep=3)
    due = {"sense": 0, "files": 0, "look": 0, "digest": now() + DEFAULTS["digest_every"]}
    last_files = None
    cam_err = None

    def handler(signum, frame):
        raise Stop()

    if not once:
        try:
            signal.signal(signal.SIGTERM, handler)
        except ValueError:                      # not the main thread (tests)
            pass
        try:                                    # be nice: lowest CPU priority; idle I/O is set in the service unit
            os.nice(10)
        except OSError:
            pass
    out("atlas daemon: mapping " + ("once" if once else "until stopped"))
    try:
        while True:
            s = settings(home)
            t = now()
            battery, _ = power_state(power)
            slow = ON_BATTERY_SLOWER if battery else 1
            if t >= due["sense"]:
                try:
                    _, _, marks = cli.sense_marks(home)
                except OSError:
                    marks = []
                marks += vitals(t, proc, power)
                if marks:
                    store.add(marks)
                    out(f"sensors and vitals: {len(marks)} readings" + (" (on battery)" if battery else ""))
                due["sense"] = t + s["sense_every"] * slow
            if t >= due["files"]:
                total = 0
                for raw in s["roots"]:
                    p = Path(raw)
                    try:
                        if p.is_symlink() or not p.is_dir():
                            continue
                        added, entries, _sk = cli.ingest_dir(store, p, t, since=last_files, limit=FILES_LIMIT, skip_hidden=True)
                        total += added
                    except OSError as e:
                        out(f"files: {raw}: {e.strerror or e}")
                last_files = t
                out(f"files: {total} marks added")
                due["files"] = t + s["files_every"] * slow
            if t >= due["look"]:
                due["look"] = t + s["look_every"] * slow
                if s["capture"] and s["cams"]:
                    try:
                        cams = [int(c) for c in s["cams"].split(",")]
                        rig = {"f": s["focal"], "xs": [int(x) for x in s["xs"].split(",")],
                               "pose": [int(x) for x in s["pose"].split(",")], "voxel": 100}
                        if len(cams) != len(rig["xs"]):
                            raise ValueError("cams and xs must have the same count")
                        data = _grab()(cams, 128, 96, count=4, every_ms=400)
                        marks, sm = vision.analyse(rig, data["sets"], data["w"], data["h"], bg)
                        store.add(marks)
                        cam_err = None
                        if sm["events"]:
                            out(f"cameras: {sm['events']} things moved")
                    except (RuntimeError, ValueError) as e:
                        if str(e) != cam_err:           # say it once, not every look
                            out(f"cameras: {e}")
                            cam_err = str(e)
                        due["look"] = t + max(s["look_every"], 300) * slow
            if t >= due["digest"]:
                rep = store.consolidate(now=t, keep_s=3600)
                out(f"digest: size {rep['before']} -> {rep['after']} characters")
                due["digest"] = t + s["digest_every"] * slow
            if once:
                break
            sleep(max(1, min(60, min(due.values()) - now())))
    except (Stop, KeyboardInterrupt):
        out("atlas daemon: stopped")
    return 0


# ---- start at boot ------------------------------------------------------------------------------------------------

def _config_dir() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def unit_text(home: Path, py: str, repo: Path) -> str:
    """A systemd USER service: low priority, memory cap, no new privileges, may write only the atlas folder."""
    return (
        "[Unit]\n"
        "Description=NeuroClaw Atlas: keeps the map of what happens, so the AI knows when it was not running\n"
        "\n[Service]\n"
        f"Environment=PYTHONPATH={repo}\n"
        f"Environment=NEUROCLAW_ATLAS_HOME={home}\n"
        f"ExecStart={py} -m atlas daemon\n"
        "Restart=on-failure\nRestartSec=30\n"
        "Nice=10\nIOSchedulingClass=idle\nCPUWeight=20\nMemoryMax=256M\n"
        "NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\n"
        f"ReadWritePaths={home}\n"
        "\n[Install]\nWantedBy=default.target\n"
    )


def desktop_text(home: Path, py: str, repo: Path) -> str:
    return ("[Desktop Entry]\nType=Application\nName=NeuroClaw Atlas\n"
            f"Exec=env PYTHONPATH={repo} NEUROCLAW_ATLAS_HOME={home} {py} -m atlas daemon\n"
            "X-GNOME-Autostart-enabled=true\n")


def _systemctl(*args) -> bool:
    try:
        return subprocess.run(["systemctl", "--user", *args], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def autostart(home: Path, state, out, config_dir: Path | None = None, use_systemd: bool | None = None) -> int:
    """``on``: map from boot. ``off``: stop and remove it. ``None``: report. Touches only the user's own config folder."""
    cfg_dir = config_dir or _config_dir()
    systemd = (shutil.which("systemctl") is not None) if use_systemd is None else use_systemd
    unit, desk = cfg_dir / "systemd" / "user" / UNIT, cfg_dir / "autostart" / DESKTOP
    py, repo = sys.executable or "python3", Path(__file__).resolve().parent.parent
    cfg = cli._config(home)
    if state == "on":
        if systemd:
            unit.parent.mkdir(parents=True, exist_ok=True)
            unit.write_text(unit_text(home, py, repo))
            _systemctl("daemon-reload")
            started = _systemctl("enable", "--now", UNIT)
            lingered = False
            try:        # lets the user's services start at BOOT, before anyone logs in
                lingered = subprocess.run(["loginctl", "enable-linger"], capture_output=True, timeout=30).returncode == 0
            except (OSError, subprocess.SubprocessError):
                pass
            out(f"autostart on: {unit} ({'started' if started else 'written; systemd did not start it now'})")
            out("starts at boot" if lingered else
                "starts when you log in (could not enable boot-before-login; run `loginctl enable-linger` as your user)")
        else:
            desk.parent.mkdir(parents=True, exist_ok=True)
            desk.write_text(desktop_text(home, py, repo))
            out(f"autostart on: {desk} (starts when you log in; no systemd here)")
        cfg["autostart"] = True
        cli._save_json(home, "config.json", cfg)
    elif state == "off":
        if systemd:
            _systemctl("disable", "--now", UNIT)
        for f in (unit, desk):
            try:
                f.unlink()
            except OSError:
                pass
        if systemd:
            _systemctl("daemon-reload")
        cfg["autostart"] = False
        cli._save_json(home, "config.json", cfg)
        out("autostart off")
    else:
        out("autostart: " + ("on" if cfg.get("autostart") else "off")
            + "; cameras " + ("on" if cfg.get("capture") else "off (neuroclaw-atlas capture on)"))
    return 0
