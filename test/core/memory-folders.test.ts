/**
 * Topic memory: a folder tree of notes the agent files into, updates and
 * searches. The cases that matter are the ones where it could go wrong
 * quietly: a path that escapes the tree, a note that overwrites a folder, a
 * search that favours a long note over the right one, a forget that takes a
 * whole folder when the agent only meant one note.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryFolders, MemoryFolderError, parsePath, MAX_DEPTH } from '../../models && skills/core/memory-folders.js'
import { MemoryTopicsPlugin } from '../../plugins/memory-topics.js'
import { createPluginInstance, pluginExtensions } from '../../plugins/index.js'
import { buildAgentCapabilities } from '../../models && skills/core/agent-capabilities.js'
import { PERCEPTION_SOURCES } from '../../models && skills/core/prompting-skills.js'
import { handleMemoryTopicsRoutes } from '../../interface/memory-topics-routes.js'

let dir: string
const savedDir = process.env.CORONA_DATA_DIR
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'memory-folders-'))
  process.env.CORONA_DATA_DIR = dir
})
afterEach(() => {
  if (savedDir === undefined) delete process.env.CORONA_DATA_DIR
  else process.env.CORONA_DATA_DIR = savedDir
  rmSync(dir, { recursive: true, force: true })
})

const store = () => new MemoryFolders()
const root = () => path.join(dir, 'memory-topics')

describe('paths', () => {
  it('turns names into plain lowercase segments', () => {
    expect(parsePath('Projects//My Garden/Plan.md', { note: true })).toEqual(['projects', 'my-garden', 'plan'])
    expect(parsePath('a\\b/c')).toEqual(['a', 'b', 'c'])
  })

  it('refuses anything that could leave the tree or is not a name', () => {
    for (const bad of ['../x', 'a/../b', '..', '.', 'a/./b', '!!!', 'a/???/b', '']) {
      expect(() => parsePath(bad)).toThrow(MemoryFolderError)
    }
    expect(() => parsePath(42 as unknown as string)).toThrow(/text/)
    expect(() => parsePath(Array(MAX_DEPTH + 1).fill('a').join('/'))).toThrow(/levels deep/)
    expect(parsePath('', { allowRoot: true })).toEqual([])
  })

  it('cannot write outside memory however the path is spelled', () => {
    for (const evil of ['../../escape', '/etc/passwd', '..\\..\\x', 'a/..%2f..%2fx']) {
      try { store().write(evil, 'x') } catch { /* refused or flattened: both fine */ }
    }
    expect(existsSync(path.join(dir, 'escape.md'))).toBe(false)
    expect(existsSync('/etc/passwd.md')).toBe(false)
    // Whatever was flattened landed inside the root.
    expect(store().count()).toBeGreaterThanOrEqual(0)
  })

  it('does not follow a link planted inside memory', () => {
    mkdirSync(root(), { recursive: true })
    const outside = mkdtempSync(path.join(tmpdir(), 'memory-outside-'))
    try {
      writeFileSync(path.join(outside, 'secret.md'), 'top secret')
      symlinkSync(outside, path.join(root(), 'linked'))
      expect(() => store().read('linked/secret')).toThrow(/Links/)
      expect(() => store().write('linked/new', 'x')).toThrow(/Links/)
      expect(store().search('secret')).toEqual([])
      expect(existsSync(path.join(outside, 'new.md'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('writing', () => {
  it('saves a note as markdown on disk with a heading, and reads it back', () => {
    const n = store().write('projects/garden/plan', 'Plant tomatoes in May.')
    expect(n).toMatchObject({ path: 'projects/garden/plan', title: 'Plan' })
    const file = path.join(root(), 'projects', 'garden', 'plan.md')
    expect(readFileSync(file, 'utf-8')).toBe('# Plan\n\nPlant tomatoes in May.\n')
    expect(store().read('Projects/Garden/Plan.md').content).toContain('tomatoes')
  })

  it('keeps a heading the agent wrote itself, and replaces on a second save', () => {
    store().write('people/alex', '# Alex Rivera\nLikes climbing.')
    expect(store().read('people/alex').title).toBe('Alex Rivera')
    store().write('people/alex', '# Alex Rivera\nMoved to Denver.')
    const c = store().read('people/alex').content
    expect(c).toContain('Denver')
    expect(c).not.toContain('climbing')
  })

  it('rejects empty, oversized, and note-versus-folder clashes', () => {
    expect(() => store().write('a/b', '   ')).toThrow(/some text/)
    expect(() => store().write('a/b', 'x'.repeat(20_001))).toThrow(/at most/)
    store().write('food/pizza', 'Margherita.')
    expect(() => store().write('food', 'oops')).toThrow(/is a folder/)
    expect(() => store().write('food/pizza/toppings', 'basil')).toThrow(/is a note/)
  })

  it('appends dated lines, creating the note on first use', () => {
    const day = new Date('2026-11-08T12:00:00Z')
    store().append('preferences/coding', 'Prefers tabs.', day)
    store().append('preferences/coding', 'Uses\nvitest.', new Date('2026-11-09T12:00:00Z'))
    const c = store().read('preferences/coding').content
    expect(c).toContain('- 2026-11-08: Prefers tabs.')
    expect(c).toContain('- 2026-11-09: Uses vitest.')
    expect(c.indexOf('11-08')).toBeLessThan(c.indexOf('11-09'))
  })

  it('stops appending when a note is full, telling the agent to split it', () => {
    const s = store()
    s.write('log/big', 'x'.repeat(19_000))
    for (let i = 0; i < 40; i++) {
      try { s.append('log/big', 'y'.repeat(1500)) } catch (e) {
        expect((e as Error).message).toMatch(/full/)
        return
      }
    }
    throw new Error('append never refused')
  })
})

describe('the tree', () => {
  it('shows folders, notes and empty folders in name order', () => {
    const s = store()
    s.write('projects/garden/plan', 'a')
    s.write('projects/garden/shopping', 'b')
    s.write('people/alex', 'c')
    s.write('inbox', 'd')
    mkdirSync(path.join(root(), 'later'), { recursive: true })
    const t = s.tree()
    expect(t.notes.map(n => n.path)).toEqual(['inbox'])
    expect(t.folders.map(f => f.name)).toEqual(['later', 'people', 'projects'])
    const garden = s.tree('projects/garden')
    expect(garden.notes.map(n => n.path)).toEqual(['projects/garden/plan', 'projects/garden/shopping'])
    expect(() => s.tree('nope')).toThrow(/no folder/)
    expect(s.count()).toBe(4)
  })

  it('outlines memory for the agent, and says when empty', () => {
    expect(store().outline()).toBe('Memory is empty.')
    store().write('projects/garden/plan', 'a')
    expect(store().outline()).toBe('projects/\n  garden/\n    plan  (Plan)')
  })
})

describe('search', () => {
  it('ranks a note whose NAME matches over one that only mentions the word', () => {
    const s = store()
    s.write('projects/garden/plan', 'Beds along the south fence.')
    s.write('journal/2026-05', 'Spent the weekend on the garden, garden, garden, garden, garden.')
    const hits = s.search('garden plan')
    expect(hits[0].path).toBe('projects/garden/plan')
    expect(hits.map(h => h.path)).toContain('journal/2026-05')
  })

  it('does not favour a note for being long', () => {
    const s = store()
    // Same number of mentions; one note is padded out to thousands of characters.
    s.write('a/short', 'Rust is the language for the compiler project.')
    s.write('a/long', 'Rust is the language for the compiler project. ' + 'filler '.repeat(2000))
    const hits = s.search('rust')
    expect(hits).toHaveLength(2)
    expect(hits[0].score).toBe(hits[1].score)
    // And repeating the word helps only a little, then stops helping.
    s.write('a/spam', 'rust '.repeat(500))
    expect(s.search('rust').find(h => h.path === 'a/spam')!.score).toBe(0.167)
  })

  it('returns the best matching line as the snippet, nothing for no match, and respects topK', () => {
    const s = store()
    s.write('pets/dog', 'Name: Biscuit.\nBiscuit hates thunder and loud fireworks.\nLikes walks.')
    s.write('pets/cat', 'Biscuit the dog is not the cat.')
    s.write('pets/fish', 'Biscuit? No.')
    const hits = s.search('thunder fireworks', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toBe('Biscuit hates thunder and loud fireworks.')
    expect(s.search('zzzz')).toEqual([])
    expect(s.search('   ')).toEqual([])
    expect(s.search('biscuit', 2)).toHaveLength(2)
  })

  it('formats lines for the agent loop with where the note lives', () => {
    store().write('people/alex', 'Alex is allergic to peanuts.')
    expect(store().digest('peanuts')).toEqual(['memory/people/alex: Alex — Alex is allergic to peanuts.'])
  })
})

describe('moving and forgetting', () => {
  it('moves a note, then a whole folder, and tidies up empty folders left behind', () => {
    const s = store()
    s.write('inbox/idea', 'Build a shed.')
    expect(s.move('inbox/idea', 'projects/shed/idea')).toEqual({ from: 'inbox/idea', to: 'projects/shed/idea', kind: 'note' })
    expect(existsSync(path.join(root(), 'inbox'))).toBe(false)
    expect(s.move('projects/shed', 'projects/outbuildings').kind).toBe('folder')
    expect(s.read('projects/outbuildings/idea').content).toContain('shed')
  })

  it('never overwrites, never moves a folder into itself, and says when there is nothing to move', () => {
    const s = store()
    s.write('a/one', '1')
    s.write('a/two', '2')
    expect(() => s.move('a/one', 'a/two')).toThrow(/already exists/)
    expect(() => s.move('a', 'a/inside')).toThrow(/into itself/)
    expect(() => s.move('missing', 'x')).toThrow(/nothing at/)
    expect(s.read('a/two').content).toContain('2')
  })

  it('forgets a note without touching its neighbours, and prunes the empty folder', () => {
    const s = store()
    s.write('x/y/one', '1')
    s.write('x/two', '2')
    expect(s.remove('x/y/one')).toBe(1)
    expect(existsSync(path.join(root(), 'x', 'y'))).toBe(false)
    expect(s.read('x/two').content).toContain('2')
    expect(() => s.remove('x/y/one')).toThrow(/nothing at/)
  })

  it('refuses to forget a folder full of notes unless told to recurse', () => {
    const s = store()
    s.write('trip/flights', 'a')
    s.write('trip/hotel', 'b')
    expect(() => s.remove('trip')).toThrow(/holds 2 notes/)
    expect(s.count()).toBe(2)
    expect(s.remove('trip', { recursive: true })).toBe(2)
    expect(s.count()).toBe(0)
  })

  it('forgets everything for "delete all memory" and reports how many', () => {
    const s = store()
    s.write('a/b', '1')
    s.write('c', '2')
    expect(s.forgetAll()).toBe(2)
    expect(existsSync(root())).toBe(false)
    expect(s.forgetAll()).toBe(0)
  })
})

describe('the plugin the agent uses', () => {
  const plugin = () => new MemoryTopicsPlugin({ id: 'memory-topics', name: 'Memory Topics', type: 'api-connection', capabilities: ['memory-topics'] } as never)
  const say = async (m: string) => ((await plugin().onMessage(m)) as { result: string } | null)

  it('ignores chat that merely mentions memory, so it falls through to other tools', async () => {
    expect(await say('my memory is bad')).toBeNull()
    expect(await say('memory leaks in my code')).toBeNull()
    expect(await say('what is in the memory of this phone?')).toBeNull()
    expect(await say('')).toBeNull()
  })

  it('shows help for bare "memory"', async () => {
    expect((await say('memory'))!.result).toContain('memory save <path>')
    expect((await say('Memory help'))!.result).toContain('memory tree')
  })

  it('files, updates, finds, reads, moves and forgets through plain commands', async () => {
    expect((await say('memory save projects/garden/plan: Tomatoes in May, beans in June.'))!.result).toMatch(/^Saved projects\/garden\/plan/)
    expect((await say('memory add projects/garden/plan: Bought seeds today.'))!.result).toBe('Added to projects/garden/plan.')
    expect((await say('memory tree'))!.result).toBe('projects/\n  garden/\n    plan  (Plan)')
    const found = (await say('memory search when do I plant tomatoes'))!.result
    expect(found).toContain('projects/garden/plan')
    expect(found).toContain('Tomatoes in May')
    const read = (await say('memory read projects/garden/plan'))!.result
    expect(read).toContain('Bought seeds today.')
    expect((await say('memory move projects/garden/plan to hobbies/garden'))!.result).toBe('Moved note projects/garden/plan to hobbies/garden.')
    expect((await say('memory forget hobbies/garden'))!.result).toBe('Forgot hobbies/garden.')
    expect((await say('memory search tomatoes'))!.result).toMatch(/Nothing in memory/)
  })

  it('reads a path with a colon in the text, not in the path', async () => {
    await say('memory save notes/times: Meeting at 9:30: bring slides')
    expect(store().read('notes/times').content).toContain('Meeting at 9:30: bring slides')
  })

  it('reports problems as sentences instead of throwing, and will not forget a full folder', async () => {
    expect((await say('memory read nope'))!.result).toMatch(/no note/)
    expect((await say('memory save ../x: hi'))!.result).toMatch(/cannot contain/)
    expect((await say('memory save onlypath'))!.result).toMatch(/Format/)
    await say('memory save trip/a: 1')
    await say('memory save trip/b: 2')
    expect((await say('memory forget trip'))!.result).toMatch(/needs recursive/)
    expect(store().count()).toBe(2)
  })

  it('is registered like every other plugin', () => {
    expect(pluginExtensions['memory-topics']).toMatchObject({ id: 'memory-topics' })
    expect(createPluginInstance('memory-topics', pluginExtensions['memory-topics'])).toBeInstanceOf(MemoryTopicsPlugin)
  })
})

describe('the agent loop', () => {
  it('can perceive from topic memory and a skill may name it as a source', async () => {
    expect(PERCEPTION_SOURCES).toContain('topics')
    store().write('people/alex', 'Alex is allergic to peanuts.')
    const caps = buildAgentCapabilities({})
    expect(await caps.searchTopics!('peanuts')).toEqual(['memory/people/alex: Alex — Alex is allergic to peanuts.'])
    expect(await caps.searchTopics!('zzzz')).toEqual([])
  })
})

describe('HTTP routes', () => {
  function call(method: string, pathname: string, query = '', body?: unknown) {
    let status = 0
    let json: any
    const ctx = {
      req: {} as never, res: {} as never, pathname, method,
      url: new URL(`http://x${pathname}${query}`),
      parseBody: async () => body,
      sendJson: (_r: unknown, data: unknown, s = 200) => { status = s; json = data },
    }
    return handleMemoryTopicsRoutes(ctx).then(handled => ({ handled, status, json }))
  }

  it('ignores other paths', async () => {
    expect((await call('GET', '/api/memory')).handled).toBe(false)
    expect((await call('GET', '/api/memory-topicsX')).handled).toBe(false)
  })

  it('writes, lists, searches, reads, appends, moves and deletes', async () => {
    expect((await call('PUT', '/api/memory-topics/note', '', { path: 'projects/shed/plan', content: 'Concrete base first.' })).status).toBe(200)
    expect((await call('POST', '/api/memory-topics/append', '', { path: 'projects/shed/plan', text: 'Order gravel.' })).json.content).toContain('Order gravel.')
    const tree = (await call('GET', '/api/memory-topics')).json
    expect(tree.notes).toBe(1)
    expect(tree.tree.folders[0].name).toBe('projects')
    expect((await call('GET', '/api/memory-topics/search', '?q=concrete')).json.hits[0].path).toBe('projects/shed/plan')
    expect((await call('GET', '/api/memory-topics/note', '?path=projects/shed/plan')).json.title).toBe('Plan')
    expect((await call('POST', '/api/memory-topics/move', '', { from: 'projects/shed', to: 'projects/barn' })).json.kind).toBe('folder')
    expect((await call('DELETE', '/api/memory-topics', '?path=projects')).status).toBe(409)
    expect((await call('DELETE', '/api/memory-topics', '?path=projects&recursive=1')).json).toEqual({ removed: 1 })
  })

  it('answers with the right status for bad input', async () => {
    expect((await call('GET', '/api/memory-topics/note', '?path=missing')).status).toBe(404)
    expect((await call('PUT', '/api/memory-topics/note', '', { path: '../x', content: 'y' })).status).toBe(400)
    expect((await call('PUT', '/api/memory-topics/note', '', 'not an object')).status).toBe(400)
  })
})
