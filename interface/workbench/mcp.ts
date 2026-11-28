/**
 * Tool servers over the Model Context Protocol: a client written from the protocol's own description.
 *
 * Three ways to reach a server, chosen per server in `mcp.json`:
 *   stdio  start a program and talk over its stdin and stdout (no shell; the argv is used as given)
 *   http   POST each message to one URL; the reply is JSON or an event stream (streamable HTTP)
 *   sse    open an event stream, learn the POST address from it, send messages there (older servers)
 *
 *   { "servers": { "docs": { "transport": "stdio", "command": ["my-server", "--flag"], "env": {"MODE": "ro"}, "envPass": ["DOCS_TOKEN"] },
 *                  "wiki": { "transport": "http", "url": "https://tools.example.com/mcp", "bearerEnv": "WIKI_TOKEN" } } }
 *
 * Secrets are never in the file: `bearerEnv` and `envPass` name environment variables to read. A program started over
 * stdio gets a cleaned environment plus only what is listed.
 *
 * Safety, in this order, before a tool runs:
 *   1. a project's own `mcp.json` is ignored until the owner approved that exact file (trust.ts); it starts programs;
 *   2. an administrator's `allowedServers` / `disabled` in the managed file are enforced;
 *   3. the call is a permission request `mcp:<server>:<tool>`: denied stops, asks goes to the approver, which by default
 *      refuses, so an unattended run cannot use a tool nobody allowed;
 *   4. HTTP and SSE servers pass through the offline-mode check (netguard.ts) and must be https unless on this machine;
 *   5. results are size-capped, and a server that stops answering times out instead of hanging the agent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { assertEgress, isLocalHost } from './netguard.js';
import { PROJECT_DIR, workbenchRoot } from './paths.js';
import { SAFE_NAME } from './text-utils.js';
import type { Decision, PermissionEngine } from './permissions.js';
import { TrustStore } from './trust.js';

export type McpTransportKind = 'stdio' | 'http' | 'sse';
export interface McpServerDef {
  transport: McpTransportKind;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envPass?: string[];
  url?: string;
  headers?: Record<string, string>;
  bearerEnv?: string;
  timeoutMs?: number;
}
export interface McpConfigFile { servers: Record<string, McpServerDef> }
export interface McpTool { server: string; name: string; description: string; inputSchema: unknown }

export const PROTOCOL_VERSION = '2025-03-26';
const MAX_RESULT = 100_000;
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'];

/** Check one server definition; returns the reason it is not usable, or null. */
export function validateServer(name: string, d: McpServerDef): string | null {
  if (!SAFE_NAME.test(name)) return `"${name}" is not a valid server name (a-z, 0-9, - and _).`;
  if (d.transport === 'stdio') return Array.isArray(d.command) && d.command.length && d.command.every(c => typeof c === 'string') ? null : 'A stdio server needs a command (a list: the program, then its arguments).';
  if (d.transport === 'http' || d.transport === 'sse') {
    let u: URL;
    try { u = new URL(String(d.url)); } catch { return 'A url is needed.'; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) return 'Only https addresses are allowed (http only for this machine).';
    return null;
  }
  return 'transport must be stdio, http or sse.';
}

// ── Transports: each gives the peer an input and an output stream ──

function stdioStreams(d: McpServerDef, cwd: string): { input: PassThrough; output: Writable; child: ChildProcess } {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of d.envPass ?? []) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, d.env ?? {});
  const child = spawn(d.command![0], d.command!.slice(1), { cwd: d.cwd ? path.resolve(cwd, d.cwd) : cwd, env, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
  const input = new PassThrough();
  child.stdout!.pipe(input);
  child.on('error', () => input.end());
  child.on('close', () => input.end());
  return { input, output: child.stdin!, child };
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { void reader.cancel(); throw new Error('The server\'s reply was too large.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Pull `data:` payloads out of an event stream text. */
export function sseEvents(text: string): Array<{ event: string; data: string }> {
  return text.replace(/\r\n/g, '\n').split('\n\n').map(block => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return { event, data: data.join('\n') };
  }).filter(e => e.data);
}

function authHeaders(d: McpServerDef): Record<string, string> {
  const h: Record<string, string> = { ...(d.headers ?? {}) };
  if (d.bearerEnv) { const t = process.env[d.bearerEnv]; if (t) h.Authorization = `Bearer ${t}`; }
  return h;
}

function httpStreams(d: McpServerDef): { input: PassThrough; output: Writable; close: () => void } {
  const url = String(d.url);
  const input = new PassThrough();
  let session: string | undefined;
  const ac = new AbortController();
  const output = new Writable({
    write(chunk, _enc, cb) {
      const body = chunk.toString('utf8').trim();
      cb();
      if (!body) return;
      void (async () => {
        try {
          assertEgress(url, 'a tool server');
          const res = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.any([ac.signal, AbortSignal.timeout(d.timeoutMs ?? 60_000)]),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION, ...(session ? { 'Mcp-Session-Id': session } : {}), ...authHeaders(d) },
            body,
          });
          session = res.headers.get('mcp-session-id') ?? session;
          if (res.status === 202 || res.status === 204) return;
          const text = await readCapped(res, 8 * 1024 * 1024);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) for (const e of sseEvents(text)) input.write(e.data.replace(/\n/g, ' ') + '\n');
          else input.write(text.replace(/\r?\n/g, ' ') + '\n');
        } catch (e) {
          // Turn a failed POST into an error reply for that request id so the caller is not left waiting.
          try { const id = JSON.parse(body).id; if (id !== undefined) input.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } }) + '\n'); } catch { /* notification */ }
        }
      })();
    },
  });
  return { input, output, close: () => { ac.abort(); input.end(); } };
}

function sseStreams(d: McpServerDef): { input: PassThrough; output: Writable; close: () => void } {
  const base = String(d.url);
  const input = new PassThrough();
  const ac = new AbortController();
  let endpoint: string | null = null;
  const waiters: Array<() => void> = [];
  void (async () => {
    try {
      assertEgress(base, 'a tool server');
      const res = await fetch(base, { redirect: 'error', signal: ac.signal, headers: { Accept: 'text/event-stream', ...authHeaders(d) } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += Buffer.from(value).toString('utf8');
        if (acc.length > 16 * 1024 * 1024) throw new Error('too much data');
        const cut = acc.replace(/\r\n/g, '\n').lastIndexOf('\n\n');
        if (cut === -1) continue;
        const ready = acc.replace(/\r\n/g, '\n').slice(0, cut + 2);
        acc = acc.replace(/\r\n/g, '\n').slice(cut + 2);
        for (const e of sseEvents(ready)) {
          if (e.event === 'endpoint') {
            const next = new URL(e.data.trim(), base);
            if (next.origin !== new URL(base).origin) throw new Error('The server pointed to a different host.');
            endpoint = next.toString();
            waiters.splice(0).forEach(w => w());
          } else input.write(e.data.replace(/\n/g, ' ') + '\n');
        }
      }
    } catch { /* stream ended */ } finally { input.end(); }
  })();
  const output = new Writable({
    write(chunk, _enc, cb) {
      cb();
      const body = chunk.toString('utf8').trim();
      if (!body) return;
      void (async () => {
        if (!endpoint) await new Promise<void>(r => { waiters.push(r); setTimeout(r, 10_000); });
        if (!endpoint) return;
        try { await fetch(endpoint, { method: 'POST', redirect: 'error', signal: ac.signal, headers: { 'Content-Type': 'application/json', ...authHeaders(d) }, body }); } catch { /* the request times out */ }
      })();
    },
  });
  return { input, output, close: () => { ac.abort(); input.end(); } };
}

export class McpConnection {
  peer: JsonRpcPeer | null = null;
  private stop: () => void = () => undefined;
  tools: McpTool[] = [];
  constructor(readonly name: string, readonly def: McpServerDef, private cwd: string) {}

  async connect(): Promise<void> {
    const bad = validateServer(this.name, this.def);
    if (bad) throw new Error(bad);
    let s: { input: PassThrough; output: Writable };
    if (this.def.transport === 'stdio') { const x = stdioStreams(this.def, this.cwd); s = x; this.stop = () => { x.child.kill(); }; }
    else if (this.def.transport === 'http') { const x = httpStreams(this.def); s = x; this.stop = x.close; }
    else { const x = sseStreams(this.def); s = x; this.stop = x.close; }
    this.peer = new JsonRpcPeer(s.input, s.output, 'ndjson');
    const timeout = this.def.timeoutMs ?? 30_000;
    await this.peer.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'neuroclaw', version: '0.1.0' } }, timeout);
    this.peer.notify('notifications/initialized');
    const listed = await this.peer.request<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>('tools/list', {}, timeout);
    this.tools = (listed.tools ?? []).slice(0, 500).map(t => ({ server: this.name, name: String(t.name), description: String(t.description ?? '').slice(0, 500), inputSchema: t.inputSchema ?? {} }));
  }

  async call(tool: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (!this.peer || this.peer.isClosed) throw new Error(`${this.name} is not connected.`);
    const r = await this.peer.request<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>('tools/call', { name: tool, arguments: args ?? {} }, this.def.timeoutMs ?? 60_000);
    let text = (r.content ?? []).map(c => c.type === 'text' ? String(c.text ?? '') : `[${c.type} content not shown]`).join('\n');
    if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + '\n…(truncated)';
    return { text, isError: r.isError === true };
  }

  close(): void { this.peer?.close(); try { this.stop(); } catch { /* gone */ } this.peer = null; }
}

// ── Config and the manager ──

export interface McpPolicy { disabled?: boolean; allowedServers?: string[] }

export class McpManager {
  private conns = new Map<string, McpConnection>();
  constructor(private opts: {
    root: string;
    engine: PermissionEngine;
    trust: TrustStore;
    policy?: () => McpPolicy;
    dataDir?: string;
    /** Asked when a rule says "ask". Without one, anything that asks is refused. */
    approve?: (what: { server: string; tool: string; args: unknown }) => Promise<boolean>;
    extra?: () => Record<string, McpServerDef>;
  }) {}

  private userFile(): string { return path.join(workbenchRoot(this.opts.dataDir), 'mcp.json'); }
  private projectFile(): string { return path.join(this.opts.root, PROJECT_DIR, 'mcp.json'); }

  private readFile(file: string): { servers: Record<string, McpServerDef>; raw: string } {
    try { const raw = readFileSync(file, 'utf8'); const v = JSON.parse(raw); return { servers: v && typeof v.servers === 'object' ? v.servers : {}, raw }; } catch { return { servers: {}, raw: '' }; }
  }

  /** Every usable server definition, with where it came from and why an unusable one is left out. */
  configs(): Array<{ name: string; def: McpServerDef; scope: 'user' | 'project' | 'bundle'; problem?: string }> {
    const out: Array<{ name: string; def: McpServerDef; scope: 'user' | 'project' | 'bundle'; problem?: string }> = [];
    const pol = this.opts.policy?.() ?? {};
    const push = (servers: Record<string, McpServerDef>, scope: 'user' | 'project' | 'bundle', gate?: string) => {
      for (const [name, def] of Object.entries(servers)) {
        let problem = gate ?? validateServer(name, def) ?? undefined;
        if (!problem && pol.disabled) problem = 'Tool servers are turned off by an administrator.';
        if (!problem && pol.allowedServers && !pol.allowedServers.includes(name)) problem = 'Not on the administrator\'s list of allowed servers.';
        out.push({ name, def, scope, problem });
      }
    };
    push(this.readFile(this.userFile()).servers, 'user');
    const proj = this.readFile(this.projectFile());
    if (proj.raw) push(proj.servers, 'project', this.opts.trust.isTrusted(this.opts.root, 'mcp', proj.raw) ? undefined : 'This project\'s tool-server file has not been approved yet.');
    push(this.opts.extra?.() ?? {}, 'bundle');
    return out;
  }

  add(scope: 'user' | 'project', name: string, def: McpServerDef): { ok: boolean; reason?: string } {
    const bad = validateServer(name, def);
    if (bad) return { ok: false, reason: bad };
    const file = scope === 'user' ? this.userFile() : this.projectFile();
    const cur = this.readFile(file).servers;
    cur[name] = def;
    writeJsonAtomic(file, { servers: cur });
    return { ok: true };
  }

  remove(scope: 'user' | 'project', name: string): boolean {
    const file = scope === 'user' ? this.userFile() : this.projectFile();
    const cur = this.readFile(file).servers;
    if (!(name in cur)) return false;
    delete cur[name];
    writeJsonAtomic(file, { servers: cur });
    this.conns.get(name)?.close();
    this.conns.delete(name);
    return true;
  }

  /** Approve the project's current file so its servers may start. The owner calls this on purpose. */
  trustProject(): boolean {
    const f = this.readFile(this.projectFile());
    if (!f.raw) return false;
    this.opts.trust.trust(this.opts.root, 'mcp', f.raw);
    return true;
  }

  async connect(name: string): Promise<McpConnection> {
    const existing = this.conns.get(name);
    if (existing?.peer && !existing.peer.isClosed) return existing;
    const cfg = this.configs().find(c => c.name === name);
    if (!cfg) throw new Error(`No tool server named ${name}.`);
    if (cfg.problem) throw new Error(`${name}: ${cfg.problem}`);
    const conn = new McpConnection(name, cfg.def, this.opts.root);
    try { await conn.connect(); } catch (e) { conn.close(); throw e; }
    this.conns.set(name, conn);
    return conn;
  }

  async tools(): Promise<{ tools: McpTool[]; errors: string[] }> {
    const tools: McpTool[] = [];
    const errors: string[] = [];
    for (const c of this.configs()) {
      if (c.problem) { errors.push(`${c.name}: ${c.problem}`); continue; }
      try { tools.push(...(await this.connect(c.name)).tools); } catch (e) { errors.push(`${c.name}: ${(e as Error).message}`); }
    }
    return { tools, errors };
  }

  async call(server: string, tool: string, args: unknown, agent?: string): Promise<{ ok: boolean; text: string; decision: Decision }> {
    const v = this.opts.engine.evaluate({ tool: `mcp:${server}:${tool}`, target: tool, agent });
    if (v.decision === 'deny') return { ok: false, text: v.reason, decision: 'deny' };
    if (v.decision === 'ask') {
      const yes = this.opts.approve ? await this.opts.approve({ server, tool, args }) : false;
      if (!yes) return { ok: false, text: `${server}/${tool} needs approval and none was given. ${v.reason}`, decision: 'ask' };
    }
    try {
      const r = await (await this.connect(server)).call(tool, args);
      return { ok: !r.isError, text: r.text, decision: v.decision };
    } catch (e) { return { ok: false, text: (e as Error).message, decision: v.decision }; }
  }

  closeAll(): void { for (const c of this.conns.values()) c.close(); this.conns.clear(); }
}
