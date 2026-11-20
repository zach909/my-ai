/**
 * The plugin host: the one small thing that is not a plugin.
 *
 * Everything else in NeuroClaw is meant to be a KernelPlugin: a named unit with
 * a lifecycle, the other plugins it needs, the services it offers, and the
 * HTTP routes it owns. The host only does four jobs:
 *
 *   1. start plugins in dependency order, and stop them in the reverse order;
 *   2. keep a registry of the services plugins offer each other;
 *   3. hand the HTTP server the routes of the plugins that are running;
 *   4. let a plugin be turned off and on again, and remember which are off.
 *
 * It has no imports on purpose: it must load before anything else does, and it
 * must never depend on a plugin it is hosting.
 *
 * ── Guarded plugins ────────────────────────────────────────────────────
 *
 * The safety modules (alignment veto, danger protocol, tool gate) are plugins
 * like the rest, and can be turned off, but only by the owner. A plugin marked
 * `guarded` refuses to stop when the request comes from the agent or from the
 * system on its own. Without that, anything the agent can call could switch
 * off the thing that watches the agent, which is the exact tamper case the
 * danger protocol already treats as the worst thing it can do.
 */

export type PluginActor = "owner" | "agent" | "system";

export type PluginState = "registered" | "starting" | "running" | "stopping" | "stopped" | "failed";

/** One HTTP route group a plugin owns. `C` is whatever context the server builds per request. */
export interface PluginRoute<C = unknown> {
  /** Cheap check on the path and method. No side effects. */
  match(pathname: string, method: string): boolean;
  /**
   * True for the paths of this route that must answer without the server's
   * password gate (a login page, a token-checked API). Asked only while the
   * plugin is running, so turning a plugin off closes its open doors too.
   */
  isPublic?(pathname: string, method: string): boolean;
  /** Handle the request. Return true if it was answered, false to let the next route try. */
  handle(ctx: C): Promise<boolean> | boolean;
}

export interface PluginHostContext {
  readonly pluginId: string;
  /** Services of the plugins this one `requires`; throws if one is missing. */
  service<T = unknown>(name: string): T;
  /** Same, but undefined when nobody offers it. For optional links. */
  optionalService<T = unknown>(name: string): T | undefined;
  log(message: string): void;
}

export interface KernelPlugin<C = unknown> {
  id: string;
  version?: string;
  description?: string;
  /** Ids of plugins that must be running before this one starts. */
  requires?: string[];
  /** Service names start() returns. The host checks start() really returned each one. */
  provides?: string[];
  /** Only the owner may stop it. See the note at the top of this file. */
  guarded?: boolean;
  /** Lower starts first among plugins with no dependency between them. Default 100. */
  order?: number;
  /** HTTP routes this plugin owns, served only while it is running. */
  routes?: PluginRoute<C>[];
  /** Start. Return the services named in `provides`, by name. */
  start(ctx: PluginHostContext): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  stop?(): Promise<void> | void;
}

export interface PluginStatus {
  id: string;
  version: string;
  description: string;
  state: PluginState;
  enabled: boolean;
  guarded: boolean;
  requires: string[];
  provides: string[];
  error?: string;
}

/** Where the on/off choices live. The host does not know about files. */
export interface PluginEnabledStore {
  load(): Record<string, boolean>;
  save(enabled: Record<string, boolean>): void;
}

export type PluginHostEvent = { type: "state"; id: string; state: PluginState; error?: string };

export interface PluginRefusal { ok: false; reason: string }
export interface PluginOk { ok: true; changed: string[] }
export type PluginResult = PluginOk | PluginRefusal;

interface Entry<C> {
  plugin: KernelPlugin<C>;
  state: PluginState;
  error?: string;
  services: Record<string, unknown>;
}

export class PluginHost<C = unknown> {
  private entries = new Map<string, Entry<C>>();
  private serviceOwner = new Map<string, string>();
  private enabled: Record<string, boolean>;
  /** Stopped only because something they need was turned off; they restart with it. */
  private cascaded = new Set<string>();
  private listeners: Array<(e: PluginHostEvent) => void> = [];
  private logger: (message: string) => void;

  private store?: PluginEnabledStore;

  constructor(store?: PluginEnabledStore, logger?: (message: string) => void) {
    this.store = store;
    this.logger = logger ?? (() => undefined);
    let saved: Record<string, boolean> = {};
    try { saved = store?.load() ?? {}; } catch { saved = {}; }
    this.enabled = { ...saved };
  }

  // ── registering ───────────────────────────────────────────────────────

  register(plugin: KernelPlugin<C>): void {
    if (!plugin || typeof plugin.id !== "string" || !plugin.id) throw new Error("A plugin needs an id.");
    if (typeof plugin.start !== "function") throw new Error(`Plugin "${plugin.id}" has no start().`);
    if (this.entries.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is already registered.`);
    this.entries.set(plugin.id, { plugin, state: "registered", services: {} });
  }

  has(id: string): boolean { return this.entries.has(id); }

  onEvent(listener: (e: PluginHostEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  // ── starting and stopping ────────────────────────────────────────────

  /** Start every enabled plugin, dependencies first. One plugin failing never stops the others. */
  async startAll(): Promise<void> {
    const order = this.startOrder();
    for (const id of order) {
      if (!this.isEnabled(id)) { this.setState(id, "stopped"); continue; }
      await this.startOne(id);
    }
  }

  /** Stop every running plugin, dependents first. */
  async stopAll(): Promise<void> {
    const order = this.startOrder().reverse();
    for (const id of order) await this.stopOne(id);
  }

  /**
   * Turn a plugin on (and whatever it needs). The choice is saved.
   * Refuses if a plugin it needs is not registered.
   */
  async enable(id: string): Promise<PluginResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: `No plugin called "${id}".` };
    const chain = this.dependencyChain(id);
    const missing = chain.find(x => !this.entries.has(x));
    if (missing) return { ok: false, reason: `"${id}" needs "${missing}", which is not installed.` };
    const changed: string[] = [];
    for (const dep of chain) {
      this.enabled[dep] = true;
      if (this.entries.get(dep)!.state !== "running") {
        await this.startOne(dep);
        changed.push(dep);
      }
    }
    // Plugins that were only stopped because this one was, and are still wanted, come back.
    for (const x of this.startOrder()) {
      if (!this.cascaded.has(x) || !this.isEnabled(x) || this.entries.get(x)!.state === "running") continue;
      if (!chain.includes(x) && !this.dependentsOf(id).includes(x)) continue;
      this.cascaded.delete(x);
      await this.startOne(x);
      changed.push(x);
    }
    this.persist();
    const bad = chain.find(x => this.entries.get(x)!.state !== "running");
    if (bad) return { ok: false, reason: `"${bad}" did not start: ${this.entries.get(bad)!.error ?? "see its status"}` };
    return { ok: true, changed };
  }

  /**
   * Turn a plugin off, and everything that needs it. The choice is saved.
   * A guarded plugin, or anything that needs one, is refused unless `actor`
   * is "owner". The check is made before anything is stopped, so a refusal
   * changes nothing.
   */
  async disable(id: string, actor: PluginActor): Promise<PluginResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: `No plugin called "${id}".` };
    const toStop = [id, ...this.dependentsOf(id)];
    if (actor !== "owner") {
      const guarded = toStop.find(x => this.entries.get(x)!.plugin.guarded);
      if (guarded) {
        return { ok: false, reason: `"${guarded}" is guarded: only the owner can turn it off${guarded === id ? "" : `, and "${id}" cannot stop while it is on`}.` };
      }
    }
    // Dependents first, then the plugin itself.
    const ordered = this.startOrder().filter(x => toStop.includes(x)).reverse();
    const changed: string[] = [];
    for (const x of ordered) {
      if (this.entries.get(x)!.state === "running" || this.entries.get(x)!.state === "failed") changed.push(x);
      await this.stopOne(x);
      if (x !== id) this.cascaded.add(x);
    }
    this.cascaded.delete(id);
    this.enabled[id] = false;
    this.persist();
    return { ok: true, changed };
  }

  // ── asking ────────────────────────────────────────────────────────────

  isEnabled(id: string): boolean { return this.enabled[id] !== false; }

  isRunning(id: string): boolean { return this.entries.get(id)?.state === "running"; }

  /** A running plugin's service, or undefined. */
  service<T = unknown>(name: string): T | undefined {
    const owner = this.serviceOwner.get(name);
    if (!owner || !this.isRunning(owner)) return undefined;
    return this.entries.get(owner)!.services[name] as T;
  }

  status(): PluginStatus[] {
    return [...this.entries.values()].map(e => ({
      id: e.plugin.id,
      version: e.plugin.version ?? "1.0.0",
      description: e.plugin.description ?? "",
      state: e.state,
      enabled: this.isEnabled(e.plugin.id),
      guarded: !!e.plugin.guarded,
      requires: [...(e.plugin.requires ?? [])],
      provides: [...(e.plugin.provides ?? [])],
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  /** The routes of running plugins, in start order. */
  routes(): Array<{ pluginId: string; route: PluginRoute<C> }> {
    const out: Array<{ pluginId: string; route: PluginRoute<C> }> = [];
    for (const id of this.startOrder()) {
      const e = this.entries.get(id)!;
      if (e.state !== "running") continue;
      for (const route of e.plugin.routes ?? []) out.push({ pluginId: id, route });
    }
    return out;
  }

  /** Does a running plugin say this path is open without the password gate? */
  isPublicRoute(pathname: string, method: string): boolean {
    for (const { route } of this.routes()) {
      try { if (route.isPublic?.(pathname, method)) return true; } catch { /* a broken check is "not public" */ }
    }
    return false;
  }

  /**
   * Offer a request to every running plugin's routes. True if one answered.
   * A route that throws does not take the server down: the error goes to the
   * log and the next route is tried; the caller still decides what to send if
   * nothing answered.
   */
  async dispatchRoute(pathname: string, method: string, ctx: C): Promise<boolean> {
    for (const { pluginId, route } of this.routes()) {
      let matched = false;
      try { matched = route.match(pathname, method); } catch { matched = false; }
      if (!matched) continue;
      if (await route.handle(ctx)) return true;
      this.logger(`route of "${pluginId}" matched ${method} ${pathname} but did not answer`);
    }
    return false;
  }

  // ── inside ────────────────────────────────────────────────────────────

  private async startOne(id: string): Promise<void> {
    const entry = this.entries.get(id)!;
    if (entry.state === "running") return;
    const { plugin } = entry;
    const blocked = (plugin.requires ?? []).find(r => !this.isRunning(r));
    if (blocked) {
      this.setState(id, "failed", this.entries.has(blocked)
        ? `needs "${blocked}", which is not running`
        : `needs "${blocked}", which is not installed`);
      return;
    }
    this.setState(id, "starting");
    try {
      const ctx = this.contextFor(plugin);
      const offered = ((await plugin.start(ctx)) ?? {}) as Record<string, unknown>;
      for (const name of plugin.provides ?? []) {
        if (!(name in offered)) throw new Error(`promised service "${name}" but start() did not return it`);
        const other = this.serviceOwner.get(name);
        if (other && other !== id && this.isRunning(other)) throw new Error(`service "${name}" is already offered by "${other}"`);
      }
      entry.services = offered;
      for (const name of plugin.provides ?? []) this.serviceOwner.set(name, id);
      this.setState(id, "running");
    } catch (err) {
      entry.services = {};
      this.setState(id, "failed", err instanceof Error ? err.message : String(err));
    }
  }

  private async stopOne(id: string): Promise<void> {
    const entry = this.entries.get(id)!;
    if (entry.state !== "running" && entry.state !== "failed" && entry.state !== "starting") {
      if (entry.state === "registered") this.setState(id, "stopped");
      return;
    }
    this.setState(id, "stopping");
    let error: string | undefined;
    try { await entry.plugin.stop?.(); } catch (err) { error = `stop failed: ${err instanceof Error ? err.message : String(err)}`; }
    for (const name of entry.plugin.provides ?? []) {
      if (this.serviceOwner.get(name) === id) this.serviceOwner.delete(name);
    }
    entry.services = {};
    // Stopped either way: a plugin that cannot stop cleanly must not stay "running".
    this.setState(id, "stopped", error);
  }

  private contextFor(plugin: KernelPlugin<C>): PluginHostContext {
    const allowed = new Set(plugin.requires ?? []);
    const lookup = <T,>(name: string): T | undefined => {
      const owner = this.serviceOwner.get(name);
      if (!owner || !allowed.has(owner)) return undefined;
      return this.service<T>(name);
    };
    return {
      pluginId: plugin.id,
      service: <T,>(name: string): T => {
        const v = lookup<T>(name);
        if (v === undefined) throw new Error(`"${plugin.id}" asked for service "${name}", which none of its required plugins offer`);
        return v;
      },
      optionalService: <T,>(name: string): T | undefined => lookup<T>(name),
      log: (m: string) => this.logger(`[${plugin.id}] ${m}`),
    };
  }

  /** Every plugin that needs `id`, directly or not. */
  private dependentsOf(id: string): string[] {
    const found = new Set<string>();
    const walk = (target: string): void => {
      for (const [other, e] of this.entries) {
        if (found.has(other) || other === id) continue;
        if ((e.plugin.requires ?? []).includes(target)) { found.add(other); walk(other); }
      }
    };
    walk(id);
    return [...found];
  }

  /** `id` and everything it needs, needs first. Unknown ids are included so the caller can report them. */
  private dependencyChain(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (x: string): void => {
      if (seen.has(x)) return;
      seen.add(x);
      for (const r of this.entries.get(x)?.plugin.requires ?? []) visit(r);
      out.push(x);
    };
    visit(id);
    return out;
  }

  /**
   * All registered plugin ids, each after the plugins it requires; ties broken
   * by `order` then by id so the order is the same on every machine. A cycle
   * is an error in the plugin set, not something to start around.
   */
  private startOrder(): string[] {
    const ids = [...this.entries.keys()];
    const rank = (id: string): number => this.entries.get(id)!.plugin.order ?? 100;
    ids.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    const out: string[] = [];
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): void => {
      const s = state.get(id);
      if (s === 2) return;
      if (s === 1) throw new Error(`Plugin cycle: ${[...trail, id].join(" -> ")}`);
      state.set(id, 1);
      const reqs = [...(this.entries.get(id)!.plugin.requires ?? [])].filter(r => this.entries.has(r));
      reqs.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
      for (const r of reqs) visit(r, [...trail, id]);
      state.set(id, 2);
      out.push(id);
    };
    for (const id of ids) visit(id, []);
    return out;
  }

  private setState(id: string, state: PluginState, error?: string): void {
    const entry = this.entries.get(id)!;
    entry.state = state;
    if (error) entry.error = error; else if (state === "running" || state === "starting") delete entry.error;
    for (const l of this.listeners) {
      try { l({ type: "state", id, state, ...(error ? { error } : {}) }); } catch { /* a listener must not break the host */ }
    }
  }

  private persist(): void {
    try { this.store?.save({ ...this.enabled }); } catch (err) {
      this.logger(`could not save which plugins are on: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
