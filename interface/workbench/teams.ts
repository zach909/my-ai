/**
 * Sub-agents and teams.
 *
 * A sub-agent is one agent run on its own: a fresh message list (its own context window), its own system prompt, and
 * only its summary comes back to the caller. Several run in parallel, up to a limit. They cannot start sub-agents of
 * their own past `maxDepth`, and the total per run is capped, so a prompt cannot fan out forever.
 *
 * A team coordinates sub-agents over shared state kept on disk:
 *   a task list     tasks with owners and dependencies; `claim` hands out the next ready task to exactly one member
 *   a mailbox       messages from one member to another (or everyone)
 * Both are small JSON files guarded by a lock folder, so two processes cannot claim the same task. Sizes are bounded.
 *
 * The executor that actually runs an agent is passed in. That keeps this file free of any engine and lets a test run
 * a whole team with a function that returns strings.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { workbenchRoot } from './paths.js';
import { SAFE_NAME } from './text-utils.js';
import type { AgentDef } from './agents.js';

export interface SubagentRequest { agent: AgentDef; prompt: string; depth: number; context?: string }
export type Executor = (req: SubagentRequest) => Promise<string>;
export interface SubagentResult { agent: string; ok: boolean; summary: string; ms: number }

export interface RunLimits { concurrency?: number; maxDepth?: number; maxTotal?: number; summaryChars?: number; timeoutMs?: number }

export async function runSubagents(
  jobs: Array<{ agent: AgentDef; prompt: string; context?: string }>,
  exec: Executor,
  depth: number,
  limits: RunLimits = {},
): Promise<SubagentResult[]> {
  const maxDepth = limits.maxDepth ?? 2;
  const maxTotal = limits.maxTotal ?? 12;
  const concurrency = Math.max(1, Math.min(limits.concurrency ?? 4, 8));
  const cap = limits.summaryChars ?? 4000;
  if (depth >= maxDepth) return jobs.map(j => ({ agent: j.agent.name, ok: false, summary: `Not started: sub-agents may not start more than ${maxDepth} levels of sub-agents.`, ms: 0 }));
  const results: SubagentResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      if (i >= maxTotal) { results[i] = { agent: jobs[i].agent.name, ok: false, summary: `Not started: at most ${maxTotal} sub-agents per run.`, ms: 0 }; continue; }
      const t0 = Date.now();
      try {
        const run = exec({ agent: jobs[i].agent, prompt: jobs[i].prompt, depth: depth + 1, context: jobs[i].context });
        const text = limits.timeoutMs ? await Promise.race([run, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timed out')), limits.timeoutMs))]) : await run;
        results[i] = { agent: jobs[i].agent.name, ok: true, summary: String(text).slice(0, cap), ms: Date.now() - t0 };
      } catch (e) { results[i] = { agent: jobs[i].agent.name, ok: false, summary: (e as Error).message.slice(0, 500), ms: Date.now() - t0 }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

// ── Team state ──

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'failed';
export interface TeamTask { id: string; title: string; status: TaskStatus; owner?: string; deps: string[]; result?: string }
export interface TeamMessage { id: string; from: string; to: string; text: string; at: string; readBy: string[] }
interface TeamState { tasks: TeamTask[]; messages: TeamMessage[] }

const MAX_TASKS = 500, MAX_MESSAGES = 500, MAX_TEXT = 4000;

export class Team {
  private dir: string;
  private file: string;
  constructor(readonly name: string, dataDir?: string) {
    if (!SAFE_NAME.test(name)) throw new Error('A team name uses a-z, 0-9, - and _.');
    this.dir = path.join(workbenchRoot(dataDir), 'teams', name);
    this.file = path.join(this.dir, 'state.json');
  }

  private read(): TeamState {
    try { const v = JSON.parse(readFileSync(this.file, 'utf8')); return { tasks: v.tasks ?? [], messages: v.messages ?? [] }; } catch { return { tasks: [], messages: [] }; }
  }

  /** Run `fn` holding the team's lock (a folder: creating it is atomic). A lock older than 30 s is taken over. */
  private async locked<T>(fn: (s: TeamState) => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, '.lock');
    const t0 = Date.now();
    for (;;) {
      try { mkdirSync(lock); break; } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
        if (Date.now() - t0 > 10_000) throw new Error('The team is busy; try again.');
        await new Promise(r => setTimeout(r, 15));
      }
    }
    try { const s = this.read(); const out = fn(s); writeJsonAtomic(this.file, s); return out; } finally { rmSync(lock, { recursive: true, force: true }); }
  }

  async addTask(title: string, deps: string[] = []): Promise<TeamTask> {
    return this.locked(s => {
      if (s.tasks.length >= MAX_TASKS) throw new Error('The task list is full.');
      const t: TeamTask = { id: randomBytes(3).toString('hex'), title: title.slice(0, 300), status: 'pending', deps: deps.filter(d => s.tasks.some(x => x.id === d)) };
      s.tasks.push(t);
      return t;
    });
  }

  /** Give `member` the first pending task whose dependencies are all done. Null when nothing is ready. */
  async claim(member: string): Promise<TeamTask | null> {
    return this.locked(s => {
      const t = s.tasks.find(x => x.status === 'pending' && x.deps.every(d => s.tasks.find(y => y.id === d)?.status === 'done'));
      if (!t) return null;
      t.status = 'claimed'; t.owner = member;
      return { ...t };
    });
  }

  async finish(id: string, member: string, ok: boolean, result: string): Promise<boolean> {
    return this.locked(s => {
      const t = s.tasks.find(x => x.id === id);
      if (!t || t.owner !== member || t.status !== 'claimed') return false;
      t.status = ok ? 'done' : 'failed'; t.result = result.slice(0, MAX_TEXT);
      return true;
    });
  }

  async tasks(): Promise<TeamTask[]> { return this.read().tasks; }

  /** Mark every pending task that depends (directly or through others) on a failed task as failed, so nothing waits on it forever. */
  async failBlocked(): Promise<number> {
    return this.locked(s => {
      let n = 0, changed = true;
      while (changed) {
        changed = false;
        for (const t of s.tasks) {
          if (t.status === 'pending' && t.deps.some(d => s.tasks.find(x => x.id === d)?.status === 'failed')) { t.status = 'failed'; t.result = 'A task it depends on failed.'; n++; changed = true; }
        }
      }
      return n;
    });
  }

  async send(from: string, to: string, text: string): Promise<void> {
    await this.locked(s => {
      s.messages.push({ id: randomBytes(3).toString('hex'), from, to, text: text.slice(0, MAX_TEXT), at: new Date().toISOString(), readBy: [] });
      if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    });
  }

  /** Messages for `member` (or for everyone, `*`) not yet read by them; marks them read. */
  async inbox(member: string): Promise<TeamMessage[]> {
    return this.locked(s => {
      const mine = s.messages.filter(m => (m.to === member || m.to === '*') && m.from !== member && !m.readBy.includes(member));
      mine.forEach(m => m.readBy.push(member));
      return mine.map(m => ({ ...m }));
    });
  }

  /**
   * Run members until the task list is finished: each member claims a task, the executor does it, the result is recorded.
   * A task whose executor throws is marked failed so the dependants stop instead of waiting forever.
   */
  async run(members: AgentDef[], exec: (task: TeamTask, member: AgentDef) => Promise<string>, concurrency = 3): Promise<TeamTask[]> {
    const work = async (member: AgentDef) => {
      for (;;) {
        const t = await this.claim(member.name);
        if (!t) {
          const left = (await this.tasks()).some(x => x.status === 'claimed' || (x.status === 'pending' && x.deps.every(d => (this.read().tasks.find(y => y.id === d)?.status ?? 'done') !== 'failed')));
          if (!left) return;
          await new Promise(r => setTimeout(r, 25));
          continue;
        }
        try { await this.finish(t.id, member.name, true, await exec(t, member)); } catch (e) { await this.finish(t.id, member.name, false, (e as Error).message); }
      }
    };
    await Promise.all(members.slice(0, Math.max(1, concurrency)).map(work));
    await this.failBlocked();
    return this.tasks();
  }
}
