/**
 * The agents on a hive work at the same time, and each one is a shoggoth in the sphere.
 *
 * What these protect: the team really overlaps (not one after another), no task is ever taken twice, the
 * overview says who is thinking right now, and the shoggoths always pack into the sphere at one equal size.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createProject, getProject, type ProjectCtx } from '../../models && skills/core/projects.js'
import { runHive, hiveAgentsOverview, type HiveDeps } from '../../models && skills/core/project-hive.js'
import { AMBIENT_JS } from '../../interface/ambient.js'

let dir: string
let pctx: ProjectCtx
let hfile: string
const savedStore = process.env.NEUROCLAW_STORE_DIR
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hive-par-'))
  pctx = { file: path.join(dir, 'projects.json'), pointsFile: path.join(dir, 'points.json') }
  hfile = path.join(dir, 'hives.json')
  process.env.NEUROCLAW_STORE_DIR = path.join(dir, 'store')
})
afterEach(() => {
  if (savedStore === undefined) delete process.env.NEUROCLAW_STORE_DIR
  else process.env.NEUROCLAW_STORE_DIR = savedStore
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('a hive working in parallel', () => {
  it('has several agents thinking at once, takes no task twice, and reports who is thinking', async () => {
    const project = createProject({ title: 'par', pot: 10, tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map((title, i) => ({ title, folder: `F${i % 3}` })) }, pctx)
    let now = 0, peak = 0
    const workedOn: string[] = []
    const seenThinking: string[] = []
    const think: HiveDeps['think'] = async (agent, prompt) => {
      if (prompt.includes('Would it go better')) return 'HELP'
      if (prompt.includes('Start your reply with YES')) return 'NO'
      if (prompt.includes('checking another AI')) return 'ACCEPT'
      now++; peak = Math.max(peak, now)
      if (prompt.includes('Task:')) workedOn.push(/Task: (.*)/.exec(prompt)![1])
      seenThinking.push(...hiveAgentsOverview(hfile).filter(a => a.thinking).map(a => a.id))
      await sleep(15)
      now--
      return 'done'
    }
    await runHive(project.id, { think, file: hfile, project: pctx, publish: () => null })
    expect(peak).toBeGreaterThan(1)
    expect(new Set(workedOn).size).toBe(workedOn.length)
    expect(getProject(project.id, pctx)!.status).toBe('complete')
    expect(seenThinking.length).toBeGreaterThan(0)
    expect(hiveAgentsOverview(hfile).every(a => !a.thinking)).toBe(true)
  })
})

describe('the shoggoths in the sphere', () => {
  const body = /function packCircles\(n\) \{[\s\S]*?\n  \}\n/.exec(AMBIENT_JS)![0]
  const pack = new Function(`var packed = {}; ${body}; return packCircles;`)() as (n: number) => { r: number; pts: number[][] }

  it('are all inside the sphere, none overlapping, at one size, for any number of agents', () => {
    for (let n = 1; n <= 40; n++) {
      const { r, pts } = pack(n)
      expect(pts).toHaveLength(n)
      for (const [x, y] of pts) expect(Math.hypot(x, y) + r).toBeLessThanOrEqual(1 + 1e-9)
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThanOrEqual(2 * r - 1e-9)
      }
    }
  })

  it('are as big as the best known packing for the small teams', () => {
    const best: Record<number, number> = { 1: 1, 2: 0.5, 3: 0.4641, 4: 0.4142, 5: 0.3702, 6: 0.3333, 7: 0.3333, 8: 0.3026, 9: 0.2768 }
    for (const [n, r] of Object.entries(best)) expect(pack(Number(n)).r).toBeCloseTo(r, 3)
  })
})
