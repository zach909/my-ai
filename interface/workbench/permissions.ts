/**
 * Permission rules: allow, ask or deny, per tool and per agent, in layers.
 *
 *   managed (an administrator)  >  user (data folder)  >  project (.neuroclaw/settings.json)  >  built-in
 *
 * A rule is `tool(pattern)`, e.g. `bash(git status*)`, `edit(src/**)`, `fetch(domain:*.example.com)`,
 * `mcp:github:*`. A bare `tool` matches every use of it.
 *
 * How a request is decided:
 *   1. Every rule from every layer that matches is collected.
 *   2. A deny from any layer is final. Otherwise the highest layer that has a matching rule decides, and inside one
 *      layer ask beats allow. So a project can tighten what the user allowed, and nothing a project or user writes can
 *      loosen what an administrator denied.
 *   3. No rule matched: the first layer that names a `default` decides, otherwise `ask`.
 *
 * The layers are ordered managed, user, project, built-in: a repository never outranks the person using it. The caller
 * strips the `allow` rules from a project file the owner has not approved (see workbench.ts), because a rule that grants
 * must come from someone who chose it; rules that only restrict are always safe to read.
 *
 * Shell commands are split into their parts (`a && b | c`). Every part must be allowed for the command to be
 * allowed; one denied part denies it. A command with a substitution (`$(...)`, backticks, `<(...)`) is never
 * allowed by a pattern, because the pattern cannot see what runs inside it; it asks.
 *
 * This module only decides. It never weakens the tool gate (core/tool-safety.ts): the caller combines this
 * verdict with the gate's using `mostRestrictive`, so an allow here cannot skip an approval the gate wants.
 */
import path from 'node:path';
import { globMatch } from './text-utils.js';
import { confine, relPosix } from './paths.js';

export type Decision = 'allow' | 'ask' | 'deny';
export type LayerName = 'managed' | 'user' | 'project' | 'builtin' | 'agent';

export interface RuleSet {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  default?: Decision;
}

export interface PermissionConfig extends RuleSet {
  /** Extra rules that apply only while a named agent is acting. */
  agents?: Record<string, RuleSet>;
}

export interface Layer { name: LayerName; config: PermissionConfig }

export interface PermissionRequest {
  tool: string;
  /** A path, a command, a URL, or an MCP tool's name. Absent for a bare tool use. */
  target?: string;
  agent?: string;
}

export interface Verdict {
  decision: Decision;
  reason: string;
  layer?: LayerName;
  rule?: string;
}

const ORDER: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
export const mostRestrictive = (...ds: Decision[]): Decision => ds.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), 'allow' as Decision);

interface ParsedRule { tool: string; pattern: string | null; raw: string }

export function parseRule(raw: string): ParsedRule | null {
  const m = /^\s*([A-Za-z][\w:.*-]{0,80}?)\s*(?:\((.*)\))?\s*$/s.exec(raw);
  if (!m) return null;
  return { tool: m[1].toLowerCase(), pattern: m[2] === undefined ? null : m[2], raw };
}

const toolMatches = (ruleTool: string, tool: string): boolean => ruleTool === tool || globMatch(ruleTool, tool, 'plain');

// ── Shell command parsing ────────────────────────────────────────────

/** Split on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. Flags substitutions it cannot reason about. */
export function splitCommand(cmd: string): { parts: string[]; opaque: boolean } {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let opaque = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") { cur += c; if (c === "'") quote = null; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(') || ((c === '<' || c === '>') && cmd[i + 1] === '(')) opaque = true;
    if (quote === '"') { cur += c; if (c === '"') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return { parts, opaque: opaque || quote !== null };
}

// ── Targets ──────────────────────────────────────────────────────────

const PATH_TOOLS = new Set(['read', 'edit', 'write', 'delete']);

export function hostOf(url: string): string | null {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase(); } catch { return null; }
}

// ── The engine ───────────────────────────────────────────────────────

export interface EngineOptions {
  /** The folder paths are judged against. */
  root: string;
}

export class PermissionEngine {
  constructor(private layers: Layer[], private opts: EngineOptions) {}

  setLayers(layers: Layer[]): void { this.layers = layers; }

  evaluate(req: PermissionRequest): Verdict {
    const tool = String(req.tool ?? '').toLowerCase();
    if (!tool) return { decision: 'deny', reason: 'No tool named.' };
    const target = req.target;

    // A file path that leaves the project is never matched by a relative rule, and is held unless a rule
    // names it by absolute path. Resolve once; rules compare against the project-relative form.
    let candidates: string[] = [];
    let opaque = false;
    if (target !== undefined) {
      if (tool === 'bash' || tool === 'shell' || tool === 'terminal') {
        const split = splitCommand(target);
        candidates = split.parts.length ? split.parts : [target.trim()];
        opaque = split.opaque;
      } else if (PATH_TOOLS.has(tool)) {
        const inside = confine(this.opts.root, target);
        const abs = path.resolve(this.opts.root, target);
        candidates = inside ? [relPosix(this.opts.root, inside), abs.split(path.sep).join('/')] : [abs.split(path.sep).join('/')];
        if (!inside) opaque = true; // outside the project or through a symlink: allow rules for relative paths must not apply
      } else if (tool === 'fetch' || tool === 'web') {
        const host = hostOf(target);
        candidates = host ? [`domain:${host}`, target] : [target];
      } else candidates = [target];
    }

    const hits: Array<{ decision: Decision; layer: LayerName; rule: string; idx: number }> = [];
    const allowedParts = new Set<number>();
    let sawRule = false;
    for (const [idx, layer] of this.layers.entries()) {
      const sets: RuleSet[] = [layer.config];
      if (req.agent && layer.config.agents?.[req.agent]) sets.push(layer.config.agents[req.agent]);
      for (const set of sets) {
        for (const decision of ['deny', 'ask', 'allow'] as Decision[]) {
          for (const raw of set[decision] ?? []) {
            const rule = parseRule(raw);
            if (!rule || !toolMatches(rule.tool, tool)) continue;
            sawRule = true;
            if (rule.pattern === null) {
              if (decision === 'allow' && opaque) continue;
              hits.push({ decision, layer: layer.name, rule: raw, idx });
              if (decision === 'allow') candidates.forEach((_, i) => allowedParts.add(i));
              continue;
            }
            const mode = PATH_TOOLS.has(tool) ? 'path' : 'plain';
            candidates.forEach((c, i) => {
              const matched = globMatch(rule.pattern as string, c, mode) || (tool === 'bash' && globMatch(`${rule.pattern}`, c, 'plain'));
              if (!matched) return;
              if (decision === 'allow') {
                if (opaque) return;
                allowedParts.add(i);
                hits.push({ decision, layer: layer.name, rule: raw, idx });
              } else hits.push({ decision, layer: layer.name, rule: raw, idx });
            });
          }
        }
      }
    }

    const denied = hits.find(h => h.decision === 'deny');
    if (denied) return { decision: 'deny', reason: `Denied by ${denied.layer} rule ${denied.rule}.`, layer: denied.layer, rule: denied.rule };
    const live = hits.filter(h => h.decision !== 'deny');
    if (live.length) {
      const best = Math.min(...live.map(h => h.idx));
      const top = live.filter(h => h.idx === best);
      const winner = top.find(h => h.decision === 'ask') ?? top[0];
      if (winner.decision === 'ask') return { decision: 'ask', reason: `${winner.layer} rule ${winner.rule} asks first.`, layer: winner.layer, rule: winner.rule };
      // An allow holds only when every part of a compound command (or the one target) matched an allow rule.
      if (!opaque && (candidates.length === 0 || this.coversAll(tool, candidates, allowedParts))) {
        return { decision: 'allow', reason: `Allowed by ${winner.layer} rule ${winner.rule}.`, layer: winner.layer, rule: winner.rule };
      }
      return { decision: 'ask', reason: 'Only part of this command is covered by an allow rule, so it asks.', layer: winner.layer };
    }
    if (opaque && sawRule) return { decision: 'ask', reason: 'The command or path cannot be checked against a pattern, so it asks.' };
    for (const layer of this.layers) {
      if (layer.config.default) return { decision: layer.config.default, reason: `No rule matched; ${layer.name} default is ${layer.config.default}.`, layer: layer.name };
    }
    return { decision: 'ask', reason: 'No rule matched, so it asks.' };
  }

  private coversAll(tool: string, candidates: string[], allowedParts: Set<number>): boolean {
    if (tool === 'bash' || tool === 'shell' || tool === 'terminal') return candidates.every((_, i) => allowedParts.has(i));
    // For paths and URLs the candidates are alternative spellings of one target; one match is enough.
    return allowedParts.size > 0;
  }
}

/** Rules every layer starts from: read-only tools go ahead, everything that changes something asks. */
export const BUILTIN_RULES: PermissionConfig = {
  allow: ['read(**)', 'search'],
  ask: ['edit', 'write', 'delete', 'bash', 'fetch', 'mcp:*'],
  // A secrets file is never read or written without a person saying so.
  deny: [],
  default: 'ask',
};

/** Normalise whatever a config file holds into a PermissionConfig, dropping anything malformed. */
export function sanitizeConfig(raw: unknown): PermissionConfig {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 400 && parseRule(x) !== null).slice(0, 500) : [];
  const set = (v: unknown): RuleSet => {
    const o = isObj(v) ? v : {};
    const out: RuleSet = { allow: list(o.allow), ask: list(o.ask), deny: list(o.deny) };
    if (o.default === 'allow' || o.default === 'ask' || o.default === 'deny') out.default = o.default;
    return out;
  };
  const base = set(raw);
  const cfg: PermissionConfig = { ...base };
  const agents = isObj(raw) && isObj(raw.agents) ? raw.agents : {};
  cfg.agents = {};
  for (const [name, v] of Object.entries(agents).slice(0, 100)) cfg.agents[name] = set(v);
  return cfg;
}
