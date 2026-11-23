"""A folder as the map's backend, with the guarantees the map relies on.

* Every write is atomic: the text goes to a temporary file in the same folder and is moved into place, so a crash
  leaves the old chunk or the new one, never half of one.
* The folder is private to the user (mode 0700, files 0600) and never follows a symlink: a chunk that is a symlink is
  not read, and is not written through.
* A write that fails returns ``False`` (the map then raises ``OSError`` and loses nothing: see ``atlas_core``).
* Keys are plain names (``c.world.3_-2_0``, ``index``); anything else is refused, so a hostile key cannot leave the folder.

The map is stored in clear text, readable by anyone who can read the folder: it holds places, times and sizes of what
was seen, not pictures. Put the folder on an encrypted disk if that matters to you."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

from . import atlas_core as core

KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def default_home() -> Path:
    return Path(os.environ.get("NEUROCLAW_ATLAS_HOME") or Path.home() / ".neuroclaw" / "atlas")


class DirBackend:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass

    def _path(self, key: str) -> Path:
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ValueError("bad key")
        return self.root / key

    def keys(self) -> list:
        try:
            return sorted(n for n in os.listdir(self.root) if KEY_RE.match(n) and not (self.root / n).is_symlink())
        except OSError:
            return []

    def get(self, key: str):
        p = self._path(key)
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            return None
        try:
            with os.fdopen(fd, "rb") as f:
                return f.read(core.MAX_CHUNK_CHARS * 4 + 1).decode("utf-8", "replace")
        except OSError:
            return None

    def put(self, key: str, text: str) -> bool:
        p = self._path(key)
        try:
            if p.is_symlink():
                return False
            fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=self.root)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(text.encode("utf-8"))
                    f.flush()
                    os.fsync(f.fileno())
                os.chmod(tmp, 0o600)
                os.replace(tmp, p)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            return True
        except OSError:
            return False

    def delete(self, key: str) -> bool:
        try:
            p = self._path(key)
            if p.is_symlink():
                return False
            p.unlink()
            return True
        except (OSError, ValueError):
            return False


def open_store(home=None, **kw) -> "core.MarkStore":
    """The map in ``home`` (default ``~/.neuroclaw/atlas``). A folder has no 500-item limit, so it keeps more chunks."""
    kw.setdefault("max_chunks", 5000)
    return core.MarkStore(DirBackend(home or default_home()), **kw)
