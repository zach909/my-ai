#!/usr/bin/env node
/**
 * One command for the installable app: `npm run package`.
 *
 *   1. build the backend (scripts/build-backend.mjs)
 *   2. stage the payload: app + Node runtime + window program (scripts/release/stage-app.mjs)
 *   3. wrap it for this operating system, into release-artifacts/:
 *        Linux    neuroclaw-<v>-linux-<arch>.deb (its postinst runs scripts/install.sh) and .tar.gz
 *        Windows  neuroclaw-<v>-windows-<arch>.exe (IExpress installer) and .zip
 *        macOS    neuroclaw-<v>-macos-<arch>.dmg and .zip
 *
 *   node scripts/release/package-app.mjs [--out <dir>] [--no-build] [--platform linux|windows|macos]
 *
 * Each installer can only be built on its own OS (dpkg-deb, iexpress.exe, hdiutil need the real thing), so on
 * another OS the others are reported as skipped rather than faked. Node built-ins only.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageApp } from './stage-app.mjs';
import { packageLinux } from './package-linux.mjs';
import { packageWindows } from './package-windows.mjs';
import { packageMacos } from './package-macos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2);
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const out = path.resolve(ROOT, opt('--out', 'release-artifacts'));
const platform = opt('--platform', { linux: 'linux', win32: 'windows', darwin: 'macos' }[process.platform]);
const stageDir = path.join(out, '.stage');

if (!a.includes('--no-build')) {
  console.log('[package] building the backend...');
  const r = spawnSync(process.execPath, ['scripts/build-backend.mjs'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[package] backend build failed'); process.exit(r.status || 1); }
}
try {
  console.log('[package] staging the app...');
  stageApp({ out: stageDir, channel: opt('--channel', 'dev') });
  console.log(`[package] packaging for ${platform}...`);
  const made = platform === 'linux' ? await packageLinux({ stageDir, outDir: out })
    : platform === 'windows' ? (await packageWindows({ stageDir, outDir: out })).artifacts
    : platform === 'macos' ? await packageMacos({ stageDir, outDir: out })
    : (() => { throw new Error(`unknown platform ${platform}`); })();
  for (const x of (Array.isArray(made) ? made : made.artifacts ?? [])) console.log(x.file ?? x);
} catch (e) { console.error(`[package] failed: ${e.message}`); process.exit(1); }
