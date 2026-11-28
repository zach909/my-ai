/**
 * Worker thread: scores weight perturbations for the trainer. Created by eval-pool.mjs.
 * Gets plain numbers in, sends plain numbers back; it never touches the files or the network.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { makeLocalEvaluator } from './es.mjs';

const local = makeLocalEvaluator(workerData.sizes, workerData.envOptions);

parentPort.on('message', async (msg) => {
  try {
    const scores = await local.evaluate(msg.task);
    parentPort.postMessage({ id: msg.id, scores });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String(err && err.stack || err) });
  }
});
