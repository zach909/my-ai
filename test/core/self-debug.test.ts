/**
 * Self-debug (models && skills/core/self-debug.ts): find what goes wrong, look at the weights,
 * edit them a little, check better or worse, keep going; make a skill or a plugin proposal when
 * weights cannot fix it.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { netMaker, type BuiltNet } from '../../models && skills/core/neuro-build';
import { WeightEditor, MAX_NUDGE } from '../../models && skills/core/weight-editor';
import { MistakeTracker } from '../../models && skills/core/mistake-tracker';
import {
  SelfDebugger, WeightLedger, casesFromNet, casesFromMistakes, normalizeCases, scoreSuite, summarize,
  makePluginSource, vetPluginSource, MAX_LEDGER, PLUGIN_THRESHOLD,
  type DebugCase, type SkillMaker, type PluginProposer,
} from '../../models && skills/core/self-debug';

const SRC = `neurons="8"\n"n1"@input="hello"\n"n1"@response="hi there"\n"n2"@input="goodbye"\n"n2"@response="see you later"\n"n3"@input="thanks"\n"n3"@response="you are welcome"`;

async function made(src = SRC): Promise<BuiltNet> {
  return (await netMaker(src, { dimensions: 32 })).net!;
}

const stateOf = (net: BuiltNet) => JSON.stringify(net.engine.captureNetworkState());
/** The learned numbers only: running a net moves its activations, which are not weights. */
const weightsOf = (net: BuiltNet) => { const s = JSON.parse(stateOf(net)); return { connDiag: s.connDiag, connShift: s.connShift, bias: s.bias }; };

describe('cases and scoring', () => {
  it('turns the net\'s own declared responses into cases and scores them without changing the net', async () => {
    const net = await made();
    const cases = casesFromNet(net);
    expect(cases.map(c => c.expect).sort()).toEqual(['hi there', 'see you later', 'you are welcome']);
    const before = stateOf(net);
    const scores = scoreSuite(net, cases);
    expect(scores).toHaveLength(3);
    expect(scores.every(s => s.loss > 0 && s.loss < 1)).toBe(true);
    // Reading does not train: weights are the same afterwards (activations may differ, so compare the weights only).
    const w = (s: string) => JSON.parse(s).connDiag;
    expect(w(stateOf(net))).toEqual(w(before));
  });

  it('only uses mistakes that say what the right answer was, and only repeated ones', () => {
    const t = new MistakeTracker();
    t.record({ task: 'what is 2+2', description: 'said 5', expected: 'four' });
    t.record({ task: 'what is 2+2', description: 'said 5 again', expected: 'four' });
    t.record({ task: 'capital of nowhere', description: 'no idea' });
    t.record({ task: 'capital of nowhere', description: 'no idea' });
    t.record({ task: 'once only', description: 'x', expected: 'y' });
    const cases = casesFromMistakes(t.all());
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ text: 'what is 2+2', expect: 'four', source: 'mistake' });
  });

  it('drops empty cases, makes ids unique and bounds the count', () => {
    const out = normalizeCases([
      { id: 'a', text: 'x', expect: 'y', source: 'user' }, { id: 'a', text: 'x2', expect: 'y2', source: 'user' },
      { id: 'b', text: '', expect: 'y', source: 'user' }, { id: 'c', text: 'x', expect: '  ', source: 'user' },
    ]);
    expect(out.map(c => c.id)).toEqual(['a', "a'"]);
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, text: `t${i}`, expect: `e${i}`, source: 'user' as const }));
    expect(normalizeCases(many).length).toBeLessThanOrEqual(64);
  });
});

describe('the loop', () => {
  it('finds weak answers, edits the weights, and ends with less error and nothing broken', async () => {
    const net = await made();
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.6, maxRounds: 40 });

    expect(s.before.confident).toBeLessThan(s.after.confident);
    expect(s.after.totalLoss).toBeLessThan(s.before.totalLoss);
    expect(s.after.correct).toBeGreaterThanOrEqual(s.before.correct);
    expect(s.restored).toBe(false);
    expect(s.rounds.length).toBeGreaterThan(0);
    // Nothing that was right was ever kept broken.
    expect(s.rounds.filter(r => r.verdict === 'kept').every(r => r.flipped.length === 0)).toBe(true);
    // Every nudge is bounded; a retrain lists no edits.
    for (const r of s.rounds) {
      if (r.kind === 'nudge') expect(r.edits.every(e => Math.abs(e.after - e.before) <= MAX_NUDGE + 1e-6)).toBe(true);
      else expect(r.edits).toEqual([]);
    }
    // The two voices both spoke, and the critic gave a verdict each round.
    expect(new Set(s.dialogue.map(x => x.speaker))).toEqual(new Set(['debugger', 'critic']));
    expect(s.dialogue.some(x => /^Keep/.test(x.text))).toBe(true);
    expect(d.history()).toHaveLength(1);
  });

  it('leaves a net that already passes alone', async () => {
    const net = await made();
    const before = weightsOf(net);
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0 });
    expect(s.rounds).toEqual([]);
    expect(s.stopReason).toBe('all-correct');
    expect(weightsOf(net)).toEqual(before);
  });

  it('remembers which weights carried a big share and which edits helped', async () => {
    const net = await made();
    const d = new SelfDebugger();
    await d.debug('t', net, casesFromNet(net), { minCosine: 0.6 });
    const top = d.ledger.top(5);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].examined).toBeGreaterThan(0);
    expect(top.some(r => r.bigInput > 0)).toBe(true);
    const edited = top.find(r => r.edits > 0)!;
    expect(d.ledger.trust(edited.key)).toBeGreaterThan(0.5);
  });

  it('refuses to edit a frozen output neuron and changes no weight', async () => {
    const net = await made();
    net.freeze('n8');
    const before = weightsOf(net);
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.9 });
    expect(s.problems.length).toBeGreaterThan(0);
    expect(s.problems.every(p => p.outcome === 'refused')).toBe(true);
    expect(s.rounds).toEqual([]);
    expect(weightsOf(net)).toEqual(before);
  });

  it('undoes an edit that does not help and never ends worse than it began', async () => {
    const net = await made();
    // An editor that pushes every weight the WRONG way: every nudge round must be undone.
    class Backwards extends WeightEditor {
      override nudge(target: string, source: string, dim: number, delta: number, reason = '') { return super.nudge(target, source, dim, -delta, reason); }
    }
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.9, maxRounds: 20 }, new Backwards(net));
    const nudges = s.rounds.filter(r => r.kind === 'nudge');
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges.every(r => r.verdict === 'undone')).toBe(true);
    expect(nudges.every(r => r.caseLossAfter === r.caseLossBefore)).toBe(true);
    expect(s.after.totalLoss).toBeLessThanOrEqual(s.before.totalLoss + 1e-9);
    expect(s.after.correct).toBeGreaterThanOrEqual(s.before.correct);
    expect(s.dialogue.some(x => x.speaker === 'critic' && /^Undo/.test(x.text))).toBe(true);
  });

  it('rejects a change that fixes one case by breaking another', async () => {
    const net = await made();
    const d = new SelfDebugger();
    // Two cases that want different answers for the same typed text cannot both be right.
    const cases: DebugCase[] = [
      ...casesFromNet(net),
      { id: 'user:conflict', text: 'hello', expect: 'see you later', drive: 'n1', source: 'user' },
    ];
    const s = await d.debug('t', net, cases, { minCosine: 0.6, maxRounds: 30 });
    expect(s.rounds.filter(r => r.verdict === 'kept').every(r => r.flipped.length === 0)).toBe(true);
    expect(s.after.correct).toBeGreaterThanOrEqual(s.before.correct);
  });

  it('stops when the round budget is spent, and says so', async () => {
    const net = await made();
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.99, maxRounds: 2 });
    expect(s.rounds.length).toBeLessThanOrEqual(2);
    expect(s.stopReason).toBe('budget');
  });

  it('records the problem it ran out of budget on, and the ones it never reached', async () => {
    const net = await made();
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.99, maxRounds: 1 });
    expect(s.stopReason).toBe('budget');
    expect(s.problems).toHaveLength(3); // every failing case is in the report
    expect(s.problems.some(p => p.outcome === 'untried')).toBe(true);
  });

  it('does not make a skill for a problem that only ran out of budget', async () => {
    const net = await made();
    let calls = 0;
    const makeSkill: SkillMaker = async () => { calls++; return { ok: true, converged: true, detail: '' }; };
    const wrong: DebugCase[] = [{ id: 'user:x', text: 'hello', expect: 'completely unrelated answer', drive: 'n1', source: 'user' }];
    await new SelfDebugger({ makeSkill }).debug('t', net, wrong, { maxRounds: 1 });
    expect(calls).toBe(0);
  });

  it('refuses a second run while one is in progress', async () => {
    const net = await made();
    const d = new SelfDebugger();
    const first = d.debug('t', net, casesFromNet(net), { minCosine: 0.9 });
    await expect(d.debug('t', net, casesFromNet(net))).rejects.toThrow(/already in progress/);
    await first;
    await expect(d.debug('t', net, casesFromNet(net), { minCosine: 0 })).resolves.toBeDefined();
  });

  it('puts the network back exactly if something throws mid-run', async () => {
    const net = await made();
    const before = weightsOf(net);
    class Boom extends WeightEditor {
      override view(): never { throw new Error('boom'); }
    }
    const d = new SelfDebugger();
    const s = await d.debug('t', net, casesFromNet(net), { minCosine: 0.9 }, new Boom(net));
    expect(s.stopReason).toBe('error');
    expect(s.restored).toBe(true);
    expect(weightsOf(net)).toEqual(before);
    expect(d.isRunning()).toBe(false);
  });
});

describe('skills and plugin proposals', () => {
  // Same text, different answers: no weights can satisfy all of them, so the loop must reach for a skill.
  const contradictions = (n: number): DebugCase[] =>
    Array.from({ length: n }, (_, i) => ({ id: `user:c${i}`, text: 'hello', expect: `answer number ${i} is different`, drive: 'n1', source: 'user' as const }));

  it('makes a skill from what the weights could not be nudged into, and says which problems it covers', async () => {
    const net = await made();
    const specs: string[] = [];
    const makeSkill: SkillMaker = async spec => { specs.push(JSON.stringify(spec)); return { ok: true, converged: true, id: 'skill-x', detail: 'ok' }; };
    const d = new SelfDebugger({ makeSkill });
    const s = await d.debug('t', net, contradictions(2), { maxRounds: 30 });
    expect(s.skills).toHaveLength(1);
    expect(s.skills[0].ok).toBe(true);
    const spec = JSON.parse(specs[0]);
    expect(spec.sources).toContain('self-debug');
    expect(spec.scripts.length).toBeGreaterThan(0);
    expect(s.problems.some(p => p.outcome === 'skill')).toBe(true);
    expect(d.actions.history().some(a => a.action.startsWith('skill:create:') && a.result === 'success')).toBe(true);
  });

  it('does not count a skill the maker refused', async () => {
    const net = await made();
    const makeSkill: SkillMaker = async () => ({ ok: false, converged: false, detail: 'two scripts disagree' });
    const s = await new SelfDebugger({ makeSkill }).debug('t', net, contradictions(2), { maxRounds: 30 });
    expect(s.skills[0]).toMatchObject({ ok: false, trained: false });
    expect(s.problems.some(p => p.outcome === 'skill')).toBe(false);
    expect(s.dialogue.some(x => /NOT kept/.test(x.text))).toBe(true);
  });

  it('keeps a skill whose training did not converge, and says so rather than claiming it trained', async () => {
    const net = await made();
    const makeSkill: SkillMaker = async () => ({ ok: true, converged: false, id: 's', detail: 'saved; training reproduced 0 of 2' });
    const s = await new SelfDebugger({ makeSkill }).debug('t', net, contradictions(2), { maxRounds: 30 });
    expect(s.skills[0]).toMatchObject({ ok: true, trained: false });
    expect(s.problems.some(p => p.outcome === 'skill')).toBe(true);
  });

  it('never makes a skill for a right-but-weak answer, only for a wrong one', async () => {
    const net = await made();
    let calls = 0;
    const makeSkill: SkillMaker = async () => { calls++; return { ok: true, converged: true, detail: '' }; };
    const s = await new SelfDebugger({ makeSkill }).debug('t', net, casesFromNet(net), { minCosine: 0.99, maxRounds: 10 });
    expect(s.problems.some(p => p.outcome === 'weak')).toBe(true);
    expect(calls).toBe(0);
  });

  it('proposes a plugin after enough skills, installed OFF, and only the owner can turn it on', async () => {
    const net = await made();
    const sources: string[] = [];
    const activated: string[] = [];
    const makeSkill: SkillMaker = async () => ({ ok: true, converged: true, id: 's', detail: 'ok' });
    const proposePlugin: PluginProposer = async (source, spec) => { sources.push(source); return { ok: true, id: spec.id, detail: 'installed, inactive' }; };
    const d = new SelfDebugger({ makeSkill, proposePlugin, activatePlugin: async id => { activated.push(id); } });
    const s = await d.debug('t', net, contradictions(PLUGIN_THRESHOLD + 1), { maxRounds: 40 });

    expect(s.plugins).toHaveLength(1);
    expect(s.plugins[0]).toMatchObject({ ok: true, pendingApproval: true });
    expect(vetPluginSource(sources[0]).ok).toBe(true);
    expect(activated).toEqual([]); // proposing is not activating
    const [pending] = d.pendingPlugins();
    expect(pending).toBeDefined();

    expect((await d.approvePlugin('nope')).ok).toBe(false);
    expect(d.denyPlugin(pending.id).ok).toBe(true);
    expect(activated).toEqual([]);
    expect(d.pendingPlugins()).toEqual([]);
  });

  it('activates a plugin only after approval, and logs the result', async () => {
    const net = await made();
    const activated: string[] = [];
    const d = new SelfDebugger({
      makeSkill: async () => ({ ok: true, converged: true, detail: 'ok' }),
      proposePlugin: async (_s, spec) => ({ ok: true, id: spec.id, detail: 'ok' }),
      activatePlugin: async id => { activated.push(id); },
    });
    await d.debug('t', net, contradictions(PLUGIN_THRESHOLD + 1), { maxRounds: 40 });
    const [pending] = d.pendingPlugins();
    expect((await d.approvePlugin(pending.id)).ok).toBe(true);
    expect(activated).toEqual([pending.id]);
    expect(d.actions.history().find(a => a.action === `plugin:activate:${pending.id}`)).toMatchObject({ approval: 'approved', result: 'success' });
  });

  it('does nothing about skills or plugins when none are connected', async () => {
    const net = await made();
    const s = await new SelfDebugger().debug('t', net, contradictions(2), { maxRounds: 20 });
    expect(s.skills).toEqual([]);
    expect(s.plugins).toEqual([]);
  });
});

describe('plugin source', () => {
  const spec = { id: 'Self Debug Demo', name: 'Demo', description: 'd', capabilities: ['answer'], table: [{ userSays: 'process the fetch', response: 'run eval(process) now' }] };

  it('is generated from a fixed template, vets clean, and is valid TypeScript', () => {
    const src = makePluginSource(spec);
    expect(vetPluginSource(src)).toEqual({ ok: true, problems: [] });
    const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    expect(out.diagnostics ?? []).toEqual([]);
    expect(src).toContain('extends BasePlugin');
    // Words in the answers are data, not code: they do not trip the vetting.
    expect(src).toContain('run eval(process) now');
  });

  it('refuses anything outside the template', () => {
    const base = makePluginSource(spec);
    expect(vetPluginSource(base + '\nimport fs from "node:fs";').ok).toBe(false);
    const outside = ['left', 'pad'].join('-'); // built, so this file itself holds no import of an outside package
    expect(vetPluginSource(base + '\n' + ['import', 'x', 'from'].join(' ') + ' "' + outside + '";').ok).toBe(false);
    expect(vetPluginSource(base + '\nconst x = require("fs");').ok).toBe(false);
    expect(vetPluginSource(base + '\neval("1");').ok).toBe(false);
    expect(vetPluginSource(base + '\nprocess.exit(1);').ok).toBe(false);
    expect(vetPluginSource(base + '\nfetch("http://x");').ok).toBe(false);
    expect(vetPluginSource(base + '\nconst t = `${1}`;').ok).toBe(false);
    expect(vetPluginSource(base + '\nconst c = ({}).constructor;').ok).toBe(false);
    expect(vetPluginSource(base + '\nconst m = await ' + 'import' + '("' + outside + '");').ok).toBe(false);
  });

  it('bounds what goes in: row count and text length', () => {
    const big = { ...spec, table: Array.from({ length: 500 }, (_, i) => ({ userSays: 'q'.repeat(5000) + i, response: 'a'.repeat(5000) })) };
    const src = makePluginSource(big);
    expect(src.length).toBeLessThan(200_000);
    expect(vetPluginSource(src).ok).toBe(true);
  });
});

describe('weight ledger', () => {
  it('trusts what helped, distrusts what was undone, and round-trips through JSON', () => {
    const l = new WeightLedger();
    expect(l.trust('a')).toBe(0.5);
    l.edited('a', true, 0.1); l.edited('a', true, 0.1);
    l.edited('b', false, 0); l.edited('b', false, 0);
    expect(l.trust('a')).toBeGreaterThan(0.5);
    expect(l.trust('b')).toBeLessThan(0.5);
    l.examine('a', 0.4); l.examine('a', 0.1);
    expect(l.get('a')).toMatchObject({ examined: 2, bigInput: 1, edits: 2, kept: 2 });
    const back = WeightLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    expect(back.get('a')).toEqual(l.get('a'));
  });

  it('is bounded, and ignores junk when loading', () => {
    const l = new WeightLedger();
    for (let i = 0; i < MAX_LEDGER + 50; i++) l.examine(`k${i}`, 0.1);
    expect(l.size()).toBeLessThanOrEqual(MAX_LEDGER);
    const loaded = WeightLedger.fromJSON([{ key: 'ok', examined: 3 }, null, 5, { key: 7 }, { key: 'neg', examined: -4, edits: NaN }]);
    expect(loaded.get('ok')?.examined).toBe(3);
    expect(loaded.get('neg')).toMatchObject({ examined: 0, edits: 0 });
    expect(loaded.size()).toBe(2);
    expect(WeightLedger.fromJSON('nonsense').size()).toBe(0);
  });
});

it('summarize counts right and clear answers', async () => {
  const net = await made();
  const s = summarize(scoreSuite(net, casesFromNet(net), 0));
  expect(s).toMatchObject({ cases: 3, correct: 3, confident: 3 });
});
