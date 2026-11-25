/**
 * Prompt memory over HTTP. What can go wrong here is not the search (that is
 * prompt-memory.test.ts) but the edges: a search that runs for hours must not
 * hold a request open, two must not run at once on one mesh, a bad body must
 * be refused before anything is run, and a failed search must say so instead
 * of leaving a job that looks like it is still going.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handlePromptMemoryRoutes, isPromptMemoryRoute } from '../../interface/prompt-memory-routes.js'
import { PromptMemoryError, type PromptRunner } from '../../models && skills/core/prompt-memory.js'
import type { ZipTree } from '../../models && skills/core/zip-halt.js'

let dir: string
const savedDir = process.env.CORONA_DATA_DIR
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prompt-memory-routes-'))
  process.env.CORONA_DATA_DIR = dir
})
afterEach(() => {
  if (savedDir === undefined) delete process.env.CORONA_DATA_DIR
  else process.env.CORONA_DATA_DIR = savedDir
  rmSync(dir, { recursive: true, force: true })
})

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
/** Reads the ask, and the lines of the notes that say KEY. */
const mesh = (t: ZipTree): string =>
  (t.files['prompt/ask.txt'] ?? '') + '|' + (t.files['memory/notes.txt'] ?? '').split('\n').filter(l => l.includes('KEY')).join('/')

interface Harness {
  /** Resolves the runner when a search starts; lets a test hold it open. */
  gate?: Promise<void>
  fingerprint?: string | null
  failWith?: PromptMemoryError
}

function api(h: Harness = {}) {
  const runner: PromptRunner = {
    fingerprint: () => 'mesh-1',
    run: async tree => {
      if (h.gate) await h.gate
      return enc(mesh(tree))
    },
  }
  return async function call(method: string, pathname: string, query = '', body?: unknown) {
    let status = 0
    let json: any
    const ctx = {
      req: {} as never, res: {} as never, pathname, method,
      url: new URL(`http://x${pathname}${query}`),
      parseBody: async () => body,
      sendJson: (_r: unknown, data: unknown, s = 200) => { status = s; json = data },
      withRunner: async <T,>(work: (r: PromptRunner) => Promise<T>): Promise<T> => {
        if (h.failWith) throw h.failWith
        return work(runner)
      },
      fingerprint: async () => (h.fingerprint === undefined ? 'mesh-1' : h.fingerprint),
    }
    const handled = await handlePromptMemoryRoutes(ctx)
    return { handled, status, json }
  }
}

const bigFiles = () => {
  const notes = Array.from({ length: 40 }, (_, i) => `filler line ${i} of the notes`)
  notes[5] = 'KEY alpha is 7'
  notes[30] = 'KEY beta is 9'
  return {
    'prompt/ask.txt': 'what is the plan?',
    'memory/notes.txt': notes.join('\n'),
    'memory/old-chat.txt': Array.from({ length: 200 }, (_, i) => `old turn ${i}`).join('\n'),
  }
}

/** The job is background work; wait for it the way a person polling would. */
async function finished(call: ReturnType<typeof api>) {
  for (let i = 0; i < 200; i++) {
    const { json } = await call('GET', '/api/prompt-memory/job')
    if (json.job && json.job.state !== 'running') return json.job
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('the job never finished')
}

describe('prompt memory routes', () => {
  it('ignores other paths', async () => {
    const call = api()
    expect((await call('GET', '/api/memory')).handled).toBe(false)
    expect((await call('GET', '/api/prompt-memoryX')).handled).toBe(false)
    expect(isPromptMemoryRoute('/api/prompt-memory/use')).toBe(true)
    expect(isPromptMemoryRoute('/api/prompt-memory-other')).toBe(false)
  })

  it('answers a record at once, does the search in the background, and then serves the stand-in', async () => {
    const call = api()
    const started = await call('POST', '/api/prompt-memory/record', '', { name: 'Plan', files: bigFiles() })
    expect(started.status).toBe(202)
    expect(started.json.started).toBe(true)

    const job = await finished(call)
    expect(job.state).toBe('done')
    expect(job.outcome.ok).toBe(true)
    expect(job.outcome.standInBytes).toBeLessThan(job.outcome.bigBytes)
    expect(job.runs).toBeGreaterThan(3)

    const list = (await call('GET', '/api/prompt-memory')).json
    expect(list.standIns).toHaveLength(1)
    expect(list.standIns[0].name).toBe('plan')
    expect(list.standIns[0].tree).toBeUndefined()
    expect(list.standIns[0].stale).toBeNull()
    expect((await call('GET', '/api/prompt-memory', '?stale=1')).json.standIns[0].stale).toBe(false)

    const one = (await call('GET', '/api/prompt-memory/standin', '?id=plan')).json
    expect(Object.keys(one.tree.files).sort()).toEqual(['memory/notes.txt', 'prompt/ask.txt'])
  })

  it('hands back the stand-in with extra talking added, in the shape the zip loop takes', async () => {
    const call = api()
    await call('POST', '/api/prompt-memory/record', '', { name: 'plan', files: bigFiles() })
    await finished(call)
    const used = await call('POST', '/api/prompt-memory/use', '', { id: 'plan', extra: { 'prompt/question.txt': 'and next?' } })
    expect(used.status).toBe(200)
    expect(used.json.files['prompt/question.txt']).toBe('and next?')
    expect(used.json.files['prompt/ask.txt']).toBe('what is the plan?')
    expect(used.json.binary).toEqual({})
    expect(used.json.stale).toBe(false)
    // The stand-in itself did not change.
    expect((await call('GET', '/api/prompt-memory/standin', '?id=plan')).json.tree.files['prompt/question.txt']).toBeUndefined()
    // And it will not let the extra talking overwrite it.
    expect((await call('POST', '/api/prompt-memory/use', '', { id: 'plan', extra: { 'prompt/ask.txt': 'other' } })).status).toBe(400)
    expect((await call('POST', '/api/prompt-memory/use', '', { id: 'missing' })).status).toBe(404)
  })

  it('says a stand-in is stale when the mesh has changed', async () => {
    await (async () => {
      const call = api()
      await call('POST', '/api/prompt-memory/record', '', { name: 'plan', files: bigFiles() })
      await finished(call)
    })()
    const moved = api({ fingerprint: 'mesh-2' })
    expect((await moved('GET', '/api/prompt-memory', '?stale=1')).json.standIns[0].stale).toBe(true)
    expect((await moved('POST', '/api/prompt-memory/use', '', { id: 'plan' })).json.stale).toBe(true)
    // With no mesh to ask, it does not guess.
    expect((await api({ fingerprint: null })('POST', '/api/prompt-memory/use', '', { id: 'plan' })).json.stale).toBeNull()
  })

  it('runs one search at a time', async () => {
    let release!: () => void
    const call = api({ gate: new Promise<void>(r => { release = r }) })
    expect((await call('POST', '/api/prompt-memory/record', '', { name: 'one', files: bigFiles() })).status).toBe(202)
    const second = await call('POST', '/api/prompt-memory/record', '', { name: 'two', files: bigFiles() })
    expect(second.status).toBe(409)
    expect(second.json.error).toMatch(/already being made/)
    expect((await call('GET', '/api/prompt-memory/job')).json.busy).toBe(true)
    release()
    expect((await finished(call)).state).toBe('done')
    expect((await call('GET', '/api/prompt-memory/job')).json.busy).toBe(false)
  })

  it('reports a search that could not run as failed, and a refusal as a finished job that says why', async () => {
    const down = api({ failWith: new PromptMemoryError('The network has not run yet.', 409) })
    expect((await down('POST', '/api/prompt-memory/record', '', { files: bigFiles() })).status).toBe(202)
    const failed = await finished(down)
    expect(failed.state).toBe('failed')
    expect(failed.error).toMatch(/not run yet/)

    // A mesh that ignores its input: the search refuses and keeps nothing.
    const blindRunner: PromptRunner = { fingerprint: () => 'x', run: async () => enc('same') }
    let status = 0
    const ctx = (pathname: string, method: string, body?: unknown) => ({
      req: {} as never, res: {} as never, pathname, method, url: new URL(`http://x${pathname}`),
      parseBody: async () => body,
      sendJson: (_r: unknown, _d: unknown, s = 200) => { status = s },
      withRunner: async <T,>(work: (r: PromptRunner) => Promise<T>): Promise<T> => work(blindRunner),
      fingerprint: async () => 'x',
    })
    await handlePromptMemoryRoutes(ctx('/api/prompt-memory/record', 'POST', { files: bigFiles() }))
    expect(status).toBe(202)
    const call = api()
    const job = await finished(call)
    expect(job.state).toBe('done')
    expect(job.outcome.ok).toBe(false)
    expect(job.outcome.reason).toBe('blind')
    expect((await call('GET', '/api/prompt-memory')).json.standIns).toEqual([])
  })

  it('refuses a bad body before running anything', async () => {
    const call = api()
    const bad: unknown[] = [
      { files: 'not an object' },
      { files: { 'a.txt': 5 } },
      { files: { 'a.txt': 'x' }, binary: { 'a.txt': 'eA==' } },
      { files: { 'a.txt': 'x' }, threshold: 2 },
      { files: { 'a.txt': 'x' }, maxTrials: 100000 },
      { files: { 'a.txt': 'x' }, maxMs: 5 },
      { files: { 'a.txt': 'x' }, probes: 'ask' },
      { files: { 'a.txt': 'x' }, probes: [{ 'q.txt': 1 }] },
      'a string',
    ]
    for (const body of bad) expect((await call('POST', '/api/prompt-memory/record', '', body)).status).toBe(400)
    expect((await call('GET', '/api/prompt-memory/job')).json).toEqual({ busy: false, job: null })
  })

  it('cannot refresh what was not kept, and forgets', async () => {
    const call = api()
    await call('POST', '/api/prompt-memory/record', '', { name: 'plan', files: bigFiles() })
    await finished(call)
    expect((await call('POST', '/api/prompt-memory/refresh', '', { id: 'nothing' })).status).toBe(404)
    // The original was not kept, so there is nothing to check it again from.
    expect((await call('POST', '/api/prompt-memory/refresh', '', { id: 'plan' })).status).toBe(202)
    const job = await finished(call)
    expect(job.state).toBe('failed')
    expect(job.error).toMatch(/not kept/)

    expect((await call('DELETE', '/api/prompt-memory', '?id=plan')).json).toEqual({ forgotten: true })
    expect((await call('DELETE', '/api/prompt-memory', '?id=plan')).status).toBe(404)
  })
})
