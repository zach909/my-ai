"""The ledger: an exact inventory of what this computer touches, and a timeline of what changes.

The map (``atlas_core``) is for meaning and is allowed to forget. The ledger is for facts and does not: every file and
folder (path, size, modified time), and what is running, connected, mounted, plugged in, or holding the camera or
microphone. The FIRST pass over each kind of thing is only a baseline (it records what exists and raises no events).
Every pass after that records only what CHANGED, as one row on a timeline: created, modified, deleted, started,
stopped, opened, closed, plugged, unplugged. So "what changed between 14:00 and 14:10?" and "what was running or
connected when this happened?" have exact answers even if the AI was not running.

Standard library only (``sqlite3``). It stores METADATA ONLY: never file contents, never command lines (they hold
passwords), never pictures or sound. The file is mode 0600 inside the private atlas folder. Disk cost is about 100
bytes per file, so a whole disk is large: ``ledger_max_files`` caps it, and old timeline rows are pruned.

What it cannot see: anything this user may not read (run it as the user, and it sees what the user sees), and
anything that happened and was undone between two passes. A file's change time is its modified time (exact); a
creation or deletion is dated to the pass that noticed it.
"""

from __future__ import annotations

import ipaddress
import os
import sqlite3
import stat
import time
from pathlib import Path

SKIP_TOP = ("/proc", "/sys", "/dev", "/run")
REAL_FS = frozenset({"ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "zfs",
                     "jfs", "reiserfs", "hfsplus", "overlay", "9p"})
PSEUDO_FS = frozenset({"proc", "sysfs", "cgroup", "cgroup2", "devpts", "devtmpfs", "mqueue", "securityfs", "debugfs",
                       "tracefs", "pstore", "bpf", "configfs", "fusectl", "autofs", "binfmt_misc", "hugetlbfs", "nsfs",
                       "rpc_pipefs"})
OPS = {"process": ("started", "stopped"), "net": ("opened", "closed"), "mount": ("mounted", "unmounted"),
       "usb": ("plugged", "unplugged"), "device": ("opened", "closed")}
WATCHED_DEVICES = ("/dev/video", "/dev/snd/", "/dev/media")
COMMIT_EVERY = 5000
TEXT = 300

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, isdir INTEGER, seen INTEGER) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS live(cat TEXT, key TEXT, info TEXT, PRIMARY KEY(cat, key)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, t INTEGER, seen INTEGER, cat TEXT, op TEXT, key TEXT, info TEXT)",
    "CREATE INDEX IF NOT EXISTS ev_t ON events(t)",
    "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID",
)


def _clip(s: str) -> str:
    return "".join(c for c in str(s) if c.isprintable())[:TEXT]


class Ledger:
    def __init__(self, home, readonly: bool = False):
        path = Path(home) / "ledger.sqlite"
        if readonly:
            self.db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        else:
            Path(home).mkdir(parents=True, exist_ok=True, mode=0o700)
            os.close(os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))
            self.db = sqlite3.connect(path)
            self.db.execute("PRAGMA synchronous=NORMAL")
            for s in SCHEMA:
                self.db.execute(s)
            self.db.commit()

    @classmethod
    def existing(cls, home):
        """A read-only ledger, or ``None`` if there is none yet. Asking questions never creates or changes anything."""
        if not (Path(home) / "ledger.sqlite").is_file():
            return None
        try:
            return cls(home, readonly=True)
        except sqlite3.Error:
            return None

    def close(self):
        self.db.close()

    # ---- meta and events --------------------------------------------------------------------------------------
    def _meta(self, k):
        r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else None

    def _set_meta(self, k, v):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))

    def _event(self, t, seen, cat, op, key, info=""):
        self.db.execute("INSERT INTO events(t,seen,cat,op,key,info) VALUES (?,?,?,?,?,?)",
                        (int(t), int(seen), cat, op, _clip(key), _clip(info)))

    # ---- files: baseline once, then only changes -------------------------------------------------------------
    def scan_files(self, roots, now: int, skip=(), max_files: int = 5_000_000, between=None) -> dict:
        """Walk every root (never following a symlink, never crossing into another filesystem). The first ever pass is
        a baseline; later passes add created / modified / deleted events. ``between`` is called every few thousand rows
        so a long walk does not starve the caller's other timers."""
        baseline = self._meta("baseline_files") is None
        pass_id = (self._meta("pass_files") or 0) + 1
        skips = tuple(s.rstrip("/") + "/" for s in skip) + tuple(s + "/" for s in SKIP_TOP)
        counts = {"seen": 0, "created": 0, "modified": 0, "deleted": 0}
        incomplete, scanned = [], []
        total = self.db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        for root in roots:
            try:
                st = os.lstat(root)
            except OSError:
                continue
            if not stat.S_ISDIR(st.st_mode):
                continue
            ok = self._walk(str(root).rstrip("/") or "/", st.st_dev, pass_id, now, baseline, skips, counts, incomplete,
                            max_files - total, between)
            scanned.append(str(root).rstrip("/") + "/")
            if not ok:
                incomplete.append(str(root).rstrip("/") + "/")
        # Deleted: rows under a fully walked root that this pass did not see. A root (or a folder inside one) that could
        # not be read completely is not treated as empty.
        rows = self.db.execute("SELECT path, isdir FROM files WHERE seen<?", (pass_id,)).fetchall()
        gone = []
        for path, isdir in rows:
            if any(path.startswith(s) for s in scanned) and not any(path.startswith(s) for s in incomplete):
                gone.append(path)
                if not baseline:
                    self._event(now, now, "files", "deleted", path, "folder" if isdir else "")
        for i in range(0, len(gone), 500):
            self.db.executemany("DELETE FROM files WHERE path=?", [(p,) for p in gone[i:i + 500]])
        counts["deleted"] = 0 if baseline else len(gone)
        if baseline:
            self._event(now, now, "files", "baseline", "", f"{counts['seen']} entries")
            self._set_meta("baseline_files", now)
        self._set_meta("pass_files", pass_id)
        self.db.commit()
        counts["incomplete"] = len(incomplete)
        return counts

    def _protect(self, prefix, pass_id):
        """Keep a subtree we could not read from looking deleted: mark everything under it as seen."""
        self.db.execute("UPDATE files SET seen=? WHERE path>=? AND path<?", (pass_id, prefix + "/", prefix + "0"))

    def _walk(self, root, dev, pass_id, now, baseline, skips, counts, incomplete, room, between):
        stack = [root]
        new_rows = 0
        ok = True
        while stack:
            d = stack.pop()
            try:
                with os.scandir(d) as it:
                    entries = list(it)
            except OSError:
                self._protect(d.rstrip("/"), pass_id)
                incomplete.append(d.rstrip("/") + "/")
                continue
            for e in entries:
                path = (d.rstrip("/") + "/" + e.name)
                if path.startswith(skips) or path + "/" in skips:
                    continue
                try:
                    if e.is_symlink():
                        continue
                    s = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                isdir = stat.S_ISDIR(s.st_mode)
                if not isdir and not stat.S_ISREG(s.st_mode):
                    continue
                if isdir and s.st_dev != dev:
                    continue
                counts["seen"] += 1
                old = self.db.execute("SELECT size, mtime FROM files WHERE path=?", (path,)).fetchone()
                mt = int(s.st_mtime)
                if old is None:
                    if new_rows >= room:
                        ok = False
                        continue
                    new_rows += 1
                    self.db.execute("INSERT INTO files VALUES (?,?,?,?,?)", (path, s.st_size, mt, int(isdir), pass_id))
                    if not baseline:
                        self._event(min(mt, now) if mt else now, now, "files", "created", path, "folder" if isdir else f"{s.st_size} bytes")
                        counts["created"] += 1
                elif not isdir and (old[0], old[1]) != (s.st_size, mt):
                    self.db.execute("UPDATE files SET size=?, mtime=?, seen=? WHERE path=?", (s.st_size, mt, pass_id, path))
                    self._event(min(mt, now) if mt else now, now, "files", "modified", path, f"{old[0]} -> {s.st_size} bytes")
                    counts["modified"] += 1
                else:
                    self.db.execute("UPDATE files SET seen=? WHERE path=?", (pass_id, path))
                if isdir:
                    stack.append(path)
                if counts["seen"] % COMMIT_EVERY == 0:
                    self.db.commit()
                    if between:
                        between()
        return ok

    # ---- things that are running, connected, mounted, plugged in: baseline once, then appeared / gone ----------
    def sync_live(self, cat: str, current, now: int) -> dict:
        """``current``: ``{key: info}`` of what exists right now, or ``None`` if it could not be read (then nothing is
        concluded). The first call for a ``cat`` is the baseline."""
        if current is None:
            return {"appeared": 0, "gone": 0}
        up, down = OPS[cat]
        baseline = self._meta("baseline_" + cat) is None
        old = dict(self.db.execute("SELECT key, info FROM live WHERE cat=?", (cat,)).fetchall())
        appeared = [k for k in current if k not in old]
        gone = [k for k in old if k not in current]
        for k in appeared:
            self.db.execute("INSERT OR REPLACE INTO live VALUES (?,?,?)", (cat, _clip(k), _clip(current[k])))
            if not baseline:
                self._event(now, now, cat, up, k, current[k])
        for k in gone:
            self.db.execute("DELETE FROM live WHERE cat=? AND key=?", (cat, k))
            if not baseline:
                self._event(now, now, cat, down, k, old[k])
        if baseline:
            self._event(now, now, cat, "baseline", "", f"{len(current)} present")
            self._set_meta("baseline_" + cat, now)
        self.db.commit()
        return {"appeared": 0 if baseline else len(appeared), "gone": 0 if baseline else len(gone)}

    # ---- asking -----------------------------------------------------------------------------------------------
    def timeline(self, since=None, until=None, cat=None, op=None, words=(), limit=50) -> list:
        q, a = "SELECT t, seen, cat, op, key, info FROM events WHERE op!='baseline'", []
        if since is not None:
            q += " AND t>=?"; a.append(since)
        if until is not None:
            q += " AND t<=?"; a.append(until)
        for col, val in (("cat", cat), ("op", op)):
            if val:
                q += f" AND {col}=?"; a.append(val)
        for w in words:
            q += " AND (key LIKE ? ESCAPE '\\' OR info LIKE ? ESCAPE '\\')"
            like = "%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            a += [like, like]
        q += " ORDER BY t DESC, id DESC LIMIT ?"
        a.append(max(1, min(int(limit), 1000)))
        return [{"t": r[0], "seen": r[1], "cat": r[2], "op": r[3], "key": r[4], "info": r[5]}
                for r in self.db.execute(q, a).fetchall()]

    def last_event_id(self) -> int:
        """The newest timeline row's number, or 0 if there is none (map prompts follow the timeline by this number)."""
        return self.db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]

    def events_after(self, event_id: int, limit: int = 500) -> list:
        """Timeline rows newer than ``event_id``, oldest first, with their numbers. Baseline markers are left out."""
        rows = self.db.execute("SELECT id, t, seen, cat, op, key, info FROM events WHERE id>? AND op!='baseline' "
                               "ORDER BY id LIMIT ?", (int(event_id), max(1, min(int(limit), 5000)))).fetchall()
        return [{"id": r[0], "t": r[1], "seen": r[2], "cat": r[3], "op": r[4], "key": r[5], "info": r[6]} for r in rows]

    def find_files(self, words, limit=30) -> list:
        q, a = "SELECT path, size, mtime, isdir FROM files WHERE 1", []
        for w in words:
            q += " AND path LIKE ? ESCAPE '\\'"
            a.append("%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        q += " LIMIT ?"
        a.append(max(1, min(int(limit), 1000)))
        return [{"path": r[0], "size": r[1], "mtime": r[2], "dir": bool(r[3])} for r in self.db.execute(q, a).fetchall()]

    def stats(self) -> dict:
        one = lambda q: self.db.execute(q).fetchone()[0]  # noqa: E731
        return {"files": one("SELECT COUNT(*) FROM files WHERE isdir=0"), "folders": one("SELECT COUNT(*) FROM files WHERE isdir=1"),
                "events": one("SELECT COUNT(*) FROM events WHERE op!='baseline'"),
                "live": dict(self.db.execute("SELECT cat, COUNT(*) FROM live GROUP BY cat").fetchall()),
                "baseline": dict(self.db.execute("SELECT k, v FROM meta WHERE k LIKE 'baseline_%'").fetchall())}

    def prune(self, now: int, keep_days: int = 90, max_events: int = 2_000_000) -> int:
        """Keep the timeline bounded: drop rows older than ``keep_days`` and, past ``max_events``, the oldest."""
        n = self.db.execute("DELETE FROM events WHERE t<?", (now - keep_days * 86400,)).rowcount
        over = self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0] - max_events
        if over > 0:
            n += self.db.execute("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY t LIMIT ?)", (over,)).rowcount
        self.db.commit()
        return n


# ---- what exists right now (each returns ``{key: info}`` or ``None`` if it cannot be read) ------------------------

def _read(p: Path) -> str | None:
    try:
        return p.read_text(errors="replace")
    except OSError:
        return None


def real_mounts(proc: Path = Path("/proc")) -> list:
    """Mount points of real storage (disks, USB sticks, network shares that behave like disks), not virtual ones."""
    text = _read(proc / "mounts")
    out = []
    for line in (text or "").splitlines():
        f = line.split()
        if len(f) >= 3 and f[2] in REAL_FS:
            mp = f[1].replace("\\040", " ")
            if not mp.startswith(tuple(s + "/" for s in SKIP_TOP)) and mp not in SKIP_TOP:
                out.append(mp)
    return sorted(set(out)) or ["/"]


def probe_mounts(proc: Path = Path("/proc")):
    text = _read(proc / "mounts")
    if text is None:
        return None
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) >= 3 and f[2] not in PSEUDO_FS:
            out[f[1].replace("\\040", " ")] = f"{f[0]} {f[2]}"
    return out


def _proc_pids(proc: Path):
    try:
        return [n for n in os.listdir(proc) if n.isdigit()]
    except OSError:
        return None


def probe_processes(proc: Path = Path("/proc")):
    """Running programs by pid and start time, as name and program path. Never the command line (it may hold secrets)."""
    pids = _proc_pids(proc)
    if pids is None:
        return None
    out = {}
    for pid in pids:
        text = _read(proc / pid / "stat")
        if not text or ")" not in text:
            continue
        rest = text.rsplit(")", 1)[1].split()
        try:
            if int(rest[6]) & 0x200000:          # a kernel thread
                continue
            start = rest[19]
        except (IndexError, ValueError):
            continue
        comm = text[text.find("(") + 1:text.rfind(")")]
        try:
            exe = os.readlink(proc / pid / "exe")
        except OSError:
            exe = ""
        out[f"{pid}:{start}"] = f"{comm} {exe}".strip()
    return out


def _addr(hexaddr: str) -> str:
    ip, _, port = hexaddr.partition(":")
    b = bytes.fromhex(ip)
    if len(b) == 4:
        host = str(ipaddress.IPv4Address(b[::-1]))
    else:
        host = "[" + str(ipaddress.IPv6Address(b"".join(b[i:i + 4][::-1] for i in range(0, 16, 4)))) + "]"
    return f"{host}:{int(port, 16)}"


def probe_net(proc: Path = Path("/proc")):
    """Programs listening, and the remote machines this computer is connected to (by remote address: many connections
    to one place count once)."""
    out, read_any = {}, False
    for name in ("tcp", "tcp6", "udp", "udp6"):
        text = _read(proc / "net" / name)
        if text is None:
            continue
        read_any = True
        for line in text.splitlines()[1:]:
            f = line.split()
            if len(f) < 4:
                continue
            try:
                local, remote, st = _addr(f[1]), _addr(f[2]), f[3]
            except (ValueError, OSError):
                continue
            proto = name.rstrip("6")
            if proto == "tcp" and st == "0A":
                out[f"{proto} listen {local}"] = f"listening on {local}"
            elif proto == "tcp" and st == "01":
                out[f"{proto} {remote}"] = f"connected to {remote}"
            elif proto == "udp" and not f[1].endswith(":0000"):          # a bound port, not an unbound socket
                out[f"{proto} listen {local}"] = f"listening on {local}"
    return out if read_any else None


def probe_usb(sys_root: Path = Path("/sys")):
    base = sys_root / "bus" / "usb" / "devices"
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return None
    out = {}
    for n in names:
        vid = _read(base / n / "idVendor")
        if vid is None:
            continue
        pid = (_read(base / n / "idProduct") or "").strip()
        label = " ".join(x.strip() for x in (_read(base / n / "manufacturer") or "", _read(base / n / "product") or "") if x.strip())
        out[n] = f"{vid.strip()}:{pid} {label}".strip()
    return out


def probe_devices(proc: Path = Path("/proc")):
    """Which program has the camera, microphone or sound card open right now (what the fd points at, nothing more)."""
    pids = _proc_pids(proc)
    if pids is None:
        return None
    out = {}
    for pid in pids:
        try:
            fds = os.listdir(proc / pid / "fd")
        except OSError:
            continue
        seen = set()
        for fd in fds:
            try:
                target = os.readlink(proc / pid / "fd" / fd)
            except OSError:
                continue
            if target.startswith(WATCHED_DEVICES) and target not in seen:
                seen.add(target)
                comm = (_read(proc / pid / "comm") or "?").strip()
                out[f"{pid}:{target}"] = f"{comm} has {target} open"
    return out


LIVE_PROBES = {"process": probe_processes, "net": probe_net, "mount": probe_mounts, "usb": probe_usb, "device": probe_devices}
