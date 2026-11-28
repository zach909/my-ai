/**
 * The Referee decides whether a claim is right without trusting how it is worded
 * or the process that made it: it recomputes, runs, cross-checks and counts
 * independent witnesses, and holds anything it cannot judge.
 */
import { describe, it, expect } from 'vitest'
import { Referee, Quarantine, refereedLearn, releaseProven, originOf, type Evidence, type EvidenceSource } from '../../models && skills/core/referee.js'
import { AutonomousLearner } from '../../models && skills/core/autonomous-learner.js'
import { KnowledgeGraph } from '../../models && skills/core/knowledge-graph.js'

const web = (...rows: Array<[string, string]>): EvidenceSource => () => rows.map(([origin, text]) => ({ origin, text, kind: 'web' as const }))
const referee = (...sources: EvidenceSource[]) => new Referee({ sources })

describe('what can be proven wrong without asking anyone', () => {
  it('recomputes arithmetic: a wrong sum is a mistake however confidently it is said', async () => {
    const r = await referee().judge({ claim: 'It is definitely, verifiably proven that 2 * (3 + 4) = 99' })
    expect(r.verdict).toBe('mistake')
    expect(r.action).toBe('reject')
    expect(r.reasons.join(' ')).toContain('= 14')
  })
  it('a claim that is only correct arithmetic needs no witnesses', async () => {
    const r = await referee().judge({ claim: '2 * (3 + 4) = 14' })
    expect(r.verdict).toBe('supported')
    expect(r.action).toBe('accept')
  })
  it('rounding a decimal the way it was written is not a mistake', async () => {
    expect((await referee().judge({ claim: '1 / 3 = 0.333' })).verdict).toBe('supported')
    expect((await referee().judge({ claim: '1 / 3 = 0.5' })).verdict).toBe('mistake')
  })
  it('code that fails its test is a mistake; with no runner it is reported untested, never passed', async () => {
    const failing = new Referee({ testCode: () => ({ passed: false, detail: 'expected 3 got 4' }) })
    expect((await failing.judge({ claim: 'This function adds two numbers correctly', code: ['x'] })).verdict).toBe('mistake')
    const none = await referee().judge({ claim: 'This function adds two numbers correctly', code: ['x'] })
    expect(none.reasons.join(' ')).toContain('not tested')
    expect(none.verdict).not.toBe('supported')
  })
  it('a claim that contradicts itself is a mistake', async () => {
    const r = await referee().judge({ claim: 'Glass is a liquid. Glass is not a liquid.' })
    expect(r.verdict).toBe('mistake')
  })
})

describe('outside evidence counts by independent origin', () => {
  const claim = 'The Eiffel Tower is located in Paris France'
  it('two independent sites agreeing is support', async () => {
    const r = await referee(web(
      ['https://www.britannica.com/topic/eiffel', 'The Eiffel Tower is located in Paris, France, on the Champ de Mars.'],
      ['https://en.wikipedia.org/wiki/Eiffel_Tower', 'Located in Paris France, the Eiffel Tower was finished in 1889.'],
    )).judge({ claim })
    expect(r.verdict).toBe('supported')
    expect(r.action).toBe('accept')
    expect(r.reliability).toBeGreaterThan(0.7)
  })
  it('ten pages from one site are one voice', async () => {
    const rows: Array<[string, string]> = [1, 2, 3, 4].map(i => [`https://blog.example.com/p${i}`, `Post ${i}: the Eiffel Tower is located in Paris France, as everyone knows.`])
    const r = await referee(web(...rows)).judge({ claim })
    expect(r.verdict).toBe('unconfirmed')
    expect(r.action).toBe('hold')
  })
  it('one article mirrored on two sites is still one voice', async () => {
    const text = 'The Eiffel Tower is located in Paris France and is visited by millions.'
    const r = await referee(web(['https://a-news.com/x', text], ['https://b-mirror.org/y', text])).judge({ claim })
    expect(r.verdict).toBe('unconfirmed')
  })
  it('two independent sites opposing is a contradiction, and a confident tone does not save it', async () => {
    const r = await referee(web(
      ['https://a-atlas.com/1', 'The Eiffel Tower is not located in Paris France; it stands in Lyon.'],
      ['https://b-guide.org/2', 'The Eiffel Tower is not located in Paris France according to this page.'],
    )).judge({ claim: 'The Eiffel Tower is definitely, certainly located in Paris France' })
    expect(r.verdict).toBe('contradicted')
    expect(r.action).toBe('reject')
    expect(r.reliability).toBe(0)
  })
  it('a mismatched number opposes the claim', async () => {
    const r = await referee(web(
      ['https://a-facts.com/1', 'The Eiffel Tower is 330 metres tall.'],
      ['https://b-facts.org/2', 'Standing 330 metres tall, the Eiffel Tower dominates Paris.'],
    )).judge({ claim: 'The Eiffel Tower is 450 metres tall' })
    expect(r.verdict).toBe('contradicted')
    expect(r.findings[0].why).toContain('numbers disagree')
  })
  it('evidence split across independent sites is disputed and held for a person', async () => {
    const r = await referee(web(
      ['https://a-one.com/1', 'Coffee does increase alertness in most adults.'],
      ['https://b-two.org/2', 'Coffee does not increase alertness in most adults.'],
    )).judge({ claim: 'Coffee does increase alertness in most adults' })
    expect(r.verdict).toBe('disputed')
    expect(r.action).toBe('hold')
  })
  it('a single opposing source is only a dispute, never a rejection (cue words are not comprehension)', async () => {
    const r = await referee(web(['https://a-one.com/1', 'Coffee does not increase alertness in most adults.'])).judge({ claim: 'Coffee does increase alertness in most adults' })
    expect(r.verdict).toBe('disputed')
    expect(r.limits.join(' ')).toContain('cue words')
  })
  it('evidence about something else says nothing; a possible new idea is held as a hypothesis', async () => {
    const r = await referee(web(['https://a-one.com/1', 'Bananas are rich in potassium and grow in tropical climates.'])).judge({ claim: 'Graphene membranes filter seawater at ambient pressure' })
    expect(r.verdict).toBe('unconfirmed')
    expect(r.reasons.join(' ')).toContain('possible new idea')
  })
  it('a curated source can carry two votes by itself', async () => {
    const trusted: EvidenceSource = () => [{ origin: 'kb:scifact', kind: 'kb', trust: 2, text: 'Vitamin D supplementation reduces the risk of rickets in children.' } as Evidence]
    const r = await referee(trusted).judge({ claim: 'Vitamin D supplementation reduces the risk of rickets in children' })
    expect(r.verdict).toBe('supported')
  })
  it('evidence from the claim\'s own source is thrown away: a claim cannot vouch for itself', async () => {
    const r = await referee(web(
      ['https://my-blog.example.net/a', 'The Eiffel Tower is located in Paris France.'],
      ['https://my-blog.example.net/b', 'Yes, the Eiffel Tower is located in Paris France.'],
    )).judge({ claim, source: 'https://my-blog.example.net/post' })
    expect(r.verdict).toBe('unconfirmed')
  })
  it('no evidence source answering is "unchecked", not "true" and not "false"', async () => {
    expect((await referee().judge({ claim })).verdict).toBe('unchecked')
    const broken: EvidenceSource = () => { throw new Error('connection refused') }
    const r = await referee(broken).judge({ claim })
    expect(r.verdict).toBe('unchecked')
    expect(r.reasons.join(' ')).toContain('failed')
  })
  it('a source that never answers is cut off at the timeout', async () => {
    const hang: EvidenceSource = () => new Promise(() => {})
    const r = await new Referee({ sources: [hang], timeoutMs: 20 }).judge({ claim })
    expect(r.verdict).toBe('unchecked')
  })
  it('folds hostnames into one origin per site', () => {
    expect(originOf('https://www.nature.com/articles/x')).toBe('nature.com')
    expect(originOf('https://news.bbc.co.uk/a')).toBe('bbc.co.uk')
    expect(originOf('kb:scifact')).toBe('kb:scifact')
  })
})

describe('the AI\'s own memory', () => {
  it('can never confirm a claim alone, so an earlier mistake cannot vouch for a later one', async () => {
    const kg = new KnowledgeGraph(); kg.relate('the moon', 'is', 'made of cheese', { confidence: 0.9 })
    const r = await new Referee({ knowledge: kg }).judge({ claim: 'The moon is made of cheese' })
    expect(r.verdict).not.toBe('supported')
    expect(r.agreeWeight).toBe(0.5)
  })
  it('can raise a dispute, but never reject a claim by itself', async () => {
    const kg = new KnowledgeGraph(); kg.relate('the moon', 'is-not', 'made of cheese', { confidence: 0.9 })
    const r = await new Referee({ knowledge: kg }).judge({ claim: 'The moon is made of cheese' })
    expect(r.verdict).toBe('disputed')
    expect(r.action).toBe('hold')
  })
})

describe('not every sentence is a claim', () => {
  for (const claim of ['Is the moon made of cheese?', 'I think pineapple on pizza is wonderful', 'Bitcoin will crash next year', 'ok']) {
    it(`ignores: ${claim}`, async () => {
      const r = await referee(web(['https://a.com', 'anything'])).judge({ claim })
      expect(r.verdict).toBe('unverifiable')
      expect(r.action).toBe('ignore')
    })
  }
})

describe('the gate in front of what the AI learns', () => {
  const proven = web(
    ['https://a-one.com/1', 'Water boils at 100 degrees Celsius at sea level. Higher up, where air pressure drops, the boiling point falls.'],
    ['https://b-two.org/2', 'A kitchen reference: at sea level, water boils at 100 degrees Celsius, which is why pasta recipes give fixed timings.'],
  )
  it('learns what is supported, at the reliability the evidence earned', async () => {
    const kg = new KnowledgeGraph(); const learner = new AutonomousLearner(kg); const q = new Quarantine()
    const out = await refereedLearn(referee(proven), learner, q, 'Water boils at 100 degrees Celsius at sea level')
    expect(out.ruling.verdict).toBe('supported')
    expect(out.learned).toBeDefined()
    expect(out.learned!.reliability).toBeCloseTo(out.ruling.reliability, 5)
  })
  it('closes the old hole: a confidently worded falsehood is NOT learned, though the wording alone would have passed', async () => {
    const kg = new KnowledgeGraph(); const learner = new AutonomousLearner(kg); const q = new Quarantine()
    const lie = 'The sun is definitely, certainly, provably confirmed cold'
    expect(new AutonomousLearner(new KnowledgeGraph()).learn(lie).decision).not.toBe('ignored-unreliable') // the wording-only judge let it in
    const hot = web(['https://a-one.com/1', 'The sun is not cold; it is extremely hot.'], ['https://b-two.org/2', 'The sun is not cold, it is a very hot star.'])
    const out = await refereedLearn(referee(hot), learner, q, lie)
    expect(out.ruling.action).toBe('reject')
    expect(out.learned).toBeUndefined()
    expect(kg.getConcept('the sun')).toBeUndefined()
  })
  it('a carefully hedged truth is not lost to its wording', async () => {
    const kg = new KnowledgeGraph(); const learner = new AutonomousLearner(kg); const q = new Quarantine()
    const out = await refereedLearn(referee(proven), learner, q, 'Maybe, I think, water boils at 100 degrees Celsius at sea level')
    expect(out.ruling.verdict).toBe('supported')
    expect(out.learned!.decision).not.toBe('ignored-unreliable')
  })
  it('a possible new idea goes to the shelf, not into the graph, and is released once corroborated', async () => {
    const kg = new KnowledgeGraph(); const learner = new AutonomousLearner(kg); const q = new Quarantine()
    let rows: Array<[string, string]> = []
    const live: EvidenceSource = () => rows.map(([origin, text]) => ({ origin, text, kind: 'web' as const }))
    const ref = referee(live)
    const idea = 'Seawater desalination works with graphene membranes at ambient pressure'
    const out = await refereedLearn(ref, learner, q, idea)
    expect(out.ruling.verdict).toBe('unconfirmed')
    expect(out.held).toBeTruthy()
    expect(kg.conceptCount()).toBe(0)
    expect(q.size()).toBe(1)

    expect(await releaseProven(ref, learner, q)).toHaveLength(0)
    expect(q.size()).toBe(1)

    rows = [
      ['https://a-lab.com/1', 'Seawater desalination works with graphene membranes at ambient pressure, a new study found.'],
      ['https://b-journal.org/2', 'A study shows seawater desalination works with graphene membranes at ambient pressure.'],
    ]
    const released = await releaseProven(ref, learner, q)
    expect(released).toHaveLength(1)
    expect(q.size()).toBe(0)
    expect(kg.conceptCount()).toBeGreaterThan(0)
  })
  it('a held claim that turns out false is dropped, and a dispute stays for a person', async () => {
    const q = new Quarantine(); const learner = new AutonomousLearner(new KnowledgeGraph())
    const disputed = referee(web(['https://a-one.com/1', 'Coffee does not increase alertness in most adults.']))
    await refereedLearn(disputed, learner, q, 'Coffee does increase alertness in most adults')
    for (let i = 0; i < 10; i++) await q.recheck(disputed)
    expect(q.size()).toBe(1)
    expect(q.list()[0].verdict).toBe('disputed')
  })
  it('the shelf is bounded', async () => {
    const q = new Quarantine(3)
    const ref = referee(web(['https://a.com', 'nothing relevant here at all']))
    for (let i = 0; i < 8; i++) q.add(await ref.judge({ claim: `Zorblax number ${i} frobnicates the quux module` }))
    expect(q.size()).toBe(3)
  })
})

describe('auditing the referee itself', () => {
  it('keeps a bounded history and counts verdicts, so a referee that rejects or accepts everything shows up', async () => {
    const ref = new Referee({ historySize: 5 })
    for (let i = 0; i < 9; i++) await ref.judge({ claim: `${i} + 1 = ${i + 1}` })
    await ref.judge({ claim: '2 + 2 = 5' })
    expect(ref.recent(100)).toHaveLength(5)
    expect(ref.stats()).toEqual({ supported: 9, mistake: 1 })
  })
})
