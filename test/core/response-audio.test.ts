/**
 * The spoken copy of a reply: response/reply.wav, made by the project's own synthesizer.
 */
import { describe, it, expect } from 'vitest'
import { renderSpeechWav, speakable, SAMPLE_RATE } from '../../interface/response-audio.js'
import { buildResponseBundle } from '../../interface/response-bundle.js'
import { readZip } from '../../models && skills/core/zip-archive.js'

const samples = (wav: Buffer) => { const out: number[] = []; for (let i = 44; i + 1 < wav.length; i += 2) out.push(wav.readInt16LE(i)); return out }
const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / Math.max(1, xs.length))

describe('speech wav', () => {
  it('is a valid 16-bit mono PCM wav whose header matches its data', () => {
    const wav = renderSpeechWav('Hello there. How are you?')!
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44)
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
  })
  it('makes sound, within range, and the same bytes for the same text', () => {
    const a = renderSpeechWav('Hello there')!
    const xs = samples(a)
    expect(rms(xs)).toBeGreaterThan(500)
    expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(32767)
    expect(a.equals(renderSpeechWav('Hello there')!)).toBe(true)
    expect(a.equals(renderSpeechWav('Goodbye')!)).toBe(false)
  })
  it('is longer for longer text, and stops at the time limit', () => {
    expect(renderSpeechWav('hello hello hello hello')!.length).toBeGreaterThan(renderSpeechWav('hello')!.length)
    const capped = renderSpeechWav('hello '.repeat(5000), { maxSeconds: 2 })!
    expect(capped.length).toBeLessThanOrEqual(44 + 2 * SAMPLE_RATE * 2)
  })
  it('says nothing for text with nothing to say', () => {
    expect(renderSpeechWav('')).toBe(null)
    expect(renderSpeechWav('[[ask: Go | go on]] {{x}} ```code``` 😀')).toBe(null)
  })
  it('leaves out buttons, markers, code and links, and spells digits', () => {
    expect(speakable('Hi [[ask: A | b]] {{def}} https://x.y `z` 42')).toBe('Hi z four two')
  })
})

describe('in the zip', () => {
  const files = (zip: Buffer) => Object.fromEntries(readZip(zip).map(e => [e.name, e.data]))
  it('puts reply.wav in response/ next to reply.md', () => {
    const f = files(buildResponseBundle({ response: 'Hello there.' }))
    expect(Object.keys(f)).toContain('response/reply.md')
    expect(f['response/reply.wav'].toString('ascii', 0, 4)).toBe('RIFF')
    expect(JSON.parse(f['manifest.json'].toString()).files).toContain('response/reply.wav')
  })
  it('speaks the reply after definitions and approved edits, not the raw text', () => {
    const plain = files(buildResponseBundle({ response: 'Say {{w}}.', definitions: { w: 'hello' } }))['response/reply.wav']
    expect(plain.equals(renderSpeechWav('Say hello.')!)).toBe(true)
  })
  it('can be left out, and is absent when the reply has nothing to say', () => {
    expect(files(buildResponseBundle({ response: 'Hello', audio: false }))['response/reply.wav']).toBe(undefined)
    expect(files(buildResponseBundle({ response: '[[ask: A | b]]' }))['response/reply.wav']).toBe(undefined)
  })
})
