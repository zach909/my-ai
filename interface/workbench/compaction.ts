/**
 * Context compaction: when a conversation gets long, fold the old part into a short summary and keep the recent part
 * exactly as it was.
 *
 * Size is counted in characters, not tokens: this project has no tokenizer, and a count that is a little off only moves
 * the moment of compaction slightly. Compaction runs when the conversation passes `threshold` of `budgetChars`.
 *
 * What is never summarised away: the first message (the task), anything pinned, the last `keepRecent` turns, and every
 * message that carries a diff or a tool result from the last `keepRecent * 2` messages. The summary lists the files
 * touched and keeps the most salient lines of what it replaces (core/context-compressor.ts, deterministic, no model).
 */
import { ContextCompressor } from '../../models && skills/core/context-compressor.js';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  pinned?: boolean;
  /** Set on a message that is a compaction summary. */
  summary?: boolean;
  /** Paths a tool call touched, if this message records one. */
  files?: string[];
}

export interface CompactOptions {
  budgetChars?: number;
  threshold?: number;
  keepRecent?: number;
  summaryChars?: number;
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  before: number;
  after: number;
  replaced: number;
}

export const sizeOf = (m: Message[]): number => m.reduce((n, x) => n + x.content.length + 8, 0);

const looksLikeDiff = (s: string): boolean => /^(?:@@ |\+\+\+ |--- |diff --git)/m.test(s) || /^[+-][^\n]{0,200}\n[+-]/m.test(s);

export function needsCompaction(m: Message[], opts: CompactOptions = {}): boolean {
  return sizeOf(m) > (opts.budgetChars ?? 48000) * (opts.threshold ?? 0.8);
}

export function compact(messages: Message[], opts: CompactOptions = {}): CompactResult {
  const before = sizeOf(messages);
  const keepRecent = Math.max(2, opts.keepRecent ?? 6);
  if (!needsCompaction(messages, opts) || messages.length <= keepRecent + 2) return { messages, compacted: false, before, after: before, replaced: 0 };

  const recentStart = messages.length - keepRecent;
  const protectFrom = Math.max(0, messages.length - keepRecent * 2);
  const keep: boolean[] = messages.map((m, i) => i === 0 || m.pinned === true || i >= recentStart || (i >= protectFrom && (looksLikeDiff(m.content) || m.role === 'tool')));
  const old = messages.filter((_, i) => !keep[i]);
  if (old.length < 2) return { messages, compacted: false, before, after: before, replaced: 0 };

  const files = new Set<string>();
  for (const m of old) {
    m.files?.forEach(f => files.add(f));
    for (const f of m.content.matchAll(/^(?:\+\+\+|---) [ab]\/(\S+)/gm)) files.add(f[1]);
  }
  const lines = old.map(m => `${m.role}: ${m.content.replace(/\s+/g, ' ').trim()}`);
  const summary = new ContextCompressor().compress(lines, { maxChars: opts.summaryChars ?? 1800, separator: '\n' }).summary;
  const text = `[Earlier conversation, compacted: ${old.length} messages]\n${summary}${files.size ? `\nFiles touched earlier: ${[...files].slice(0, 40).join(', ')}` : ''}`;

  const out: Message[] = [];
  let placed = false;
  messages.forEach((m, i) => {
    if (keep[i]) out.push(m);
    else if (!placed) { out.push({ role: 'system', content: text, summary: true }); placed = true; }
  });
  return { messages: out, compacted: true, before, after: sizeOf(out), replaced: old.length };
}
