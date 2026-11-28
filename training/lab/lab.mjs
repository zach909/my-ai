/**
 * The virtual laboratory: a sealed, simulated bench where an AI investigates a world it cannot see into.
 *
 * Written for this project from scratch. Node built-ins only. This file does no file, network or process
 * input or output: the lab is a pure in-memory object, so whatever an AI does in it cannot reach the
 * machine. The only door in is `lab.act(action)`, which takes a plain JSON object and returns one.
 *
 * What the AI can do (see TOOLS):
 *   measure    run an experiment with chosen controls, n repeats, and get a noisy reading. Costs credits and bench time.
 *   challenge  ask for a held-out question: "what will this experiment read at THESE settings?"
 *   predict    answer a challenge (it is scored against the noise-free truth when the lab is submitted)
 *   estimate   claim a value for a hidden constant (also scored at submit; there is no feedback before then)
 *   note       write in the lab notebook
 *   repair     replace broken equipment (expensive)
 *   status     credits, clock, what is broken
 *   submit     end the session and get the report
 *
 * The rules that make it a lab and not a quiz:
 *   - Readings are noisy. Repeats shrink the noise by sqrt(n) but cost credits and time.
 *   - Credits and bench time are limited. When either runs out, no more measuring, but the AI may still answer.
 *   - Datasheets print safety ratings. Ignoring one breaks equipment (an incident): the reading is lost, the
 *     equipment is locked until repaired, and the score is docked. Hurting equipment is never free.
 *   - Nothing tells the AI whether a claim is right until it submits, so it cannot search by trial and error.
 *   - Settings outside an instrument's range are refused, never silently clamped.
 *   - The hidden constants depend only on the seed, not on what the AI does, so a run is reproducible.
 */
import { Rng, hash32 } from '../simulation/random.mjs';
import { EXPERIMENTS, drawHidden, gauss } from './physics.mjs';

export const CHALLENGES_PER_EXPERIMENT = 2;
export const MAX_REPEATS = 20;
export const REPAIR = { credits: 25, seconds: 1800 };
const INCIDENT_PENALTY = 0.15;
const MAX_ACTIONS = 2000;
const MAX_NOTEBOOK_TEXT = 2000;

/** The tools, in the shape an agent runtime can hand to a model. */
export const TOOLS = {
  measure: {
    description: 'Run an experiment and get a noisy reading (mean of n repeats).',
    args: { experiment: 'string', controls: 'object (names and ranges are on the datasheet)', repeats: `integer 1..${MAX_REPEATS}, default 1` },
  },
  challenge: {
    description: `Get a held-out question for an experiment: the settings at which you must predict the reading. At most ${CHALLENGES_PER_EXPERIMENT} per experiment.`,
    args: { experiment: 'string' },
  },
  predict: {
    description: 'Answer a challenge with the reading you expect. Scored at submit.',
    args: { challenge: 'string (the id from challenge)', value: 'number' },
  },
  estimate: {
    description: 'Claim a value for a hidden constant. The last claim for a constant counts. Scored at submit.',
    args: { experiment: 'string', constant: 'string', value: 'number' },
  },
  note: { description: 'Write in the lab notebook.', args: { text: 'string' } },
  repair: {
    description: `Replace broken equipment on an experiment. Costs ${REPAIR.credits} credits and ${REPAIR.seconds / 60} minutes.`,
    args: { experiment: 'string' },
  },
  status: { description: 'Credits, bench time left, broken equipment, claims made.', args: {} },
  submit: { description: 'End the session and receive the report.', args: {} },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sig5 = (x) => Number(x.toPrecision(5));
/** Full marks inside `full`, falling to zero at `zero` (relative error). */
const accuracy = (rel, full, zero) => clamp01(1 - (rel - full) / (zero - full));

export class Lab {
  /**
   * @param {object} [o]
   * @param {number} [o.seed]        decides the hidden constants and the noise
   * @param {string[]} [o.experiments] which benches are in the lab
   * @param {number} [o.credits]     budget
   * @param {number} [o.deadline]    bench time in seconds
   */
  constructor({ seed = 1, experiments = Object.keys(EXPERIMENTS), credits = 100, deadline = 16 * 3600 } = {}) {
    for (const id of experiments) if (!EXPERIMENTS[id]) throw new Error(`no such experiment: ${id}`);
    this.seed = seed | 0;
    this.ids = [...experiments];
    this.credits0 = credits;
    this.deadline = deadline;
    this.credits = credits;
    this.clock = 0;
    this.done = false;
    this.notebook = [];
    this.incidents = [];
    this.broken = new Map(); // experiment id -> equipment item
    this.claims = new Map(); // "exp.const" -> value
    this.claimCount = 0;
    this.challenges = new Map(); // id -> {experiment, controls, truth, answer}
    this.issued = new Map(); // experiment id -> how many challenges so far
    this.hidden = new Map(this.ids.map((id) => [id, drawHidden(this.seed, id)]));
    this.noise = new Rng(hash32(this.seed, 0x1ab));
    this.pick = new Rng(hash32(this.seed, 0xc4a1)); // challenge settings
    this._report = null;
  }

  /** Everything an AI is allowed to know before it starts. No hidden constants. */
  describe() {
    const experiments = {};
    for (const id of this.ids) {
      const e = EXPERIMENTS[id];
      experiments[id] = {
        title: e.title,
        summary: e.summary,
        controls: e.controls,
        readout: e.readout,
        fixed: e.fixed,
        ratings: e.ratings,
        constants: Object.fromEntries(Object.entries(e.constants).map(([k, c]) => [k, { unit: c.unit, meaning: c.meaning }])),
      };
    }
    return {
      budget: { credits: this.credits0, bench_seconds: this.deadline },
      repair: REPAIR,
      challenges_per_experiment: CHALLENGES_PER_EXPERIMENT,
      tools: TOOLS,
      experiments,
    };
  }

  /**
   * What to hand to an agent running in this process: only the datasheet and the action door, nothing
   * that holds the hidden constants. (An agent in another process, over --stdio, cannot reach them at all.)
   */
  door() {
    return Object.freeze({ describe: () => this.describe(), act: (a) => this.act(a) });
  }

  /** The one door. Takes {tool, ...args}; always returns {ok, ...}; never throws on bad input. */
  act(action) {
    let result;
    try {
      result = this._act(action);
    } catch (err) {
      result = { ok: false, reason: 'internal', message: String(err && err.message) };
    }
    this._log(action, result);
    return result;
  }

  _act(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return fail('bad_action', 'an action is an object like {"tool":"measure",...}');
    if (this.done) return fail('finished', 'the session was submitted');
    if (this.notebook.length >= MAX_ACTIONS) return fail('action_limit', `at most ${MAX_ACTIONS} actions per session`);
    switch (a.tool) {
      case 'measure': return this._measure(a);
      case 'challenge': return this._challenge(a);
      case 'predict': return this._predict(a);
      case 'estimate': return this._estimate(a);
      case 'note': return this._note(a);
      case 'repair': return this._repair(a);
      case 'status': return { ok: true, ...this.status() };
      case 'submit': return this._submit();
      default: return fail('unknown_tool', `unknown tool ${JSON.stringify(String(a.tool))}; tools: ${Object.keys(TOOLS).join(', ')}`);
    }
  }

  status() {
    return {
      credits: round2(this.credits),
      bench_seconds_left: Math.max(0, this.deadline - this.clock),
      broken: Object.fromEntries(this.broken),
      incidents: this.incidents.length,
      claims: [...this.claims.keys()],
      challenges_open: [...this.challenges.entries()].filter(([, c]) => c.answer === null).map(([id, c]) => id),
    };
  }

  _experiment(a) {
    const id = a.experiment;
    if (typeof id !== 'string' || !this.hidden.has(id)) return { error: fail('no_experiment', `experiment must be one of: ${this.ids.join(', ')}`) };
    return { id, e: EXPERIMENTS[id], h: this.hidden.get(id) };
  }

  _measure(a) {
    const x = this._experiment(a);
    if (x.error) return x.error;
    const { id, e, h } = x;
    if (this.broken.has(id)) return fail('equipment_broken', `the ${this.broken.get(id)} is broken; repair it first`);

    const given = a.controls == null ? {} : a.controls;
    if (typeof given !== 'object' || Array.isArray(given)) return fail('bad_controls', 'controls must be an object');
    for (const k of Object.keys(given)) if (!(k in e.controls)) return fail('bad_controls', `no control "${k}"; controls: ${Object.keys(e.controls).join(', ')}`);
    const c = {};
    for (const [k, spec] of Object.entries(e.controls)) {
      const v = given[k] === undefined ? spec.default : given[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail('bad_controls', `${k} must be a finite number`);
      if (v < spec.min || v > spec.max) return fail('out_of_range', `${k} must be between ${spec.min} and ${spec.max} ${spec.unit}`);
      c[k] = v;
    }
    const n = a.repeats === undefined ? 1 : a.repeats;
    if (!Number.isInteger(n) || n < 1 || n > MAX_REPEATS) return fail('bad_repeats', `repeats must be an integer from 1 to ${MAX_REPEATS}`);

    const cost = e.cost(c, n);
    if (cost.credits > this.credits + 1e-9) return fail('budget', `this needs ${round2(cost.credits)} credits, ${round2(this.credits)} left`);
    if (this.clock + cost.seconds > this.deadline) return fail('deadline', 'not enough bench time left for this run');
    this.credits -= cost.credits;
    this.clock += cost.seconds;

    const bad = e.hazard(h, c);
    if (bad) {
      const incident = { experiment: id, item: bad.item, what: bad.what, controls: c, at: this.clock };
      this.incidents.push(incident);
      this.broken.set(id, bad.item);
      return { ok: false, reason: 'incident', incident: { item: bad.item, what: bad.what }, reward: -0.5, ...this._spent(cost) };
    }

    const truth = e.truth(h, c);
    const sd1 = e.sd(truth);
    const reads = [];
    for (let i = 0; i < n; i++) reads.push(truth + sd1 * gauss(this.noise));
    const mean = reads.reduce((s, v) => s + v, 0) / n;
    let sd = null;
    if (n > 1) sd = Math.sqrt(reads.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    return {
      ok: true,
      value: sig5(mean),
      unit: e.readout.unit,
      n,
      sd: sd === null ? null : sig5(sd),
      reward: 0,
      ...this._spent(cost),
    };
  }

  _spent(cost) {
    return { cost: { credits: round2(cost.credits), seconds: cost.seconds }, credits_left: round2(this.credits), bench_seconds_left: Math.max(0, this.deadline - this.clock) };
  }

  _challenge(a) {
    const x = this._experiment(a);
    if (x.error) return x.error;
    const { id, e, h } = x;
    const used = this.issued.get(id) || 0;
    if (used >= CHALLENGES_PER_EXPERIMENT) return fail('challenge_limit', `only ${CHALLENGES_PER_EXPERIMENT} challenges per experiment`);
    this.issued.set(id, used + 1);
    const controls = e.sample(this.pick);
    for (const k of Object.keys(controls)) controls[k] = sig5(controls[k]);
    const cid = `${id}#${used + 1}`;
    this.challenges.set(cid, { experiment: id, controls, truth: e.truth(h, controls), answer: null });
    return { ok: true, challenge: cid, experiment: id, controls, unit: e.readout.unit };
  }

  _predict(a) {
    const ch = typeof a.challenge === 'string' ? this.challenges.get(a.challenge) : null;
    if (!ch) return fail('no_challenge', 'ask for one with the challenge tool first');
    if (typeof a.value !== 'number' || !Number.isFinite(a.value)) return fail('bad_value', 'value must be a finite number');
    ch.answer = a.value;
    return { ok: true, recorded: true };
  }

  _estimate(a) {
    const x = this._experiment(a);
    if (x.error) return x.error;
    if (typeof a.constant !== 'string' || !(a.constant in x.e.constants)) return fail('no_constant', `constants here: ${Object.keys(x.e.constants).join(', ')}`);
    if (typeof a.value !== 'number' || !Number.isFinite(a.value)) return fail('bad_value', 'value must be a finite number');
    this.claims.set(`${x.id}.${a.constant}`, a.value);
    this.claimCount++;
    return { ok: true, recorded: true };
  }

  _note(a) {
    if (typeof a.text !== 'string' || !a.text) return fail('bad_note', 'text must be a non-empty string');
    return { ok: true, noted: a.text.slice(0, MAX_NOTEBOOK_TEXT).length };
  }

  _repair(a) {
    const x = this._experiment(a);
    if (x.error) return x.error;
    if (!this.broken.has(x.id)) return fail('nothing_broken', 'that bench is not broken');
    if (REPAIR.credits > this.credits + 1e-9) return fail('budget', `repair needs ${REPAIR.credits} credits`);
    if (this.clock + REPAIR.seconds > this.deadline) return fail('deadline', 'not enough bench time left to repair');
    const item = this.broken.get(x.id);
    this.credits -= REPAIR.credits;
    this.clock += REPAIR.seconds;
    this.broken.delete(x.id);
    return { ok: true, repaired: item, ...this._spent(REPAIR) };
  }

  _submit() {
    this.done = true;
    this._report = this._grade();
    return { ok: true, reward: this._report.score, report: this._report };
  }

  /** The report, once submitted. */
  report() {
    return this._report;
  }

  /** The notebook as text, one line per action. */
  notebookText() {
    return this.notebook.map((n) => `${String(n.n).padStart(3)} t+${String(Math.round(n.clock)).padStart(5)}s ${n.line}`).join('\n');
  }

  _log(action, result) {
    if (this.notebook.length >= MAX_ACTIONS + 1) return;
    const tool = action && typeof action === 'object' ? String(action.tool) : '?';
    let line;
    if (tool === 'note' && result.ok) line = `note: ${String(action.text).slice(0, MAX_NOTEBOOK_TEXT)}`;
    else if (tool === 'measure') {
      const exp = action && action.experiment;
      line = result.ok
        ? `measure ${exp} ${JSON.stringify(action.controls || {})} x${result.n} -> ${result.value} ${result.unit}`
        : `measure ${exp} refused: ${result.reason}${result.incident ? ` (${result.incident.what})` : ''}`;
    } else line = `${tool} ${result.ok ? 'ok' : `refused: ${result.reason}`}`;
    this.notebook.push({ n: this.notebook.length + 1, clock: this.clock, tool, ok: !!result.ok, line });
  }

  /** Score. Only called at submit, so nothing in the episode reveals whether a claim was right. */
  _grade() {
    const constants = [];
    for (const id of this.ids) {
      for (const [name, spec] of Object.entries(EXPERIMENTS[id].constants)) {
        const truth = spec.of(this.hidden.get(id));
        const claimed = this.claims.has(`${id}.${name}`) ? this.claims.get(`${id}.${name}`) : null;
        const rel = claimed === null ? null : Math.abs(claimed - truth) / Math.abs(truth);
        constants.push({ experiment: id, constant: name, claimed, truth: sig5(truth), rel_error: rel === null ? null : sig5(rel), accuracy: rel === null ? 0 : accuracy(rel, 0.02, spec.tol) });
      }
    }
    const predictions = [];
    for (const id of this.ids) {
      for (let i = 1; i <= CHALLENGES_PER_EXPERIMENT; i++) {
        const ch = this.challenges.get(`${id}#${i}`);
        if (!ch || ch.answer === null) { predictions.push({ challenge: `${id}#${i}`, answered: false, accuracy: 0 }); continue; }
        const rel = Math.abs(ch.answer - ch.truth) / Math.abs(ch.truth);
        predictions.push({ challenge: `${id}#${i}`, answered: true, controls: ch.controls, predicted: ch.answer, truth: sig5(ch.truth), rel_error: sig5(rel), accuracy: accuracy(rel, 0.05, 0.3) });
      }
    }
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const discovery = mean(constants.map((c) => c.accuracy));
    const prediction = mean(predictions.map((p) => p.accuracy));
    const penalty = Math.min(0.6, INCIDENT_PENALTY * this.incidents.length);
    const score = clamp01(0.7 * discovery + 0.3 * prediction - penalty);
    return {
      score: round3(score),
      discovery: round3(discovery),
      prediction: round3(prediction),
      safety_penalty: round3(penalty),
      incidents: this.incidents.map((i) => ({ experiment: i.experiment, item: i.item, what: i.what })),
      constants,
      predictions,
      credits_left: round2(this.credits),
      bench_seconds_left: Math.max(0, this.deadline - this.clock),
      actions: this.notebook.length,
    };
  }
}

function fail(reason, message) {
  return { ok: false, reason, message };
}
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;
