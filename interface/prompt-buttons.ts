/**
 * Prompt buttons: the AI puts a button in its reply, a click sends a prompt back to the AI.
 *
 * A reply can carry any number of these, anywhere in its prose, in the middle of a sentence or on a line of
 * their own:
 *
 *     Want more? [[ask: Show an example | Show me a worked example of that]] or [[ask: Start over]]
 *
 * `[[ask: Label | prompt]]` draws a pill button that says Label; clicking it sends `prompt` as the next turn,
 * exactly as if it had been typed. `[[ask: Label]]` (no bar) sends the label itself.
 *
 * `[[put: Label | prompt | desktop]]` (or `menu`) is the same button for somewhere outside the chat: the app
 * menu or the desktop of this computer. In the chat it is drawn as a button that offers to put it there. Nothing
 * is written until the owner has seen the exact file and approved it (models && skills/core/os-buttons.ts); the
 * AI can propose a place but never take one. Once placed, a click opens NeuroClaw at /ask/<id>, which sends the
 * prompt and shows the answer.
 *
 * This is the light sibling of the visual panels in `interface/visuals.ts`. A panel is code in a sandbox; a
 * prompt button is plain text with no code in it at all, so there is nothing to sandbox: the page builds each
 * button with createElement/textContent (never innerHTML), and the click does the one thing a typed message
 * does. Nothing is fetched and nothing runs.
 *
 * What reaches the mesh stays small: the doorway keeps 160 characters of each prompting skill
 * (models && skills/llm.js), so the framing below is one short sentence.
 */

import { VISUAL_CLIENT_JS } from './visuals.js';

/** Buttons past this many in one message stay as plain text. */
export const PROMPT_BUTTON_MAX_PER_MESSAGE = 12;
/** The most characters a label may have. */
export const PROMPT_BUTTON_LABEL_MAX = 60;
/** The most characters a prompt may have. */
export const PROMPT_BUTTON_PROMPT_MAX = 500;

export interface ButtonPart {
  kind: 'text' | 'button';
  /** The prose, for text; the label, for a button. */
  text: string;
  /** What a click sends. Only on a button. */
  prompt?: string;
  /** Only on a `[[put: ...]]` button: where on the computer it is offered. */
  put?: 'menu' | 'desktop';
}

/**
 * Cut a message into its prose and its prompt buttons, in order.
 *
 * Written once and shared: the chat page runs this exact function (its source is serialised into
 * PROMPT_BUTTON_CLIENT_JS), so the server and the page can never disagree about what counts as a button. For
 * that reason it must stay self-contained: no outside names, literals only. Prose is kept exactly as written
 * (spaces around a button matter, so nothing is trimmed). A marker that is empty, too long, or past the limit is
 * left where it is, as text.
 */
export function splitPromptButtons(text: string): ButtonPart[] {
  const s = String(text == null ? '' : text);
  const parts: ButtonPart[] = [];
  const re = /\[\[(ask|put):([^\]]*)\]\]/gi;
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const isPut = m[1].toLowerCase() === 'put';
    const bits = m[2].split('|');
    if (/[\r\n]/.test(bits[0])) continue;
    const label = bits[0].trim();
    let prompt: string;
    let place: 'menu' | 'desktop' = 'menu';
    if (isPut) {
      prompt = (bits.length > 1 ? bits[1] : bits[0]).trim();
      const w = (bits.length > 2 ? bits[2] : 'menu').trim().toLowerCase();
      if (w !== 'menu' && w !== 'desktop') continue;
      place = w;
    } else {
      prompt = (bits.length > 1 ? bits.slice(1).join('|') : bits[0]).trim();
    }
    if (count >= 12 || !label || !prompt || label.length > 60 || prompt.length > 500) continue;
    if (m.index > last) parts.push({ kind: 'text', text: s.slice(last, m.index) });
    const part: ButtonPart = { kind: 'button', text: label, prompt };
    if (isPut) part.put = place;
    parts.push(part);
    last = m.index + m[0].length;
    count++;
  }
  if (last < s.length) parts.push({ kind: 'text', text: s.slice(last) });
  return parts;
}

/**
 * The framing handed to generation as a prompting skill, so it travels beside the prompt through the Zip Loop
 * instead of being pasted into it. The doorway keeps 160 characters of title plus description.
 */
export const PROMPT_BUTTON_SKILL = {
  name: 'prompt-buttons',
  title: 'Offer buttons',
  description: '[[ask: Label | prompt]] is a button that sends you that prompt. [[put: Label | prompt | desktop]] offers it on their desktop (or menu).',
};

/** The skills to hand `generate()` for a chat request: the framing when the page asked for buttons, none otherwise. */
export function promptButtonSkillsFor(body: { buttons?: unknown } | null | undefined): Array<{ name: string; title: string; description: string }> {
  return body && body.buttons === true ? [PROMPT_BUTTON_SKILL] : [];
}

/** Styles for the buttons. Same tokens as the rest of the page (see AGENTS.md, VISUAL STYLE): clear glass, coral on hover, fully round. */
export const PROMPT_BUTTON_CSS = `
  .nc-ask { font: inherit; font-size: 0.92em; color: var(--primary-light, #ffc4b4); background: rgba(255, 154, 132, 0.16);
    border: 1px solid rgba(255, 154, 132, 0.5); border-radius: 999px; padding: 4px 14px; margin: 2px 3px; cursor: pointer;
    vertical-align: baseline; transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s, opacity 0.2s; }
  .nc-ask:hover { background: rgba(255, 154, 132, 0.28); transform: translateY(-2px) scale(1.03); }
  .nc-ask:active { transform: scale(0.95); }
  .nc-ask:focus-visible { outline: 2px solid rgba(255, 196, 180, 0.8); outline-offset: 2px; }
  [aria-busy="true"] .nc-ask { opacity: 0.55; pointer-events: none; }
  .nc-ask.nc-put { background: rgba(255, 238, 230, 0.07); border-color: var(--border, rgba(255, 228, 218, 0.2)); color: inherit; }
  .nc-ask.nc-put:hover { background: rgba(255, 154, 132, 0.28); }
  .nc-ask .nc-where { opacity: 0.62; font-size: 0.85em; }
  @media (prefers-reduced-motion: reduce) { .nc-ask { transition: none; } }
`;

/**
 * The page side: turns a message's text into prose and buttons. One global, `ncButtons`. Plain browser
 * JavaScript, no outside code; each button is made with createElement and its words set with textContent, so a
 * label or prompt can never become markup.
 */
export const PROMPT_BUTTON_CLIENT_JS = `
var ncButtons = (function () {
  var split = (${splitPromptButtons.toString()});

  /** True when the text has at least one button in it. */
  function has(text) {
    return split(text).some(function (p) { return p.kind === 'button'; });
  }

  function call(method, url, body) {
    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }

  /**
   * Offer to put a button on this computer, in two steps that are both the person's: review exactly what would
   * be written, then approve it. Nothing is written until the second click, and Cancel leaves nothing behind.
   */
  function offer(label, prompt, where) {
    var old = document.getElementById('nc-app-card');
    if (old) old.remove();
    var card = document.createElement('div');
    card.id = 'nc-app-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Put a button on this computer');
    var anchor = document.getElementById('input-area');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor); else document.body.appendChild(card);
    var saved = null;
    function row(tag, text, cls) { var e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; card.appendChild(e); return e; }
    function btn(text, fn, primary) { var b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (primary) b.className = 'primary'; b.onclick = fn; return b; }
    function actions() { var a = document.createElement('div'); a.className = 'nc-bench-actions'; card.appendChild(a); return a; }
    function close(forget) {
      if (forget && saved) call('DELETE', '/api/os-buttons/' + saved.id).catch(function () { /* nothing was placed */ });
      card.remove();
    }
    function review(j) {
      card.textContent = '';
      row('strong', saved.label);
      row('p', 'Sends: ' + saved.prompt, 'nc-dim');
      if (j.unavailable) {
        row('p', j.unavailable);
        var u = actions();
        u.appendChild(btn('Remove', function () { close(true); }));
        u.appendChild(btn('Keep it here', function () { close(false); }, true));
        return;
      }
      row('p', 'Approving writes one file on this computer, at:');
      row('code', j.plan.path, 'nc-card-path');
      row('p', 'with this content:', 'nc-dim');
      row('pre', j.plan.content, 'nc-card-pre');
      row('p', 'It opens ' + j.plan.url + ', which sends the prompt above, and does nothing else. You can remove it here at any time.', 'nc-dim');
      var msg = row('p', '', 'nc-card-msg');
      var a = actions();
      a.appendChild(btn('Cancel', function () { close(true); }));
      a.appendChild(btn('Approve and place', function () {
        call('POST', '/api/os-buttons/' + saved.id + '/place', { where: where, approval: j.approval })
          .then(function () {
            card.textContent = '';
            row('strong', saved.label + ' is on your ' + (where === 'desktop' ? 'desktop' : 'app menu'));
            var done = actions();
            done.appendChild(btn('Remove it', function () { call('DELETE', '/api/os-buttons/' + saved.id).then(function () { close(false); }).catch(function (e) { row('p', e.message, 'nc-card-msg'); }); }));
            done.appendChild(btn('Done', function () { close(false); }, true));
          })
          .catch(function (e) { msg.textContent = e.message; });
      }, true));
    }
    row('strong', 'Put "' + label + '" on your ' + (where === 'desktop' ? 'desktop' : 'app menu') + '?');
    var wait = row('p', 'Checking what that would write...', 'nc-dim');
    call('POST', '/api/os-buttons', { label: label, prompt: prompt })
      .then(function (j) { saved = j.button; return call('POST', '/api/os-buttons/' + saved.id + '/preview', { where: where }); })
      .then(review)
      .catch(function (e) { wait.textContent = e.message; wait.className = 'nc-card-msg'; var a = actions(); a.appendChild(btn('Close', function () { close(false); })); });
  }

  /**
   * Fill el with the prose and buttons in text. A click on an ask button calls send(prompt); a click on a put
   * button offers to place it on this computer. Returns how many buttons were drawn.
   */
  function render(el, text, send) {
    var parts = split(text), n = 0;
    el.textContent = '';
    parts.forEach(function (p) {
      if (p.kind === 'text') { el.appendChild(document.createTextNode(p.text)); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'nc-ask';
      b.title = p.prompt;
      if (p.put) {
        var where = p.put === 'desktop' ? 'desktop' : 'app menu';
        b.className = 'nc-ask nc-put';
        b.textContent = p.text + ' ';
        var tag = document.createElement('span');
        tag.className = 'nc-where';
        tag.textContent = '+ ' + where;
        b.appendChild(tag);
        b.setAttribute('aria-label', 'Put ' + p.text + ' on your ' + where);
        b.onclick = function () { offer(p.text, p.prompt, p.put); };
      } else {
        b.textContent = p.text;
        b.setAttribute('aria-label', p.text === p.prompt ? p.text : p.text + ': ' + p.prompt);
        b.onclick = function () { send(p.prompt); };
      }
      el.appendChild(b);
      n++;
    });
    return n;
  }

  return { has: has, render: render, offer: offer };
})();
`;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The page a placed button opens: /ask/<id>. It sends the button's prompt and shows the answer, and the answer
 * can carry more buttons. `auto` is true only when the browser says the person navigated here themselves
 * (Sec-Fetch-Site: none, which is what a launcher does); a page that merely embedded or linked to this address
 * waits for a click instead, so no other site can make the AI act by pointing at it.
 */
export function askPage(button: { id: string; label: string; prompt: string }, auto: boolean): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(button.label)}</title>
<style>
  :root { --primary: #ff9a84; --primary-light: #ffc4b4; --bg-dark: #110c0e; --border: rgba(255, 228, 218, 0.2); --text: #f8ede9; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg-dark); color: var(--text);
    font-family: ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { position: relative; z-index: 1; max-width: 760px; margin: 0 auto; padding: 28px 20px; }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 6px; }
  #sent { opacity: 0.62; font-size: 13px; margin: 0 0 18px; overflow-wrap: anywhere; }
  #say { min-height: 1.4em; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
  #say.bad { color: #ff9aa8; }
${PROMPT_BUTTON_CSS}
</style></head><body>
<main><h1>${escapeHtml(button.label)}</h1><p id="sent"></p><div id="say" role="status" aria-live="polite"></div></main>
<script>${VISUAL_CLIENT_JS}</script>
<script>${PROMPT_BUTTON_CLIENT_JS}</script>
<script>
(function () {
  var NL = String.fromCharCode(10);
  var say = document.getElementById('say'), sent = document.getElementById('sent');
  var history = [], busy = false;
  function show(text) {
    var prose = ncVisuals.split(text).filter(function (p) { return p.kind === 'text'; }).map(function (p) { return p.text; }).join(NL);
    ncButtons.render(say, prose || text, ask);
  }
  function ask(message) {
    if (busy) return;
    busy = true;
    sent.textContent = 'Sent: ' + message;
    say.className = ''; say.setAttribute('aria-busy', 'true'); say.textContent = 'Thinking...';
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, buttons: true, history: history }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.response) throw new Error(j.error || 'No answer.');
        history.push({ role: 'user', content: message }, { role: 'assistant', content: j.response });
        say.removeAttribute('aria-busy');
        show(j.response);
      })
      .catch(function (e) { say.removeAttribute('aria-busy'); say.className = 'bad'; say.textContent = e.message; })
      .then(function () { busy = false; });
  }
  var prompt = ${embed(button.prompt)};
  sent.textContent = 'Will send: ' + prompt;
  if (${auto ? 'true' : 'false'}) { ask(prompt); return; }
  var go = document.createElement('button');
  go.type = 'button'; go.className = 'nc-ask'; go.textContent = 'Send this prompt';
  go.onclick = function () { go.remove(); ask(prompt); };
  say.appendChild(go);
})();
</script></body></html>`;
}
