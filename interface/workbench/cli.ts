/**
 * The workbench's command line.
 *
 *   neuroclaw run [prompt] [--agent NAME] [--output text|json|stream-json] [--session ID] [--model ROLE]
 *   neuroclaw wb status | agents | commands | sessions | search WORDS | fork ID [N] | rename ID TITLE | share ID [DAYS] | revoke TOKEN
 *   neuroclaw wb checkpoints | diff ID | undo [--force] | redo [--force] | rewind ID [code|conversation|both] [--session ID]
 *   neuroclaw wb trust [settings|hooks|mcp ...]
 *   neuroclaw wb mcp list | add NAME stdio CMD ARGS... | add NAME http URL | remove NAME | tools
 *   neuroclaw wb bundle install DIR [--trust] | list | remove NAME | enable NAME | disable NAME
 *   neuroclaw wb usage [DAYS] | memory [list|add TEXT|forget WORDS]
 *
 * Pure: it takes argv and an io object and returns an exit code, so it can be tested with no process around it.
 */
import { runHeadless, readStdin, type OutputFormat } from './headless.js';
import type { Workbench } from './workbench.js';

export interface CliIO { out(s: string): void; err(s: string): void; stdin?(): Promise<string> }

const take = (args: string[], flag: string): string | undefined => { const i = args.indexOf(flag); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (args: string[], flag: string): boolean => { const i = args.indexOf(flag); if (i === -1) return false; args.splice(i, 1); return true; };
const line = (io: CliIO, s = '') => io.out(s + '\n');

export async function workbenchCli(argv: string[], wb: Workbench, io: CliIO, tui?: () => Promise<number>): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  if (cmd === 'run') {
    const agent = take(args, '--agent'), output = take(args, '--output') as OutputFormat | undefined, session = take(args, '--session'), model = take(args, '--model');
    if (output && !['text', 'json', 'stream-json'].includes(output)) { io.err('--output must be text, json or stream-json.\n'); return 1; }
    const r = await runHeadless(wb, { prompt: args.join(' '), agent, output, session, model, stdin: io.stdin ? await io.stdin() : await readStdin() });
    io.out(r.stdout);
    return r.exitCode;
  }
  if (cmd === 'tui') { if (!tui) { io.err('The terminal interface needs a terminal.\n'); return 1; } return tui(); }
  if (cmd !== 'wb') { io.err('Usage: neuroclaw run|tui|wb ... (see interface/workbench/cli.ts)\n'); return 1; }

  const sub = args.shift();
  switch (sub) {
    case 'status': line(io, JSON.stringify(wb.status(), null, 2)); return 0;
    case 'agents': for (const a of wb.agents()) line(io, `${a.name.padEnd(14)} ${a.source.padEnd(8)} ${a.description}`); return 0;
    case 'commands': for (const c of wb.commands()) line(io, `/${c.name.padEnd(20)} ${c.source.padEnd(8)} ${c.description}`); return 0;
    case 'sessions': for (const s of wb.sessions.list().slice(0, 50)) line(io, `${s.id}  ${s.updated.slice(0, 16)}  ${s.agent.padEnd(8)} ${s.title}${s.parent ? `  (fork of ${s.parent})` : ''}`); return 0;
    case 'search': for (const r of wb.sessions.search(args.join(' '))) line(io, `${r.id}  ${r.title}\n    ${r.snippet}`); return 0;
    case 'fork': { const h = wb.sessions.fork(args[0] ?? '', args[1] === undefined ? undefined : Number(args[1])); if (!h) { io.err('No such session.\n'); return 1; } line(io, h.id); return 0; }
    case 'rename': { const id = args.shift() ?? ''; if (!wb.sessions.rename(id, args.join(' '))) { io.err('No such session.\n'); return 1; } return 0; }
    case 'share': { const r = wb.sessions.share(args[0] ?? '', args[1] ? Number(args[1]) : undefined); if (r.ok === false) { io.err((r as { reason: string }).reason + '\n'); return 1; } const ok = r as { path: string; expires: string }; line(io, `${ok.path}   (expires ${ok.expires}; open it on the server that runs NeuroClaw)`); return 0; }
    case 'revoke': return wb.sessions.revoke(args[0] ?? '') ? 0 : 1;
    case 'checkpoints': for (const c of wb.checkpoints.list()) line(io, `${c.id}  ${c.at.slice(0, 16)}  ${c.undone ? 'undone ' : 'applied'}  ${Object.keys(c.before).length} file(s)  ${c.label}`); return 0;
    case 'diff': line(io, wb.checkpoints.diff(args[0] ?? '')); return 0;
    case 'undo': { const r = wb.checkpoints.undo({ force: has(args, '--force') }); line(io, r.ok ? `Restored ${r.files.length} file(s): ${r.files.join(', ')}` : r.reason ?? 'Nothing to undo.'); return r.ok ? 0 : 1; }
    case 'redo': { const r = wb.checkpoints.redo({ force: has(args, '--force') }); line(io, r.ok ? `Reapplied ${r.files.length} file(s): ${r.files.join(', ')}` : r.reason ?? 'Nothing to redo.'); return r.ok ? 0 : 1; }
    case 'rewind': {
      const session = take(args, '--session'), force = has(args, '--force');
      const what = (['code', 'conversation', 'both'].includes(args[1]) ? args[1] : 'code') as 'code' | 'conversation' | 'both';
      const r = wb.rewind(args[0] ?? '', what, session, force);
      line(io, r.ok ? `Rewound ${what}.${r.files.length ? ` Files: ${r.files.join(', ')}.` : ''}` : r.reason ?? 'Could not rewind.'); return r.ok ? 0 : 1;
    }
    case 'trust': { const kinds = args.filter((a): a is 'settings' | 'hooks' | 'mcp' => ['settings', 'hooks', 'mcp'].includes(a)); const done = wb.trustProject(kinds.length ? kinds : undefined); line(io, done.length ? `Approved: ${done.join(', ')}` : 'This project has no .neuroclaw files to approve.'); return 0; }
    case 'mcp': {
      const m = args.shift();
      if (m === 'list') { for (const c of wb.mcp.configs()) line(io, `${c.name.padEnd(16)} ${c.scope.padEnd(8)} ${c.def.transport.padEnd(6)} ${c.problem ?? 'ready'}`); return 0; }
      if (m === 'tools') { const r = await wb.mcp.tools(); r.tools.forEach(t => line(io, `${t.server}/${t.name}  ${t.description}`)); r.errors.forEach(e => io.err(e + '\n')); wb.mcp.closeAll(); return 0; }
      if (m === 'remove') { const ok = wb.mcp.remove('user', args[0] ?? '') || wb.mcp.remove('project', args[0] ?? ''); return ok ? 0 : 1; }
      if (m === 'add') {
        const scope = has(args, '--project') ? 'project' : 'user';
        const [name, transport, ...rest] = args;
        const def = transport === 'stdio' ? { transport: 'stdio' as const, command: rest } : { transport: transport as 'http' | 'sse', url: rest[0] };
        const r = wb.mcp.add(scope, name ?? '', def);
        if (!r.ok) { io.err((r.reason ?? 'Could not add it.') + '\n'); return 1; }
        if (scope === 'project') line(io, 'Added to this project. It will not start until you approve it: neuroclaw wb trust mcp');
        return 0;
      }
      io.err('Usage: wb mcp list|tools|add|remove\n'); return 1;
    }
    case 'bundle': {
      const b = args.shift();
      if (b === 'list') { for (const r of wb.bundles.list()) line(io, `${r.name}@${r.version}  ${r.enabled ? 'on ' : 'off'}  ${r.trusted ? 'hooks+servers' : 'prompts only'}  ${r.description}`); return 0; }
      if (b === 'install') { const r = wb.bundles.install(args.find(a => !a.startsWith('--')) ?? '', { trust: has(args, '--trust') }); if (!r.ok) { io.err((r.reason ?? 'Failed') + '\n'); return 1; } wb.reload(); line(io, `Installed ${r.record!.name}.${r.held?.length ? ` Held back until you reinstall with --trust: ${r.held.join(', ')}` : ''}`); return 0; }
      if (b === 'remove') { const ok = wb.bundles.remove(args[0] ?? ''); wb.reload(); return ok ? 0 : 1; }
      if (b === 'enable' || b === 'disable') { const ok = wb.bundles.setEnabled(args[0] ?? '', b === 'enable'); wb.reload(); return ok ? 0 : 1; }
      io.err('Usage: wb bundle install|list|remove|enable|disable\n'); return 1;
    }
    case 'usage': line(io, JSON.stringify(wb.usage.summary(args[0] ? Number(args[0]) : 7), null, 2)); return 0;
    case 'memory': {
      const m = args.shift() ?? 'list';
      if (m === 'add') { const r = wb.remember('note', args.join(' ')); line(io, r.ok ? 'Remembered.' : r.reason ?? ''); return r.ok ? 0 : 1; }
      if (m === 'forget') { const words = args.join(' ').trim(); if (words.length < 3) { io.err('Say which memory to forget (at least a few letters).\n'); return 1; } const n = wb.memory.forget(words); line(io, `Forgot ${n} entr${n === 1 ? 'y' : 'ies'}.`); return 0; }
      wb.memory.all().forEach(e => line(io, `(${e.kind}) ${e.text}`)); return 0;
    }
    default: io.err('Usage: neuroclaw wb status|agents|commands|sessions|search|fork|rename|share|revoke|checkpoints|diff|undo|redo|rewind|trust|mcp|bundle|usage|memory\n'); return 1;
  }
}
