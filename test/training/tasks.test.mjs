/**
 * Tests for task training (training/tasks/): audio and video tasks, exact-match scoring, live captions.
 * Node's built-in runner:  node --test "test/training/*.test.mjs"
 * Offline and generated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trainSoftmax, predict, score } from '../../training/tasks/learn.mjs'
import { runAudio, makeClip, windows, noteFeatures, TRAIN, HELD } from '../../training/tasks/audio.mjs'
import { Rng } from '../../training/simulation/random.mjs'
import { trainVideo, examVideo, makeVideo, packVideo, unpackVideo, captionFor, liveCaption, causalityCheck, T } from '../../training/tasks/video.mjs'

test('the learner trains on task answers and beats both baselines', () => {
  const X = [], y = []
  for (let i = 0; i < 90; i++) { const c = i % 3; X.push([c + Math.sin(i) * 0.1, (c * 2) % 3]); y.push(c) }
  const m = trainSoftmax(X, y, 3, { epochs: 150 })
  assert.ok(m.loss.at(-1) < m.loss[0])
  const s = score(m, X, y)
  assert.ok(s.accuracy > 0.95 && s.accuracy > s.chance && s.accuracy > s.majority)
})

test('audio: a clip has an exact answer key and the held-out keys/modes differ from the training ones', () => {
  const c = makeClip(new Rng(3), { len: 6, ...TRAIN })
  assert.equal(windows(c).length, c.midi.length)
  assert.equal(c.pcm.length, c.midi.length * 1000)
  assert.ok(TRAIN.tonics.every((t) => !HELD.tonics.includes(t)))
  assert.ok(TRAIN.modes.every((m) => !HELD.modes.includes(m)))
  assert.equal(noteFeatures(windows(c)[0]).length, 51)
})

test('audio: trained note task decodes unseen keys and modes far above chance', () => {
  const r = runAudio({ trainClips: 60, testClips: 20, epochs: 120 })
  const unseen = r.results.find((x) => x.exam === 'UNSEEN keys+modes')
  assert.ok(unseen.note.accuracy > 0.8, String(unseen.note.accuracy))
  assert.ok(unseen.note.accuracy > 10 * unseen.note.chance)
})

test('video: captions are part of the sample and survive packing', () => {
  const v = makeVideo(new Rng(1), { hue: 2, dir: 0, speed: 1 })
  assert.equal(v.captions.length, T)
  assert.equal(v.captions[0], 'green square')
  assert.equal(v.captions[3], 'green square moving right fast')
  const u = unpackVideo(packVideo(v))
  assert.deepEqual(u.captions, v.captions)
  assert.equal(u.frames.length, v.frames.length)
})

test('video: live captions use only frames up to the current one', () => {
  const models = trainVideo({ trainVideos: 60, epochs: 100 })
  const v = makeVideo(new Rng(9), { hue: 4, dir: 2, speed: 0 })
  assert.equal(causalityCheck(models, v), true)
  assert.equal(liveCaption(models, v.frames, 0), captionFor({ hue: 4 }, 0))
})

test('video: held-out hue+direction combinations get exact live captions', () => {
  const models = trainVideo({ trainVideos: 80, epochs: 120 })
  const r = examVideo(models, { count: 20 })
  assert.ok(r.captionExactPerFrame > 0.9, String(r.captionExactPerFrame))
  assert.equal(r.liveCaptionsCausal, '20/20')
})
