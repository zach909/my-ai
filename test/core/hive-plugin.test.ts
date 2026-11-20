/**
 * HivePlugin's chat-command surface: "you see the hive team, make it so in
 * any chat a ai can summon a hive teammate or a sub ai or sub team." The
 * real hive delegation/summon work (AlignmentVeto gating, trust reward,
 * blackboard sharing) lives on NeuroclawSystem and is exercised against a
 * real instance in test/smoke.mjs (matching how collaborate()/solve() are
 * tested there); this file is the plugin's own layer -- command parsing and
 * dispatch -- with the live-system call stubbed out, matching
 * store-plugin-manage.test.ts's/ResearchPlugin's own convention for a
 * plugin method that reaches a live singleton.
 */
import { describe, it, expect, vi } from 'vitest'
import { HivePlugin } from '../../plugins/hive.js'

function pluginWithSystem(system: Record<string, unknown> | null) {
  const plugin = new HivePlugin({ id: 'hive', name: 'Hive', type: 'api-connection', capabilities: ['hive'] } as never)
  // getSystem() is `private` only at the TypeScript level -- an ordinary
  // instance method at runtime, stubbed the same way ResearchPlugin's own
  // live-system-touching method is stubbed in test/smoke.mjs.
  ;(plugin as unknown as { getSystem: () => Promise<unknown> }).getSystem = async () => system
  return plugin
}

describe('HivePlugin dispatch', () => {
  it('returns null for a message that does not name a hive command, so it falls through to the next plugin', async () => {
    const plugin = pluginWithSystem(null)
    expect(await plugin.onMessage('what is the weather today')).toBeNull()
    expect(await plugin.onMessage('')).toBeNull()
    expect(await plugin.onMessage('hive')).not.toBeNull() // bare "hive" IS a command (usage text)
  })

  it('"hive" / "hive help" return usage text without touching the live system', async () => {
    const plugin = pluginWithSystem(null)
    const result = (await plugin.onMessage('hive')) as { tool: string; result: string }
    expect(result.tool).toBe('hive')
    expect(result.result).toContain('hive ask')
    expect(result.result).toContain('hive summon')
    const help = (await plugin.onMessage('hive help')) as { tool: string; result: string }
    expect(help.result).toBe(result.result)
  })

  it('"hive team" lists the roster from hiveTeamSnapshot()', async () => {
    const hiveTeamSnapshot = vi.fn().mockReturnValue([
      { id: 'planner', role: 'planner', specialization: 'planning', trust: 12.5 },
      { id: 'coder', role: 'coder', specialization: 'coding', trust: 12.5 },
    ])
    const plugin = pluginWithSystem({ hiveTeamSnapshot })
    const result = (await plugin.onMessage('hive team')) as { tool: string; result: string }
    expect(hiveTeamSnapshot).toHaveBeenCalledOnce()
    expect(result.result).toContain('planner (planner/planning) — trust 12.5')
    expect(result.result).toContain('coder (coder/coding) — trust 12.5')
    // "hive roster" is a synonym for "hive team".
    const alt = (await plugin.onMessage('hive roster')) as { tool: string; result: string }
    expect(alt.result).toBe(result.result)
  })

  it('"hive ask <role>: <task>" delegates to askHiveAgent() and formats a successful answer', async () => {
    const askHiveAgent = vi.fn().mockResolvedValue({ agent: 'coder', role: 'coder', output: 'function fib(n) { ... }' })
    const plugin = pluginWithSystem({ askHiveAgent })
    const result = (await plugin.onMessage('hive ask coder: write a fibonacci function')) as { tool: string; result: string }
    expect(askHiveAgent).toHaveBeenCalledWith('coder', 'write a fibonacci function')
    expect(result.result).toBe('coder (coder): function fib(n) { ... }')
  })

  it('"hive ask" surfaces an error result (e.g. unknown role) instead of throwing', async () => {
    const askHiveAgent = vi.fn().mockResolvedValue({ error: 'No hive agent matches "poet". Current team: coder (coder).' })
    const plugin = pluginWithSystem({ askHiveAgent })
    const result = (await plugin.onMessage('hive ask poet: write a haiku')) as { tool: string; result: string }
    expect(result.result).toContain('No hive agent matches "poet"')
  })

  it('"hive summon <role> <specialization>: <task>" delegates to summonHiveAgent()', async () => {
    const summonHiveAgent = vi.fn().mockResolvedValue({ agent: 'poet.summon.abc', role: 'poet', output: 'Roses are red...' })
    const plugin = pluginWithSystem({ summonHiveAgent })
    const result = (await plugin.onMessage('hive summon poet lyricism: write a haiku about the sea')) as { tool: string; result: string }
    expect(summonHiveAgent).toHaveBeenCalledWith('poet', 'lyricism', 'write a haiku about the sea')
    expect(result.result).toContain('Summoned poet (poet.summon.abc)')
    expect(result.result).toContain('Roses are red...')
  })

  it('"hive summon team <name>: <task>" routes to summonHiveSubTeam(), not the single-agent summon() path', async () => {
    const summonHiveSubTeam = vi.fn().mockResolvedValue({ coordinator: 'chat.hive1.coordinator', output: 'Findings: ...' })
    const summonHiveAgent = vi.fn()
    const plugin = pluginWithSystem({ summonHiveSubTeam, summonHiveAgent })
    const result = (await plugin.onMessage('hive summon team research-squad: investigate quantum batteries')) as { tool: string; result: string }
    expect(summonHiveSubTeam).toHaveBeenCalledWith('research-squad', 'investigate quantum batteries')
    expect(summonHiveAgent).not.toHaveBeenCalled()
    expect(result.result).toContain('New sub-team "research-squad"')
    expect(result.result).toContain('chat.hive1.coordinator')
  })

  const draftResult = (over: Record<string, unknown> = {}) => ({
    title: 'Trees',
    markdown: '# Trees\n\n## Intro\n\nHello.\n',
    sections: [],
    status: 'approved',
    rounds: 1,
    failed: [] as string[],
    usedFallbackOutline: false,
    trace: ['main AI wrote the outline', 'read 1: main AI said OK'],
    ...over,
  })

  it('"hive draft <topic>" lets the main AI outline it, and shows the draft plus how it was made', async () => {
    const draftWithHive = vi.fn().mockResolvedValue(draftResult())
    const plugin = pluginWithSystem({ draftWithHive })
    const result = (await plugin.onMessage('hive draft an essay on trees in cities')) as { tool: string; result: string }
    expect(draftWithHive).toHaveBeenCalledWith('an essay on trees in cities', undefined)
    expect(result.result).toContain('# Trees')
    expect(result.result).toContain('the main AI approved it')
    expect(result.result).toContain('- read 1: main AI said OK')
  })

  it('"hive draft" with a /hivemind outline under the topic line passes the outline through and skips the outline step', async () => {
    const draftWithHive = vi.fn().mockResolvedValue(draftResult())
    const plugin = pluginWithSystem({ draftWithHive })
    await plugin.onMessage('hive draft: trees\n## Intro\n/hivemind writer\n## End')
    expect(draftWithHive).toHaveBeenCalledWith('trees', '## Intro\n/hivemind writer\n## End')
  })

  it('a draft the main AI never approved, or with pieces that failed, says so instead of presenting itself as finished', async () => {
    const draftWithHive = vi.fn().mockResolvedValue(draftResult({ status: 'max-rounds', failed: ['Evidence'] }))
    const plugin = pluginWithSystem({ draftWithHive })
    const result = (await plugin.onMessage('hive draft trees')) as { tool: string; result: string }
    expect(result.result).toContain('NOT approved')
    expect(result.result).toContain('could not write: Evidence')
  })

  it('a withheld draft returns the veto reason', async () => {
    const plugin = pluginWithSystem({ draftWithHive: vi.fn().mockResolvedValue({ error: '[Withheld] nope' }) })
    const result = (await plugin.onMessage('hive draft trees')) as { tool: string; result: string }
    expect(result.result).toBe('[Withheld] nope')
  })

  it('reports "unavailable in fallback mode" instead of throwing when there is no live system', async () => {
    const plugin = pluginWithSystem(null)
    const result = (await plugin.onMessage('hive team')) as { tool: string; result: string }
    expect(result.result).toContain('fallback mode')
  })

  it('describeCapabilities() names every command so the capability router can find this plugin', () => {
    const plugin = pluginWithSystem(null)
    const caps = plugin.describeCapabilities()
    expect(caps.commands).toEqual(expect.arrayContaining(['hive team', 'hive ask <role>: <task>', 'hive summon team <name>: <task>']))
    expect(caps.verbs).toContain('summon')
    expect(caps.nouns).toContain('hive')
  })
})
