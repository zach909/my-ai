/**
 * The AI OS layers: the only parts of NeuroClaw that AI OS exposes to the computer. They are native on
 * Linux, Windows and macOS: each system uses its own tools, and nothing outside this project sits in the way.
 *
 *   os     the deepest layer: the system's own commands (services, processes, network, disks, permissions)
 *            Linux: systemd, ps, ip, df, ls     Windows: PowerShell cmdlets     macOS: launchctl, ps, ifconfig, df
 *            -> the "os-commands" tool (interface/platform/os-commands.ts)
 *   app    terminal commands: run programs and app commands                    -> the "terminal" tool
 *   gui    the graphical button clicker: windows, clicks, typing, screenshots
 *            Linux: X11 / Wayland     Windows: PowerShell + user32     macOS: osascript + screencapture
 *            -> the "desktop" tool (models && skills/core/desktop/)
 *   skill  the auto skill maker                                                -> the "skill-maker" tool
 *
 * "kernel" is still accepted as another name for "os", so callers written for the old four-layer list keep
 * working. Nothing else is reachable through here (no chat, email, camera, calls, research ...).
 *
 * Every request still goes through PluginRegistry.runTool(), the same gate chat uses, so the danger protocol,
 * the Computer Access switches and the approval queue all apply. This grants the agent nothing new. The
 * `osai` command (scripts/osai.mjs, installed on every system) and anything else on this computer reach the
 * layers through POST /api/ai-os/layer, as the admin, from this machine only.
 *
 * Node built-ins only.
 */

import { osFamily, type OsFamily } from './os-commands.js';

interface LayerDef {
  id: 'os' | 'app' | 'gui' | 'skill';
  label: string;
  tool: string;
  /** Text the tool needs in front of a plain request, unless the request already starts that way. */
  prefix?: string;
  startsWith?: RegExp;
}

export const AI_OS_LAYERS: readonly LayerDef[] = [
  { id: 'os', label: 'OS commands (native)', tool: 'os-commands', prefix: 'os ', startsWith: /^os\b/i },
  { id: 'app', label: 'Terminal: app commands', tool: 'terminal', prefix: 'run ', startsWith: /^(run|exec|execute|shell|terminal)\b/i },
  { id: 'gui', label: 'Graphical button clicker', tool: 'desktop', prefix: 'desktop ', startsWith: /^desktop\b/i },
  { id: 'skill', label: 'Auto skill maker', tool: 'skill-maker' },
];

/** Other names a layer answers to. */
export const LAYER_ALIASES: Readonly<Record<string, LayerDef['id']>> = { kernel: 'os' };

export type AiOsLayerId = LayerDef['id'];
export const AI_OS_REQUEST_MAX = 600;

export interface LayerOutcome { status: 'ran' | 'held' | 'refused' | 'declined' | 'unavailable' | 'bad-request'; text: string }
export type ToolRunner = (tool: string, request: string) => Promise<{ status: LayerOutcome['status']; text: string }>;

const NATIVE: Record<OsFamily, Record<AiOsLayerId, string>> = {
  linux: { os: 'systemd and the standard Linux tools', app: 'the shell', gui: 'X11 / Wayland', skill: 'the skill maker' },
  windows: { os: 'PowerShell', app: 'the Windows command shell', gui: 'PowerShell + user32 (Win32)', skill: 'the skill maker' },
  macos: { os: 'launchctl and the standard macOS tools', app: 'the shell', gui: 'osascript + screencapture', skill: 'the skill maker' },
};

export function resolveLayerId(layer: unknown): AiOsLayerId | null {
  if (typeof layer !== 'string') return null;
  const id = layer.trim().toLowerCase();
  const alias = Object.prototype.hasOwnProperty.call(LAYER_ALIASES, id) ? LAYER_ALIASES[id] : id;
  return AI_OS_LAYERS.some((l) => l.id === alias) ? (alias as AiOsLayerId) : null;
}

/** What each layer is, what it uses on this system, and whether this computer can offer it. */
export function layerList(platform: NodeJS.Platform = process.platform): Array<{ id: AiOsLayerId; label: string; available: boolean; native?: string; reason?: string }> {
  const family = osFamily(platform);
  return AI_OS_LAYERS.map((l) => {
    if (!family && (l.id === 'os' || l.id === 'gui')) return { id: l.id, label: l.label, available: false, reason: `${l.label} is not offered on ${platform}.` };
    return { id: l.id, label: l.label, available: true, native: family ? NATIVE[family][l.id] : undefined };
  });
}

/** The tool for a request. On Linux the older permission-tool questions still reach the Linux permission tools. */
function toolFor(def: LayerDef, request: string, platform: NodeJS.Platform): string {
  if (def.id === 'os' && platform === 'linux' && /^(list|show)\s+linux\s+permission\s+tools$|^describe\s+linux\s+tool\s/i.test(request)) return 'linux-permission-tools';
  return def.tool;
}

/** Run one request on one layer. Unknown layers and bad requests are refused here, before any tool is touched. */
export async function runLayer(layer: unknown, request: unknown, run: ToolRunner, platform: NodeJS.Platform = process.platform): Promise<LayerOutcome> {
  const id = resolveLayerId(layer);
  const def = id ? AI_OS_LAYERS.find((l) => l.id === id) : undefined;
  if (!def) return { status: 'bad-request', text: `Unknown layer. AI OS has: ${AI_OS_LAYERS.map((l) => l.id).join(', ')}.` };
  if (typeof request !== 'string' || !request.trim() || request.length > AI_OS_REQUEST_MAX) {
    return { status: 'bad-request', text: `The request must be 1 to ${AI_OS_REQUEST_MAX} characters.` };
  }
  if ((def.id === 'os' || def.id === 'gui') && !osFamily(platform)) return { status: 'unavailable', text: `${def.label} is not offered on ${platform}.` };
  const text = request.trim();
  const tool = toolFor(def, text, platform);
  const send = tool === def.tool && def.prefix && def.startsWith && !def.startsWith.test(text) ? def.prefix + text : text;
  return run(tool, send);
}
