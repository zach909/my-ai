/**
 * The workbench: everything in this folder, joined into one object a turn can run through.
 *
 * It owns no model. A caller gives it an `Executor` (the engine call) and every turn then goes through the same steps:
 *
 *   slash command expanded -> UserPromptSubmit hooks -> instructions + memory + route chosen -> checkpoint opened
 *   -> engine runs (its tool use passes `runTool`) -> checkpoint closed -> compaction if long -> session saved -> Stop hooks
 *
 * `runTool` is the single door for a tool the workbench runs for the agent: permission rules, then the project's tool gate
 * if one is given (the stricter verdict wins), then PreToolUse hooks, a checkpoint of the files it will change, the tool
 * itself, formatters, PostToolUse hooks and diagnostics. Nothing in here can loosen a refusal.
 *
 * Settings come in layers and only restrict as they go down: managed (administrator) > user > project > built-in. A
 * project's own settings, hooks, tool servers and language servers are read but its permission `allow` rules and its hooks
 * and servers do nothing until the owner approves that exact file with `trustProject`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAgentsFrom, mergeAgents, BUILTIN_AGENTS, agentRules, findAgent, type AgentDef } from './agents.js';
import { loadCommandsFrom, expandCommand, parseSlash, type CommandDef } from './commands.js';
import { CheckpointStore } from './checkpoints.js';
import { compact, needsCompaction, type Message, type CompactOptions } from './compaction.js';
import { DiagnosticsService, renderDiagnostics } from './diagnostics.js';
import { HookRunner, mergeHookConfigs, sanitizeHookConfig, type HookConfig } from './hooks.js';
import { AutoMemory, Instructions } from './instructions.js';
import { McpManager, type McpServerDef } from './mcp.js';
import { onFileWillChange } from './observers.js';
import { BUILTIN_RULES, mostRestrictive, PermissionEngine, sanitizeConfig, type Decision, type Layer, type PermissionConfig, type Verdict } from './permissions.js';
import { PROJECT_DIR, confine, managedFile, workbenchRoot, relPosix } from './paths.js';
import { resolveRoute, type Route, type RoutingConfig } from './routing.js';
import { SessionStore, type SessionMessage } from './sessions.js';
import { runSubagents, type Executor as SubExecutor, type SubagentResult } from './teams.js';
import { TrustStore } from './trust.js';
import { UsageLedger } from './usage.js';
import { BundleStore } from './bundles.js';

export interface ManagedPolicy {
  permissions?: PermissionConfig;
  hooks?: HookConfig;
  mcp?: { disabled?: boolean; allowedServers?: string[] };
  routing?: RoutingConfig;
  offline?: boolean;
  /** Ignore a project's hooks, tool servers and language servers outright, approved or not. */
  disableProjectExtensions?: boolean;
  usageRetentionDays?: number;
}

export function readManaged(file = managedFile()): ManagedPolicy {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export interface TurnRequest {
  prompt: string;
  session?: string;
  agent?: string;
  /** Extra text a caller wants in front of the prompt for this turn only. */
  context?: string;
  model?: string;
}

export interface EngineCall {
  system: string;
  history: Message[];
  prompt: string;
  agent: AgentDef;
  route: Route;
  session: string;
  /** Run a sub-agent job set in parallel; each gets a fresh context and only its summary returns. */
  subagents(jobs: Array<{ agent: string; prompt: string }>): Promise<SubagentResult[]>;
  runTool: Workbench['runTool'];
}
export type Executor = (call: EngineCall) => Promise<string>;

export interface TurnResult {
  ok: boolean;
  blocked?: boolean;
  text: string;
  session: string;
  agent: string;
  route: Route;
  checkpoint?: string;
  compacted?: boolean;
  warnings: string[];
  ms: number;
}

export interface ToolRequest { tool: string; target?: string; input?: unknown; agent?: string; session?: string }
export interface ToolOutcome<T> { ok: boolean; verdict: Verdict; value?: T; error?: string; notes: string[] }

const FILE_CHANGING = new Set(['edit', 'write', 'delete']);

export interface WorkbenchOptions {
  root: string;
  dataDir?: string;
  executor?: Executor;
  /** The project's own tool gate, if any: returns its verdict for a request. The stricter of the two applies. */
  gate?: (req: ToolRequest) => Decision;
  /** Asked when something needs approval. Without one, anything that asks is refused. */
  approve?: (req: ToolRequest, why: string) => Promise<boolean>;
  managedFile?: string;
  compaction?: CompactOptions;
}

export class Workbench {
  readonly root: string;
  readonly trust: TrustStore;
  readonly sessions: SessionStore;
  readonly checkpoints: CheckpointStore;
  readonly memory: AutoMemory;
  readonly instructions: Instructions;
  readonly usage: UsageLedger;
  readonly bundles: BundleStore;
  readonly engine: PermissionEngine;
  readonly mcp: McpManager;
  readonly diagnostics: DiagnosticsService;
  private hooks: HookRunner;
  private opts: WorkbenchOptions;
  private idleTimer: NodeJS.Timeout | null = null;
  private unobserve: () => void;
  readonly warnings: string[] = [];

  constructor(opts: WorkbenchOptions) {
    this.opts = opts;
    this.root = path.resolve(opts.root);
    this.trust = new TrustStore(opts.dataDir);
    this.sessions = new SessionStore(opts.dataDir);
    this.checkpoints = new CheckpointStore(this.root, opts.dataDir);
    this.memory = new AutoMemory(this.root, opts.dataDir);
    this.instructions = new Instructions(this.root);
    this.bundles = new BundleStore(opts.dataDir);
    this.usage = new UsageLedger(opts.dataDir, this.managed().usageRetentionDays);
    this.engine = new PermissionEngine(this.layers(), { root: this.root });
    this.mcp = new McpManager({
      // Every tool-server call is judged by the same live rules as any other tool (settings are re-read, the agent's own limits apply),
      // not by a copy made when the workbench was created.
      root: this.root, engine: { evaluate: (r) => this.decide({ tool: r.tool, target: r.target, agent: r.agent }) } as PermissionEngine, trust: this.trust, dataDir: opts.dataDir,
      policy: () => this.managed().mcp ?? {},
      approve: opts.approve ? async w => opts.approve!({ tool: `mcp:${w.server}:${w.tool}`, target: w.tool, input: w.args }, 'A tool server tool wants to run.') : undefined,
      extra: () => this.bundleMcp(),
    });
    this.diagnostics = new DiagnosticsService({ root: this.root, trust: this.trust, dataDir: opts.dataDir });
    this.hooks = new HookRunner(this.hookConfig(), this.root);
    // Every file write the app makes is checkpointed, whether or not a workbench turn started it.
    this.unobserve = onFileWillChange(p => this.trackWrite(p));
  }

  close(): void { this.unobserve(); this.mcp.closeAll(); this.diagnostics.closeAll(); if (this.idleTimer) clearTimeout(this.idleTimer); this.checkpoints.end(); }

  // ── settings ──
  managed(): ManagedPolicy { return readManaged(this.opts.managedFile); }

  private readJson(file: string): { value: any; raw: string } {
    try { const raw = readFileSync(file, 'utf8'); return { value: JSON.parse(raw), raw }; } catch { return { value: {}, raw: '' }; }
  }

  private userSettings(): any { return this.readJson(path.join(workbenchRoot(this.opts.dataDir), 'settings.json')).value; }

  private projectSettings(): { value: any; raw: string; trusted: boolean } {
    const f = this.readJson(path.join(this.root, PROJECT_DIR, 'settings.json'));
    return { ...f, trusted: !!f.raw && !this.managed().disableProjectExtensions && this.trust.isTrusted(this.root, 'settings', f.raw) };
  }

  layers(agent?: AgentDef): Layer[] {
    const m = this.managed();
    const proj = this.projectSettings();
    const projCfg = sanitizeConfig(proj.value?.permissions);
    // A project that has not been approved can still restrict, never grant.
    if (!proj.trusted) { projCfg.allow = []; projCfg.default = projCfg.default === 'allow' ? undefined : projCfg.default; for (const a of Object.values(projCfg.agents ?? {})) { a.allow = []; if (a.default === 'allow') a.default = undefined; } }
    const layers: Layer[] = [];
    if (agent) layers.push({ name: 'agent', config: agentRules(agent) });
    layers.push({ name: 'managed', config: sanitizeConfig(m.permissions) }, { name: 'user', config: sanitizeConfig(this.userSettings()?.permissions) }, { name: 'project', config: projCfg }, { name: 'builtin', config: BUILTIN_RULES });
    return layers;
  }

  routing(): RoutingConfig {
    const m = this.managed().routing, u = this.userSettings()?.routing ?? {}, p = this.projectSettings().value?.routing ?? {};
    return { roles: { ...(p.roles ?? {}), ...(u.roles ?? {}), ...(m?.roles ?? {}) }, agents: { ...(p.agents ?? {}), ...(u.agents ?? {}), ...(m?.agents ?? {}) } };
  }

  private hookConfig(): HookConfig {
    const m = this.managed();
    const userHooks = sanitizeHookConfig(this.readJson(path.join(workbenchRoot(this.opts.dataDir), 'hooks.json')).value);
    const proj = this.readJson(path.join(this.root, PROJECT_DIR, 'hooks.json'));
    let projHooks: HookConfig = {};
    if (proj.raw && !m.disableProjectExtensions) {
      if (this.trust.isTrusted(this.root, 'hooks', proj.raw)) projHooks = sanitizeHookConfig(proj.value);
      else this.warnings.push('This project has hooks, but the owner has not approved .neuroclaw/hooks.json, so they do not run.');
    }
    const bundleHooks = this.bundles.enabledDirs().filter(b => b.trusted).map(b => sanitizeHookConfig(this.readJson(path.join(b.dir, 'hooks.json')).value));
    return mergeHookConfigs(sanitizeHookConfig(m.hooks), userHooks, projHooks, ...bundleHooks);
  }

  private bundleMcp(): Record<string, McpServerDef> {
    const out: Record<string, McpServerDef> = {};
    for (const b of this.bundles.enabledDirs().filter(x => x.trusted)) Object.assign(out, this.readJson(path.join(b.dir, 'mcp.json')).value?.servers ?? {});
    return out;
  }

  /** Re-read every settings file (after an edit or an approval). */
  reload(): void { this.engine.setLayers(this.layers()); this.hooks.setConfig(this.hookConfig()); }

  /** The owner approves what is in this project's files right now. */
  trustProject(kinds: Array<'settings' | 'hooks' | 'mcp'> = ['settings', 'hooks', 'mcp']): string[] {
    const done: string[] = [];
    const files = { settings: 'settings.json', hooks: 'hooks.json', mcp: 'mcp.json' } as const;
    for (const k of kinds) { const f = this.readJson(path.join(this.root, PROJECT_DIR, files[k])); if (f.raw) { this.trust.trust(this.root, k, f.raw); done.push(files[k]); } }
    this.reload();
    return done;
  }

  // ── agents and commands ──
  agents(): AgentDef[] {
    const user = loadAgentsFrom(path.join(workbenchRoot(this.opts.dataDir), 'agents'), 'user');
    const proj = loadAgentsFrom(path.join(this.root, PROJECT_DIR, 'agents'), 'project');
    const bundle = this.bundles.enabledDirs().map(b => loadAgentsFrom(path.join(b.dir, 'agents'), 'bundle'));
    return mergeAgents(BUILTIN_AGENTS, ...bundle.map(b => b.items), user.items, proj.items);
  }

  commands(): CommandDef[] {
    const by = new Map<string, CommandDef>();
    for (const b of this.bundles.enabledDirs()) loadCommandsFrom(path.join(b.dir, 'commands'), 'bundle').items.forEach(c => by.set(c.name, c));
    loadCommandsFrom(path.join(workbenchRoot(this.opts.dataDir), 'commands'), 'user').items.forEach(c => by.set(c.name, c));
    loadCommandsFrom(path.join(this.root, PROJECT_DIR, 'commands'), 'project').items.forEach(c => by.set(c.name, c));
    return [...by.values()];
  }

  // ── checkpoints from the app's own writes ──
  private trackWrite(abs: string): void {
    if (!confine(this.root, abs)) return;
    if (!this.checkpoints.open) this.checkpoints.begin('(file change)');
    this.checkpoints.track(abs);
    // A change outside any workbench turn closes its checkpoint after a quiet moment.
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.inTurn) this.checkpoints.end(); }, 3000);
    this.idleTimer.unref?.();
  }
  private inTurn = false;

  // ── tools ──
  decide(req: ToolRequest): Verdict {
    const def = req.agent ? findAgent(this.agents(), req.agent) : undefined;
    const layered = new PermissionEngine(this.layers(def), { root: this.root });
    const v = layered.evaluate({ tool: req.tool, target: req.target, agent: req.agent });
    const g = this.opts.gate?.(req);
    if (g && mostRestrictive(v.decision, g) !== v.decision) return { decision: g, reason: `The tool gate says ${g}.`, layer: 'builtin' };
    return v;
  }

  async runTool<T>(req: ToolRequest, fn: () => Promise<T> | T): Promise<ToolOutcome<T>> {
    const t0 = Date.now();
    const notes: string[] = [];
    const verdict = this.decide(req);
    const record = (ok: boolean, blocked: boolean) => this.usage.record({ kind: 'tool', tool: req.tool, agent: req.agent, session: req.session, ms: Date.now() - t0, bytesIn: JSON.stringify(req.input ?? req.target ?? '').length, bytesOut: 0, ok, blocked });
    if (verdict.decision === 'deny') { record(false, true); return { ok: false, verdict, error: verdict.reason, notes }; }
    if (verdict.decision === 'ask') {
      const yes = this.opts.approve ? await this.opts.approve(req, verdict.reason) : false;
      if (!yes) { record(false, true); return { ok: false, verdict, error: `Needs approval: ${verdict.reason}`, notes }; }
    }
    const pre = await this.hooks.run({ event: 'PreToolUse', tool: req.tool, target: req.target, input: req.input, session: req.session });
    notes.push(...pre.warnings);
    if (pre.blocked) { record(false, true); return { ok: false, verdict, error: `Blocked by a hook: ${pre.reason}`, notes }; }
    const changes = FILE_CHANGING.has(req.tool) && req.target !== undefined;
    if (changes) { if (!this.checkpoints.open) this.checkpoints.begin(`${req.tool} ${req.target}`); this.checkpoints.track(req.target!); }
    let value: T;
    try { value = await fn(); } catch (e) { record(false, false); return { ok: false, verdict, error: (e as Error).message, notes }; }
    if (changes && req.target) {
      const f = await this.hooks.format(path.resolve(this.root, req.target));
      if (f.warning) notes.push(f.warning);
      const diag = renderDiagnostics(await this.diagnostics.diagnose(req.target));
      if (diag) notes.push(`Problems found in ${relPosix(this.root, path.resolve(this.root, req.target))}:\n${diag}`);
    }
    const post = await this.hooks.run({ event: 'PostToolUse', tool: req.tool, target: req.target, input: req.input, output: typeof value === 'string' ? value.slice(0, 4000) : undefined, session: req.session });
    notes.push(...post.warnings, ...post.notes);
    record(true, false);
    return { ok: true, verdict, value, notes };
  }

  /** Run the hooks for one event. Used by the gate bridge, so a PreToolUse hook can stop the agent's own tools. */
  runHook(payload: Parameters<HookRunner['run']>[0]) { return this.hooks.run(payload); }

  // ── turns ──
  async turn(req: TurnRequest): Promise<TurnResult> {
    const t0 = Date.now();
    const warnings: string[] = [...this.warnings];
    const agents = this.agents();
    let prompt = req.prompt;
    let agentName = req.agent ?? 'build';
    const slash = parseSlash(prompt);
    if (slash) {
      const cmd = this.commands().find(c => c.name === slash.name);
      if (cmd) { prompt = expandCommand(cmd, slash.args, { root: this.root }); if (cmd.agent) agentName = cmd.agent; }
    }
    const agent = findAgent(agents, agentName) ?? findAgent(agents, 'build')!;
    if (agent.name !== agentName.toLowerCase()) warnings.push(`No agent called "${agentName}"; used ${agent.name}.`);
    const route = resolveRoute(agent, this.routing(), { model: slash ? this.commands().find(c => c.name === slash.name)?.model : req.model });

    const existing = req.session && this.sessions.get(req.session) ? req.session : null;
    const submit = await this.hooks.run({ event: 'UserPromptSubmit', prompt, session: existing ?? undefined });
    warnings.push(...submit.warnings);
    // A blocked prompt leaves nothing behind: no session is made for it.
    if (submit.blocked) return { ok: false, blocked: true, text: `Blocked by a hook: ${submit.reason}`, session: existing ?? '', agent: agent.name, route, warnings, ms: Date.now() - t0 };
    const session = existing ?? this.sessions.create({ cwd: this.root, agent: agent.name, title: prompt.replace(/\s+/g, ' ').slice(0, 60) }).id;
    const stored = this.sessions.get(session)!;
    const history: Message[] = stored.messages.map(m => ({ role: m.role, content: m.content, pinned: m.pinned, summary: m.summary, files: m.files }));
    if (history.length === 0) { const start = await this.hooks.run({ event: 'SessionStart', session }); warnings.push(...start.warnings); }

    const system = [agent.prompt, this.instructions.render(this.instructions.load(this.root)), this.memory.render(this.memory.recall(prompt)), route.effortLine, req.context, submit.notes.join('\n')]
      .filter(Boolean).join('\n\n');

    const cp = this.checkpoints.begin(prompt.slice(0, 80), history.length);
    this.inTurn = true;
    let text = '', ok = true;
    try {
      if (!this.opts.executor) throw new Error('No engine is connected to the workbench.');
      this.sessions.append(session, { role: 'user', content: prompt });
      text = await this.opts.executor({
        system, history, prompt, agent, route, session,
        subagents: (jobs) => this.subagents(jobs, 0),
        runTool: (r, fn) => this.runTool({ ...r, agent: r.agent ?? agent.name, session }, fn),
      });
    } catch (e) { ok = false; text = (e as Error).message; } finally { this.inTurn = false; }
    const closed = this.checkpoints.end();
    const changed = closed ? Object.keys(closed.before) : [];

    this.sessions.append(session, { role: 'assistant', content: text, files: changed, checkpoint: closed?.id });
    this.usage.record({ kind: 'turn', agent: agent.name, session, ms: Date.now() - t0, bytesIn: prompt.length, bytesOut: text.length, ok });

    let compacted = false;
    const all = [...history, { role: 'user' as const, content: prompt }, { role: 'assistant' as const, content: text, files: changed }];
    if (needsCompaction(all, this.opts.compaction)) {
      const pre = await this.hooks.run({ event: 'PreCompact', session });
      warnings.push(...pre.warnings);
      if (!pre.blocked) { const r = compact(all, this.opts.compaction); compacted = r.compacted; if (compacted) this.sessions.append(session, { role: 'system', content: r.messages.find(m => m.summary)!.content, summary: true }); }
    }
    const stop = await this.hooks.run({ event: 'Stop', session, output: text.slice(0, 4000) });
    warnings.push(...stop.warnings);
    return { ok, text, session, agent: agent.name, route, checkpoint: cp.id && closed ? closed.id : undefined, compacted, warnings, ms: Date.now() - t0 };
  }

  async subagents(jobs: Array<{ agent: string; prompt: string }>, depth: number): Promise<SubagentResult[]> {
    const agents = this.agents();
    const exec: SubExecutor = async (r) => {
      if (!this.opts.executor) throw new Error('No engine is connected to the workbench.');
      const route = resolveRoute(r.agent, this.routing());
      // A fresh context: no history, only the agent's own prompt, the project's instructions and the job.
      return this.opts.executor({
        system: [r.agent.prompt, this.instructions.render(this.instructions.load(this.root)), route.effortLine].filter(Boolean).join('\n\n'),
        history: [], prompt: r.prompt, agent: r.agent, route, session: '',
        subagents: (j) => this.subagents(j, r.depth),
        runTool: (rq, fn) => this.runTool({ ...rq, agent: rq.agent ?? r.agent.name }, fn),
      });
    };
    const resolved = jobs.map(j => ({ agent: findAgent(agents, j.agent) ?? findAgent(agents, 'explore')!, prompt: j.prompt }));
    return runSubagents(resolved, exec, depth);
  }

  // ── conversation and file rewind together ──
  rewind(checkpointId: string, what: 'code' | 'conversation' | 'both', session?: string, force = false): { ok: boolean; reason?: string; files: string[]; messages?: number } {
    let files: string[] = [], messages: number | undefined;
    const cp = this.checkpoints.list().find(c => c.id === checkpointId);
    if (!cp) return { ok: false, reason: `No checkpoint ${checkpointId}.`, files };
    if (what !== 'conversation') {
      const r = this.checkpoints.rewind(checkpointId, { force });
      if (!r.ok) return { ok: false, reason: r.reason, files: r.files };
      files = r.files;
    }
    if (what !== 'code' && session) { messages = cp.messages; this.sessions.truncate(session, cp.messages); }
    return { ok: true, files, messages };
  }

  /** Remember a lesson from this session. Secrets are refused. */
  remember(kind: Parameters<AutoMemory['remember']>[0], text: string) { return this.memory.remember(kind, text); }

  status() {
    return {
      root: this.root, agents: this.agents().map(a => ({ name: a.name, description: a.description, source: a.source, mode: a.mode })),
      commands: this.commands().map(c => ({ name: c.name, description: c.description, source: c.source })),
      checkpoints: this.checkpoints.list().length, sessions: this.sessions.list().length,
      bundles: this.bundles.list(), mcp: this.mcp.configs().map(c => ({ name: c.name, scope: c.scope, transport: c.def.transport, problem: c.problem })),
      warnings: this.warnings, offline: (this.managed().offline ?? false),
    };
  }
}

export type { SessionMessage };
