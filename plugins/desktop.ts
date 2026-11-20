/**
 * Desktop plugin -- the GNOME graphical layer, as a set of tools.
 *
 * The terminal plugin is the non-graphical half of the computer; this is the
 * other half: windows, the screen, launching applications, typing and
 * clicking. Each of those is one named tool, and each tool is one output
 * neuron in the network (models && skills/core/tool-neurons.ts), so the
 * network can reach for "list the windows" or "take a screenshot" as a single
 * action rather than by composing a sentence for a plugin to parse.
 *
 * The capability itself lives in DesktopControl (models && skills/core/
 * desktop-control.ts), unchanged. That module already goes through the
 * AccessManager on every operation and already refuses to type into, click
 * on, move or close any window the agent did not open itself, so everything
 * here inherits both rules rather than restating them -- a tool the network
 * fires cannot reach anything a person on the Access page has not allowed.
 *
 * ComputerAccessPlugin keeps its desktop() accessor and its on/off switches.
 * This plugin is the tool surface; that one is where access is described and
 * turned off.
 */

import type { PluginDefinition } from "../plugin_manager/types.js";
import { ToolPlugin } from "../plugin_manager/sdk.js";
import { sharedAccessManager } from "../models && skills/core/access-settings.js";
import { DesktopControl } from "../models && skills/core/desktop-control.js";

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be text.`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

export class DesktopPlugin extends ToolPlugin {
  private control: DesktopControl | null;

  /**
   * @param control  The desktop to drive. Injectable so a test can stand in
   *                 for a machine with no display; by default it is the real
   *                 one, behind the same shared AccessManager the Access page
   *                 edits.
   */
  constructor(definition: PluginDefinition, control?: DesktopControl) {
    super(definition);
    this.control = control ?? null;
    this.defineTools();
  }

  private desktop(): DesktopControl {
    if (!this.control) this.control = new DesktopControl(sharedAccessManager());
    return this.control;
  }

  private defineTools(): void {
    this.defineTool({
      name: "probe",
      description: "What this machine can do graphically: the session, and which desktop tools are installed.",
      args: [],
      run: async () => this.desktop().probe(),
    });
    this.defineTool({
      name: "list_windows",
      description: "Every open window, and which ones the agent opened itself.",
      args: [],
      capability: "screen.observe",
      run: async () => this.desktop().listWindows(),
    });
    this.defineTool({
      name: "screenshot",
      description: "Capture the screen as a PNG.",
      args: [],
      capability: "screen.observe",
      // Base64, not a Buffer: the result goes back into the network inside a
      // zip archive, and ZipTree carries bytes as base64 (zip-halt.ts).
      run: async () => ({ mime: "image/png", base64: (await this.desktop().screenshot()).toString("base64") }),
    });
    this.defineTool({
      name: "launch_app",
      description: "Open an application in a window marked as the agent's own.",
      args: ["command"],
      optionalArgs: ["args"],
      capability: "app.launch",
      run: async args => this.desktop().launchAgentWindow(
        textArg(args, "command"),
        Array.isArray(args.args) ? args.args.map(String) : [],
      ),
    });
    this.defineTool({
      name: "move_window",
      description: "Move and resize one of the agent's own windows.",
      args: ["windowId", "x", "y", "width", "height"],
      capability: "window.manage",
      run: async args => {
        await this.desktop().moveWindow(
          textArg(args, "windowId"),
          numberArg(args, "x"),
          numberArg(args, "y"),
          numberArg(args, "width"),
          numberArg(args, "height"),
        );
        return { moved: args.windowId };
      },
    });
    this.defineTool({
      name: "close_window",
      description: "Close one of the agent's own windows.",
      args: ["windowId"],
      capability: "window.manage",
      run: async args => {
        await this.desktop().closeWindow(textArg(args, "windowId"));
        return { closed: args.windowId };
      },
    });
    this.defineTool({
      name: "type_text",
      description: "Type text into one of the agent's own windows.",
      args: ["windowId", "text"],
      capability: "keyboard.control",
      run: async args => {
        await this.desktop().typeInto(textArg(args, "windowId"), textArg(args, "text"));
        return { typed: String(args.text).length };
      },
    });
    this.defineTool({
      name: "click",
      description: "Click at a point inside one of the agent's own windows.",
      args: ["windowId", "x", "y"],
      optionalArgs: ["button"],
      capability: "mouse.control",
      run: async args => {
        await this.desktop().clickIn(
          textArg(args, "windowId"),
          numberArg(args, "x"),
          numberArg(args, "y"),
          args.button === undefined ? 1 : numberArg(args, "button"),
        );
        return { clicked: args.windowId };
      },
    });
  }

  /**
   * Strict, like the terminal: null unless the text is one of the forms below, so a message routed here that
   * it cannot answer falls through to the next candidate. Every form that does something is also a form that
   * wouldAct() reports, so the tool gate sees all of them and none can slip past it.
   *
   *   desktop probe | windows | list windows | screenshot
   *   desktop launch COMMAND [ARGS...]
   *   desktop click ID X Y [BUTTON]
   *   desktop type ID TEXT...
   *   desktop move ID X Y WIDTH HEIGHT
   *   desktop close ID
   *
   * ID is a window id from "desktop windows". Whether the window may be touched at all is still decided by
   * DesktopControl: only windows the agent opened itself, on every operating system.
   */
  static parse(message: unknown): { tool: string; args: Record<string, unknown> } | null {
    const input = (typeof message === "string" ? message : String(message ?? "")).trim();
    const m = input.match(/^desktop\s*:?\s+([\s\S]+)$/i);
    if (!m) return null;
    const body = m[1].trim();
    const word = body.toLowerCase();
    if (word === "probe") return { tool: "probe", args: {} };
    if (word === "screenshot") return { tool: "screenshot", args: {} };
    if (word === "windows" || word === "list windows") return { tool: "list_windows", args: {} };
    const ID = "([0-9A-Za-z:._-]{1,64})";
    const NUM = "(-?\\d{1,6})";
    let r: RegExpMatchArray | null;
    if ((r = body.match(/^launch\s+(\S[\s\S]*)$/i))) {
      const parts = r[1].trim().split(/\s+/);
      return { tool: "launch_app", args: { command: parts[0], args: parts.slice(1) } };
    }
    if ((r = body.match(new RegExp(`^click\\s+${ID}\\s+${NUM}\\s+${NUM}(?:\\s+([123]))?$`, "i")))) {
      return { tool: "click", args: { windowId: r[1], x: Number(r[2]), y: Number(r[3]), button: r[4] ? Number(r[4]) : 1 } };
    }
    if ((r = body.match(new RegExp(`^type\\s+${ID}\\s+([\\s\\S]+)$`, "i")))) {
      return { tool: "type_text", args: { windowId: r[1], text: r[2] } };
    }
    if ((r = body.match(new RegExp(`^move\\s+${ID}\\s+${NUM}\\s+${NUM}\\s+(\\d{1,6})\\s+(\\d{1,6})$`, "i")))) {
      return { tool: "move_window", args: { windowId: r[1], x: Number(r[2]), y: Number(r[3]), width: Number(r[4]), height: Number(r[5]) } };
    }
    if ((r = body.match(new RegExp(`^close\\s+${ID}$`, "i")))) return { tool: "close_window", args: { windowId: r[1] } };
    return null;
  }

  override wouldAct(message: unknown): boolean {
    return DesktopPlugin.parse(message) !== null;
  }

  override async onMessage(message: unknown): Promise<unknown> {
    const parsed = DesktopPlugin.parse(message);
    if (!parsed) return null;
    const event = await this.callTool(parsed.tool, parsed.args, "message");
    return { tool: `desktop.${parsed.tool}`, result: event.ok ? event.result : event.error };
  }

  async onHealthCheck(): Promise<boolean> {
    return this.active;
  }
}
