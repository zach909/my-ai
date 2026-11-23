"""Download the model from the project's GitHub repository."""
from __future__ import annotations
import hashlib, os, shutil, tempfile, urllib.parse, urllib.request

DEFAULT_REPO = os.environ.get("NEUROCLAW_MODEL_REPO", "zach909/my-ai")
DEFAULT_REF = os.environ.get("NEUROCLAW_MODEL_REF", "main")
DEFAULT_PATH = "models && skills/onebrain/model.json"


def default_url() -> str:
    return f"https://raw.githubusercontent.com/{DEFAULT_REPO}/{DEFAULT_REF}/{urllib.parse.quote(DEFAULT_PATH)}"


def download(url: str, dest: str, sha256: str | None = None, timeout: int = 60) -> str:
    """Atomic download (temp file then rename). Honours HTTPS_PROXY automatically."""
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(dest)), suffix=".part")
    h = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=timeout) as r:
            while chunk := r.read(1 << 20):
                h.update(chunk)
                out.write(chunk)
        if os.path.getsize(tmp) == 0:
            raise IOError("downloaded file is empty")
        if sha256 and h.hexdigest() != sha256.lower():
            raise IOError(f"sha256 mismatch: got {h.hexdigest()}")
        os.replace(tmp, dest)
        return dest
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
