/**
 * learn.mjs -- the learner used for task training. Own code, Node built-ins only.
 *
 * "Train on tasks, not prediction": every example here is (input, the task's answer) and the loss is on that answer
 * alone. Nothing predicts the next byte, sample or frame. A model is scored by exact match on the task, on examples
 * built from rule combinations it never trained on, next to a chance baseline and a most-common-answer baseline.
 *
 * The learner is multinomial logistic regression (softmax) trained by full-batch gradient descent on standardised
 * features. It is deliberately small and fully inspectable: what it learns is a weight matrix, not a lookup of
 * training examples, and the feature front ends (audio.mjs, video.mjs) are hand-written signal processing, not learned.
 */

export function fitStandardiser(X) {
  const d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0)
  for (const r of X) for (let i = 0; i < d; i++) mu[i] += r[i] / X.length
  for (const r of X) for (let i = 0; i < d; i++) sd[i] += (r[i] - mu[i]) ** 2 / X.length
  return { mu, sd: sd.map((v) => Math.sqrt(v) || 1) }
}
export const standardise = (s, x) => x.map((v, i) => (v - s.mu[i]) / s.sd[i])

function softmax(z) {
  const m = Math.max(...z), e = z.map((v) => Math.exp(v - m)), t = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / t)
}

/** Train. X: number[][], y: integer class per row. Returns a model; `loss` is the training loss curve (every 25 epochs). */
export function trainSoftmax(X, y, nClasses, { epochs = 300, lr = 0.5, l2 = 1e-4 } = {}) {
  const std = fitStandardiser(X), Z = X.map((r) => standardise(std, r)), d = Z[0].length
  const W = Array.from({ length: nClasses }, () => new Array(d).fill(0)), b = new Array(nClasses).fill(0), loss = []
  for (let ep = 0; ep < epochs; ep++) {
    const gW = Array.from({ length: nClasses }, () => new Array(d).fill(0)), gb = new Array(nClasses).fill(0)
    let L = 0
    for (let n = 0; n < Z.length; n++) {
      const p = softmax(W.map((w, c) => b[c] + w.reduce((s, wi, i) => s + wi * Z[n][i], 0)))
      L -= Math.log(Math.max(p[y[n]], 1e-12))
      for (let c = 0; c < nClasses; c++) {
        const g = p[c] - (c === y[n] ? 1 : 0)
        gb[c] += g
        for (let i = 0; i < d; i++) gW[c][i] += g * Z[n][i]
      }
    }
    for (let c = 0; c < nClasses; c++) {
      b[c] -= (lr * gb[c]) / Z.length
      for (let i = 0; i < d; i++) W[c][i] -= lr * (gW[c][i] / Z.length + l2 * W[c][i])
    }
    if (ep % 25 === 0 || ep === epochs - 1) loss.push(+(L / Z.length).toFixed(4))
  }
  return { W, b, std, nClasses, loss, majority: majorityClass(y, nClasses) }
}

export function predict(model, x) {
  const z = standardise(model.std, x)
  const s = model.W.map((w, c) => model.b[c] + w.reduce((a, wi, i) => a + wi * z[i], 0))
  return s.indexOf(Math.max(...s))
}

function majorityClass(y, k) {
  const c = new Array(k).fill(0); for (const v of y) c[v]++
  return c.indexOf(Math.max(...c))
}

/** Accuracy plus the two baselines the task must beat: uniform chance and always-the-most-common-training-answer. */
export function score(model, X, y) {
  let ok = 0, maj = 0
  X.forEach((x, i) => { if (predict(model, x) === y[i]) ok++; if (model.majority === y[i]) maj++ })
  return { n: y.length, accuracy: +(ok / y.length).toFixed(4), chance: +(1 / model.nClasses).toFixed(4), majority: +(maj / y.length).toFixed(4) }
}
