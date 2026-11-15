/**
 * Optimize prompt: tidy what the person typed before it reaches the AI.
 *
 * This is the "optimize my prompt" switch. It is a clean-up, not a rewrite: it only takes things OUT (filler at
 * the start, a word typed twice, a sentence or line repeated straight after itself, runs of spaces and blank
 * lines, "???"), so it can never change what was asked and never adds a fact, a guess or a style of its own.
 * Fenced code, indented code and anything else that is not plain prose is left exactly as it was.
 *
 * It does not call a model. A rewrite by the AI itself would cost a full answer's worth of compute before the
 * real answer starts, and could drift from what was meant; if that is wanted later it belongs in front of
 * this, with the original always kept beside it. Whatever this returns says what it changed, so the page can
 * show the original and the change, and the person can see the difference.
 *
 * Pure function, no I/O.
 */

/** A prompt longer than this is passed through untouched: the clean-up is for ordinary messages, not documents. */
export const OPTIMIZE_MAX_CHARS = 20_000;

export interface OptimizedPrompt {
  /** What to send. Equals the original when nothing needed changing. */
  text: string;
  original: string;
  changed: boolean;
  /** One short line per kind of change, for the details panel. */
  changes: string[];
  /** How many characters shorter it is. */
  savedChars: number;
}

/** Words that may legitimately appear twice in a row ("that that", "had had"), or are emphasis ("no no no"). */
const REPEAT_OK = new Set(['had', 'that', 'is', 'do', 'can', 'will', 'no', 'very', 'so', 'bye', 'ha', 'hey', 'yes', 'really']);

const OPENER = /^(?:(?:hey|hi|hello|yo|ok(?:ay)?|um+|uh+|er+|so|well|basically|like|just|alright)[,.!:]*\s+)+/i;

/** A fence line is three backticks (or tildes) at the start of a line, with up to three spaces before. */
const FENCE = /^ {0,3}(```|~~~)/;

const words = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;

/** Split into segments that are either fenced code (kept) or prose (cleaned). An unclosed fence runs to the end. */
function segments(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let inCode = false;
  let mark = '';
  const flush = (code: boolean): void => { if (buf.length) out.push({ code, text: buf.join('\n') }); buf = []; };
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (!inCode && f) { flush(false); inCode = true; mark = f[1]; buf.push(line); continue; }
    if (inCode) {
      buf.push(line);
      if (line.trimStart().startsWith(mark)) { flush(true); inCode = false; }
      continue;
    }
    buf.push(line);
  }
  flush(inCode);
  return out;
}

export function optimizePrompt(prompt: unknown): OptimizedPrompt {
  const original = typeof prompt === 'string' ? prompt : '';
  const unchanged: OptimizedPrompt = { text: original, original, changed: false, changes: [], savedChars: 0 };
  if (original.trim() === '' || original.length > OPTIMIZE_MAX_CHARS) return unchanged;

  const changes = new Set<string>();
  const segs = segments(original.replace(/\r\n/g, '\n'));
  let firstProse = true;

  const cleaned = segs.map(seg => {
    if (seg.code) return seg.text;
    let previousLine: string | null = null;
    const lines = seg.text.split('\n').map(line => {
      // Indented code and other pre-formatted lines are not prose: leave them alone.
      if (/^(?: {4,}|\t)\S/.test(line)) { previousLine = null; return line; }
      let s = line;
      const trimmed = s.replace(/[ \t]+$/, '');
      if (trimmed !== s) { s = trimmed; changes.add('removed trailing spaces'); }
      const lead = /^[ \t]*/.exec(s)![0];
      const rest = s.slice(lead.length);
      const squeezed = rest.replace(/[ \t]{2,}/g, ' ');
      if (squeezed !== rest) { s = lead + squeezed; changes.add('collapsed repeated spaces'); }

      if (firstProse && s.trim() !== '') {
        firstProse = false;
        const m = OPENER.exec(s.trimStart());
        if (m) {
          const remaining = s.trimStart().slice(m[0].length);
          // Only when a real request is left: "hello" alone, or "so what" are not touched.
          if (words(remaining) >= 3) {
            changes.add(`removed filler opening "${m[0].trim()}"`);
            s = lead + remaining;
          }
        }
      }

      const noStutter = s.replace(/\b([A-Za-z][A-Za-z']+)(?:\s+\1\b)+/gi, (whole, w: string) => (REPEAT_OK.has(w.toLowerCase()) ? whole : w));
      if (noStutter !== s) { s = noStutter; changes.add('removed a word typed twice'); }

      const noBang = s.replace(/([!?])\1{1,}/g, '$1');
      if (noBang !== s) { s = noBang; changes.add('shortened repeated ! and ?'); }

      // A sentence repeated straight after itself, on one line.
      const parts = s.split(/(?<=[.!?])\s+/);
      if (parts.length > 1) {
        const kept: string[] = [];
        for (const p of parts) {
          if (kept.length && p.trim().toLowerCase() === kept[kept.length - 1].trim().toLowerCase() && words(p) >= 2) { changes.add('removed a repeated sentence'); continue; }
          kept.push(p);
        }
        if (kept.length !== parts.length) s = lead + kept.join(' ').trimStart();
      }

      // A whole line repeated straight after itself.
      if (s.trim() !== '' && previousLine !== null && s.trim().toLowerCase() === previousLine.trim().toLowerCase() && words(s) >= 2) {
        changes.add('removed a repeated line');
        return null;
      }
      previousLine = s.trim() === '' ? null : s;
      return s;
    }).filter((l): l is string => l !== null);
    return lines.join('\n');
  });

  let text = cleaned.join('\n');
  const fewerBlank = text.replace(/\n{3,}/g, '\n\n');
  if (fewerBlank !== text) { text = fewerBlank; changes.add('collapsed extra blank lines'); }
  const trimmed = text.replace(/^\s+|\s+$/g, '');
  if (trimmed !== text) { text = trimmed; if (trimmed.length !== original.trim().length) changes.add('trimmed the ends'); }

  // Never hand back something empty, longer, or with less to say than what was typed.
  if (text === '' || words(text) < Math.min(2, words(original))) return unchanged;
  if (text === original || text === original.trim()) return unchanged;
  return { text, original, changed: true, changes: Array.from(changes), savedChars: original.length - text.length };
}
