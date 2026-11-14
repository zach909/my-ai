/**
 * Draft-then-fill (models && skills/core/draft-fill.ts): outline first, each piece
 * filled by its own hive agent, then the main AI reads, edits and approves.
 * Thinking and the hive are stubbed; what is tested is the pipeline itself.
 */
import { describe, it, expect } from 'vitest'
import { parseOutline, parseReview, draftDocument, outlinePrompt, type DraftDeps } from '../../models && skills/core/draft-fill.js'

const OUTLINE = [
  '# Why cities should plant more trees',
  '## Introduction',
  '/hivemind writer',
  'hook the reader and state the claim',
  '## The evidence',
  '/hivemind researcher',
  '/subagent',
  '## Counter-arguments /hivemind team critics',
  '## Conclusion',
].join('\n')

describe('parseOutline', () => {
  it('reads the title, each piece, its hive, and its brief', () => {
    const o = parseOutline(OUTLINE)
    expect(o.title).toBe('Why cities should plant more trees')
    expect(o.usedFallback).toBe(false)
    expect(o.sections.map(s => s.title)).toEqual(['Introduction', 'The evidence', 'Counter-arguments', 'Conclusion'])
    expect(o.sections.map(s => s.index)).toEqual([1, 2, 3, 4])
    expect(o.sections[0].hive).toEqual({ name: 'writer', team: false })
    expect(o.sections[0].brief).toBe('hook the reader and state the claim')
    expect(o.sections[1].hive).toEqual({ name: 'researcher', team: false })
    expect(o.sections[1].brief).toBe('') // /subagent is a marker, not part of the brief
    expect(o.sections[2].hive).toEqual({ name: 'critics', team: true }) // marker on the heading line
    expect(o.sections[3].hive).toBeNull()
  })

  it('accepts a numbered list with no headings', () => {
    const o = parseOutline('1. Setup\n/hivemind coder\n2. Run it\n3. Clean up', 'Guide')
    expect(o.title).toBe('Guide')
    expect(o.sections.map(s => s.title)).toEqual(['Setup', 'Run it', 'Clean up'])
    expect(o.sections[0].hive?.name).toBe('coder')
  })

  it('treats several level-1 headings as pieces, not a title', () => {
    const o = parseOutline('# One\n# Two', 'Fallback')
    expect(o.title).toBe('Fallback')
    expect(o.sections.map(s => s.title)).toEqual(['One', 'Two'])
  })

  it('falls back to a generic outline, and says so, when nothing is readable', () => {
    const o = parseOutline('I am not sure how to outline that.', 'Thing')
    expect(o.usedFallback).toBe(true)
    expect(o.sections.map(s => s.title)).toEqual(['Introduction', 'Main points', 'Conclusion'])
  })
})

describe('parseReview', () => {
  it('reads OK', () => {
    expect(parseReview('OK', 3)).toEqual({ verdict: { kind: 'ok' }, understood: true })
    expect(parseReview('Looks good to me.', 3).understood).toBe(true)
  })

  it('reads REDO and a multi-line REWRITE, and ignores a number that is not a piece', () => {
    const r = parseReview('REDO 2: add a source\nREWRITE 3: First line.\nSecond line.\nREDO 9: nope', 3)
    expect(r.verdict).toEqual({
      kind: 'changes',
      redo: [{ index: 2, note: 'add a source' }],
      rewrite: [{ index: 3, text: 'First line.\nSecond line.' }],
    })
  })

  it('a change request beats a stray "OK"', () => {
    const r = parseReview('OK except\nREDO 1: shorter', 2)
    expect(r.verdict.kind).toBe('changes')
  })

  it('an unreadable answer ends the loop as OK but is flagged as not understood', () => {
    expect(parseReview('hmm let me think', 3)).toEqual({ verdict: { kind: 'ok' }, understood: false })
  })
})

function stubDeps(over: Partial<DraftDeps> & { reviews?: string[] } = {}) {
  const fills: Array<{ title: string; hive: string; team: boolean; note?: string }> = []
  const prompts: string[] = []
  const reviews = [...(over.reviews ?? ['OK'])]
  const deps: DraftDeps = {
    think: async p => {
      prompts.push(p)
      if (p.startsWith('Write the OUTLINE ONLY')) return OUTLINE
      return reviews.length > 1 ? reviews.shift()! : reviews[0]
    },
    fill: async (s, hive, ctx) => {
      fills.push({ title: s.title, hive: hive.name, team: hive.team, note: ctx.note })
      return { text: `## ${s.title}\nBody of ${s.title}${ctx.note ? ' (' + ctx.note + ')' : ''}.`, by: hive.name + '-1' }
    },
    ...over,
  }
  return { deps, fills, prompts }
}

describe('draftDocument', () => {
  it('outlines, fills every piece through its own hive, reads once, and approves', async () => {
    const { deps, fills, prompts } = stubDeps()
    const r = await draftDocument('trees in cities', deps)
    expect(prompts[0]).toBe(outlinePrompt('trees in cities'))
    expect(fills.map(f => [f.title, f.hive, f.team])).toEqual([
      ['Introduction', 'writer', false],
      ['The evidence', 'researcher', false],
      ['Counter-arguments', 'critics', true],
      ['Conclusion', 'writer', false], // no /hivemind -> the default hive
    ])
    expect(r.status).toBe('approved')
    expect(r.rounds).toBe(1)
    expect(r.failed).toEqual([])
    expect(r.markdown.startsWith('# Why cities should plant more trees\n\n## Introduction\n\nBody of Introduction.')).toBe(true)
    // The sub-agent repeated the heading; it must not show twice.
    expect(r.markdown.match(/## Introduction/g)).toHaveLength(1)
    // The reviewer is shown the numbered pieces.
    expect(prompts[prompts.length - 1]).toContain('[2] ## The evidence')
  })

  it('each sub-agent sees the whole outline', async () => {
    let seen: string[] = []
    const { deps } = stubDeps({
      fill: async (s, _h, ctx) => {
        seen = ctx.outlineTitles
        return { text: 'x', by: 'a' }
      },
    })
    await draftDocument('t', deps)
    expect(seen).toEqual(['Introduction', 'The evidence', 'Counter-arguments', 'Conclusion'])
  })

  it('REDO sends just that piece back with the note, then reads again', async () => {
    const { deps, fills } = stubDeps({ reviews: ['REDO 2: add a source', 'OK'] })
    const r = await draftDocument('t', deps)
    expect(r.status).toBe('approved')
    expect(r.rounds).toBe(2)
    expect(fills.filter(f => f.note)).toEqual([{ title: 'The evidence', hive: 'researcher', team: false, note: 'add a source' }])
    expect(r.sections[1].revisions).toBe(1)
    expect(r.sections[1].text).toContain('add a source')
    expect(r.sections[0].revisions).toBe(0)
  })

  it('REWRITE is the main AI editing the piece itself, with no sub-agent call', async () => {
    const { deps, fills } = stubDeps({ reviews: ['REWRITE 4: Plant trees. Now.', 'OK'] })
    const r = await draftDocument('t', deps)
    expect(fills.filter(f => f.note)).toHaveLength(0)
    expect(r.sections[3].text).toBe('Plant trees. Now.')
    expect(r.sections[3].writtenBy).toBe('main')
    expect(r.status).toBe('approved')
  })

  it('stops after maxRounds and says it was not approved', async () => {
    const { deps } = stubDeps({ reviews: ['REDO 1: again'] })
    const r = await draftDocument('t', deps, { maxRounds: 2 })
    expect(r.status).toBe('max-rounds')
    expect(r.rounds).toBe(2)
    expect(r.trace.join('\n')).toContain('was still asking for changes')
  })

  it('a piece that fails is reported and left as a visible placeholder, never dropped silently', async () => {
    const { deps } = stubDeps({
      fill: async (s, h) => {
        if (s.title === 'The evidence') throw new Error('hive agent unreachable')
        return { text: `Body of ${s.title}`, by: h.name }
      },
    })
    const r = await draftDocument('t', deps)
    expect(r.failed).toEqual(['The evidence'])
    expect(r.markdown).toContain('[This piece could not be written: hive agent unreachable]')
    expect(r.sections[1].error).toBe('hive agent unreachable')
  })

  it('an empty answer from a sub-agent counts as a failure', async () => {
    const { deps } = stubDeps({ fill: async () => ({ text: '   ', by: 'a' }) })
    const r = await draftDocument('t', deps)
    expect(r.failed).toHaveLength(4)
  })

  it('a given outline skips the main AI outline step', async () => {
    const { deps, prompts } = stubDeps()
    const r = await draftDocument('ignored topic', deps, { outline: '## Only piece\n/hivemind coder' })
    expect(prompts.some(p => p.startsWith('Write the OUTLINE ONLY'))).toBe(false)
    expect(r.sections).toHaveLength(1)
    expect(r.trace[0]).toBe('using the outline you gave')
  })

  it('runs pieces at the same time, but no more than the limit', async () => {
    let live = 0
    let peak = 0
    const { deps } = stubDeps({
      fill: async (s, h) => {
        live++
        peak = Math.max(peak, live)
        await new Promise(res => setTimeout(res, 15))
        live--
        return { text: 'x', by: h.name }
      },
    })
    await draftDocument('t', deps, { concurrency: 2 })
    expect(peak).toBe(2)
  })

  it('a fallback outline is flagged in the result', async () => {
    const { deps } = stubDeps({ think: async p => (p.startsWith('Write the OUTLINE') ? 'no idea' : 'OK') })
    const r = await draftDocument('t', deps)
    expect(r.usedFallbackOutline).toBe(true)
    expect(r.trace.join('\n')).toContain('generic three-piece outline')
  })
})
