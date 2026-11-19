/**
 * One plugin contract, one hub.
 *
 * Everything pluggable in NeuroClaw -- model adapters, the agent loop, tools,
 * UI, storage, sandboxes -- is a `HubPlugin` with a `kind`, registered into a
 * single `PluginHub`. There is one lifecycle (activate / deactivate / health)
 * and one lookup (`get`, `list`, `resolve`), so a new category never needs its
 * own registry.
 *
 * This file is deliberately small. It does not replace `PluginRegistry` (which
 * owns neuron wiring and routing for tool plugins); `adoptRegistryTools()`
 * mirrors those plugins into the hub as kind "tool" without changing them.
 *
 * Only `model` and `storage` have interfaces so far. `loop`, `ui` and `sandbox`
 * are reserved kinds: they can be registered, but their contracts are not
 * defined until a second implementation needs one.
 */

import type { BasePlugin } from "./sdk.js";
import type { PluginDefinition } from "./types.js";

export type PluginKind = "model" | "loop" | "tool" | "ui" | "storage" | "sandbox";

export const PLUGIN_KINDS: readonly PluginKind[] = ["model", "loop", "tool", "ui", "storage", "sandbox"];

/** The one shape every plugin of every kind has. */
export interface HubPlugin {
  readonly id: string;
  readonly name: string;
  readonly kind: PluginKind;
  readonly version?: string;
  activate?(): Promise<void>;
  deactivate?(): Promise<void>;
  /** Resolves true when the plugin can do its job right now. Absent means "assume yes". */
  health?(): Promise<boolean>;
}

export class PluginHub {
  private readonly byKind = new Map<PluginKind, Map<string, HubPlugin>>();
  private readonly defaults = new Map<PluginKind, string>();
  private readonly active = new Set<string>();

  private static key(kind: PluginKind, id: string): string {
    return `${kind}:${id}`;
  }

  /** Add a plugin. The first of a kind becomes that kind's default. Ids are unique within a kind. */
  register<T extends HubPlugin>(plugin: T): T {
    if (!PLUGIN_KINDS.includes(plugin.kind)) {
      throw new Error(`Unknown plugin kind "${String(plugin.kind)}" for ${plugin.id}.`);
    }
    if (!plugin.id) throw new Error("A plugin needs an id.");
    let group = this.byKind.get(plugin.kind);
    if (!group) {
      group = new Map();
      this.byKind.set(plugin.kind, group);
    }
    if (group.has(plugin.id)) {
      throw new Error(`A ${plugin.kind} plugin called "${plugin.id}" is already registered.`);
    }
    group.set(plugin.id, plugin);
    if (!this.defaults.has(plugin.kind)) this.defaults.set(plugin.kind, plugin.id);
    return plugin;
  }

  async unregister(kind: PluginKind, id: string): Promise<boolean> {
    const group = this.byKind.get(kind);
    if (!group?.has(id)) return false;
    await this.deactivate(kind, id);
    group.delete(id);
    if (this.defaults.get(kind) === id) {
      const next = group.keys().next();
      if (next.done) this.defaults.delete(kind);
      else this.defaults.set(kind, next.value);
    }
    return true;
  }

  get<T extends HubPlugin = HubPlugin>(kind: PluginKind, id: string): T | undefined {
    return this.byKind.get(kind)?.get(id) as T | undefined;
  }

  list<T extends HubPlugin = HubPlugin>(kind?: PluginKind): T[] {
    if (kind) return [...(this.byKind.get(kind)?.values() ?? [])] as T[];
    return PLUGIN_KINDS.flatMap(k => [...(this.byKind.get(k)?.values() ?? [])]) as T[];
  }

  setDefault(kind: PluginKind, id: string): void {
    if (!this.get(kind, id)) throw new Error(`No ${kind} plugin called "${id}".`);
    this.defaults.set(kind, id);
  }

  /** The plugin to use for a kind: the named one, else that kind's default. */
  resolve<T extends HubPlugin = HubPlugin>(kind: PluginKind, id?: string): T {
    const plugin = this.get<T>(kind, id ?? this.defaults.get(kind) ?? "");
    if (!plugin) {
      throw new Error(id ? `No ${kind} plugin called "${id}".` : `No ${kind} plugin is registered.`);
    }
    return plugin;
  }

  isActive(kind: PluginKind, id: string): boolean {
    return this.active.has(PluginHub.key(kind, id));
  }

  async activate(kind: PluginKind, id: string): Promise<void> {
    const plugin = this.resolve(kind, id);
    const key = PluginHub.key(kind, id);
    if (this.active.has(key)) return;
    await plugin.activate?.();
    this.active.add(key);
  }

  async deactivate(kind: PluginKind, id: string): Promise<void> {
    const plugin = this.get(kind, id);
    const key = PluginHub.key(kind, id);
    if (!plugin || !this.active.has(key)) return;
    this.active.delete(key);
    await plugin.deactivate?.();
  }

  /** Activate everything registered. One plugin failing does not stop the rest; failures are returned. */
  async activateAll(): Promise<{ kind: PluginKind; id: string; error: string }[]> {
    const failures: { kind: PluginKind; id: string; error: string }[] = [];
    for (const plugin of this.list()) {
      try {
        await this.activate(plugin.kind, plugin.id);
      } catch (err) {
        failures.push({ kind: plugin.kind, id: plugin.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  async deactivateAll(): Promise<void> {
    for (const plugin of this.list()) await this.deactivate(plugin.kind, plugin.id);
  }

  async health(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const plugin of this.list()) {
      let ok = true;
      try {
        ok = plugin.health ? await plugin.health() : true;
      } catch {
        ok = false;
      }
      out.set(PluginHub.key(plugin.kind, plugin.id), ok);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Existing tool plugins
// ---------------------------------------------------------------------------

/** The slice of PluginRegistry that adoption needs. PluginRegistry satisfies it. */
export interface ToolPluginSource {
  listDefinitions(): PluginDefinition[];
  getPluginInstance(pluginId: string): BasePlugin | undefined;
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

/**
 * Mirror every plugin already in a PluginRegistry into the hub as kind "tool".
 * The registry stays the owner: activation and health go through it, so
 * nothing about how those plugins run changes. Returns how many were adopted.
 */
export function adoptRegistryTools(hub: PluginHub, source: ToolPluginSource): number {
  let adopted = 0;
  for (const def of source.listDefinitions()) {
    if (hub.get("tool", def.id)) continue;
    hub.register({
      id: def.id,
      name: def.name,
      kind: "tool",
      activate: () => source.activate(def.id),
      deactivate: () => source.deactivate(def.id),
      health: async () => (await source.getPluginInstance(def.id)?.onHealthCheck?.()) ?? false,
    });
    adopted++;
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// kind: "model"
// ---------------------------------------------------------------------------

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Provider-specific model name. Absent means the adapter's own default. */
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  model: string;
}

/** Connects the harness to one model provider. Text in, text out. */
export interface ModelAdapter extends HubPlugin {
  readonly kind: "model";
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface OllamaAdapterOptions {
  id?: string;
  /** Base URL of an Ollama server you run. Defaults to the usual local port. */
  baseUrl?: string;
  model: string;
  /** Replaceable so tests need no server. Defaults to the built-in `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Talks to an Ollama server over HTTP (/api/chat). Nothing from Ollama is imported or vendored. */
export class OllamaAdapter implements ModelAdapter {
  readonly kind = "model" as const;
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaAdapterOptions) {
    this.id = options.id ?? "ollama";
    this.name = "Ollama";
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model ?? this.model;
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages,
        stream: false,
        ...(request.temperature !== undefined ? { options: { temperature: request.temperature } } : {}),
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status} ${res.statusText}`.trim());
    const body = (await res.json()) as { message?: { content?: unknown } };
    const text = body?.message?.content;
    if (typeof text !== "string") throw new Error("Ollama's reply had no message content.");
    return { text, model };
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// kind: "storage"
// ---------------------------------------------------------------------------

export type StorageRecord = Record<string, unknown>;

/** An append-only log of records, grouped into named streams (a session, an action log, ...). */
export interface StoragePlugin extends HubPlugin {
  readonly kind: "storage";
  append(stream: string, record: StorageRecord): Promise<void>;
  /** Oldest first. `limit` keeps the most recent N. */
  read(stream: string, options?: { limit?: number }): Promise<StorageRecord[]>;
  streams(): Promise<string[]>;
}

/** Keeps streams in memory. For tests and throwaway sessions. */
export class MemoryStorage implements StoragePlugin {
  readonly kind = "storage" as const;
  readonly id: string;
  readonly name = "Memory storage";
  private readonly data = new Map<string, StorageRecord[]>();

  constructor(id = "memory") {
    this.id = id;
  }

  async append(stream: string, record: StorageRecord): Promise<void> {
    const list = this.data.get(stream) ?? [];
    list.push({ ...record });
    this.data.set(stream, list);
  }

  async read(stream: string, options: { limit?: number } = {}): Promise<StorageRecord[]> {
    const list = this.data.get(stream) ?? [];
    return (options.limit !== undefined ? list.slice(-Math.max(0, options.limit)) : list).map(r => ({ ...r }));
  }

  async streams(): Promise<string[]> {
    return [...this.data.keys()];
  }
}
