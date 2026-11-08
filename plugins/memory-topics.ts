/**
 * Memory topics plugin: the agent's hands on its folder-tree memory
 * (models && skills/core/memory-folders.ts).
 *
 *   memory tree                          the folders and notes, as an outline
 *   memory search <words>                find notes by topic words
 *   memory read <path>                   open one note
 *   memory save <path>: <text>           create a note, or replace it
 *   memory add <path>: <text>            add one dated line to a note (makes it if new)
 *   memory move <from> to <to>           re-file a note or a whole folder
 *   memory forget <path>                 forget a note (or an empty folder)
 *
 * Paths read like projects/garden/plan. The agent is expected to look at
 * `memory tree` (or search) before filing something new, so related things end
 * up in the same folder instead of next to near-duplicates.
 *
 * Strict dispatch, like the other chat plugins: onMessage() returns null
 * unless the text starts with a real memory command, so ordinary chat that
 * mentions the word falls through to the next candidate.
 */

import type { PluginDefinition } from "../plugin_manager/types.js";
import { BasePlugin } from "../plugin_manager/sdk.js";
import { MemoryFolderError, MemoryFolders } from "../models && skills/core/memory-folders.js";

const USAGE =
  "Memory commands:\n" +
  "  memory tree — the folders and notes\n" +
  "  memory search <words> — find notes by topic\n" +
  "  memory read <path> — open a note, e.g. memory read projects/garden/plan\n" +
  "  memory save <path>: <text> — create or replace a note\n" +
  "  memory add <path>: <text> — add a dated line to a note\n" +
  "  memory move <from> to <to> — re-file a note or folder\n" +
  "  memory forget <path> — forget a note or an empty folder";

const COMMAND = /^memory(?:\s+(tree|search|read|save|add|move|forget|help)\b)?/i;

export class MemoryTopicsPlugin extends BasePlugin {
  constructor(definition: PluginDefinition) {
    super(definition);
  }

  describeCapabilities() {
    return {
      commands: ["memory tree", "memory search <words>", "memory read <path>", "memory save <path>: <text>", "memory add <path>: <text>", "memory move <from> to <to>", "memory forget <path>"],
      verbs: ["remember", "recall", "memorize", "forget", "note"],
      nouns: ["memory", "memories", "topic", "topics", "note", "notes"],
    };
  }

  override async onMessage(message: unknown): Promise<unknown> {
    const input = (typeof message === "string" ? message : String(message ?? "")).trim();
    const head = COMMAND.exec(input);
    if (!head) return null;
    // "memory" alone is the help; "memory leaks in my code" is not ours.
    const verb = head[1]?.toLowerCase();
    if (!verb && !/^memory$/i.test(input)) return null;
    const rest = input.slice(head[0].length).trim();
    const reply = (result: string): { tool: string; result: string } => ({ tool: "memory-topics", result });
    const store = new MemoryFolders();

    try {
      if (!verb || verb === "help") return reply(USAGE);

      if (verb === "tree") return reply(store.outline());

      if (verb === "search") {
        if (!rest) return reply("Say what to look for: memory search <words>.");
        const hits = store.search(rest, 5);
        if (hits.length === 0) return reply(`Nothing in memory matches "${rest}".`);
        return reply(hits.map(h => `${h.path} — ${h.title}: ${h.snippet}`).join("\n"));
      }

      if (verb === "read") {
        if (!rest) return reply("Say which note: memory read <path>.");
        const n = store.read(rest);
        return reply(`${n.path}\n${n.content}`);
      }

      if (verb === "save" || verb === "add") {
        // The colon that ends the path is the first one followed by a space or a line break.
        const m = /^(.+?):\s+([\s\S]+)$/.exec(rest);
        if (!m) return reply(`Format: memory ${verb} <path>: <text>.`);
        if (verb === "save") {
          const n = store.write(m[1], m[2]);
          return reply(`Saved ${n.path} (${n.chars} characters).`);
        }
        const n = store.append(m[1], m[2]);
        return reply(`Added to ${n.path}.`);
      }

      if (verb === "move") {
        const m = /^(.+?)\s+to\s+(.+)$/i.exec(rest);
        if (!m) return reply("Format: memory move <from> to <to>.");
        const r = store.move(m[1], m[2]);
        return reply(`Moved ${r.kind} ${r.from} to ${r.to}.`);
      }

      if (verb === "forget") {
        if (!rest) return reply("Say which note: memory forget <path>.");
        // The agent may drop a note or an empty folder on its own. Emptying a whole folder of notes is the owner's call (the Memory tab).
        const n = store.remove(rest);
        return reply(n === 0 ? `Forgot the empty folder ${rest}.` : `Forgot ${rest}.`);
      }
    } catch (err) {
      if (err instanceof MemoryFolderError) return reply(err.message);
      throw err;
    }
    return reply(USAGE);
  }
}
