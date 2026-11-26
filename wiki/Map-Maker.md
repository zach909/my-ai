# Map Maker (also: Compression Map, Sensory Integration)

> **Status: design only. Nothing in this page is built yet.** It records what the owner has said so far. No file in the repo
> implements it; check `git grep -i "map maker"` before treating any of this as real.

## What it is

One component with three names: **Map Maker**, **Compression Map** and **Sensory Integration**. Map Maker is the name to use.

## What the owner has decided

- **Always on.** Mapping is not a switch the user turns on. It runs whenever the app runs.
- **A new feature**, not a rename of existing code.

## Not decided yet (needs the owner)

- What it takes in (microphone, camera, files, the phone's sensors, or all of them) and what it produces.
- Where its output goes: into the mesh through the Zip Loop doorway ports ([[Zip-IO]]), or somewhere else.

## Rules it must follow once built

These come from `CLAUDE.md` and `AGENTS.md`, not from a new decision:

- **No third-party code and no tokenizer.** Raw bits enter the mesh through the Zip Loop; Node built-ins and the Python standard library only.
- **Always on must still be cheap.** Event-driven rather than polled, bounded memory (a circular buffer like the Zip Loop's), and lower background work on battery. The phone matters most.
- **One permission gate.** Microphone, camera and other sensors go through the existing access permissions with explicit grants.
