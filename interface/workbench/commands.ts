/**
 * Custom slash commands: Markdown prompt templates in `.neuroclaw/commands/` (project) and the data folder (user).
 *
 *   .neuroclaw/commands/review.md          ->  /review
 *   .neuroclaw/commands/git/commit.md      ->  /git:commit
 *
 * In the body: `$ARGUMENTS` is everything after the command, `$1`..`$9` are the words (quotes respected),
 * and a line holding only `@path/to/file` is replaced by that file's text (inside the project, size-capped).
 * Frontmatter: `description`, `agent`, `model`, `argument-hint`.
 *
 * A command is only a prompt. It cannot run anything by itself; whatever the prompt makes the agent do still
 * goes through the permission rules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, splitArgs } from './text-utils.js';
import { confine } from './paths.js';
import type { LoadResult } from './agents.js';

export interface CommandDef {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
  argumentHint?: string;
  source: 'project' | 'user' | 'bundle';
  file: string;
}

const MAX_FILE = 64 * 1024;
const MAX_COMMANDS = 500;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function walk(dir: string, prefix: string, out: Array<{ file: string; name: string }>, depth = 0): void {
  if (depth > 3 || out.length >= MAX_COMMANDS) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir).sort(); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, `${prefix}${e}:`, out, depth + 1);
    else if (st.isFile() && e.endsWith('.md')) out.push({ file: full, name: `${prefix}${e.slice(0, -3)}`.toLowerCase() });
  }
}

export function loadCommandsFrom(dir: string, source: CommandDef['source']): LoadResult<CommandDef> {
  const items: CommandDef[] = [];
  const warnings: string[] = [];
  const found: Array<{ file: string; name: string }> = [];
  walk(dir, '', found);
  for (const { file, name } of found) {
    if (!name.split(':').every(p => NAME.test(p))) { warnings.push(`${file}: "${name}" is not a valid command name.`); continue; }
    try {
      if (statSync(file).size > MAX_FILE) { warnings.push(`${file}: over ${MAX_FILE} bytes, skipped.`); continue; }
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      items.push({
        name, description: String(data.description ?? '').slice(0, 300), template: body.trim(),
        agent: typeof data.agent === 'string' ? data.agent.toLowerCase() : undefined,
        model: typeof data.model === 'string' ? data.model.slice(0, 64) : undefined,
        argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'].slice(0, 100) : undefined,
        source, file,
      });
    } catch (e) { warnings.push(`${file}: ${(e as Error).message}`); }
  }
  return { items, warnings };
}

export interface ExpandOptions {
  root: string;
  /** Called for each `@file` line; return the text, or null to leave the line as it is. Defaults to reading inside root. */
  readFile?: (abs: string) => string | null;
  maxInclude?: number;
}

export function expandCommand(def: CommandDef, args: string, opts: ExpandOptions): string {
  const words = splitArgs(args);
  const maxInclude = opts.maxInclude ?? 64 * 1024;
  const read = opts.readFile ?? ((abs: string) => { try { const st = statSync(abs); return st.isFile() && st.size <= maxInclude ? readFileSync(abs, 'utf8') : null; } catch { return null; } });
  let usedArgs = false;
  const lines = def.template.split('\n').map(line => {
    const inc = /^@(\S.*)$/.exec(line.trim());
    if (inc) {
      const abs = confine(opts.root, inc[1].trim());
      const text = abs ? read(abs) : null;
      return text === null ? line : `File ${inc[1].trim()}:\n\`\`\`\n${text}\n\`\`\``;
    }
    return line;
  });
  let out = lines.join('\n').replace(/\$ARGUMENTS|\$([1-9])/g, (m, n) => {
    usedArgs = true;
    return n ? (words[Number(n) - 1] ?? '') : args;
  });
  if (!usedArgs && args.trim()) out += `\n\n${args.trim()}`;
  return out;
}

/** Split "/name rest of line" into the command and its arguments; null when the text is not a command. */
export function parseSlash(input: string): { name: string; args: string } | null {
  const m = /^\/([a-z0-9][a-z0-9_:-]{0,127})(?:\s+([^]*))?$/i.exec(input.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}
