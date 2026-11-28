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

**Everything the computer touches, then only what changes.** On its first pass the daemon records a baseline of every
file and folder on every real disk, what is running, who is listening or connected on the network, what is mounted or
plugged into USB, and which program has the camera or microphone open. It raises no events for that baseline. After
it, only changes are recorded, each with a time:

```bash
neuroclaw-atlas timeline                     # what changed, newest first
neuroclaw-atlas timeline report --cat files  # only files, only paths containing "report"
neuroclaw-atlas timeline --cat device        # who had the camera or microphone open, and when
neuroclaw-atlas timeline --since 1795819000 --until 1795819600
neuroclaw-atlas files invoice                # find any file on the computer by part of its path
```

This lives in `ledger.sqlite` (standard-library `sqlite3`, mode 0600, in the atlas folder) beside the map, because the
map is allowed to forget and a timeline must not. It stores **metadata only**: no file contents, no command lines (they
can hold passwords), no pictures, no sound. A file change is dated by its own modified time; a creation or deletion by
the pass that noticed it. It runs as **you**, so it sees what you can read, not other users' files or processes; a
system-wide view would need a root service, which the installer will not set up for you. Cost: about 90 bytes per file
(a 93,000-file test took 1.7 s the first time and 0.7 s after, 8 MB), so a whole disk is hundreds of megabytes:
`ledger_max_files` (default 5,000,000) caps it and `timeline_keep_days` (default 90) prunes old rows. Set
`"ledger": false`, or `"watch_roots": ["/home"]`, in `config.json` to narrow it. Hidden folders are included in the
ledger (it records that they exist and change); only the content mapping above skips them.

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

## Map prompts: the mapper asks the agent for help by itself

The daemon already sees a low battery, a drive being plugged in, a program opening the camera, a folder filling with
files. A *map prompt* is a standing rule: **when the map shows this, ask the agent to do that**, so nobody has to notice
first. When a rule matches, the daemon queues one request (`<atlas home>/prompts/outbox.jsonl`); the NeuroClaw backend
(`models && skills/core/map-prompts.ts`) hands it to the agent by the same path as a typed message.

```bash
neuroclaw-atlas prompts            # is it on, how many were asked today, every rule and when it last fired
neuroclaw-atlas prompts off        # the owner's switch (it is ON by default)
neuroclaw-atlas prompts disable memory-high     # one rule off (enable turns it back on)
neuroclaw-atlas prompts outbox     # what is waiting for the agent
```

| Rule | Fires when | At most every |
|---|---|---|
| `battery-low` | battery 15% or less and the charger is not connected | 3 h |
| `memory-high` | memory 92% used or more | 2 h |
| `disk-low` | the disk the map lives on has 5% free or less | 12 h |
| `drive-plugged` | a USB device was plugged in | 10 min |
| `camera-mic-opened` | a program opened the camera, microphone or sound card | 30 min |
| `files-burst` | 25 or more new files appeared in one folder (between two whole-disk passes) | 6 h |

Add your own under `map_prompts.custom` in `config.json`. A rule names its conditions (every one must hold), the
instruction, and a cooldown in minutes (5 or more):

```json
{"map_prompts": {"max_per_day": 6, "custom": [
  {"id": "invoices", "title": "An invoice appeared",
   "when": {"event": {"cat": "files", "op": "created", "contains": "invoice"}},
   "prompt": "A new invoice file appeared. Tell me what it is and offer to file it.", "cooldown_minutes": 30}]}}
```

Conditions: `battery_below`, `memory_above`, `disk_free_below` (whole percent, inclusive), `unplugged` (true/false),
`event` (`cat`, `op`, optional `contains`: a timeline change, see `timeline`), `burst` (`cat`, `op`, `count`: that many
of one change under one folder). A bad rule is ignored and `prompts` says why.

**What keeps it safe.** A prompt that launches work on its own is a dangerous capability, so:

* **On by default, and the owner can stop it** (`prompts off`; it stays off). The agent never changes the switch, and `tool.json` has no tool that does (it has a
  read-only `atlas_prompts`, so the agent can see why a message was sent).
* **It only asks.** The request goes to the agent's normal path, so its approval gate still holds every risky tool
  (terminal, email, files) until the owner decides, whether or not anyone is there. Every built-in instruction says to
  ask before closing, moving or deleting anything.
* **Bounded.** A cooldown per rule (never under 5 minutes), a daily cap (default 6, at most 24), an outbox of the newest
  50, 3 delivered per minute, and a request older than 6 hours is dropped, not run.
* **What the computer reported is data.** File names, device labels and program names can be written by anyone. They
  are cleaned and put in the request as a quoted JSON list after a sentence saying it is data, never spliced into the
  instruction.
* **Only changes fire it.** The first look starts from now and raises nothing for what is already there (turning it back on does the same); events older
  than a day are ignored.
* **At most once.** A request is marked delivered before it runs, so one that crashes the agent is never repeated.
  Outcomes (not message text) are kept in `~/.neuroclaw/map-prompts.json`.
* `NEUROCLAW_MAP_PROMPTS=0` stops the backend delivering, whatever the mapper queues.

**Limits, honestly.** The mapper does not understand anything: it checks conditions and sends the instruction written
for them, and what the agent does with it is only as good as the agent. It runs where the daemon runs (Linux
`/proc` and `/sys`). Requests wait only while the backend is off and are dropped after 6 hours. There is no page for
the history yet (the file above, and Settings, where the approval queue already shows what is held). Delivery goes to
the owner only: the map is the owner's computer.

## For an agent

`tool.json` describes thirteen tools (nine read-only, four that change the map) as argument templates over this command line,
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
