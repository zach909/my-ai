/**
 * Static measurement of a code tree, for the modifiability, organization and repo-hygiene dimensions.
 *
 * It reads source files and counts what matters for changing them safely:
 *   - import cycles (A imports B imports A): a change to one file can ripple round the loop
 *   - fan-out (how many local files one file imports): a file that depends on many others is fragile to change
 *   - file size: large files usually mix several jobs
 *   - third-party imports: anything outside Node built-ins and this repo (must be zero)
 *
 * Honest limits: imports are found with a regular expression, not a parser. It handles `import ... from`,
 * `export ... from`, `import('...')` and `require('...')`, and ignores comments only roughly. Good enough to
 * rank and track change over time; not a proof. The thresholds below are choices, written here so they can be
 * argued with, and they are reported alongside the numbers.
 *
 * Node built-ins only. No third-party code (AGENTS.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

export const THRESHOLDS = Object.freeze({
  maxLinesPerFile: 800,
  maxFanOut: 12,
});

const SOURCE_EXT = ['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'generated', 'out', 'coverage', 'release-artifacts']);
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const IMPORT_RE = /(?:^|[\s;{])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

export function walkSources(root, { skip = SKIP_DIRS } = {}) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) visit(full);
      } else if (e.isFile() && SOURCE_EXT.includes(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort();
}

function resolveLocal(fromFile, spec, known) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...SOURCE_EXT.map((x) => base + x), ...SOURCE_EXT.map((x) => path.join(base, 'index' + x))];
  // Imports written with a .js suffix point at a .ts source in TypeScript projects.
  if (spec.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

/** Tarjan's strongly connected components, iterative so a deep graph cannot overflow the stack. */
export function findCycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  for (const start of graph.keys()) {
    if (idx.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = [...(graph.get(frame.v) ?? [])];
      if (frame.i < edges.length) {
        const w = edges[frame.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
        }
        if (low.get(frame.v) === idx.get(frame.v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          const selfLoop = comp.length === 1 && (graph.get(comp[0]) ?? new Set()).has(comp[0]);
          if (comp.length > 1 || selfLoop) cycles.push(comp);
        }
      }
    }
  }
  return cycles;
}

/**
 * @param {string} root  directory to measure
 * @returns {object} metrics and the three scores (modifiability, organization, repo_hygiene), each in [0,1]
 */
export function measureTree(root) {
  const absRoot = path.resolve(root);
  const files = walkSources(absRoot);
  const known = new Set(files);
  const graph = new Map();
  const thirdParty = [];
  const sizes = [];
  let totalLines = 0;

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n').length;
    totalLines += lines;
    sizes.push({ file: path.relative(absRoot, f), lines });
    const local = new Set();
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolveLocal(f, spec, known);
        if (target && target !== f) local.add(target);
      } else if (!BUILTIN.has(spec)) {
        thirdParty.push({ file: path.relative(absRoot, f), spec });
      }
    }
    graph.set(f, local);
  }

  const cycles = findCycles(graph);
  const inCycle = new Set(cycles.flat());
  const fanOut = [...graph.values()].map((s) => s.size);
  const overFanOut = files.filter((f) => graph.get(f).size > THRESHOLDS.maxFanOut).length;
  const overSize = sizes.filter((s) => s.lines > THRESHOLDS.maxLinesPerFile);
  const thirdPartyFiles = new Set(thirdParty.map((t) => t.file));
  const n = files.length || 1;

  const modifiability = 0.5 * (1 - inCycle.size / n) + 0.5 * (1 - overFanOut / n);
  const organization = 1 - overSize.length / n;
  const repoHygiene = 1 - thirdPartyFiles.size / n;

  return {
    root: absRoot,
    thresholds: THRESHOLDS,
    files: files.length,
    totalLines,
    cycles: cycles.map((c) => c.map((f) => path.relative(absRoot, f))),
    filesInCycles: inCycle.size,
    filesOverFanOut: overFanOut,
    meanFanOut: fanOut.reduce((s, x) => s + x, 0) / n,
    filesOverSize: overSize.length,
    largestFiles: sizes.sort((a, b) => b.lines - a.lines).slice(0, 10),
    thirdPartyImports: thirdParty.slice(0, 50),
    thirdPartyImportCount: thirdParty.length,
    scores: {
      modifiability: clamp01(modifiability),
      organization: clamp01(organization),
      repo_hygiene: clamp01(repoHygiene),
    },
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
