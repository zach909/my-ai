/**
 * Put the chooser to work on one message.
 *
 * engine-chooser.ts decides; this runs the decision and teaches the chooser
 * what happened. What it can actually do today, stated plainly:
 *
 *   remote            really runs: the message is sent to the computer this
 *                     device may borrow (compute-share.ts peers, paid in credit
 *                     or points by compute-market.ts). If that fails for any
 *                     reason the answer is null and the caller answers locally.
 *   local-full /      the caller answers on this device as it always has. The
 *   local-quantized   choice is recorded (and learned from) but does not by
 *                     itself change the precision of the weights in memory:
 *                     the engine has one live copy, quantized in place by the
 *                     background quantizer, not two it can swap between. Making
 *                     the engine act on this choice is a separate piece of work.
 *
 * The caller's part:
 *
 *     const route = await routeMessage(prompt, history);
 *     if (route.answer !== null) return route.answer;      // a remote computer answered
 *     const t0 = Date.now();
 *     try { answer = await answerLocally(); route.finish(true, Date.now() - t0); }
 *     catch (e) { route.finish(false, Date.now() - t0); throw e; }
 *
 * Nothing here throws on its own account: a probe that fails, a peer that is
 * down, a weights file that cannot be saved all degrade to "answer locally".
 */

import { borrowPriced } from "./compute-market.js";
import { loadCompute } from "./compute-share.js";
import { Chooser, loadChooser, rewardFor, saveChooser, type Choice, type Engine } from "./engine-chooser.js";
import { probeDevice, type DeviceProfile } from "./device-profile.js";

export interface RouterDeps {
  probe(): Promise<DeviceProfile>;
  /** Whether a remote computer can be tried, and which one. */
  remote(): { available: boolean; peerId: string | null };
  borrow(peerId: string, prompt: string): Promise<{ result: string }>;
  chooser: Chooser;
  save(chooser: Chooser): void;
  modelBytes(): { full: number; quantized: number };
  now(): number;
}

export interface Route {
  choice: Choice;
  /** Set only when a remote computer answered. Null means: answer on this device. */
  answer: string | null;
  /** What happened on the way, for the details panel. */
  notes: string[];
  /** Report how the local answer went so the chooser can learn from it. A no-op after a remote answer. */
  finish(ok: boolean, ms: number): void;
}

/** The "chooser is on" switch. Off by default: nothing changes until the owner turns it on. */
export function chooserEnabled(): boolean {
  return (process.env.NEUROCLAW_CHOOSER ?? "").trim() === "1";
}

let sharedChooser: Chooser | null = null;

export function defaultDeps(): RouterDeps {
  return {
    probe: () => {
      let mops: number | null = null;
      try { mops = loadCompute().mops; } catch { /* unmeasured is fine */ }
      return probeDevice({ mops });
    },
    remote: () => {
      try {
        const s = loadCompute();
        const peer = s.peers[0];
        return { available: !!peer && s.balance + s.creditLimit > 0, peerId: peer?.id ?? null };
      } catch { return { available: false, peerId: null }; }
    },
    borrow: (peerId, prompt) => borrowPriced(peerId, prompt),
    chooser: (sharedChooser ??= loadChooser()),
    save: (c) => { saveChooser(c); },
    modelBytes: () => {
      const forced = Number(process.env.NEUROCLAW_FULL_MODEL_BYTES);
      // What this process holds now is the best measure of what the full model costs here.
      const full = Number.isFinite(forced) && forced > 0 ? forced : process.memoryUsage().rss;
      const bits = Math.min(16, Math.max(2, Number(process.env.NEUROCLAW_QUANT_BITS) || 8));
      return { full, quantized: Math.ceil((full * bits) / 32) };
    },
    now: Date.now,
  };
}

const note = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function routeMessage(prompt: string, history: string[] = [], deps: RouterDeps = defaultDeps()): Promise<Route> {
  const notes: string[] = [];
  let device: DeviceProfile;
  try {
    device = await deps.probe();
  } catch (e) {
    // Without a picture of the device there is nothing to choose with.
    notes.push(`could not read this device (${note(e)}); answering locally`);
    const choice = new Chooser().choose({
      device: { kind: "unknown", platform: "unknown", cores: 1, totalMemBytes: 0, freeMemBytes: 0, load: 0, mops: null, battery: null, online: null },
      prompt, remote: { available: false }, fullModelBytes: 1, quantizedModelBytes: 1,
    });
    return { choice, answer: null, notes, finish: () => undefined };
  }

  const remote = deps.remote();
  const bytes = deps.modelBytes();
  const choice = deps.chooser.choose({
    device, prompt, historyChars: history.reduce((n, h) => n + h.length, 0),
    remote: { available: remote.available && !!remote.peerId },
    fullModelBytes: bytes.full, quantizedModelBytes: bytes.quantized,
  });
  const learn = (engine: Engine, ok: boolean, ms: number): void => {
    try {
      deps.chooser.learn(engine, choice.features, rewardFor({ ok, ms }));
      deps.save(deps.chooser);
    } catch { /* learning is a bonus; never let it break an answer */ }
  };

  if (choice.engine === "remote" && remote.peerId) {
    const t0 = deps.now();
    try {
      const r = await deps.borrow(remote.peerId, prompt);
      learn("remote", true, deps.now() - t0);
      notes.push("answered by a remote computer");
      return { choice, answer: r.result, notes, finish: () => undefined };
    } catch (e) {
      learn("remote", false, deps.now() - t0);
      notes.push(`the remote computer failed (${note(e)}); answering locally`);
      // The failure is already learned. The local answer that follows is not credited to anything:
      // it was not what was chosen, so judging the chosen engine by it would teach the wrong thing.
      return { choice, answer: null, notes, finish: () => undefined };
    }
  }

  const engine = choice.engine;
  return { choice, answer: null, notes, finish: (ok, ms) => learn(engine, ok, ms) };
}
