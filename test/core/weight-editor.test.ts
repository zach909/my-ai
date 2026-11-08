/**
 * The weight editor and the compiler (weight-editor.ts), and the routes that
 * expose them (interface/weights-routes.ts).
 */
import { describe, it, expect } from 'vitest';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain';
import { netMaker } from '../../models && skills/core/neuro-build';
import { WeightEditor, compileView, MAX_NUDGE, EditRefused } from '../../models && skills/core/weight-editor';
import { handleWeightsRoutes } from '../../interface/weights-routes';
import { WEIGHTS_PAGE } from '../../interface/weights-page';

async function untrained() {
  const r = await netMaker(`neurons="8"\n"n1"@input="hello"`, { dimensions: 32 });
  return { net: r.net!, editor: new WeightEditor(r.net!) };
}

describe('weight editor', () => {
  it('explains the weights that decide an output and says which way to move them', async () => {
    const { editor } = await untrained();
    const v = editor.view({ text: 'hello', goal: 'hi there' });
    expect(v.loss).toBeGreaterThan(0);
    expect(v.lines.length).toBeGreaterThan(0);
    expect(v.lines.every(l => l.suggestion.length > 10)).toBe(true);
    expect(v.lines.filter(l => l.kind === 'shift').every(l => !l.editable)).toBe(true);
    expect(v.text_summary).toContain('hello');
  });

  it('caps one edit at MAX_NUDGE and undo restores the weight exactly', async () => {
    const { net, editor } = await untrained();
    const line = editor.view({ text: 'hello', goal: 'hi there' }).lines.find(l => l.editable)!;
    const e = editor.nudge(line.target, line.source, line.dim, 5, 'test');
    expect(Math.abs(e.after - e.before)).toBeLessThanOrEqual(MAX_NUDGE + 1e-6);
    editor.undo();
    expect(net.engine.getConnectionWeight(net.idOf(line.target), net.idOf(line.source), line.dim)).toBeCloseTo(e.before, 9);
  });

  it('improve() moves the output closer to the goal in small kept steps only', async () => {
    const { editor } = await untrained();
    const r = editor.improve({ text: 'hello', goal: 'hi there', steps: 25, size: 0.05 });
    expect(r.after).toBeLessThan(r.before);
    expect(editor.getHistory().every(h => Math.abs(h.after - h.before) <= MAX_NUDGE + 1e-6)).toBe(true);
  });

  it('refuses to edit a frozen neuron, by nudge or by step', async () => {
    const { net, editor } = await untrained();
    net.freeze('n8');
    expect(() => editor.nudge('n8', 'n1', 1, 0.05)).toThrow(EditRefused);
    expect(() => editor.step({ text: 'hello', goal: 'x' })).toThrow(EditRefused);
  });
});

describe('compiler view', () => {
  it('compiles straight-line arithmetic exactly', () => {
    const c = compileView('(x) => 2*x + 1', [3]);
    expect(c.tier).toBe('affine');
    expect(c.outputs!.net[0]).toBe(7);
  });

  it('compiles a polynomial exactly', () => {
    const c = compileView('(x) => x*x - 3*x + 2', [4]);
    expect(c.tier).toBe('polynomial');
    expect(c.outputs!.net[0]).toBeCloseTo(6, 9);
  });

  it('says plainly when code only gets an identity', () => {
    const c = compileView('for (;;) {}');
    expect(c.tier).toBe('embedding');
    expect(c.summary).toContain('identity-only');
  });
});

describe('weights routes', () => {
  let engine: HyperDimensionalEngine | null = null;
  async function call(method: string, pathname: string, body?: unknown) {
    let out: { status: number; data: any } | undefined;
    const handled = await handleWeightsRoutes({
      req: {} as never, res: {} as never, pathname, method,
      parseBody: async () => body,
      sendJson: (_r, data, status = 200) => { out = { status, data }; },
      base: async () => engine,
    });
    return { handled, ...out! };
  }

  it('makes a net, explains it, edits it a little, and refuses a frozen neuron', async () => {
    const made = await call('POST', '/api/nets', { source: `neurons="8"\n"n1"@input="hello"\n"n1"@response="hi there"\ntrain`, dimensions: 32 });
    expect(made.status).toBe(200);
    const id = made.data.id;
    expect((await call('POST', `/api/nets/${id}/respond`, { text: 'hello' })).data.response).toBe('hi there');
    const line = (await call('POST', `/api/nets/${id}/view`, { text: 'hello', goal: 'hi there' })).data.lines.find((l: any) => l.editable);
    const nudge = await call('POST', `/api/nets/${id}/nudge`, { target: line.target, source: line.source, dim: line.dim, delta: 9 });
    expect(Math.abs(nudge.data.edit.after - nudge.data.edit.before)).toBeLessThanOrEqual(MAX_NUDGE + 1e-6);
    await call('POST', `/api/nets/${id}/freeze`, { neuron: 'n8', frozen: true });
    expect((await call('POST', `/api/nets/${id}/nudge`, { target: 'n8', source: 'n1', dim: 1, delta: 0.05 })).status).toBe(400);
    expect((await call('POST', `/api/nets/${id}/nudge`, { target: 'nope', source: 'n1', dim: 1, delta: 0.05 })).status).toBe(400);
  });

  it('will not graft a skill into the live AI without confirm, or without a live AI', async () => {
    const skill = `kind="skill"\nneurons="3"\n"n1"@response="x"`;
    expect((await call('POST', '/api/nets', { source: skill })).status).toBe(409);
    engine = null;
    expect((await call('POST', '/api/nets', { source: skill, confirm: true })).status).toBe(503);
    engine = new HyperDimensionalEngine({ neuronCount: 10, dimensions: 32, seed: 3 });
    const ok = await call('POST', '/api/nets', { source: skill, confirm: true, name: 'route-skill' });
    expect(ok.status).toBe(200);
    expect(engine.getNeuronCount()).toBe(13);
  });

  it('compiles code', async () => {
    const r = await call('POST', '/api/compile', { code: '(x) => 2*x + 1', inputs: [3] });
    expect(r.data.tier).toBe('affine');
  });

  it('the page uses no innerHTML and no blue', () => {
    expect(WEIGHTS_PAGE).not.toContain('innerHTML');
    expect(WEIGHTS_PAGE).not.toMatch(/#4a7dff|indigo|cyan/i);
  });
});
