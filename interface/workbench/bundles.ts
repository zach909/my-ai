/**
 * Bundles: one folder that carries commands, agents, hooks and tool servers, installed with one command.
 *
 *   neuroclaw-bundle.json   { "name": "review-kit", "version": "1.0.0", "description": "..." }
 *   commands/*.md   agents/*.md   hooks.json   mcp.json
 *
 * Installing copies the folder into the workbench's own data folder from a local path. There is no download step and no
 * registry: a bundle comes from a folder you already have. Hooks and tool servers start programs, so a bundle's
 * `hooks.json` and `mcp.json` are held back unless the install says `trust: true`; commands and agents are only prompts and
 * rules and always load. Files are copied one by one: no links, no `..`, nothing over 1 MB, at most 200 files.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../models && skills/core/atomic-write.js';
import { workbenchRoot } from './paths.js';
import { SAFE_NAME } from './text-utils.js';

export interface BundleRecord { name: string; version: string; description: string; enabled: boolean; trusted: boolean; installed: string }

const MAX_FILES = 200, MAX_FILE = 1024 * 1024;
const ALLOWED = /^(?:neuroclaw-bundle\.json|hooks\.json|mcp\.json|(?:commands|agents)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md)$/i;

export class BundleStore {
  private dir: string;
  private registry: string;
  constructor(dataDir?: string) { const r = workbenchRoot(dataDir); this.dir = path.join(r, 'bundles'); this.registry = path.join(r, 'bundles.json'); }

  private records(): BundleRecord[] { try { const v = JSON.parse(readFileSync(this.registry, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } }
  list(): BundleRecord[] { return this.records(); }
  pathOf(name: string): string { return path.join(this.dir, name); }

  install(src: string, opts: { trust?: boolean } = {}): { ok: boolean; reason?: string; record?: BundleRecord; held?: string[] } {
    const root = path.resolve(src);
    let manifest: any;
    try { manifest = JSON.parse(readFileSync(path.join(root, 'neuroclaw-bundle.json'), 'utf8')); } catch { return { ok: false, reason: 'No readable neuroclaw-bundle.json in that folder.' }; }
    const name = String(manifest?.name ?? '').toLowerCase();
    if (!SAFE_NAME.test(name)) return { ok: false, reason: 'The bundle name must use a-z, 0-9, - and _.' };
    const files: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d)) {
        const abs = path.join(d, e), r = rel ? `${rel}/${e}` : e;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) throw new Error(`${r} is a link; bundles may not contain links.`);
        if (st.isDirectory()) walk(abs, r);
        else if (st.isFile() && ALLOWED.test(r)) { if (st.size > MAX_FILE) throw new Error(`${r} is over 1 MB.`); files.push(r); }
      }
    };
    try { walk(root, ''); } catch (e) { return { ok: false, reason: (e as Error).message }; }
    if (files.length > MAX_FILES) return { ok: false, reason: `More than ${MAX_FILES} files.` };
    const held: string[] = [];
    const dest = this.pathOf(name);
    rmSync(dest, { recursive: true, force: true });
    for (const f of files) {
      if ((f === 'hooks.json' || f === 'mcp.json') && !opts.trust) { held.push(f); continue; }
      const to = path.join(dest, ...f.split('/'));
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(root, ...f.split('/')), to);
    }
    const record: BundleRecord = { name, version: String(manifest.version ?? '0.0.0').slice(0, 40), description: String(manifest.description ?? '').slice(0, 300), enabled: true, trusted: !!opts.trust, installed: new Date().toISOString() };
    writeJsonAtomic(this.registry, [...this.records().filter(r => r.name !== name), record]);
    return { ok: true, record, held };
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const all = this.records();
    const r = all.find(x => x.name === name);
    if (!r) return false;
    r.enabled = enabled;
    writeJsonAtomic(this.registry, all);
    return true;
  }

  remove(name: string): boolean {
    const all = this.records();
    if (!all.some(r => r.name === name) || !SAFE_NAME.test(name)) return false;
    rmSync(this.pathOf(name), { recursive: true, force: true });
    writeJsonAtomic(this.registry, all.filter(r => r.name !== name));
    return true;
  }

  /** Folders of enabled bundles, for the loaders. */
  enabledDirs(): Array<{ name: string; dir: string; trusted: boolean }> {
    return this.records().filter(r => r.enabled && existsSync(this.pathOf(r.name))).map(r => ({ name: r.name, dir: this.pathOf(r.name), trusted: r.trusted }));
  }
}
