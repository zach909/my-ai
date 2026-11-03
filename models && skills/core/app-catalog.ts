/**
 * App catalog: for one app, every command it has, with a short entry saying what each one does.
 *
 * This is the part of the auto skill maker that knows "very specific apps". For an app it collects
 *
 *   - command-line apps: the app's own `--help` text (its subcommands and options), and
 *   - graphical apps: the buttons and actions the app declares in its launcher file (.desktop):
 *     the app itself plus each "Desktop Action" (New Window, Private Window, ...),
 *
 * and writes one wiki page, `apps/<app>`, with a small entry per command or control. The AI's wiki search
 * (agent-capabilities.ts, searchWiki) hands that page to the AI when it is looking for a skill for that app.
 *
 * Every entry is the app's OWN words, cut to length. Nothing is invented: a command the app does not describe
 * is listed with "(the app gives no description)". The page says where it came from.
 *
 * Limits, stated so nobody assumes more:
 *   - Reading buttons and menu items INSIDE a running window needs the desktop's accessibility interface
 *     (AT-SPI). The desktop layer cannot read that yet, so graphical apps get only what their launcher file
 *     declares. `extraControls` is where a future accessibility reader plugs in.
 *   - Collecting a command-line app RUNS it with `--help`, as you would in a terminal, in your real environment.
 *     This is the AI's real access to the computer, not a sandbox. It only runs for the one app you name.
 *
 * Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishWikiPage, type WikiPage } from "./wiki-store.js";

export interface CatalogEntry { name: string; usage?: string; summary: string }
export interface AppCatalog {
  app: string;
  /** What the app does, in its own words, when it says. */
  about: string;
  usage: string;
  commands: CatalogEntry[];
  options: CatalogEntry[];
  /** Graphical apps: the app and its declared actions. */
  controls: CatalogEntry[];
  /** Where each part came from. */
  sources: string[];
  /** What could not be read, in plain words. */
  notes: string[];
}

export class AppCatalogError extends Error {}

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_ENTRIES = 200;
const SUMMARY_MAX = 300;
const NO_DESCRIPTION = "(the app gives no description)";

export function assertAppName(name: string): string {
  if (!APP_NAME.test(name)) throw new AppCatalogError(`"${name.slice(0, 40)}" is not an app name (letters, digits, . _ + - only).`);
  return name;
}

const clip = (s: string, n = SUMMARY_MAX): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Pull the usage line, a one-line description, subcommands and options out of a --help text. */
export function parseHelp(text: string): { about: string; usage: string; commands: CatalogEntry[]; options: CatalogEntry[] } {
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").split("\n");
  let usage = "";
  let about = "";
  const commands: CatalogEntry[] = [];
  const options: CatalogEntry[] = [];
  let section: "commands" | "options" | "other" = "other";
  let last: CatalogEntry | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed) { last = null; continue; }
    const indent = line.length - line.trimStart().length;

    const u = trimmed.match(/^usage:\s*(.*)$/i);
    if (u) { if (!usage) usage = clip(u[1] || "", 200); last = null; continue; }

    const flag = line.match(/^\s{0,12}(-{1,2}[A-Za-z0-9][\w-]*(?:[ ,=|]+[^\s:,|]+)*)(?:\s+:\s+|\s{2,})(\S.*)$/);
    if (flag) {
      const e = { name: clip(flag[1], 80), summary: clip(flag[2]) };
      if (options.length < MAX_ENTRIES) options.push(e);
      last = e;
      continue;
    }

    if (indent === 0) {                       // a heading or a plain sentence
      if (/:\s*$/.test(trimmed) || /^[A-Z][A-Za-z ]+$/.test(trimmed)) {
        section = /command/i.test(trimmed) ? "commands" : /option|flag|argument/i.test(trimmed) ? "options" : "other";
        last = null;
        continue;
      }
      if (!about && !commands.length && !options.length && /\.$/.test(trimmed) && !/^[-\[]/.test(trimmed)) about = clip(trimmed, 200);
      last = null;
      continue;
    }

    const bareFlag = trimmed.match(/^(-{1,2}[A-Za-z0-9][\w-]*(?:[ ,=|]+\S+)*)$/);
    if (bareFlag) {                            // a flag alone on a line; its description is on the next one
      const e = { name: clip(bareFlag[1], 80), summary: "" };
      if (options.length < MAX_ENTRIES) options.push(e);
      last = e;
      continue;
    }
    if (section === "commands") {
      const cmd = line.match(/^\s{1,10}([A-Za-z][\w:.+-]*)(?:\s+<[^>]*>|\s+\[[^\]]*\])*\s{2,}(\S.*)$/);
      if (cmd) {
        const e = { name: cmd[1], summary: clip(cmd[2]) };
        if (commands.length < MAX_ENTRIES) commands.push(e);
        last = e;
        continue;
      }
    }
    if (last && indent >= 8) last.summary = clip(`${last.summary} ${trimmed}`);   // wrapped description
  }
  for (const e of [...commands, ...options]) if (!e.summary) e.summary = NO_DESCRIPTION;
  return { about, usage, commands, options };
}

/** Find an executable on PATH without a shell. */
export function findOnPath(app: string, pathVar: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, app);
    try { accessSync(p, constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
}

export type HelpRunner = (file: string, args: string[]) => string;

/**
 * Runs the app once with a help flag, the way you would in a terminal: your real environment, your home folder,
 * your working directory. The only limit is a timeout, so an app that ignores --help and just opens cannot hang
 * the catalog.
 */
export const runHelp: HelpRunner = (file, args) => {
  const r = spawnSync(file, args, { input: "", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 << 20, encoding: "utf8", env: process.env });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
};

function collectCli(app: string, run: HelpRunner, pathVar?: string): Partial<AppCatalog> & { notes: string[]; sources: string[] } {
  const file = findOnPath(app, pathVar);
  if (!file) return { notes: [`"${app}" is not a command on this computer's PATH.`], sources: [] };
  for (const flag of ["--help", "-h"]) {
    let out = "";
    try { out = run(file, [flag]); } catch { continue; }
    const parsed = parseHelp(out);
    if (parsed.commands.length || parsed.options.length) {
      return { ...parsed, sources: [`${app} ${flag} (run on this computer, ${new Date().toISOString().slice(0, 10)})`], notes: [] };
    }
  }
  return { notes: [`${app} printed no help text I could read with --help or -h.`], sources: [] };
}

function desktopDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const data = (env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
  const more = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [data, ...more].map((d) => path.join(d, "applications"));
}

interface DesktopGroup { [key: string]: string }
function parseDesktop(text: string): Record<string, DesktopGroup> {
  const groups: Record<string, DesktopGroup> = {};
  let cur: DesktopGroup | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const g = line.match(/^\[(.+)\]$/);
    if (g) { cur = groups[g[1]] = {}; continue; }
    const kv = line.match(/^([A-Za-z-]+)(?:\[[^\]]+\])?=(.*)$/);
    if (kv && cur && !(kv[1] in cur)) cur[kv[1]] = kv[2];     // first value wins: the unlocalised one
  }
  return groups;
}

const stripFieldCodes = (exec: string): string => exec.replace(/\s*%[A-Za-z%]/g, "").trim();

function collectGui(app: string, dirs: string[]): Partial<AppCatalog> & { notes: string[]; sources: string[] } {
  const want = app.toLowerCase();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".desktop")); } catch { continue; }
    for (const f of files) {
      const base = f.slice(0, -8).toLowerCase();
      const isId = base === want || base.endsWith(`.${want}`);
      let groups: Record<string, DesktopGroup>;
      try { groups = parseDesktop(readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const main = groups["Desktop Entry"];
      if (!main || main.Type !== "Application") continue;
      if (!isId && (main.Name ?? "").toLowerCase() !== want) continue;
      const name = main.Name || app;
      const controls: CatalogEntry[] = [{ name: `Open ${name}`, summary: clip(main.Comment || `Starts ${name} (${stripFieldCodes(main.Exec || "")}).`) }];
      for (const id of (main.Actions || "").split(";").filter(Boolean)) {
        const a = groups[`Desktop Action ${id}`];
        if (a?.Name && controls.length < MAX_ENTRIES) controls.push({ name: a.Name, summary: clip(a.Comment || `Runs: ${stripFieldCodes(a.Exec || "")}`) });
      }
      return {
        about: clip(main.Comment || main.GenericName || ""), controls, sources: [path.join(dir, f)],
        notes: ["Buttons and menus inside the running window are not read: that needs the desktop's accessibility interface, which this computer's desktop layer cannot read yet. Only what the launcher file declares is listed."],
      };
    }
  }
  return { notes: [`No launcher file for "${app}" was found, so no graphical controls were listed.`], sources: [] };
}

export interface CollectOptions {
  run?: HelpRunner;
  pathVar?: string;
  desktopDirs?: string[];
  /** Where a future accessibility reader plugs in: controls already read from the running app. */
  extraControls?: CatalogEntry[];
}

/** Collect everything this computer can say about one app. Throws only for a bad name or when nothing was found. */
export function collectApp(app: string, opts: CollectOptions = {}): AppCatalog {
  assertAppName(app);
  const cli = collectCli(app, opts.run ?? runHelp, opts.pathVar);
  const gui = collectGui(app, opts.desktopDirs ?? desktopDirs());
  const cat: AppCatalog = {
    app,
    about: cli.about || gui.about || "",
    usage: cli.usage || "",
    commands: cli.commands ?? [],
    options: cli.options ?? [],
    controls: [...(gui.controls ?? []), ...(opts.extraControls ?? [])],
    sources: [...cli.sources, ...gui.sources],
    notes: [],
  };
  const found = cat.commands.length + cat.options.length + cat.controls.length;
  cat.notes = found ? [...(cli.commands || cli.options ? [] : cli.notes), ...(gui.controls ? gui.notes : [])] : [...cli.notes, ...gui.notes];
  if (!found) throw new AppCatalogError(cat.notes.join(" "));
  return cat;
}

const section = (title: string, entries: CatalogEntry[]): string[] =>
  entries.length ? ["", `## ${title}`, ...entries.flatMap((e) => ["", `### ${e.name}`, e.summary, ...(e.usage ? [`Usage: ${e.usage}`] : [])])] : [];

/** The wiki page for one app. The first plain line is the description the AI's search matches against, so it names the commands. */
export function renderAppPage(c: AppCatalog): { name: string; title: string; content: string } {
  const names = [...c.commands.map((e) => e.name), ...c.controls.map((e) => e.name), ...c.options.map((e) => e.name)];
  const summary = clip(`Commands and controls for ${c.app}${c.about ? ` (${c.about})` : ""}: ${names.join(", ")}`, 400);
  const content = [
    `# ${c.app}`,
    "",
    summary,
    ...(c.usage ? ["", `Usage: ${c.usage}`] : []),
    ...section("Commands", c.commands),
    ...section("Buttons and actions", c.controls),
    ...section("Options", c.options),
    ...(c.notes.length ? ["", "## Not covered", ...c.notes.map((n) => `- ${n}`)] : []),
    "",
    "## Sources",
    ...c.sources.map((s) => `- ${s}`),
    "",
  ].join("\n");
  return { name: `apps/${c.app.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`, title: c.app, content };
}

/** Collect an app and publish its page, so the AI finds it when it looks for a skill for that app. */
export function buildAppSkill(app: string, opts: CollectOptions = {}): { page: WikiPage; catalog: AppCatalog } {
  const catalog = collectApp(app, opts);
  const { name, title, content } = renderAppPage(catalog);
  return { page: publishWikiPage(name, title, content), catalog };
}
