/**
 * Self-improvement page: the numbers come from the three real ledgers (interface/self-improvement-data.ts),
 * a ledger that does not exist yet gives zeros and empty lists, and the page script carries no made-up figures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, ensureBuilt } from './helpers.mjs';

ensureBuilt();
const D = await import(dist('interface/self-improvement-data.js'));
const { selfImprovementPage } = await import(dist('interface/platform/self-improvement-page.js'));

const empty = { scoreboard: { targets: {} }, drills: { skills: {} }, attempts: [] };
const ledgers = {
  scoreboard: { targets: { t: { history: [{ at: '2026-11-01T00:00:00Z', ok: true }, { at: '2026-11-02T00:00:00Z', ok: false, error: 'boom' }] } } },
  drills: { skills: { math: { history: [
    { at: '2026-11-03T00:00:00Z', topic: 'Math', ok: true, improved: true, accuracyBefore: 0.5, accuracyAfter: 0.75 },
    { at: '2026-11-04T00:00:00Z', ok: false, error: 'x' },
  ] }, idle: { history: [] } } },
  attempts: [{ at: 1, matched: true, similarity: 0.9, matchedSkill: 'math' }, { at: 2, matched: false, similarity: 0.3 }],
};

test('no ledgers yet: zeros, nulls and empty lists, never invented numbers', () => {
  const o = D.selfImprovementTab('overview', empty);
  assert.equal(o.directAnswers.attempts, 0);
  assert.equal(o.directAnswers.ratePercent, null);
  assert.equal(o.drills.total, 0);
  assert.deepEqual(D.selfImprovementTab('skills', empty), []);
  assert.deepEqual(D.selfImprovementTab('history', empty), []);
  assert.equal(D.selfImprovementTab('reasoning', empty).averageSimilarity, null);
});

test('the tabs are worked out from what the ledgers hold', () => {
  const o = D.selfImprovementTab('overview', ledgers);
  assert.deepEqual(o.directAnswers, { attempts: 2, matched: 1, ratePercent: 50 });
  assert.deepEqual(o.drills, { total: 2, finished: 1, improved: 1, skillsDrilled: 1 });
  assert.deepEqual(o.experiments, { targets: 1, attempts: 2, sandboxFailures: 1 });
  const skills = D.selfImprovementTab('skills', ledgers);
  assert.deepEqual(skills, [{ name: 'math', drills: 2, improvedDrills: 1, lastBefore: 50, lastAfter: 75 }]);
  assert.deepEqual(D.selfImprovementTab('reasoning', ledgers).topSkills, [{ name: 'math', count: 1 }]);
  const history = D.selfImprovementTab('history', ledgers);
  assert.equal(history.length, 4);
  assert.deepEqual(history.map((e) => e.at), [...history.map((e) => e.at)].sort().reverse());
});

test('only the four tabs are accepted', () => {
  for (const t of ['overview', 'skills', 'reasoning', 'history']) assert.equal(D.isSelfImprovementTab(t), true);
  assert.equal(D.isSelfImprovementTab('nope'), false);
  assert.equal(D.isSelfImprovementTab(null), false);
});

test('the page script parses and holds no placeholder figures', () => {
  const script = selfImprovementPage().split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
  for (const fake of ['47', '92.3', '324', '156', '1,847']) assert.ok(!script.includes(fake), `placeholder ${fake} is back`);
  assert.ok(script.includes('/api/self-improvement?tab='));
});
