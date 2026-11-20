/**
 * Sources: the AI backs up what it says with a link, and the link opens on the part that proves it.
 *
 * A reply can carry any number of these, anywhere in its prose:
 *
 *     Water boils at 100 C at sea level. [[source: Boiling point | https://example.org/boiling | boils at 100 degrees Celsius]]
 *     [[source: The cat | https://example.org/cat.jpg | the cat on the sofa | 0.2,0.3,0.4,0.35]]
 *
 * `[[source: Title | address | passage]]` is a link chip. With "Open sources at the passage" on (Settings >
 * Sources) the chip opens /source, which shows the page as plain text with the passage highlighted and scrolled
 * into view, the way Ctrl+F does in a browser. With it off, the chip is an ordinary link to the address.
 *
 * A fourth part, `x,y,w,h` (each 0 to 1, as a fraction of the picture, from its top left), marks the part of an
 * image that matters. /source then shows only that part and drops the rest, with a button to see the whole picture.
 * The AI names the box; nothing here looks at the picture's pixels or decodes it, the browser crops it.
 *
 * Safety. The viewer never shows the other site's own markup, scripts or styles: it fetches the page on the
 * server (through the same private-address block the browser plugin uses), keeps only the words, escapes them,
 * and wraps the passage in <mark>. Chips are built with createElement/textContent, never innerHTML. Only http and
 * https addresses are accepted; anything else stays as text. Local files are not offered yet (see the note on
 * `parseSourceQuery`).
 */

/** Chips past this many in one message stay as plain text. */
export const SOURCE_MAX_PER_MESSAGE = 12;
export const SOURCE_TITLE_MAX = 90;
export const SOURCE_URL_MAX = 2000;
export const SOURCE_QUOTE_MAX = 400;
/** The viewer reads at most this much of a page, in characters, after the markup is removed. */
export const SOURCE_PAGE_TEXT_MAX = 400_000;

export interface SourcePart {
  kind: 'text' | 'source';
  /** The prose, for text; the title, for a source. */
  text: string;
  /** http(s) address. Only on a source. */
  url?: string;
  /** The passage that supports the claim. Only on a source, and may be empty. */
  quote?: string;
  /** [x, y, w, h] as fractions of an image. Only on a source. */
  box?: [number, number, number, number];
}

/**
 * Cut a message into its prose and its source chips, in order.
 *
 * Shared like splitPromptButtons: the chat page runs this exact function (its source is serialised into
 * SOURCE_CLIENT_JS), so it must stay self-contained, literals only. A marker with no title, an address that is
 * not http(s), or one past the limit is left in place, as text. A box that is not four fractions inside the
 * picture is dropped and the chip is kept.
 */
export function splitSources(text: string): SourcePart[] {
  const s = String(text == null ? '' : text);
  const parts: SourcePart[] = [];
  const re = /\[\[source:([^\]]*)\]\]/gi;
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const bits = m[1].split('|');
    if (bits.length < 2 || /[\r\n]/.test(bits[0])) continue;
    const title = bits[0].trim();
    const url = bits[1].trim();
    if (count >= 12 || !title || title.length > 90) continue;
    if (url.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(url)) continue;
    let rest = bits.slice(2);
    let box: [number, number, number, number] | undefined;
    if (rest.length) {
      const bm = rest[rest.length - 1].trim().match(/^(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)$/);
      if (bm) {
        rest = rest.slice(0, -1);
        const n = [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])];
        if (n[0] >= 0 && n[1] >= 0 && n[2] > 0 && n[3] > 0 && n[0] + n[2] <= 1.0001 && n[1] + n[3] <= 1.0001) {
          box = [n[0], n[1], Math.min(n[2], 1 - n[0]), Math.min(n[3], 1 - n[1])];
        }
      }
    }
    const quote = rest.join('|').trim().replace(/\s+/g, ' ').slice(0, 400);
    if (m.index > last) parts.push({ kind: 'text', text: s.slice(last, m.index) });
    const part: SourcePart = { kind: 'source', text: title, url, quote };
    if (box) part.box = box;
    parts.push(part);
    last = m.index + m[0].length;
    count++;
  }
  if (last < s.length) parts.push({ kind: 'text', text: s.slice(last) });
  return parts;
}

/**
 * The framing handed to generation as a prompting skill. The doorway keeps 160 characters of title plus
 * description (models && skills/llm.js), so this stays one short sentence.
 */
export const SOURCE_SKILL = {
  name: 'sources',
  title: 'Cite sources',
  description: 'Back claims with [[source: Title | https://address | exact words from the page]]. For a picture add | x,y,w,h (0 to 1) around what matters.',
};

/** The skills to hand `generate()` for a chat request: the framing when the page asked for sources, none otherwise. */
export function sourceSkillsFor(body: { sources?: unknown } | null | undefined): Array<{ name: string; title: string; description: string }> {
  return body && body.sources === true ? [SOURCE_SKILL] : [];
}

/** Chip styles. Same tokens as the rest of the page (AGENTS.md, VISUAL STYLE): clear glass, coral, fully round. */
export const SOURCE_CSS = `
  .nc-src { display: inline-block; font-size: 0.85em; color: var(--primary-light, #efd0c8); background: rgba(255,238,230, 0.07);
    border: 1px solid var(--border, rgba(255,228,218,0.2)); border-radius: 999px; padding: 2px 12px; margin: 2px 3px; text-decoration: none;
    vertical-align: baseline; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s; }
  .nc-src:hover { background: rgba(227,169,157, 0.28); transform: translateY(-2px) scale(1.03); }
  .nc-src:active { transform: scale(0.95); }
  .nc-src:focus-visible { outline: 2px solid rgba(239,208,200, 0.8); outline-offset: 2px; }
  .nc-src-off { opacity: 0.7; font-style: italic; }
  @media (prefers-reduced-motion: reduce) { .nc-src { transition: none; } }
`;

/**
 * The page side: one global, `ncSources`. `mode` is 'focus' (open the viewer at the passage), 'link' (plain link to
 * the address) or 'off' (show the title as plain words). `renderText(el, str)` fills the prose between chips so
 * the prompt buttons can still be drawn there.
 */
export const SOURCE_CLIENT_JS = `
var ncSources = (function () {
  var split = (${splitSources.toString()});

  function has(text) {
    return split(text).some(function (p) { return p.kind === 'source'; });
  }

  /** The /source address for a chip. Built from encodeURIComponent only. */
  function viewerHref(p) {
    var q = '/source?u=' + encodeURIComponent(p.url) + '&t=' + encodeURIComponent(p.text);
    if (p.quote) q += '&q=' + encodeURIComponent(p.quote);
    if (p.box) q += '&box=' + p.box.map(function (n) { return String(Math.round(n * 10000) / 10000); }).join(',');
    return q;
  }

  function render(el, text, mode, renderText) {
    var parts = split(text), n = 0;
    el.textContent = '';
    parts.forEach(function (p) {
      if (p.kind === 'text') {
        var span = document.createElement('span');
        if (renderText) renderText(span, p.text); else span.textContent = p.text;
        el.appendChild(span);
        return;
      }
      n++;
      if (mode === 'off') {
        var t = document.createElement('span');
        t.className = 'nc-src nc-src-off';
        t.textContent = p.text;
        el.appendChild(t);
        return;
      }
      var a = document.createElement('a');
      a.className = 'nc-src';
      a.href = mode === 'focus' ? viewerHref(p) : p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = p.text;
      a.title = (p.quote ? '"' + p.quote + '" - ' : '') + p.url;
      a.setAttribute('aria-label', 'Source: ' + p.text + (p.box ? ' (part of an image)' : p.quote ? ' (opens at the passage)' : ''));
      el.appendChild(a);
    });
    return n;
  }

  return { has: has, render: render, viewerHref: viewerHref };
})();
`;

// ---------------------------------------------------------------------------------------------------------------
// The viewer (server side)
// ---------------------------------------------------------------------------------------------------------------

export interface SourceQuery {
  url: string;
  title: string;
  quote: string;
  box: [number, number, number, number] | null;
}

/**
 * Read /source's query. Returns null for anything that is not a plain http(s) address.
 *
 * Only web addresses are accepted. A local file would have to pass the computer-access switches
 * (models && skills/core/access-manager.ts) and that is a decision for the owner, so it is not offered yet.
 */
export function parseSourceQuery(params: URLSearchParams): SourceQuery | null {
  const url = (params.get('u') ?? '').trim();
  if (!url || url.length > SOURCE_URL_MAX || !/^https?:\/\/[^\s]+$/i.test(url)) return null;
  try { new URL(url); } catch { return null; }
  const title = (params.get('t') ?? '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_TITLE_MAX) || url;
  const quote = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_QUOTE_MAX);
  let box: SourceQuery['box'] = null;
  const b = params.get('box');
  if (b) {
    const n = b.split(',').map(Number);
    if (n.length === 4 && n.every((v) => Number.isFinite(v)) && n[0] >= 0 && n[1] >= 0 && n[2] > 0 && n[3] > 0 && n[0] + n[2] <= 1.0001 && n[1] + n[3] <= 1.0001) {
      box = [n[0], n[1], Math.min(n[2], 1 - n[0]), Math.min(n[3], 1 - n[1])];
    }
  }
  return { url, title, quote, box };
}

/** True when the address looks like a picture by its file name. */
export function looksLikeImage(url: string): boolean {
  try { return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(new URL(url).pathname); } catch { return false; }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/**
 * The words of a page: markup, scripts, styles and comments removed, block elements turned into line breaks,
 * entities decoded. What is left is plain text and is only ever shown escaped.
 */
export function extractPageText(html: string): string {
  let s = String(html ?? '');
  if (!/<[a-z!/]/i.test(s)) return s.replace(/\r/g, '').slice(0, SOURCE_PAGE_TEXT_MAX); // plain text already
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|li|ul|ol|tr|table|h[1-6]|br|hr|blockquote|pre|figure|figcaption|dd|dt|dl)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ''); // inline tags join the words around them: <b>here</b>. stays "here."
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, SOURCE_PAGE_TEXT_MAX);
}

interface Word { norm: string; start: number; end: number }

const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function wordsOf(s: string): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const norm = normWord(m[0]);
    if (!norm) continue;
    // The highlight starts and ends on letters and digits, so a full stop or bracket next to the passage is not painted.
    const core = m[0].match(/[\p{L}\p{N}][\s\S]*[\p{L}\p{N}]|[\p{L}\p{N}]/u);
    const at = core ? (core.index ?? 0) : 0;
    out.push({ norm, start: m.index + at, end: m.index + at + (core ? core[0].length : m[0].length) });
  }
  return out;
}

/**
 * Find the passage in the page text, the way Ctrl+F would, but forgiving: case, punctuation, curly quotes and
 * line breaks do not matter. First tries the whole passage as an exact run of words; if the page words it
 * differently, takes the stretch of text that shares the most of the passage's words (at least 60%, and at least
 * two words). Returns character offsets into `text`, or null when it is not there. Never guesses wildly: a passage
 * that is not on the page is reported as not found.
 */
export function findPassage(text: string, quote: string): { start: number; end: number; exact: boolean } | null {
  const q = wordsOf(quote);
  if (!q.length) return null;
  const t = wordsOf(text);
  if (t.length < 1) return null;
  const n = q.length;
  // 1. exact run of words
  outer: for (let i = 0; i + n <= t.length; i++) {
    for (let j = 0; j < n; j++) if (t[i + j].norm !== q[j].norm) continue outer;
    return { start: t[i].start, end: t[i + n - 1].end, exact: true };
  }
  // 2. best-overlapping window of the same length
  if (n < 2) return null;
  const need = new Map<string, number>();
  for (const w of q) need.set(w.norm, (need.get(w.norm) ?? 0) + 1);
  const have = new Map<string, number>();
  let hits = 0;
  const add = (w: string, d: 1 | -1): void => {
    const want = need.get(w) ?? 0;
    if (!want) return;
    const cur = have.get(w) ?? 0;
    if (d === 1) { if (cur < want) hits++; have.set(w, cur + 1); }
    else { if (cur <= want) hits--; have.set(w, cur - 1); }
  };
  let best = -1;
  let bestAt = -1;
  const size = Math.min(n, t.length);
  for (let i = 0; i < t.length; i++) {
    add(t[i].norm, 1);
    if (i >= size) add(t[i - size].norm, -1);
    if (i >= size - 1 && hits > best) { best = hits; bestAt = i - size + 1; }
  }
  if (bestAt < 0 || best < 2 || best / n < 0.6) return null;
  // Trim the window to the first and last word that is actually part of the passage.
  let a = bestAt;
  let b = bestAt + size - 1;
  while (a < b && !need.has(t[a].norm)) a++;
  while (b > a && !need.has(t[b].norm)) b--;
  return { start: t[a].start, end: t[b].end, exact: false };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const VIEWER_CSS = `
  :root { color-scheme: dark; --primary: #e3a99d; --primary-light: #efd0c8; --border: rgba(255,228,218,0.2); --text: #f8ede9; --dim: rgba(248,237,233,.62); }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { min-height: 100vh; background: #110c0e; color: var(--text); overflow-x: hidden;
    font-family: ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { position: relative; z-index: 1; max-width: 820px; margin: 0 auto; padding: 20px 16px 96px; display: grid; gap: 14px; }
  header { padding: 18px 22px; border-radius: 32px; background: rgba(255,240,232,.07); border: 1px solid var(--border);
    backdrop-filter: blur(26px) saturate(1.5); -webkit-backdrop-filter: blur(26px) saturate(1.5); }
  h1 { font-size: 18px; margin: 0 0 4px; overflow-wrap: anywhere; }
  .addr { font-size: 13px; color: var(--dim); overflow-wrap: anywhere; margin: 0 0 10px; }
  .note { font-size: 14px; margin: 0 0 10px; line-height: 1.5; }
  .note.bad { color: #ff9aa8; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { font: inherit; font-size: 14px; min-height: 40px; padding: 8px 18px; border-radius: 999px; color: inherit; cursor: pointer; text-decoration: none;
    background: rgba(255,238,230,.07); border: 1px solid var(--border); display: inline-flex; align-items: center;
    transition: transform .2s cubic-bezier(.34,1.56,.64,1), background .2s; }
  .btn.primary { color: var(--primary-light); background: rgba(227,169,157,.16); border-color: rgba(227,169,157,.5); }
  .btn:hover { background: rgba(227,169,157,.28); transform: translateY(-2px) scale(1.03); }
  .btn:active { transform: scale(.95); }
  .btn:focus-visible { outline: 2px solid #e3a99d; outline-offset: 2px; }
  article { padding: 22px; border-radius: 32px; background: rgba(255,240,232,.07); border: 1px solid var(--border); line-height: 1.7; font-size: 15px;
    white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  mark { background: rgba(227,169,157,.38); color: #fff4ef; border-radius: 6px; padding: 1px 3px; box-shadow: 0 0 0 2px rgba(227,169,157,.45); }
  mark.pulse { animation: nc-pulse 1.4s ease-out 1; }
  @keyframes nc-pulse { 0% { box-shadow: 0 0 0 0 rgba(239,208,200,.9); } 100% { box-shadow: 0 0 0 14px rgba(239,208,200,0); } }
  .stage { padding: 14px; border-radius: 32px; background: rgba(255,240,232,.07); border: 1px solid var(--border); display: grid; place-items: center; min-width: 0; }
  canvas, .stage img { max-width: 100%; height: auto; border-radius: 22px; display: block; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { mark.pulse { animation: none; } .btn { transition: none; } }
`;

function shell(title: string, body: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${VIEWER_CSS}</style></head><body class="nc-soft">
<main>${body}</main>${script ? `\n<script>${script}</script>` : ''}</body></html>`;
}

function headerHtml(q: SourceQuery, note: string, bad: boolean, extra = ''): string {
  return `<header><h1>${escapeHtml(q.title)}</h1><p class="addr">${escapeHtml(q.url)}</p>`
    + `<p class="note${bad ? ' bad' : ''}" role="status">${escapeHtml(note)}</p>`
    + `<div class="actions">${extra}<a class="btn" href="${escapeHtml(q.url)}" target="_blank" rel="noopener noreferrer">Open the original</a>`
    + `<a class="btn" href="/">Back to chat</a></div></header>`;
}

/** The page for a web page source: its words, the passage highlighted, scrolled into view. `text` is already extracted. */
export function sourceTextPage(q: SourceQuery, text: string): string {
  const hit = q.quote ? findPassage(text, q.quote) : null;
  let note: string;
  let bad = false;
  let article: string;
  if (hit) {
    article = `<article id="doc">${escapeHtml(text.slice(0, hit.start))}<mark id="hit" class="pulse">${escapeHtml(text.slice(hit.start, hit.end))}</mark>${escapeHtml(text.slice(hit.end))}</article>`;
    note = hit.exact ? 'The passage is highlighted below.' : 'The page words this a little differently. The closest passage is highlighted below.';
  } else {
    article = `<article id="doc">${escapeHtml(text)}</article>`;
    bad = !!q.quote;
    note = q.quote ? 'That passage was not found on the page, so nothing is highlighted. The page may have changed, or may load its text with a script.' : 'No passage was given for this source.';
  }
  note += ' This is the page as plain text, without its own layout, pictures or scripts.';
  const jump = hit ? '<button class="btn primary" type="button" id="again">Jump to passage</button>' : '';
  const script = hit ? `(function(){var m=document.getElementById('hit'),b=document.getElementById('again');function go(){m.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}if(b)b.addEventListener('click',go);go();})();` : '';
  return shell(q.title, headerHtml(q, note, bad, jump) + article, script);
}

/** The page when the source could not be read at all. */
export function sourceErrorPage(q: SourceQuery | null, message: string): string {
  const fake: SourceQuery = q ?? { url: '', title: 'Source', quote: '', box: null };
  const head = q
    ? headerHtml(fake, message, true)
    : `<header><h1>Source</h1><p class="note bad" role="status">${escapeHtml(message)}</p><div class="actions"><a class="btn" href="/">Back to chat</a></div></header>`;
  return shell(fake.title, head);
}

/**
 * The page for a picture source. With a box it shows only that part, drawn by the browser's own canvas from the
 * picture the browser loads itself; a button shows the whole picture. The page needs img-src for other sites, so
 * the server sends a CSP for this page that allows exactly that (see IMAGE_SOURCE_CSP).
 */
export function sourceImagePage(q: SourceQuery): string {
  const note = q.box
    ? 'Showing only the part of the picture that matters. The rest is left out.'
    : 'No part of the picture was marked, so the whole picture is shown.';
  const toggle = q.box ? '<button class="btn primary" type="button" id="whole">Show the whole picture</button>' : '';
  const body = headerHtml(q, note, false, toggle)
    + `<div class="stage"><canvas id="crop" role="img" aria-label="${escapeHtml(q.title)}" hidden></canvas><img id="full" alt="${escapeHtml(q.title)}" referrerpolicy="no-referrer" hidden><p class="note" id="msg" role="status">Loading the picture...</p></div>`;
  const script = `(function(){
var url=${embed(q.url)},box=${embed(q.box)};
var cv=document.getElementById('crop'),full=document.getElementById('full'),msg=document.getElementById('msg'),btn=document.getElementById('whole');
var img=new Image();img.referrerPolicy='no-referrer';
var showingWhole=false;
function paint(){
  if(showingWhole||!box){cv.hidden=true;full.hidden=false;return;}
  var W=img.naturalWidth,H=img.naturalHeight,pad=0.03;
  var x=Math.max(0,box[0]-pad),y=Math.max(0,box[1]-pad),w=Math.min(1-x,box[2]+2*pad),h=Math.min(1-y,box[3]+2*pad);
  var sx=Math.round(x*W),sy=Math.round(y*H),sw=Math.max(1,Math.round(w*W)),sh=Math.max(1,Math.round(h*H));
  var scale=Math.min(1,1400/sw);cv.width=Math.max(1,Math.round(sw*scale));cv.height=Math.max(1,Math.round(sh*scale));
  cv.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,cv.width,cv.height);
  full.hidden=true;cv.hidden=false;
}
img.onload=function(){full.src=url;msg.hidden=true;paint();};
img.onerror=function(){msg.textContent='The picture could not be loaded from that address.';msg.className='note bad';if(btn)btn.hidden=true;};
if(btn)btn.addEventListener('click',function(){showingWhole=!showingWhole;btn.textContent=showingWhole?'Show only the part that matters':'Show the whole picture';paint();});
img.src=url;
})();`;
  return shell(q.title, body, script);
}

/** CSP for the picture page: the same as every other page, plus pictures from other sites. */
export const IMAGE_SOURCE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data:;";
