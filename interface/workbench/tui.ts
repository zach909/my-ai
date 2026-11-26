/**
 * The terminal interface: keyboard-driven, modal, in the project's own colours (soft coral on dark, green and pink for
 * added and removed, no blue). The state change and the drawing are pure functions (`reduce`, `render`), so everything
 * except the thin loop at the bottom can be tested with no terminal.
 *
 *   insert mode   type; Enter sends; `!cmd` runs a shell command (through the permission rules); `@` completes a file name
 *                 by fuzzy match; Tab completes or cycles the agent mode; pasting an image path attaches the image; Esc leaves
 *   normal mode   j/k or arrows scroll, g/G top/bottom, Ctrl-D/U half page, i/a insert, `:` command, `/` search, u undo, Ctrl-R redo, q quit
 *   command mode  :agent NAME  :undo  :redo  :rewind ID [code|conversation|both]  :fork  :sessions  :share  :diff ID  :quit
 *
 * Code blocks are highlighted by `highlight` (a small pattern-based colouriser for JS/TS, Python, JSON and shell); diff blocks
 * show `+` lines in green and `-` lines in pink.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execLimited } from './hooks.js';
import { renderDiff } from './diff.js';
import type { Workbench } from './workbench.js';

// ── Colours (24-bit; the project's palette) ──
const RESET = '\x1b[0m', DIM = '\x1b[2m', BOLD = '\x1b[1m';
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
export const COLOR = { coral: fg(227, 169, 157), soft: fg(239, 208, 200), deep: fg(201, 132, 118), green: fg(143, 227, 168), pink: fg(255, 154, 168), text: fg(248, 237, 233), dim: `${fg(248, 237, 233)}${DIM}` };
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// ── Highlighting ──
const KEYWORDS: Record<string, RegExp> = {
  js: /\b(?:const|let|var|function|return|if|else|for|while|class|extends|import|from|export|default|new|await|async|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|interface|type|enum|implements|public|private|readonly|null|undefined|true|false|this|of|in)\b/g,
  py: /\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|pass|break|continue|None|True|False|and|or|not|in|is|async|await|global|nonlocal)\b/g,
  sh: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|echo|cd|export|local|return|exit)\b/g,
  json: /\b(?:true|false|null)\b/g,
};
const LANG: Record<string, keyof typeof KEYWORDS> = { js: 'js', javascript: 'js', ts: 'js', typescript: 'js', tsx: 'js', jsx: 'js', mjs: 'js', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', json: 'json' };

/** Colour one line of code. Strings, comments, numbers and keywords; anything else is left alone. */
export function highlight(line: string, lang: string): string {
  const L = LANG[lang.toLowerCase()];
  if (!L) return line;
  const comment = L === 'py' || L === 'sh' ? /#.*$/ : L === 'json' ? null : /\/\/.*$|\/\*.*?\*\//;
  const re = new RegExp(`(${comment ? `${comment.source}|` : ''}"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\b\\d+(?:\\.\\d+)?\\b|${KEYWORDS[L].source})`, 'g');
  return line.replace(re, (m) => {
    if (m[0] === '"' || m[0] === "'" || m[0] === '`') return `${COLOR.green}${m}${RESET}`;
    if ((comment && comment.test(m) && /^(?:\/\/|\/\*|#)/.test(m))) return `${COLOR.dim}${m}${RESET}`;
    if (/^\d/.test(m)) return `${COLOR.soft}${m}${RESET}`;
    return `${COLOR.coral}${m}${RESET}`;
  });
}

// ── Fuzzy ──
/** Subsequence match score: higher is better, -1 when the letters do not appear in order. Prefers consecutive and word-start hits. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase(), c = candidate.toLowerCase();
  if (!q) return 0;
  let score = 0, ci = 0, last = -2;
  for (const ch of q) {
    const i = c.indexOf(ch, ci);
    if (i === -1) return -1;
    score += i === last + 1 ? 5 : 1;
    if (i === 0 || '/_-.'.includes(c[i - 1])) score += 3;
    last = i; ci = i + 1;
  }
  return score - candidate.length * 0.01;
}
export const fuzzyRank = (query: string, items: string[], n = 6): string[] =>
  items.map(f => ({ f, s: fuzzyScore(query, f) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.f);

/** Project files for completion: bounded, no dependency or build folders. */
export function listFiles(root: string, max = 5000): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.neuroclaw', 'build', '__pycache__']);
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= max) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      if (skip.has(n) || out.length >= max) continue;
      const full = path.join(dir, n);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1); else if (st.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root, 0);
  return out;
}

// ── Keys ──
export interface Key { name: string; ch?: string; ctrl?: boolean; text?: string }

export function parseKeys(buf: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (buf.startsWith('\x1b[200~', i)) {
      const end = buf.indexOf('\x1b[201~', i);
      keys.push({ name: 'paste', text: buf.slice(i + 6, end === -1 ? undefined : end) });
      if (end === -1) break;
      i = end + 5; continue;
    }
    if (c === '\x1b') {
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(buf.slice(i));
      if (m) {
        const map: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
        keys.push({ name: map[m[2]] ?? (m[2] === '~' ? ({ '3': 'delete', '5': 'pageup', '6': 'pagedown' } as Record<string, string>)[m[1]] ?? 'unknown' : 'unknown') });
        i += m[0].length - 1;
      } else keys.push({ name: 'escape' });
      continue;
    }
    if (c === '\r' || c === '\n') keys.push({ name: 'enter' });
    else if (c === '\t') keys.push({ name: 'tab' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (c.charCodeAt(0) < 32) keys.push({ name: String.fromCharCode(c.charCodeAt(0) + 96), ctrl: true });
    else keys.push({ name: 'char', ch: c });
  }
  return keys;
}

// ── State ──
export interface Line { kind: 'user' | 'assistant' | 'system' | 'diff' | 'error'; text: string }
export interface TuiState {
  mode: 'insert' | 'normal' | 'command';
  input: string;
  cmd: string;
  lines: Line[];
  scroll: number;               // lines scrolled up from the bottom
  agent: string;
  agents: string[];
  session: string;
  status: string;
  engine: string;
  suggestions: string[];
  files: string[];
  attachments: string[];
  busy: boolean;
  pending: { text: string } | null;   // an approval waiting for y or n
  search: string;
  width: number;
  height: number;
}

export type Effect =
  | { type: 'send'; text: string; attachments: string[] }
  | { type: 'shell'; cmd: string }
  | { type: 'command'; name: string; args: string[] }
  | { type: 'approve'; yes: boolean }
  | { type: 'attach'; path: string }
  | { type: 'quit' };

export const initialState = (o: Partial<TuiState> = {}): TuiState => ({
  mode: 'insert', input: '', cmd: '', lines: [], scroll: 0, agent: 'build', agents: ['build', 'plan', 'general', 'explore'], session: '', status: '', engine: 'auto',
  suggestions: [], files: [], attachments: [], busy: false, pending: null, search: '', width: 80, height: 24, ...o,
});

const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const atToken = (s: string): string | null => { const m = /(?:^|\s)@(\S*)$/.exec(s); return m ? m[1] : null; };

export function reduce(s: TuiState, k: Key): { state: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  let n: TuiState = { ...s };
  const page = Math.max(1, s.height - 4);
  const maxScroll = Math.max(0, wrapAll(s.lines, s.width).length - 1);
  if (k.ctrl && k.name === 'c') { effects.push({ type: 'quit' }); return { state: n, effects }; }

  if (s.pending) {
    if (k.name === 'char' && (k.ch === 'y' || k.ch === 'n')) { effects.push({ type: 'approve', yes: k.ch === 'y' }); n.pending = null; }
    return { state: n, effects };
  }

  if (s.mode === 'insert') {
    if (k.name === 'escape') { n.mode = 'normal'; n.suggestions = []; }
    else if (k.name === 'enter') {
      if (n.suggestions.length) { n = complete(n); }
      else if (n.input.trim() && !s.busy) {
        const text = n.input.trim();
        if (text.startsWith('!')) effects.push({ type: 'shell', cmd: text.slice(1).trim() });
        else effects.push({ type: 'send', text, attachments: n.attachments });
        n.input = ''; n.attachments = []; n.suggestions = []; n.scroll = 0;
      }
    } else if (k.name === 'tab') {
      if (n.suggestions.length) n = complete(n);
      else { const i = n.agents.indexOf(n.agent); n.agent = n.agents[(i + 1) % n.agents.length]; n.status = `Agent: ${n.agent}`; }
    } else if (k.name === 'backspace') { n.input = n.input.slice(0, -1); n = suggest(n); }
    else if (k.ctrl && k.name === 'u') { n.input = ''; n.suggestions = []; }
    else if (k.name === 'paste' && k.text !== undefined) {
      const t = k.text.trim().replace(/^'(.*)'$/, '$1');
      if (IMAGE.test(t) && !t.includes('\n')) effects.push({ type: 'attach', path: t });
      else n.input += k.text.replace(/\r/g, '');
      n = suggest(n);
    } else if (k.name === 'char' && k.ch) { n.input += k.ch; n = suggest(n); }
    else if (k.name === 'up') n.scroll = Math.min(maxScroll, n.scroll + 1);
    else if (k.name === 'down') n.scroll = Math.max(0, n.scroll - 1);
    return { state: n, effects };
  }

  if (s.mode === 'command') {
    if (k.name === 'escape') { n.mode = 'normal'; n.cmd = ''; }
    else if (k.name === 'backspace') { if (n.cmd) n.cmd = n.cmd.slice(0, -1); else n.mode = 'normal'; }
    else if (k.name === 'enter') {
      const text = n.cmd.trim(); n.cmd = ''; n.mode = 'normal';
      if (text.startsWith('/')) { n.search = text.slice(1); n = findNext(n, 1); }
      else if (text) { const [name, ...args] = text.split(/\s+/); effects.push(name === 'q' || name === 'quit' ? { type: 'quit' } : { type: 'command', name, args }); }
    } else if (k.name === 'char' && k.ch) n.cmd += k.ch;
    return { state: n, effects };
  }

  // normal
  if (k.name === 'char') {
    switch (k.ch) {
      case 'i': case 'a': n.mode = 'insert'; break;
      case ':': n.mode = 'command'; n.cmd = ''; break;
      case '/': n.mode = 'command'; n.cmd = '/'; break;
      case 'j': n.scroll = Math.max(0, n.scroll - 1); break;
      case 'k': n.scroll = Math.min(maxScroll, n.scroll + 1); break;
      case 'g': n.scroll = maxScroll; break;
      case 'G': n.scroll = 0; break;
      case 'n': n = findNext(n, 1); break;
      case 'N': n = findNext(n, -1); break;
      case 'u': effects.push({ type: 'command', name: 'undo', args: [] }); break;
      case 'q': effects.push({ type: 'quit' }); break;
    }
  } else if (k.name === 'down') n.scroll = Math.max(0, n.scroll - 1);
  else if (k.name === 'up') n.scroll = Math.min(maxScroll, n.scroll + 1);
  else if (k.name === 'enter') n.mode = 'insert';
  else if (k.name === 'pagedown' || (k.ctrl && k.name === 'd')) n.scroll = Math.max(0, n.scroll - Math.floor(page / 2));
  else if (k.name === 'pageup' || (k.ctrl && k.name === 'u')) n.scroll = Math.min(maxScroll, n.scroll + Math.floor(page / 2));
  else if (k.ctrl && k.name === 'r') effects.push({ type: 'command', name: 'redo', args: [] });
  return { state: n, effects };
}

function suggest(s: TuiState): TuiState {
  const t = atToken(s.input);
  return { ...s, suggestions: t === null ? [] : fuzzyRank(t, s.files) };
}
function complete(s: TuiState): TuiState {
  const pick = s.suggestions[0];
  return { ...s, input: s.input.replace(/@\S*$/, `@${pick} `), suggestions: [] };
}
function findNext(s: TuiState, dir: 1 | -1): TuiState {
  if (!s.search) return s;
  const all = wrapAll(s.lines, s.width).map(l => stripAnsi(l).toLowerCase());
  const total = all.length, here = total - 1 - s.scroll;
  for (let step = 1; step <= total; step++) {
    const i = (here - dir * step + total * 2) % total;
    if (all[i].includes(s.search.toLowerCase())) return { ...s, scroll: Math.max(0, total - 1 - i), status: `/${s.search}` };
  }
  return { ...s, status: `Not found: ${s.search}` };
}

// ── Drawing ──
/** Break plain text (no colour codes) into pieces of at most `width` characters. Never loops on a bad width. */
function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width) || 80);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length <= w) { out.push(raw); continue; }
    // Break at the last space inside the width when there is one, else hard-cut.
    let rest = raw;
    while (rest.length > w) {
      const sp = rest.lastIndexOf(' ', w);
      const cut = sp > w / 2 ? sp : w;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    out.push(rest);
  }
  return out;
}

export function renderLine(l: Line, width: number): string[] {
  const w = Math.max(20, Math.floor(width) || 80);
  const label = l.kind === 'user' ? `${COLOR.coral}${BOLD}you${RESET}` : l.kind === 'assistant' ? `${COLOR.green}${BOLD}agent${RESET}` : l.kind === 'error' ? `${COLOR.pink}${BOLD}error${RESET}` : `${COLOR.dim}·${RESET}`;
  const out: string[] = [label];
  let fence: string | null = null;
  for (const raw of l.text.split('\n')) {
    const f = /^```(\w*)/.exec(raw);
    if (f) { fence = fence === null ? (f[1] || 'text') : null; out.push(`${COLOR.dim}${raw.slice(0, w)}${RESET}`); continue; }
    const diffy = l.kind === 'diff' || fence === 'diff';
    if (diffy) {
      const shown = raw.slice(0, w);
      out.push(raw.startsWith('+') ? `${COLOR.green}${shown}${RESET}` : raw.startsWith('-') ? `${COLOR.pink}${shown}${RESET}` : `${COLOR.dim}${shown}${RESET}`);
    } else if (fence) out.push(highlight(raw.slice(0, w), fence));   // code is cut at the edge, not wrapped, so its layout stays readable
    else for (const piece of wrapText(raw, w)) out.push(l.kind === 'error' ? `${COLOR.pink}${piece}${RESET}` : l.kind === 'system' ? `${COLOR.dim}${piece}${RESET}` : piece);
  }
  out.push('');
  return out;
}

const wrapAll = (lines: Line[], width: number): string[] => lines.flatMap(l => renderLine(l, width));

export function render(s: TuiState): string {
  const w = Math.max(20, s.width || 80), h = Math.max(6, s.height || 24);
  const header = `${COLOR.coral}${BOLD} NeuroClaw ${RESET}${COLOR.dim} agent ${RESET}${COLOR.soft}${s.agent}${RESET}${COLOR.dim}  engine ${s.engine}${s.session ? `  session ${s.session}` : ''}${RESET}`;
  const body = wrapAll(s.lines, w);
  const room = h - 3 - (s.suggestions.length ? Math.min(s.suggestions.length, 4) : 0);
  const end = Math.max(0, body.length - s.scroll);
  const view = body.slice(Math.max(0, end - room), end);
  while (view.length < room) view.unshift('');
  const badge = s.pending ? `${COLOR.pink}${BOLD} APPROVE? y/n ${RESET}` : s.busy ? `${COLOR.deep}${BOLD} WORKING ${RESET}` : s.mode === 'insert' ? `${COLOR.green}${BOLD} INSERT ${RESET}` : s.mode === 'command' ? `${COLOR.pink}${BOLD} COMMAND ${RESET}` : `${COLOR.coral}${BOLD} NORMAL ${RESET}`;
  const prompt = s.pending ? `${COLOR.pink}${s.pending.text}${RESET}` : s.mode === 'command' ? `:${s.cmd}` : s.mode === 'insert' ? `${COLOR.coral}›${RESET} ${s.input}${s.attachments.length ? `  ${COLOR.dim}[${s.attachments.length} image${s.attachments.length > 1 ? 's' : ''}]${RESET}` : ''}` : `${COLOR.dim}i insert  : command  / search  u undo  q quit${RESET}`;
  const sug = s.suggestions.slice(0, 4).map(f => `${COLOR.dim}  @${f}${RESET}`);
  const foot = `${badge} ${COLOR.dim}${s.status}${RESET}`;
  return [header, ...view, ...sug, foot, prompt].join('\n');
}

// ── The loop ──
export interface TuiIO { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }

/** Run the interface until the user quits. Returns the exit code. */
export async function runTui(wb: Workbench, io: TuiIO, hooks: { approveRef: { fn: ((req: { tool: string; target?: string }, why: string) => Promise<boolean>) | null } }): Promise<number> {
  if (!io.stdin.isTTY) { io.stdout.write('The terminal interface needs a terminal. Use `neuroclaw run` in scripts.\n'); return 1; }
  let state = initialState({ width: io.stdout.columns || 80, height: io.stdout.rows || 24, agents: wb.agents().filter(a => a.mode !== 'subagent').map(a => a.name), files: listFiles(wb.root) });
  let resolveApproval: ((yes: boolean) => void) | null = null;
  hooks.approveRef.fn = (req, why) => new Promise<boolean>(res => { resolveApproval = res; state = { ...state, pending: { text: `${req.tool}${req.target ? ` ${req.target.slice(0, 60)}` : ''} — ${why.slice(0, 60)}` } }; draw(); });
  const draw = () => io.stdout.write(`\x1b[H\x1b[2J${render(state)}`);
  const add = (kind: Line['kind'], text: string) => { state = { ...state, lines: [...state.lines, { kind, text }], scroll: 0 }; };
  io.stdout.write('\x1b[?1049h\x1b[?2004h');
  io.stdin.setRawMode(true); io.stdin.resume(); io.stdin.setEncoding('utf8');
  draw();
  return new Promise<number>(resolve => {
    const finish = (code: number) => { io.stdin.off('data', onData); io.stdout.off('resize', onResize); io.stdin.setRawMode(false); io.stdin.pause(); io.stdout.write('\x1b[?2004l\x1b[?1049l'); wb.close(); resolve(code); };
    const onResize = () => { state = { ...state, width: io.stdout.columns || 80, height: io.stdout.rows || 24 }; draw(); };
    const run = async (e: Effect): Promise<void> => {
      if (e.type === 'quit') return finish(0);
      if (e.type === 'approve') { resolveApproval?.(e.yes); resolveApproval = null; return; }
      if (e.type === 'attach') { state = { ...state, attachments: [...state.attachments, e.path], status: `Attached ${path.basename(e.path)}` }; return; }
      if (e.type === 'send') {
        add('user', e.text); state = { ...state, busy: true }; draw();
        const r = await wb.turn({ prompt: e.text, agent: state.agent, session: state.session || undefined });
        state = { ...state, session: r.session, engine: r.route.engine, busy: false };
        add(r.ok ? 'assistant' : 'error', r.text);
        r.warnings.forEach(x => add('system', x));
        if (r.checkpoint) { const d = wb.checkpoints.diff(r.checkpoint); if (d) add('diff', d); }
        return;
      }
      if (e.type === 'shell') {
        add('user', `!${e.cmd}`); state = { ...state, busy: true }; draw();
        const o = await wb.runTool({ tool: 'bash', target: e.cmd, session: state.session }, async () => { const [f, a] = process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', e.cmd]] : ['/bin/sh', ['-c', e.cmd]]; const r = await execLimited(f, a, { cwd: wb.root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeoutMs: 60_000 }); return `${r.stdout}${r.stderr}`.trimEnd() || `(exit ${r.code})`; });
        state = { ...state, busy: false };
        add(o.ok ? 'assistant' : 'error', o.ok ? String(o.value) : o.error ?? 'Refused');
        return;
      }
      const [a0, a1] = e.args;
      switch (e.name) {
        case 'agent': if (wb.agents().some(a => a.name === a0)) state = { ...state, agent: a0, status: `Agent: ${a0}` }; else add('error', `No agent "${a0}". Agents: ${wb.agents().map(a => a.name).join(', ')}`); break;
        case 'undo': { const r = wb.checkpoints.undo(); add(r.ok ? 'system' : 'error', r.ok ? `Undid ${r.files.join(', ') || 'nothing'}` : r.reason ?? ''); break; }
        case 'redo': { const r = wb.checkpoints.redo(); add(r.ok ? 'system' : 'error', r.ok ? `Redid ${r.files.join(', ')}` : r.reason ?? ''); break; }
        case 'rewind': { const r = wb.rewind(a0 ?? '', (['code', 'conversation', 'both'].includes(a1) ? a1 : 'code') as 'code', state.session || undefined); add(r.ok ? 'system' : 'error', r.ok ? `Rewound. ${r.files.join(', ')}` : r.reason ?? ''); break; }
        case 'fork': { const h = state.session ? wb.sessions.fork(state.session) : null; if (h) { state = { ...state, session: h.id }; add('system', `Forked into ${h.id}`); } else add('error', 'No session to fork yet.'); break; }
        case 'sessions': add('system', wb.sessions.list().slice(0, 12).map(x => `${x.id} ${x.title}`).join('\n') || 'No sessions.'); break;
        case 'share': { const r = state.session ? wb.sessions.share(state.session) : { ok: false, reason: 'No session yet.' }; add(r.ok ? 'system' : 'error', r.ok ? `Read-only link: ${(r as { path: string }).path}` : (r as { reason: string }).reason); break; }
        case 'diff': add('diff', wb.checkpoints.diff(a0 ?? wb.checkpoints.list().slice(-1)[0]?.id ?? '') || 'No changes recorded.'); break;
        default: add('error', `Unknown command :${e.name}`);
      }
    };
    const onData = (chunk: string) => {
      void (async () => {
        for (const key of parseKeys(chunk)) {
          const r = reduce(state, key);
          state = r.state;
          for (const e of r.effects) { try { await run(e); } catch (err) { add('error', (err as Error).message); state = { ...state, busy: false }; } }
        }
        draw();
      })();
    };
    io.stdin.on('data', onData); io.stdout.on('resize', onResize);
  });
}
void existsSync; void readFileSync; void renderDiff;
