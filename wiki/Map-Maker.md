# Map Maker (also: Compression Map, Sensory Integration)

Map Maker is the always-on map of the whole system. It is the existing `ArchitectureMapper`
(`models && skills/core/architecture-mapper.ts`), which keeps the components, how data flows between them, and the
bottlenecks and waste found in them. The owner's other names for it are **Compression Map** and **Sensory Integration**.

> **Open question:** the owner has not yet confirmed that Map Maker means the architecture mapper, and not
> `context-compressor.ts` or something new. This page and the code below assume the architecture mapper.

## Always on

- The map is built when the system starts and is kept current by `trackCall()`, which records every measured call
  (latency, CPU, memory, errors) into the matching component.
- `NeuroclawSystem.autoMapTick()` (`src/index.ts`) refreshes the bottleneck and waste analysis. It runs once at start and
  then every 60 seconds in the background.
- **Idle costs nothing.** A refresh does nothing when no call was measured since the last one, so a quiet app does no work.
  The timer is `unref`'d, so it never keeps the process alive.
- **No disk writes.** The map lives in memory only; nothing is logged or saved by the refresh.
- `mapStatus()` returns when the map last refreshed and how many times.
- Settings: `NEUROCLAW_AUTOMAP=0` turns the background refresh off; `NEUROCLAW_AUTOMAP_INTERVAL_MS` changes the 60-second
  interval. The timer is not started under tests (`VITEST`), like the curiosity timer.

## Not done

- The map covers the system's own components. It does not map the outside world through a microphone, camera or other
  sensors; that would be a separate feature and needs the owner's design.
- The refresh is not yet slower on battery. It already does no work when idle; a battery-aware interval needs a way to read
  the battery state, which is not wired in.
- No test covers `autoMapTick()` yet. The type check and test runner were not installed where this was written, so the change
  was only parse-checked.
