/**
 * The agent's reply as a zip.
 *
 *   response/   the reply itself (reply.md), a spoken copy of it (reply.wav), the first visual block of the reply as visual.html if it has one, the reply in every converter format (formats/), the question that led to it (question.md) and how the turn was built (details.json)
 *   plugins/    one file per plugin the turn used, with the tools it called and whether each worked, plus an index
 *   prompts/    ready-to-send prompts, as [[ask: Label | prompt]] lines (the same syntax a reply's own buttons use, so
 *               a line pasted into the chat becomes a button): plugins.md, tools.md, commands.md, feedback.md, and
 *               follow-ups.md for any button of the reply that fits none of those
 *
 * Written on the project's own zip writer (models && skills/core/zip-archive.ts); nothing else is used. Everything in
 * the zip is derived from what the page already has (the reply and the details of its turn), so building one never
 * runs a tool and never asks the mesh anything (the format list is the one file it reads). Names inside the zip are built here from
 * a strict character set, never copied from the input.
 */

import { writeZip, type ZipEntry } from "../models && skills/core/zip-archive.js";
import { applyApproved, decide, isSettled, normalizeDefinitions, normalizeEdits, open, resolveDefinitions, revise, withdraw, type Edit, type Revision } from "./response-edits.js";
import { renderSpeechWav } from "./response-audio.js";
import { SOURCE_FORMAT, formatEntries } from "./response-formats.js";
import { splitVisuals } from "./visuals.js";
import { PROMPT_BUTTON_LABEL_MAX, PROMPT_BUTTON_PROMPT_MAX, splitPromptButtons } from "./prompt-buttons.js";

export const BUNDLE_FORMAT = "neuroclaw-response";
/** Largest reply, question or details text kept, in characters. */
export const BUNDLE_MAX_TEXT = 200_000;
const MAX_PLUGINS = 64;
const MAX_CALLS_PER_PLUGIN = 200;

export interface BundleInput {
  /** What the person asked. */
  message?: unknown;
  /** What the agent answered. */
  response: unknown;
  /** The turn's details as the chat route returned them. Only the parts that can be checked are used. */
  details?: unknown;
  /** Names the reply uses as `{{name}}` and defines here, later. They are put in first, before any edit. */
  definitions?: unknown;
  /** Edits to the reply and prompts. Only the ones a reviewer approved change the text; the rest are listed in response/edits.json. */
  edits?: unknown;
  /** Set false to leave out response/reply.wav (the spoken copy). On by default. */
  audio?: boolean;
  /** Set false to leave out response/formats/ (the reply in every format the converter knows). On by default. */
  formats?: boolean;
}

export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  error?: string;
}

export interface PluginRecord {
  plugin: string;
  calls: ToolCallRecord[];
}

interface Prompt {
  label: string;
  prompt: string;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const text = (v: unknown, n = BUNDLE_MAX_TEXT): string => (typeof v === "string" ? clip(v, n) : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A file-name-safe version of a plugin name: letters, digits, dot, dash, underscore; never starts with a dot. */
export function safeName(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "").slice(0, 64);
  return s || "plugin";
}

/** The plugins (and their tool calls) found in a turn's details, rebuilt field by field. */
export function pluginsFromDetails(details: unknown): PluginRecord[] {
  if (!isObj(details) || !Array.isArray(details.toolCalls)) return [];
  const byPlugin = new Map<string, PluginRecord>();
  for (const raw of details.toolCalls) {
    if (!isObj(raw) || typeof raw.plugin !== "string" || typeof raw.tool !== "string") continue;
    const plugin = clip(raw.plugin, 100);
    const rec = byPlugin.get(plugin) ?? (byPlugin.size < MAX_PLUGINS ? { plugin, calls: [] } : null);
    if (!rec || rec.calls.length >= MAX_CALLS_PER_PLUGIN) continue;
    const call: ToolCallRecord = { tool: clip(raw.tool, 100), ok: raw.ok === true };
    if (typeof raw.error === "string" && raw.error) call.error = clip(raw.error, 500);
    rec.calls.push(call);
    byPlugin.set(plugin, rec);
  }
  return [...byPlugin.values()];
}

const FEEDBACK_RE = /feedback|wrong|incorrect|correct|improve|better|rate|helpful|not what i|thank/i;
const COMMAND_RE = /\b(run|execute|command|commands|terminal|shell|script)\b/i;
const TOOL_RE = /\btools?\b|calculate|convert|hash|encode|decode|compute/i;
const PLUGIN_RE = /\bplugins?\b|extension|install|enable|connect/i;

type Kind = "plugins" | "tools" | "commands" | "feedback" | "follow-ups";

/** Which file a prompt of the reply belongs in. Feedback first, then commands, tools, plugins; anything else is a follow-up. */
export function classifyPrompt(p: Prompt): Kind {
  const s = `${p.label} ${p.prompt}`;
  if (FEEDBACK_RE.test(s)) return "feedback";
  if (COMMAND_RE.test(s)) return "commands";
  if (TOOL_RE.test(s)) return "tools";
  if (PLUGIN_RE.test(s)) return "plugins";
  return "follow-ups";
}

const FEEDBACK: Prompt[] = [
  { label: "That was right", prompt: "That answer was right. Remember what worked about it and do it the same way next time." },
  { label: "That was wrong", prompt: "That answer was wrong. Tell me what you got wrong, then give the corrected answer." },
  { label: "Too long", prompt: "That was too long. Say it again in a few sentences, keeping what matters." },
  { label: "Too short", prompt: "That was too short. Go deeper and show the steps." },
  { label: "Not what I asked", prompt: "That was not what I asked. Ask me one question to find out what I meant, then answer that." },
];

const COMMANDS: Prompt[] = [
  { label: "What commands can I give you?", prompt: "List the commands I can give you, with one example of each." },
  { label: "Do that again", prompt: "Do that again, the same way, and show me the result." },
];

const TOOLS: Prompt[] = [
  { label: "What tools do you have?", prompt: "List the tools you can call, what each is for, and one example request for each." },
];

const PLUGINS: Prompt[] = [
  { label: "What plugins are on?", prompt: "List the plugins that are on right now, what each can do, and which ones need my approval." },
];

/** The buttons the reply itself carries, in order. A `[[put: ...]]` button is for somewhere outside the chat and is not a prompt to send. */
export function promptsFromReply(reply: string): Prompt[] {
  const out: Prompt[] = [];
  for (const part of splitPromptButtons(reply)) {
    if (part.kind !== "button" || part.put || !part.prompt) continue;
    out.push({ label: part.text, prompt: part.prompt });
  }
  return out;
}

/** Prompts made from what this turn actually used. */
export function promptsFromPlugins(plugins: PluginRecord[]): { plugins: Prompt[]; tools: Prompt[] } {
  const pluginPrompts: Prompt[] = [];
  const toolPrompts: Prompt[] = [];
  for (const p of plugins) {
    pluginPrompts.push({
      label: `What did ${p.plugin} do?`,
      prompt: `Tell me what the ${p.plugin} plugin did in that answer, and what else it can do.`,
    });
    for (const c of p.calls) {
      toolPrompts.push(c.ok
        ? { label: `Explain ${p.plugin}.${c.tool}`, prompt: `Explain what ${c.tool} (${p.plugin} plugin) did in that answer and how I can use it myself.` }
        : { label: `Fix ${p.plugin}.${c.tool}`, prompt: `${c.tool} (${p.plugin} plugin) failed${c.error ? `: ${c.error}` : ""}. Explain why, and what to try instead.` });
    }
  }
  return { plugins: pluginPrompts, tools: toolPrompts };
}

/** One prompt as a `[[ask: Label | prompt]]` line, cut to the limits a button has. Brackets and bars in the parts would end the marker early, so they are softened. */
function askLine(p: Prompt): string {
  const part = (s: string, n: number) => clip(s.replace(/\s+/g, " ").replace(/\]\]/g, "] ]").replace(/\|/g, "/").trim(), n);
  return `[[ask: ${part(p.label, PROMPT_BUTTON_LABEL_MAX)} | ${part(p.prompt, PROMPT_BUTTON_PROMPT_MAX)}]]`;
}

const TITLES: Record<Kind, { title: string; intro: string }> = {
  plugins: { title: "Prompts for plugins", intro: "Ask about the plugins behind that answer." },
  tools: { title: "Prompts for tools", intro: "Ask about the tools that were called, or what to do when one failed." },
  commands: { title: "Prompts for commands", intro: "Give a command, or ask what commands there are." },
  feedback: { title: "Prompts for feedback", intro: "Tell the agent how that answer went. A pasted line becomes a button in the chat." },
  "follow-ups": { title: "Follow-ups from the reply", intro: "Buttons the reply carried that fit none of the other files." },
};

function promptFile(kind: Kind, prompts: Prompt[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of prompts) {
    const line = askLine(p);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const { title, intro } = TITLES[kind];
  return `# ${title}\n\n${intro}\n\n${lines.join("\n\n")}\n`;
}

const EDITABLE = (name: string): boolean => name === "response/reply.md" || name === "response/question.md" || name.startsWith("prompts/");

/** The files of the zip, in a fixed order. */
export function bundleEntries(input: BundleInput, now = new Date()): ZipEntry[] {
  const defs = normalizeDefinitions(input.definitions);
  const hasDefs = Object.keys(defs).length > 0;
  let edits: Edit[] = normalizeEdits(input.edits);

  // Definitions first, then the approved edits, then everything that is built from the text (the prompts).
  const stage = (name: string, body: string, scope: (f: string) => boolean): string => {
    const resolved = resolveDefinitions(body, defs).text;
    const applied = applyApproved(new Map([[name, resolved]]), edits, f => f === name && scope(f));
    edits = applied.edits;
    return applied.files.get(name)!;
  };
  const missing = new Set<string>();
  const loops = new Set<string>();
  const note = (body: string) => { const r = resolveDefinitions(body, defs); r.missing.forEach(m => missing.add(m)); r.loops.forEach(l => loops.add(l)); };
  note(text(input.response)); note(text(input.message));

  const reply = stage("response/reply.md", text(input.response), EDITABLE);
  const question = stage("response/question.md", text(input.message), EDITABLE);
  const plugins = pluginsFromDetails(input.details);

  const files: ZipEntry[] = [];
  const add = (name: string, body: string) => files.push({ name, data: Buffer.from(body, "utf8") });

  add("response/reply.md", reply + (reply.endsWith("\n") ? "" : "\n"));
  // The spoken copy, made from the reply as it now reads (definitions in, approved edits applied).
  const wav = input.audio === false ? null : renderSpeechWav(reply);
  if (wav) files.push({ name: "response/reply.wav", data: wav });
  // The reply in every format the converter knows. Not the mesh writing them: see interface/response-formats.ts.
  let formatCount = 0;
  if (input.formats !== false) {
    const r = formatEntries(reply);
    files.push(...r.entries);
    formatCount = r.entries.length;
    add("response/formats/index.json", JSON.stringify({ source: SOURCE_FORMAT, total: r.total, written: r.written.length, skipped: r.skipped.length, files: r.written, notSent: r.skipped }, null, 2) + "\n");
  }
  // A visual block in the reply as its own file, so a player (the voice orb) can show it without reading the reply. The block as written, a fragment.
  const visual = splitVisuals(reply).find(p => p.kind === "visual");
  if (visual) add("response/visual.html", visual.text + (visual.text.endsWith("\n") ? "" : "\n"));
  if (question) add("response/question.md", question + (question.endsWith("\n") ? "" : "\n"));
  if (input.details !== undefined) {
    let json = "";
    try { json = JSON.stringify(input.details, null, 2) ?? ""; } catch { /* a value that cannot be written is left out */ }
    if (json && json.length <= BUNDLE_MAX_TEXT) add("response/details.json", json + "\n");
  }

  const used = new Set<string>();
  const index: Array<{ plugin: string; file: string; calls: number; failed: number }> = [];
  for (const p of plugins) {
    let base = safeName(p.plugin);
    for (let n = 2; used.has(base); n++) base = `${safeName(p.plugin).slice(0, 58)}-${n}`;
    used.add(base);
    const file = `plugins/${base}.json`;
    add(file, JSON.stringify(p, null, 2) + "\n");
    index.push({ plugin: p.plugin, file, calls: p.calls.length, failed: p.calls.filter(c => !c.ok).length });
  }
  add("plugins/index.json", JSON.stringify({ plugins: index }, null, 2) + "\n");

  const made = promptsFromPlugins(plugins);
  const buckets: Record<Kind, Prompt[]> = {
    plugins: [...made.plugins, ...PLUGINS],
    tools: [...made.tools, ...TOOLS],
    commands: [...COMMANDS],
    feedback: [...FEEDBACK],
    "follow-ups": [],
  };
  for (const p of promptsFromReply(reply)) buckets[classifyPrompt(p)].push(p);
  for (const kind of ["plugins", "tools", "commands", "feedback"] as const) {
    const name = `prompts/${kind}.md`;
    add(name, stage(name, promptFile(kind, buckets[kind]), EDITABLE));
  }
  if (buckets["follow-ups"].length) add("prompts/follow-ups.md", stage("prompts/follow-ups.md", promptFile("follow-ups", buckets["follow-ups"]), EDITABLE));

  // An approved edit whose file is not in the zip could not be applied above; send it back rather than call it done.
  const names = new Set(files.map(f => f.name));
  edits = edits.map(e => (e.status === "approved" && !names.has(e.file)
    ? { ...e, status: "rejected" as const, comments: [...e.comments, { by: "system" as const, text: `There is no file ${e.file} in the zip.` }] }
    : e));

  if (hasDefs) {
    add("response/definitions.json", JSON.stringify({ definitions: defs, missing: [...missing].sort(), loops: [...loops].sort() }, null, 2) + "\n");
  }
  if (edits.length) {
    add("response/edits.json", JSON.stringify({ done: isSettled(edits), remaining: open(edits).length, edits }, null, 2) + "\n");
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    version: 1,
    createdAt: now.toISOString(),
    folders: { response: "the reply and how it was built", plugins: "what the turn used", prompts: "prompts to send next" },
    editsRemaining: open(edits).length,
    formatFiles: formatCount,
    files: files.map(f => f.name).filter(n => !n.startsWith("response/formats/") || n === "response/formats/index.json").concat("manifest.json").sort(),
  };
  add("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return files;
}

/** The zip. Throws if `response` is not a string. */
export function buildResponseBundle(input: BundleInput, now = new Date()): Buffer {
  if (typeof input.response !== "string") throw new TypeError("Send { \"response\": \"<what the agent said>\" }.");
  return writeZip(bundleEntries(input, now), now);
}

export interface ReviewStep {
  /** The separate agent's calls on pending edits. An approval is checked against the text as it stands after the edits approved so far. */
  decisions?: Array<{ id: string; approve: boolean; comment?: string }>;
  /** The author's rewrites of rejected edits; each goes back to pending. */
  revisions?: Array<Revision & { id: string }>;
  /** Rejected edits the author gives up on. */
  withdraw?: string[];
}

export interface ReviewState {
  /** True only when no edit is left unapproved. */
  done: boolean;
  remaining: number;
  edits: Edit[];
  /** Edits still waiting for a reviewer (`pending`) or a rewrite (`rejected`): what the next round has to deal with. */
  open: Edit[];
}

/**
 * One round of the review, over HTTP or in a loop: withdrawals, then rewrites, then decisions. Throws on an unknown edit id
 * or on revising an edit that was not rejected, and changes nothing in that case.
 */
export function reviewStep(input: BundleInput, step: ReviewStep): ReviewState {
  let edits = normalizeEdits(input.edits);
  const current = (): Map<string, string> => new Map(bundleEntries({ ...input, edits }).map(e => [e.name, e.data.toString("utf8")]));
  for (const id of step.withdraw ?? []) edits = withdraw(edits, id);
  for (const r of step.revisions ?? []) edits = revise(edits, r.id, r);
  for (const d of step.decisions ?? []) {
    const target = edits.find(e => e.id === d.id);
    edits = decide(edits, d.id, d.approve === true, typeof d.comment === "string" ? d.comment : "", target ? current().get(target.file) : undefined);
  }
  const still = open(edits);
  return { done: still.length === 0, remaining: still.length, edits, open: still };
}
