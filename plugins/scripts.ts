/**
 * Scripts plugin: the chat front door to tool scripts (models && skills/core/script-runner.ts).
 *
 *   script: <code>        run a short script that calls tools with `await tools.call("<tool>", "<request>")`
 *   script help           what a script can use, and the limits
 *
 * The script runs in a locked-down child process, and every tool call it makes goes through the same gate chat
 * uses (PluginRegistry.runTool): a risky tool is held for your approval and the script stops there. This plugin adds
 * no permission of its own and is not on the ask-first list, because by itself it can do nothing: all it can do is
 * ask other tools, one at a time, and each of those decides for itself.
 *
 * Strict, like the other chat plugins: onMessage() returns null unless the text starts with "script:" or
 * "script help", so a message that merely mentions the word falls through.
 */

import type { PluginDefinition } from "../plugin_manager/types.js";
import { BasePlugin } from "../plugin_manager/sdk.js";
import {
  SCRIPT_BLOCKED_TOOLS,
  SCRIPT_LIMITS,
  describeScriptResult,
  runScript,
  type ToolCallResult,
} from "../models && skills/core/script-runner.js";

/** The part of PluginRegistry this plugin needs; the registry hands itself over in register() (attachRegistry). */
export interface ScriptToolHost {
  runTool(pluginId: string, input: string): Promise<ToolCallResult>;
  listActivePlugins(): Array<{ id: string }>;
}

const USAGE =
  "Scripts run a few tool calls in one go:\n" +
  "  script: const a = await tools.call(\"calendar\", \"list events tomorrow\");\n" +
  "          console.log(a);\n" +
  "          return a.length;\n" +
  "A script sees only `tools` and `console`:\n" +
  "  tools.list()                what it may call\n" +
  "  await tools.call(name, text) run one tool with a request written as text; returns the tool's reply\n" +
  "  console.log(...)            printed back to you\n" +
  "  return <value>              shown at the end\n" +
  "Each call goes through the same approval gate as chat. A risky tool is held for you and the script stops there; " +
  "approving it runs that one call, and the rest of the script does not continue. " +
  `Limits: ${SCRIPT_LIMITS.maxCalls} calls, ${Math.round(SCRIPT_LIMITS.timeoutMs / 1000)} seconds, ${SCRIPT_LIMITS.maxCodeChars} characters of code. ` +
  "A script has no files, no programs and no environment of its own, and cannot start another script.";

export class ScriptsPlugin extends BasePlugin {
  private host: ScriptToolHost | null = null;

  constructor(definition: PluginDefinition) {
    super(definition);
  }

  /** Called by PluginRegistry.register(): this is how the plugin reaches the gated tool runner. */
  attachRegistry(host: ScriptToolHost): void {
    this.host = host;
  }

  describeCapabilities() {
    return {
      commands: ["script:", "script help"],
      verbs: ["script"],
      nouns: ["script", "scripts"],
    };
  }

  wouldAct(message: unknown): boolean {
    return /^\s*script\s*:/i.test(typeof message === "string" ? message : String(message ?? ""));
  }

  override async onMessage(message: unknown): Promise<unknown> {
    const input = (typeof message === "string" ? message : String(message ?? "")).trim();
    if (/^script(?:\s+help)?$/i.test(input)) return { tool: "scripts", result: USAGE };
    const m = /^script\s*:\s*([\s\S]+)$/i.exec(input);
    if (!m) return null;

    const host = this.host;
    if (!host) return { tool: "scripts", result: "Scripts cannot run here: this plugin is not attached to the tool registry." };

    const tools = host.listActivePlugins().map(p => p.id).filter(id => !SCRIPT_BLOCKED_TOOLS.includes(id.toLowerCase()));
    const run = await runScript(m[1], (tool, request) => host.runTool(tool, request), tools);
    return { tool: "scripts", result: describeScriptResult(run) };
  }
}
