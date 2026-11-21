/**
 * Hosted mode over real HTTP: an account makes a token, a guest uses it on the
 * compute route, the admin sets the limits, and with no passphrase everything
 * stays shut. The vault on disk is checked for plaintext.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleCoronaRoutes } from '../../interface/corona-routes.js'
import { handleHostedRoutes, isHostedRoute } from '../../interface/hosted-routes.js'
import { getAccounts, resetAccounts, userMayReach } from '../../models && skills/core/accounts.js'
import { addPeer, loadCompute } from '../../models && skills/core/compute-share.js'
import { borrowPriced } from '../../models && skills/core/compute-market.js'
import { resetHosted, hostedFile } from '../../models && skills/core/hosted.js'
import { runAs, OWNER, ANONYMOUS } from '../../models && skills/core/user-context.js'

let dir: string
let server: http.Server
let base: string
const ids: Record<string, string> = {}

async function body(req: http.IncomingMessage, max = Infinity): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) { n += c.length; if (n > max) throw new Error('too big'); chunks.push(c as Buffer) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const who = String(req.headers['x-who'] ?? '')
    const w = who === 'owner' ? OWNER
      : ids[who] ? { kind: 'user' as const, id: ids[who], name: who, role: (who === 'boss' ? 'admin' : 'user') as 'admin' | 'user' }
      : ANONYMOUS
    const common = {
      req, res, pathname: url.pathname, method: req.method ?? 'GET',
      parseBody: (r: http.IncomingMessage, m?: number) => body(r, m),
      sendJson: (r: http.ServerResponse, data: unknown, status = 200) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(data)) },
    }
    const handled = isHostedRoute(url.pathname)
      ? await runAs(w, () => handleHostedRoutes(common))
      : await handleCoronaRoutes({ ...common, chat: async m => `OWNER-CHAT:${m}`, text: async m => `text:${m}`, status: () => ({}) })
    if (!handled) { res.writeHead(404); res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))

const PASS = 'a long passphrase for the test vault'
const KEYS = ['CORONA_DATA_DIR', 'CORONA_ACCOUNTS_FILE', 'CORONA_COMPUTE_FILE', 'CORONA_HOSTED_FILE', 'NEUROCLAW_VAULT_PASSPHRASE']

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hosted-routes-'))
  process.env.CORONA_DATA_DIR = dir
  process.env.CORONA_ACCOUNTS_FILE = path.join(dir, 'accounts.json')
  process.env.CORONA_COMPUTE_FILE = path.join(dir, 'compute.json')
  process.env.CORONA_HOSTED_FILE = path.join(dir, 'hosted.vault')
  process.env.NEUROCLAW_VAULT_PASSPHRASE = PASS
  resetAccounts(); resetHosted()
  const a = getAccounts()
  ids.boss = (await a.setupAdmin('boss', 'boss-password-1', true)).id
  ids.sam = (await a.createUser('sam', 'sam-password-1')).id
  ids.kim = (await a.createUser('kim', 'kim-password-1')).id
})
afterEach(() => {
  for (const k of KEYS) delete process.env[k]
  resetAccounts(); resetHosted()
  for (const k of Object.keys(ids)) delete ids[k]
  // Only the folder this test made, nothing above it.
  if (path.basename(dir).startsWith('hosted-routes-') && path.dirname(dir) === tmpdir()) rmSync(dir, { recursive: true, force: true })
})

const call = async (method: string, p: string, opts: { who?: string; token?: string; json?: unknown } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.who ? { 'x-who': opts.who } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}
const run = (token: string, prompt = 'hello') => call('POST', '/api/corona/v1/compute/run', { token, json: { job: 'chat', prompt } })

describe('who may reach the hosted routes', () => {
  it('lets an ordinary account use its own tokens and see its usage, and keeps the limits for the admin', () => {
    expect(userMayReach('/api/hosted/status', 'GET')).toBe(true)
    expect(userMayReach('/api/hosted/tokens', 'GET')).toBe(true)
    expect(userMayReach('/api/hosted/tokens', 'POST')).toBe(true)
    expect(userMayReach('/api/hosted/tokens/0123456789abcdef', 'DELETE')).toBe(true)
    expect(userMayReach('/api/hosted/settings', 'POST')).toBe(false)
    expect(userMayReach('/api/hosted/tokens/not-an-id', 'DELETE')).toBe(false)
    expect(userMayReach('/api/hosted/', 'GET')).toBe(false)
  })
})

describe('hosted mode over HTTP', () => {
  it('works with the borrow call a client\'s chooser already uses, with the token added as a peer', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true, dailyCu: 5 } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'phone' } })).json
    const peer = addPeer({ name: 'Host', baseUrl: base, leaseToken: token })
    const before = loadCompute().balance
    const r = await borrowPriced(peer.id, 'hello from a client')
    expect(r.result).toBe('text:hello from a client')
    // A hosted guest is limited by its account's day on the server, so its own ledger is not spent.
    expect(r.cu).toBe(0)
    expect(loadCompute().balance).toBe(before)
  })

  it('is off until the admin turns it on, and only the admin can', async () => {
    expect((await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'phone' } })).status).toBe(403)
    expect((await call('POST', '/api/hosted/settings', { who: 'sam', json: { enabled: true } })).status).toBe(403)
    expect((await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true, dailyCu: 5 } })).status).toBe(200)
    expect((await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'phone' } })).status).toBe(201)
  })

  it('lets an account make a token, use it as a guest, and see its day', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true, dailyCu: 5 } })
    const made = await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'phone' } })
    const token = made.json.token as string
    expect(token.startsWith('nch_')).toBe(true)
    expect(JSON.stringify((await call('GET', '/api/hosted/tokens', { who: 'sam' })).json)).not.toContain(token)
    expect((await call('GET', '/api/hosted/tokens', { who: 'kim' })).json.tokens).toHaveLength(0)

    const r = await run(token, 'hello')
    expect(r.status).toBe(200)
    // The text-only path, never the owner's chat with its plugins.
    expect(r.json.result).toBe('text:hello')
    expect(r.json).toMatchObject({ hosted: true, cu: 0 })
    const offer = await call('GET', '/api/corona/v1/compute/lease', { token })
    expect(offer.status).toBe(200)
    expect(offer.json.remainingCu).toBeLessThanOrEqual(5)
    expect(offer.json.pointsPerCu).toBe(0)
    expect((await call('GET', '/api/hosted/status', { who: 'sam' })).json.usage.jobs).toBe(1)
  })

  it('shows an ordinary account the limits that matter to it and nothing about how the server is set up', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const sam = (await call('GET', '/api/hosted/status', { who: 'sam' })).json
    expect(sam.enabled).toBe(true)
    expect(sam.limits).toEqual({ dailyCu: 30, perMinute: 10, maxPromptChars: 16000 })
    expect(sam.settings).toBeUndefined()
    expect(sam.reason).toBeUndefined()
    expect((await call('GET', '/api/hosted/status', { who: 'boss' })).json.settings.maxQueue).toBe(8)
  })

  it('gives a wrong or revoked token the same 401, and a revoked one stops working at once', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const made = await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })
    expect((await run('nch_not-a-real-token')).status).toBe(401)
    expect((await call('GET', '/api/corona/v1/compute/lease', { token: 'nch_not-a-real-token' })).status).toBe(401)
    expect((await run(made.json.token)).status).toBe(200)
    expect((await call('DELETE', `/api/hosted/tokens/${made.json.record.id}`, { who: 'kim' })).json.revoked).toBe(false)
    expect((await call('DELETE', `/api/hosted/tokens/${made.json.record.id}`, { who: 'sam' })).json.revoked).toBe(true)
    expect((await run(made.json.token)).status).toBe(401)
  })

  it('stops a guest whose account is disabled', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })).json
    getAccounts().setDisabled(ids.sam, true)
    expect((await run(token)).status).toBe(403)
  })

  it('refuses a guest that asks for something other than chat, and one with a lease-style token here', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })).json
    expect((await call('POST', '/api/corona/v1/compute/run', { token, json: { job: 'shell', prompt: 'rm -rf /' } })).status).toBe(400)
    expect((await call('POST', '/api/corona/v1/chat', { token, json: { message: 'hi' } })).status).toBe(401) // not an app token
  })

  it('has no tokens for the owner without an account, and none for the signed-out', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    expect((await call('POST', '/api/hosted/tokens', { who: 'owner', json: {} })).status).toBe(400)
    expect((await call('GET', '/api/hosted/tokens')).status).toBe(400)
  })

  it('validates the admin\'s settings', async () => {
    for (const bad of [{ dailyCu: -1 }, { perMinute: 0 }, { enabled: 'yes' }, { nope: 1 }]) {
      expect((await call('POST', '/api/hosted/settings', { who: 'boss', json: bad })).status, JSON.stringify(bad)).toBe(400)
    }
  })

  it('keeps no token, label or readable structure on disk', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'MY-SECRET-LABEL' } })).json
    await run(token)
    const file = hostedFile()
    const raw = readFileSync(file)
    for (const needle of [token, 'MY-SECRET-LABEL', 'dailyCu', 'tokens', 'usedCu', ids.sam]) {
      expect(raw.includes(Buffer.from(needle)), needle).toBe(false)
    }
    expect(raw.subarray(0, 4).toString()).toBe('NCV1')
    expect((statSync(file).size - 48) % 4096).toBe(0) // a 48-byte header, then the body padded to whole 4 KiB blocks
  })

  it('stays shut with no passphrase: no hosting, no tokens, no guests, and the admin is told why', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })).json
    delete process.env.NEUROCLAW_VAULT_PASSPHRASE
    resetHosted()
    expect((await run(token)).status).toBe(503)
    expect((await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })).status).toBe(503)
    expect((await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })).status).toBe(503)
    const boss = (await call('GET', '/api/hosted/status', { who: 'boss' })).json
    expect(boss.available).toBe(false)
    expect(boss.reason).toMatch(/NEUROCLAW_VAULT_PASSPHRASE/)
    expect((await call('GET', '/api/hosted/status', { who: 'sam' })).json.reason).toBeUndefined()
  })

  it('stays shut with the wrong passphrase, and does not start over with an empty vault', async () => {
    await call('POST', '/api/hosted/settings', { who: 'boss', json: { enabled: true } })
    const { token } = (await call('POST', '/api/hosted/tokens', { who: 'sam', json: { label: 'x' } })).json
    const before = readFileSync(hostedFile())
    process.env.NEUROCLAW_VAULT_PASSPHRASE = 'some other passphrase entirely'
    resetHosted()
    expect((await run(token)).status).toBe(503)
    expect((await call('POST', '/api/hosted/settings', { who: 'boss', json: { dailyCu: 1000 } })).status).toBe(503)
    expect(readFileSync(hostedFile()).equals(before)).toBe(true) // nothing was overwritten
    process.env.NEUROCLAW_VAULT_PASSPHRASE = PASS
    resetHosted()
    expect((await run(token)).status).toBe(200) // the right one still opens it
  })
})
