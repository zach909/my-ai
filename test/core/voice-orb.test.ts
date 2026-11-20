/**
 * The voice orb: what it plays from a response zip (audio file first, else the text for the system voice), which
 * visual it casts, and the rules its page script has to follow (interface/voice-orb.ts).
 */
import { describe, it, expect } from 'vitest'
import { ORB_CLIENT_JS, ORB_CSS, orbMedia, sniffAudio, sniffImage, spokenText, speechChunks } from '../../interface/voice-orb.js'
import { bundleEntries } from '../../interface/response-bundle.js'
import { renderSpeechWav } from '../../interface/response-audio.js'
import { readZip, writeZip, type ZipEntry } from '../../models && skills/core/zip-archive.js'

const file = (name: string, data: Buffer | string): ZipEntry => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
const wav = renderSpeechWav('hello there')!
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const FENCE = '```'

describe('what the orb plays', () => {
  it('prefers the audio file, and still carries the text', () => {
    const m = orbMedia([file('response/reply.md', 'Hello there. How are you?'), file('response/reply.wav', wav)])
    expect(m.source).toBe('audio')
    expect(m.audio).toMatchObject({ name: 'response/reply.wav', mime: 'audio/wav' })
    expect(Buffer.from(m.audio!.data, 'base64').equals(wav)).toBe(true)
    expect(m.speech.join(' ')).toBe('Hello there. How are you?')
  })

  it('falls back to the text for the system voice when there is no audio file', () => {
    const m = orbMedia([file('response/reply.md', 'Hello there.')])
    expect(m.source).toBe('voice')
    expect(m.audio).toBeNull()
    expect(m.speech).toEqual(['Hello there.'])
  })

  it('has nothing to play when there is neither, or the text has nothing to say', () => {
    expect(orbMedia([file('manifest.json', '{}')]).source).toBe('none')
    expect(orbMedia([file('response/reply.md', `${FENCE}js\nlet a = 1\n${FENCE}`)]).source).toBe('none')
  })

  it('does not play a file that only has an audio name', () => {
    const m = orbMedia([file('response/reply.md', 'Hi there.'), file('response/reply.wav', 'this is plain text')])
    expect(m.source).toBe('voice')
    expect(m.notes.join(' ')).toContain('not an audio file')
  })

  it('never plays or casts anything from response/formats/, where text is only relabelled', () => {
    const m = orbMedia([file('response/reply.md', 'Hi there.'), file('response/formats/WAV.wav', wav), file('response/formats/visual.png', png)])
    expect(m.audio).toBeNull()
    expect(m.visual).toBeNull()
  })

  it('prefers reply.* and response/ among several audio files', () => {
    const m = orbMedia([file('other/zed.wav', wav), file('response/note.wav', wav), file('response/reply.wav', wav)])
    expect(m.audio!.name).toBe('response/reply.wav')
  })

  it('casts a visual file onto the circle: an image by its bytes, html as source', () => {
    const img = orbMedia([file('response/reply.md', 'x y'), file('response/visual.png', png)])
    expect(img.visual).toMatchObject({ name: 'response/visual.png', kind: 'image', mime: 'image/png' })
    const html = orbMedia([file('response/visual.html', '<b>hi</b>')])
    expect(html.visual).toEqual({ name: 'response/visual.html', kind: 'html', mime: 'text/html', data: '<b>hi</b>' })
    expect(orbMedia([file('response/visual.png', 'not a picture at all')]).visual).toBeNull()
    expect(orbMedia([file('response/visual.html', '   ')]).visual).toBeNull()
  })

  it('recognises files by their first bytes', () => {
    expect(sniffAudio(wav)).toBe('audio/wav')
    expect(sniffAudio(Buffer.from('OggS' + 'x'.repeat(20)))).toBe('audio/ogg')
    expect(sniffAudio(Buffer.from('ID3' + 'x'.repeat(20)))).toBe('audio/mpeg')
    expect(sniffAudio(Buffer.from('just some words here'))).toBeNull()
    expect(sniffImage(png)).toBe('image/png')
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImage(Buffer.from('<html><body>not an image</body></html>'))).toBeNull()
  })
})

describe('what the system voice says', () => {
  it('leaves out code, visuals, markers, links and markdown marks', () => {
    const md = `# Title\n\nSome **bold** text, a [link](https://example.com) and \`code\`.\n\n${FENCE}visual\n<b>x</b>\n${FENCE}\n\n- one\n- two\n\n[[ask: More | tell me more]]\n\nSee https://example.com/page now.`
    expect(spokenText(md)).toBe('Title\nSome bold text, a link and code.\none\ntwo\nSee now.')
  })

  it('runs an unterminated fence to the end instead of reading code aloud', () => {
    expect(spokenText(`Before.\n${FENCE}js\nlet secret = 1`)).toBe('Before.')
  })

  it('cuts into short pieces at sentence ends and packs them back up', () => {
    expect(speechChunks('One. Two. Three.', 220)).toEqual(['One. Two. Three.'])
    expect(speechChunks('One.\nTwo.', 220)).toEqual(['One. Two.'])
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const parts = speechChunks(long, 100)
    expect(parts.length).toBeGreaterThan(5)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100)
    expect(parts.join(' ')).toBe(long)
  })

  it('splits one very long sentence at commas or spaces, never in a word', () => {
    const s = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const parts = speechChunks(s, 60)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(61)
    expect(parts.join(' ')).toBe(s)
  })

  it('stops at a limit and says so', () => {
    const m = orbMedia([file('response/reply.md', 'word '.repeat(10_000))])
    expect(m.speech.join(' ').length).toBeLessThanOrEqual(20_000)
    expect(m.notes.join(' ')).toContain('read aloud')
  })
})

describe('the reply zip', () => {
  it('plays from a real response zip: audio file first', () => {
    const zip = writeZip(bundleEntries({ response: 'Hello there. This is the reply.', formats: false }))
    const m = orbMedia(readZip(zip))
    expect(m.source).toBe('audio')
    expect(m.audio!.name).toBe('response/reply.wav')
  })

  it('uses the system voice when the zip was made without audio', () => {
    const m = orbMedia(readZip(writeZip(bundleEntries({ response: 'Hello there. This is the reply.', audio: false, formats: false }))))
    expect(m.source).toBe('voice')
    expect(m.speech.join(' ')).toBe('Hello there. This is the reply.')
  })

  it('writes the first visual block of a reply as response/visual.html, and the orb casts it', () => {
    const reply = `Here you go.\n${FENCE}visual\n<button id="go">Roll</button>\n${FENCE}\nDone.`
    const names = bundleEntries({ response: reply, formats: false }).map(e => e.name)
    expect(names).toContain('response/visual.html')
    const m = orbMedia(bundleEntries({ response: reply, formats: false }))
    expect(m.visual).toMatchObject({ kind: 'html', data: '<button id="go">Roll</button>\n' })
    expect(m.speech.join(' ')).toBe('Here you go. Done.')
    expect(bundleEntries({ response: 'No visual here.', formats: false }).map(e => e.name)).not.toContain('response/visual.html')
  })
})

describe('the page script', () => {
  it('is valid JavaScript and defines ncOrb', () => {
    expect(() => new Function(ORB_CLIENT_JS + '\nreturn ncOrb;')).not.toThrow()
  })

  it('can be spliced into the chat template: no backticks, backslashes or dollar-brace', () => {
    expect(ORB_CLIENT_JS).not.toMatch(/[`\\]/)
    expect(ORB_CLIENT_JS).not.toContain('${')
  })

  it('uses no blue and no outside code or fonts', () => {
    for (const s of [ORB_CLIENT_JS, ORB_CSS]) {
      expect(s).not.toMatch(/#4a7dff|indigo|cyan|\bblue\b|https?:\/\/|@import|(^|[^A-Za-z])url\(/i)
    }
    expect(ORB_CSS).toContain('prefers-reduced-motion')
    expect(ORB_CLIENT_JS).toContain('prefers-reduced-motion')
  })
})
