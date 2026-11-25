/**
 * Edits to a reply zip: definitions first, approval before any change, and the loop that runs until no edits are left.
 */
import { describe, it, expect } from 'vitest'
import { applyApproved, decide, isSettled, normalizeDefinitions, normalizeEdits, resolveDefinitions, revise, runReviewLoop, withdraw, type Edit } from '../../interface/response-edits.js'
import { buildResponseBundle, reviewStep } from '../../interface/response-bundle.js'
import { readZip } from '../../models && skills/core/zip-archive.js'

const edit = (id: string, find: string, replace: string, file = 'response/reply.md', status: Edit['status'] = 'pending'): Edit =>
  ({ id, file, find, replace, status, comments: [] })
const files = (zip: Buffer) => Object.fromEntries(readZip(zip).map(e => [e.name, e.data.toString('utf8')]))

describe('definitions', () => {
  it('puts a later definition in where it was used, including definitions inside definitions', () => {
    const r = resolveDefinitions('Use {{tool}} then {{ unit }}.', { tool: 'the {{kind}} tool', kind: 'hash', unit: 'km' })
    expect(r).toEqual({ text: 'Use the hash tool then km.', missing: [], loops: [] })
  })
  it('reports what is missing or loops, and leaves the marker as it was', () => {
    const r = resolveDefinitions('{{a}} {{nope}}', { a: '{{b}}', b: '{{a}}' })
    expect(r.text).toBe('{{a}} {{nope}}')
    expect(r.missing).toEqual(['nope'])
    expect(r.loops.length).toBeGreaterThan(0)
  })
  it('keeps only valid names and text values', () => {
    const d = normalizeDefinitions({ ok: 'x', 'bad name': 'y', n: 5, __proto__: 'z' })
    expect(Object.keys(d)).toEqual(['ok'])
  })
})

describe('edits need approval', () => {
  it('changes nothing while an edit is pending or rejected', () => {
    const files0 = new Map([['response/reply.md', 'hello world']])
    const out = applyApproved(files0, [edit('1', 'world', 'there'), edit('2', 'hello', 'bye', 'response/reply.md', 'rejected')])
    expect(out.files.get('response/reply.md')).toBe('hello world')
  })
  it('applies an approved edit, in order', () => {
    const out = applyApproved(new Map([['response/reply.md', 'a b']]), [edit('1', 'a', 'x', 'response/reply.md', 'approved'), edit('2', 'x b', 'done', 'response/reply.md', 'approved')])
    expect(out.files.get('response/reply.md')).toBe('done')
  })
  it('sends back an approved edit that no longer fits, instead of losing it', () => {
    const out = applyApproved(new Map([['response/reply.md', 'a a']]), [edit('1', 'a', 'x', 'response/reply.md', 'approved')])
    expect(out.files.get('response/reply.md')).toBe('a a')
    expect(out.edits[0].status).toBe('rejected')
    expect(out.edits[0].comments.at(-1)?.by).toBe('system')
  })
  it('will not approve an edit that does not fit the file as it is now', () => {
    const next = decide([edit('1', 'gone', 'x')], '1', true, 'ok', 'hello')
    expect(next[0].status).toBe('rejected')
  })
  it('only a rejected edit is rewritten, and it goes back to pending', () => {
    expect(() => revise([edit('1', 'a', 'b')], '1', { replace: 'c' })).toThrow()
    const r = revise([edit('1', 'a', 'b', 'response/reply.md', 'rejected')], '1', { replace: 'c', comment: 'fixed' })
    expect(r[0]).toMatchObject({ status: 'pending', replace: 'c' })
    expect(r[0].comments.at(-1)).toEqual({ by: 'author', text: 'fixed' })
  })
  it('an unknown id is an error, not a silent no-op', () => {
    expect(() => decide([], 'x', true)).toThrow()
    expect(() => withdraw([], 'x')).toThrow()
  })
  it('rebuilds edits field by field', () => {
    const e = normalizeEdits([{ id: 'a', file: 'f', find: 'x', replace: 'y', status: 'weird', extra: 1 }, { id: 'a', file: 'f', find: 'x', replace: 'y' }, { id: 'b', file: 'f', find: '', replace: 'y' }, 7])
    expect(e).toEqual([{ id: 'a', file: 'f', find: 'x', replace: 'y', status: 'pending', comments: [] }])
  })
})

describe('the loop runs until no edits are left', () => {
  const base = () => new Map([['response/reply.md', 'The cat sat. The cat ran.']])

  it('retries a rejected edit until the reviewer approves it', async () => {
    let tries = 0
    const res = await runReviewLoop({
      files: base(),
      edits: [edit('1', 'cat', 'dog')], // matches twice: the reviewer cannot approve it as written
      reviewer: () => ({ approve: true, comment: 'fine' }),
      author: (e) => { tries++; return { find: 'cat sat', replace: 'dog sat', comment: 'quoted more' } },
    })
    expect(res.done).toBe(true)
    expect(tries).toBe(1)
    expect(res.rounds).toBe(2)
    expect(res.files.get('response/reply.md')).toBe('The dog sat. The cat ran.')
    expect(isSettled(res.edits)).toBe(true)
  })

  it('does not apply anything the reviewer refused', async () => {
    const res = await runReviewLoop({
      files: base(), maxRounds: 3,
      edits: [edit('1', 'cat sat', 'dog sat')],
      reviewer: () => ({ approve: false, comment: 'no' }),
      author: (e) => ({ replace: e.replace + '!' }),
    })
    expect(res.done).toBe(false) // out of rounds: it says so
    expect(res.rounds).toBe(3)
    expect(res.files.get('response/reply.md')).toBe('The cat sat. The cat ran.')
    expect(res.edits[0].comments.filter(c => c.by === 'reviewer').length).toBeGreaterThan(0)
  })

  it('finishes when the author withdraws the edit', async () => {
    const res = await runReviewLoop({
      files: base(), edits: [edit('1', 'cat sat', 'dog sat')],
      reviewer: () => ({ approve: false }), author: () => null,
    })
    expect(res.done).toBe(true)
    expect(res.edits).toEqual([])
    expect(res.files.get('response/reply.md')).toBe('The cat sat. The cat ran.')
  })

  it('judges each edit against the text the earlier approved edits left', async () => {
    const seen: Array<string | undefined> = []
    const res = await runReviewLoop({
      files: base(), edits: [edit('1', 'cat sat', 'dog sat'), edit('2', 'dog sat', 'owl sat')],
      reviewer: (e, current) => { seen.push(current); return { approve: true } },
      author: () => null,
    })
    expect(res.done).toBe(true)
    expect(seen[1]).toBe('The dog sat. The cat ran.')
    expect(res.files.get('response/reply.md')).toBe('The owl sat. The cat ran.')
  })
})

describe('in the zip', () => {
  it('uses definitions first, then approved edits; pending ones are listed but change nothing', () => {
    const f = files(buildResponseBundle({
      response: 'Ask the {{who}} about {{what}}. Keep going.',
      definitions: { who: 'helper', what: 'tools' },
      edits: [edit('a', 'Keep going.', 'Stop.', 'response/reply.md', 'approved'), edit('b', 'helper', 'robot')],
    }))
    expect(f['response/reply.md']).toBe('Ask the helper about tools. Stop.\n')
    const e = JSON.parse(f['response/edits.json'])
    expect(e).toMatchObject({ done: false, remaining: 1 })
    expect(JSON.parse(f['response/definitions.json']).definitions).toEqual({ who: 'helper', what: 'tools' })
    expect(JSON.parse(f['manifest.json']).editsRemaining).toBe(1)
  })

  it('an edit can reach the prompts files, and is sent back if its file does not exist', () => {
    const f = files(buildResponseBundle({
      response: 'x',
      edits: [edit('a', 'That was right', 'Spot on', 'prompts/feedback.md', 'approved'), edit('b', 'q', 'r', 'prompts/nope.md', 'approved')],
    }))
    expect(f['prompts/feedback.md']).toContain('Spot on')
    const e = JSON.parse(f['response/edits.json'])
    expect(e.edits.find((x: Edit) => x.id === 'b').status).toBe('rejected')
    expect(e.done).toBe(false)
  })

  it('has no edits file and no definitions file when none were sent', () => {
    const f = files(buildResponseBundle({ response: 'x' }))
    expect(f['response/edits.json']).toBeUndefined()
    expect(f['response/definitions.json']).toBeUndefined()
    expect(JSON.parse(f['manifest.json']).editsRemaining).toBe(0)
  })

  it('reviewStep runs a round over the wire: reject, rewrite, approve until done', () => {
    const input = { response: 'The cat sat. The cat ran.', edits: [edit('1', 'cat', 'dog')] }
    let s = reviewStep(input, { decisions: [{ id: '1', approve: true, comment: 'ok' }] })
    expect(s).toMatchObject({ done: false, remaining: 1 }) // matches twice, so it is sent back
    expect(s.edits[0].status).toBe('rejected')
    s = reviewStep({ ...input, edits: s.edits }, { revisions: [{ id: '1', find: 'cat sat', replace: 'dog sat' }] })
    expect(s.edits[0].status).toBe('pending')
    s = reviewStep({ ...input, edits: s.edits }, { decisions: [{ id: '1', approve: true }] })
    expect(s).toMatchObject({ done: true, remaining: 0 })
    const f = files(buildResponseBundle({ ...input, edits: s.edits }))
    expect(f['response/reply.md']).toBe('The dog sat. The cat ran.\n')
  })
})
