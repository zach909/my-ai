/**
 * OS buttons: a prompt button (see interface/prompt-buttons.ts) kept on this computer, outside the chat, where
 * the operating system shows launchers: the app menu, or the desktop. Click it and NeuroClaw opens, sends the
 * button's prompt to the AI, and shows the answer. Any number of them, anywhere the system has a place for one.
 *
 * The AI can propose one (`[[put: Label | prompt | desktop]]` in a reply) but cannot place one. Two steps, and
 * the second is never taken for the owner, exactly as for visual apps (models && skills/core/visual-apps.ts):
 *
 *   1. Saving. The label and prompt are kept in this device's data folder. Nothing outside it changes.
 *   2. Placing. One small file is written where the system looks for launchers. Before anything is written the
 *      exact path and the exact text of the file are shown, and the write goes ahead only with the single-use,
 *      expiring approval that preview returned. A request that never saw the preview cannot place anything.
 *
 * The file only opens this computer's own NeuroClaw at /ask/<id>. The prompt is not in the file or the link: it
 * is looked up here, so the file can be neither edited nor forged into asking something else.
 *
 * Removing deletes only a file this module wrote (it carries a marker), and a file already at the path that this
 * module did not write is never overwritten.
 *
 * State: ~/.neuroclaw/os-buttons/<id>.json (override the folder with CORONA_OS_BUTTONS_DIR). Node built-ins only.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

export class OsButtonError extends Error {}

export const LABEL_MAX = 40;
export const PROMPT_MAX = 500;
export const BUTTONS_MAX = 200;
/** How long a preview's approval stays good. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export type Where = "menu" | "desktop";
export type LauncherPlatform = "linux" | "macos" | "windows";

export interface OsButton {
  id: string;
  label: string;
  prompt: string;
  createdAt: number;
  /** Set once a launcher was written: where, and for which system. */
  launcher?: { platform: LauncherPlatform; where: Where; path: string; at: number };
}

export interface LauncherPlan {
  platform: LauncherPlatform;
  where: Where;
  /** The one file that would be written. */
  path: string;
  /** Its exact content. */
  content: string;
  /** The page it opens. */
  url: string;
}

export interface Unavailable { unavailable: string }

const MARK = (id: string) => `neuroclaw-os-button:${id}`;

/** A place to put a button: the exact words the AI may use, in `[[put: ... | where]]`. */
export function cleanWhere(raw: unknown): Where {
  if (raw === undefined || raw === null || raw === "") return "menu";
  const w = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (w === "menu" || w === "desktop") return w;
  throw new OsButtonError('Place a button in the "menu" or on the "desktop".');
}

/** No control characters, no path pieces; short enough to be a file name. */
export function cleanLabel(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const label = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
  if (!label) throw new OsButtonError("Give the button a label.");
  return label;
}

export function cleanPrompt(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const prompt = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!prompt) throw new OsButtonError("Give the button a prompt to send.");
  if (prompt.length > PROMPT_MAX) throw new OsButtonError(`The prompt is over ${PROMPT_MAX} characters.`);
  return prompt;
}

export function buttonsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CORONA_OS_BUTTONS_DIR) return path.resolve(env.CORONA_OS_BUTTONS_DIR);
  const root = env.CORONA_DATA_DIR ? path.resolve(env.CORONA_DATA_DIR) : path.join(homedir(), ".neuroclaw");
  return path.join(root, "os-buttons");
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const isButtonId = (s: unknown): s is string => typeof s === "string" && ID_RE.test(s);

function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return s || "button";
}

/** A file name safe on every file system. */
function fileName(b: Pick<OsButton, "id" | "label">): string {
  const s = b.label.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return s || b.id;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SystemInfo { platform: string; home: string; env: NodeJS.ProcessEnv }

/** What placing a button would write, without writing it. `baseUrl` is where this NeuroClaw answers. */
export function planOsButton(
  button: Pick<OsButton, "id" | "label">,
  where: Where,
  baseUrl: string,
  system: SystemInfo = { platform: process.platform, home: homedir(), env: process.env },
): LauncherPlan | Unavailable {
  const url = `${baseUrl.replace(/\/+$/, "")}/ask/${button.id}`;
  const name = fileName(button);
  if (system.platform === "linux") {
    const data = system.env.XDG_DATA_HOME ? path.resolve(system.env.XDG_DATA_HOME) : path.join(system.home, ".local", "share");
    const desktop = system.env.XDG_DESKTOP_DIR ? path.resolve(system.env.XDG_DESKTOP_DIR) : path.join(system.home, "Desktop");
    return {
      platform: "linux", where, url,
      path: where === "desktop" ? path.join(desktop, `${name}.desktop`) : path.join(data, "applications", `neuroclaw-ask-${button.id}.desktop`),
      content: ["[Desktop Entry]", "Type=Application", `Name=${button.label}`, "Comment=Sends a prompt to NeuroClaw", `Exec=xdg-open ${url}`, "Terminal=false", "Categories=Utility;", `X-${MARK(button.id)}=1`, ""].join("\n"),
    };
  }
  if (system.platform === "darwin") {
    return {
      platform: "macos", where, url,
      path: path.join(system.home, where === "desktop" ? "Desktop" : "Applications", `${name}.webloc`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARK(button.id)} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${xml(url)}</string></dict></plist>\n`,
    };
  }
  if (system.platform === "win32") {
    const appData = system.env.APPDATA ? path.resolve(system.env.APPDATA) : path.join(system.home, "AppData", "Roaming");
    const dir = where === "desktop" ? path.join(system.home, "Desktop") : path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
    return {
      platform: "windows", where, url,
      path: path.join(dir, `${name}.url`),
      content: `[InternetShortcut]\r\nURL=${url}\r\nNeuroClawButton=${MARK(button.id)}\r\n`,
    };
  }
  return { unavailable: `This system (${system.platform}) has no launcher folder this can write to. The button is saved in NeuroClaw and opens at ${url}.` };
}

export const isUnavailable = <T extends object>(p: T | Unavailable): p is Unavailable => "unavailable" in p;

export class OsButtonStore {
  /** Approvals handed out by a preview, by button id. In memory only: a restart cancels them. */
  private approvals = new Map<string, { token: string; what: string; expires: number }>();

  constructor(private readonly dir: string = buttonsDir(), private readonly now: () => number = Date.now) {}

  private hold(key: string, what: string): string {
    const token = randomBytes(18).toString("hex");
    this.approvals.set(key, { token, what, expires: this.now() + APPROVAL_TTL_MS });
    return token;
  }

  /** Spend the approval for `key`: it is gone whether or not it matched, and must match `what` and be in time. */
  private spend(key: string, given: unknown, what: string): boolean {
    const held = this.approvals.get(key);
    this.approvals.delete(key);
    const g = typeof given === "string" ? Buffer.from(given) : Buffer.alloc(0);
    return !!held && held.expires >= this.now() && held.what === what && g.length === held.token.length && timingSafeEqual(g, Buffer.from(held.token));
  }

  private file(id: string): string {
    if (!isButtonId(id)) throw new OsButtonError("Not a button id.");
    return path.join(this.dir, `${id}.json`);
  }

  list(): OsButton[] {
    if (!existsSync(this.dir)) return [];
    const out: OsButton[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const b = this.get(f.slice(0, -5));
      if (b) out.push(b);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): OsButton | null {
    if (!isButtonId(id)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.file(id), "utf8")) as OsButton;
      return raw && raw.id === id && typeof raw.label === "string" && typeof raw.prompt === "string" ? raw : null;
    } catch {
      return null;
    }
  }

  /** Save a button (step 1). Changes nothing outside the data folder. */
  save(labelRaw: unknown, promptRaw: unknown): OsButton {
    const label = cleanLabel(labelRaw);
    const prompt = cleanPrompt(promptRaw);
    const existing = this.list();
    if (existing.length >= BUTTONS_MAX) throw new OsButtonError(`There is room for ${BUTTONS_MAX} buttons; remove one first.`);
    const taken = new Set(existing.map((b) => b.id));
    let id = slug(label);
    for (let n = 2; taken.has(id); n++) id = `${slug(label).slice(0, 40)}-${n}`;
    const button: OsButton = { id, label, prompt, createdAt: this.now() };
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file(id), JSON.stringify(button, null, 2));
    return button;
  }

  /** Show what placing would write and hand back the approval it needs. Writes nothing. */
  preview(id: string, whereRaw: unknown, baseUrl: string, system?: SystemInfo): { plan: LauncherPlan; approval: string } | Unavailable {
    const button = this.get(id);
    if (!button) throw new OsButtonError("No such button.");
    const plan = planOsButton(button, cleanWhere(whereRaw), baseUrl, system);
    if (isUnavailable(plan)) return plan;
    return { plan, approval: this.hold(`${id}:place`, plan.path) };
  }

  /**
   * Place it (step 2), only with the approval a preview returned. The plan is made again and must name the same
   * file the preview showed. A file already there that this did not write is left alone.
   */
  place(id: string, whereRaw: unknown, approval: unknown, baseUrl: string, system?: SystemInfo): OsButton {
    const button = this.get(id);
    if (!button) throw new OsButtonError("No such button.");
    const plan = planOsButton(button, cleanWhere(whereRaw), baseUrl, system);
    if (isUnavailable(plan)) throw new OsButtonError(plan.unavailable);
    if (!this.spend(`${id}:place`, approval, plan.path)) throw new OsButtonError("Not approved. Review what will be written first, then approve it.");
    if (existsSync(plan.path)) {
      let ours = false;
      try { ours = readFileSync(plan.path, "utf8").includes(MARK(id)); } catch { /* unreadable: not ours */ }
      if (!ours) throw new OsButtonError("There is already a file at that place that NeuroClaw did not write, so it was left alone.");
    }
    mkdirSync(path.dirname(plan.path), { recursive: true });
    writeFileAtomic(plan.path, plan.content);
    const next: OsButton = { ...button, launcher: { platform: plan.platform, where: plan.where, path: plan.path, at: this.now() } };
    writeFileAtomic(this.file(id), JSON.stringify(next, null, 2));
    return next;
  }

  /** Take a button off the computer and out of the store. Touches the launcher only if it is still the one this wrote. */
  remove(id: string): { removed: boolean; launcherRemoved: boolean } {
    const button = this.get(id);
    if (!button) return { removed: false, launcherRemoved: false };
    let launcherRemoved = false;
    if (button.launcher) {
      try {
        if (readFileSync(button.launcher.path, "utf8").includes(MARK(button.id))) {
          rmSync(button.launcher.path);
          launcherRemoved = true;
        }
      } catch { /* already gone */ }
    }
    rmSync(this.file(id), { force: true });
    this.approvals.delete(`${id}:place`);
    return { removed: true, launcherRemoved };
  }
}
