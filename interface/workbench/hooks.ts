/**
 * Lifecycle hooks: shell commands that run at exact points, so linting, testing and security checks happen every
 * time instead of when the model remembers.
 *
 * Config (`hooks.json`, or the `hooks` key of settings):
 *   { "hooks": { "PreToolUse": [ { "matcher": "edit|write", "hooks": [ { "command": "./check.sh", "timeout": 10 } ] } ] },
 *     "formatters": [ { "extensions": [".ts", ".js"], "command": ["myfmt", "--write", "{file}"] } ] }
 *
 * Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop.
 * A hook gets one JSON object on stdin. Exit 0 carries on; exit 2 blocks (its stderr is the reason, and for
 * PreToolUse the tool does not run); any other exit is a warning that does not block.
 * A matcher is a `|`-separated list of tool names with `*` wildcards; absent or `*` matches everything.
 *
 * Formatters are the file-write hook made simple: after an edit or write of a matching file, the argv runs
 * with `{file}` replaced. No shell is involved, so a file name cannot inject anything.
 *
 * Safety: a hook runs with a cleaned environment (no secrets unless listed in `env`), a time limit and an
 * output cap. Hooks from a project run only when the owner approved that exact file (trust.ts).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { globMatch } from './text-utils.js';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

export interface HookCommand { command: string; timeout?: number; env?: string[] }
export interface HookGroup { matcher?: string; hooks: HookCommand[] }
export interface FormatterDef { extensions: string[]; command: string[]; timeout?: number }
export interface HookConfig {
  hooks?: Partial<Record<HookEvent, HookGroup[]>>;
  formatters?: FormatterDef[];
}

export interface HookPayload { event: HookEvent; tool?: string; target?: string; input?: unknown; output?: string; prompt?: string; session?: string; cwd: string }

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  warnings: string[];
  /** Text a hook printed on exit 0, to hand back to the agent (diagnostics, lint output). */
  notes: string[];
  ran: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024;
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SystemRoot', 'ComSpec'];

function cleanEnv(extra: string[] | undefined, event: HookEvent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of extra ?? []) if (/^[A-Z_][A-Z0-9_]{0,63}$/i.test(k) && process.env[k] !== undefined) env[k] = process.env[k];
  env.NEUROCLAW_HOOK_EVENT = event;
  return env;
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Run a program with a time limit and an output cap; never throws. */
export function execLimited(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string; shell?: boolean }): Promise<ExecResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); } };
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) { stderr = (e as Error).message; resolve({ code: 127, stdout, stderr, timedOut }); return; }
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
    child.on('error', e => { stderr += e.message; finish(127); });
    child.on('close', code => finish(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin ?? '');
  });
}

const shellFor = (command: string): [string, string[]] =>
  process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];

export const matcherMatches = (matcher: string | undefined, tool: string | undefined): boolean => {
  if (!matcher || matcher === '*') return true;
  if (!tool) return false;
  return matcher.split('|').some(m => globMatch(m.trim().toLowerCase(), tool.toLowerCase()));
};

export function sanitizeHookConfig(raw: unknown): HookConfig {
  const out: HookConfig = { hooks: {}, formatters: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const hooks = (r.hooks && typeof r.hooks === 'object' ? r.hooks : {}) as Record<string, unknown>;
  for (const ev of HOOK_EVENTS) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    out.hooks![ev] = groups.slice(0, 50).flatMap((g: any): HookGroup[] => {
      if (!g || !Array.isArray(g.hooks)) return [];
      const list = g.hooks.slice(0, 20).filter((h: any) => h && typeof h.command === 'string' && h.command.length < 2000)
        .map((h: any): HookCommand => ({ command: h.command, timeout: typeof h.timeout === 'number' ? h.timeout : undefined, env: Array.isArray(h.env) ? h.env.filter((x: unknown) => typeof x === 'string') : undefined }));
      return list.length ? [{ matcher: typeof g.matcher === 'string' ? g.matcher : undefined, hooks: list }] : [];
    });
  }
  if (Array.isArray(r.formatters)) {
    for (const f of r.formatters.slice(0, 50) as any[]) {
      if (f && Array.isArray(f.extensions) && Array.isArray(f.command) && f.command.length && f.command.every((x: unknown) => typeof x === 'string')) {
        out.formatters!.push({ extensions: f.extensions.filter((e: unknown) => typeof e === 'string').map((e: string) => e.toLowerCase()), command: f.command, timeout: typeof f.timeout === 'number' ? f.timeout : undefined });
      }
    }
  }
  return out;
}

export function mergeHookConfigs(...configs: HookConfig[]): HookConfig {
  const out: HookConfig = { hooks: {}, formatters: [] };
  for (const c of configs) {
    for (const ev of HOOK_EVENTS) if (c.hooks?.[ev]?.length) out.hooks![ev] = [...(out.hooks![ev] ?? []), ...c.hooks[ev]!];
    out.formatters!.push(...(c.formatters ?? []));
  }
  return out;
}

export class HookRunner {
  constructor(private config: HookConfig, private cwd: string) {}

  setConfig(c: HookConfig): void { this.config = c; }
  has(event: HookEvent): boolean { return (this.config.hooks?.[event]?.length ?? 0) > 0; }

  async run(payload: Omit<HookPayload, 'cwd'>): Promise<HookOutcome> {
    const outcome: HookOutcome = { blocked: false, warnings: [], notes: [], ran: 0 };
    const body = JSON.stringify({ ...payload, cwd: this.cwd });
    for (const group of this.config.hooks?.[payload.event] ?? []) {
      if (!matcherMatches(group.matcher, payload.tool)) continue;
      for (const h of group.hooks) {
        const [file, args] = shellFor(h.command);
        const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(100, (h.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000));
        const r = await execLimited(file, args, { cwd: this.cwd, env: cleanEnv(h.env, payload.event), timeoutMs, stdin: body });
        outcome.ran++;
        if (r.timedOut) { outcome.warnings.push(`Hook timed out after ${timeoutMs / 1000}s: ${h.command}`); continue; }
        if (r.code === 2) { outcome.blocked = true; outcome.reason = (r.stderr || r.stdout || `Blocked by hook: ${h.command}`).trim().slice(0, 2000); return outcome; }
        if (r.code !== 0) outcome.warnings.push(`Hook exited ${r.code}: ${h.command}${r.stderr ? ` — ${r.stderr.trim().slice(0, 300)}` : ''}`);
        else if (r.stdout.trim()) outcome.notes.push(r.stdout.trim().slice(0, 4000));
      }
    }
    return outcome;
  }

  /** Format a file after it was written. Returns what ran; failures are reported, never thrown. */
  async format(file: string): Promise<{ ran: boolean; warning?: string }> {
    const ext = path.extname(file).toLowerCase();
    const def = (this.config.formatters ?? []).find(f => f.extensions.includes(ext));
    if (!def) return { ran: false };
    const argv = def.command.map(a => a.replace(/\{file\}/g, file));
    const r = await execLimited(argv[0], argv.slice(1), { cwd: this.cwd, env: cleanEnv(undefined, 'PostToolUse'), timeoutMs: Math.min(MAX_TIMEOUT_MS, (def.timeout ?? 20) * 1000) });
    return r.code === 0 ? { ran: true } : { ran: true, warning: `Formatter failed (${r.timedOut ? 'timed out' : `exit ${r.code}`}): ${argv[0]}` };
  }
}
