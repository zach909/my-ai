/**
 * The AI OS layers: the only parts of NeuroClaw that AI OS exposes to the computer.
 *
 *   gui     the graphical button clicker (windows, clicks, typing)       -> the "desktop" tool
 *   app     terminal commands: app commands                              -> the "terminal" tool
 *   kernel  kernel commands: Linux permission tools (Linux only)         -> the "linux-permission-tools" tool
 *   skill   the auto skill maker                                         -> the "skill-maker" tool
 *
 * Nothing else is reachable through here (no chat, email, camera, calls, research ...). KOS (the kernal-os
 * repo, `kos aios ...`) is the engine in front of this: it asks for the owner's password and writes its audit
 * log, then calls POST /api/ai-os/layer on this computer. This module is the other half of that door.
 *
 * Every request still goes through PluginRegistry.runTool(), the same gate chat uses, so the danger protocol,
 * the Computer Access switches and the approval queue all apply. This grants the agent nothing new.
 *
 * Node built-ins only.
 */

export const AI_OS_LAYERS = [
  { id: 'gui', label: 'Graphical button clicker', tool: 'desktop', linuxOnly: false },
  { id: 'app', label: 'Terminal: app commands', tool: 'terminal', linuxOnly: false },
  { id: 'kernel', label: 'Kernel commands (Linux permission tools)', tool: 'linux-permission-tools', linuxOnly: true },
  { id: 'skill', label: 'Auto skill maker', tool: 'skill-maker', linuxOnly: false },
] as const;

export type AiOsLayerId = (typeof AI_OS_LAYERS)[number]['id'];
export const AI_OS_REQUEST_MAX = 600;

export interface LayerOutcome { status: 'ran' | 'held' | 'refused' | 'declined' | 'unavailable' | 'bad-request'; text: string }
export type ToolRunner = (tool: string, request: string) => Promise<{ status: LayerOutcome['status']; text: string }>;

/** What each layer is and whether this computer can offer it. */
export function layerList(platform: NodeJS.Platform = process.platform): Array<{ id: AiOsLayerId; label: string; available: boolean; reason?: string }> {
  return AI_OS_LAYERS.map((l) => (l.linuxOnly && platform !== 'linux'
    ? { id: l.id, label: l.label, available: false, reason: 'Kernel commands need Linux.' }
    : { id: l.id, label: l.label, available: true }));
}

/** Run one request on one layer. Unknown layers and bad requests are refused here, before any tool is touched. */
export async function runLayer(layer: unknown, request: unknown, run: ToolRunner, platform: NodeJS.Platform = process.platform): Promise<LayerOutcome> {
  const def = AI_OS_LAYERS.find((l) => l.id === layer);
  if (!def) return { status: 'bad-request', text: `Unknown layer. AI OS has: ${AI_OS_LAYERS.map((l) => l.id).join(', ')}.` };
  if (typeof request !== 'string' || !request.trim() || request.length > AI_OS_REQUEST_MAX) {
    return { status: 'bad-request', text: `The request must be 1 to ${AI_OS_REQUEST_MAX} characters.` };
  }
  if (def.linuxOnly && platform !== 'linux') return { status: 'unavailable', text: 'Kernel commands need Linux.' };
  return run(def.tool, request.trim());
}
