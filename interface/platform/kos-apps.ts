/**
 * KOS apps: open an app by its address, the way a browser opens a website.
 *
 *   kos://firefox      an app on this computer, found by name (nothing to register first)
 *   kos://kernel       an app KOS ships with
 *   kos://my-notes     an app the owner installed (a small manifest, below)
 *
 * Three rules, and the code enforces each one rather than just stating it:
 *
 *   1. Everything goes through the layers. An app is only a list of requests, each one aimed at one AI OS layer
 *      (gui = the graphical button clicker, app = app commands, kernel = kernel commands, skill = the skill
 *      maker). Opening an app calls runLayer() from ai-os-layers.ts for every request, and that is the only way
 *      this module touches the computer: it imports no file, process or network module for acting, and
 *      test/platform/kos-apps.test.mjs fails if one is added. The tool gate behind runLayer (danger protocol,
 *      Computer Access switches, approvals) therefore applies to every app, with no exception.
 *   2. Everything is an app. The layers' own front ends are apps in the same list (kos://buttons, kos://commands,
 *      kos://kernel, kos://skills), and anything on the computer is one by name. There is no second kind of thing.
 *   3. Two versions of the system, chosen by the owner, per computer:
 *        extension  KOS sits on top of the system like a browser extension. It only drives what is already there
 *                   through the button clicker and app commands. Nothing system-wide is touched, the kernel layer
 *                   is closed, and removing it leaves the computer as it was. This is the default.
 *        system     KOS may also use the kernel layer, so an app marked scope "system" can change system apps
 *                   and services. Linux only, because kernel commands are Linux only.
 *      An app says which version it needs (scope). A "system" app is refused in the extension version, and a
 *      kernel request is refused there whatever the app claims.
 *
 * The installed apps and the chosen version live in one small file in the user's config folder, written
 * atomically; a failed save is reported and changes nothing.
 *
 * Node built-ins and this project's own modules only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { configFile } from './app-paths.js';
import { AI_OS_LAYERS, AI_OS_REQUEST_MAX, runLayer, type AiOsLayerId, type LayerOutcome, type ToolRunner } from './ai-os-layers.js';

export const KOS_EDITIONS = ['extension', 'system'] as const;
export type KosEdition = (typeof KOS_EDITIONS)[number];
export type KosScope = KosEdition;

export interface KosAction { layer: AiOsLayerId; request: string }
export interface KosApp {
  id: string;
  name: string;
  /** The version of the system this app needs. */
  scope: KosScope;
  /** What opening it does: requests, in order, each through one layer. */
  open: KosAction[];
  builtin?: boolean;
}

export class KosAppError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const APP_ID = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
/** What a computer's own apps are called (same rule the app catalog uses), kept here so this file imports nothing that runs programs. */
const SYSTEM_APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_ACTIONS = 8;
const MAX_INSTALLED = 200;
const LAYER_IDS: readonly string[] = AI_OS_LAYERS.map((l) => l.id);

/** The apps KOS ships with: the layers' own front ends. */
export const BUILTIN_APPS: readonly KosApp[] = [
  { id: 'buttons', name: 'Button clicker', scope: 'extension', builtin: true, open: [{ layer: 'gui', request: 'list the open windows' }] },
  { id: 'commands', name: 'App commands', scope: 'extension', builtin: true, open: [{ layer: 'app', request: 'list the command-line apps installed on this computer' }] },
  { id: 'kernel', name: 'Kernel commands', scope: 'system', builtin: true, open: [{ layer: 'kernel', request: 'list the system services' }] },
  { id: 'skills', name: 'Auto skill maker', scope: 'extension', builtin: true, open: [{ layer: 'skill', request: 'list the skills you have' }] },
];

/** The app manifest, checked. Throws KosAppError saying which part is wrong. */
export function validateApp(raw: unknown): KosApp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new KosAppError('An app must be a JSON object.');
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim().toLowerCase() : '';
  if (!APP_ID.test(id)) throw new KosAppError('The app id must be 1 to 64 characters: lowercase letters, digits and . _ + -');
  if (BUILTIN_APPS.some((b) => b.id === id)) throw new KosAppError(`"${id}" is one of KOS's own apps.`, 409);
  const name = typeof o.name === 'string' ? o.name.trim() : id;
  if (!name || name.length > 80) throw new KosAppError('The app name must be 1 to 80 characters.');
  if (o.scope !== 'extension' && o.scope !== 'system') throw new KosAppError('scope must be "extension" or "system".');
  if (!Array.isArray(o.open) || o.open.length < 1 || o.open.length > MAX_ACTIONS) throw new KosAppError(`open must list 1 to ${MAX_ACTIONS} requests.`);
  const open: KosAction[] = o.open.map((a, i) => {
    const x = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
    if (typeof x.layer !== 'string' || !LAYER_IDS.includes(x.layer)) throw new KosAppError(`open[${i}].layer must be one of: ${LAYER_IDS.join(', ')}.`);
    if (typeof x.request !== 'string' || !x.request.trim() || x.request.length > AI_OS_REQUEST_MAX) throw new KosAppError(`open[${i}].request must be 1 to ${AI_OS_REQUEST_MAX} characters.`);
    if (x.layer === 'kernel' && o.scope !== 'system') throw new KosAppError(`open[${i}] uses the kernel layer, so the app's scope must be "system".`);
    return { layer: x.layer as AiOsLayerId, request: x.request.trim() };
  });
  return { id, name, scope: o.scope, open };
}

/** `kos://firefox`, `kos:firefox` or `firefox`. Anything with a space, slash, query or odd character is not an address. */
export function parseAddress(input: unknown): { ok: true; name: string } | { ok: false; text: string } {
  if (typeof input !== 'string') return { ok: false, text: 'Give an app address such as kos://firefox.' };
  const name = input.trim().replace(/^kos:(\/\/)?/i, '').replace(/\/+$/, '');
  if (!SYSTEM_APP_NAME.test(name)) return { ok: false, text: `"${input.slice(0, 40)}" is not an app address. Use kos://name (letters, digits, . _ + - only).` };
  return { ok: true, name };
}

/**
 * Find the app an address points at. A registered app wins; otherwise the name is taken to be an app already on
 * the computer and opened with the button clicker, which is how a browser opens a site nobody registered.
 */
export function resolveApp(address: unknown, apps: readonly KosApp[]): { app: KosApp; discovered: boolean } | { error: string } {
  const parsed = parseAddress(address);
  if ('text' in parsed) return { error: parsed.text };
  const known = apps.find((a) => a.id === parsed.name.toLowerCase());
  if (known) return { app: known, discovered: false };
  return {
    app: { id: parsed.name.toLowerCase(), name: parsed.name, scope: 'extension', open: [{ layer: 'gui', request: `launch the app ${parsed.name}` }] },
    discovered: true,
  };
}

/** Whether this version of the system, on this computer, lets the app open. Pure; nothing is run. */
export function checkOpen(app: KosApp, edition: KosEdition, platform: NodeJS.Platform = process.platform): { ok: true } | { ok: false; status: 'refused' | 'unavailable'; text: string } {
  if (app.scope === 'system' && edition !== 'system') {
    return { ok: false, status: 'refused', text: `${app.name} changes system apps, so it needs the system version of KOS. This computer is set to the extension version.` };
  }
  if (app.open.some((a) => a.layer === 'kernel')) {
    if (edition !== 'system') return { ok: false, status: 'refused', text: 'Kernel commands are closed in the extension version of KOS.' };
    if (platform !== 'linux') return { ok: false, status: 'unavailable', text: 'Kernel commands need Linux.' };
  }
  return { ok: true };
}

export interface OpenStep { layer: AiOsLayerId; request: string; status: LayerOutcome['status']; text: string }
export interface OpenResult { status: LayerOutcome['status']; app?: { id: string; name: string; scope: KosScope; discovered: boolean }; text: string; steps: OpenStep[] }

/**
 * Open an app: every request goes through runLayer(), in order, and the first one that does not run stops the
 * rest, with its status (held for approval, refused, ...) passed up unchanged.
 */
export async function openApp(address: unknown, o: { apps: readonly KosApp[]; edition: KosEdition; run: ToolRunner; platform?: NodeJS.Platform }): Promise<OpenResult> {
  const platform = o.platform ?? process.platform;
  const found = resolveApp(address, o.apps);
  if ('error' in found) return { status: 'bad-request', text: found.error, steps: [] };
  const { app, discovered } = found;
  const info = { id: app.id, name: app.name, scope: app.scope, discovered };
  const gate = checkOpen(app, o.edition, platform);
  if ('status' in gate) return { status: gate.status, app: info, text: gate.text, steps: [] };
  const steps: OpenStep[] = [];
  for (const a of app.open) {
    const out = await runLayer(a.layer, a.request, o.run, platform);
    steps.push({ layer: a.layer, request: a.request, status: out.status, text: out.text });
    if (out.status !== 'ran') return { status: out.status, app: info, text: out.text, steps };
  }
  return { status: 'ran', app: info, text: steps.map((s) => s.text).join('\n'), steps };
}

interface StoreFile { edition: KosEdition; apps: KosApp[] }

/** The chosen version of the system and the installed apps, in one small file. Read fresh each time, so there is no copy to drift. */
export class KosAppStore {
  readonly file: { write: string; read: string };
  constructor(override?: string) { this.file = configFile('kos-apps.json', override); }

  private read(): StoreFile {
    const state: StoreFile = { edition: 'extension', apps: [] };
    try {
      if (!existsSync(this.file.read)) return state;
      const j = JSON.parse(readFileSync(this.file.read, 'utf8')) as { edition?: unknown; apps?: unknown };
      if (j.edition === 'system') state.edition = 'system';
      if (Array.isArray(j.apps)) {
        for (const a of j.apps.slice(0, MAX_INSTALLED)) {
          try { const v = validateApp(a); if (!state.apps.some((x) => x.id === v.id)) state.apps.push(v); } catch { /* a bad entry is skipped, not trusted */ }
        }
      }
    } catch { /* damaged file: defaults, and it is replaced on the next successful save */ }
    return state;
  }

  private write(state: StoreFile): void {
    try { writeJsonAtomic(this.file.write, state); }
    catch (err) { throw new KosAppError(`Could not save (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`, 500); }
  }

  edition(): KosEdition { return this.read().edition; }
  installed(): KosApp[] { return this.read().apps; }
  /** KOS's own apps first, then the owner's. */
  list(): KosApp[] { return [...BUILTIN_APPS, ...this.read().apps]; }

  setEdition(edition: unknown): KosEdition {
    if (edition !== 'extension' && edition !== 'system') throw new KosAppError('edition must be "extension" or "system".');
    const s = this.read();
    s.edition = edition;
    this.write(s);
    return edition;
  }

  install(raw: unknown): KosApp {
    const app = validateApp(raw);
    const s = this.read();
    const i = s.apps.findIndex((a) => a.id === app.id);
    if (i >= 0) s.apps[i] = app;
    else if (s.apps.length >= MAX_INSTALLED) throw new KosAppError(`At most ${MAX_INSTALLED} apps can be installed.`, 409);
    else s.apps.push(app);
    this.write(s);
    return app;
  }

  remove(id: unknown): boolean {
    if (typeof id !== 'string') throw new KosAppError('Say which app to remove.');
    const key = id.trim().toLowerCase();
    if (BUILTIN_APPS.some((b) => b.id === key)) throw new KosAppError(`"${key}" is one of KOS's own apps and cannot be removed.`, 409);
    const s = this.read();
    const next = s.apps.filter((a) => a.id !== key);
    if (next.length === s.apps.length) return false;
    s.apps = next;
    this.write(s);
    return true;
  }
}

let shared: KosAppStore | null = null;
export const sharedKosApps = (): KosAppStore => (shared ??= new KosAppStore());
