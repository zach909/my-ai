/**
 * OS commands plugin: the deepest AI OS layer, native on Linux, Windows and macOS.
 *
 * The table of commands and how each is run on each system lives in interface/platform/os-commands.ts; this
 * is only the plugin around it. Two things decide what happens to a request:
 *
 *  - wouldAct() is true only for commands that change something (start, stop, restart, kill). The tool gate
 *    holds those for a person, as it does for the terminal. Commands that only look are not held.
 *  - AccessManager still applies: looking needs `system.info`, changing needs `terminal.execute`, so the
 *    switches on the Access page turn this layer off exactly as they turn off the others.
 */

import type { PluginDefinition } from "../plugin_manager/types.js";
import { ToolPlugin } from "../plugin_manager/sdk.js";
import { sharedAccessManager } from "../models && skills/core/access-settings.js";
import { listOsCommands, parseOsCommand, runOsCommand, type OsRunner, realOsRunner } from "../interface/platform/os-commands.js";

/** A request names this plugin by starting with "os": "os services", "os: restart sshd". */
const OS_PREFIX = /^os\s*:?\s+\S/i;

export class OsCommandsPlugin extends ToolPlugin {
  private readonly runner: OsRunner;
  private readonly platform: NodeJS.Platform;

  constructor(definition: PluginDefinition, runner: OsRunner = realOsRunner, platform: NodeJS.Platform = process.platform) {
    super(definition);
    this.runner = runner;
    this.platform = platform;
    this.defineTool({
      name: "os_command",
      description: "Run one native OS command (info, uptime, processes, services, service NAME, network, disks, users, permissions PATH, start/stop/restart NAME, kill PID).",
      args: ["command"],
      capability: "terminal.execute",
      run: async (args) => this.execute(String(args.command ?? "")),
    });
    this.defineTool({
      name: "os_commands",
      description: "List the OS commands this system offers.",
      args: [],
      capability: "system.info",
      run: async () => listOsCommands(this.platform),
    });
  }

  private async execute(request: string): Promise<string> {
    const parsed = parseOsCommand(request, this.platform);
    if (parsed.ok === false) return parsed.reason;
    sharedAccessManager().require(parsed.command.risk === "control" ? "terminal.execute" : "system.info");
    return (await runOsCommand(request, this.runner, this.platform)).text;
  }

  /** True only for commands that change something, so the gate holds those and lets looking through. */
  override wouldAct(message: unknown): boolean {
    const text = typeof message === "string" ? message : String(message ?? "");
    if (!OS_PREFIX.test(text.trim())) return false;
    const parsed = parseOsCommand(text, this.platform);
    return parsed.ok && parsed.command.risk === "control";
  }

  override async onMessage(message: unknown): Promise<unknown> {
    const input = (typeof message === "string" ? message : String(message ?? "")).trim();
    // Only text that names this plugin ("os services"); anything else falls through to the next plugin.
    if (!OS_PREFIX.test(input) && !/^(?:list|show)\s+os\s+commands$/i.test(input)) return null;
    if (/^(?:list|show)\s+os\s+commands$/i.test(input) || /^os\s*:?\s+(?:help|list)$/i.test(input)) {
      return listOsCommands(this.platform).map((c) => `${c.name}${c.risk === "control" ? " (asks first)" : ""}: ${c.help}`).join("\n");
    }
    const parsed = parseOsCommand(input, this.platform);
    if (parsed.ok === false) return parsed.reason;
    const event = await this.callTool("os_command", { command: input }, "message");
    return event.ok ? event.result : event.error;
  }

  async onHealthCheck(): Promise<boolean> {
    return this.active;
  }
}
