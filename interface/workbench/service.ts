/**
 * The workbench as the server runs it: one instance, a workspace folder that is safe to watch, and the engine behind the executor.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import path from 'node:path';
import { dataRoot } from '../platform/app-paths.js';
import { Workbench, type EngineCall, type Executor } from './workbench.js';
import { installGateBridge, type GateLike } from './gate-bridge.js';
import { needsApproval, loadSafety, normalizeToolId } from '../../models && skills/core/tool-safety.js';
import type { ToolRequest } from './workbench.js';
import type { Decision } from './permissions.js';

/**
 * The folder the workbench treats as the project. Never a filesystem root or the home folder itself (every write under it
 * would be checkpointed). NEUROCLAW_WORKSPACE wins; then the working folder if it looks like a project; otherwise a
 * `workspace` folder inside the app's data folder.
 */
export function defaultWorkspace(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const looksLikeProject = (d: string) => ['.git', 'package.json', '.neuroclaw', 'pyproject.toml', 'Cargo.toml', 'go.mod'].some(f => existsSync(path.join(d, f)));
  const bad = (d: string) => path.dirname(d) === d || path.resolve(d) === path.resolve(homedir());
  const fromEnv = env.NEUROCLAW_WORKSPACE?.trim();
  if (fromEnv && existsSync(fromEnv) && !bad(path.resolve(fromEnv))) return path.resolve(fromEnv);
  if (!bad(cwd) && looksLikeProject(cwd)) return path.resolve(cwd);
  const fallback = path.join(dataRoot(), 'workspace');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** Hands a turn's text to the engine. A read-only agent gets the text-only path, so it cannot use a tool at all. */
export interface Engine { act(message: string): Promise<string>; text(message: string): Promise<string> }

const SYSTEM_CAP = 2000;
const HISTORY_MSGS = 6;
const HISTORY_CHARS = 500;

/** The one message the mesh reads: the agent's rules, the last few turns, then the request. Bounded, because the doorway reads bits and length costs time. */
export function composeMessage(call: Pick<EngineCall, 'system' | 'history' | 'prompt'>): string {
  const parts: string[] = [];
  if (call.system.trim()) parts.push(call.system.trim().slice(0, SYSTEM_CAP));
  const tail = call.history.slice(-HISTORY_MSGS).map(m => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, HISTORY_CHARS)}`);
  if (tail.length) parts.push(tail.join('\n'));
  parts.push(call.prompt);
  return parts.join('\n\n');
}

export const READ_ONLY = (tools: string[] | null): boolean => !!tools && !tools.some(t => ['edit', 'write', 'delete', 'bash', 'mcp:*', 'agent'].includes(t));

export function engineExecutor(engine: () => Engine | null): Executor {
  return async (call) => {
    const e = engine();
    if (!e) throw new Error('The engine is not reachable from here.');
    const message = composeMessage(call);
    return READ_ONLY(call.agent.tools) ? e.text(message) : e.act(message);
  };
}

/** The workbench's view of the agent's own tool gate, for runTool: the stricter of the two verdicts applies. */
const GATE_ID: Record<string, string> = { bash: 'terminal', edit: 'file-system', write: 'file-system', delete: 'file-system', fetch: 'browser' };
export function toolGateVerdict(req: ToolRequest): Decision {
  const id = GATE_ID[req.tool];
  if (!id) return 'allow';
  try { return needsApproval(normalizeToolId(id), loadSafety()) ? 'ask' : 'allow'; } catch { return 'ask'; }
}

export class WorkbenchService {
  private wb: Workbench | null = null;
  private als = new AsyncLocalStorage<Engine>();
  private unbridge: (() => void) | null = null;

  /** The instance, created on first use so a server that never uses it pays nothing. */
  get(): Workbench {
    if (!this.wb) {
      this.wb = new Workbench({ root: defaultWorkspace(), executor: engineExecutor(() => this.als.getStore() ?? null), gate: toolGateVerdict });
    }
    return this.wb;
  }

  within<T>(engine: Engine, fn: () => Promise<T>): Promise<T> { return this.als.run(engine, fn); }

  /** Add the workbench's refusals to the agent's tool gate. Safe to call once; only ever adds refusals. */
  bridge(gate: GateLike): void { this.unbridge?.(); this.unbridge = installGateBridge(this.get(), gate); }

  close(): void { this.unbridge?.(); this.unbridge = null; this.wb?.close(); this.wb = null; }
}
