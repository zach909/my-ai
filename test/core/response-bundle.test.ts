/**
 * A reply as a zip: response/, plugins/ and prompts/.
 */
import { describe, it, expect } from 'vitest'
import { buildResponseBundle, bundleEntries, classifyPrompt, pluginsFromDetails, safeName } from '../../interface/response-bundle.js'
import { readZip } from '../../models && skills/core/zip-archive.js'
import { splitPromptButtons } from '../../interface/prompt-buttons.js'

const files = (zip: Buffer) => Object.fromEntries(readZip(zip).map(e => [e.name, e.data.toString('utf8')]))

const details = {
  skills: [], recalled: [], route: null, emotion: null, mesh: null, zipBytes: 0, ms: 5,
  toolCalls: [
    { plugin: 'tools', tool: 'hash', ok: true },
    { plugin: 'tools', tool: 'convert', ok: false, error: 'unknown unit' },
    { plugin: 'terminal', tool: 'run', ok: true },
  ],
}

describe('the reply zip', () => {
  it('has the three folders and a manifest', () => {
    const f = files(buildResponseBundle({ message: 'hi', response: 'hello', details }))
    expect(Object.keys(f)).toEqual(expect.arrayContaining([
      'manifest.json', 'response/reply.md', 'response/question.md', 'response/details.json',
      'plugins/index.json', 'plugins/tools.json', 'plugins/terminal.json',
      'prompts/plugins.md', 'prompts/tools.md', 'prompts/commands.md', 'prompts/feedback.md',
    ]))
    expect(f['response/reply.md']).toBe('hello\n')
    for (const name of Object.keys(f)) expect(/^(response|plugins|prompts)\//.test(name) || name === 'manifest.json').toBe(true)
  })

  it('lists each plugin with what its tools did', () => {
    const f = files(buildResponseBundle({ response: 'x', details }))
    expect(JSON.parse(f['plugins/tools.json'])).toEqual({ plugin: 'tools', calls: [{ tool: 'hash', ok: true }, { tool: 'convert', ok: false, error: 'unknown unit' }] })
    expect(JSON.parse(f['plugins/index.json']).plugins).toEqual([
      { plugin: 'tools', file: 'plugins/tools.json', calls: 2, failed: 1 },
      { plugin: 'terminal', file: 'plugins/terminal.json', calls: 1, failed: 0 },
    ])
  })

  it('still has an empty plugins index when nothing was used', () => {
    const f = files(buildResponseBundle({ response: 'x' }))
    expect(JSON.parse(f['plugins/index.json'])).toEqual({ plugins: [] })
    expect(f['response/details.json']).toBeUndefined()
    expect(f['response/question.md']).toBeUndefined()
  })

  it('writes prompts in the button syntax the chat already understands', () => {
    const f = files(buildResponseBundle({ response: 'x', details }))
    for (const name of ['prompts/plugins.md', 'prompts/tools.md', 'prompts/commands.md', 'prompts/feedback.md']) {
      const buttons = splitPromptButtons(f[name]).filter(p => p.kind === 'button')
      expect(buttons.length).toBeGreaterThan(0)
      for (const b of buttons) expect(b.prompt && b.prompt.length).toBeGreaterThan(0)
    }
    // A failed tool gets a fix prompt that carries its error; a good one gets an explain prompt.
    expect(f['prompts/tools.md']).toContain('Fix tools.convert')
    expect(f['prompts/tools.md']).toContain('unknown unit')
    expect(f['prompts/tools.md']).toContain('Explain tools.hash')
  })

  it('files the reply\'s own buttons by what they are about', () => {
    const reply = 'More? [[ask: Run it | run the script again]] [[ask: Was that wrong? | tell me what was wrong]] [[ask: Convert units | convert 5 km to miles]] [[ask: Next | go on]] [[put: Pin | do it | desktop]]'
    const f = files(buildResponseBundle({ response: reply }))
    expect(f['prompts/commands.md']).toContain('Run it')
    expect(f['prompts/feedback.md']).toContain('Was that wrong?')
    expect(f['prompts/tools.md']).toContain('Convert units')
    expect(f['prompts/follow-ups.md']).toContain('Next')
    // A button for somewhere outside the chat is not a prompt to send.
    expect(Object.entries(f).filter(([n]) => n.startsWith('prompts/')).map(([, t]) => t).join('\n')).not.toContain('Pin')
  })

  it('classifies feedback before commands, commands before tools, tools before plugins', () => {
    expect(classifyPrompt({ label: 'Improve it', prompt: 'run again' })).toBe('feedback')
    expect(classifyPrompt({ label: 'Go', prompt: 'run the tool' })).toBe('commands')
    expect(classifyPrompt({ label: 'Go', prompt: 'use a tool plugin' })).toBe('tools')
    expect(classifyPrompt({ label: 'Go', prompt: 'enable the plugin' })).toBe('plugins')
    expect(classifyPrompt({ label: 'Go', prompt: 'continue' })).toBe('follow-ups')
  })

  it('never lets input choose a path inside the zip', () => {
    const evil = { toolCalls: [{ plugin: '../../etc/passwd', tool: 'x', ok: true }, { plugin: '..', tool: 'y', ok: true }, { plugin: '.hidden', tool: 'z', ok: true }, { plugin: '../../etc/passwd', tool: 'again', ok: true }] }
    const names = bundleEntries({ response: 'x', details: evil }).map(e => e.name)
    for (const n of names) {
      expect(n.includes('..')).toBe(false)
      expect(n.startsWith('/')).toBe(false)
      expect(n.split('/').length).toBeLessThanOrEqual(2)
      expect(n.split('/').pop()!.startsWith('.')).toBe(false)
    }
    expect(new Set(names).size).toBe(names.length)
    expect(safeName('')).toBe('plugin')
    expect(safeName('a b/c')).toBe('a_b_c')
  })

  it('rebuilds tool calls field by field and ignores junk', () => {
    expect(pluginsFromDetails(null)).toEqual([])
    expect(pluginsFromDetails({ toolCalls: 'no' })).toEqual([])
    expect(pluginsFromDetails({ toolCalls: [null, 5, { plugin: 1, tool: 'x' }, { plugin: 'p', tool: 't', ok: 'yes', extra: 'drop me' }] }))
      .toEqual([{ plugin: 'p', calls: [{ tool: 't', ok: false }] }])
  })

  it('refuses a reply that is not text', () => {
    expect(() => buildResponseBundle({ response: 42 })).toThrow(TypeError)
  })
})
