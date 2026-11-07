/**
 * The Store and Extension Builder pages (interface/platform/store-page.ts, builder-page.ts). Each is one HTML
 * string with an inline script, so a stray escape in the TypeScript source breaks the whole page without any
 * compile error. These checks catch that, and pin each page to the API shapes the server really returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const { storePage } = await import(dist('interface/platform/store-page.js'));
const { builderPage } = await import(dist('interface/platform/builder-page.js'));

const script = (html) => {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'page has an inline script');
  return m[1];
};

test('both inline scripts are valid JavaScript as served', () => {
  assert.doesNotThrow(() => new vm.Script(script(storePage())), 'store script');
  assert.doesNotThrow(() => new vm.Script(script(builderPage())), 'builder script');
});

test('the store reads /api/store as { kinds, labels, catalog } and installs with { kind, name }', () => {
  const js = script(storePage());
  assert.match(js, /data\.catalog/);
  assert.doesNotMatch(js, /data\.items/, '/api/store has no "items" field');
  assert.match(js, /\/api\/store\/install/);
  assert.match(js, /kind: kind, name: item\.name/);
  assert.match(js, /\/api\/store\/installed/);
});

test('the store builds its cards from text, never from item names spliced into HTML', () => {
  assert.doesNotMatch(script(storePage()), /innerHTML/);
});

test('the builder talks to the real extension routes and sends NeuroLang, not JavaScript', () => {
  const html = builderPage();
  const js = script(html);
  assert.match(js, /\/api\/extension\/build/);
  assert.match(js, /\/api\/extension\/list/);
  assert.doesNotMatch(js, /\/api\/extensions\b/, 'old routes that do not exist');
  assert.doesNotMatch(js, /eval\(/);
  assert.match(html, /NeuroLang code/);
});

test('every builder template is a statement the NeuroLang parser accepts', async () => {
  const js = script(builderPage());
  const block = js.match(/var templates = (\{[\s\S]*?\n    \});/);
  assert.ok(block, 'templates object found');
  const templates = vm.runInNewContext('(' + block[1] + ')');
  const { ExtensionBuilder } = await import(dist('extension-builder/builder.js'));
  for (const [kind, code] of Object.entries(templates)) {
    const builder = new ExtensionBuilder();
    const project = builder.createProject(kind, '');
    const parsed = await builder.parseNeuroLang(project.id, code);
    assert.equal(parsed.success, true, `${kind} template: ${JSON.stringify(parsed.errors)}`);
  }
});
