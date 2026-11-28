/**
 * Agent modes and custom agents.
 *
 * Four built-in modes, then any number of Markdown agents the user or a project defines:
 *
 *   build    full access, still behind the permission rules and the tool gate
 *   plan     read-only: it can read, search and think, never change anything
 *   general  multi-step work: may start sub-agents to do parts in parallel
 *   explore  fast, read-only, low effort: for finding things
 *
 * A custom agent is a `.md` file with frontmatter (`description`, `tools`, `model`, `effort`, `mode`) and a body
 * that is its system prompt. A custom agent can only narrow what is allowed: its `tools` list becomes deny rules
 * for everything else (see `agentRules`). It can never grant a permission, so a repository cannot ship an agent
 * that does more than the owner's own rules allow.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { asList, parseFrontmatter, SAFE_NAME } from './text-utils.js';
import type { RuleSet } from './permissions.js';

export type Effort = 'low' | 'medium' | 'high';
export type AgentMode = 'primary' | 'subagent' | 'all';

export interface AgentDef {
  name: string;
  description: string;
  mode: AgentMode;
  /** Tools it may use. Null: every tool the permission rules allow. */
  tools: string[] | null;
  /** Tool names it may never use, on top of the above. */
  disallowed: string[];
  /** A routing role (see routing.ts): "fast", "deep", or an engine id. */
  model?: string;
  effort?: Effort;
  prompt: string;
  source: 'builtin' | 'project' | 'user' | 'bundle';
  file?: string;
}

export const READ_ONLY_TOOLS = ['read', 'search', 'fetch'];

export const BUILTIN_AGENTS: AgentDef[] = [
  { name: 'build', description: 'Full-access mode: reads, edits and runs commands, behind the permission rules.', mode: 'primary', tools: null, disallowed: [], effort: 'medium', source: 'builtin',
    prompt: 'You are in build mode. Make the change asked for, verify it, and report what you did.' },
  { name: 'plan', description: 'Read-only planning mode: reads and searches, never changes anything.', mode: 'primary', tools: READ_ONLY_TOOLS, disallowed: [], effort: 'high', source: 'builtin',
    prompt: 'You are in plan mode. You cannot change files or run commands. Read what you need and write a step-by-step plan.' },
  { name: 'general', description: 'Multi-step execution mode: splits work into parts and may start sub-agents.', mode: 'all', tools: null, disallowed: [], effort: 'medium', source: 'builtin',
    prompt: 'You are in general mode. Break the task into steps, run independent steps with sub-agents, and combine their results.' },
  { name: 'explore', description: 'Fast read-only exploration: finds files, code and answers quickly.', mode: 'all', tools: READ_ONLY_TOOLS.filter(t => t !== 'fetch'), disallowed: [], model: 'fast', effort: 'low', source: 'builtin',
    prompt: 'You are in explore mode. Search and read only what is needed and answer briefly with file paths.' },
];

const BUILTIN_NAMES = new Set(BUILTIN_AGENTS.map(a => a.name));
const MAX_FILE = 64 * 1024;
const MAX_AGENTS = 200;

export interface LoadResult<T> { items: T[]; warnings: string[] }

/** Read every `*.md` directly inside `dir`. A missing folder is not an error. */
export function loadAgentsFrom(dir: string, source: AgentDef['source']): LoadResult<AgentDef> {
  const items: AgentDef[] = [];
  const warnings: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.md')).sort().slice(0, MAX_AGENTS); } catch { return { items, warnings }; }
  for (const file of names) {
    const full = path.join(dir, file);
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_FILE) { warnings.push(`${file}: skipped (not a file or over ${MAX_FILE} bytes).`); continue; }
      const { data, body } = parseFrontmatter(readFileSync(full, 'utf8'));
      const name = String(data.name ?? file.replace(/\.md$/, '')).toLowerCase();
      if (!SAFE_NAME.test(name)) { warnings.push(`${file}: "${name}" is not a valid agent name (a-z, 0-9, - and _).`); continue; }
      if (BUILTIN_NAMES.has(name)) { warnings.push(`${file}: "${name}" is a built-in mode and cannot be replaced.`); continue; }
      const mode = data.mode === 'primary' || data.mode === 'subagent' || data.mode === 'all' ? data.mode : 'subagent';
      const effort = data.effort === 'low' || data.effort === 'medium' || data.effort === 'high' ? data.effort : undefined;
      const tools = data.tools === undefined ? null : asList(data.tools).map(t => t.toLowerCase());
      items.push({
        name, description: String(data.description ?? '').slice(0, 300), mode, tools,
        disallowed: asList(data.disallowedTools ?? data.disallowed).map(t => t.toLowerCase()),
        model: typeof data.model === 'string' ? data.model.slice(0, 64) : undefined,
        effort, prompt: body.trim().slice(0, 16000), source, file: full,
      });
    } catch (e) { warnings.push(`${file}: ${(e as Error).message}`); }
  }
  return { items, warnings };
}

/** Built-ins first, then each folder in order; a later definition replaces an earlier one of the same name. */
export function mergeAgents(...lists: AgentDef[][]): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const list of lists) for (const a of list) byName.set(a.name, a);
  return [...byName.values()];
}

const ALL_TOOLS = ['read', 'search', 'fetch', 'edit', 'write', 'delete', 'bash', 'mcp:*', 'agent'];

/**
 * Deny rules that confine an agent to its tools. Added to the permission layers while that agent acts.
 * An agent with `tools: null` adds only its `disallowed` list.
 */
export function agentRules(def: AgentDef): RuleSet {
  const deny = new Set<string>(def.disallowed);
  if (def.tools) {
    const allowed = def.tools.map(t => t.toLowerCase());
    for (const t of ALL_TOOLS) {
      const covered = allowed.some(a => a === t || (a.endsWith('*') && t.startsWith(a.slice(0, -1))) || (t.endsWith('*') && a.startsWith(t.slice(0, -1))));
      if (!covered) deny.add(t);
    }
  }
  return { deny: [...deny] };
}

export const findAgent = (agents: AgentDef[], name: string): AgentDef | undefined => agents.find(a => a.name === name.toLowerCase());
export const dirExists = (d: string): boolean => { try { return existsSync(d) && statSync(d).isDirectory(); } catch { return false; } };
