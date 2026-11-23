# Atlas: a map of anything

**Put data in space, so redundant data goes away and good data is kept.**

Everything on the map is a *mark*: what kind of thing, where (in whatever space fits), when, how much, and what it is
about. A depth pixel, a whiff of gas, a sound's direction, a temperature, a file, a note, a download, random bytes, or
*how many people liked a video* are all marks. Put in the same thing twice and it folds into one mark that remembers it
was seen twice. What is seen again and again is kept longest; a speck seen once is the first to go. And the whole map
works out what no single mark says: a surface, a routine, where a smell comes from, which files are about the same
subject, which number is rising.

The same core (`atlas_core.py`) runs in the KOS operating system (kernal-os, `docs/ATLAS.md` there has the full idea
and the format); `CORE_SHA256` records which version this is and a test fails if the two drift.

## Use it

```bash
neuroclaw-atlas put recipe espresso machine descaling needs citric acid     # a note
neuroclaw-atlas ingest ~/Documents ~/Downloads/photo.jpg                    # any files, text or not
neuroclaw-atlas reading likes 900 --ref video:cats --unit likes             # a number about anything
neuroclaw-atlas find descaling                                              # ask
neuroclaw-atlas about video:cats                                            # everything about one thing
neuroclaw-atlas similar espresso descaling                                  # data like this
neuroclaw-atlas digest                                                      # smaller and smarter
neuroclaw-atlas --json stats                                                # any command, machine-readable
```

Without the installer: `python3 -m atlas ...` from this folder's parent. Python 3.11+, standard library only.

**Depth from two cameras.** The nearer a thing is, the *more* its two views differ; that difference gives the distance.

```bash
neuroclaw-atlas scan --pgm left.pgm right.pgm --focal 600 --xs 0,60        # from picture files, no camera needed
neuroclaw-atlas capture on                                                 # allow live cameras (they are off)
neuroclaw-atlas scan --cams 0,1 --focal 600 --xs 0,60 --for 600 --every 30 # watch, in the foreground, for 10 minutes
```

Live cameras need `opencv-python-headless`. Pictures are never written to disk, only the marks made from them. A watch
runs in your terminal until its time is up or you press Ctrl-C; the installer starts nothing and schedules nothing.

**Sensors.** `neuroclaw-atlas sense` reads this computer's plain sensors (Linux IIO: temperature, humidity, pressure,
light, gas). Say where each sits (`neuroclaw-atlas place sensor 0 0 0 0`, millimetres) and, with three or more,
`digest` compares them and works out where a smell or a change comes from.

## For an agent

`tool.json` describes ten tools (six read-only, four that change the map) as argument templates over this command line,
all of which print JSON with `--json`. `install.sh` copies it to `config/tools/atlas.json`. **The NeuroClaw runtime that
would load it is not in this repository** (the TypeScript source is missing from it), so what is shipped and tested here is
the description and the command line it points at, not an agent actually calling them.

## What it is not

* **It recognises nobody.** It records that something person-sized moved at a place and a time, never who. A photo is
  placed by its bytes, not by what is in the picture; text by its words (not meaning: "car" and "automobile" are not near).
* **No real camera or sensor was used.** Depth is tested on scenes whose answer is known; the live-camera path against a
  fake `cv2`, sensors against a fake sysfs tree.
* **The map is stored in clear** in `~/.neuroclaw/atlas` (mode 0700). It holds places, times and sizes, not pictures. Put
  it on an encrypted disk if that matters. Event marks (something person-sized moved here at this time) are about people:
  keep them as private as you would a diary, and do not point cameras at people who have not agreed to it.
* Cameras must be side by side, level and looking the same way, with their spacing and focal length told to it; it does not
  calibrate them, handles yaw only, and a flat or repeating surface gets no depth.
* A single point source is assumed for smells and sounds; with its strength unknown two places fit equally and both are
  returned (`alt`).
