/**
 * Sessions: every conversation kept as an append-only file you can resume, fork, rename, search and share.
 *
 *   <workbench>/sessions/<id>.jsonl      line 1 is the header, every later line is one message or event
 *   <workbench>/shares.json              share links: token -> session, expiry
 *
 * Fork copies a session up to a message into a new one that remembers its parent. Resume is just reading the
 * messages back. Search scans titles and message text with a time and size budget. Retention keeps the newest 300.
 *
 * Share: a link to a read-only page of the transcript and its diffs. The token is 24 random bytes, the link expires
 * (7 days by default), it can be revoked, and everything on the page goes through the secret redactor first. The
 * page is served by the workbench route; with offline mode on, sharing is refused.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { workbenchRoot } from './paths.js';
import { escapeHtml, redactSecrets } from './text-utils.js';
import { isOffline } from './netguard.js';
import type { Message } from './compaction.js';

export interface SessionHeader { id: string; title: string; cwd: string; agent: string; created: string; updated: string; parent?: string; forkedAt?: number }
export interface SessionMessage extends Message { at: string; checkpoint?: string }

const MAX_SESSIONS = 300;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const ID = /^[a-f0-9]{12}$/;

export class SessionStore {
  private dir: string;
  private sharesFile: string;
  constructor(dataDir?: string) {
    const root = workbenchRoot(dataDir);
    this.dir = path.join(root, 'sessions');
    this.sharesFile = path.join(root, 'shares.json');
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('Not a session id.');
    return path.join(this.dir, `${id}.jsonl`);
  }

  create(opts: { cwd: string; agent: string; title?: string; parent?: string; forkedAt?: number }): SessionHeader {
    mkdirSync(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const h: SessionHeader = { id: randomBytes(6).toString('hex'), title: (opts.title ?? 'New session').slice(0, 120), cwd: opts.cwd, agent: opts.agent, created: now, updated: now, parent: opts.parent, forkedAt: opts.forkedAt };
    writeFileAtomic(this.file(h.id), JSON.stringify({ header: h }) + '\n');
    this.prune();
    return h;
  }

  private readAll(id: string): { header: SessionHeader; messages: SessionMessage[] } | null {
    let text: string;
    try { text = readFileSync(this.file(id), 'utf8'); } catch { return null; }
    const lines = text.split('\n').filter(Boolean);
    let header: SessionHeader | null = null;
    const messages: SessionMessage[] = [];
    for (const l of lines) {
      try {
        const v = JSON.parse(l);
        if (v.header) header = { ...(header ?? {}), ...v.header };   // a later header line is a rename
        else if (v.truncate !== undefined) messages.length = Math.min(messages.length, Number(v.truncate));
        else if (typeof v.content === 'string') messages.push(v);
      } catch { /* a torn last line is ignored */ }
    }
    return header ? { header, messages } : null;
  }

  get(id: string): { header: SessionHeader; messages: SessionMessage[] } | null { try { return this.readAll(id); } catch { return null; } }

  append(id: string, m: Omit<SessionMessage, 'at'>): boolean {
    const f = this.file(id);
    try { if (statSync(f).size > MAX_SESSION_BYTES) return false; } catch { return false; }
    appendFileSync(f, JSON.stringify({ ...m, at: new Date().toISOString() }) + '\n');
    return true;
  }

  rename(id: string, title: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    appendFileSync(this.file(id), JSON.stringify({ header: { title: title.slice(0, 120), updated: new Date().toISOString() } }) + '\n');
    return true;
  }

  /** Cut a session back to its first `count` messages (rewinding the conversation). */
  truncate(id: string, count: number): boolean {
    if (!this.get(id)) return false;
    appendFileSync(this.file(id), JSON.stringify({ truncate: Math.max(0, count) }) + '\n');
    return true;
  }

  fork(id: string, at?: number, title?: string): SessionHeader | null {
    const s = this.get(id);
    if (!s) return null;
    const n = at === undefined ? s.messages.length : Math.max(0, Math.min(at, s.messages.length));
    const h = this.create({ cwd: s.header.cwd, agent: s.header.agent, title: title ?? `${s.header.title} (fork)`, parent: id, forkedAt: n });
    for (const m of s.messages.slice(0, n)) appendFileSync(this.file(h.id), JSON.stringify(m) + '\n');
    return h;
  }

  list(): SessionHeader[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(n => n.endsWith('.jsonl')); } catch { return []; }
    const out: SessionHeader[] = [];
    for (const n of names) { const s = this.get(n.slice(0, -6)); if (s) out.push({ ...s.header, updated: this.lastTouched(n.slice(0, -6)) ?? s.header.updated }); }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  private lastTouched(id: string): string | null { try { return statSync(this.file(id)).mtime.toISOString(); } catch { return null; } }

  search(query: string, limit = 20, budgetMs = 1500): Array<{ id: string; title: string; snippet: string }> {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const t0 = Date.now();
    const out: Array<{ id: string; title: string; snippet: string }> = [];
    for (const h of this.list()) {
      if (Date.now() - t0 > budgetMs || out.length >= limit) break;
      if (h.title.toLowerCase().includes(q)) { out.push({ id: h.id, title: h.title, snippet: h.title }); continue; }
      const s = this.get(h.id);
      const hit = s?.messages.find(m => m.content.toLowerCase().includes(q));
      if (hit) {
        const i = hit.content.toLowerCase().indexOf(q);
        out.push({ id: h.id, title: h.title, snippet: redactSecrets(hit.content.slice(Math.max(0, i - 40), i + q.length + 80)).replace(/\s+/g, ' ') });
      }
    }
    return out;
  }

  delete(id: string): boolean { try { unlinkSync(this.file(id)); return true; } catch { return false; } }

  private prune(): void {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(n => n.endsWith('.jsonl')); } catch { return; }
    if (names.length <= MAX_SESSIONS) return;
    const aged = names.map(n => ({ n, t: statSync(path.join(this.dir, n)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { n } of aged.slice(0, names.length - MAX_SESSIONS)) { try { unlinkSync(path.join(this.dir, n)); } catch { /* ignore */ } }
  }

  // ── Sharing ──
  private shares(): Record<string, { session: string; expires: number; created: number }> {
    try { const v = JSON.parse(readFileSync(this.sharesFile, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  share(id: string, days = 7): { ok: true; token: string; path: string; expires: string } | { ok: false; reason: string } {
    if (isOffline()) return { ok: false, reason: 'Offline mode is on, so sharing is off.' };
    if (!this.get(id)) return { ok: false, reason: 'No such session.' };
    const all = this.shares();
    const now = Date.now();
    for (const [t, s] of Object.entries(all)) if (s.expires < now) delete all[t];
    const token = randomBytes(24).toString('base64url');
    const expires = now + Math.min(90, Math.max(1, days)) * 86_400_000;
    all[token] = { session: id, expires, created: now };
    mkdirSync(path.dirname(this.sharesFile), { recursive: true });
    writeJsonAtomic(this.sharesFile, all);
    return { ok: true, token, path: `/share/${token}`, expires: new Date(expires).toISOString() };
  }

  revoke(token: string): boolean {
    const all = this.shares();
    if (!all[token]) return false;
    delete all[token];
    writeJsonAtomic(this.sharesFile, all);
    return true;
  }

  listShares(): Array<{ tokenEnd: string; session: string; expires: string }> {
    return Object.entries(this.shares()).map(([t, s]) => ({ tokenEnd: t.slice(-6), session: s.session, expires: new Date(s.expires).toISOString() }));
  }

  /** The read-only page for a token, or null when the token is unknown, expired, or offline mode is on. */
  renderShare(token: string): string | null {
    if (isOffline() || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const entry = this.shares()[token];
    if (!entry || entry.expires < Date.now()) return null;
    const s = this.get(entry.session);
    if (!s) return null;
    return renderTranscript(s.header, s.messages);
  }
}

const isDiff = (t: string): boolean => /^(?:@@ |\+\+\+ |--- )/m.test(t);

export function renderTranscript(h: SessionHeader, messages: SessionMessage[]): string {
  const body = messages.map(m => {
    const text = redactSecrets(m.content);
    const inner = isDiff(text)
      ? `<pre class="diff">${text.split('\n').map(l => `<span class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${escapeHtml(l)}</span>`).join('\n')}</pre>`
      : `<div class="text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
    return `<section class="nc-glass msg ${m.role}"><h3>${escapeHtml(m.role)}</h3>${inner}</section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(redactSecrets(h.title))}</title>
<style>.wrap{max-width:860px;margin:0 auto;padding:28px 16px 64px}.msg{margin:14px 0;padding:16px 22px;border-radius:32px}.msg h3{margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#e3a99d}.text{line-height:1.55;word-break:break-word}
pre.diff{margin:0;overflow:auto;font:12.5px ui-monospace,monospace}.diff .add{color:#8fe3a8}.diff .del{color:#ff9aa8}.note{opacity:.62;font-size:13px}</style></head>
<body class="nc-soft"><div class="wrap"><h1>${escapeHtml(redactSecrets(h.title))}</h1><p class="note">A read-only copy of a conversation. Anything that looked like a password or key was removed.</p>${body}</div></body></html>`;
}
void existsSync;
