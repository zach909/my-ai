#!/usr/bin/env node
/**
 * app.mjs -- `npm run app`: build, then open NeuroClaw in its own native window.
 *
 * No browser and no localhost address: the engine runs on a pipe and the window is a small native program around the
 * system's own web view (see scripts/desktop-launcher.mjs and docs/PLATFORMS.md). Node built-ins only.
 *
 *   1. build the backend into dist/ (scripts/build-backend.mjs)
 *   2. Linux: build native/target/neuroclaw-window with rustc if it is missing or older than its sources
 *      (macOS has NeuroClaw.app as its window; Windows has no native window yet, see docs/PLATFORMS.md)
 *   3. run the desktop launcher from this source tree, with no browser fallback
 *
 * Closing the window stops the engine. Pass `--rebuild` to force the window program to be rebuilt.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAwait } from './spawn-utils.mjs';
import { buildWindowHost, hostFileName } from './build-window-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rebuild = process.argv.includes('--rebuild');

function newestMtime(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return t;
}

console.log('[app] building the backend...');
const built = await spawnAwait(process.execPath, ['scripts/build-backend.mjs'], { cwd: ROOT });
if (built !== 0) { console.error(`[app] backend build failed (exit ${built})`); process.exit(built); }

if (process.platform === 'linux') {
  const exe = path.join(ROOT, 'native', 'target', hostFileName());
  const stale = !existsSync(exe) || statSync(exe).mtimeMs < Math.max(newestMtime(path.join(ROOT, 'native', 'host')), statSync(path.join(ROOT, 'native', 'lib.rs')).mtimeMs);
  if (rebuild || stale) {
    console.log('[app] building the window program (rustc)...');
    try { buildWindowHost(); } catch (e) { console.error(`[app] ${e.message}`); process.exit(1); }
  }
}

const code = await spawnAwait(process.execPath, ['scripts/desktop-launcher.mjs'], {
  cwd: ROOT,
  // Run from the source tree. (Windows has no native window yet, so there the launcher still uses Edge/Chrome's app window.)
  env: { ...process.env, NEUROCLAW_APP_HOME: ROOT, NEUROCLAW_AUTO_UPDATE: '0' },
});
process.exit(code);
