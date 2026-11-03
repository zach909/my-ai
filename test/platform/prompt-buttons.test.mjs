/**
 * Prompt buttons: the AI puts [[ask: Label | prompt]] in its reply and a click sends the prompt back
 * (interface/prompt-buttons.ts). The parsing, the framing skill and the page-side renderer are checked here;
 * the renderer runs against a tiny stand-in for the DOM so no browser is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const B = await import(dist('interface/prompt-buttons.js'));

test('buttons can sit anywhere in the prose, several at once, and the prose around them is kept exactly', () => {
  const parts = B.splitPromptButtons('Want more? [[ask: Example | Show me a worked example]] or [[ask: Start over]].\n[[ask: Third | Do the third thing]]');
  assert.deepEqual(parts.map((p) => p.kind), ['text', 'button', 'text', 'button', 'text', 'button']);
  assert.equal(parts[0].text, 'Want more? ');
  assert.deepEqual([parts[1].text, parts[1].prompt], ['Example', 'Show me a worked example']);
  assert.deepEqual([parts[3].text, parts[3].prompt], ['Start over', 'Start over'], 'no bar: the label is the prompt');
  assert.equal(parts[4].text, '.\n');
  assert.equal(parts[5].prompt, 'Do the third thing');
});

test('a message with no button comes back as one untouched piece of text', () => {
  const plain = '  hello\n\n  [[not a button]] world  ';
  assert.deepEqual(B.splitPromptButtons(plain), [{ kind: 'text', text: plain }]);
  assert.deepEqual(B.splitPromptButtons(''), []);
  assert.deepEqual(B.splitPromptButtons(null), []);
});

test('empty, oversized or surplus markers stay as text', () => {
  for (const bad of ['[[ask:]]', '[[ask:   ]]', '[[ask: x | ]]', `[[ask: ${'l'.repeat(B.PROMPT_BUTTON_LABEL_MAX + 1)}]]`, `[[ask: ok | ${'p'.repeat(B.PROMPT_BUTTON_PROMPT_MAX + 1)}]]`]) {
    assert.ok(!B.splitPromptButtons(bad).some((p) => p.kind === 'button'), bad.slice(0, 30));
  }
  const many = Array.from({ length: 20 }, (_, i) => `[[ask: b${i}]]`).join(' ');
  const parts = B.splitPromptButtons(many);
  assert.equal(parts.filter((p) => p.kind === 'button').length, B.PROMPT_BUTTON_MAX_PER_MESSAGE);
  assert.ok(parts.at(-1).text.includes('[[ask: b19]]'), 'the surplus is left in the text');
});

test('the framing fits the 160 characters the doorway keeps, and is sent only when the page asked', () => {
  const s = B.PROMPT_BUTTON_SKILL;
  assert.ok(`${s.title}: ${s.description}`.length <= 160, 'would be cut off at the doorway');
  assert.deepEqual(B.promptButtonSkillsFor({ buttons: true }), [s]);
  for (const body of [null, {}, { buttons: false }, { buttons: 'yes' }]) assert.deepEqual(B.promptButtonSkillsFor(body), []);
});

test('the page scripts hold no </head>, </body> or </html>: the server inserts its tags at the first one it finds', () => {
  for (const [name, js] of [['PROMPT_BUTTON_CLIENT_JS', B.PROMPT_BUTTON_CLIENT_JS], ['PROMPT_BUTTON_CSS', B.PROMPT_BUTTON_CSS]]) {
    assert.ok(!/<\/(head|body|html)>/i.test(js), `${name} contains a closing page tag`);
  }
});

test('the page renderer builds a real button per marker, from text only, and a click sends that prompt', () => {
  const node = (tag) => ({ tag, children: [], attrs: {}, textContent: '', appendChild(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = v; } });
  const document = { createElement: node, createTextNode: (t) => ({ tag: '#text', textContent: t }) };
  const ncButtons = new Function('document', `${B.PROMPT_BUTTON_CLIENT_JS}\nreturn ncButtons;`)(document);

  const evil = '<img src=x onerror=alert(1)>';
  const text = `Hi [[ask: ${evil} | say <b>hi</b>]] and [[ask: Two]]`;
  assert.equal(ncButtons.has(text), true);
  assert.equal(ncButtons.has('nothing here'), false);

  const sent = [];
  const el = node('div');
  assert.equal(ncButtons.render(el, text, (p) => sent.push(p)), 2);
  assert.deepEqual(el.children.map((c) => c.tag), ['#text', 'button', '#text', 'button']);
  const [, first, , second] = el.children;
  assert.equal(first.textContent, evil, 'the label is set as text, never parsed as markup');
  assert.equal(first.className, 'nc-ask');
  first.onclick();
  second.onclick();
  assert.deepEqual(sent, ['say <b>hi</b>', 'Two']);
});
