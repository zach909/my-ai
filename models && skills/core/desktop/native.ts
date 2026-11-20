/**
 * Native desktop backends for Windows and macOS: the graphical button-clicker layer, using only what each
 * operating system already ships.
 *
 *   Windows  powershell.exe with the .NET (System.Windows.Forms, System.Drawing) and Win32 (user32.dll) calls
 *            Windows itself provides. No module, no download.
 *   macOS    osascript (System Events and the CoreGraphics calls JavaScript for Automation can reach) and
 *            /usr/sbin/screencapture. No helper program, no download.
 *
 * The same rules as the Linux backends hold, and they are enforced twice, here and in DesktopControl:
 *  - the agent only touches windows it opened itself (a window belongs to the agent when its process id is in
 *    `agentPids`, filled by DesktopControl.launchAgentWindow); every other window is observe-only;
 *  - input goes only to a window that has been brought to the front AND confirmed to be in front; if focus did
 *    not take, nothing is sent;
 *  - a click outside the window is refused.
 *
 * Nothing the model writes is ever part of a script. Each script below is a fixed constant; the operation and
 * its values (window id, text, coordinates) reach it through environment variables.
 *
 * HONEST LIMITS. Written against each system's documented behaviour and tested here with a stand-in runner for
 * what is sent and how errors are reported. It has NOT been run on a real Windows or macOS desktop from the
 * environment it was written in. Known limits: Windows may refuse to let a background program take focus (the
 * backend then sends nothing and says so); Windows reports pixel positions in the DPI the process sees; macOS
 * asks the user for Accessibility (to list, type and click) and Screen Recording (to capture) the first time,
 * and a Store app on Windows or an app started through `open` on macOS runs under a different process id, so
 * it counts as the user's window and stays observe-only.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopError } from "./errors.js";
import type { BackendKind, BackendReport, DesktopBackend, DesktopFeature, RawWindow, Region } from "./backends.js";

/** Process ids of programs the agent started itself. A window whose process is in here is the agent's. */
export const agentPids = new Set<number>();

export interface NativeRunResult { status: number | null; stdout: string; stderr: string; error?: string }
export type NativeRun = (file: string, args: string[], env?: Record<string, string>) => Promise<NativeRunResult>;

/** The real runner: no shell, a time limit, room for a base64 screenshot, no console window on Windows. */
export const realNativeRun: NativeRun = (file, args, env = {}) => new Promise((resolve) => {
  execFile(file, args, {
    encoding: "utf8", timeout: 30000, maxBuffer: 96 * 1024 * 1024, windowsHide: true, shell: false,
    env: { ...process.env, ...env },
  }, (err, stdout, stderr) => {
    if (!err) return resolve({ status: 0, stdout, stderr });
    const e = err as NodeJS.ErrnoException & { code?: number | string };
    if (e.code === "ENOENT") return resolve({ status: null, stdout: "", stderr: "", error: `${file} is not on this computer.` });
    resolve({ status: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "", error: typeof e.code === "number" ? undefined : e.message });
  });
});

const ALL_OFF = (): Record<DesktopFeature, boolean> => ({ windows: false, screenshot: false, keyboard: false, pointer: false, moveResize: false, settings: false, launch: false });

const WINDOW_ID = /^[0-9]{1,20}$/;
const MAC_WINDOW_ID = /^([0-9]{1,10}):([0-9]{1,4})$/;

function clean(text: string): string {
  return text.replace(/\r/g, "").replace(/#< CLIXML[\s\S]*$/m, "").trim().split("\n").filter(Boolean).slice(0, 4).join(" ").slice(0, 400);
}

// ── Windows ───────────────────────────────────────────────────────────────

/** SendKeys treats + ^ % ~ ( ) { } [ ] as commands; wrap each so it is typed literally, and turn line ends into Enter. */
export function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, "{ENTER}").replace(/\t/g, "{TAB}");
}

/** One fixed script. OSAI_OP picks the operation; OSAI_* carry its values. Never built from request text. */
export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OsaiWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@
function Get-Own([string]$id, [string]$owner) {
  $h = New-Object IntPtr ([int64]$id)
  if (-not [OsaiWin]::IsWindow($h)) { throw "No window with id $id." }
  $p = [uint32]0
  [void][OsaiWin]::GetWindowThreadProcessId($h, [ref]$p)
  if ([string]$p -ne $owner) { throw "Window $id does not belong to the program the agent started." }
  return $h
}
function Set-Front($h) {
  [void][OsaiWin]::ShowWindow($h, 9)
  [OsaiWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [OsaiWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][OsaiWin]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 150
  if ([OsaiWin]::GetForegroundWindow().ToInt64() -ne $h.ToInt64()) { throw 'The window did not come to the front, so nothing was sent.' }
}
switch ($env:OSAI_OP) {
  'probe' { Write-Output ('ok ' + $PSVersionTable.PSVersion.ToString()) }
  'list' {
    $r = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
      [pscustomobject]@{ id = [string]$_.MainWindowHandle.ToInt64(); pid = [int]$_.Id; title = [string]$_.MainWindowTitle } })
    Write-Output (ConvertTo-Json -InputObject $r -Compress)
  }
  'screenshot' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $b.X; $y = $b.Y; $w = $b.Width; $ht = $b.Height
    if ($env:OSAI_REGION) { $v = $env:OSAI_REGION.Split(','); $x = [int]$v[0]; $y = [int]$v[1]; $w = [int]$v[2]; $ht = [int]$v[3] }
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ([Convert]::ToBase64String($ms.ToArray()))
  }
  'type' {
    $h = Get-Own $env:OSAI_ID $env:OSAI_OWNER
    Set-Front $h
    [System.Windows.Forms.SendKeys]::SendWait($env:OSAI_TEXT)
  }
  'click' {
    $h = Get-Own $env:OSAI_ID $env:OSAI_OWNER
    $rc = New-Object OsaiWin+RECT
    [void][OsaiWin]::GetWindowRect($h, [ref]$rc)
    $px = [int]$env:OSAI_X; $py = [int]$env:OSAI_Y
    $ww = $rc.Right - $rc.Left; $wh = $rc.Bottom - $rc.Top
    if ($px -lt 0 -or $py -lt 0 -or $px -ge $ww -or $py -ge $wh) {
      $msg = "($px, $py) is outside window " + $env:OSAI_ID + ", which is " + $ww + "x" + $wh + "."
      throw $msg
    }
    Set-Front $h
    [void][OsaiWin]::SetCursorPos($rc.Left + $px, $rc.Top + $py)
    $down = 0x2; $up = 0x4
    if ($env:OSAI_BUTTON -eq '2') { $down = 0x20; $up = 0x40 }
    if ($env:OSAI_BUTTON -eq '3') { $down = 0x8; $up = 0x10 }
    [OsaiWin]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [OsaiWin]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  }
  'move' {
    $h = Get-Own $env:OSAI_ID $env:OSAI_OWNER
    [void][OsaiWin]::MoveWindow($h, [int]$env:OSAI_X, [int]$env:OSAI_Y, [int]$env:OSAI_W, [int]$env:OSAI_H, $true)
  }
  'close' {
    $h = Get-Own $env:OSAI_ID $env:OSAI_OWNER
    [void][OsaiWin]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  default { throw "Unknown operation $($env:OSAI_OP)." }
}
`;

export class WindowsBackend implements DesktopBackend {
  readonly kind: BackendKind = "windows";
  private encoded: string | null = null;

  constructor(private readonly run: NativeRun = realNativeRun, private readonly pids: Set<number> = agentPids) {}

  private async ps(op: string, env: Record<string, string> = {}): Promise<string> {
    this.encoded ??= Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
    const r = await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", this.encoded], { OSAI_OP: op, ...env });
    if (r.error) throw new DesktopError(r.error);
    if (r.status !== 0) throw new DesktopError(clean(r.stderr || r.stdout) || `PowerShell failed (${r.status}).`);
    return r.stdout;
  }

  async describe(): Promise<BackendReport> {
    try {
      await this.ps("probe");
    } catch (e) {
      return { reachable: false, notes: [`PowerShell could not be used: ${(e as Error).message}`], platform: "windows", features: ALL_OFF() };
    }
    return {
      reachable: true,
      platform: "windows",
      notes: [
        "Windows: only windows of programs the agent started itself can be driven; a Store app starts through a helper and counts as the user's.",
        "Windows may refuse to let a background program take focus; if it does, nothing is typed or clicked and the error says so.",
      ],
      features: { windows: true, screenshot: true, keyboard: true, pointer: true, moveResize: true, settings: false, launch: true },
    };
  }

  async listWindows(): Promise<RawWindow[]> {
    const out = (await this.ps("list")).trim();
    let rows: Array<{ id: string; pid: number; title: string }>;
    try { rows = out ? JSON.parse(out) : []; } catch { throw new DesktopError("Windows returned a window list this layer could not read."); }
    return (Array.isArray(rows) ? rows : [rows]).map((w) => ({
      id: String(w.id), desktop: "0", pid: Number(w.pid), host: os.hostname(), title: String(w.title ?? ""), owned: this.pids.has(Number(w.pid)),
    }));
  }

  async screenshot(region?: Region): Promise<Buffer> {
    const env: Record<string, string> = {};
    if (region) env.OSAI_REGION = [region.x, region.y, region.width, region.height].map((n) => Math.trunc(Number(n))).join(",");
    const b64 = (await this.ps("screenshot", env)).trim();
    const png = Buffer.from(b64, "base64");
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new DesktopError("The screenshot came back empty.");
    return png;
  }

  /** The agent's own window with this id, or an error. Checked again here so no caller can skip it. */
  private async own(windowId: string): Promise<RawWindow> {
    if (!WINDOW_ID.test(windowId)) throw new DesktopError(`"${windowId.slice(0, 40)}" is not a window id.`);
    const w = (await this.listWindows()).find((x) => x.id === windowId);
    if (!w) throw new DesktopError(`No window with id ${windowId}.`);
    if (!w.owned) throw new DesktopError(`Window ${windowId} ("${w.title}") belongs to the user. The agent can observe it but not control it.`);
    return w;
  }

  async typeInto(windowId: string, text: string): Promise<void> {
    const w = await this.own(windowId);
    await this.ps("type", { OSAI_ID: windowId, OSAI_OWNER: String(w.pid), OSAI_TEXT: sendKeysEscape(text) });
  }

  async clickIn(windowId: string, x: number, y: number, button: number): Promise<void> {
    const w = await this.own(windowId);
    await this.ps("click", { OSAI_ID: windowId, OSAI_OWNER: String(w.pid), OSAI_X: String(Math.trunc(x)), OSAI_Y: String(Math.trunc(y)), OSAI_BUTTON: String([1, 2, 3].includes(button) ? button : 1) });
  }

  async moveWindow(windowId: string, x: number, y: number, width: number, height: number): Promise<void> {
    const w = await this.own(windowId);
    await this.ps("move", { OSAI_ID: windowId, OSAI_OWNER: String(w.pid), OSAI_X: String(Math.trunc(x)), OSAI_Y: String(Math.trunc(y)), OSAI_W: String(Math.trunc(width)), OSAI_H: String(Math.trunc(height)) });
  }

  async closeWindow(windowId: string): Promise<void> {
    const w = await this.own(windowId);
    await this.ps("close", { OSAI_ID: windowId, OSAI_OWNER: String(w.pid) });
  }

  async readSetting(): Promise<string> {
    throw new DesktopError("Reading desktop settings is not offered on Windows.");
  }
}

// ── macOS ─────────────────────────────────────────────────────────────────

/** One fixed JavaScript-for-Automation script. OSAI_OP picks the operation; OSAI_* carry its values. */
export const MAC_SCRIPT = String.raw`
// Bracket form on purpose: the packaging scan would read the dotted form inside this text as a package import.
ObjC['import']('Foundation');
ObjC['import']('CoreGraphics');
const env = $.NSProcessInfo.processInfo.environment;
const get = (k) => { const v = env.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); };
const se = Application('System Events');
const me = Application.currentApplication();
me.includeStandardAdditions = true;
function proc(pid) {
  const found = se.processes.whose({ unixId: pid })();
  if (!found.length) throw new Error('No program with process id ' + pid + '.');
  return found[0];
}
function win(p, index) {
  const ws = p.windows();
  if (index < 1 || index > ws.length) throw new Error('No window ' + index + ' in that program.');
  return ws[index - 1];
}
function toFront(p, w) {
  p.frontmost = true;
  try { w.actions.byName('AXRaise').perform(); } catch (e) {}
  me.delay(0.25);
  if (!p.frontmost()) throw new Error('The program did not come to the front, so nothing was sent.');
}
function run() {
  const op = get('OSAI_OP');
  if (op === 'probe') {
    const front = se.processes.whose({ frontmost: true })()[0];
    if (front) front.windows();
    return 'ok';
  }
  if (op === 'list') {
    const out = [];
    se.processes.whose({ backgroundOnly: false })().forEach((p) => {
      const pid = p.unixId();
      let ws = [];
      try { ws = p.windows(); } catch (e) {}
      ws.forEach((w, i) => {
        let t = '';
        try { t = w.name() || ''; } catch (e) {}
        out.push({ id: pid + ':' + (i + 1), pid: pid, title: t || p.name() });
      });
    });
    return JSON.stringify(out);
  }
  const pid = Number(get('OSAI_PID'));
  const index = Number(get('OSAI_INDEX'));
  const p = proc(pid);
  const w = win(p, index);
  if (op === 'type') {
    toFront(p, w);
    get('OSAI_TEXT').split('\n').forEach((line, i) => {
      if (i > 0) se.keyCode(36);
      if (line.length) se.keystroke(line);
    });
    return 'ok';
  }
  if (op === 'click') {
    const pos = w.position(); const size = w.size();
    const x = Number(get('OSAI_X')); const y = Number(get('OSAI_Y'));
    if (x < 0 || y < 0 || x >= size[0] || y >= size[1]) throw new Error('(' + x + ', ' + y + ') is outside the window, which is ' + size[0] + 'x' + size[1] + '.');
    toFront(p, w);
    const pt = $.CGPointMake(pos[0] + x, pos[1] + y);
    const b = Number(get('OSAI_BUTTON'));
    const kinds = b === 3 ? [3, 4, 1] : (b === 2 ? [25, 26, 2] : [1, 2, 0]);
    const post = (type, btn) => $.CGEventPost(0, $.CGEventCreateMouseEvent($(), type, pt, btn));
    post(5, kinds[2]);
    post(kinds[0], kinds[2]);
    post(kinds[1], kinds[2]);
    return 'ok';
  }
  if (op === 'move') {
    w.position = [Number(get('OSAI_X')), Number(get('OSAI_Y'))];
    w.size = [Number(get('OSAI_W')), Number(get('OSAI_H'))];
    return 'ok';
  }
  if (op === 'close') {
    const b = w.buttons.whose({ subrole: 'AXCloseButton' })();
    if (!b.length) throw new Error('That window has no close button.');
    b[0].click();
    return 'ok';
  }
  throw new Error('Unknown operation ' + op + '.');
}
`;

/** Turn osascript's complaints into what the person has to do. */
export function macError(text: string): string {
  if (/not allowed assistive access|\(-25211\)|\(-1719\)|\(-25204\)/i.test(text)) {
    return "macOS has not allowed this program to control the computer. Open System Settings > Privacy & Security > Accessibility and turn it on for NeuroClaw (or for the Terminal that started it), then try again.";
  }
  if (/not authorized to send apple events|\(-1743\)/i.test(text)) {
    return "macOS has not allowed this program to control System Events. Open System Settings > Privacy & Security > Automation and allow it, then try again.";
  }
  return clean(text) || "osascript failed.";
}

export class MacBackend implements DesktopBackend {
  readonly kind: BackendKind = "macos";

  constructor(private readonly run: NativeRun = realNativeRun, private readonly pids: Set<number> = agentPids) {}

  private async js(op: string, env: Record<string, string> = {}): Promise<string> {
    const r = await this.run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT], { OSAI_OP: op, ...env });
    if (r.error) throw new DesktopError(r.error);
    if (r.status !== 0) throw new DesktopError(macError(r.stderr || r.stdout));
    return r.stdout;
  }

  async describe(): Promise<BackendReport> {
    const notes = [
      "macOS: only windows of programs the agent started itself (by their own executable) can be driven; an app started through `open` runs under another process id and counts as the user's.",
      "macOS asks for Accessibility (to list windows, type and click) and Screen Recording (to capture the screen) the first time. A window id is the program's process id and the window's position in its list, so it can change when windows reorder.",
    ];
    try {
      await this.js("probe");
    } catch (e) {
      const msg = (e as Error).message;
      const needsPermission = /Accessibility|Automation/.test(msg);
      return {
        reachable: needsPermission,
        notes: [msg],
        platform: "macos",
        features: needsPermission ? { ...ALL_OFF(), screenshot: true, launch: true } : ALL_OFF(),
      };
    }
    return { reachable: true, notes, platform: "macos", features: { windows: true, screenshot: true, keyboard: true, pointer: true, moveResize: true, settings: false, launch: true } };
  }

  async listWindows(): Promise<RawWindow[]> {
    const out = (await this.js("list")).trim();
    let rows: Array<{ id: string; pid: number; title: string }>;
    try { rows = out ? JSON.parse(out) : []; } catch { throw new DesktopError("macOS returned a window list this layer could not read."); }
    return rows.map((w) => ({ id: String(w.id), desktop: "0", pid: Number(w.pid), host: os.hostname(), title: String(w.title ?? ""), owned: this.pids.has(Number(w.pid)) }));
  }

  async screenshot(region?: Region): Promise<Buffer> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osai-shot-"));
    const file = path.join(dir, "screen.png");
    try {
      const args = ["-x", "-t", "png"];
      if (region) args.push("-R", [region.x, region.y, region.width, region.height].map((n) => Math.trunc(Number(n))).join(","));
      args.push(file);
      const r = await this.run("screencapture", args);
      if (r.error) throw new DesktopError(r.error);
      if (r.status !== 0) throw new DesktopError(clean(r.stderr) || "screencapture failed. Check System Settings > Privacy & Security > Screen Recording.");
      const png = await readFile(file);
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new DesktopError("The screenshot came back empty. Check System Settings > Privacy & Security > Screen Recording.");
      return png;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async own(windowId: string): Promise<{ pid: number; index: number }> {
    const m = MAC_WINDOW_ID.exec(windowId);
    if (!m) throw new DesktopError(`"${windowId.slice(0, 40)}" is not a window id.`);
    const w = (await this.listWindows()).find((x) => x.id === windowId);
    if (!w) throw new DesktopError(`No window with id ${windowId}.`);
    if (!w.owned) throw new DesktopError(`Window ${windowId} ("${w.title}") belongs to the user. The agent can observe it but not control it.`);
    return { pid: Number(m[1]), index: Number(m[2]) };
  }

  async typeInto(windowId: string, text: string): Promise<void> {
    const w = await this.own(windowId);
    await this.js("type", { OSAI_PID: String(w.pid), OSAI_INDEX: String(w.index), OSAI_TEXT: text });
  }

  async clickIn(windowId: string, x: number, y: number, button: number): Promise<void> {
    const w = await this.own(windowId);
    await this.js("click", { OSAI_PID: String(w.pid), OSAI_INDEX: String(w.index), OSAI_X: String(Math.trunc(x)), OSAI_Y: String(Math.trunc(y)), OSAI_BUTTON: String([1, 2, 3].includes(button) ? button : 1) });
  }

  async moveWindow(windowId: string, x: number, y: number, width: number, height: number): Promise<void> {
    const w = await this.own(windowId);
    await this.js("move", { OSAI_PID: String(w.pid), OSAI_INDEX: String(w.index), OSAI_X: String(Math.trunc(x)), OSAI_Y: String(Math.trunc(y)), OSAI_W: String(Math.trunc(width)), OSAI_H: String(Math.trunc(height)) });
  }

  async closeWindow(windowId: string): Promise<void> {
    const w = await this.own(windowId);
    await this.js("close", { OSAI_PID: String(w.pid), OSAI_INDEX: String(w.index) });
  }

  async readSetting(): Promise<string> {
    throw new DesktopError("Reading desktop settings is not offered on macOS.");
  }
}
