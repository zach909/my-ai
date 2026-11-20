/**
 * extension-builder/corpus-extension.mjs: the cited-data side of the Extension Builder.
 * Node's built-in runner, Node built-ins only. These tests build their own small corpus in a temp folder, so they
 * need no network and no compiled backend; the last test also checks the real training_data/open_corpus folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, tempDir, removeDir } from './helpers.mjs';
import {
  CitationError, applyToBuilder, buildKnowledgeExtension, chunkSpans, formatCitation, loadCitedCorpus,
  readKnowledgeExtension, searchKnowledgeExtension, sha256, verifyAgainstCorpus, verifyKnowledgeExtension,
  writeKnowledgeExtension,
} from '../../extension-builder/corpus-extension.mjs';

const BOOK = [
  'CHAPTER I\n\nIt is a truth that a river runs downhill. The water does not argue about it.',
  'Second paragraph about stone and moss. '.repeat(8).trim(),
  'The lamp was lit and the ship was safe in harbour.',
].join('\n\n') + '\n';
const ARTICLE = 'Entropy\n\nEntropy is a measure of disorder. The second law of thermodynamics says that the entropy of an isolated system never decreases.\n';

/** A tiny corpus in the exact layout fetch-open-corpus.mjs writes. */
function makeCorpus(mutate) {
  const dir = tempDir('nc-corpus-');
  mkdirSync(path.join(dir, 'gutenberg'));
  mkdirSync(path.join(dir, 'wikipedia_full'));
  writeFileSync(path.join(dir, 'gutenberg', '7.txt'), BOOK);
  writeFileSync(path.join(dir, 'wikipedia_full', 'Entropy.txt'), ARTICLE);
  const manifest = {
    generated: '2026-11-13',
    gutenberg: [{
      id: 7, title: 'The River Book', author: 'A. Writer', url: 'https://www.gutenberg.org/cache/epub/7/pg7.txt',
      page: 'https://www.gutenberg.org/ebooks/7', licence: 'Public domain in the USA (Project Gutenberg)',
      accessed: '2026-11-13', file: 'gutenberg/7.txt', sha256: sha256(BOOK),
    }],
    wikipedia: [],
    wikipediaFull: [{
      title: 'Entropy', url: 'https://en.wikipedia.org/wiki/Entropy', revision: 111, timestamp: '2026-11-06T14:50:37Z',
      history: 'https://en.wikipedia.org/w/index.php?title=Entropy&action=history',
      licence: 'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); text by Wikipedia contributors',
      accessed: '2026-11-13', file: 'wikipedia_full/Entropy.txt', sha256: sha256(ARTICLE),
    }],
  };
  if (mutate) mutate(manifest, dir);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

const withCorpus = (mutate, fn) => {
  const dir = makeCorpus(mutate);
  try { return fn(dir); } finally { removeDir(dir); }
};
const problemsOf = (dir) => {
  try { loadCitedCorpus(dir); } catch (err) { assert.ok(err instanceof CitationError); return err.problems.join('\n'); }
  return '';
};

test('a fully cited corpus loads, with its licence recognised for every source', () => {
  withCorpus(null, (dir) => {
    const c = loadCitedCorpus(dir);
    assert.deepEqual(c.sources.map((s) => [s.id, s.licenceId]), [['gutenberg:7', 'PD-US'], ['wikipedia:Entropy', 'CC-BY-SA-4.0']]);
    assert.equal(c.sources[0].text, BOOK);
  });
});

test('data without a full citation is refused, and every problem is reported at once', () => {
  assert.match(problemsOf('/nonexistent-corpus-dir'), /manifest\.json does not exist/);
  withCorpus((m) => { delete m.gutenberg[0].url; }, (d) => assert.match(problemsOf(d), /missing url/));
  withCorpus((m) => { m.gutenberg[0].accessed = 'yesterday'; }, (d) => assert.match(problemsOf(d), /accessed must be YYYY-MM-DD/));
  withCorpus((m) => { m.gutenberg[0].licence = 'All rights reserved'; }, (d) => assert.match(problemsOf(d), /only openly licensed data is accepted/));
  withCorpus((m) => { m.gutenberg[0].url = 'http://example.org/x'; }, (d) => assert.match(problemsOf(d), /https link/));
  withCorpus((m) => { m.gutenberg[0].file = '../escape.txt'; }, (d) => assert.match(problemsOf(d), /outside the corpus folder/));
  withCorpus((m) => { m.gutenberg.push({ ...m.gutenberg[0] }); }, (d) => assert.match(problemsOf(d), /listed twice/));
  withCorpus((m, d) => { m.gutenberg[0].licence = 'nope'; m.wikipediaFull[0].sha256 = '0'.repeat(64); }, (d) => {
    const p = problemsOf(d);
    assert.match(p, /licence "nope"/);
    assert.match(p, /does not match its recorded SHA-256/);
  });
});

test('a text file nobody cited, or one edited after it was cited, is caught', () => {
  withCorpus(null, (dir) => {
    writeFileSync(path.join(dir, 'gutenberg', '999.txt'), 'pasted from somewhere\n');
    assert.match(problemsOf(dir), /gutenberg\/999\.txt has no citation/);
  });
  withCorpus(null, (dir) => {
    writeFileSync(path.join(dir, 'gutenberg', '7.txt'), BOOK + 'one extra line\n');
    assert.match(problemsOf(dir), /changed since it was cited/);
  });
});

test('chunkSpans: passages are exact slices, never longer than max, and lose no text', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['river', 'stone', 'light', 'Zip.', 'loop!', 'bits?', 'a', 'of', 'neuron,', 'ship'];
  let text = '';
  for (let p = 0; p < 60; p++) {
    const len = rnd(5) === 0 ? 400 + rnd(900) : 3 + rnd(40);       // some paragraphs far longer than max
    text += Array.from({ length: len }, () => words[rnd(words.length)]).join(' ') + (rnd(3) === 0 ? '\n   \n' : '\n\n');
  }
  text += '🦀'.repeat(300);                                            // surrogate pairs with no spaces: forces a hard cut
  const max = 300;
  const spans = chunkSpans(text, max);
  assert.ok(spans.length > 20);
  let lastEnd = 0;
  for (const [a, b] of spans) {
    assert.ok(a >= lastEnd && b > a && b - a <= max, `span ${a}-${b}`);
    assert.doesNotMatch(text.slice(a, b), /^\s|\s$/);
    assert.doesNotMatch(text.slice(a, b), /[\ud800-\udbff]$|^[\udc00-\udfff]/, 'no split surrogate pair');
    lastEnd = b;
  }
  const strip = (s) => s.replace(/\s+/g, '');
  assert.equal(strip(spans.map(([a, b]) => text.slice(a, b)).join('')), strip(text));
  assert.throws(() => chunkSpans('x', 10), /at least 100/);
});

test('the built extension verifies, its id follows the data, and tampering is detected', () => {
  withCorpus(null, (dir) => {
    const corpus = loadCitedCorpus(dir);
    const ext = buildKnowledgeExtension(corpus, { name: 'tiny', version: '1.0.0', maxChars: 200, now: 0 });
    assert.deepEqual(verifyKnowledgeExtension(ext), { ok: true, errors: [] });
    assert.equal(ext.builtAt, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(ext.licences.map((l) => [l.id, l.sources]), [['PD-US', 1], ['CC-BY-SA-4.0', 1]]);
    assert.match(ext.attribution, /action=history/);                 // ShareAlike source: authors are reachable
    assert.match(ext.attribution, /ShareAlike|CC BY-SA 4\.0/);
    assert.equal(buildKnowledgeExtension(corpus, { maxChars: 200, now: 5 }).id, buildKnowledgeExtension(corpus, { maxChars: 200 }).id, 'same data, same id');
    assert.notEqual(buildKnowledgeExtension(corpus, { maxChars: 300 }).id, ext.id, 'chunking is part of the id');

    const edit = (fn) => { const c = structuredClone(ext); fn(c); return verifyKnowledgeExtension(c); };
    assert.match(edit((c) => { c.chunks[0].t = 'Chapter I'; }).errors.join(), /length does not match|does not match its hash/);
    assert.match(edit((c) => { c.chunks[0].t = c.chunks[0].t.replace('river', 'RIVER'); }).errors.join(), /does not match its hash/);
    assert.match(edit((c) => { c.chunks[0].s = 'gutenberg:404'; }).errors.join(), /unknown source/);
    assert.match(edit((c) => { delete c.sources[0].url; }).errors.join(), /missing url/);
    assert.match(edit((c) => { c.sources[0].licenceId = 'Proprietary'; }).errors.join(), /unaccepted licence/);
    assert.match(edit((c) => { c.chunks.pop(); }).errors.join(), /passages but/);
    assert.match(edit((c) => { c.sources[1].sha256 = '1'.repeat(64); }).errors.join(), /id does not match/);
    assert.match(edit((c) => { c.attribution = ''; }).errors.join(), /attribution text does not mention/);
    assert.match(edit((c) => { c.formatVersion = 2; }).errors.join(), /upgrade your builder/);
    assert.match(edit((c) => { c.kind = 'project'; }).errors.join(), /expected "knowledge-extension"/);
  });
});

test('verifyAgainstCorpus notices when the corpus moved on after the build', () => {
  withCorpus(null, (dir) => {
    const ext = buildKnowledgeExtension(loadCitedCorpus(dir), { maxChars: 200 });
    assert.deepEqual(verifyAgainstCorpus(ext, dir), { ok: true, errors: [] });
    writeFileSync(path.join(dir, 'gutenberg', '7.txt'), BOOK.replace('river', 'brook'));
    assert.throws(() => verifyAgainstCorpus(ext, dir), CitationError);          // file no longer matches its citation
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.gutenberg[0].sha256 = sha256(BOOK.replace('river', 'brook'));
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    const r = verifyAgainstCorpus(ext, dir);                                      // re-cited, but this extension is now stale
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /changed since this extension was built/);
  });
});

test('search returns the passage together with its citation, and nothing without one', () => {
  withCorpus(null, (dir) => {
    const ext = buildKnowledgeExtension(loadCitedCorpus(dir), { maxChars: 200 });
    const hits = searchKnowledgeExtension(ext, 'the second law of thermodynamics', { k: 3 });
    assert.equal(hits[0].source, 'wikipedia:Entropy');
    assert.match(hits[0].text, /second law of thermodynamics/);
    assert.match(hits[0].citation, /en\.wikipedia\.org\/wiki\/Entropy.*Revision 111.*Attribution-ShareAlike.*Accessed 2026-11-13/);
    assert.ok(hits.every((h) => h.citation && h.source && Number.isInteger(h.offset)));
    const book = searchKnowledgeExtension(ext, 'ship was safe in harbour', { k: 1 })[0];
    assert.equal(book.source, 'gutenberg:7');
    assert.match(book.citation, /A\. Writer\. \*The River Book\*\. Project Gutenberg ebook #7\..*Public domain in the USA/);
    assert.deepEqual(searchKnowledgeExtension(ext, '   '), []);
    assert.deepEqual(searchKnowledgeExtension(ext, 'zzzzqqqq'), []);
    assert.ok(searchKnowledgeExtension(ext, 'a')[0].citation);       // one-letter query still works
    assert.deepEqual(searchKnowledgeExtension(ext, 'ship', { sourceKind: 'article' }), []);
    // The cited offset really points at the passage in the original file.
    assert.equal(BOOK.slice(book.offset, book.offset + book.text.length), book.text);
  });
});

test('write then read round-trips, leaves no temp file, and refuses to write a broken extension', () => {
  withCorpus(null, (dir) => {
    const ext = buildKnowledgeExtension(loadCitedCorpus(dir), { name: 'tiny', maxChars: 200 });
    const out = path.join(dir, 'out', 'tiny.kx.json');
    const { bytes } = writeKnowledgeExtension(ext, out);
    assert.ok(bytes > 100);
    assert.deepEqual(readdirSync(path.join(dir, 'out')), ['tiny.kx.json']);
    assert.deepEqual(readKnowledgeExtension(out), ext);
    const broken = structuredClone(ext); broken.chunks[0].t += 'x';
    assert.throws(() => writeKnowledgeExtension(broken, path.join(dir, 'out', 'bad.kx.json')), /fails verification/);
    assert.deepEqual(readdirSync(path.join(dir, 'out')), ['tiny.kx.json']);
    assert.throws(() => buildKnowledgeExtension(loadCitedCorpus(dir), { name: '../evil' }), /extension name/);
    assert.throws(() => buildKnowledgeExtension(loadCitedCorpus(dir), { version: 'one' }), /version/);
  });
});

test('applyToBuilder drives the ExtensionBuilder public methods (stand-in builder: the real engine needs the compiled backend)', () => {
  withCorpus(null, (dir) => {
    const ext = buildKnowledgeExtension(loadCitedCorpus(dir), { maxChars: 200 });
    const calls = [];
    const fake = {
      createProject: (name, description) => { calls.push(['createProject', name, description]); return { id: 'p1' }; },
      addNetSearch: (pid, name, corpus, query, netPath, pos) => { calls.push(['addNetSearch', pid, name, corpus, pos]); return { id: `n${calls.length}` }; },
      dragLabel: (pid, nid, label) => { calls.push(['dragLabel', pid, nid, label]); return true; },
    };
    const r = applyToBuilder(fake, ext, { linesPerSource: 2 });
    assert.deepEqual(r, { projectId: 'p1', neurons: 2, lines: calls.filter((c) => c[0] === 'addNetSearch').reduce((a, c) => a + c[3].split('\n').length, 0) });
    assert.match(calls[0][2], new RegExp(ext.id));
    const searches = calls.filter((c) => c[0] === 'addNetSearch');
    assert.deepEqual(searches.map((c) => c[2]), ['The River Book', 'Entropy']);
    assert.ok(searches.every((c) => c[3].split('\n').length <= 2 && !c[3].includes('\r')));
    assert.deepEqual(calls.filter((c) => c[0] === 'dragLabel').map((c) => c[3]), [
      'PD-US https://www.gutenberg.org/cache/epub/7/pg7.txt', 'CC-BY-SA-4.0 https://en.wikipedia.org/wiki/Entropy']);
    assert.match(formatCitation(ext.sources[1]), /Wikipedia\./);
  });
});

test('the real training_data/open_corpus folder is fully cited, licensed and unchanged since it was cited', () => {
  const corpus = loadCitedCorpus(path.join(ROOT, 'training_data', 'open_corpus'));
  assert.ok(corpus.sources.length >= 40);
  assert.ok(corpus.sources.every((s) => s.licenceId && s.url.startsWith('https://') && s.accessed));
  const ext = buildKnowledgeExtension(corpus, { name: 'real-check', now: 0 });
  assert.deepEqual(verifyKnowledgeExtension(ext), { ok: true, errors: [] });
  const hit = searchKnowledgeExtension(ext, 'second law of thermodynamics entropy increases', { k: 1 })[0];
  assert.match(hit.citation, /^Wikipedia contributors\./);
});
