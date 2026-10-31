#!/usr/bin/env node
/**
 * train-open-corpus.mjs -- train NeuroclawTrainer (char-level, no tokenizer) on the cited
 * open corpus in training_data/open_corpus and score it on held-out text.
 * Needs the backend built first (node scripts/build-backend.mjs) so dist/ has trainer.js.
 *
 * Usage: node scripts/train-open-corpus.mjs [trainChars=300000] [distDir] [corpusDir]
 * Held-out = unseen passages of the same books + 3 unseen Wikipedia summaries + two book openings.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
const BUILD = process.argv[3] ?? path.join('dist', 'models && skills')
const CORPUS = process.argv[4] ?? path.join('training_data', 'open_corpus')
const TRAIN_CHARS = Number(process.argv[2] ?? 300000)
const { NeuroclawTrainer } = await import(path.join(BUILD, 'trainer.js'))

const read = (d) => readdirSync(path.join(CORPUS, d)).sort().map((f) => ({ f, t: readFileSync(path.join(CORPUS, d, f), 'utf8').replace(/\s+/g, ' ') }))
const books = read('gutenberg'), wiki = read('wikipedia')

// Training text: an equal slice from every document (middle of each book), wiki in full for 6 of 15.
const heldWiki = wiki.filter((_, i) => i % 5 === 4)         // 3 articles never trained on
const trainWiki = wiki.filter((_, i) => i % 5 !== 4)
const per = Math.floor((TRAIN_CHARS - trainWiki.reduce((a, w) => a + w.t.length, 0)) / books.length)
let train = '', heldSame = []
for (const b of books) {
  const mid = Math.floor(b.t.length / 2)
  train += b.t.slice(mid, mid + per) + ' '
  heldSame.push(b.t.slice(mid + per + 1000, mid + per + 1000 + 3000))   // same book, unseen passage
}
for (const w of trainWiki) train += w.t + ' '
const heldNew = [books[3].t.slice(0, 3000), books[5].t.slice(0, 3000), ...heldWiki.map((w) => w.t)]  // (Darwin, Plato start) are partly in train? start != mid -> unseen

const chars = [...new Set(train + heldSame.join('') + heldNew.join(''))].sort()
const charToId = new Map(), idToChar = new Map()
chars.forEach((c, i) => { charToId.set(c, i + 4); idToChar.set(i + 4, c) })
const V = chars.length + 4

function score(model, texts) {
  let n = 0, top1 = 0, lp = 0
  for (const t of texts) for (let i = 8; i < t.length; i++) {
    const id = charToId.get(t[i]); if (id === undefined) continue
    const p = model.predict(t.slice(Math.max(0, i - 8), i))
    let best = 4; for (let v = 5; v < V; v++) if (p[v] > p[best]) best = v
    n++; if (best === id) top1++
    lp += Math.log(Math.max(p[id], 1e-6))
  }
  return { n, top1: +(top1 / n).toFixed(4), ppl: +Math.exp(-lp / n).toFixed(2) }
}

const model = new NeuroclawTrainer(V, charToId, idToChar, { epochs: 1 })
const before = { same: score(model, heldSame), other: score(model, heldNew) }
const t0 = Date.now()
await model.train(train)
const secs = ((Date.now() - t0) / 1000).toFixed(1)
const after = { same: score(model, heldSame), other: score(model, heldNew) }
console.log(JSON.stringify({ trainChars: train.length, vocab: V, trainSecs: +secs, loss: model.getTrainingLoss(), samples: model.getSamplesProcessed(), before, after, randomTop1: +(1 / chars.length).toFixed(4) }, null, 1))
