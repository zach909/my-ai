/**
 * Score perturbations on several CPU cores with Node's own worker threads (nothing installed).
 * Same shape as makeLocalEvaluator in es.mjs: `evaluate(task)` returns one score per job, in order.
 */
import { Worker } from 'node:worker_threads';

export function makePoolEvaluator(sizes, envOptions, workers) {
  const pool = [];
  const waiting = new Map();
  let nextId = 1;
  for (let i = 0; i < workers; i++) {
    const w = new Worker(new URL('./eval-worker.mjs', import.meta.url), { workerData: { sizes, envOptions } });
    w.on('message', (msg) => {
      const p = waiting.get(msg.id);
      if (!p) return;
      waiting.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.scores);
    });
    w.on('error', (err) => { for (const p of waiting.values()) p.reject(err); waiting.clear(); });
    pool.push(w);
  }
  return {
    async evaluate(task) {
      const { jobs } = task;
      const chunk = Math.ceil(jobs.length / pool.length);
      const parts = [];
      for (let w = 0; w < pool.length; w++) {
        const slice = jobs.slice(w * chunk, (w + 1) * chunk);
        if (!slice.length) continue;
        const id = nextId++;
        parts.push(new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          pool[w].postMessage({ id, task: { ...task, jobs: slice } });
        }));
      }
      const results = await Promise.all(parts);
      const out = new Float64Array(jobs.length);
      let k = 0;
      for (const r of results) for (const v of r) out[k++] = v;
      return out;
    },
    close() { for (const w of pool) w.terminate(); },
  };
}
