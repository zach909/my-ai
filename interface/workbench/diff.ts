/** A small line diff (longest common subsequence) for inline previews, checkpoints and shared transcripts. */

export interface DiffLine { kind: ' ' | '+' | '-'; text: string }

const MAX_LINES = 2500;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // Too big for the quadratic table: trim the shared head and tail and show the rest as one replacement.
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const mid = (x: string[], k: '+' | '-'): DiffLine[] => x.slice(s, x.length - e).slice(0, 400).map(text => ({ kind: k, text }));
    return [...mid(a, '-'), ...mid(b, '+')];
  }
  const n = a.length, m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ kind: '-', text: a[i++] });
    else out.push({ kind: '+', text: b[j++] });
  }
  while (i < n) out.push({ kind: '-', text: a[i++] });
  while (j < m) out.push({ kind: '+', text: b[j++] });
  return out;
}

/** The changed lines with `context` unchanged lines around each change, as plain text. */
export function renderDiff(before: string, after: string, context = 2): string {
  const d = diffLines(before, after);
  const keep = new Array<boolean>(d.length).fill(false);
  d.forEach((l, i) => { if (l.kind !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true; });
  const out: string[] = [];
  let gap = false;
  d.forEach((l, i) => {
    if (!keep[i]) { gap = true; return; }
    if (gap && out.length) out.push('…');
    gap = false;
    out.push(`${l.kind}${l.text}`);
  });
  return out.join('\n');
}

export const diffStats = (before: string, after: string): { added: number; removed: number } => {
  const d = diffLines(before, after);
  return { added: d.filter(l => l.kind === '+').length, removed: d.filter(l => l.kind === '-').length };
};
