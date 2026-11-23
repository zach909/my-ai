// The solvers the math exam can ask. Each is built from what the exam teaches:
//   factory({ train, T, seed, dist }) -> { name, solve(problem) -> number | null }
// `null` means "no answer" and counts as wrong. A custom solver is a module whose default export is such a factory
// (--solver path/to/solver.mjs).
import { pathToFileURL } from 'node:url';
import { evalParts } from './math-problems.mjs';

const coreUrl = (dist) => pathToFileURL(`${dist}/models && skills/core/`).href;

/** Exact arithmetic. Must score 100%: if it does not, the exam itself is broken. */
export const reference = () => ({ name: 'reference (exact)', solve: (p) => evalParts(p.parts) });

/** Remembers the taught facts and nothing else. Canary: it must fail an exam made of unseen problems. */
export function memoriser({ train }) {
  const m = new Map(train.map((f) => [`${f.a}|${f.op}|${f.b}`, f.result]));
  return { name: 'memoriser (taught facts only)', solve: (p) => (p.parts.ops.length === 1 ? m.get(`${p.parts.operands[0]}|${p.parts.ops[0]}|${p.parts.operands[1]}`) ?? null : null) };
}

/** The repo's own arithmetic network (math-engine.ts on the HyperDimensionalEngine): trained on the facts, then asked. Chains are
 *  answered by asking it one step at a time, so its errors compound, as they would for any composed answer. */
export async function mesh({ train, seed, dist }) {
  const { scaleForFacts, trainArithmetic, askArithmetic } = await import(coreUrl(dist) + 'math-engine.js');
  const { HyperDimensionalEngine } = await import(coreUrl(dist) + 'onebrain.js');
  const facts = train.map(({ a, b, op, result }) => ({ a, b, op, result }));
  const scale = scaleForFacts(facts);
  const engine = new HyperDimensionalEngine({ neuronCount: 24, dimensions: 8, seed });
  const report = trainArithmetic(engine, facts, 0, 1, scale, { epochs: 300, learningRate: 0.2 });
  return {
    name: 'mesh (trainArithmetic / askArithmetic)', trainReport: report,
    solve(p) {
      let acc = p.parts.operands[0];
      for (let i = 0; i < p.parts.ops.length; i++) { acc = Math.round(askArithmetic(engine, acc, p.parts.operands[i + 1], p.parts.ops[i], 0, 1, scale)); if (!Number.isFinite(acc)) return null; }
      return acc;
    },
  };
}

/** The Zip Loop: taught question text -> answer text, asked the exam's text. No parsing on our side; bytes in, bytes out. */
export async function zip({ train, seed, dist }) {
  const { ZipSpeaker } = await import(coreUrl(dist) + 'zip-speech.js');
  const { HyperDimensionalEngine } = await import(coreUrl(dist) + 'onebrain.js');
  const engine = new HyperDimensionalEngine({ neuronCount: 64, dimensions: 64, seed });
  const sp = new ZipSpeaker(engine, { maxAnswerBytes: 10 });
  sp.teach(train.map((f) => ({ question: f.text, answer: String(f.result) })));
  return { name: 'zip loop (text in, text out)', solve: (p) => { const n = Number(sp.speakText(p.text).trim()); return Number.isFinite(n) ? n : null; } };
}

export const BUILT_IN = { reference, memorise: memoriser, mesh, zip };

export async function loadSolver(spec, ctx) {
  if (BUILT_IN[spec]) return BUILT_IN[spec](ctx);
  const mod = await import(pathToFileURL(spec).href);
  if (typeof mod.default !== 'function') throw new Error(`solver ${spec}: default export must be a function (ctx) => ({ name, solve })`);
  return mod.default(ctx);
}
