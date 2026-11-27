/**
 * Small text helpers the workbench shares: frontmatter, globs, argument splitting, secret redaction.
 * Written here, from scratch, so nothing in the workbench needs a parsing or matching library.
 */

// ── Frontmatter ──────────────────────────────────────────────────────

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

/**
 * Parse the small subset of YAML that agent and command files use: `key: value`, `key: [a, b]`, and
 * a `key:` line followed by `- item` lines. Anything fancier is ignored rather than guessed at.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: src };
  const head = src.slice(4, end).split('\n');
  const rest = src.slice(end + 4);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of head) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1].trim())); continue; }
    const kv = /^([A-Za-z][\w-]{0,40}):\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const [, key, value] = kv;
    const v = value.trim();
    if (v === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    if (v.startsWith('[') && v.endsWith(']')) {
      data[key] = v.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    } else data[key] = unquote(v);
  }
  return { data, body };
}

function unquote(s: string): string {
  return s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) ? s.slice(1, -1) : s;
}

export const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map(s => s.trim()).filter(Boolean);

// ── Globs ────────────────────────────────────────────────────────────

type Tok = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'any' } | { t: 'dirs' };

const TOK_CACHE = new Map<string, Tok[][]>();
const TOK_CACHE_MAX = 500;
const MAX_ALTERNATIVES = 64;

/** Expand `{a,b}` choices (not nested) into every plain pattern, up to a cap. */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const out: string[] = [];
  for (const alt of m[1].split(',')) {
    for (const rest of expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length))) {
      out.push(rest);
      if (out.length >= MAX_ALTERNATIVES) return out;
    }
  }
  return out;
}

function tokenize(pattern: string, mode: 'path' | 'plain'): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (mode === 'path' && pattern[i + 1] === '/') { i++; toks.push({ t: 'dirs' }); } else toks.push({ t: 'any' });
      } else toks.push(mode === 'path' ? { t: 'star' } : { t: 'any' });
    } else if (c === '?') toks.push({ t: 'one' });
    else toks.push({ t: 'lit', c });
  }
  return toks;
}

/**
 * Glob match, `path` mode: `*` stays inside one path segment, `**` crosses them, `**` + `/` also matches no folder at all.
 * Plain mode (commands, domains): `*` matches anything. `?` is one character; `{a,b}` is a choice.
 *
 * Done with a table walk, one pass per pattern piece over the text, so the time is (pattern length x text length) however
 * many stars there are. A pattern from a config file or a repository cannot make a permission check stall.
 */
export function globMatch(glob: string, text: string, mode: 'path' | 'plain' = 'plain'): boolean {
  const key = `${mode}:${glob}`;
  let alts = TOK_CACHE.get(key);
  if (!alts) {
    alts = expandBraces(glob).map(p => tokenize(p, mode));
    if (TOK_CACHE.size >= TOK_CACHE_MAX) TOK_CACHE.delete(TOK_CACHE.keys().next().value as string);
    TOK_CACHE.set(key, alts);
  }
  return alts.some(toks => matchTokens(toks, text, mode));
}

function matchTokens(toks: Tok[], text: string, mode: 'path' | 'plain'): boolean {
  const n = text.length;
  let cur = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const tok of toks) {
    const next = new Uint8Array(n + 1);
    switch (tok.t) {
      case 'lit': for (let i = 0; i < n; i++) if (cur[i] && text[i] === tok.c) next[i + 1] = 1; break;
      case 'one': for (let i = 0; i < n; i++) if (cur[i] && (mode === 'plain' || text[i] !== '/')) next[i + 1] = 1; break;
      case 'any': { let run = 0; for (let i = 0; i <= n; i++) { if (cur[i]) run = 1; next[i] = run; } break; }
      case 'star': { let run = 0; for (let i = 0; i <= n; i++) { if (cur[i]) run = 1; next[i] = run; if (i < n && text[i] === '/') run = 0; } break; }
      case 'dirs': { let run = 0; for (let i = 0; i <= n; i++) { if (cur[i]) { run = 1; next[i] = 1; } if (i < n && run && text[i] === '/') next[i + 1] = 1; } break; }
    }
    cur = next;
  }
  return cur[n] === 1;
}

// ── Arguments ────────────────────────────────────────────────────────

/** Split `a "b c" d` into words, honouring single and double quotes and backslash escapes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < input.length) { cur += input[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

// ── Secrets ──────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[^]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{16,}\b/g, '[secret removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [secret removed]'],
  [/\b(password|passwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1$2[secret removed]'],
];

/** Replace anything that looks like a credential. Used before text is shared, remembered or logged. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export const looksSecret = (text: string): boolean => redactSecrets(text) !== text;

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** A name safe to use as a file name and an id. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
