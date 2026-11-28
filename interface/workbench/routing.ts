/**
 * Per-agent routing: which engine and how hard it tries, decided by the agent doing the work.
 *
 * A fast read-only agent can use the light local engine at low effort while the agent making edits uses the full one
 * at high effort. The choices are the project's own: the engines of core/engine-chooser.ts ('local-quantized',
 * 'local-full', 'remote' = a computer this device may borrow) and the effort dial of core/effort.ts. No outside model or
 * provider is involved, and none can be named here.
 *
 *   "fast" -> local-quantized    "deep" -> local-full    "remote" -> a borrowed computer    anything else -> auto (the chooser decides)
 *
 * Settings, `routing` in settings.json:  { "roles": { "fast": "local-quantized" }, "agents": { "explore": "fast", "build": "deep" } }
 * Effort is `low`, `medium` or `high`, which set the dial to 20, 50 or 90 and become the one-line effort input the mesh reads.
 * Offline mode turns 'remote' into 'local-full' and says so.
 *
 * Until the engine acts on the choice (see core/engine-router.ts) the route is a recommendation that is recorded with each
 * turn; nothing here pretends otherwise.
 */
import { effortText, planEffort } from '../../models && skills/core/effort.js';
import { isOffline } from './netguard.js';
import type { AgentDef, Effort } from './agents.js';

export type EngineChoice = 'local-quantized' | 'local-full' | 'remote' | 'auto';
export interface RoutingConfig { roles?: Record<string, string>; agents?: Record<string, string> }
export interface Route { agent: string; role: string; engine: EngineChoice; effort: Effort; dial: number; effortLine: string | null; notes: string[] }

export const DIAL: Record<Effort, number> = { low: 20, medium: 50, high: 90 };
const DEFAULT_ROLES: Record<string, EngineChoice> = { fast: 'local-quantized', deep: 'local-full', remote: 'remote' };
const ENGINES = new Set<string>(['local-quantized', 'local-full', 'remote', 'auto']);

export function resolveRoute(def: Pick<AgentDef, 'name' | 'model' | 'effort'>, cfg: RoutingConfig = {}, override?: { model?: string; effort?: Effort }): Route {
  const notes: string[] = [];
  const role = override?.model ?? cfg.agents?.[def.name] ?? def.model ?? 'auto';
  const table = { ...DEFAULT_ROLES, ...(cfg.roles ?? {}) } as Record<string, string>;
  let engine: string = ENGINES.has(role) ? role : table[role] ?? 'auto';
  if (!ENGINES.has(engine)) { notes.push(`"${engine}" is not an engine this project has; using auto.`); engine = 'auto'; }
  if (engine === 'remote' && isOffline()) { engine = 'local-full'; notes.push('Offline mode is on, so a borrowed computer is not used; running on this device.'); }
  const effort: Effort = override?.effort ?? def.effort ?? 'medium';
  const dial = DIAL[effort];
  return { agent: def.name, role, engine: engine as EngineChoice, effort, dial, effortLine: effortText(dial), notes };
}

export const describeEffort = (e: Effort): string => `${e} (${planEffort(DIAL[e]).mode}, ${planEffort(DIAL[e]).checks} check${planEffort(DIAL[e]).checks === 1 ? '' : 's'})`;
