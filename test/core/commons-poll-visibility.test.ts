/**
 * The Commons page polls the engine every few seconds. A hidden tab must stop:
 * on a phone, polling a page nobody is looking at keeps the radio awake and
 * drains the battery. Every poller goes through poll(), which pauses on
 * visibilitychange and catches up when the tab returns.
 */
import { describe, it, expect } from 'vitest'
import { COMMONS_PAGE } from '../../interface/commons-page.js'

describe('Commons page polling', () => {
  it('has no bare setInterval outside the visibility-aware poll() helper', () => {
    const uses = COMMONS_PAGE.match(/setInterval\(/g) ?? []
    expect(uses).toHaveLength(1) // the one inside poll()
    const helper = COMMONS_PAGE.slice(COMMONS_PAGE.indexOf('function poll(fn, ms)'))
    expect(helper.slice(0, 600)).toContain('clearInterval')
    expect(helper.slice(0, 600)).toContain("'visibilitychange'")
    expect(helper.slice(0, 600)).toContain('document.hidden')
  })

  it('routes all four pollers (safety, agent, health, experts) through poll()', () => {
    expect((COMMONS_PAGE.match(/\bpoll\(/g) ?? []).length).toBeGreaterThanOrEqual(5) // definition + 4 calls
  })
})
