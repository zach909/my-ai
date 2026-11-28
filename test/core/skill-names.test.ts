import { describe, it, expect } from 'vitest';
import { HyperDimensionalEngine } from '../../models && skills/core/onebrain.js';

// The page behind every screen asks GET /api/net-skills?counts=1 for the names of the skill
// regions instead of the whole pair table (skillAffinity(), O(skills^2 x neurons)). That is only
// the same picture if skillNames() is exactly the set of names the pairs are built from.
function mesh(): HyperDimensionalEngine {
  const engine = new HyperDimensionalEngine({ neuronCount: 24, dimensions: 8, propagationSteps: 2, learningRate: 0.05 });
  for (let i = 0; i < 8; i++) engine.setNeuronGroup(i, 'math');
  for (let i = 8; i < 16; i++) engine.setNeuronGroup(i, 'language');
  for (let i = 16; i < 24; i++) engine.setNeuronGroup(i, 'vision');
  return engine;
}

describe('skillNames', () => {
  it('lists every region once, sorted', () => {
    expect(mesh().skillNames()).toEqual(['language', 'math', 'vision']);
  });

  it('names the same regions that skillAffinity() pairs up', () => {
    const engine = mesh();
    const inPairs = new Set<string>();
    for (const p of engine.skillAffinity()) { inPairs.add(p.a); inPairs.add(p.b); }
    expect([...inPairs].sort()).toEqual(engine.skillNames());
  });

  it('counts a neuron that belongs to two regions in both, and a region with no neurons not at all', () => {
    const engine = mesh();
    engine.setNeuronGroup(0, 'language');
    expect(engine.skillNames()).toEqual(['language', 'math', 'vision']);
    expect(new HyperDimensionalEngine({ neuronCount: 4, dimensions: 4, propagationSteps: 1, learningRate: 0.05 }).skillNames()).toEqual([]);
  });
});
