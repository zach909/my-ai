#!/usr/bin/env node
/**
 * build-window-host.mjs -- compile (and test) the window program in native/host/.
 * Node built-ins only; the compiler is `rustc` (the language's own toolchain). There is deliberately no
 * Cargo.toml: this repo takes no crates, and the no-third-party check rejects Cargo manifests.
 *
 *   node scripts/build-window-host.mjs --test            run the unit tests (any OS)
 *   node scripts/build-window-host.mjs                   build native/target/neuroclaw-window[.exe]
 *   node scripts/build-window-host.mjs --out <dir>       build into <dir> instead (what packaging does)
 *
 * The program shows the system's own web view (WebKitGTK on Linux, found at run time and not bundled). macOS does
 * not use it: NeuroClaw.app is its own window. Windows has none yet (see docs/PLATFORMS.md).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'native', 'host', 'main.rs');

export function hostFileName(platform = process.platform) {
  return platform === 'win32' ? 'neuroclaw-window.exe' : 'neuroclaw-window';
}

function rustc(args) {
  const r = spawnSync('rustc', ['--edition', '2021', SRC, ...args], { stdio: 'inherit' });
  if (r.error) throw new Error(`could not run rustc (${r.error.message}). Install the Rust toolchain from rust-lang.org; it is the only thing needed to build the window program.`);
  if (r.status !== 0) throw new Error(`rustc failed with exit code ${r.status}`);
}

/** Build the window program into `outDir`; returns the path of the executable. */
export function buildWindowHost(outDir = path.join(ROOT, 'native', 'target')) {
  if (process.platform !== 'linux') throw new Error('the window program is for Linux only: macOS has its own window (NeuroClaw.app) and Windows is not covered yet');
  mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, hostFileName());
  rustc(['-O', '-o', exe]);
  return exe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    if (a.includes('--test')) {
      const out = path.join(ROOT, 'native', 'target');
      mkdirSync(out, { recursive: true });
      const t = path.join(out, process.platform === 'win32' ? 'host-tests.exe' : 'host-tests');
      rustc(['--test', '-o', t]);
      const r = spawnSync(t, { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    const i = a.indexOf('--out');
    console.log(buildWindowHost(i >= 0 ? path.resolve(a[i + 1]) : undefined));
  } catch (e) { console.error(`window program build failed: ${e.message}`); process.exit(1); }
}
