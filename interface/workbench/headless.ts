/**
 * Headless (print) mode: one prompt in, one answer out, no screen. For scripts, pipelines and reviews.
 *
 *   neuroclaw run "summarise the failing tests" --agent plan --output json
 *   git diff | neuroclaw run "review this diff" --output text
 *
 * Output formats:
 *   text         the answer, nothing else
 *   json         one object: { type:"result", ok, result, session_id, agent, route, checkpoint, duration_ms, usage, warnings }
 *   stream-json  one JSON object per line: an "init" line, then the "result" line (the engine answers whole, so there are no partial lines)
 * Exit code: 0 answered, 1 failed, 2 stopped by a hook or a permission rule.
 */
import type { Workbench } from './workbench.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface HeadlessOptions {
  prompt: string;
  agent?: string;
  output?: OutputFormat;
  session?: string;
  model?: string;
  /** Text piped in on stdin, added after the prompt. */
  stdin?: string;
}

export const MAX_STDIN = 1024 * 1024;

export async function runHeadless(wb: Workbench, o: HeadlessOptions): Promise<{ exitCode: number; stdout: string }> {
  const format = o.output ?? 'text';
  const prompt = o.stdin ? `${o.prompt}\n\n${o.stdin.slice(0, MAX_STDIN)}`.trim() : o.prompt;
  if (!prompt.trim()) return { exitCode: 1, stdout: format === 'text' ? 'No prompt given.\n' : JSON.stringify({ type: 'result', ok: false, result: 'No prompt given.' }) + '\n' };
  const r = await wb.turn({ prompt, agent: o.agent, session: o.session, model: o.model });
  const result = {
    type: 'result', ok: r.ok, blocked: r.blocked === true, result: r.text, session_id: r.session, agent: r.agent,
    route: { engine: r.route.engine, effort: r.route.effort }, checkpoint: r.checkpoint ?? null, compacted: r.compacted === true,
    duration_ms: r.ms, usage: { bytes_in: Buffer.byteLength(prompt), bytes_out: Buffer.byteLength(r.text) }, warnings: r.warnings,
  };
  const exitCode = r.blocked ? 2 : r.ok ? 0 : 1;
  if (format === 'json') return { exitCode, stdout: JSON.stringify(result) + '\n' };
  if (format === 'stream-json') return { exitCode, stdout: JSON.stringify({ type: 'init', session_id: r.session, agent: r.agent }) + '\n' + JSON.stringify(result) + '\n' };
  return { exitCode, stdout: r.text.endsWith('\n') ? r.text : r.text + '\n' };
}

/** Read all of stdin up to the cap, or '' when stdin is a terminal. */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return '';
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) { n += (c as Buffer).length; if (n > MAX_STDIN) break; chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_STDIN);
}
