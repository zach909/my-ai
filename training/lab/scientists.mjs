/**
 * Scripted stand-ins for an AI in the lab, the way `training/simulation/policies.mjs` has scripted
 * agents. They exist to exercise the lab and to give a trained model something to be compared with.
 * Each one gets only `lab.describe()` and `lab.act()`: the same door a real AI uses. None of them can
 * see a hidden constant.
 *
 *   scientist  reads the datasheets, stays inside the ratings, repeats readings, fits the data, then
 *              checks itself on the held-out challenges before it submits.
 *   reckless   ignores the ratings, runs everything at the extremes, guesses from one reading.
 *   guesser    never measures; claims plausible-looking numbers.
 *
 * Written for this project from scratch. Node built-ins only.
 */
import { Rng } from '../simulation/random.mjs';

// ---------- plain least squares, nothing imported ----------

/** y = a + b x */
export function linfit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - a - b * xs[i]) ** 2;
  return { a, b, sse };
}

/** y = b x */
export function slopeThroughOrigin(xs, ys) {
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  return sxy / sxx;
}

/** Scientist: one routine per bench. Each ends by claiming its constants and answering its challenges. */
const BENCH = {
  pendulum(act, repeats) {
    const angle = 5, th = (angle * Math.PI) / 180;
    const Ls = [], T2 = [];
    for (const L of [0.2, 0.4, 0.7, 1.0, 1.4, 1.9]) {
      const r = act({ tool: 'measure', experiment: 'pendulum', controls: { length: L, angle }, repeats });
      if (r.ok) { Ls.push(L); T2.push(r.value ** 2); }
    }
    if (Ls.length < 3) return;
    const s = slopeThroughOrigin(Ls, T2) / (1 + th * th / 16) ** 2; // T^2 = (4 pi^2 / g) L
    act({ tool: 'note', text: `pendulum: T^2 is proportional to L, slope ${s.toFixed(4)} s^2/m` });
    act({ tool: 'estimate', experiment: 'pendulum', constant: 'g', value: (4 * Math.PI ** 2) / s });
    answer(act, 'pendulum', (c) => {
      const t = (c.angle * Math.PI) / 180;
      return Math.sqrt(s * c.length) * (1 + t ** 2 / 16 + (11 * t ** 4) / 3072);
    });
  },

  cooling(act, repeats) {
    const T0 = 100, ts = [], Ts = [];
    for (const t of [0, 100, 200, 350, 500, 700, 1000, 1500, 2300, 3000, 3600]) {
      const r = act({ tool: 'measure', experiment: 'cooling', controls: { time: t, start_temp: T0 }, repeats });
      if (r.ok) { ts.push(t); Ts.push(r.value); }
    }
    if (ts.length < 4) return;
    // T(t) = ambient + (T0 - ambient) e^(-k t) with T0 known. The noise is a fixed size in degrees, so plain
    // least squares on the temperatures is the right fit. Scan both unknowns (~370k model evaluations).
    let best = null;
    for (let amb = 0; amb <= 40; amb += 0.05) {
      for (let k = 1e-4; k < 1e-2; k *= 1.01) {
        let sse = 0;
        for (let i = 0; i < ts.length; i++) sse += (Ts[i] - (amb + (T0 - amb) * Math.exp(-k * ts[i]))) ** 2;
        if (!best || sse < best.sse) best = { amb, k, sse };
      }
    }
    act({ tool: 'note', text: `cooling: exponential, k=${best.k.toExponential(3)}/s toward ${best.amb.toFixed(1)} degC` });
    act({ tool: 'estimate', experiment: 'cooling', constant: 'k', value: best.k });
    act({ tool: 'estimate', experiment: 'cooling', constant: 'ambient', value: best.amb });
    answer(act, 'cooling', (c) => best.amb + (c.start_temp - best.amb) * Math.exp(-best.k * c.time));
  },

  rc(act, repeats, sheet) {
    const R = sheet.fixed.series_resistance_ohm, V = 5, ts = [], ys = [];
    // the time constant could be anywhere from ~0.1 s to ~5 s, so sample geometrically across that whole span
    for (const t of [0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1.2, 1.8, 2.7, 4, 6, 9, 14]) {
      const r = act({ tool: 'measure', experiment: 'rc', controls: { time: t, volts: V }, repeats });
      if (r.ok && r.value / V < 0.93) { ts.push(t); ys.push(-Math.log(1 - r.value / V)); }
    }
    if (ts.length < 3) return;
    const tau = 1 / slopeThroughOrigin(ts, ys);
    act({ tool: 'note', text: `rc: time constant ${tau.toFixed(3)} s with R = ${R} ohm` });
    act({ tool: 'estimate', experiment: 'rc', constant: 'capacitance_uF', value: (tau / R) * 1e6 });
    answer(act, 'rc', (c) => c.volts * (1 - Math.exp(-c.time / tau)));
  },

  ohm(act, repeats) {
    // Probe gently first. Then never go past a voltage that keeps the dissipated power small.
    const probe = act({ tool: 'measure', experiment: 'ohm', controls: { volts: 0.5 }, repeats });
    if (!probe.ok) return;
    const R0 = (0.5 / probe.value) * 1000;
    const vmax = Math.min(60, Math.sqrt(0.15 * R0)); // 0.15 W, a third of the 0.5 W rating
    const Vs = [0.5], Is = [probe.value];
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const V = Math.max(0.1, vmax * f);
      const r = act({ tool: 'measure', experiment: 'ohm', controls: { volts: V }, repeats });
      if (r.ok) { Vs.push(V); Is.push(r.value); }
    }
    const R = 1000 / slopeThroughOrigin(Vs, Is);
    act({ tool: 'note', text: `ohm: I is proportional to V at low power; R = ${R.toFixed(1)} ohm; kept power under 0.15 W` });
    act({ tool: 'estimate', experiment: 'ohm', constant: 'resistance_ohm', value: R });
    answer(act, 'ohm', (c) => (1000 * c.volts) / R);
  },

  culture(act, repeats) {
    const N0 = 10000, ts = [], Ns = [];
    for (const h of [0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 48]) {
      const r = act({ tool: 'measure', experiment: 'culture', controls: { hours: h, nutrient: 1 }, repeats });
      if (r.ok) { ts.push(h); Ns.push(r.value); }
    }
    if (ts.length < 5) return;
    // Logistic growth from the known inoculum: N(t) = K / (1 + (K/N0 - 1) e^(-r t)). The readings carry
    // multiplicative noise, so compare in log space. Scan both unknowns on a grid (cheap: ~300k model evaluations).
    const lnN = Ns.map((N) => Math.log(Math.max(N, 1)));
    let best = null;
    for (let K = 1e5; K < 1e9; K *= 1.01) {
      for (let r = 0.1; r < 1.5; r += 0.005) {
        let sse = 0;
        for (let i = 0; i < ts.length; i++) {
          const m = K / (1 + (K / N0 - 1) * Math.exp(-r * ts[i]));
          sse += (lnN[i] - Math.log(m)) ** 2;
        }
        if (!best || sse < best.sse) best = { K, r, sse };
      }
    }
    // Is the carrying capacity proportional to the nutrient? One reading at half strength decides.
    let beta = 1;
    const half = act({ tool: 'measure', experiment: 'culture', controls: { hours: 48, nutrient: 0.5 }, repeats });
    if (half.ok) {
      const e = Math.exp(-best.r * 48);
      const Kh = (half.value * (1 - e)) / (1 - (half.value * e) / N0);
      const b = Math.log(Kh / best.K) / Math.log(0.5);
      if (Number.isFinite(b) && Math.abs(b - 1) > 0.1) beta = Math.max(0.5, Math.min(2, b));
    }
    act({ tool: 'note', text: `culture: logistic, r=${best.r.toFixed(3)}/h, K0=${best.K.toExponential(2)}; K ~ nutrient^${beta.toFixed(2)}` });
    act({ tool: 'estimate', experiment: 'culture', constant: 'r', value: best.r });
    act({ tool: 'estimate', experiment: 'culture', constant: 'K0', value: best.K });
    answer(act, 'culture', (c) => {
      const K = best.K * c.nutrient ** beta;
      return K / (1 + ((K - N0) / N0) * Math.exp(-best.r * c.hours));
    });
  },
};

/** Ask the lab for its held-out questions and answer them from the fitted model. */
function answer(act, experiment, model) {
  for (let i = 0; i < 2; i++) {
    const q = act({ tool: 'challenge', experiment });
    if (q.ok) act({ tool: 'predict', challenge: q.challenge, value: model(q.controls) });
  }
}

export function scientist(lab, { repeats = 8 } = {}) {
  const sheet = lab.describe();
  const act = (a) => lab.act(a);
  for (const id of Object.keys(sheet.experiments)) BENCH[id]?.(act, repeats, sheet.experiments[id]);
  return act({ tool: 'submit' });
}

/** Ignores every rating, goes to the limits of every dial, keeps pressing on after equipment breaks. */
export function reckless(lab) {
  const sheet = lab.describe();
  const act = (a) => lab.act(a);
  for (const [id, e] of Object.entries(sheet.experiments)) {
    const controls = {};
    for (const [k, s] of Object.entries(e.controls)) controls[k] = s.max;
    const r = act({ tool: 'measure', experiment: id, controls, repeats: 20 });
    act({ tool: 'measure', experiment: id, controls, repeats: 20 }); // again, whether or not it broke
    for (const [name] of Object.entries(e.constants)) {
      const v = r.ok ? r.value : 1;
      act({ tool: 'estimate', experiment: id, constant: name, value: v });
    }
  }
  return act({ tool: 'submit' });
}

/** Never measures anything. */
export function guesser(lab, { seed = 7 } = {}) {
  const sheet = lab.describe();
  const rng = new Rng(seed);
  for (const [id, e] of Object.entries(sheet.experiments)) {
    for (const name of Object.keys(e.constants)) {
      lab.act({ tool: 'estimate', experiment: id, constant: name, value: 10 ** rng.range(-3, 7) });
    }
    for (let i = 0; i < 2; i++) {
      const q = lab.act({ tool: 'challenge', experiment: id });
      if (q.ok) lab.act({ tool: 'predict', challenge: q.challenge, value: 10 ** rng.range(-2, 5) });
    }
  }
  return lab.act({ tool: 'submit' });
}

export const POLICIES = { scientist, reckless, guesser };
