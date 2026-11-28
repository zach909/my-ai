"""Pictures into the map: depth from two or more cameras, from picture files or live cameras.

Two ways in, both giving the same thing (grey pictures, one per camera, same size):

* **PGM files** (``read_pgm``): no camera, no extra library. Any tool can make them (``ffmpeg -i in.jpg -pix_fmt gray
  out.pgm``). This is how it is tested and how you try it without hardware.
* **Live cameras** (``grab_opencv``): needs ``opencv-python-headless``. Cameras are opened only inside one call and
  released in a ``finally``; no picture is ever written to disk, only the marks made from them.

What it can do and not do is in ``atlas_core.fuse_depth``: the cameras must be side by side, level, looking the same
way, with their spacing and focal length told to it. It does not calibrate them and does not tell who anyone is."""

from __future__ import annotations

import time

from . import atlas_core as core

MAX_SIDE = 4096


def read_pgm(path):
    """``(w, h, [0-255, ...])`` from a binary 8-bit PGM (P5). Raises ``ValueError`` for anything else."""
    with open(path, "rb") as f:
        raw = f.read(MAX_SIDE * MAX_SIDE + 1024)
    tokens, i = [], 0
    while len(tokens) < 4 and i < len(raw):
        while i < len(raw) and raw[i:i + 1].isspace():
            i += 1
        if raw[i:i + 1] == b"#":
            while i < len(raw) and raw[i:i + 1] != b"\n":
                i += 1
            continue
        j = i
        while j < len(raw) and not raw[j:j + 1].isspace():
            j += 1
        tokens.append(raw[i:j])
        i = j
    if len(tokens) < 4 or tokens[0] != b"P5":
        raise ValueError("not a binary PGM (P5) picture")
    try:
        w, h, top = (int(t) for t in tokens[1:4])
    except ValueError:
        raise ValueError("bad PGM header") from None
    if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE) or top != 255:
        raise ValueError("only 8-bit PGM pictures up to 4096 x 4096 are supported")
    data = raw[i + 1:i + 1 + w * h]
    if len(data) != w * h:
        raise ValueError("the picture is shorter than its header says")
    return w, h, list(data)


def write_pgm(path, w, h, data):
    with open(path, "wb") as f:
        f.write(b"P5\n%d %d\n255\n" % (w, h) + bytes(data))


def shrunk_size(w, h, tw, th):
    fx, fy = max(1, -(-w // tw)), max(1, -(-h // th))
    return w // fx, h // fy


def shrink(grey, w, h, tw, th):
    """``grey`` (flat, w x h) averaged down by whole blocks to at most tw x th."""
    fx, fy = max(1, -(-w // tw)), max(1, -(-h // th))
    ow, oh = w // fx, h // fy
    if (fx, fy) == (1, 1):
        return list(grey)
    out, area = [], fx * fy
    for y in range(oh):
        acc = [0] * ow
        for j in range(fy):
            row = grey[(y * fy + j) * w:(y * fy + j) * w + ow * fx]
            for i in range(fx):
                acc = [a + b for a, b in zip(acc, row[i::fx])]
        out.extend(a // area for a in acc)
    return out


def analyse(rig, sets, w, h, bg):
    """What a series of looks adds to the map: ``(marks, summary)``.

    ``rig``: ``{"f": focal length in pixels, "xs": camera positions in mm along the baseline, "pose": [x, y, z, yaw],
    "voxel": mm}``. ``sets``: ``[{"t": seconds, "frames": [grey list per camera]}]``. ``bg`` is the ``Background`` that
    learns the room: nothing counts as new until it has seen ``bg.keep`` looks."""
    vx = rig.get("voxel", 100)
    marks, done, skipped, pixels, events = [], 0, 0, 0, 0
    for s in sets:
        imgs = s["frames"]
        if len(imgs) != len(rig["xs"]) or any(len(i) != w * h for i in imgs):
            skipped += 1
            continue
        zs, votes = core.fuse_depth({"f": rig["f"], "xs": rig["xs"]}, imgs, w, h, max_disp=min(24, w - 1))
        pts = core.project(zs, votes, imgs[0], w, h, {"f": rig["f"]}, tuple(rig.get("pose", (0, 0, 0, 0))), stride=2)
        voxels = core.voxel_marks(pts, vx, s["t"])
        occupied = {tuple(c // vx for c in m["p"]) for m in voxels}
        found = core.blobs(bg.new(occupied), grow=3, min_voxels=6) if len(bg.hist) >= bg.keep else []
        evs = core.event_marks(found, vx, s["t"])
        bg.update(occupied)
        marks += voxels + evs
        done += 1
        pixels += sum(1 for z in zs if z)
        events += len(evs)
    return marks, {"looks": done, "skipped": skipped, "pixels": pixels,
                   "cells": sum(1 for m in marks if m["k"] == "sight"), "events": events,
                   "learning": len(bg.hist) < bg.keep}


def grab_opencv(indices, width, height, count=1, every_ms=0, cv2=None, sleep=time.sleep, now=lambda: int(time.time())):
    """Live pictures: ``count`` looks, one grey picture per camera index, ``every_ms`` apart. The cameras are opened
    first, then read in turn each time (a few milliseconds apart: a fast mover is seen in two places), and released
    whatever happens. Needs ``opencv-python-headless``; without it this raises ``RuntimeError`` saying so."""
    if cv2 is None:
        try:
            import cv2  # type: ignore
        except ImportError:
            raise RuntimeError("live cameras need opencv-python-headless (pip install opencv-python-headless); "
                               "or give picture files with --pgm") from None
    if not 1 <= len(indices) <= 4 or len(set(indices)) != len(indices):
        raise ValueError("between 1 and 4 different cameras")
    caps = []
    try:
        for i in indices:
            cap = cv2.VideoCapture(int(i))
            caps.append(cap)
            if not cap.isOpened():
                raise RuntimeError(f"camera {i} did not open")
        sets, size = [], None
        for n in range(count):
            frames = []
            for cap in caps:
                ok, img = cap.read()
                if not ok:
                    raise RuntimeError("a camera gave no picture")
                grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if getattr(img, "ndim", 2) == 3 else img
                small = cv2.resize(grey, (width, height), interpolation=cv2.INTER_AREA)
                frames.append([int(v) for v in small.reshape(-1)])
                size = (int(small.shape[1]), int(small.shape[0]))
            sets.append({"t": now(), "frames": frames})
            if n + 1 < count and every_ms:
                sleep(every_ms // 1000 if every_ms % 1000 == 0 else every_ms / 1000)
        return {"w": size[0], "h": size[1], "sets": sets}
    finally:
        for cap in caps:
            try:
                cap.release()
            except Exception:
                pass
