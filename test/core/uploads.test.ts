/**
 * Attaching a file or a folder to a chat message: paths stay inside their batch, bytes are stored as
 * sent, the note carries small text whole and lists the rest, and the page has the controls.
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  safeRelPath, uploadTarget, storeUpload, buildAttachmentNote, isBatchId,
  UPLOAD_CLIENT_JS, UPLOAD_CSS, INLINE_FILE_BYTES,
} from '../../interface/uploads.js'

const BATCH = 'abcdef0123456789'
const tmp = () => mkdtempSync(path.join(tmpdir(), 'nc-upload-'))

describe('paths', () => {
  it('cleans a path and never lets it climb out', () => {
    expect(safeRelPath('proj/src/a.ts')).toBe('proj/src/a.ts')
    expect(safeRelPath('..\\..\\etc/passwd')).toBe('etc/passwd')
    expect(safeRelPath('/abs/./x//y')).toBe('abs/x/y')
    expect(safeRelPath('../..')).toBe('file')
    expect(safeRelPath(undefined)).toBe('file')
  })
  it('only takes a hex batch id and stays inside the batch folder', () => {
    const d = tmp()
    expect(isBatchId(BATCH)).toBe(true)
    expect(isBatchId('../x')).toBe(false)
    expect(uploadTarget(d, '../x', 'a')).toBeNull()
    expect(uploadTarget(d, BATCH, '../../outside')!.startsWith(path.join(d, 'uploads', BATCH) + path.sep)).toBe(true)
  })
})

describe('storeUpload', () => {
  async function post(d: string, rel: string, body: Buffer) {
    return new Promise<{ status: number; json: any }>((resolve) => {
      const srv = http.createServer(async (req, res) => {
        const r = await storeUpload(req, d, BATCH, rel)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(r))
      }).listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as { port: number }
        const rq = http.request({ port, host: '127.0.0.1', method: 'POST' }, (res) => {
          let t = ''; res.on('data', c => (t += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode!, json: JSON.parse(t) }) })
        })
        rq.end(body)
      })
    })
  }
  it('keeps the bytes exactly, folders and all', async () => {
    const d = tmp()
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10])
    const r = await post(d, 'my folder/sub/data.bin', bytes)
    expect(r.status).toBe(200)
    expect(r.json.bytes).toBe(6)
    expect(readFileSync(path.join(d, 'uploads', BATCH, 'my folder/sub/data.bin')).equals(bytes)).toBe(true)
  })
  it('refuses an empty body and leaves no file', async () => {
    const d = tmp()
    const r = await post(d, 'empty.txt', Buffer.alloc(0))
    expect(r.status).toBe(400)
    expect(existsSync(path.join(d, 'uploads', BATCH, 'empty.txt'))).toBe(false)
  })
})

describe('buildAttachmentNote', () => {
  it('puts small text in whole and lists binary and oversized files', () => {
    const d = tmp()
    const base = path.join(d, 'uploads', BATCH)
    mkdirSync(path.join(base, 'p'), { recursive: true })
    writeFileSync(path.join(base, 'p/a.txt'), 'hello there')
    writeFileSync(path.join(base, 'p/b.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(path.join(base, 'p/big.txt'), 'x'.repeat(INLINE_FILE_BYTES + 1))
    const note = buildAttachmentNote(d, BATCH, ['p/a.txt', 'p/b.bin', 'p/big.txt', 'p/missing.txt', '../../etc/passwd'])
    expect(note).toContain('[Attached 5 files]')
    expect(note).toContain('hello there')
    expect(note).toContain('- p/b.bin (3 B)')
    expect(note).toContain('- p/big.txt')
    expect(note).not.toContain('xxxxxxxx')
    expect(note).toContain('- p/missing.txt: not received')
    expect(note).toContain('- etc/passwd: not received')
  })
  it('adds nothing without a batch or files', () => {
    expect(buildAttachmentNote(tmp(), 'nope', ['a'])).toBe('')
    expect(buildAttachmentNote(tmp(), BATCH, [])).toBe('')
  })
})

describe('the page side', () => {
  it('offers File and Folder, takes drops, and keeps to the look', () => {
    expect(UPLOAD_CLIENT_JS).toContain("'Folder'")
    expect(UPLOAD_CLIENT_JS).toContain('webkitdirectory')
    expect(UPLOAD_CLIENT_JS).toContain('webkitGetAsEntry')
    expect(UPLOAD_CLIENT_JS).toContain('X-NC-Upload')
    expect(() => new Function(UPLOAD_CLIENT_JS)).not.toThrow()
    expect(UPLOAD_CSS).toContain('border-radius: 999px')
    expect(UPLOAD_CSS.toLowerCase()).not.toMatch(/#4a7dff|indigo|cyan|blue/)
  })
})
