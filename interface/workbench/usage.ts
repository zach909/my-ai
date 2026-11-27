/**
 * Usage tracking, kept on this machine and never sent anywhere.
 *
 * One line per event in a daily file: a turn or a tool call, with how long it took and how many bytes went in and
 * out. Bytes, not tokens: this project has no tokenizer, so it does not pretend to count them, and there is no money
 * cost because nothing here is billed. Files older than the retention window are deleted, and a day's file stops
 * growing at 1 MB, so the ledger cannot fill the drive.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { workbenchRoot } from './paths.js';

export interface UsageEvent { t: string; kind: 'turn' | 'tool'; agent?: string; tool?: string; session?: string; ms: number; bytesIn: number; bytesOut: number; ok: boolean; blocked?: boolean }
export interface UsageSummary { events: number; turns: number; tools: number; ms: number; bytesIn: number; bytesOut: number; failures: number; blocked: number; byAgent: Record<string, number>; byTool: Record<string, number> }

const DAY_CAP = 1024 * 1024;

export class UsageLedger {
  private dir: string;
  constructor(dataDir?: string, private retentionDays = 30) { this.dir = path.join(workbenchRoot(dataDir), 'usage'); }

  private dayFile(d = new Date()): string { return path.join(this.dir, `${d.toISOString().slice(0, 10)}.jsonl`); }

  record(e: Omit<UsageEvent, 't'>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const f = this.dayFile();
      try { if (statSync(f).size > DAY_CAP) return; } catch { this.prune(); }
      appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n');
    } catch { /* usage tracking must never break a turn */ }
  }

  summary(days = 7): UsageSummary {
    const s: UsageSummary = { events: 0, turns: 0, tools: 0, ms: 0, bytesIn: 0, bytesOut: 0, failures: 0, blocked: 0, byAgent: {}, byTool: {} };
    const since = Date.now() - days * 86_400_000;
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(n => n.endsWith('.jsonl')); } catch { return s; }
    for (const n of names) {
      if (Date.parse(n.slice(0, 10)) < since - 86_400_000) continue;
      for (const l of readFileSync(path.join(this.dir, n), 'utf8').split('\n')) {
        if (!l) continue;
        let e: UsageEvent;
        try { e = JSON.parse(l); } catch { continue; }
        if (Date.parse(e.t) < since) continue;
        s.events++; s.ms += e.ms || 0; s.bytesIn += e.bytesIn || 0; s.bytesOut += e.bytesOut || 0;
        if (e.kind === 'turn') s.turns++; else s.tools++;
        if (!e.ok) s.failures++;
        if (e.blocked) s.blocked++;
        if (e.agent) s.byAgent[e.agent] = (s.byAgent[e.agent] ?? 0) + 1;
        if (e.tool) s.byTool[e.tool] = (s.byTool[e.tool] ?? 0) + 1;
      }
    }
    return s;
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    try { for (const n of readdirSync(this.dir)) if (Date.parse(n.slice(0, 10)) < cutoff) unlinkSync(path.join(this.dir, n)); } catch { /* ignore */ }
  }
}
