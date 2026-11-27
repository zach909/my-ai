/** The editor routes: confinement, guard files, secrets, diff, exact edits and the read-back on save. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleEditorRoutes, diffLines } from '../../interface/editor-routes.js'
import { runAs, OWNER, type Who } from '../../models && skills/core/user-context.js'

let server: http.Server
let base: string
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'editor-'))
  mkdirSync(path.join(dir, 'docs'))
  mkdirSync(path.join(dir, 'scripts'))
  mkdirSync(path.join(dir, 'node_modules'))
  writeFileSync(path.join(dir, 'docs', 'a.md'), '# Title\nline two\n')
  writeFileSync(path.join(dir, 'conf.json'), '{"a":1}')
  writeFileSync(path.join(dir, '.env'), 'KEY=1')
  writeFileSync(path.join(dir, 'scripts', 'check-no-third-party.mjs'), '// guard\n')
  writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]))
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const who: Who = req.headers['x-who'] === 'user' ? { kind: 'user', id: 'u1', name: 'sam', role: 'user' } : OWNER
    await runAs(who, async () => {
      const handled = await handleEditorRoutes({
        req, res, pathname: url.pathname, method: req.method ?? 'GET', root: dir,
        chat: async () => '',
        parseBody: async r => { const c: Buffer[] = []; for await (const x of r) c.push(x as Buffer); return JSON.parse(Buffer.concat(c).toString('utf8') || '{}') },
        sendJson: (r, data, status = 200) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(data)) },
      })
      if (!handled) { res.writeHead(404); res.end('{}') }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as any }
}
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any } }

describe('editor routes', () => {
  it('lists text files, hides secrets, binaries and dependency folders, marks guard files read only', async () => {
    const { body } = await get('/api/editor/files')
    const names = body.files.map((f: any) => f.path)
    expect(names).toContain('docs/a.md')
    expect(names).toContain('conf.json')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('bin.dat')
    expect(body.files.find((f: any) => f.path === 'scripts/check-no-third-party.mjs').readOnly).toBe(true)
    expect(body.files.find((f: any) => f.path === 'conf.json').kind).toBe('json')
  })

  it('only the owner or an admin may use it', async () => {
    expect((await post('/api/editor/diff', { path: 'conf.json', content: 'x' }, { 'x-who': 'user' })).status).toBe(403)
  })

  it('refuses paths outside the project, secrets and binaries', async () => {
    expect((await get('/api/editor/file?path=../etc/passwd')).status).toBe(400)
    expect((await get('/api/editor/file?path=.env')).status).toBe(400)
    expect((await get('/api/editor/file?path=bin.dat')).status).toBe(400)
    expect((await get('/api/editor/file?path=node_modules/x.js')).status).toBe(400)
  })

  it('never writes a guard file', async () => {
    const r = await post('/api/editor/save', { path: 'scripts/check-no-third-party.mjs', content: 'x' })
    expect(r.status).toBe(403)
    expect(readFileSync(path.join(dir, 'scripts', 'check-no-third-party.mjs'), 'utf8')).toBe('// guard\n')
  })

  it('saves with a diff and a verified read-back, and refuses a stale copy', async () => {
    const f = (await get('/api/editor/file?path=docs/a.md')).body
    const next = '# Title\nline 2\n'
    const ok = await post('/api/editor/save', { path: 'docs/a.md', content: next, baseHash: f.hash })
    expect(ok.status).toBe(200)
    expect(ok.body.verified).toBe(true)
    expect(ok.body.diff.added).toBe(1)
    expect(ok.body.diff.removed).toBe(1)
    expect(readFileSync(path.join(dir, 'docs', 'a.md'), 'utf8')).toBe(next)
    const stale = await post('/api/editor/save', { path: 'docs/a.md', content: 'zzz', baseHash: f.hash })
    expect(stale.status).toBe(409)
  })

  it('previews an exact edit, applies it only when asked, and rejects ambiguous matches', async () => {
    const preview = await post('/api/editor/edit', { path: 'conf.json', old: '"a":1', new: '"a":2' })
    expect(preview.body.applied).toBe(false)
    expect(readFileSync(path.join(dir, 'conf.json'), 'utf8')).toBe('{"a":1}')
    const done = await post('/api/editor/edit', { path: 'conf.json', old: '"a":1', new: '"a":2', apply: true })
    expect(done.body.verified).toBe(true)
    expect(readFileSync(path.join(dir, 'conf.json'), 'utf8')).toBe('{"a":2}')
    writeFileSync(path.join(dir, 'dup.txt'), 'x x')
    expect((await post('/api/editor/edit', { path: 'dup.txt', old: 'x', new: 'y', apply: true })).status).toBe(409)
    expect((await post('/api/editor/edit', { path: 'dup.txt', old: 'nope', new: 'y' })).status).toBe(404)
  })
})

describe('diffLines', () => {
  it('reports identical text as the same', () => { expect(diffLines('a\nb', 'a\nb').same).toBe(true) })
  it('finds an insert, a delete and a change', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc\nd')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.lines.filter(l => l.t === '+').map(l => l.s)).toEqual(['x', 'd'])
  })
})
