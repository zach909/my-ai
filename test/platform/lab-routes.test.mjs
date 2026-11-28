/**
 * Tests for the virtual laboratory's HTTP routes (interface/lab-routes.ts).
 *   node --test test/platform/lab-routes.test.mjs
 * lab-routes.ts imports only Node built-ins, so Node loads it directly (type stripping) and the real
 * handler runs here against a fake request context: no build and no server needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { handleLabRoutes, isLabRoute } = await import('../../interface/lab-routes.ts');

/** Call the handler like the server does. `body` is what parseBody will hand back. */
async function call(method, pathname, body, url = pathname) {
  let out = null;
  const ctx = {
    req: { url }, res: {}, pathname, method,
    parseBody: async () => body,
    sendJson: (_res, data, status = 200) => { out = { status, data }; },
  };
  const handled = await handleLabRoutes(ctx);
  return { handled, ...(out ?? {}) };
}

test('only the lab\'s own paths are its routes', async () => {
  assert.equal(isLabRoute('/api/lab'), true);
  assert.equal(isLabRoute('/api/lab/act'), true);
  assert.equal(isLabRoute('/api/laboratory'), false);
  assert.equal(isLabRoute('/api/nets'), false);
  assert.equal((await call('GET', '/api/nets')).handled, false);
  assert.equal((await call('GET', '/api/lab/nothing')).handled, false, 'an unknown lab path is left for the 404');
});

test('GET /api/lab gives the datasheet and the scripted agents, and no hidden constant', async () => {
  const r = await call('GET', '/api/lab');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data.datasheet.experiments).sort(), ['cooling', 'culture', 'ohm', 'pendulum', 'rc']);
  assert.deepEqual(r.data.agents, ['scientist', 'reckless', 'guesser']);
  assert.ok(!/"(hidden|truth|claimed)"\s*:/.test(JSON.stringify(r.data)), 'no hidden or truth field is sent');
});

test('a session: start, work, read the notebook, submit', async () => {
  const made = await call('POST', '/api/lab/new', { seed: 3, experiments: ['pendulum', 'rc'], credits: 50, hours: 4 });
  assert.equal(made.status, 200);
  const session = made.data.session;
  assert.match(session, /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(made.data.datasheet.experiments), ['pendulum', 'rc']);
  assert.equal(made.data.datasheet.budget.credits, 50);
  assert.equal(made.data.datasheet.budget.bench_seconds, 4 * 3600);

  const m = await call('POST', '/api/lab/act', { session, action: { tool: 'measure', experiment: 'pendulum', controls: { length: 1 }, repeats: 5 } });
  assert.equal(m.status, 200);
  assert.equal(m.data.ok, true);
  assert.equal(m.data.n, 5);

  // a refused action is an ordinary result, not an HTTP error
  const bad = await call('POST', '/api/lab/act', { session, action: { tool: 'measure', experiment: 'pendulum', controls: { length: 99 } } });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.reason, 'out_of_range');
  const junk = await call('POST', '/api/lab/act', { session, action: 'rm -rf /' });
  assert.equal(junk.data.ok, false);

  const hot = await call('POST', '/api/lab/act', { session, action: { tool: 'measure', experiment: 'rc', controls: { volts: 25 } } });
  assert.equal(hot.data.reason, 'incident');

  const nb = await call('GET', '/api/lab/notebook', undefined, `/api/lab/notebook?session=${session}`);
  assert.equal(nb.status, 200);
  assert.equal(nb.data.done, false);
  assert.match(nb.data.notebook, /measure pendulum .* x5/);
  assert.match(nb.data.notebook, /incident/);

  const done = await call('POST', '/api/lab/act', { session, action: { tool: 'submit' } });
  assert.equal(done.data.ok, true);
  assert.equal(done.data.report.incidents.length, 1);
  assert.equal((await call('GET', '/api/lab/notebook', undefined, `/api/lab/notebook?session=${session}`)).data.done, true);
  assert.equal((await call('POST', '/api/lab/act', { session, action: { tool: 'status' } })).data.reason, 'finished');
});

test('bad requests are refused with the right status', async () => {
  for (const body of [{ seed: -1 }, { seed: 1.5 }, { seed: '1' }, { credits: 0 }, { credits: 1e9 }, { hours: 0 }, { hours: 500 }, { experiments: [] }, { experiments: ['teleporter'] }, { experiments: 'rc' }, { experiments: [1] }]) {
    const r = await call('POST', '/api/lab/new', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  for (const body of [null, 5, 'x', [1]]) assert.equal((await call('POST', '/api/lab/new', body)).status, 400);
  assert.equal((await call('POST', '/api/lab/act', { session: 'nope', action: { tool: 'status' } })).status, 404);
  assert.equal((await call('POST', '/api/lab/act', { action: { tool: 'status' } })).status, 404);
  assert.equal((await call('GET', '/api/lab/notebook', undefined, '/api/lab/notebook')).status, 404);
  assert.equal((await call('POST', '/api/lab', {})).handled, false, 'wrong method on a known path is left alone');
});

test('only a few sessions are kept; the oldest is dropped', async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await call('POST', '/api/lab/new', { seed: i })).data.session);
  const alive = async (id) => (await call('POST', '/api/lab/act', { session: id, action: { tool: 'status' } })).status === 200;
  assert.equal(await alive(ids[0]), false);
  assert.equal(await alive(ids[1]), false);
  assert.equal(await alive(ids[5]), true);
});

test('baseline runs a scripted agent in a fresh lab and returns its report', async () => {
  const s = await call('POST', '/api/lab/baseline', { agent: 'scientist', seed: 2 });
  assert.equal(s.status, 200);
  assert.ok(s.data.report.score >= 0.95);
  const r = await call('POST', '/api/lab/baseline', { agent: 'reckless' });
  assert.ok(r.data.report.incidents.length >= 3);
  assert.equal((await call('POST', '/api/lab/baseline', {})).data.agent, 'scientist', 'the default agent');
  for (const agent of ['nobody', 'constructor', '__proto__', 'toString', 7]) assert.equal((await call('POST', '/api/lab/baseline', { agent })).status, 400, String(agent));
});

test('the lab is registered as a plugin and listed in the feature contract as desktop only', () => {
  const plugins = readFileSync(path.join(root, 'interface/server-plugins.ts'), 'utf8');
  assert.match(plugins, /import \{ handleLabRoutes, isLabRoute \} from '\.\/lab-routes\.js'/);
  assert.match(plugins, /id: 'lab-routes'/);
  assert.match(plugins, /commons, workbench, editor, lab\]\) host\.register\(p\)/);
  const contract = readFileSync(path.join(root, 'interface/platform/feature-contract.ts'), 'utf8');
  const entry = contract.slice(contract.indexOf("id: 'lab'"), contract.indexOf("id: 'plugin-host'"));
  assert.match(entry, /onlyOn: \['windows', 'linux', 'macos'\]/);
  for (const r of ['GET /api/lab', 'POST /api/lab/new', 'POST /api/lab/act', 'GET /api/lab/notebook', 'POST /api/lab/baseline']) assert.ok(entry.includes(`'${r}'`), r);
  assert.ok(!/android|ios|chromeos/.test(entry.match(/onlyOn: \[[^\]]*\]/)[0]), 'not on phones or the extension');
});
