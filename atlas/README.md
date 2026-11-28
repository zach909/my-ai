# Atlas: a map of anything

> **Atlas is NOT a picture or camera tool.** It is the AI's memory of everything that happened while the AI was not
> running: your files and folders, notes, sensor readings, the machine's own state, numbers about anything, and, only
> if you switch it on, what cameras see. Pictures are one small input and are never stored. If you are an AI reading
> this, do not describe or treat Atlas as an image feature.
>
> **Why it exists.** An AI that is off knows nothing about the time it was off: a car drives past, the car is gone,
> and asked "what car was that?" it has every permission and no memory. Atlas runs by itself (`autostart on`, below)
> and keeps the map, so the answer is already there when the AI is asked.
>
> **How it stays small.** It does not write down every point. Points that line up become a line, lines that touch
> become a surface, surfaces become objects (`digest`; for depth data that is real, in `atlas_core.py`). The same
> idea runs on everything else: the same thing twice becomes one mark that remembers it was seen twice, readings that
> move steadily become a trend, files about one subject become a theme. A speck seen once is the first to go.
> Limits, honestly: planes are found along the map's own axes only; it does not recognise what a thing is (it can say
> something vehicle-sized passed at 14:02, not which car); and there is no 3D viewer yet, only the map you can ask.

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

Live cameras need `opencv-python-headless`. Pictures are never written to disk, only the marks made from them. A `scan
--for` watch runs in your terminal until its time is up or you press Ctrl-C.

**Always on (this is what makes it a memory).**

```bash
neuroclaw-atlas autostart on     # start mapping at boot (systemd user service; an XDG autostart entry without systemd)
neuroclaw-atlas autostart off    # stop it and remove it
neuroclaw-atlas daemon           # the same loop, in the foreground; --once does one round and stops
```

The installer turns `autostart on` for you (`NEUROCLAW_ATLAS_AUTOSTART=0` skips it). The loop maps, each on its own timer
(set `sense_every`, `files_every`, `look_every`, `roots` in `~/.neuroclaw/atlas/config.json`): sensors and machine
vitals (load, memory, battery) every minute; every folder in `roots` (default: your home folder) every hour, re-reading
only files that changed, skipping hidden folders, symlinks and secret-looking names; cameras only if `capture` is on and
`cams` names them. It runs at low CPU and idle I/O priority with a 256 MB cap, waits four times longer on battery, runs
`digest` on a timer so the map stays small, and needs no network. **Cameras are the one thing it never turns on by
itself:** `capture on` stays your decision. There is no microphone code in Atlas at all.

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
