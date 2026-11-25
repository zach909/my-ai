/**
 * Prompt memory: a smaller archive that makes the mesh say the same thing.
 *
 * The cases that matter are the ones where it could look like it worked and
 * not have: a mesh that ignores its input (every stand-in "matches"), a mesh
 * that gives a different answer each time, a stand-in that gains text the
 * original never had, a stand-in changed by being used, and a stand-in that
 * outlives the mesh it was checked against. The mesh is a toy here (a function
 * of the archive) because a real run costs about a second per byte; the search
 * only ever sees it through PromptRunner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PromptMemory,
  PromptMemoryError,
  addFiles,
  doorwayRunner,
  meshFingerprint,
  outputSimilarity,
  packedSize,
  shrinkPrompt,
  slugName,
  type PromptRunner,
} from '../../models && skills/core/prompt-memory.js'
import { packZip, type BitDoorway, type ZipTree } from '../../models && skills/core/zip-halt.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')

/** A toy mesh: whatever `fn` says about the archive. Counts its runs. */
function toy(fn: (tree: ZipTree, call: number) => string, fingerprint = 'mesh-1') {
  const state = { calls: 0, fingerprint }
  const runner: PromptRunner = {
    fingerprint: () => state.fingerprint,
    run: async tree => enc(fn(tree, state.calls++)),
  }
  return { runner, state }
}

/** Same text every time, different from anything else, so a toy tail has something to be unlike. */
function filler(seed: number, lines: number): string {
  let x = seed
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out.push(`filler ${i} ${x.toString(36)}`)
  }
  return out.join('\n') + '\n'
}

/** Reads two things: the ask, and the lines of the notes that say KEY. Everything else is noise. */
const keyMesh = (t: ZipTree): string =>
  (t.files['prompt/ask.txt'] ?? '') + '|' + (t.files['memory/notes.txt'] ?? '').split('\n').filter(l => l.includes('KEY')).join('/')

function bigArchive(): ZipTree {
  const notes = filler(1, 20).split('\n')
  notes[3] = 'KEY alpha is 7'
  notes[11] = 'KEY beta is 9'
  return {
    files: {
      'prompt/ask.txt': 'what is the plan?',
      'memory/notes.txt': notes.join('\n'),
      'memory/old-chat.txt': filler(2, 200),
      'plugins/search/PLUGIN.json': JSON.stringify({ id: 'search', capabilities: Array.from({ length: 30 }, (_, i) => `cap-${i}`) }),
    },
  }
}

let dir: string
const savedDir = process.env.CORONA_DATA_DIR
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prompt-memory-'))
})
afterEach(() => {
  if (savedDir === undefined) delete process.env.CORONA_DATA_DIR
  else process.env.CORONA_DATA_DIR = savedDir
  rmSync(dir, { recursive: true, force: true })
})

describe('finding a smaller archive', () => {
  it('drops what the mesh does not read and keeps what it does', async () => {
    const big = bigArchive()
    const { runner } = toy(keyMesh)
    const r = await shrinkPrompt(runner, big)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(Object.keys(r.tree.files).sort()).toEqual(['memory/notes.txt', 'prompt/ask.txt'])
    expect(r.tree.files['memory/notes.txt']).toBe('KEY alpha is 7\nKEY beta is 9\n')
    expect(r.standInBytes).toBeLessThan(r.bigBytes / 2)
    expect(r.standInBytes).toBe(packedSize(r.tree))
    expect(r.similarity).toBe(1)
    // And it really does say the same thing when asked again.
    expect(dec(await runner.run(r.tree))).toBe(dec(await runner.run(big)))
  })

  it('never writes anything the original did not have', async () => {
    const big = bigArchive()
    const r = await shrinkPrompt(toy(keyMesh).runner, big)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    for (const [file, text] of Object.entries(r.tree.files)) {
      expect(file in big.files).toBe(true)
      for (const line of text.split('\n').filter(l => l.length > 0)) expect(big.files[file].includes(line)).toBe(true)
    }
  })

  it('leaves the archive it was given alone', async () => {
    const big = bigArchive()
    const before = JSON.stringify(big)
    await shrinkPrompt(toy(keyMesh).runner, big)
    expect(JSON.stringify(big)).toBe(before)
  })

  it('cuts a file back to its tail when the mesh only hears the end', async () => {
    // Hears only the last 30 characters of the archive's text, which is what a mesh that forgets does.
    const tailMesh = (t: ZipTree): string => hash(Object.keys(t.files).sort().map(k => t.files[k]).join('\0').slice(-30))
    // Big enough (about 400 KB packed) that the line search alone cannot get down to the tail.
    const big: ZipTree = { files: { 'a.txt': filler(3, 30000), 'z.txt': filler(4, 30000) + 'THE LAST WORDS OF THE MESSAGE\n' } }
    const { runner } = toy(tailMesh)
    const r = await shrinkPrompt(runner, big)
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.bigBytes).toBeGreaterThan(300000)
    expect('a.txt' in r.tree.files).toBe(false)
    expect(r.tree.files['z.txt'].length).toBeLessThan(60)
    expect(r.tree.files['z.txt'].endsWith('THE LAST WORDS OF THE MESSAGE\n')).toBe(true)
    expect(r.standInBytes).toBeLessThan(150)
    // Halving, not trying every line: measured at 21 runs for this archive.
    expect(r.runs).toBeLessThan(30)
  })

  it('refuses when the mesh ignores its input, because every stand-in would match', async () => {
    const { runner } = toy(() => 'the same thing every time')
    const r = await shrinkPrompt(runner, bigArchive())
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('blind')
  })

  it('refuses when the mesh disagrees with itself about the same archive', async () => {
    let n = 0
    const { runner } = toy(() => hash(String(n++)).slice(0, 12))
    const r = await shrinkPrompt(runner, bigArchive())
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('unrepeatable')
  })

  it('asks no more of a stand-in than the mesh gives itself', async () => {
    // The last byte flips between runs, so even the same archive is only 0.99 alike.
    const { runner } = toy((t, call) => (hash(keyMesh(t)).repeat(4).slice(0, 99)) + (call % 2 === 0 ? 'a' : 'b'))
    const r = await shrinkPrompt(runner, bigArchive())
    expect(r.ok).toBe(true)
    if (r.ok === false) return
    expect(r.noise).toBeCloseTo(0.99, 5)
    expect(r.threshold).toBeCloseTo(0.99, 5)
    expect(r.similarity).toBeGreaterThanOrEqual(0.99 - 1e-9)
    expect(r.standInBytes).toBeLessThan(r.bigBytes)
  })

  it('says so when every part of it matters', async () => {
    const big: ZipTree = { files: { 'a.txt': 'one\ntwo\n', 'b.txt': 'three\n' } }
    const { runner } = toy(t => hash(JSON.stringify(t.files)))
    const r = await shrinkPrompt(runner, big)
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('no-shorter')
  })

  it('has nothing to do with an empty archive', async () => {
    const r = await shrinkPrompt(toy(() => 'x').runner, { files: { 'a.txt': '' } })
    expect(r.ok).toBe(false)
    if (r.ok === true) return
    expect(r.reason).toBe('empty')
  })

  it('stops at its trial cap and keeps the best it has, never one that does not match', async () => {
    const big = bigArchive()
    const { runner } = toy(keyMesh)
    const r = await shrinkPrompt(runner, big, { maxTrials: 3 })
    if (r.ok === true) {
      expect(r.exhausted).toBe(true)
      expect(dec(await runner.run(r.tree))).toBe(dec(await runner.run(big)))
    } else {
      expect(r.reason).toBe('no-shorter')
    }
    // 2 for the target, 1 for the control, 3 for the search: nothing past the cap.
    expect(r.runs).toBeLessThanOrEqual(2 + 1 + 3)
  })

  it('stops at its time cap', async () => {
    let t = 0
    const { runner } = toy(keyMesh)
    const r = await shrinkPrompt(runner, bigArchive(), { maxMs: 1000, now: () => (t += 600) })
    expect(r.runs).toBeLessThan(12)
  })

  it('keeps what a question needs when it is checked with that question', async () => {
    // Notes only matter when the question is a "why". Without a probe that is invisible.
    const probeMesh = (t: ZipTree): string => {
      const question = t.files['prompt/question.txt'] ?? ''
      return (t.files['prompt/ask.txt'] ?? '') + '|' + question + '|' + (/why/.test(question) ? (t.files['memory/notes.txt'] ?? '').split('\n').filter(l => l.includes('KEY')).join('/') : '')
    }
    const big = bigArchive()
    const plain = await shrinkPrompt(toy(probeMesh).runner, big)
    expect(plain.ok).toBe(true)
    if (plain.ok === false) return
    expect('memory/notes.txt' in plain.tree.files).toBe(false)

    const probed = await shrinkPrompt(toy(probeMesh).runner, big, { probes: [{ 'prompt/question.txt': 'why?' }] })
    expect(probed.ok).toBe(true)
    if (probed.ok === false) return
    expect(probed.probes).toBe(1)
    expect(probed.tree.files['memory/notes.txt']).toBe('KEY alpha is 7\nKEY beta is 9\n')
  })
})

describe('comparing outputs', () => {
  it('is 1 for the same bytes and 0 for nothing against something', () => {
    expect(outputSimilarity(enc('abc'), enc('abc'))).toBe(1)
    expect(outputSimilarity(enc(''), enc(''))).toBe(1)
    expect(outputSimilarity(enc(''), enc('abc'))).toBe(0)
  })

  it('counts one wrong byte in a hundred as 0.99', () => {
    const a = 'x'.repeat(100)
    expect(outputSimilarity(enc(a), enc(a.slice(0, 99) + 'y'))).toBeCloseTo(0.99, 6)
  })

  it('does not call an answer cut in half a near match', () => {
    const a = 'abcdefghij'.repeat(10)
    expect(outputSimilarity(enc(a), enc(a.slice(0, 50)))).toBeLessThanOrEqual(0.5)
  })
})

describe('using a stand-in', () => {
  const record = async (store: PromptMemory, name = 'Plan Chat') => {
    const outcome = await store.record(toy(keyMesh).runner, bigArchive(), { name })
    expect(outcome.ok).toBe(true)
    if (outcome.ok === false) throw new Error('not recorded')
    return outcome.entry
  }

  it('keeps it and finds it again by name or id', async () => {
    const store = new PromptMemory(dir)
    const entry = await record(store)
    expect(entry.name).toBe('plan-chat')
    expect(store.get('plan-chat')?.id).toBe(entry.id)
    expect(store.get('Plan Chat')?.id).toBe(entry.id)
    expect(store.get(entry.id)?.name).toBe('plan-chat')
    expect(store.get('nothing-by-this-name')).toBeNull()
    expect(store.count()).toBe(1)
  })

  it('lists them without their text, and says which are out of date', async () => {
    const store = new PromptMemory(dir)
    await record(store)
    const same = toy(keyMesh, 'mesh-1').runner
    const moved = toy(keyMesh, 'mesh-2').runner
    const [listed] = store.list(same)
    expect('tree' in listed).toBe(false)
    expect('output' in listed).toBe(false)
    expect(listed.stale).toBe(false)
    expect(store.list(moved)[0].stale).toBe(true)
    expect(store.list()[0].stale).toBeNull()
  })

  it('hands out a copy with the extra talking added and never changes the stored one', async () => {
    const store = new PromptMemory(dir)
    const entry = await record(store)
    const stored = JSON.stringify(store.get(entry.id)?.tree)
    const used = store.use('plan-chat', { 'prompt/question.txt': 'and now?' })
    expect(used.tree.files['prompt/question.txt']).toBe('and now?')
    expect(used.tree.files['memory/notes.txt']).toBe(entry.tree.files['memory/notes.txt'])
    expect(used.packedBytes).toBe(packedSize(used.tree))
    // Scribbling on what came back changes nothing that is kept.
    used.tree.files['memory/notes.txt'] = 'scribble'
    delete used.tree.files['prompt/ask.txt']
    expect(JSON.stringify(store.get(entry.id)?.tree)).toBe(stored)
    expect(JSON.stringify(new PromptMemory(dir).get(entry.id)?.tree)).toBe(stored)
  })

  it('will not replace a file the stand-in already has', async () => {
    const store = new PromptMemory(dir)
    await record(store)
    expect(() => store.use('plan-chat', { 'prompt/ask.txt': 'something else' })).toThrow(/never changes/)
    expect(() => addFiles({ files: { a: 'x' } }, { a: 'y' })).toThrow(PromptMemoryError)
  })

  it('tells when the mesh is not the one it was checked against', async () => {
    const store = new PromptMemory(dir)
    await record(store)
    expect(store.use('plan-chat', {}, toy(keyMesh, 'mesh-1').runner).stale).toBe(false)
    expect(store.use('plan-chat', {}, toy(keyMesh, 'mesh-2').runner).stale).toBe(true)
    expect(store.use('plan-chat').stale).toBeNull()
  })

  it('stores nothing when the search refuses', async () => {
    const store = new PromptMemory(dir)
    const outcome = await store.record(toy(() => 'same').runner, bigArchive(), { name: 'blind-one' })
    expect(outcome.ok).toBe(false)
    expect(store.count()).toBe(0)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('records the same archive again as the same stand-in, and will not reuse a name for another', async () => {
    const store = new PromptMemory(dir)
    const first = await record(store)
    const again = await record(store)
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(store.count()).toBe(1)
    const other: ZipTree = { files: { 'prompt/ask.txt': 'a different archive', 'memory/notes.txt': 'KEY x\nfiller\n' } }
    await expect(store.record(toy(keyMesh).runner, other, { name: 'plan-chat' })).rejects.toThrow(/already a stand-in/)
  })

  it('forgets one, or all', async () => {
    const store = new PromptMemory(dir)
    const entry = await record(store)
    expect(store.forget('plan-chat')).toBe(true)
    expect(store.forget('plan-chat')).toBe(false)
    expect(store.get(entry.id)).toBeNull()
    await record(store)
    expect(store.forgetAll()).toBe(1)
    expect(store.count()).toBe(0)
  })

  it('cannot be pointed outside its folder by a name or an id', async () => {
    const store = new PromptMemory(dir)
    await record(store)
    for (const bad of ['../../etc/passwd', '..', '/etc/passwd', '..\\..\\x', 'a/b/c', '0123456789abcdef/../x']) {
      expect(store.get(bad)).toBeNull()
      expect(store.forget(bad)).toBe(false)
    }
    expect(slugName('../../Evil Name!')).toBe('evil-name')
    // Only <16 hex>.json and <16 hex>.big ever land on disk.
    for (const f of readdirSync(dir)) expect(/^[a-f0-9]{16}\.(json|big)$/.test(f)).toBe(true)
  })

  it('shrinks again from the original when it was kept, and says so when it was not', async () => {
    const store = new PromptMemory(dir)
    const kept = await store.record(toy(keyMesh).runner, bigArchive(), { name: 'kept', keepOriginal: true })
    expect(kept.ok && kept.keptOriginal).toBe(true)
    if (kept.ok === false) return
    const moved = toy(keyMesh, 'mesh-2').runner
    const refreshed = await store.refresh(moved, 'kept')
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok === false) return
    expect(refreshed.entry.fingerprint).toBe('mesh-2')
    expect(refreshed.entry.id).toBe(kept.entry.id)
    expect(store.use('kept', {}, moved).stale).toBe(false)

    const lost = new PromptMemory(dir)
    const plain = await lost.record(toy(keyMesh).runner, { files: { 'prompt/ask.txt': 'hello', 'memory/notes.txt': 'KEY one\n' + filler(9, 50) } }, { name: 'plain' })
    expect(plain.ok).toBe(true)
    await expect(lost.refresh(moved, 'plain')).rejects.toThrow(/not kept/)
  })

  it('lives in the person\'s own data folder by default', async () => {
    process.env.CORONA_DATA_DIR = dir
    const store = new PromptMemory()
    await store.record(toy(keyMesh).runner, bigArchive(), { name: 'mine' })
    expect(existsSync(path.join(dir, 'prompt-memory'))).toBe(true)
    expect(readdirSync(path.join(dir, 'prompt-memory')).some(f => f.endsWith('.json'))).toBe(true)
  })
})

describe('the live mesh as a runner', () => {
  it('names a mesh by what it learned, not by what it is holding this tick', () => {
    const weights = { shape: { neurons: 4, dimensions: 2 }, connDiag: 'AAAA', bias: 'BBBB' }
    const a = meshFingerprint({ ...weights, states: 'one', energies: 'e1', emaEnergy: 0.1, hasEma: true, sustainedDivergence: 0 })
    const b = meshFingerprint({ ...weights, states: 'two', energies: 'e2', emaEnergy: 0.9, hasEma: false, sustainedDivergence: 3 })
    expect(a).toBe(b)
    expect(meshFingerprint({ ...weights, connDiag: 'CCCC', states: 'one' })).not.toBe(a)
  })

  /** A doorway whose answer depends on the bytes it was sent, and a mesh whose state is a counter we can watch. */
  function fakeMesh() {
    const mesh = { state: 'start', restored: [] as string[], sent: [] as number[] }
    let out: number[] = []
    const doorway: BitDoorway = {
      sendClocked: true,
      sendBytes(bytes) {
        mesh.sent = Array.from(bytes)
        mesh.state = 'dirty'
        out = [bytes.length & 0xff, bytes[bytes.length - 1] ?? 0, 0x21]
      },
      nextOutputByte() {
        return out.length > 0 ? out.shift()! : null
      },
    }
    return {
      mesh,
      handle: {
        doorway,
        capture: () => ({ shape: { neurons: 1, dimensions: 1 }, connDiag: 'w', states: mesh.state }),
        restore: (s: unknown) => {
          mesh.restored.push((s as { states: string }).states)
          mesh.state = (s as { states: string }).states
          return true
        },
      },
    }
  }

  it('feeds the archive, reads what comes back, and puts the mesh back every time', async () => {
    const { mesh, handle } = fakeMesh()
    const runner = doorwayRunner(handle, { outputBytes: 16 })
    const tree: ZipTree = { files: { 'prompt/ask.txt': 'hi' } }
    const packed = packZip(tree)
    const out = await runner.run(tree)
    expect(mesh.sent).toEqual(Array.from(packed))
    expect(Array.from(out)).toEqual([packed.length & 0xff, packed[packed.length - 1], 0x21])
    expect(mesh.state).toBe('start')
    // Put back before the run and after it.
    expect(mesh.restored).toEqual(['start', 'start'])
    await runner.run(tree)
    expect(mesh.restored.length).toBe(4)
  })

  it('refuses a trial the mesh could not be put back for', async () => {
    const { handle } = fakeMesh()
    const runner = doorwayRunner({ ...handle, restore: () => false })
    await expect(runner.run({ files: { a: 'b' } })).rejects.toThrow(/starting state/)
  })

  it('gives the same fingerprint for the same learned mesh', () => {
    const { handle } = fakeMesh()
    expect(doorwayRunner(handle).fingerprint()).toBe(doorwayRunner(handle).fingerprint())
  })
})

describe('what is on disk', () => {
  it('is plain JSON a person can read, with the stand-in as the same kind of tree the loop takes', async () => {
    const store = new PromptMemory(dir)
    const outcome = await store.record(toy(keyMesh).runner, bigArchive(), { name: 'readable' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok === false) return
    const file = readdirSync(dir).find(f => f.endsWith('.json'))!
    const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    expect(parsed.name).toBe('readable')
    expect(parsed.standInBytes).toBeLessThan(parsed.bigBytes)
    expect(Object.keys(parsed.tree.files).sort()).toEqual(['memory/notes.txt', 'prompt/ask.txt'])
    expect(Buffer.from(parsed.output, 'base64').toString()).toBe(dec(await toy(keyMesh).runner.run(bigArchive())))
  })
})
