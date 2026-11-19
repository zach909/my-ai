import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  PluginHub, OllamaAdapter, MemoryStorage, JsonlStorage, adoptRegistryTools,
  type HubPlugin, type ModelAdapter, type StoragePlugin,
} from "../../plugin_manager/index.js";
import { PluginRegistry } from "../../plugin_manager/registry.js";

const fake = (id: string, kind: HubPlugin["kind"] = "tool"): HubPlugin => ({ id, name: id, kind });

describe("PluginHub", () => {
  it("registers by kind, defaults to the first, and rejects duplicates", () => {
    const hub = new PluginHub();
    hub.register(fake("a", "storage"));
    hub.register(fake("b", "storage"));
    expect(hub.resolve("storage").id).toBe("a");
    hub.setDefault("storage", "b");
    expect(hub.resolve("storage").id).toBe("b");
    expect(() => hub.register(fake("a", "storage"))).toThrow(/already registered/);
    expect(hub.list("storage")).toHaveLength(2);
    expect(() => hub.resolve("model")).toThrow(/No model plugin/);
    expect(() => hub.register({ id: "x", name: "x", kind: "bogus" as never })).toThrow(/Unknown plugin kind/);
  });

  it("allows the same id in different kinds", () => {
    const hub = new PluginHub();
    hub.register(fake("x", "tool"));
    hub.register(fake("x", "ui"));
    expect(hub.list()).toHaveLength(2);
  });

  it("activates once, and one failure does not stop activateAll", async () => {
    const hub = new PluginHub();
    let calls = 0;
    hub.register({ ...fake("ok"), activate: async () => { calls++; } });
    hub.register({ ...fake("bad"), activate: async () => { throw new Error("boom"); } });
    const failures = await hub.activateAll();
    await hub.activate("tool", "ok");
    expect(calls).toBe(1);
    expect(failures).toEqual([{ kind: "tool", id: "bad", error: "boom" }]);
    expect(hub.isActive("tool", "ok")).toBe(true);
    expect(hub.isActive("tool", "bad")).toBe(false);
  });

  it("moves the default when the default is unregistered", async () => {
    const hub = new PluginHub();
    hub.register(fake("a", "model"));
    hub.register(fake("b", "model"));
    await hub.unregister("model", "a");
    expect(hub.resolve("model").id).toBe("b");
  });

  it("reports health, treating a throw as unhealthy", async () => {
    const hub = new PluginHub();
    hub.register({ ...fake("up"), health: async () => true });
    hub.register({ ...fake("down"), health: async () => { throw new Error("x"); } });
    const h = await hub.health();
    expect(h.get("tool:up")).toBe(true);
    expect(h.get("tool:down")).toBe(false);
  });

  it("adopts the real tool plugins in a PluginRegistry without changing the registry", async () => {
    const registry = new PluginRegistry();
    await registry.bootstrap();
    const before = registry.getPluginCount();
    const hub = new PluginHub();
    const adopted = adoptRegistryTools(hub, registry);
    expect(adopted).toBe(before);
    expect(hub.list("tool")).toHaveLength(before);
    expect(registry.getPluginCount()).toBe(before);
    expect(adoptRegistryTools(hub, registry)).toBe(0);
  });
});

describe("OllamaAdapter", () => {
  const reply = (body: unknown, ok = true, status = 200) =>
    (async () => ({ ok, status, statusText: ok ? "OK" : "Bad", json: async () => body })) as unknown as typeof fetch;

  it("posts to /api/chat and returns the message text", async () => {
    let seen: { url: string; body: any } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ message: { content: "hi" } }) };
    }) as unknown as typeof fetch;
    const adapter: ModelAdapter = new OllamaAdapter({ model: "m1", baseUrl: "http://h:1/", fetchImpl });
    const out = await adapter.complete({ messages: [{ role: "user", content: "yo" }], temperature: 0.2 });
    expect(out).toEqual({ text: "hi", model: "m1" });
    expect(seen!.url).toBe("http://h:1/api/chat");
    expect(seen!.body).toMatchObject({ model: "m1", stream: false, options: { temperature: 0.2 } });
  });

  it("throws on HTTP errors and malformed replies, and reports health", async () => {
    await expect(new OllamaAdapter({ model: "m", fetchImpl: reply({}, false, 500) }).complete({ messages: [] })).rejects.toThrow(/500/);
    await expect(new OllamaAdapter({ model: "m", fetchImpl: reply({}) }).complete({ messages: [] })).rejects.toThrow(/no message content/);
    expect(await new OllamaAdapter({ model: "m", fetchImpl: reply({}) }).health()).toBe(true);
    const down = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect(await new OllamaAdapter({ model: "m", fetchImpl: down }).health()).toBe(false);
  });
});

describe("storage plugins", () => {
  const exercise = async (s: StoragePlugin) => {
    await s.append("sess 1", { n: 1 });
    await s.append("sess 1", { n: 2 });
    await s.append("sess 1", { n: 3 });
    expect((await s.read("sess 1")).map(r => r.n)).toEqual([1, 2, 3]);
    expect((await s.read("sess 1", { limit: 2 })).map(r => r.n)).toEqual([2, 3]);
    expect(await s.read("missing")).toEqual([]);
    expect((await s.streams()).length).toBe(1);
  };

  it("MemoryStorage", async () => exercise(new MemoryStorage()));

  it("JsonlStorage persists, sanitises stream names, and skips a torn last line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-jsonl-"));
    const s = new JsonlStorage(dir);
    await exercise(s);
    await s.append("../escape", { n: 9 });
    expect(fs.readdirSync(dir).every(f => !f.includes(".."))).toBe(true);
    expect(fs.existsSync(path.join(dir, "..", "escape.jsonl"))).toBe(false);
    fs.appendFileSync(path.join(dir, "sess_1.jsonl"), '{"n":4');
    expect((await s.read("sess 1")).map(r => r.n)).toEqual([1, 2, 3]);
    expect(await s.health()).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });
});
