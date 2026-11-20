/**
 * Sources: the AI backs a claim with [[source: Title | address | passage]] and the link opens on the passage
 * (interface/sources.ts). Parsing, the passage finder, the viewer pages and the page-side renderer are checked
 * here; the renderer runs against a tiny stand-in for the DOM so no browser is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const S = await import(dist('interface/sources.js'));

test('chips can sit anywhere in the prose, and the prose around them is kept exactly', () => {
  const parts = S.splitSources('Water boils at 100 C. [[source: Boiling | https://e.org/b | boils at 100 degrees]] Next.\n[[source: Two | http://e.org/2]]');
  assert.deepEqual(parts.map((p) => p.kind), ['text', 'source', 'text', 'source']);
  assert.equal(parts[0].text, 'Water boils at 100 C. ');
  assert.deepEqual([parts[1].text, parts[1].url, parts[1].quote], ['Boiling', 'https://e.org/b', 'boils at 100 degrees']);
  assert.equal(parts[2].text, ' Next.\n');
  assert.equal(parts[3].quote, '', 'a passage is optional');
  const plain = '  hello [[not a source]] world  ';
  assert.deepEqual(S.splitSources(plain), [{ kind: 'text', text: plain }]);
  assert.deepEqual(S.splitSources(null), []);
});

test('only http(s) addresses count; anything else, and empty or oversized markers, stay as text', () => {
  for (const bad of ['[[source: x | javascript:alert(1) | q]]', '[[source: x | file:///etc/passwd | q]]', '[[source: x | /local/path | q]]', '[[source: | https://e.org | q]]', '[[source: only title]]',
    `[[source: ${'t'.repeat(S.SOURCE_TITLE_MAX + 1)} | https://e.org | q]]`, `[[source: x | https://e.org/${'a'.repeat(S.SOURCE_URL_MAX)} | q]]`]) {
    assert.ok(!S.splitSources(bad).some((p) => p.kind === 'source'), bad.slice(0, 40));
  }
  const many = Array.from({ length: 20 }, (_, i) => `[[source: s${i} | https://e.org/${i}]]`).join(' ');
  assert.equal(S.splitSources(many).filter((p) => p.kind === 'source').length, S.SOURCE_MAX_PER_MESSAGE);
});

test('an image box is four fractions inside the picture; a bad box is dropped and the chip kept', () => {
  const ok = S.splitSources('[[source: Cat | https://e.org/c.jpg | the cat | 0.2,0.3,0.4,0.35]]')[0];
  assert.deepEqual(ok.box, [0.2, 0.3, 0.4, 0.35]);
  assert.equal(ok.quote, 'the cat');
  const noQuote = S.splitSources('[[source: Cat | https://e.org/c.jpg | | 0.1,0.1,0.5,0.5]]')[0];
  assert.deepEqual(noQuote.box, [0.1, 0.1, 0.5, 0.5]);
  for (const box of ['0.9,0.9,0.5,0.5', '0,0,0,0', '2,0,1,1']) {
    const p = S.splitSources(`[[source: Cat | https://e.org/c.jpg | q | ${box}]]`)[0];
    assert.equal(p.kind, 'source');
    assert.equal(p.box, undefined, box);
  }
});

test('the framing fits the 160 characters the doorway keeps, and is sent only when the page asked', () => {
  const s = S.SOURCE_SKILL;
  assert.ok(`${s.title}: ${s.description}`.length <= 160, 'would be cut off at the doorway');
  assert.deepEqual(S.sourceSkillsFor({ sources: true }), [s]);
  for (const body of [null, {}, { sources: false }, { sources: 'yes' }]) assert.deepEqual(S.sourceSkillsFor(body), []);
});

test('page words: markup, scripts, styles and comments are gone, entities decoded, inline tags keep words together', () => {
  const html = '<html><head><title>t</title><script>var secret="boils"</script><style>p{}</style></head><body><h1>Water</h1><p>At sea level, water &amp; liquids\nboils  at&nbsp;100 degrees.</p><!-- hidden --><p>Other <b>here</b>.</p></body></html>';
  const t = S.extractPageText(html);
  assert.ok(!/secret|hidden|p\{\}|<|>/.test(t), t);
  assert.match(t, /water & liquids\nboils at 100 degrees\./);
  assert.match(t, /Other here\./);
  assert.equal(S.extractPageText('just plain words'), 'just plain words');
});

test('finding the passage is forgiving about case, punctuation and line breaks, and says so when it is not there', () => {
  const t = 'Intro text.\nAt sea level, water\nboils at 100 degrees Celsius (212 F).\nMore.';
  const exact = S.findPassage(t, 'BOILS at 100 degrees, Celsius');
  assert.ok(exact.exact);
  assert.equal(t.slice(exact.start, exact.end), 'boils at 100 degrees Celsius');
  const near = S.findPassage(t, 'water boils at roughly 100 degrees Celsius');
  assert.ok(near && !near.exact, 'a reworded passage gets the closest stretch');
  assert.match(t.slice(near.start, near.end), /boils at 100 degrees Celsius/);
  assert.equal(S.findPassage(t, 'the moon is made of cheese'), null);
  assert.equal(S.findPassage(t, ''), null);
  assert.equal(S.findPassage('', 'anything'), null);
});

test('the text viewer escapes everything from the other site and highlights only the passage', () => {
  const q = { url: 'https://e.org/<x>', title: '<img src=x onerror=alert(1)>', quote: 'boils at 100 degrees', box: null };
  const page = S.sourceTextPage(q, 'Water boils at 100 degrees. <script>alert(2)</script>');
  assert.ok(page.includes('<mark id="hit" class="pulse">boils at 100 degrees</mark>'));
  assert.ok(!page.includes('<script>alert(2)') && !page.includes('<img src=x'), 'nothing from the page or the title becomes markup');
  assert.match(page, /passage is highlighted/);
  const missing = S.sourceTextPage({ ...q, quote: 'not on the page at all' }, 'Water boils.');
  assert.ok(!missing.includes('<mark'), 'no guess when it is not found');
  assert.match(missing, /not found on the page/);
});

test('the picture viewer embeds the address and box as data, never as markup, and the CSP allows pictures from other sites', () => {
  const q = S.parseSourceQuery(new URLSearchParams({ u: 'https://e.org/c.jpg?a=</script><script>alert(1)', t: 'Cat', box: '0.2,0.3,0.4,0.35' }));
  const page = S.sourceImagePage(q);
  assert.ok(!page.includes('</script><script>alert(1)'));
  assert.ok(page.includes('drawImage') && page.includes('0.2,0.3,0.4,0.35'.split(',')[0]));
  assert.match(S.IMAGE_SOURCE_CSP, /img-src 'self' http: https:/);
  assert.match(S.IMAGE_SOURCE_CSP, /default-src 'self'/);
  assert.match(S.IMAGE_SOURCE_CSP, /script-src 'self'/, "the app's own ring script (/ambient.js) still loads on this page");
});

test('the viewer takes web addresses only', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://e.org/x', '', '/relative', 'https://e.org/a b']) {
    assert.equal(S.parseSourceQuery(new URLSearchParams({ u })), null, u);
  }
  assert.equal(S.parseSourceQuery(new URLSearchParams({ u: 'https://e.org/p', q: '  two   words ' })).quote, 'two words');
  assert.equal(S.looksLikeImage('https://e.org/a/b.PNG?x=1'), true);
  assert.equal(S.looksLikeImage('https://e.org/a/b.html'), false);
});

test('the page scripts hold no </head>, </body> or </html>: the server inserts its tags at the first one it finds', () => {
  for (const [name, js] of [['SOURCE_CLIENT_JS', S.SOURCE_CLIENT_JS], ['SOURCE_CSS', S.SOURCE_CSS]]) assert.ok(!/<\/(head|body|html)>/i.test(js), name);
});

test('the page renderer builds a real link per marker, from text only, in the chosen mode', () => {
  const node = (tag) => ({ tag, children: [], attrs: {}, textContent: '', appendChild(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = v; } });
  const document = { createElement: node, createTextNode: (t) => ({ tag: '#text', textContent: t }) };
  const ncSources = new Function('document', `${S.SOURCE_CLIENT_JS}\nreturn ncSources;`)(document);
  const evil = '<img src=x onerror=alert(1)>';
  const text = `Fact. [[source: ${evil} | https://e.org/a b | q]] [[source: Page | https://e.org/p?x=1&y=2 | two words | 0.1,0.2,0.3,0.4]] end`;
  assert.equal(ncSources.has(text), true);
  assert.equal(ncSources.has('nothing'), false);

  const focus = node('div');
  assert.equal(ncSources.render(focus, text, 'focus'), 1, 'the first marker has a space in its address, so it stays prose');
  const link = focus.children.find((c) => c.tag === 'a');
  assert.equal(link.textContent, 'Page');
  assert.equal(link.href, '/source?u=https%3A%2F%2Fe.org%2Fp%3Fx%3D1%26y%3D2&t=Page&q=two%20words&box=0.1,0.2,0.3,0.4');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');

  const bare = node('div');
  ncSources.render(bare, text, 'link');
  assert.equal(bare.children.find((c) => c.tag === 'a').href, 'https://e.org/p?x=1&y=2', 'link mode opens the page as it is');

  const off = node('div');
  ncSources.render(off, text, 'off');
  assert.ok(!off.children.some((c) => c.tag === 'a'), 'off mode draws no links');
  assert.ok(off.children.some((c) => c.className === 'nc-src nc-src-off' && c.textContent === 'Page'));

  const seen = [];
  ncSources.render(node('div'), 'a [[source: T | https://e.org/x | q]] b', 'focus', (el, t) => { el.textContent = t; seen.push(t); });
  assert.deepEqual(seen, ['a ', ' b'], 'the prose between chips goes through the caller, so prompt buttons still work there');
});
