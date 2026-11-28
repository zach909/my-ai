#!/usr/bin/env node
/**
 * Train the audio and video task models and report exact-match scores on held-out combinations.
 *   node training/tasks/run.mjs            (about a minute; everything is generated, nothing is downloaded)
 */
import { runAudio } from './audio.mjs'
import { trainVideo, examVideo } from './video.mjs'

const t0 = Date.now()
const audio = runAudio()
console.log(`AUDIO: trained the note task on ${audio.trained.clips} clips (${audio.trained.notes} notes); loss ${audio.trained.loss[0]} -> ${audio.trained.loss.at(-1)}`)
for (const r of audio.results) {
  console.log(`  ${r.exam.padEnd(34)} note ${r.note.accuracy} (chance ${r.note.chance}, most-common ${r.note.majority})  whole tune exact ${r.tuneExact} over ${r.tunes}  notes never trained: ${r.notesNeverTrained}`)
}

const models = trainVideo()
console.log(`\nVIDEO: trained on ${models.trained.videos} videos (${models.trained.samples} motion samples); hue/direction/speed classifiers`)
for (const [name, cfg] of [['seen combinations (sanity)', { heldOut: false }], ['UNSEEN hue+direction combinations', {}], ['UNSEEN combinations, much noisier', { noise: 0.5 }]]) {
  const r = examVideo(models, cfg)
  console.log(`  ${name.padEnd(36)} hue ${r.hue.accuracy} (chance ${r.hue.chance})  direction ${r.direction.accuracy} (chance ${r.direction.chance})  speed ${r.speed.accuracy} (chance ${r.speed.chance})`)
  console.log(`  ${''.padEnd(36)} live caption exact: per frame ${r.captionExactPerFrame}, whole video ${r.captionExactWholeVideo}; causal ${r.liveCaptionsCausal} of ${r.videos} videos`)
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
