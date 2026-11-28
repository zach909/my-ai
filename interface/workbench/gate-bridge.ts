/**
 * The bridge from the workbench into the agent's own tool gate (core/tool-safety.ts).
 *
 * The agent's tools run through the plugin registry, which asks the shared gate before each one. The gate keeps its
 * approvals and its danger protocol; this adds two refusals on top, and nothing else:
 *
 *   1. a permission rule that denies the tool (`deny: ["bash"]`, `deny: ["email"]`, or for a given agent), and
 *   2. a PreToolUse hook that exits 2.
 *
 * The gate only offers a tool's name and the message that pointed at it, not the exact command, so rules written with a
 * pattern (`bash(git *)`) cannot match here; bare tool names do. A rule that says "ask" is not repeated here: for the
 * risky tools the gate already asks, and for the rest there is nobody to ask, so a project that wants a tool held should
 * list it as risky in the gate's settings.
 */
import type { Workbench } from './workbench.js';

/** The gate's plugin ids, in the workbench's tool names. Anything not listed is named by its own id. */
export const TOOL_FOR_PLUGIN: Record<string, string> = {
  terminal: 'bash', 'os-commands': 'bash', 'file-system': 'edit', browser: 'fetch', searxng: 'fetch', research: 'fetch',
};

export const toolNameFor = (pluginId: string): string => TOOL_FOR_PLUGIN[pluginId.toLowerCase()] ?? pluginId.toLowerCase();

export interface GateLike { useExtraCheck(fn: ((pluginId: string, input: string) => Promise<string | null>) | null): void }

export function installGateBridge(wb: Workbench, gate: GateLike, hooksEnabled = true): () => void {
  gate.useExtraCheck(async (pluginId, input) => {
    const tool = toolNameFor(pluginId);
    const v = wb.decide({ tool });
    if (v.decision === 'deny') return `[Refused by a rule] ${v.reason}`;
    if (hooksEnabled) {
      const r = await wb.runHook({ event: 'PreToolUse', tool, input: { plugin: pluginId, request: input.slice(0, 600) } });
      if (r.blocked) return `[Stopped by a hook] ${r.reason ?? 'A PreToolUse hook blocked this.'}`;
    }
    return null;
  });
  return () => gate.useExtraCheck(null);
}
