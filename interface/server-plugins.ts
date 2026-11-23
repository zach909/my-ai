/**
 * The HTTP server's route groups, as plugins.
 *
 * Each group (platform, accounts, hosted, corona, memory topics, prompt memory, safety, weights, agent, commons) used to be
 * wired into web-server.ts by hand: an `if (isXRoute(path))` block, one per group, each building its own context.
 * Now each is a KernelPlugin (plugin_manager/host.ts) that owns its routes. The server builds one
 * ServerRouteContext per request and offers it to whichever plugins are running; a plugin that is turned off
 * answers nothing, and the paths it kept open past the password gate close with it.
 *
 * The handlers themselves are unchanged. A plugin only maps the server's context onto the context its handler
 * already took.
 *
 * Guarded (only the owner can turn them off, see plugin_manager/host.ts): accounts (the login door), safety and
 * agent (the controls for what the agent may do, its sandbox, danger level and alignment protocol), and the
 * plugin list itself.
 */
import type * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { PluginHost, type KernelPlugin, type PluginEnabledStore, type PluginActor } from '../plugin_manager/host.js';
import { configFile } from './platform/app-paths.js';
import { handlePlatformRoutes, isPlatformRoute } from './platform/routes.js';
import { handleAccountsRoutes, isAccountsRoute, isAccountsPublicRoute } from './accounts-routes.js';
import { handleHostedRoutes, isHostedRoute } from './hosted-routes.js';
import { handleCoronaRoutes, isCoronaApiRoute } from './corona-routes.js';
import { handleMemoryTopicsRoutes, isMemoryTopicsRoute } from './memory-topics-routes.js';
import { handlePromptMemoryRoutes, isPromptMemoryRoute } from './prompt-memory-routes.js';
import { handleSafetyRoutes, isSafetyRoute } from './safety-routes.js';
import { handleWeightsRoutes, isWeightsRoute } from './weights-routes.js';
import { handleSelfDebugRoutes, isSelfDebugRoute, selfDebugService } from './self-debug-routes.js';
import { handleAgentRoutes, isAgentRoute } from './agent-routes.js';
import { handleCommonsRoutes, type CommonsContext } from './commons-routes.js';
import { getAccounts, USER_COOKIE } from '../models && skills/core/accounts.js';
import { isComputerAdministrator } from '../models && skills/core/computer-admin.js';
import { sharedToolGate } from '../models && skills/core/tool-safety.js';
import { readCookie } from '../models && skills/core/remote-access.js';
import { isAutonomous, isOwnerOrAdmin } from '../models && skills/core/user-context.js';
import { writeJsonAtomic } from '../models && skills/core/atomic-write.js';

/** What the server hands every route plugin for one request. */
export interface ServerRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
  /** True when the request came from the computer the server runs on. */
  fromThisMachine(req: http.IncomingMessage): boolean;
  /** Whether a setup code is the one printed on the server's console. */
  setupCodeOk(code: unknown): boolean;
  /** Called once the first account exists. */
  onSetup(): void;
  /** The agent's normal path, with its tools. */
  chat(message: string): Promise<string>;
  /** Text only, never a tool; held while the agent is alive. */
  text(message: string): Promise<string>;
  /** The normal path with its tools, held while the agent is alive. */
  act(message: string): Promise<string>;
  running(): boolean;
  uptime(): number;
  chatHistory: CommonsContext['chats'];
  learnFromFiling(text: string): void;
}

type Plugin = KernelPlugin<ServerRouteContext>;

const base = (c: ServerRouteContext) => ({
  req: c.req, res: c.res, pathname: c.pathname, method: c.method,
  parseBody: c.parseBody, sendJson: c.sendJson,
});

/** The last few errors the app caught, as lines. The self-debug report lists them; no weight can fix an exception. */
function recentErrorLines(): string[] {
  try {
    // Loaded lazily and synchronously-safe: the log is a plain in-memory list.
    const mod = errorLogModule;
    return mod ? mod.getRecentErrors(5).map(e => `${new Date(e.timestamp).toISOString()} ${e.source}: ${e.message}`) : [];
  } catch { return []; }
}
let errorLogModule: typeof import('../src/lib/error-log.js') | null = null;
void import('../src/lib/error-log.js').then(m => { errorLogModule = m; }, () => undefined);

const liveSystem = async () => (await import('../src/index.js')).getNeuroclawSystem();
const liveAccess = async () => (await import('../models && skills/core/access-settings.js')).sharedAccessManager();

const platform: Plugin = {
  id: 'platform-routes',
  description: 'Settings, app info, updates, the AI OS and the installable-app files.',
  order: 10,
  routes: [{
    match: (p) => isPlatformRoute(p),
    handle: (c) => handlePlatformRoutes({
      ...base(c),
      isAdmin: () => isOwnerOrAdmin(),
      fromThisMachine: () => c.fromThisMachine(c.req),
    }),
  }],
  start: () => undefined,
};

const accounts: Plugin = {
  id: 'accounts-routes',
  description: 'Accounts and logging in.',
  guarded: true,
  order: 20,
  routes: [{
    match: (p) => isAccountsRoute(p),
    isPublic: (p, m) => isAccountsPublicRoute(p, m),
    handle: (c) => handleAccountsRoutes({
      ...base(c),
      accounts: getAccounts(),
      fromThisMachine: (r) => c.fromThisMachine(r),
      computerAdmin: () => isComputerAdministrator(),
      setupCodeOk: (code) => c.setupCodeOk(code),
      onSetup: () => c.onSetup(),
      token: (r) => readCookie(r.headers.cookie, USER_COOKIE),
    }),
  }],
  start: () => undefined,
};

const hosted: Plugin = {
  id: 'hosted-routes',
  description: 'Hosted mode: an account\'s tokens for the full AI on this computer.',
  requires: ['accounts-routes'],
  order: 30,
  routes: [{
    match: (p) => isHostedRoute(p),
    handle: (c) => handleHostedRoutes(base(c)),
  }],
  start: () => undefined,
};

const corona: Plugin = {
  id: 'corona-routes',
  description: 'Apps, compute sharing and the data donor, plus the token-checked /api/corona/v1 API.',
  order: 40,
  routes: [{
    match: (p) => p.startsWith('/api/corona-apps') || p.startsWith('/api/compute') || p.startsWith('/api/donor') || isCoronaApiRoute(p),
    // Apps and borrowers carry a bearer token; corona-routes.ts checks it on every request.
    isPublic: (p) => isCoronaApiRoute(p),
    handle: (c) => handleCoronaRoutes({
      ...base(c),
      chat: (m) => c.chat(m),
      // What guests get: text only, never a tool.
      text: (m) => c.text(m),
      status: () => ({ running: c.running(), uptime: Math.floor(c.uptime()) }),
    }),
  }],
  start: () => undefined,
};

const memoryTopics: Plugin = {
  id: 'memory-topics-routes',
  description: 'The folder-tree memory the agent files into.',
  order: 50,
  routes: [{
    match: (p) => isMemoryTopicsRoute(p),
    handle: (c) => handleMemoryTopicsRoutes({ ...base(c), url: c.url }),
  }],
  start: () => undefined,
};

const promptMemory: Plugin = {
  id: 'prompt-memory-routes',
  description: 'Small stand-in archives that make the mesh say what a big one does.',
  order: 55,
  routes: [{
    match: (p) => isPromptMemoryRoute(p),
    handle: (c) => handlePromptMemoryRoutes({
      ...base(c),
      url: c.url,
      // The live mesh, held for the whole search: every trial drives the same doorway chat and learning use.
      withRunner: async (work) => {
        const { PromptMemoryError, doorwayRunner } = await import('../models && skills/core/prompt-memory.js');
        const { ZipLoopInterface, zipLoopIdsFor } = await import('../models && skills/core/onebrain.js');
        const system = await liveSystem();
        system.pipeline.ensureReady();
        const engine = system.pipeline.getHyperEngine();
        if (!engine) throw new PromptMemoryError('The network has not run yet, so there is no mesh to try archives on. Ask it something first.', 409);
        return system.promptFeed.lock().run(() => work(doorwayRunner({
          doorway: new ZipLoopInterface(engine, zipLoopIdsFor(engine)),
          capture: () => engine.captureNetworkState(),
          restore: (snapshot) => engine.restoreNetworkState(snapshot as Parameters<typeof engine.restoreNetworkState>[0]),
        })));
      },
      fingerprint: async () => {
        try {
          const { meshFingerprint } = await import('../models && skills/core/prompt-memory.js');
          const engine = (await liveSystem()).pipeline.getHyperEngine();
          return engine ? meshFingerprint(engine.captureNetworkState()) : null;
        } catch { return null; }
      },
    }),
  }],
  start: () => undefined,
};

const safety: Plugin = {
  id: 'safety-routes',
  description: 'Risky tools, approvals, complete access and auto-continue.',
  guarded: true,
  order: 60,
  routes: [{
    match: (p) => isSafetyRoute(p),
    handle: (c) => handleSafetyRoutes({
      ...base(c),
      gate: sharedToolGate(),
      access: liveAccess,
      runApproved: async (toolId, request) => (await liveSystem()).pluginRegistry.runApproved(toolId, request),
    }),
  }],
  start: () => undefined,
};

const weights: Plugin = {
  id: 'weights-routes',
  description: 'Net maker, net skill maker, weight editor and compiler.',
  order: 70,
  routes: [{
    match: (p) => isWeightsRoute(p),
    handle: (c) => handleWeightsRoutes({
      ...base(c),
      base: async () => (await liveSystem()).pipeline.ensureBrain() ?? null,
    }),
  }],
  start: () => undefined,
};

const selfDebug: Plugin = {
  id: 'self-debug-routes',
  description: 'Self-debug: the AI finds what goes wrong in a net, edits its weights a little, checks, and keeps going. Part of self-improvement.',
  requires: ['weights-routes'],
  order: 75,
  routes: [{
    match: (p) => isSelfDebugRoute(p),
    handle: (c) => handleSelfDebugRoutes({
      ...base(c),
      mistakes: async () => (await liveSystem()).mistakes.all(),
      errors: recentErrorLines,
    }),
  }],
  // The background pass: every ten minutes (NEUROCLAW_SELF_DEBUG_INTERVAL_MS), look at the nets that exist.
  // Off with NEUROCLAW_SELF_DEBUG=0 or the switch on the Self-improvement page. Costs nothing with no nets.
  start: () => { selfDebugService().startLoop(recentErrorLines); },
  stop: () => { selfDebugService().stopLoop(); },
};

const agent: Plugin = {
  id: 'agent-routes',
  description: 'The agent: sandbox, danger level and alignment protocol.',
  guarded: true,
  order: 80,
  routes: [{
    match: (p) => isAgentRoute(p),
    handle: (c) => handleAgentRoutes({ ...base(c), access: liveAccess }),
  }],
  start: () => undefined,
};

const commons: Plugin = {
  id: 'commons-routes',
  description: 'Points, projects and the hive.',
  order: 90,
  routes: [{
    match: (p) => p === '/api/commons' || p.startsWith('/api/commons/'),
    handle: (c) => handleCommonsRoutes({
      ...base(c),
      // Text only, never a tool.
      chat: (m) => c.text(m),
      act: (m) => c.act(m),
      status: () => ({ running: c.running() }),
      chats: c.chatHistory,
      learn: (text) => c.learnFromFiling(text),
      learner: async () => {
        try { return (await liveSystem()).hiveLearner(); } catch { return null; }
      },
    }),
  }],
  start: () => undefined,
};

/** Who is asking, for the guard: a person at the owner's controls, or the agent on its own. */
function actorOf(): PluginActor {
  return isAutonomous() ? 'agent' : 'owner';
}

/** The plugin list itself: see what is installed, turn plugins off and on. Owner or admin only. */
function listPlugin(host: PluginHost<ServerRouteContext>): Plugin {
  const prefix = '/api/plugin-host';
  return {
    id: 'plugin-host-routes',
    description: 'The list of plugins, and turning them off and on.',
    guarded: true,
    order: 5,
    routes: [{
      match: (p) => p === prefix || p.startsWith(`${prefix}/`),
      handle: async (c) => {
        const { pathname, method, res } = c;
        if (!isOwnerOrAdmin()) { c.sendJson(res, { error: 'Only the owner or an admin can do that.' }, 403); return true; }
        if (pathname === prefix && method === 'GET') {
          c.sendJson(res, { plugins: host.status() });
          return true;
        }
        const m = /^\/api\/plugin-host\/([a-z0-9-]{1,64})\/(enable|disable)$/.exec(pathname);
        if (m && method === 'POST') {
          const [, id, verb] = m;
          // This route is how a plugin is turned back on; turning it off would leave no way to do that here.
          if (verb === 'disable' && id === 'plugin-host-routes') {
            c.sendJson(res, { ok: false, reason: '"plugin-host-routes" is how plugins are turned back on, so it cannot be turned off here.' }, 409);
            return true;
          }
          const result = verb === 'enable' ? await host.enable(id) : await host.disable(id, actorOf());
          c.sendJson(res, result, result.ok ? 200 : 409);
          return true;
        }
        c.sendJson(res, { error: 'No such plugin route.' }, 404);
        return true;
      },
    }],
    start: () => undefined,
  };
}

/** Which plugins are off, kept with the other small config files. */
export function fileEnabledStore(override?: string): PluginEnabledStore {
  const file = configFile('plugins.json', override);
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(file.read, 'utf8'));
        const out: Record<string, boolean> = {};
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'boolean') out[k] = v;
        }
        return out;
      } catch { return {}; }
    },
    save(enabled) { writeJsonAtomic(file.write, enabled); },
  };
}

/** The server's plugin host, with every route plugin registered and not yet started. */
export function createServerHost(store: PluginEnabledStore = fileEnabledStore(), log?: (m: string) => void): PluginHost<ServerRouteContext> {
  const host = new PluginHost<ServerRouteContext>(store, log);
  for (const p of [listPlugin(host), platform, accounts, hosted, corona, memoryTopics, promptMemory, safety, weights, selfDebug, agent, commons]) host.register(p);
  return host;
}
