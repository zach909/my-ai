/**
 * What kind of computer is this, and how much can it spare right now.
 *
 * The chooser (engine-chooser.ts) needs a handful of plain facts to decide
 * whether this device can run the full AI, should run the smaller quantized
 * one, or should hand the question to a bigger machine: what sort of device it
 * is, how much memory is free, how busy the processor is, how fast it is, and
 * whether it is running on a battery and how much is left.
 *
 * Everything is read from the operating system with Node's own modules. There
 * is no library. Where Node has no API (battery), the OS's own command-line
 * answer is read: /sys/class/power_supply on Linux, `pmset` on macOS and a
 * WMI query on Windows. Each reader is injectable and each parser is a pure
 * function, so tests do not depend on the machine they run on.
 *
 * A client that knows better than this process (a phone's web view can read
 * the real battery and chip; a server process in a container cannot) passes
 * `overrides` and those win. Anything this cannot learn is `null`, never a
 * guess: the chooser treats "unknown" as "no reason to worry", not as "fine".
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";

export type DeviceKind = "phone" | "laptop" | "desktop" | "server" | "unknown";

export interface BatteryState {
  /** 0 (empty) to 1 (full). */
  level: number;
  charging: boolean;
}

export interface DeviceProfile {
  kind: DeviceKind;
  platform: string;
  cores: number;
  totalMemBytes: number;
  freeMemBytes: number;
  /** One-minute load per core: 0 idle, 1 every core busy, above 1 queued. */
  load: number;
  /** Million integer operations per second (compute-share's benchmark), or null when not measured. */
  mops: number | null;
  /** null on a machine with no battery, or when it cannot be read. */
  battery: BatteryState | null;
  /** null when unknown. A client that can tell passes it in. */
  online: boolean | null;
}

/* ------------------------------------------------------------------ parsers */

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** One entry per /sys/class/power_supply/BAT*: its `capacity` and `status` files. */
export function parseLinuxBattery(entries: Array<{ capacity: string; status: string }>): BatteryState | null {
  for (const e of entries) {
    const cap = Number.parseFloat(e.capacity);
    if (!Number.isFinite(cap)) continue;
    const status = e.status.trim().toLowerCase();
    return { level: clamp01(cap / 100), charging: status === "charging" || status === "full" };
  }
  return null;
}

/** `pmset -g batt`, e.g. "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t87%; charging; 0:42 remaining". */
export function parsePmset(out: string): BatteryState | null {
  const m = /(\d{1,3})%;\s*([A-Za-z ]+?)(?:;|$|\s*present)/m.exec(out);
  if (!m || !/InternalBattery/i.test(out)) return null;
  const status = m[2].trim().toLowerCase();
  const onAc = /drawing from 'AC Power'/i.test(out);
  return { level: clamp01(Number(m[1]) / 100), charging: onAc || /^(charging|charged|finishing charge)$/.test(status) };
}

/** Win32_Battery as JSON: an object, an array of them, or empty when there is no battery. */
export function parseWindowsBattery(out: string): BatteryState | null {
  const text = out.trim();
  if (!text) return null;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  const row = (Array.isArray(data) ? data[0] : data) as { EstimatedChargeRemaining?: unknown; BatteryStatus?: unknown } | undefined;
  const pct = Number(row?.EstimatedChargeRemaining);
  if (!row || !Number.isFinite(pct)) return null;
  // 1 discharging, 4 low, 5 critical: running on the battery. Everything else is on mains or charging.
  const status = Number(row.BatteryStatus);
  return { level: clamp01(pct / 100), charging: ![1, 4, 5].includes(status) };
}

/* ------------------------------------------------------------------ readers */

export interface DeviceReaders {
  platform(): string;
  cores(): number;
  totalMem(): number;
  freeMem(): number;
  loadAvg1(): number;
  battery(): Promise<BatteryState | null>;
}

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
    } catch { resolve(""); }
  });
}

async function readBattery(platform: string): Promise<BatteryState | null> {
  try {
    if (platform === "linux" || platform === "android") {
      const base = "/sys/class/power_supply";
      const entries: Array<{ capacity: string; status: string }> = [];
      for (const name of readdirSync(base)) {
        if (!/^BAT/i.test(name)) continue;
        try {
          entries.push({
            capacity: readFileSync(`${base}/${name}/capacity`, "utf8"),
            status: readFileSync(`${base}/${name}/status`, "utf8"),
          });
        } catch { /* a battery with no readable files is skipped */ }
      }
      return parseLinuxBattery(entries);
    }
    if (platform === "darwin") return parsePmset(await run("pmset", ["-g", "batt"]));
    if (platform === "win32") {
      return parseWindowsBattery(await run("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
      ]));
    }
  } catch { /* no battery information is not an error */ }
  return null;
}

export const SYSTEM_READERS: DeviceReaders = {
  platform: () => process.platform,
  cores: () => Math.max(1, os.cpus()?.length ?? 1),
  totalMem: () => os.totalmem(),
  freeMem: () => os.freemem(),
  loadAvg1: () => os.loadavg()[0] ?? 0,
  battery: () => readBattery(process.platform),
};

/* ------------------------------------------------------------------- probe */

export interface ProbeOptions {
  /** compute-share's machineMops(), when the caller has it: the probe never runs a benchmark itself. */
  mops?: number | null;
  /** What a client knows better than this process. Wins over what was read. */
  overrides?: Partial<DeviceProfile>;
  readers?: DeviceReaders;
}

function inferKind(platform: string, battery: BatteryState | null): DeviceKind {
  const forced = (process.env.NEUROCLAW_DEVICE_KIND ?? "").trim().toLowerCase();
  if (forced === "phone" || forced === "laptop" || forced === "desktop" || forced === "server") return forced;
  if (platform === "android" || platform === "ios") return "phone";
  if (battery) return "laptop";
  if (platform === "linux" || platform === "win32" || platform === "darwin") return "desktop";
  return "unknown";
}

export async function probeDevice(opts: ProbeOptions = {}): Promise<DeviceProfile> {
  const r = opts.readers ?? SYSTEM_READERS;
  const cores = Math.max(1, r.cores());
  const platform = r.platform();
  const battery = await r.battery().catch(() => null);
  const base: DeviceProfile = {
    kind: inferKind(platform, battery),
    platform,
    cores,
    totalMemBytes: r.totalMem(),
    freeMemBytes: r.freeMem(),
    load: Math.max(0, r.loadAvg1()) / cores,
    mops: opts.mops ?? null,
    battery,
    online: null,
  };
  return { ...base, ...(opts.overrides ?? {}) };
}
