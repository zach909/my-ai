/**
 * Live diagnostics: after the agent edits a file, find what is wrong with it and hand that straight back.
 *
 * Two sources, both optional and both safe to be missing:
 *   built-in checks    JSON syntax; `node --check` for JavaScript; Python's own compiler for .py (nothing is written to disk);
 *                      the project's own `tsc` for TypeScript when the project has one installed
 *   language servers   any server the owner lists in `lsp.json`, spoken to over stdio with the Language Server Protocol
 *                      (`{ "servers": { "go": { "command": ["gopls"], "extensions": [".go"] } } }`)
 *
 * Nothing here installs a server. A server that is not there, crashes or is slow produces no diagnostics and a note,
 * never an error in the agent's turn. A server listed in the project's own `lsp.json` is a program the project asks to run, so
 * that file needs the owner's approval like hooks do; the user-level file does not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { execLimited } from './hooks.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { PROJECT_DIR, workbenchRoot, confine, relPosix } from './paths.js';
import { TrustStore } from './trust.js';
import { pathToFileURL } from 'node:url';

export type Severity = 'error' | 'warning' | 'info' | 'hint';
export interface Diagnostic { file: string; line: number; column: number; severity: Severity; message: string; source: string }

const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SystemRoot'];
const cleanEnv = (): NodeJS.ProcessEnv => { const e: NodeJS.ProcessEnv = {}; for (const k of SAFE_ENV) if (process.env[k] !== undefined) e[k] = process.env[k]; return e; };

const PY_CHECK = 'import sys\ntry:\n compile(open(sys.argv[1],encoding="utf-8").read(), sys.argv[1], "exec")\nexcept SyntaxError as e:\n print("%s:%s:%s" % (e.lineno or 1, e.offset or 1, e.msg)); sys.exit(1)';

export async function builtinDiagnostics(root: string, file: string, timeoutMs = 20_000): Promise<Diagnostic[]> {
  const abs = confine(root, file);
  if (!abs || !existsSync(abs)) return [];
  const rel = relPosix(root, abs);
  const ext = path.extname(abs).toLowerCase();
  const d = (line: number, column: number, message: string, source: string, severity: Severity = 'error'): Diagnostic => ({ file: rel, line, column, severity, message: message.slice(0, 400), source });
  if (ext === '.json') {
    try { JSON.parse(readFileSync(abs, 'utf8')); return []; } catch (e) {
      const m = /position (\d+)/.exec((e as Error).message);
      let line = 1, col = 1;
      if (m) { const upto = readFileSync(abs, 'utf8').slice(0, Number(m[1])); line = upto.split('\n').length; col = upto.length - upto.lastIndexOf('\n'); }
      return [d(line, col, (e as Error).message, 'json')];
    }
  }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = await execLimited(process.execPath, ['--check', abs], { cwd: root, env: cleanEnv(), timeoutMs });
    if (r.code === 0) return [];
    const m = /:(\d+)\n[^]*?\n([A-Za-z]*Error: .*)/.exec(r.stderr);
    return [d(m ? Number(m[1]) : 1, 1, m ? m[2] : r.stderr.split('\n').find(Boolean) ?? 'Syntax error', 'node')];
  }
  if (ext === '.py') {
    const r = await execLimited('python3', ['-c', PY_CHECK, abs], { cwd: root, env: cleanEnv(), timeoutMs });
    if (r.code === 0 || r.code === 127) return [];
    const m = /^(\d+):(\d+):(.*)$/m.exec(r.stdout);
    return m ? [d(Number(m[1]), Number(m[2]), m[3].trim(), 'python')] : [];
  }
  if (ext === '.ts' || ext === '.tsx') {
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const cfg = ['tsconfig.json', 'tsconfig.backend.json'].find(c => existsSync(path.join(root, c)));
    if (!existsSync(tsc) || !cfg) return [];
    const r = await execLimited(process.execPath, [tsc, '--noEmit', '-p', cfg, '--pretty', 'false'], { cwd: root, env: cleanEnv(), timeoutMs: Math.max(timeoutMs, 60_000) });
    const out: Diagnostic[] = [];
    for (const m of r.stdout.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/gm)) {
      if (path.resolve(root, m[1]) === abs) out.push(d(Number(m[2]), Number(m[3]), `${m[5]} ${m[6]}`, 'tsc', m[4] as Severity));
    }
    return out;
  }
  return [];
}

// ── Language servers ──

export interface LspServerDef { command: string[]; extensions: string[] }

class LspSession {
  peer: JsonRpcPeer;
  private child;
  private diags = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, () => void>();
  private versions = new Map<string, number>();
  constructor(private root: string, private name: string, def: LspServerDef) {
    this.child = spawn(def.command[0], def.command.slice(1), { cwd: root, env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
    this.child.on('error', () => this.peer.close());
    this.peer = new JsonRpcPeer(this.child.stdout!, this.child.stdin!, 'content-length');
    this.peer.onNotification('textDocument/publishDiagnostics', (p: any) => {
      const sev: Severity[] = ['error', 'error', 'warning', 'info', 'hint'];
      const list: Diagnostic[] = (p.diagnostics ?? []).slice(0, 200).map((x: any): Diagnostic => ({
        file: p.uri, line: (x.range?.start?.line ?? 0) + 1, column: (x.range?.start?.character ?? 0) + 1,
        severity: sev[x.severity ?? 1] ?? 'error', message: String(x.message ?? '').slice(0, 400), source: String(x.source ?? this.name),
      }));
      this.diags.set(p.uri, list);
      this.waiters.get(p.uri)?.();
    });
    this.peer.onRequest('workspace/configuration', () => []);
    this.peer.onRequest('client/registerCapability', () => null);
    this.peer.onRequest('window/workDoneProgress/create', () => null);
  }

  async start(): Promise<void> {
    await this.peer.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.root).toString(), capabilities: { textDocument: { publishDiagnostics: {} } }, workspaceFolders: null }, 20_000);
    this.peer.notify('initialized', {});
  }

  async check(abs: string, text: string, waitMs: number): Promise<Diagnostic[]> {
    const uri = pathToFileURL(abs).toString();
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    const done = new Promise<void>(r => { this.waiters.set(uri, r); setTimeout(r, waitMs); });
    if (version === 1) this.peer.notify('textDocument/didOpen', { textDocument: { uri, languageId: path.extname(abs).slice(1), version, text } });
    else this.peer.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    await done;
    this.waiters.delete(uri);
    return (this.diags.get(uri) ?? []).map(x => ({ ...x, file: relPosix(this.root, abs) }));
  }

  close(): void { this.peer.close(); try { this.child.kill(); } catch { /* gone */ } }
}

export class DiagnosticsService {
  private sessions = new Map<string, LspSession>();
  readonly notes: string[] = [];
  constructor(private opts: { root: string; trust: TrustStore; dataDir?: string }) {}

  private servers(): Record<string, LspServerDef> {
    const out: Record<string, LspServerDef> = {};
    const read = (file: string): { servers: Record<string, LspServerDef>; raw: string } => { try { const raw = readFileSync(file, 'utf8'); return { servers: JSON.parse(raw)?.servers ?? {}, raw }; } catch { return { servers: {}, raw: '' }; } };
    Object.assign(out, read(path.join(workbenchRoot(this.opts.dataDir), 'lsp.json')).servers);
    const proj = read(path.join(this.opts.root, PROJECT_DIR, 'lsp.json'));
    if (proj.raw) {
      if (this.opts.trust.isTrusted(this.opts.root, 'mcp', proj.raw)) Object.assign(out, proj.servers);
      else this.notes.push('This project lists language servers in .neuroclaw/lsp.json, but the owner has not approved that file, so they were not started.');
    }
    return out;
  }

  /** Diagnostics for one file from every source that applies. Never throws. */
  async diagnose(file: string, opts: { timeoutMs?: number } = {}): Promise<Diagnostic[]> {
    const abs = confine(this.opts.root, file);
    if (!abs) return [];
    const out: Diagnostic[] = [];
    try { out.push(...await builtinDiagnostics(this.opts.root, file, opts.timeoutMs)); } catch (e) { this.notes.push(`Built-in check failed: ${(e as Error).message}`); }
    const ext = path.extname(abs).toLowerCase();
    for (const [name, def] of Object.entries(this.servers())) {
      if (!Array.isArray(def.command) || !def.command.length || !def.extensions?.map(e => e.toLowerCase()).includes(ext)) continue;
      try {
        let s = this.sessions.get(name);
        if (!s || s.peer.isClosed) { s = new LspSession(this.opts.root, name, def); await s.start(); this.sessions.set(name, s); }
        out.push(...await s.check(abs, readFileSync(abs, 'utf8'), opts.timeoutMs ?? 4000));
      } catch (e) { this.notes.push(`Language server ${name}: ${(e as Error).message}`); this.sessions.get(name)?.close(); this.sessions.delete(name); }
    }
    return out;
  }

  closeAll(): void { for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}

/** The diagnostics as the few lines the agent reads after an edit. Errors first, capped. */
export function renderDiagnostics(list: Diagnostic[], max = 20): string {
  if (!list.length) return '';
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
  const sorted = [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const lines = sorted.slice(0, max).map(d => `${d.file}:${d.line}:${d.column} ${d.severity} [${d.source}] ${d.message}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more.`);
  return lines.join('\n');
}
