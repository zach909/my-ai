/**
 * Runs once before the whole vitest run.
 *
 * Some suites exercise the compiled backend: they import files from dist/ or run the
 * scripts that do (scripts/optimize-agent.mjs). dist/ is generated and never committed,
 * so on a fresh checkout a bare `npx vitest run` failed those suites with
 * ERR_MODULE_NOT_FOUND until someone remembered to build first (`npm test` does).
 * Build it here when it is missing. An existing dist/ is left alone: the build takes a
 * few seconds, and a developer who already built is not made to wait again.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(join(root, 'dist', 'interface', 'main.js'))) return;
  execFileSync(process.execPath, [join(root, 'scripts', 'build-backend.mjs')], { cwd: root, stdio: 'inherit' });
}
