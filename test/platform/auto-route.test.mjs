/**
 * Auto route: effort, where to answer, and how much of the network runs, picked per message
 * (models && skills/core/auto-route.ts), with the weight islands it gates on (weight-islands.ts) and the
 * prompt tidy-up (prompt-optimizer.ts). Pure logic against the compiled modules; nothing is mocked except the
 * device, the peer and the clock, which the router takes as dependencies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const W = await import(dist('models && skills/core/weight-islands.js'));
const P = await import(dist('models && skills/core/prompt-optimizer.js'));
const A = await import(dist('models && skills/core/auto-route.js'));
const { Chooser } = await import(dist('models && skills/core/engine-chooser.js'));

const GB = 1024 ** 3;

/* ------------------------------------------------------------------ meshes */

/** A small deterministic generator so the meshes are the same on every run. */
function lcg(seed) { let a = seed >>> 0; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

/** `blocks` groups of `per` neurons: strong links (0.6-1.0, either sign) inside a group, weak (under 0.1) between groups. */
function blockMesh(blocks = 4, per = 8, seed = 7) {
  const rnd = lcg(seed);
  const ids = Array.from({ length: blocks * per }, (_, i) => i);
  const edges = [];
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const same = Math.floor(a / per) === Math.floor(b / per);
    edges.push({ from: a, to: b, weight: (same ? 0.6 + 0.4 * rnd() : 0.1 * rnd()) * (rnd() < 0.5 ? -1 : 1) });
  }
  return { ids, edges };
}

function randomMesh(n = 32, seed = 11) {
  const rnd = lcg(seed);
  const ids = Array.from({ length: n }, (_, i) => i);
  const edges = [];
  for (const a of ids) for (const b of ids) if (a !== b) edges.push({ from: a, to: b, weight: rnd() * 2 - 1 });
  return { ids, edges };
}

/* ----------------------------------------------------------------- islands */

test('the 0/1 view keeps a connection when its weight is big enough, by size not sign, and never changes the weights', () => {
  const edges = [
    { from: 1, to: 2, weight: 0.9 }, { from: 2, to: 3, weight: -0.9 }, { from: 3, to: 4, weight: 0.2 }, { from: 4, to: 5, weight: 0 },
  ];
  const before = JSON.stringify(edges);
  assert.deepEqual(W.binarize(edges, 0.5), [[1, 2], [2, 3]]);
  assert.deepEqual(W.binarize(edges, 0.1), [[1, 2], [2, 3], [3, 4]], 'a weight of exactly 0 is never a connection');
  assert.equal(JSON.stringify(edges), before, 'the real weights are only read');
});

test('it finds the chunks a mesh really has: four groups of eight, strong inside and weak between', () => {
  const { ids, edges } = blockMesh();
  const p = W.partitionIslands(ids, edges);
  assert.equal(p.ok, true, p.reason);
  assert.deepEqual(p.islands.map((i) => i.size), [8, 8, 8, 8]);
  assert.deepEqual(p.dust, []);
  // Each island is exactly one of the groups.
  for (const island of p.islands) {
    const group = new Set(island.neurons.map((n) => Math.floor(n / 8)));
    assert.equal(group.size, 1, `${island.id} mixes groups`);
  }
  assert.ok(p.threshold > 0.1 && p.threshold <= 1, `the cut sits above the weak links, at ${p.threshold}`);
  assert.ok(p.insideMass > 0.7, `most of the weight is inside the islands (${p.insideMass})`);
});

test('the same mesh always splits the same way, whatever order its connections arrive in', () => {
  const { ids, edges } = blockMesh(3, 6, 3);
  const shuffled = [...edges];
  const rnd = lcg(9);
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const a = W.partitionIslands(ids, edges);
  const b = W.partitionIslands([...ids].reverse(), shuffled);
  assert.deepEqual(a.islands, b.islands);
  assert.equal(a.threshold, b.threshold);
  assert.deepEqual(a.islands.map((i) => i.id), ['island-1', 'island-2', 'island-3']);
});

test('a mesh wired all-to-all with random weights has no islands, and says so instead of guessing', () => {
  const { ids, edges } = randomMesh();
  const p = W.partitionIslands(ids, edges);
  assert.equal(p.ok, false);
  assert.match(p.reason, /no real structure|no threshold/);
  assert.equal(W.islandLabels(p).size, 0, 'a split that is not ok labels nothing');
  assert.deepEqual(W.describeIslands(p, () => ['x']), []);
});

test('pieces that are genuinely cut off from each other are islands, and a stray pair is dust (core, always on)', () => {
  const link = (a, b) => [{ from: a, to: b, weight: 0.8 }, { from: b, to: a, weight: 0.8 }];
  const edges = [
    ...link(0, 1), ...link(1, 2), ...link(2, 3), ...link(3, 4),        // five in a chain
    ...link(10, 11), ...link(11, 12), ...link(12, 13),                  // four in a chain
    ...link(20, 21),                                                    // a pair
  ];
  const ids = [0, 1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 30];
  const p = W.partitionIslands(ids, edges, { maxShare: 0.6 });
  assert.equal(p.ok, true, p.reason);
  assert.deepEqual(p.islands.map((i) => i.neurons), [[0, 1, 2, 3, 4], [10, 11, 12, 13]]);
  assert.deepEqual(p.dust, [20, 21, 30]);
  // Eight links in all (4 + 3 in the chains, 1 in the pair), all equally strong; seven of them are inside an island.
  assert.ok(Math.abs(p.insideMass - 7 / 8) < 1e-9, `insideMass ${p.insideMass}`);
});

test('too few neurons, or no connections, is "not ok" with a reason, never a throw', () => {
  assert.equal(W.partitionIslands([1, 2, 3], [{ from: 1, to: 2, weight: 1 }]).ok, false);
  assert.match(W.partitionIslands([], []).reason, /too few/);
  const lonely = W.partitionIslands(Array.from({ length: 12 }, (_, i) => i), []);
  assert.equal(lonely.ok, false);
  assert.match(lonely.reason, /no connections/);
  const junk = W.partitionIslands([1, 2, 3, 4, 5, 6], [{ from: 1, to: 2, weight: NaN }, { from: 1, to: 99, weight: 1 }, { from: 3, to: 3, weight: 1 }]);
  assert.equal(junk.ok, false);
});

test('labelling neurons by island changes no wiring, and a split that is not ok labels nothing', () => {
  const { ids, edges } = blockMesh(2, 6, 4);
  const nodes = ids.map((id) => ({ id, connections: new Map(edges.filter((e) => e.from === id).map((e) => [e.to, e.weight])) }));
  const snapshot = JSON.stringify(nodes.map((n) => [n.id, [...n.connections]]));
  const p = W.partitionNodes(nodes);
  assert.equal(p.ok, true, p.reason);
  const labelled = new Map();
  const count = W.applyIslandLabels({ setNeuronGroup: (id, g) => { labelled.set(id, g); return true; } }, p);
  assert.equal(count, 12);
  assert.equal(new Set(labelled.values()).size, 2);
  assert.equal(JSON.stringify(nodes.map((n) => [n.id, [...n.connections]])), snapshot, 'every connection is exactly as it was');
  const bad = W.partitionIslands(randomMesh().ids, randomMesh().edges);
  assert.equal(W.applyIslandLabels({ setNeuronGroup: () => true }, bad), 0);
});

/** Four islands labelled with skill regions, and how relevant each skill is to the message. */
function fourIslands() {
  const { ids, edges } = blockMesh();
  const p = W.partitionIslands(ids, edges);
  const regionOf = (id) => [['email', 'files', 'maths', 'chat'][Math.floor(id / 8)]];
  return W.describeIslands(p, regionOf);
}

test('an island is about the best skill region it carries, and an island with none is about nothing', () => {
  const infos = fourIslands();
  assert.deepEqual(infos.map((i) => Object.keys(i.groups)), [['email'], ['files'], ['maths'], ['chat']]);
  const scores = W.scoreIslands(infos, (g) => ({ maths: 0.7, files: 0.1 })[g] ?? 0);
  assert.deepEqual(scores.map((s) => s.relevance), [0, 0.1, 0.7, 0]);
  const unlabelled = W.scoreIslands([{ id: 'island-9', neurons: [1], size: 1, links: 0, groups: {} }], () => 1);
  assert.equal(unlabelled[0].relevance, 0);
});

test('every island that is about the message runs, whatever the budget; the budget then adds more, most relevant first', () => {
  const infos = fourIslands();
  const scores = W.scoreIslands(infos, (g) => ({ maths: 0.7, files: 0.3, email: 0.1 })[g] ?? 0);
  const low = W.planIslands(infos, scores, { share: 0.1 });
  assert.deepEqual(low.run.sort(), ['island-2', 'island-3', 'island-1'].sort(), 'maths, files and email are all relevant, so all three run despite a 10% budget');
  assert.deepEqual(low.off, ['island-4']);
  assert.equal(low.runNeurons, 24);
  assert.equal(low.ranAll, false);

  const onlyOne = W.scoreIslands(infos, (g) => (g === 'maths' ? 0.7 : 0));
  const tight = W.planIslands(infos, onlyOne, { share: 0.25 });
  assert.deepEqual(tight.run, ['island-3']);
  const wider = W.planIslands(infos, onlyOne, { share: 0.75 });
  assert.equal(wider.run.length, 3);
  assert.ok(wider.run.includes('island-3'));
  const everything = W.planIslands(infos, onlyOne, { share: 1 });
  assert.equal(everything.ranAll, true);
  assert.deepEqual(everything.off, []);
});

test('nothing recognised means everything runs, and instant keeps only the single best island', () => {
  const infos = fourIslands();
  const nothing = W.scoreIslands(infos, () => 0);
  const plan = W.planIslands(infos, nothing, { share: 0.1 });
  assert.equal(plan.ranAll, true);
  assert.match(plan.reason, /nothing recognised/);

  const scores = W.scoreIslands(infos, (g) => ({ maths: 0.7, files: 0.3 })[g] ?? 0);
  const instant = W.planIslands(infos, scores, { share: 1, instant: true });
  assert.deepEqual(instant.run, ['island-3']);
  assert.equal(instant.off.length, 3);
  const empty = W.planIslands([], [], { share: 0.5 });
  assert.equal(empty.ranAll, true);
  assert.deepEqual(empty.run, []);
});

/* --------------------------------------------------------- prompt optimizer */

test('optimize takes filler, repeats and stray spacing out and adds nothing', () => {
  const r = P.optimizePrompt('hey so basically   what is the the capital of France???   \n\n\n\n');
  assert.equal(r.changed, true);
  assert.equal(r.text, 'what is the capital of France?');
  assert.ok(r.savedChars > 0);
  assert.ok(r.changes.some((c) => /filler opening/.test(c)));
  assert.ok(r.changes.some((c) => /twice/.test(c)));
});

test('optimize removes a sentence or a line repeated straight after itself, and keeps what was said once', () => {
  assert.equal(P.optimizePrompt('Summarise this report. Summarise this report. Keep it under 100 words.').text, 'Summarise this report. Keep it under 100 words.');
  assert.equal(P.optimizePrompt('fix the login bug\nfix the login bug\nthen add a test').text, 'fix the login bug\nthen add a test');
  const apart = 'fix the login bug\n\nfix the login bug';
  assert.equal(P.optimizePrompt(apart).changed, false, 'a repeat with a gap between is left alone');
});

test('optimize leaves code, real double words and ellipses exactly as they were', () => {
  const code = 'run this:\n```js\nconst  a  =  1;\nconst  a  =  1;\n```\nand tell me what  it prints';
  const r = P.optimizePrompt(code);
  assert.ok(r.text.includes('```js\nconst  a  =  1;\nconst  a  =  1;\n```'), 'fenced code is untouched');
  assert.ok(r.text.endsWith('and tell me what it prints'));
  const indented = 'see:\n    x  =  1\n    x  =  1\nok';
  assert.equal(P.optimizePrompt(indented).text, indented);
  assert.equal(P.optimizePrompt('I know that that is odd, and he had had enough... wait').changed, false);
});

test('optimize never returns nothing, never grows a message, and never uses a word that was not typed', () => {
  assert.equal(P.optimizePrompt('hello').text, 'hello', 'a bare greeting is not filler');
  assert.equal(P.optimizePrompt('so what').text, 'so what');
  assert.equal(P.optimizePrompt('').changed, false);
  assert.equal(P.optimizePrompt(undefined).text, '');
  assert.equal(P.optimizePrompt(42).text, '');
  const long = 'word '.repeat(P.OPTIMIZE_MAX_CHARS);
  assert.equal(P.optimizePrompt(long).text, long, 'a document is passed through untouched');
  const samples = [
    'um, so   could you could you explain how a hash map handles collisions??? thanks',
    'hey hey  write a haiku about rain.  write a haiku about rain.',
    'ok well basically   compare  python and  rust\n\n\n\nfor web servers',
    'What does `a  ||  b` do in JS?',
  ];
  for (const s of samples) {
    const r = P.optimizePrompt(s);
    assert.ok(r.text.length <= s.length, s);
    assert.ok(r.text.length > 0, s);
    const typed = new Set(s.toLowerCase().match(/[a-z']+/g));
    for (const w of r.text.toLowerCase().match(/[a-z']+/g) ?? []) assert.ok(typed.has(w), `"${w}" was not in "${s}"`);
  }
});

/* ------------------------------------------------------------------ effort */

const SMALL = 'what time is it in Tokyo?';
const BIG = 'Design and implement a rate limiter for our API, then write the tests, and finally explain the trade-offs step by step.';
const HARD = 'Prove carefully that sqrt(2) is irrational and double-check each step. Explain the edge cases.';

test('only a real true turns a switch on, and instant brings auto with it', () => {
  assert.deepEqual(A.parseAutoRoute({ auto: true, instant: false, optimize: true, effort: '70' }), { auto: true, instant: false, optimize: true, effort: 70 });
  assert.deepEqual(A.parseAutoRoute({ auto: 'true', instant: 1, optimize: 'yes' }), { auto: false, instant: false, optimize: false, effort: null });
  assert.equal(A.parseAutoRoute({ instant: true }).auto, true);
  for (const junk of [null, undefined, 'x', 5, []]) assert.equal(A.parseAutoRoute(junk).auto, false);
});

test('effort rises with how big and how careful the job looks, and drops when the person asks for it quick', () => {
  const level = (t) => A.estimateEffort(t).level;
  assert.ok(level('hi') < 15, 'small talk');
  assert.ok(level(SMALL) >= 15 && level(SMALL) < 40, 'a plain question is light');
  assert.ok(level(BIG) >= 70, `a build with several parts is thorough (${level(BIG)})`);
  assert.ok(level(HARD) >= 70, `a careful proof is thorough (${level(HARD)})`);
  assert.ok(level(HARD) > level(SMALL) && level(SMALL) > level('hi'));
  assert.ok(level('briefly, ' + SMALL) < level(SMALL), 'asking for it quick lowers it');
  for (const t of ['', ' ', 'x'.repeat(5000), '???']) { const l = level(t); assert.ok(Number.isInteger(l) && l >= 0 && l <= 100); }
  assert.ok(A.estimateEffort(BIG).reasons.length > 0, 'it says why');
});

/* ----------------------------------------------------------------- compute */

const device = (over = {}) => ({ kind: 'desktop', platform: 'linux', cores: 8, totalMemBytes: 32 * GB, freeMemBytes: 24 * GB, load: 0.1, mops: 6000, battery: null, online: true, ...over });
const weakPhone = device({ kind: 'phone', platform: 'android', totalMemBytes: 6 * GB, freeMemBytes: 3 * GB, load: 0.3, mops: 300, battery: { level: 0.2, charging: false } });

test('more effort runs more of the network, and a busy or low device runs less', () => {
  const share = (e, d = device(), instant = false) => A.computeShare(e, d, instant).share;
  const rising = [0, 25, 50, 75, 89].map((e) => share(e));
  for (let i = 1; i < rising.length; i++) assert.ok(rising[i] >= rising[i - 1]);
  assert.ok(share(0) >= 0.1 && share(0) < 0.2);
  assert.equal(share(100), 1, 'top effort on a device with room runs everything');
  assert.ok(share(100, device({ load: 1 })) < 1, 'a flat-out processor never runs everything');
  assert.ok(share(100, weakPhone) < 1, 'a low unplugged battery never runs everything');
  assert.ok(share(60, device({ load: 1 })) < share(60), 'busy means less');
  assert.ok(share(60, device({ battery: { level: 0.1, charging: true } })) === share(60), 'charging is not a drain');
  assert.ok(share(100, device(), true) <= 0.25, 'instant is capped at a quarter');
  assert.ok(A.computeShare(100, device({ load: 1 }), false).reasons.join(' ').match(/busy/));
});

/* -------------------------------------------------------------------- plan */

const request = (over = {}) => ({ auto: true, instant: false, optimize: false, effort: null, ...over });
const input = (prompt, dev, over = {}) => ({
  prompt, device: dev, remote: { available: true }, fullModelBytes: 4 * GB, quantizedModelBytes: 1 * GB, request: request(), ...over,
});

test('a weak phone hands a big job to the bigger computer, with the effort the job needs, and keeps a small one', () => {
  const big = A.planRoute(input(BIG, weakPhone));
  assert.equal(big.where, 'cloud');
  assert.equal(big.engine, 'remote');
  assert.equal(big.effort.source, 'auto');
  assert.ok(big.effort.level >= 70);
  const small = A.planRoute(input(SMALL, weakPhone));
  assert.equal(small.where, 'local');
  assert.equal(small.engine, 'local-quantized');
  assert.ok(small.effort.level < 40);
  assert.ok(big.reasons.some((r) => /bigger computer runs the whole network/.test(r)));
});

test('instant answers fast: lowest effort, the lightest local engine even when the job would have gone away, no tidy-up', () => {
  const plan = A.planRoute(input(BIG, weakPhone, { request: request({ instant: true, optimize: true }) }));
  assert.equal(plan.mode, 'instant');
  assert.equal(plan.effort.level, 5);
  assert.equal(plan.effort.source, 'instant');
  assert.equal(plan.engine, 'local-quantized');
  assert.equal(plan.where, 'local');
  assert.equal(plan.prompt.changed, false, 'instant does not spend a tidy-up');
  assert.ok(plan.compute.share <= 0.25);
});

test('a dial set by hand wins over the estimate, and instant wins over the dial', () => {
  const manual = A.planRoute(input(SMALL, device(), { request: request({ effort: 95 }) }));
  assert.equal(manual.effort.level, 95);
  assert.equal(manual.effort.source, 'manual');
  assert.equal(manual.mode, 'manual-effort');
  assert.equal(manual.effort.tryAnother, true);
  const both = A.planRoute(input(SMALL, device(), { request: request({ effort: 95, instant: true }) }));
  assert.equal(both.effort.level, 5);
});

test('a message that looks like it holds a secret never leaves the device, however big and however weak the phone', () => {
  const secret = `${BIG}\nmy api key is sk-live_abcdefghijklmnop1234567890`;
  const plan = A.planRoute(input(secret, weakPhone));
  assert.notEqual(plan.engine, 'remote');
  assert.equal(plan.where, 'local');
});

test('optimize tidies the prompt that is sent, but the chooser still reads what was typed', () => {
  const typed = 'hey so basically   ' + BIG + '???';
  const plan = A.planRoute(input(typed, device(), { request: request({ optimize: true }) }));
  assert.equal(plan.prompt.changed, true);
  assert.ok(!plan.prompt.text.startsWith('hey so'));
  assert.equal(plan.prompt.original, typed);
  const off = A.planRoute(input(typed, device()));
  assert.equal(off.prompt.changed, false, 'off means untouched');
});

/** Islands for a plan: maths is the skill this message is about. */
const islands = fourIslands();
const mathsScore = (g) => ({ maths: 0.7 })[g] ?? 0;

test('on this device a low effort runs only the island the message needs, and top effort runs them all', () => {
  const low = A.planRoute(input(SMALL, device(), { islands, regionScore: mathsScore, request: request({ effort: 5 }) }));
  assert.deepEqual(low.compute.islands.run, ['island-3']);
  assert.deepEqual([...low.compute.activeGroups], ['island-3']);
  const high = A.planRoute(input(BIG, device(), { islands, regionScore: mathsScore, request: request({ effort: 100 }) }));
  assert.equal(high.compute.islands.ranAll, true);
  assert.equal(high.compute.activeGroups, undefined, 'ungated: everything computes');
  const none = A.planRoute(input(BIG, device()));
  assert.equal(none.compute.islands, null, 'no known islands, no gating');
  assert.ok(none.reasons.some((r) => /whole network runs/.test(r)));
});

test('no islands are switched off here when a bigger computer does the answering', () => {
  const plan = A.planRoute(input(BIG, weakPhone, { islands, regionScore: mathsScore }));
  assert.equal(plan.where, 'cloud');
  assert.equal(plan.compute.islands, null);
  assert.equal(plan.compute.activeGroups, undefined);
});

test('the summary is small, plain JSON, and carries the reasons', () => {
  const plan = A.planRoute(input(BIG, device(), { islands, regionScore: mathsScore, request: request({ optimize: true }) }));
  const s = A.routeSummary(plan, plan.prompt.changed ? plan.prompt.text : BIG);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.where, 'local');
  assert.equal(typeof s.effort.level, 'number');
  assert.ok(Array.isArray(s.compute.islandsRun));
  assert.ok(s.reasons.length > 0);
});

/* --------------------------------------------------------------------- run */

function deps(over = {}) {
  const calls = { borrow: [], saved: 0 };
  const d = {
    probe: async () => weakPhone,
    remote: () => ({ available: true, peerId: 'peer1' }),
    borrow: async (id, prompt) => { calls.borrow.push([id, prompt]); return { result: 'the big answer' }; },
    chooser: new Chooser(),
    save: () => { calls.saved++; },
    modelBytes: () => ({ full: 4 * GB, quantized: 1 * GB }),
    now: (() => { let t = 0; return () => (t += 500); })(),
    ...over,
  };
  return { d, calls };
}

test('a big job from a weak phone really runs on the peer, with the tidied prompt, and the chooser learns from it', async () => {
  const { d, calls } = deps();
  const before = [...d.chooser.weights.remote];
  const typed = 'hey so basically   ' + BIG;
  const r = await A.runAutoRoute(typed, [], request({ optimize: true }), {}, d, true);
  assert.equal(r.answer, 'the big answer');
  assert.equal(calls.borrow.length, 1);
  assert.equal(calls.borrow[0][0], 'peer1');
  assert.ok(!calls.borrow[0][1].startsWith('hey so'), 'the peer is sent the tidied prompt');
  assert.equal(r.prompt, calls.borrow[0][1]);
  assert.equal(calls.saved, 1);
  assert.notDeepEqual(d.chooser.weights.remote, before);
});

test('with borrowing off (the default) a big job is never sent to another computer, whatever Auto says', async () => {
  delete process.env.NEUROCLAW_CHOOSER;
  const { d, calls } = deps();
  const r = await A.runAutoRoute(BIG, [], request(), {}, d);
  assert.equal(r.answer, null);
  assert.equal(calls.borrow.length, 0, 'nothing left this device');
  assert.equal(r.plan.where, 'local');
  assert.ok(r.plan.reasons.some((x) => /borrowing is off/.test(x)));
  assert.ok(r.plan.effort.level >= 70, 'effort and processor are still picked');
  process.env.NEUROCLAW_CHOOSER = '1';
  try {
    const on = await A.runAutoRoute(BIG, [], request(), {}, deps().d);
    assert.equal(on.answer, 'the big answer', 'the owner opted in, so it may borrow');
  } finally { delete process.env.NEUROCLAW_CHOOSER; }
});

test('a small message is answered here, and how that went teaches the chooser', async () => {
  const { d, calls } = deps();
  const before = [...d.chooser.weights['local-quantized']];
  const r = await A.runAutoRoute('hi', [], request(), {}, d, true);
  assert.equal(r.answer, null);
  assert.equal(calls.borrow.length, 0);
  assert.equal(r.plan.effort.level, 5);
  r.finish(true, 200);
  assert.notDeepEqual(d.chooser.weights['local-quantized'], before);
});

test('a peer that fails is a note and an answer here, never an error', async () => {
  const { d } = deps({ borrow: async () => { throw new Error('peer down'); } });
  const r = await A.runAutoRoute(BIG, [], request(), {}, d, true);
  assert.equal(r.answer, null);
  assert.match(r.notes.join(' '), /remote computer failed \(peer down\)/);
});

test('a device that cannot be read is answered locally with the effort still picked', async () => {
  const { d, calls } = deps({ probe: async () => { throw new Error('no sensors'); } });
  const r = await A.runAutoRoute(BIG, [], request(), {}, d, true);
  assert.equal(r.answer, null);
  assert.equal(calls.borrow.length, 0);
  assert.match(r.notes.join(' '), /could not read this device/);
  assert.ok(r.plan.effort.level >= 70);
});

test('NEUROCLAW_AUTO_ROUTE=1 switches it on for the whole install', () => {
  delete process.env.NEUROCLAW_AUTO_ROUTE;
  assert.equal(A.autoRouteForced(), false);
  process.env.NEUROCLAW_AUTO_ROUTE = '1';
  try { assert.equal(A.autoRouteForced(), true); } finally { delete process.env.NEUROCLAW_AUTO_ROUTE; }
});
