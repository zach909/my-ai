/**
 * The EEG decoder finds what it is built to find in simulated signals, and the
 * plugin reads only from its drop folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EegPlugin } from '../../plugins/eeg.js'
import { createPluginInstance, pluginExtensions } from '../../plugins/index.js'
import { bandPower, decodeEeg, demoRecording, eventsToBytes, parseEegText, simulateEeg } from '../../plugins/eeg-decoder.js'

let dir: string
const saved = process.env.CORONA_DATA_DIR
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'eeg-plugin-')); process.env.CORONA_DATA_DIR = dir })
afterEach(() => { if (saved === undefined) delete process.env.CORONA_DATA_DIR; else process.env.CORONA_DATA_DIR = saved; rmSync(dir, { recursive: true, force: true }) })

const plugin = () => new EegPlugin({ id: 'eeg', name: 'EEG', type: 'api-connection', capabilities: ['eeg'] } as never)
const say = async (m: string) => ((await plugin().onMessage(m)) as { result: string } | null)

describe('decoder', () => {
  it('puts a 10 Hz tone in the alpha band', () => {
    const fs = 256
    const x = Array.from({ length: fs * 2 }, (_, i) => Math.sin((2 * Math.PI * 10 * i) / fs))
    const p = bandPower(x, fs)
    const total = Object.values(p).reduce((a, b) => a + b, 0)
    expect(p.alpha / total).toBeGreaterThan(0.9)
  })

  it('labels relaxed, focused and drowsy stretches and finds the blink', () => {
    const d = decodeEeg(demoRecording())
    const states = d.events.filter(e => e.kind === 'state').map(e => e.label)
    expect(states).toEqual(['relaxed', 'focused', 'drowsy'])
    const blinks = d.events.filter(e => e.kind === 'blink')
    expect(blinks.length).toBe(1)
    expect(blinks[0].t).toBeGreaterThanOrEqual(15)
    expect(blinks[0].t).toBeLessThanOrEqual(18)
  })

  it('finds a jaw clench', () => {
    const d = decodeEeg(simulateEeg([{ state: 'relaxed', seconds: 14, clenchAt: [6] }]))
    expect(d.events.some(e => e.kind === 'clench')).toBe(true)
  })

  it('reports nothing special for steady signal and is repeatable', () => {
    const a = decodeEeg(simulateEeg([{ state: 'relaxed', seconds: 10 }], 256, 7))
    const b = decodeEeg(simulateEeg([{ state: 'relaxed', seconds: 10 }], 256, 7))
    expect(a.events).toEqual(b.events)
    expect(a.events.filter(e => e.kind !== 'state')).toEqual([])
  })

  it('parses text with a header, a time column and a rate comment', () => {
    const rows = ['# fs=128', 'time,ch1,ch2']
    for (let i = 0; i < 300; i++) rows.push(`${i},${Math.sin(i / 3)},${Math.cos(i / 5)}`)
    const rec = parseEegText(rows.join('\n'))
    expect(rec.sampleRate).toBe(128)
    expect(rec.channels.length).toBe(2)
    expect(rec.channels[0].length).toBe(300)
  })

  it('refuses bad input with a clear message', () => {
    expect(() => parseEegText('1\n2\n3')).toThrow(/at least 2 seconds/)
    expect(() => parseEegText('# fs=5\n' + '1\n'.repeat(1000))).toThrow(/Sample rate/)
  })

  it('packs events as raw bytes, four per event', () => {
    const bytes = eventsToBytes(decodeEeg(demoRecording()).events)
    expect(bytes.length % 4).toBe(0)
    expect(bytes.length).toBeGreaterThan(0)
  })
})

describe('EegPlugin', () => {
  it('ignores chat that does not start with the command', async () => {
    expect(await say('what does an eeg measure?')).toBeNull()
    expect(await say('')).toBeNull()
  })

  it('explains itself and says it cannot read thoughts', async () => {
    expect((await say('eeg'))!.result).toMatch(/cannot read thoughts/)
  })

  it('decodes the demo', async () => {
    const r = await say('eeg demo')
    expect(r!.result).toMatch(/state -> focused/)
    expect(r!.result).toMatch(/blink/)
  })

  it('decodes a file from the drop folder and refuses anything else', async () => {
    mkdirSync(path.join(dir, 'eeg'), { recursive: true })
    const rows = ['# fs=256']
    const rec = simulateEeg([{ state: 'focused', seconds: 10 }])
    for (const v of rec.channels[0]) rows.push(String(v))
    writeFileSync(path.join(dir, 'eeg', 'a.csv'), rows.join('\n'))
    expect((await say('eeg list'))!.result).toContain('a.csv')
    expect((await say('eeg decode a.csv'))!.result).toMatch(/Decoded 10\.0 s/)
    expect((await say('eeg decode ../secret.csv'))!.result).toMatch(/no folders/)
    expect((await say('eeg decode /etc/passwd'))!.result).toMatch(/no folders/)
    expect((await say('eeg decode missing.csv'))!.result).toMatch(/no recording missing\.csv/)
  })

  it('does not follow a symlink out of the drop folder', async () => {
    mkdirSync(path.join(dir, 'eeg'), { recursive: true })
    writeFileSync(path.join(dir, 'outside.csv'), '1\n2\n')
    try { symlinkSync(path.join(dir, 'outside.csv'), path.join(dir, 'eeg', 'link.csv')) } catch { return }
    expect((await say('eeg decode link.csv'))!.result).toMatch(/no recording link\.csv/)
  })

  it('is registered', () => {
    expect(pluginExtensions.eeg).toBeDefined()
    expect(createPluginInstance('eeg', pluginExtensions.eeg)).toBeInstanceOf(EegPlugin)
  })
})
