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
 * This is the light sibling of the visual panels in `interface/visuals.ts`. A panel is code in a sandbox; a
 * prompt button is plain text with no code in it at all, so there is nothing to sandbox: the page builds each
 * button with createElement/textContent (never innerHTML), and the click does the one thing a typed message
 * does. Nothing is fetched and nothing runs.
 *
 * What reaches the mesh stays small: the doorway keeps 160 characters of each prompting skill
 * (models && skills/llm.js), so the framing below is one short sentence.
 */

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
  const re = /\[\[ask:([^\]|\r\n]*)(?:\|([^\]]*))?\]\]/gi;
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const label = m[1].trim();
    const prompt = (m[2] === undefined ? label : m[2]).trim();
    if (count >= 12 || !label || !prompt || label.length > 60 || prompt.length > 500) continue;
    if (m.index > last) parts.push({ kind: 'text', text: s.slice(last, m.index) });
    parts.push({ kind: 'button', text: label, prompt });
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
  description: 'Put clickable prompts anywhere in a reply: [[ask: Label | prompt to send]]. A click sends that prompt to you. Use as many as help.',
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

  /** Fill el with the prose and buttons in text. A click calls send(prompt). Returns how many buttons were drawn. */
  function render(el, text, send) {
    var parts = split(text), n = 0;
    el.textContent = '';
    parts.forEach(function (p) {
      if (p.kind === 'text') { el.appendChild(document.createTextNode(p.text)); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'nc-ask';
      b.textContent = p.text;
      b.title = p.prompt;
      b.setAttribute('aria-label', p.text === p.prompt ? p.text : p.text + ': ' + p.prompt);
      b.onclick = function () { send(p.prompt); };
      el.appendChild(b);
      n++;
    });
    return n;
  }

  return { has: has, render: render };
})();
`;
