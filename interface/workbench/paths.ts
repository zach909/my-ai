/** Where the workbench keeps things, and how it keeps file paths inside the folder they belong to. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../platform/app-paths.js';

export const PROJECT_DIR = '.neuroclaw';

/** The workbench's own data folder in the user's data root. */
export const workbenchRoot = (override?: string): string => override ? path.resolve(override) : path.join(dataRoot(), 'workbench');

/** A stable short id for a project folder, so per-project data can live in one place. */
export const projectId = (root: string): string => createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);

/** Where an enterprise or an administrator puts policy no project or user can override. */
export function managedFile(): string {
  if (process.env.NEUROCLAW_MANAGED_FILE) return path.resolve(process.env.NEUROCLAW_MANAGED_FILE);
  if (process.platform === 'win32') return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'NeuroClaw', 'managed.json');
  if (process.platform === 'darwin') return '/Library/Application Support/NeuroClaw/managed.json';
  return '/etc/neuroclaw/managed.json';
}

/** True when `child` is `root` or inside it. Both must already be absolute. */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a path against `root`, following symlinks where the target exists. Returns null when it escapes root. */
export function confine(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  if (!isInside(root, abs)) return null;
  let real = abs;
  try { real = realpathSync(abs); } catch {
    // Not there yet: check the nearest parent that is.
    let parent = path.dirname(abs);
    for (let i = 0; i < 64 && parent !== path.dirname(parent); i++) {
      try { real = path.join(realpathSync(parent), path.relative(parent, abs)); break; } catch { parent = path.dirname(parent); }
    }
  }
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* keep */ }
  return isInside(realRoot, real) ? abs : null;
}

/** A relative path with forward slashes, the way rules and checkpoints name files. */
export const relPosix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
