/**
 * Task training (task-training.ts): single, hive, separate and silent.
 */
import { describe, it, expect } from 'vitest';
import { trainTasks, arithmeticTasks, validateTasks, MAX_TASKS, type Task } from '../../models && skills/core/task-training';
import { handleWeightsRoutes } from '../../interface/weights-routes';

const plain = arithmeticTasks(6, 1);
const composite = arithmeticTasks(6, 2, true);

describe('tasks', () => {
  it('are made by arithmetic the code computes, and are deterministic', () => {
    expect(arithmeticTasks(6, 1)).toEqual(arithmeticTasks(6, 1));
    const t = arithmeticTasks(1, 1, true)[0];
    const [a, b] = t.input.split(' and ').map(Number);
    expect(t.parts).toEqual([`sum ${a + b}`, `product ${a * b}`]);
  });

  it('are refused when the net language cannot carry them', () => {
    const bad: Task[] = [{ id: 'a', input: 'say "hi"', parts: ['x'] }, { id: 'a', input: 'same', parts: [] }];
    expect(validateTasks(bad).length).toBeGreaterThanOrEqual(2);
    expect(validateTasks(arithmeticTasks(MAX_TASKS + 1, 1)).some(p => p.includes('at most'))).toBe(true);
  });
});

describe('the four modes', () => {
  it('single: one AI learns the tasks it is given, and starts knowing none', async () => {
    const r = await trainTasks(plain, { mode: 'single', rounds: 2 });
    expect(r.agents).toHaveLength(1);
    expect(r.teamScore[0]).toBe(0);
    expect(r.teamScore[r.teamScore.length - 1]).toBeGreaterThan(0.5);
    expect(r.messages).toBe(0);
  });

  it('separate: every AI is given every task and nothing is shared', async () => {
    const r = await trainTasks(plain, { mode: 'separate', agents: 3, rounds: 2 });
    expect(r.agents).toHaveLength(3);
    expect(r.agents.every(a => a.knows === plain.length)).toBe(true);
    expect(r.messages).toBe(0);
  });

  it('hive: the AIs talk, learn from each other, and trust still adds up', async () => {
    const r = await trainTasks(plain, { mode: 'hive', agents: 3, rounds: 2 });
    expect(r.messages).toBeGreaterThan(0);
    // Each agent started with a third of the tasks and now holds more than that.
    expect(r.agents.every(a => a.knows > plain.length / 3)).toBe(true);
    expect(r.agents.reduce((s, a) => s + (a.trust ?? 0), 0)).toBeCloseTo(100, 0);
    expect(r.teamScore[r.teamScore.length - 1]).toBeGreaterThan(0.5);
  });

  it('silent: no channel at all, and the agreed split is what makes the team work', async () => {
    const r = await trainTasks(composite, { mode: 'silent', agents: 3, rounds: 2 });
    expect(r.messages).toBe(0);
    // Nobody was taught everything: each holds only the parts it is responsible for.
    expect(r.agents.every(a => a.knows < composite.length * 2)).toBe(true);
    expect(r.agents.flatMap(a => a.responsibleFor ?? []).length).toBe(composite.length * 2);
    expect(r.teamScore[r.teamScore.length - 1]).toBeGreaterThan(0.5);
  });

  it('silent needs enough AIs for the parts of an answer', async () => {
    await expect(trainTasks(composite, { mode: 'silent', agents: 2, rounds: 1 })).resolves.toBeDefined();
    const three: Task[] = [{ id: 'x', input: 'abc', parts: ['1', '2', '3'] }];
    await expect(trainTasks(three, { mode: 'silent', agents: 2, rounds: 1 })).rejects.toThrow(/at least 3 agents/);
  });
});

describe('route', () => {
  it('trains and rejects bad input', async () => {
    const call = async (body: unknown) => {
      let out: { status: number; data: any } | undefined;
      await handleWeightsRoutes({
        req: {} as never, res: {} as never, pathname: '/api/task-training', method: 'POST',
        parseBody: async () => body,
        sendJson: (_r, data, status = 200) => { out = { status, data }; },
        base: async () => null,
      });
      return out!;
    };
    const ok = await call({ mode: 'single', generate: { count: 3 }, rounds: 1 });
    expect(ok.status).toBe(200);
    expect(ok.data.mode).toBe('single');
    expect((await call({ mode: 'nope', generate: { count: 3 } })).status).toBe(400);
    expect((await call({ mode: 'single' })).status).toBe(400);
    expect((await call({ mode: 'single', tasks: [{ input: 'say "hi"', parts: ['x'] }] })).status).toBe(422);
  });
});
