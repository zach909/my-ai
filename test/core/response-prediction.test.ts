/**
 * The prediction folder: a guess at the next message is always there, and is scored when the real one arrives.
 */
import { describe, it, expect } from 'vitest'
import { predictionId, resolvePrediction, scoreGuess, scorePrediction, predictionFiles } from '../../interface/response-prediction.js'
import { buildResponseBundle } from '../../interface/response-bundle.js'
import { readZip } from '../../models && skills/core/zip-archive.js'

const files = (zip: Buffer) => Object.fromEntries(readZip(zip).map(e => [e.name, e.data.toString('utf8')]))
const NOW = new Date('2026-01-02T03:04:05Z')

describe('scoring a guess', () => {
  it('is 1 similarity and 0 surprise for the same message, and exact', () => {
    const o = scoreGuess('what is the capital of spain', 'What is the capital of Spain?')
    expect(o.similarity).toBeGreaterThan(0.99)
    expect(o.surprise).toBeLessThan(0.01)
    expect(scoreGuess('thanks', ' thanks ').exact).toBe(true)
  })
  it('is full surprise for something unrelated, or for no guess at all', () => {
    expect(scoreGuess('hello there', 'quantum chromodynamics').surprise).toBe(1)
    const none = scoreGuess('', 'anything at all')
    expect(none).toMatchObject({ similarity: 0, surprise: 1, exact: false })
  })
  it('an empty guess never counts as an exact match, even for an empty message', () => {
    expect(scoreGuess('', '').exact).toBe(false)
  })
})

describe('the record', () => {
  it('is forced: nothing given gives an empty guess marked as none, not an invented one', () => {
    const r = resolvePrediction(undefined, 'a reply', NOW)
    expect(r).toMatchObject({ predicted: '', source: 'none', status: 'open', madeAt: NOW.toISOString() })
  })
  it('keeps a string guess, and a mesh guess keeps its source', () => {
    expect(resolvePrediction('tell me more', 'r', NOW)).toMatchObject({ predicted: 'tell me more', source: 'caller' })
    expect(resolvePrediction({ predicted: 'tell me more', source: 'mesh' }, 'r', NOW).source).toBe('mesh')
  })
  it('has an id that follows the reply and the guess', () => {
    expect(predictionId('r', 'g')).toBe(predictionId('r', 'g'))
    expect(predictionId('r', 'g')).not.toBe(predictionId('r', 'h'))
    expect(predictionId('r', 'g')).not.toBe(predictionId('s', 'g'))
  })
  it('scores once: a second message does not replace the first score', () => {
    const open = resolvePrediction('yes please', 'r', NOW)
    const one = scorePrediction(open, 'yes please')
    expect(one.status).toBe('scored')
    const two = scorePrediction(one, 'something else entirely')
    expect(two.outcome).toEqual(one.outcome)
  })
  it('recomputes a stored outcome instead of trusting it', () => {
    const forged = { predicted: 'hello', outcome: { actual: 'goodbye', similarity: 1, surprise: 0, exact: true } }
    const r = resolvePrediction(forged, 'r', NOW)
    expect(r.outcome).toMatchObject({ similarity: 0, surprise: 1, exact: false })
  })
  it('drops fields it does not know', () => {
    const r = resolvePrediction({ predicted: 'x', evil: '../../etc', source: 'mesh' }, 'r', NOW) as unknown as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual(['id', 'madeAt', 'predicted', 'source', 'status'])
  })
  it('writes outcome.json only once scored', () => {
    const open = resolvePrediction('x', 'r', NOW)
    expect(predictionFiles(open).map(f => f.name)).toEqual(['prediction/next-message.md', 'prediction/prediction.json'])
    expect(predictionFiles(scorePrediction(open, 'x')).map(f => f.name)).toContain('prediction/outcome.json')
  })
})

describe('in the zip', () => {
  it('always has the prediction folder, even with no guess', () => {
    const f = files(buildResponseBundle({ response: 'Hello.', formats: false, audio: false }, NOW))
    expect(JSON.parse(f['prediction/prediction.json'])).toMatchObject({ predicted: '', source: 'none', status: 'open' })
    expect(f['prediction/next-message.md']).toContain('no guess')
    expect(f['prediction/outcome.json']).toBeUndefined()
    expect(JSON.parse(f['manifest.json']).folders.prediction).toBeTruthy()
  })
  it('carries the guess, and the score once the real next message is given', () => {
    const f = files(buildResponseBundle({ response: 'Hello.', prediction: { predicted: 'how are you', source: 'mesh' }, actualNext: 'How are you?', formats: false, audio: false }, NOW))
    expect(f['prediction/next-message.md']).toBe('how are you\n')
    const out = JSON.parse(f['prediction/outcome.json'])
    expect(out.similarity).toBeGreaterThan(0.99)
    expect(out.actual).toBe('How are you?')
    expect(JSON.parse(f['prediction/prediction.json']).status).toBe('scored')
  })
  it('scores the guess against the reply as it now reads, so an id matches what was said', () => {
    const a = files(buildResponseBundle({ response: 'Say {{w}}.', definitions: { w: 'hi' }, formats: false, audio: false }, NOW))
    const b = files(buildResponseBundle({ response: 'Say hi.', formats: false, audio: false }, NOW))
    expect(JSON.parse(a['prediction/prediction.json']).id).toBe(JSON.parse(b['prediction/prediction.json']).id)
  })
})
