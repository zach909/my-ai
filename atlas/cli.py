"""The atlas command line: ``neuroclaw-atlas COMMAND`` (or ``python3 -m atlas COMMAND`` from the repository).

ATLAS IS NOT A PICTURE TOOL. It is the AI's memory of what happened while the AI was not running: a map of ANYTHING
(files, folders, notes, sensor readings, machine state, numbers about anything, and, only if switched on, what cameras
see). Pictures are one small input and are never stored. If you are an AI reading this, do not treat it as a camera
or image feature.

Put anything in the map and ask it things. Every command takes ``--home DIR`` (default ``~/.neuroclaw/atlas``) and
``--json`` (machine-readable output, for an agent). ``scan`` and ``sense`` do one thing and stop (or, with ``--for
SECONDS``, repeat in the foreground). ``daemon`` keeps mapping until stopped and ``autostart on`` runs it from boot.

  put NAME TEXT...        put a note in      reading KIND VALUE    put a number about anything in (likes, ohms, ...)
  ingest PATH...          any file or folder find WORDS...         ask the map      about REF   everything about one thing
  similar TEXT...         data like this     near X Y Z RADIUS     marks near a place
  scan --pgm L R          depth from pictures, or --cams 0,1 for live cameras (after ``capture on``)
  sense                   read this computer's sensors (Linux)      place sensor N X Y Z   say where one is
  digest                  make the map smaller and smarter           stats / recent        what the map holds
  capture on|off          allow live cameras (off until you say so)
  daemon [--once]         keep mapping files, sensors, vitals (+ cameras if allowed)   autostart on|off   run it from boot
  timeline [WORDS]        what changed and when: files, programs, connections, drives, camera/mic use (first pass is a baseline)
  files WORDS             find any file or folder on this computer by part of its path
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

from . import atlas_core as core
from . import sensors, vision
from .store import default_home, open_store

NOW = lambda: int(time.time())          # noqa: E731  (tests replace it)
SLEEP = time.sleep
GRAB = None                              # tests replace it; None means ``vision.grab_opencv``

SECRET_RE = re.compile(r"(^\.env|\.pem$|\.key$|\.p12$|\.pfx$|^id_(rsa|dsa|ecdsa|ed25519)|secret|token|passw|credential|"
                       r"\.kdbx$|\.keystore$|wallet)", re.I)
MAX_FILE = 64 << 20
HEAD_TEXT = 1 << 20
MAX_ENTRIES = 5000
MAX_DEPTH = 8
TEXT_EXT = frozenset({"", "txt", "md", "py", "js", "ts", "json", "html", "css", "c", "h", "cpp", "java", "kt", "go", "rs",
                      "sh", "toml", "yaml", "yml", "ini", "cfg", "csv", "rst", "tex", "sql", "xml"})


def _home(args) -> Path:
    return Path(args.home) if args.home else default_home()


def _show(args, out, marks):
    if args.json:
        out(json.dumps(marks, sort_keys=True))
    else:
        for m in marks:
            out(core.describe(m) + (f"  ({m['d']} away)" if "d" in m else ""))
        if not marks:
            out("nothing")


def _config(home: Path) -> dict:
    try:
        d = json.loads((home / "config.json").read_text())
    except (OSError, ValueError):
        d = {}
    return d if isinstance(d, dict) else {}


def _save_json(home: Path, name: str, obj) -> None:
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = home / f".{name}.tmp"
    tmp.write_text(json.dumps(obj, sort_keys=True))
    os.chmod(tmp, 0o600)
    os.replace(tmp, home / name)


# ---- putting things in ------------------------------------------------------------------------------------------

def cmd_put(args, out):
    text = sys.stdin.read() if args.text == ["-"] else " ".join(args.text)
    if not text.strip():
        out("nothing to put in")
        return 2
    m = core.ingest(args.name, text, t=NOW(), space=args.space, ref=args.name)
    open_store(_home(args)).add([m])
    out(json.dumps({"put": [m]}, sort_keys=True) if args.json else f"put in: {core.describe(m)}")
    return 0


def cmd_reading(args, out):
    at = None
    if args.at:
        try:
            at = [int(x) for x in args.at.split(",")]
        except ValueError:
            at = None
        if at is None or len(at) != 3:
            out("--at must be three whole numbers: X,Y,Z")
            return 2
    try:
        m = core.mark(args.kind, at, v=args.value, t=NOW(), label=args.label, ref=args.ref, unit=args.unit, space=args.space)
    except ValueError:
        out("not a valid mark (kind: lowercase letters, digits, - or _; space the same; value a whole number)")
        return 2
    open_store(_home(args)).add([m])
    out(json.dumps({"put": [m]}, sort_keys=True) if args.json else f"put in: {core.describe(m)}")
    return 0


def _read_file(path: Path, size: int):
    """The bytes to place a file by: all of a small text file, the first 1 MiB of a bigger one, or the head and tail of
    a binary. ``None`` if it cannot be read."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        head = os.read(fd, core.SCAN_HEAD)
        if size <= core.SCAN_HEAD + core.SCAN_TAIL and size > len(head):
            head += os.read(fd, size - len(head))
        elif size > core.SCAN_HEAD + core.SCAN_TAIL:
            os.lseek(fd, size - core.SCAN_TAIL, os.SEEK_SET)
            head += os.read(fd, core.SCAN_TAIL)
        return head
    except OSError:
        return None
    finally:
        os.close(fd)


def walk(root: Path, limit: int = MAX_ENTRIES, skip_hidden: bool = False):
    """``(entries, skipped)``: files and folders under ``root`` as ``{"path", "dir", "size", "mtime"}``. Never follows a
    symlink, never leaves the filesystem, never reads a file whose NAME looks like a secret (a name pattern, not a
    classifier). ``skip_hidden`` leaves out names starting with a dot and ``node_modules`` (caches, keys, history)."""
    entries, skipped = [], {"symlink": 0, "secret": 0, "other": 0, "limit": 0}
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode):
        raise NotADirectoryError(str(root))
    stack = [("", 0)]
    while stack:
        rel, depth = stack.pop()
        try:
            found = sorted(os.scandir(root / rel if rel else root), key=lambda e: e.name)
        except OSError:
            skipped["other"] += 1
            continue
        for e in found:
            if len(entries) >= limit:
                skipped["limit"] += 1
                continue
            if skip_hidden and (e.name.startswith(".") or e.name == "node_modules"):
                skipped["other"] += 1
                continue
            if e.is_symlink():
                skipped["symlink"] += 1
                continue
            try:
                s = e.stat(follow_symlinks=False)
            except OSError:
                skipped["other"] += 1
                continue
            path = f"{rel}/{e.name}" if rel else e.name
            if stat.S_ISDIR(s.st_mode):
                if s.st_dev != st.st_dev:
                    continue
                entries.append({"path": path, "dir": True, "size": 0})
                if depth + 1 < MAX_DEPTH:
                    stack.append((path, depth + 1))
            elif stat.S_ISREG(s.st_mode):
                if SECRET_RE.search(e.name):
                    skipped["secret"] += 1
                    continue
                entries.append({"path": path, "dir": False, "size": s.st_size, "mtime": int(s.st_mtime)})
    return entries, skipped


def ingest_dir(store, p: Path, t: int, since: int | None = None, limit: int = MAX_ENTRIES, skip_hidden: bool = False):
    """Map a folder into ``store``: ``(marks added, entries, skipped)``. With ``since`` (seconds), a file's CONTENT is
    only read if it changed at or after that time; the folder structure is always re-marked so places stay stable."""
    entries, skipped = walk(p, limit=limit, skip_hidden=skip_hidden)
    texts, marks = {}, []
    for e in entries:
        if e["dir"]:
            continue
        if since is not None and e.get("mtime", 0) < since:
            continue
        ext = e["path"].rsplit(".", 1)[-1].lower() if "." in e["path"].rsplit("/", 1)[-1] else ""
        data = _read_file(p / e["path"], e["size"]) if e["size"] <= MAX_FILE else None
        if data is None:
            continue
        if ext in TEXT_EXT and core.is_text(data):
            texts[e["path"]] = data[:1500].decode("utf-8", "replace")
        marks.append(core.ingest(e["path"], data, t=t, space="files-text", ref=f"{p.name}/{e['path']}", size=e["size"]))
    marks += core.file_marks(entries, t, space="files", texts=texts)
    return store.add(marks), entries, skipped


def cmd_ingest(args, out):
    notes = []
    say = notes.append if args.json else out
    store, t, total = open_store(_home(args)), NOW(), 0
    for raw in args.paths:
        p = Path(raw)
        try:
            lst = os.lstat(p)
        except OSError as e:
            say(f"{raw}: {e.strerror or 'cannot read'}")
            continue
        if stat.S_ISLNK(lst.st_mode):
            say(f"{raw}: a symlink, not followed")
            continue
        if stat.S_ISDIR(lst.st_mode):
            added, entries, skipped = ingest_dir(store, p, t)
            total += added
            say(f"{raw}: {len(entries)} entries mapped" + "".join(f", {n} {k} skipped" for k, n in skipped.items() if n))
        elif stat.S_ISREG(lst.st_mode):
            if SECRET_RE.search(p.name):
                say(f"{raw}: its name looks like a secret, not read")
                continue
            if lst.st_size > MAX_FILE:
                say(f"{raw}: bigger than 64 MiB, not read")
                continue
            data = _read_file(p, lst.st_size)
            if data is None:
                say(f"{raw}: could not be read")
                continue
            total += store.add([core.ingest(p.name, data, t=t, space="mind", ref=str(p), size=lst.st_size)])
            say(f"{raw}: placed")
        else:
            say(f"{raw}: not a file or folder")
    if args.json:
        out(json.dumps({"marks": total, "notes": notes}, sort_keys=True))
    else:
        out(f"{total} marks put in")
    return 0


# ---- asking -----------------------------------------------------------------------------------------------------

def cmd_find(args, out):
    _show(args, out, open_store(_home(args)).search(text=" ".join(args.words), kind=args.kind or "", space=args.space or "",
                                                  since=args.since, until=args.until, limit=args.limit))
    return 0


def cmd_about(args, out):
    card = open_store(_home(args)).about(args.ref)
    if args.json:
        out(json.dumps(card, sort_keys=True))
    elif not card:
        out(f"nothing about {args.ref!r}")
    else:
        for k, d in sorted(card.items()):
            out(f"{k}: {d['marks']} marks, n={d['n']}, newest {d['latest']}{d['unit']} at t={d['t']} {d['label']}")
    return 0


def cmd_similar(args, out):
    s = open_store(_home(args))
    text = " ".join(args.text)
    got = []
    for sp in ("mind", "files-text"):
        got += s.similar(text, space=sp)
    got.sort(key=lambda m: (m["d"], -m["n"]))
    if args.json:
        out(json.dumps(got[:20], sort_keys=True))
    else:
        for m in got[:20]:
            out(f"{m['d']:>2} bits  n={m['n']}  {m['l']}")
        if not got:
            out("nothing like that")
    return 0


def cmd_near(args, out):
    _show(args, out, open_store(_home(args)).search(near=(args.x, args.y, args.z), radius=args.radius, space=args.space,
                                                  limit=args.limit))
    return 0


def cmd_stats(args, out):
    st = open_store(_home(args)).stats()
    if args.json:
        out(json.dumps(st, sort_keys=True))
    else:
        out(f"{st['marks']} marks; {st['refused']} refused as not valid")
        for k, n in sorted(st["kinds"].items()):
            out(f"  {k}: {n}")
        for k, n in sorted(st["spaces"].items()):
            out(f"  space {k}: {n}")
    return 0


def cmd_recent(args, out):
    _show(args, out, open_store(_home(args)).search(limit=args.limit))
    return 0


def cmd_digest(args, out):
    floors = {}
    for item in args.floor or []:
        k, _, v = item.partition("=")
        try:
            floors[k] = int(v)
        except ValueError:
            out(f"--floor KIND=NUMBER, not {item!r}")
            return 2
    store = open_store(_home(args))
    rep = store.consolidate(now=NOW(), keep_s=args.keep_seconds, floors=floors or None)
    if args.json:
        out(json.dumps(rep, sort_keys=True))
    else:
        out(f"size {rep['before']} -> {rep['after']} characters")
        out(f"raw cells made into regions {rep['voxels_digested']}, noise dropped {rep['noise_dropped']}, "
            f"duplicates folded {rep['duplicates_merged']}, regions {rep['regions']}")
        out("worked out: " + ", ".join(f"{k} {rep[k]}" for k in ("routine", "source", "theme", "hub", "twin", "trend")))
    return 0


# ---- senses -----------------------------------------------------------------------------------------------------

def _rig(args):
    xs = [int(x) for x in args.xs.split(",")]
    pose = [int(x) for x in args.pose.split(",")]
    if len(xs) < 2 or len(set(xs)) != len(xs) or len(pose) != 4:
        raise ValueError("--xs needs two or more different positions; --pose needs X,Y,Z,YAW")
    return {"f": args.focal, "xs": xs, "pose": pose, "voxel": args.voxel}


def cmd_scan(args, out):
    home = _home(args)
    try:
        rig = _rig(args)
    except ValueError as e:
        out(str(e))
        return 2
    store, bg = open_store(home), core.Background(keep=3)
    if args.pgm:
        if len(args.pgm) != len(rig["xs"]):
            out(f"{len(rig['xs'])} cameras (--xs) need {len(rig['xs'])} pictures, one each, reference first")
            return 2
        try:
            pics = [vision.read_pgm(p) for p in args.pgm]
        except (OSError, ValueError) as e:
            out(f"cannot read the pictures: {e}")
            return 2
        w, h = pics[0][0], pics[0][1]
        if any((p[0], p[1]) != (w, h) for p in pics):
            out("the pictures are different sizes: they cannot be compared")
            return 2
        frames = [p[2] for p in pics]
        sets = [{"t": NOW(), "frames": frames} for _ in range(args.learn + 1)]
        marks, sm = vision.analyse(rig, sets, w, h, bg)
        store.add(marks)
        out(f"{sm['pixels']} pixels had a depth, {sm['cells']} cells, {sm['events']} things that moved")
        return 0
    if not args.cams:
        out("give --pgm FILE FILE [...] or --cams 0,1")
        return 2
    if not _config(home).get("capture"):
        out("live cameras are off. Turn them on with `neuroclaw-atlas capture on` (and off again with `neuroclaw-atlas capture off`).")
        return 3
    cams = [int(c) for c in args.cams.split(",")]
    if len(cams) != len(rig["xs"]):
        out(f"{len(rig['xs'])} positions (--xs) for {len(cams)} cameras")
        return 2
    grab = GRAB or vision.grab_opencv
    deadline = NOW() + args.for_seconds
    batches = 0
    try:
        while True:
            try:
                data = grab(cams, args.width, args.height, count=4, every_ms=400)
            except (RuntimeError, ValueError) as e:
                out(f"camera: {e}")
                return 1
            marks, sm = vision.analyse(rig, data["sets"], data["w"], data["h"], bg)
            store.add(marks)
            batches += 1
            out(f"[{batches}] {sm['pixels']} pixels with depth, {sm['cells']} cells, {sm['events']} things that moved"
                + (" (learning the room)" if sm["learning"] else ""))
            if NOW() >= deadline:
                break
            SLEEP(max(1, args.every))
            if NOW() >= deadline:
                break
    except KeyboardInterrupt:
        out("stopped")
    return 0


def sense_marks(home: Path):
    """``(data, pos, marks)``: one sweep of this computer's sensors and the marks it makes (nothing is saved here)."""
    try:
        pos = json.loads((home / "sensors.json").read_text())
    except (OSError, ValueError):
        pos = {}
    if not isinstance(pos, dict):
        pos = {}
    data = sensors.sweep()
    t = data["t"]
    marks = []
    for s in data["sensors"]:
        at = pos.get(str(s["index"]))
        if not (isinstance(at, list) and len(at) == 3 and all(type(c) is int for c in at)):
            at = None
        for r in s["readings"]:
            try:
                marks.append(core.mark(r["kind"], at, v=r["v"], t=t, ref=f"{s['name']}-{s['index']}"[:60], unit=r["unit"]))
            except ValueError:
                continue
    return data, pos, marks


def cmd_sense(args, out):
    home = _home(args)
    data, pos, marks = sense_marks(home)
    if not data["sensors"]:
        out("no sensors found under /sys/bus/iio/devices (Linux only)")
        return 0
    open_store(home).add(marks)
    out(f"{len(data['sensors'])} sensors, {len(marks)} readings saved")
    for s in data["sensors"]:
        out(f"  {s['name']}-{s['index']}: " + ("placed" if str(s["index"]) in pos else "nowhere yet (neuroclaw-atlas place sensor N X Y Z)"))
    return 0


def cmd_place(args, out):
    home = _home(args)
    pos = {}
    try:
        pos = json.loads((home / "sensors.json").read_text())
    except (OSError, ValueError):
        pass
    if not isinstance(pos, dict):
        pos = {}
    pos[str(args.index)] = [args.x, args.y, args.z]
    _save_json(home, "sensors.json", pos)
    out(f"sensor {args.index} is at {args.x},{args.y},{args.z} mm")
    return 0


def cmd_capture(args, out):
    home = _home(args)
    cfg = _config(home)
    if args.state:
        cfg["capture"] = args.state == "on"
        _save_json(home, "config.json", cfg)
    out("live cameras: " + ("on" if cfg.get("capture") else "off"))
    return 0


def _when(t: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t)) + " UTC"


def cmd_timeline(args, out):
    """What changed, newest first. Read-only: it never creates the ledger."""
    from .ledger import Ledger
    lg = Ledger.existing(_home(args))
    rows = lg.timeline(since=args.since, until=args.until, cat=args.cat, op=args.op, words=args.words, limit=args.limit) if lg else []
    if args.json:
        out(json.dumps(rows, sort_keys=True))
    else:
        for r in rows:
            what = f"{r['key']}  {r['info']}".strip() if r["cat"] == "files" else (r["info"] or r["key"])
            out(f"{_when(r['t'])}  {r['cat']:<7} {r['op']:<9} {what}")
        if not rows:
            out("nothing changed" if lg else "no timeline yet (start it with `neuroclaw-atlas autostart on` or `daemon --once`)")
    if lg:
        lg.close()
    return 0


def cmd_files(args, out):
    """Find any file or folder the computer has, by part of its path. Read-only."""
    from .ledger import Ledger
    lg = Ledger.existing(_home(args))
    rows = lg.find_files(args.words, args.limit) if lg else []
    if args.json:
        out(json.dumps(rows, sort_keys=True))
    else:
        for r in rows:
            out(f"{r['path']}{'/' if r['dir'] else ''}  {r['size']} bytes  changed {_when(r['mtime'])}")
        if not rows:
            out("nothing" if lg else "no inventory yet")
    if lg:
        lg.close()
    return 0


def cmd_daemon(args, out):
    from . import daemon
    return daemon.run(_home(args), out, once=args.once)


def cmd_autostart(args, out):
    from . import daemon
    return daemon.autostart(_home(args), args.state, out)


def cmd_prompts(args, out):
    """Map prompts: let the mapper ask the agent for help when the map shows something. ``on``/``off``/``enable``/
    ``disable`` are the owner's switches; ``status`` and ``outbox`` only read."""
    from . import prompts
    home = _home(args)
    act = args.action or "status"
    if act in ("enable", "disable"):
        if not args.rule:
            raise ValueError(f"{act} needs a rule id (see `prompts status`)")
        prompts.set_enabled(home, args.rule, act == "enable")
        out(f"{args.rule}: {'enabled' if act == 'enable' else 'disabled'}")
        return 0
    if args.rule:
        raise ValueError(f"{act} takes no rule id")
    if act in ("on", "off"):
        prompts.set_on(home, act == "on")
        out("map prompts on: the mapper may now ask the agent to help when the map shows something (it only asks; "
            "the agent's approval gate still holds risky tools). `prompts off` stops it." if act == "on" else "map prompts off")
        return 0
    if act == "outbox":
        rows = prompts.read_outbox(home)
        if args.json:
            out(json.dumps(rows, sort_keys=True))
        else:
            for r in rows:
                out(f"{_when(r.get('t', 0))}  #{r['id']}  {r.get('prompt_id', '?')}: {r['message']}")
            if not rows:
                out("nothing waiting")
        return 0
    st = prompts.status(home, NOW())
    if args.json:
        out(json.dumps(st, sort_keys=True))
        return 0
    out(f"map prompts: {'ON' if st['on'] else 'off (turn on with `prompts on`)'}; {st['today']} of {st['max_per_day']} "
        f"asked today; {st['pending']} waiting for the agent")
    for r in st["rules"]:
        last = f", last {_when(r['last_fired'])}" if r["last_fired"] else ""
        out(f"  {r['id']:<18} {'on ' if r['enabled'] else 'off'} {r['title']} (at most every {r['cooldown_minutes']} min{last})")
    for why in st["ignored"]:
        out(f"  ignored: {why}")
    return 0


# ---- the parser -------------------------------------------------------------------------------------------------

def parser():
    p = argparse.ArgumentParser(prog="neuroclaw-atlas", description="A map of anything.")
    p.add_argument("--home", help="where the map lives (default ~/.neuroclaw/atlas)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("put", help="put a note in the map")
    s.add_argument("name")
    s.add_argument("text", nargs="+", help="the text, or - to read it from standard input")
    s.add_argument("--space", default="mind")
    s.set_defaults(fn=cmd_put)

    s = sub.add_parser("reading", help="put a number about anything in the map (likes, ohms, degrees ...)")
    s.add_argument("kind")
    s.add_argument("value", type=int)
    s.add_argument("--at", help="X,Y,Z in whole millimetres, if it has a place")
    s.add_argument("--ref", default="", help="what it is about (video:cats)")
    s.add_argument("--unit", default="")
    s.add_argument("--label", default="")
    s.add_argument("--space", default="world")
    s.set_defaults(fn=cmd_reading)

    s = sub.add_parser("ingest", help="put any file, or a whole folder, in the map")
    s.add_argument("paths", nargs="+")
    s.set_defaults(fn=cmd_ingest)

    s = sub.add_parser("find", help="ask the map: every word must match")
    s.add_argument("words", nargs="*")
    s.add_argument("--kind")
    s.add_argument("--space")
    s.add_argument("--since", type=int)
    s.add_argument("--until", type=int)
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_find)

    s = sub.add_parser("about", help="everything the map holds about one thing")
    s.add_argument("ref")
    s.set_defaults(fn=cmd_about)

    s = sub.add_parser("similar", help="data like this text")
    s.add_argument("text", nargs="+")
    s.set_defaults(fn=cmd_similar)

    s = sub.add_parser("near", help="marks near a place (whole mm)")
    s.add_argument("x", type=int)
    s.add_argument("y", type=int)
    s.add_argument("z", type=int)
    s.add_argument("radius", type=int)
    s.add_argument("--space", default="world")
    s.add_argument("--limit", type=int, default=30)
    s.set_defaults(fn=cmd_near)

    for name, fn, hlp in (("stats", cmd_stats, "what the map holds"), ("recent", cmd_recent, "the newest marks")):
        s = sub.add_parser(name, help=hlp)
        if name == "recent":
            s.add_argument("--limit", type=int, default=20)
        s.set_defaults(fn=fn)

    s = sub.add_parser("digest", help="make the map smaller and smarter")
    s.add_argument("--keep-seconds", type=int, default=3600)
    s.add_argument("--floor", action="append", help="KIND=NUMBER: what clean air (or silence) reads for that sensor kind")
    s.set_defaults(fn=cmd_digest)

    s = sub.add_parser("scan", help="depth from two or more cameras: picture files, or live cameras")
    s.add_argument("--pgm", nargs="+", help="one binary PGM picture per camera, reference camera first")
    s.add_argument("--cams", help="live camera numbers, e.g. 0,1 (needs `neuroclaw-atlas capture on` and opencv)")
    s.add_argument("--focal", type=int, default=120, help="focal length in pixels")
    s.add_argument("--xs", default="0,60", help="camera positions along the baseline in mm, reference first")
    s.add_argument("--pose", default="0,0,0,0", help="X,Y,Z,YAW of the rig in the map")
    s.add_argument("--voxel", type=int, default=100)
    s.add_argument("--width", type=int, default=128)
    s.add_argument("--height", type=int, default=96)
    s.add_argument("--learn", type=int, default=3, help="with --pgm: how many times the room is shown before the look")
    s.add_argument("--for", dest="for_seconds", type=int, default=0, help="keep looking, in the foreground, for this many seconds")
    s.add_argument("--every", type=int, default=30, help="seconds between looks with --for")
    s.set_defaults(fn=cmd_scan)

    s = sub.add_parser("sense", help="read this computer's sensors once")
    s.set_defaults(fn=cmd_sense)

    s = sub.add_parser("place", help="say where a sensor is")
    s.add_argument("what", choices=["sensor"])
    s.add_argument("index", type=int)
    s.add_argument("x", type=int)
    s.add_argument("y", type=int)
    s.add_argument("z", type=int)
    s.set_defaults(fn=cmd_place)

    s = sub.add_parser("capture", help="allow or forbid live cameras")
    s.add_argument("state", nargs="?", choices=["on", "off"])
    s.set_defaults(fn=cmd_capture)

    s = sub.add_parser("timeline", help="what changed on this computer and when (files, programs, connections, drives, camera/mic use)")
    s.add_argument("words", nargs="*", help="only rows whose path or text contains every word")
    s.add_argument("--cat", choices=["files", "process", "net", "mount", "usb", "device"])
    s.add_argument("--op", help="created, modified, deleted, started, stopped, opened, closed, mounted, unmounted, plugged, unplugged")
    s.add_argument("--since", type=int, help="Unix seconds")
    s.add_argument("--until", type=int, help="Unix seconds")
    s.add_argument("--limit", type=int, default=50)
    s.set_defaults(fn=cmd_timeline)

    s = sub.add_parser("files", help="find any file or folder on this computer by part of its path")
    s.add_argument("words", nargs="*")
    s.add_argument("--limit", type=int, default=30)
    s.set_defaults(fn=cmd_files)

    s = sub.add_parser("daemon", help="keep mapping files, sensors, vitals (and cameras if allowed) until stopped")
    s.add_argument("--once", action="store_true", help="one round of everything, then stop")
    s.set_defaults(fn=cmd_daemon)

    s = sub.add_parser("autostart", help="start the daemon at boot (on), stop and remove it (off), or report")
    s.add_argument("state", nargs="?", choices=["on", "off"])
    s.set_defaults(fn=cmd_autostart)

    s = sub.add_parser("prompts", help="map prompts: let the mapper ask the agent for help when the map shows something (off until `on`)")
    s.add_argument("action", nargs="?", choices=["status", "on", "off", "enable", "disable", "outbox"])
    s.add_argument("rule", nargs="?", help="with enable / disable: the rule id")
    s.set_defaults(fn=cmd_prompts)
    return p


def main(argv=None, out=print) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args, out)
    except OSError as e:
        out(f"the map could not be read or saved: {e.strerror or e}")
        return 1
    except ValueError as e:
        out(f"refused: {e}")
        return 2
