/**
 * Trust for things a project asks to run.
 *
 * A repository can carry hooks and tool-server entries, and both start programs. Opening a repository must not
 * be enough to run them. Each project's hooks file and tool-server file is hashed; it runs only when the owner has
 * approved that exact content. Edit the file and the approval no longer matches, so it asks again.
 * User-level and administrator-level config is the owner's own and needs no approval.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { projectId, workbenchRoot } from './paths.js';

export type TrustKind = 'hooks' | 'mcp' | 'settings';

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

export class TrustStore {
  private file: string;
  constructor(root?: string) { this.file = path.join(workbenchRoot(root), 'trust.json'); }

  private load(): Record<string, Record<string, string>> {
    try { const v = JSON.parse(readFileSync(this.file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  isTrusted(projectRoot: string, kind: TrustKind, content: string): boolean {
    return this.load()[`${projectId(projectRoot)}:${kind}`]?.hash === hashText(content);
  }

  trust(projectRoot: string, kind: TrustKind, content: string): void {
    const all = this.load();
    all[`${projectId(projectRoot)}:${kind}`] = { hash: hashText(content), root: path.resolve(projectRoot), at: new Date().toISOString() } as Record<string, string>;
    writeJsonAtomic(this.file, all);
  }

  revoke(projectRoot: string, kind: TrustKind): void {
    const all = this.load();
    delete all[`${projectId(projectRoot)}:${kind}`];
    writeJsonAtomic(this.file, all);
  }
}
