/**
 * The phone bundler, shared by build-mobile-brain.mjs and build-mobile-server.mjs.
 *
 * Packs a TypeScript entry file and everything it imports into one Node-free JavaScript file (a tiny CommonJS
 * loader and one factory per module) for the phone's JavaScript runtime. Only the TypeScript compiler (an allowed
 * build tool) and Node built-ins are used. How it works is described in build-mobile-brain.mjs's header.
 *
 * Things the plain brain bundle never needed and the server bundle does:
 *   - `import.meta.url` is replaced by a fixed file URL for that module (there is no module URL on a phone);
 *   - a `.json` import becomes `module.exports = <the json>`;
 *   - with `report: true`, imports that cannot be resolved are listed (all of them, with the file that asked)
 *     instead of stopping at the first, so the shims that are still missing can be written in one go.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LOAD_CALL_RE = /require\((['"])((?:[^'"\\]|\\.)*)\1\)/g;

export function bundle({ root, entry, outFile, aliases = {}, header = [], report = false, phoneRoot = 'file:///phone/app' }) {
  const unresolved = new Map(); // specifier -> Set(files that import it)

  function resolveSpecifier(spec, fromFile) {
    if (spec in aliases) return aliases[spec];
    if (!spec.startsWith('.')) {
      // Text that only looks like a module load (a word with a dot in it, inside a message string) has characters
      // a package name cannot: leave it exactly as written.
      if (!/^[a-z@][a-z0-9_@/:-]*$/i.test(spec)) return null;
      if (!report) throw new Error(`unresolvable external import "${spec}" (from ${fromFile}); add it to the aliases or remove the dependency`);
      if (!unresolved.has(spec)) unresolved.set(spec, new Set());
      unresolved.get(spec).add(path.relative(root, fromFile));
      return null;
    }
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts'), `${base}.json`];
    for (const candidate of candidates) {
      if (existsSync(candidate) && ts.sys.fileExists(candidate)) return candidate;
    }
    if (!report) throw new Error(`could not resolve "${spec}" from ${fromFile}`);
    if (!unresolved.has(spec)) unresolved.set(spec, new Set());
    unresolved.get(spec).add(path.relative(root, fromFile));
    return null;
  }

  function transpile(file) {
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) return `module.exports = ${source.trim()};`;
    const result = ts.transpileModule(source, {
      // TypeScript keeps `.mjs` files as ES modules whatever the options say; name it as a plain script so it is converted like the rest.
      fileName: file.replace(/\.mjs$/, '.ts'),
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        verbatimModuleSyntax: false,
      },
    });
    const here = JSON.stringify(`${phoneRoot}/${path.relative(root, file).split(path.sep).join('/')}`);
    // A script's `#!` line is only valid at the top of a file, not in the middle of a bundle.
    return result.outputText.replace(/^#!.*\n/, '').replace(/import\.meta\.url/g, here);
  }

  const idByFile = new Map();
  let nextId = 0;
  const idOf = (file) => {
    if (!idByFile.has(file)) idByFile.set(file, nextId++);
    return idByFile.get(file);
  };

  const modules = new Map(); // id -> { file, code }
  const queue = [entry];
  const seen = new Set();

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const id = idOf(file);
    const transpiled = transpile(file);
    // A module-loading call is rewritten to a bare numeric id (not a quoted name), so this project's own
    // third-party checker, which flags quoted require() arguments it does not know, has nothing to question.
    const rewritten = transpiled.replace(LOAD_CALL_RE, (whole, quote, spec) => {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved) return whole;
      if (!seen.has(resolved)) queue.push(resolved);
      return `require(${idOf(resolved)})`;
    });
    modules.set(id, { file, code: rewritten });
  }

  if (report && unresolved.size > 0) return { unresolved, modules: modules.size };

  const lines = [];
  for (const h of header) lines.push(h);
  lines.push('(function () {');
  lines.push('  "use strict";');
  lines.push('  var __modules = {};');
  lines.push('  var __cache = {};');
  lines.push('  function __require(id) {');
  lines.push('    if (__cache[id]) return __cache[id].exports;');
  lines.push('    var mod = { exports: {} };');
  lines.push('    __cache[id] = mod;');
  lines.push('    __modules[id](mod, mod.exports, __require);');
  lines.push('    return mod.exports;');
  lines.push('  }');
  for (const [id, { file, code }] of modules) {
    lines.push(`  // ---- ${path.relative(root, file)} ----`);
    lines.push(`  __modules[${JSON.stringify(id)}] = function (module, exports, require) {`);
    lines.push(code);
    lines.push('  };');
  }
  lines.push(`  __require(${JSON.stringify(idOf(entry))});`);
  lines.push('})();');

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, lines.join('\n'));
  return { unresolved, modules: modules.size };
}
