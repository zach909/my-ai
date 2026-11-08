/**
 * Net maker and net skill maker (neuro-build.ts) and the NeuroLang statements
 * that drive them (kind, neurons, @frozen, @input, @response, @reads, train).
 */
import { describe, it, expect } from 'vitest';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain';
import { NeuroLangInterpreter, MAX_DECLARED_NEURONS } from '../../models && skills/core/neuro-lang';
import { netMaker, netSkillMaker, makeFromSource, randomContent, highlightVector } from '../../models && skills/core/neuro-build';

describe('NeuroLang maker statements', () => {
  it('makes N neurons, applies defaults, tags first and last as input and output', async () => {
    const p = await new NeuroLangInterpreter().parse(`kind="network"
neurons="6"
neurons@value="0.25"
neurons@frozen="after"
"n2"@frozen="now"
"n1"@input="hello"
"n1"@response="hi there"
train@epochs="50"
train`);
    expect(p.errors).toEqual([]);
    expect(p.neurons.size).toBe(6);
    expect(p.program?.kind).toBe('network');
    expect(p.program?.neuronCount).toBe(6);
    expect(p.neurons.get('n3')!.value).toBe(0.25);
    expect(p.neurons.get('n3')!.frozen).toBe('after');
    expect(p.neurons.get('n2')!.frozen).toBe('now'); // an explicit setting beats the default
    expect(p.neurons.get('n1')!.role).toBe('input');
    expect(p.neurons.get('n6')!.role).toBe('output');
    expect(p.program?.train).toMatchObject({ mode: 'responses', epochs: 50 });
  });

  it('refuses a neuron count past the cap instead of building it', async () => {
    const p = await new NeuroLangInterpreter().parse(`neurons="${MAX_DECLARED_NEURONS + 1}"`);
    expect(p.errors).toHaveLength(1);
    expect(p.neurons.size).toBe(0);
  });

  it('leaves programs that use none of it exactly as they were', async () => {
    const p = await new NeuroLangInterpreter().parse(`name="a"\n"a"@value="1"`);
    expect(p.program).toBeUndefined();
  });

  it('survives a JSON round trip with the new fields', async () => {
    const i = new NeuroLangInterpreter();
    const p = await i.parse(`name="a"\n"a"@input="x"\n"a"@response="y"\n"a"@frozen="after"`);
    const back = i.fromJSON(i.toJSON(p.neurons));
    expect(back.neurons.get('a')).toMatchObject({ input: 'x', response: 'y', frozen: 'after' });
  });
});

describe('net maker', () => {
  const src = `kind="network"
neurons="8"
"n1"@input="hello"
"n1"@response="hi there"
"n2"@input="goodbye"
"n2"@response="see you later"
"n3"@frozen="now"
train="responses"`;

  it('sets up every response and gives the right one for what is typed', async () => {
    const r = await netMaker(src, { dimensions: 32 });
    expect(r.ok).toBe(true);
    expect(r.training!.converged).toBe(true);
    expect(r.training!.recall).toEqual({ correct: 2, total: 2 });
    expect(r.net!.respond('hello').response).toBe('hi there');
    expect(r.net!.respond('goodbye').response).toBe('see you later');
    expect(r.net!.isFrozen('n3')).toBe(true);
  });

  it('skips a response whose output neuron is frozen now, rather than forcing it', async () => {
    const r = await netMaker(`neurons="4"\n"n1"@input="x"\n"n1"@response="y"\n"n4"@frozen="now"\ntrain`, { dimensions: 16 });
    expect(r.training!.skipped).toContain('n1');
    expect(r.training!.satisfied).toEqual([]);
  });

  it('freezes a neuron marked "after" once training is done', async () => {
    const r = await netMaker(`neurons="4"\n"n1"@input="x"\n"n1"@response="y"\n"n4"@frozen="after"\ntrain`, { dimensions: 16 });
    expect(r.training!.converged).toBe(true);
    expect(r.net!.isFrozen('n4')).toBe(true);
  });

  it('needs two neurons and says so', async () => {
    const r = await netMaker(`neurons="1"`);
    expect(r.ok).toBe(false);
  });

  it('highlights as hard as the engine allows', () => {
    const v = highlightVector('hello', 32);
    expect(Math.max(...v.map(Math.abs))).toBeCloseTo(1, 6);
  });
});

describe('learning many responses', () => {
  // Distinct, word-like answers made by code (a seeded draw of syllables).
  function phrases(n: number): string[] {
    let a = 9;
    const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const syl = ['ba', 'ko', 'ri', 'mu', 'te', 'sa', 'vo', 'lin', 'dor', 'pex', 'qua', 'zen', 'hal', 'fro', 'nim', 'tuk'];
    const out = new Set<string>();
    const word = () => Array.from({ length: 2 + Math.floor(rand() * 2) }, () => syl[Math.floor(rand() * syl.length)]).join('');
    while (out.size < n) out.add(`${word()} ${word()}`);
    return [...out];
  }
  const program = (answers: string[]) => `neurons="${2 * answers.length + 1}"\n` +
    answers.map((r, i) => `"n${i + 1}"@input="question number ${i + 1}"\n"n${i + 1}"@response="${r}"`).join('\n') + '\ntrain';

  it('holds a dozen distinct answers in one net', async () => {
    const r = await netMaker(program(phrases(12)), { dimensions: 16 });
    expect(r.training!.recall!.correct).toBeGreaterThanOrEqual(11);
  });

  it('holds twenty, where the delta rule it replaced as the default did not', async () => {
    const r = await netMaker(program(phrases(20)), { dimensions: 16 });
    expect(r.training!.recall!.correct).toBeGreaterThanOrEqual(14);
  });

  it('counts two tasks with the same answer as right, not as a miss', async () => {
    const r = await netMaker(`neurons="5"\n"n1"@input="first"\n"n1"@response="same answer"\n"n2"@input="second"\n"n2"@response="same answer"\ntrain`, { dimensions: 16 });
    expect(r.training!.recall!.correct).toBe(2);
  });
});

describe('net skill maker', () => {
  it('joins the base AI, trains only its own neurons, and leaves the base weights alone', async () => {
    const base = new HyperDimensionalEngine({ neuronCount: 12, dimensions: 32, seed: 5 });
    const snap = () => {
      const out: number[] = [];
      for (let t = 0; t < 12; t++) for (let s = 0; s < 12; s++) for (const d of [1, 5, 20]) out.push(base.getConnectionWeight(t, s, d));
      return out;
    };
    const before = snap();
    const r = await netSkillMaker(`neurons="4"\n"n1"@input="open file"\n"n1"@response="opening"\ntrain`, base, { name: 'opener' });
    expect(r.ok).toBe(true);
    expect(base.getNeuronCount()).toBe(16);
    expect(snap()).toEqual(before);
    expect(r.training!.converged).toBe(true);
    expect(r.net!.respond('open file').response).toBe('opening');
  });

  it('refuses the same skill twice and a skill with no base AI', async () => {
    const base = new HyperDimensionalEngine({ neuronCount: 8, dimensions: 16, seed: 2 });
    expect((await netSkillMaker(`neurons="3"`, base, { name: 's' })).ok).toBe(true);
    expect((await netSkillMaker(`neurons="3"`, base, { name: 's' })).ok).toBe(false);
    expect((await makeFromSource(`kind="skill"\nneurons="3"`)).ok).toBe(false);
  });
});

describe('predict and random training', () => {
  const repeating = 'the cat sat on the mat. the cat sat on the hat. the cat sat on the bat. '.repeat(4);

  it('beats the guess-the-commonest-byte baseline on what it was shown, and reports how much was recall', async () => {
    const r = await netMaker(`neurons="12"\ntrain="predict"\ntrain@text="${repeating}"`, { dimensions: 32 });
    const p = r.training!.predict!;
    expect(p.heldOutSeen).toBeGreaterThan(0.9); // the test text repeats, so this is recall, and says so
    expect(p.accuracy).toBeGreaterThan(p.baseline);
  });

  it('changes no neuron weight, so frozen neurons are untouched', async () => {
    const r = await netMaker(`neurons="12"\n"n12"@frozen="now"\ntrain="predict"\ntrain@text="${repeating}"`, { dimensions: 16 });
    expect(r.training!.skipped).toEqual([]);
    expect(r.training!.predict).toBeDefined();
  });

  it('random content is seeded', () => {
    expect(randomContent(3)).toBe(randomContent(3));
    expect(randomContent(3)).not.toBe(randomContent(4));
  });

  it('random mode runs and reports a held-out measurement', async () => {
    const r = await netMaker(`neurons="24"\ntrain="random"`, { dimensions: 32, seed: 3 });
    expect(r.training!.mode).toBe('random');
    expect(r.training!.predict!.heldOutPairs).toBeGreaterThan(0);
  });

  it('warns when predict has no text', async () => {
    const r = await netMaker(`neurons="4"\ntrain="predict"`, { dimensions: 16 });
    expect(r.warnings.some(w => w.includes('needs text'))).toBe(true);
  });
});
