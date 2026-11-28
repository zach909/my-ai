/**
 * The Referee: an independent ruling on whether a claim is right.
 *
 * The problem it answers: a language model cannot tell, from the inside, a new
 * idea from a mistake from a falsehood. All three arrive in the same confident
 * voice. `AutonomousLearner` used to settle it by reading the claim's own
 * wording (hedge words lower reliability, "definitely" raises it), which a
 * confidently worded falsehood passes and a carefully hedged truth fails.
 *
 * So the ruling never comes from the process that made the claim, and never
 * from how the claim sounds. It comes from five things the claim cannot talk
 * its way past:
 *
 *   1. RECOMPUTE   arithmetic in the claim is recalculated (MathEngine).
 *   2. EXECUTE     code in the claim is run by a sandbox the caller supplies;
 *                  no runner means "not tested", never "passed".
 *   3. SELF-CHECK  a claim that contradicts itself is a mistake.
 *   4. EVIDENCE    outside sources (SearXNG, the knowledge base) are asked. A
 *                  source counts once per independent origin: ten pages from
 *                  one site, or one article mirrored on two, are one voice.
 *                  Evidence from the claim's own source is thrown out.
 *   5. MEMORY      what the AI already holds counts for half a vote and can
 *                  never confirm a claim alone, so an earlier mistake cannot
 *                  vouch for a later one. It can still raise a dispute.
 *
 * Verdicts, and what each is for:
 *   supported     two independent agreeing votes, nothing against   -> accept as fact
 *   contradicted  two independent opposing votes, nothing for       -> reject (false)
 *   mistake       provably wrong: bad arithmetic, failing code,
 *                 self-contradiction                                -> reject (error)
 *   disputed      independent evidence on both sides                -> hold for a person
 *   unconfirmed   nothing agrees or opposes enough: a possible NEW
 *                 IDEA, or just an unverified one                   -> hold as hypothesis
 *   unverifiable  opinion, question, prediction: not a fact claim   -> ignore
 *   unchecked     no evidence source answered at all                -> hold, say so
 *
 * Honest limits (also returned in every ruling that relied on them): whether a
 * sentence agrees with or opposes a claim is decided by cue words (negation,
 * opposite words, mismatched numbers), not by understanding. That is why one
 * opposing source is only ever "disputed", and why nothing is "supported"
 * without two independent origins agreeing. The referee is a filter that fails
 * safe (holds what it cannot judge); it is not an oracle.
 *
 * Deterministic, local, no third-party code. The only outside service is the
 * evidence callback the caller passes in (the owner's SearXNG).
 */

import { extractTriple } from "./autonomous-learner.js";
import type { AutonomousLearner, LearnOptions, LearnResult } from "./autonomous-learner.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import { MathEngine } from "./math-engine.js";
import type { MistakeTracker } from "./mistake-tracker.js";

export type Verdict = "supported" | "contradicted" | "mistake" | "disputed" | "unconfirmed" | "unverifiable" | "unchecked";
export type RefereeAction = "accept" | "hold" | "reject" | "ignore";

export interface Evidence {
  /** The passage that may bear on the claim (a snippet, an abstract, a page excerpt). */
  text: string;
  /** Where it came from: a URL, a hostname, or a source id. Independence is counted by this. */
  origin: string;
  kind?: "web" | "kb" | "memory" | "other";
  /** How much one vote from this origin is worth (default 1). A curated source may be 2. */
  trust?: number;
}

export type EvidenceSource = (claim: string) => Evidence[] | Promise<Evidence[]>;

export interface Finding {
  origin: string;
  stance: "agrees" | "opposes" | "off-topic";
  sentence: string;
  relevance: number;
  why: string;
}

export interface Ruling {
  claim: string;
  verdict: Verdict;
  action: RefereeAction;
  /** How sure the referee is of THIS verdict (not of the claim). Never above 0.97. */
  confidence: number;
  /** What to store the claim at if it is stored at all: 0 for anything rejected or ignored, low for held. */
  reliability: number;
  reasons: string[];
  findings: Finding[];
  agreeWeight: number;
  opposeWeight: number;
  limits: string[];
}

export interface ReferInput {
  claim: string;
  /** Where the claim came from. Evidence from the same origin is discarded: a claim cannot vouch for itself. */
  source?: string;
  /** Extra calculations to recompute besides the ones found in the claim text. */
  calculations?: Array<{ expression: string; claimed: number; vars?: Record<string, number> }>;
  /** Code snippets to run through `testCode`. */
  code?: string[];
}

export interface RefereeDeps {
  knowledge?: KnowledgeGraph;
  math?: MathEngine;
  mistakes?: MistakeTracker;
  /** Outside evidence. Each is asked in parallel, bounded by `timeoutMs`; a failure counts as silence, not as agreement. */
  sources?: EvidenceSource[];
  /** Runs a snippet in a sandbox the caller trusts. Never executed here directly. */
  testCode?: (code: string) => { passed: boolean; detail: string } | Promise<{ passed: boolean; detail: string }>;
  /** Origins that are never evidence (the AI's own output, its own site). */
  excludeOrigins?: string[];
  /** Vote weight needed to settle a claim (default 2). */
  needed?: number;
  timeoutMs?: number;
  /** Rulings kept for audit. Bounded (default 200). */
  historySize?: number;
}

const LIMITS_STANCE = "Agree/oppose is decided by cue words (negation, opposite words, mismatched numbers), not understanding; a lone opposing source is only ever 'disputed'.";
const MAX_CONFIDENCE = 0.97;
const MAX_EVIDENCE_PER_SOURCE = 20;
const MAX_EVIDENCE_CHARS = 4000;
const MIN_RELEVANCE = 0.6;
const MEMORY_WEIGHT = 0.5;

const STOP = new Set(("a an the of to in on at by for from with and or but if then so as is are was were be been being am do does did has have had it its this that these those there here which who whom whose what when where why how "
  + "i you he she we they them his her their our your my me us will would shall should can could may might must about into over under than also very just more most some any each other such only own same too "
  // How sure the speaker sounds says nothing about what the claim is about: certainty and hedge words never count toward relevance.
  + "definitely certainly surely absolutely obviously clearly undoubtedly truly really actually literally totally provably verifiably confirmed verified proven proved fact indeed "
  + "maybe perhaps possibly probably likely apparently supposedly allegedly reportedly think thought believe heard guess sure everyone know known").split(" "));
const NEG = new Set(["not", "no", "never", "without", "neither", "nor", "none", "nobody", "nothing", "nowhere", "false", "untrue", "debunked", "myth", "isnt"]);
const ANTONYMS: Array<[string, string]> = [
  ["increase", "decrease"], ["higher", "lower"], ["more", "less"], ["improve", "worsen"], ["raise", "lower"], ["rise", "fall"],
  ["larger", "smaller"], ["bigger", "smaller"], ["before", "after"], ["safe", "dangerous"], ["true", "false"], ["legal", "illegal"],
  ["possible", "impossible"], ["always", "never"], ["open", "closed"], ["hot", "cold"], ["faster", "slower"], ["longer", "shorter"],
  ["taller", "shorter"], ["older", "younger"], ["win", "lose"], ["first", "last"], ["up", "down"], ["alive", "dead"], ["cause", "prevent"],
  ["gain", "loss"], ["positive", "negative"], ["effective", "ineffective"], ["inside", "outside"], ["majority", "minority"],
];
const ANTONYM = new Map<string, string>();
for (const [a, b] of ANTONYMS) { ANTONYM.set(stem(a), stem(b)); ANTONYM.set(stem(b), stem(a)); }
const OPPOSITE_RELATION = new Map<string, string>();
for (const [a, b] of [["is", "is-not"], ["can", "cannot"], ["causes", "prevents"], ["true", "false"], ["increases", "decreases"], ["requires", "excludes"]]) {
  OPPOSITE_RELATION.set(a, b); OPPOSITE_RELATION.set(b, a);
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const norm = (t: string) => (t || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Every word, lowercased, with contractions opened up so "isn't" is a negation, not noise. */
function allWords(text: string): string[] {
  return (text || "").toLowerCase().replace(/\bcannot\b/g, "can not").replace(/n['’]t\b/g, " not").split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}
function contentTerms(text: string): string[] {
  return allWords(text).filter(w => w.length > 1 && !STOP.has(w) && !NEG.has(w) && !/^\d+$/.test(w));
}
function negationParity(words: string[]): number { return words.filter(w => NEG.has(w)).length % 2; }

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of (text || "").matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
const sameNumber = (a: number, b: number) => a === b || Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));

function sentencesOf(text: string): string[] {
  return (text || "").slice(0, MAX_EVIDENCE_CHARS).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/** One independent voice per site: a hostname with `www.` and subdomains folded into its registrable domain. */
export function originOf(raw: string): string {
  const s = (raw || "").trim().toLowerCase();
  let host = s;
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) host = new URL(s).hostname; } catch { host = s; }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return host || "unknown";
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tail = labels[labels.length - 1], second = labels[labels.length - 2];
  return labels.slice(tail.length === 2 && second.length <= 3 ? -3 : -2).join(".");
}

/** Does this sentence agree with or oppose the claim? Cue words only; see the limits note at the top. */
function stanceOf(claim: string, sentence: string, relevance: number): { opposes: boolean; why: string } {
  const c = allWords(claim), s = allWords(sentence);
  const sSet = new Set(s);
  const cNums = numbersIn(claim), sNums = numbersIn(sentence);
  if (cNums.length && sNums.length && relevance >= 0.7 && !cNums.some(a => sNums.some(b => sameNumber(a, b)))) {
    return { opposes: true, why: `numbers disagree (claim ${cNums.join("/")}, source ${sNums.join("/")})` };
  }
  let flips = negationParity(c) !== negationParity(s) ? 1 : 0;
  const reasons: string[] = flips ? ["negation differs"] : [];
  for (const w of new Set(c)) {
    const anti = ANTONYM.get(w);
    if (anti && sSet.has(anti) && !sSet.has(w)) { flips++; reasons.push(`"${w}" vs "${anti}"`); }
  }
  return flips % 2 ? { opposes: true, why: reasons.join("; ") } : { opposes: false, why: "same polarity" };
}

/** Is this something that can be right or wrong at all? */
function notAFactClaim(claim: string): string | null {
  const t = claim.trim();
  if (contentTerms(t).length < 2 && !/\d/.test(t)) return "too little to check";
  if (/\?\s*$/.test(t)) return "a question, not a claim";
  // "I think water boils at 100C" is a hedged fact and is judged as the fact; "I love winter" is taste.
  if (/^(i|we)\s+(feel|like|love|hate|prefer|enjoy|wish)\b|\bin my (opinion|view)\b|\bimo\b/i.test(t)) return "an opinion";
  if (/\b(best|worst|beautiful|ugly|tastes? (good|bad)|should|ought to|greatest|terrible|wonderful)\b/i.test(t)) return "a value judgment";
  if (/\bwill (be|become|happen|win|lose|rise|fall|crash|replace|take over|come)\b/i.test(t)) return "a prediction";
  return null;
}

/** "2 * (3 + 4) = 14" found anywhere in the text. The tolerance is half the last decimal the claim wrote. */
function equationsIn(text: string): Array<{ expression: string; claimed: number; tolerance: number }> {
  const out: Array<{ expression: string; claimed: number; tolerance: number }> = [];
  for (const m of text.matchAll(/(\(?-?\d[\d\s+\-*/^().]*)\s*=\s*(-?\d+(?:\.\d+)?)(?![\d.]*\s*[+\-*/^])/g)) {
    const expression = m[1].trim();
    if (!/[+\-*/^]/.test(expression.replace(/^-/, ""))) continue;
    const decimals = (m[2].split(".")[1] || "").length;
    out.push({ expression, claimed: Number(m[2]), tolerance: Math.max(1e-9, 0.5 * Math.pow(10, -decimals)) });
  }
  return out;
}

export class Referee {
  private readonly math: MathEngine;
  private readonly needed: number;
  private readonly timeoutMs: number;
  private readonly excluded: Set<string>;
  private readonly log: Array<{ at: number; claim: string; verdict: Verdict }> = [];
  private readonly counts = new Map<Verdict, number>();

  constructor(private readonly deps: RefereeDeps = {}) {
    this.math = deps.math ?? new MathEngine();
    this.needed = deps.needed ?? 2;
    this.timeoutMs = deps.timeoutMs ?? 8000;
    this.excluded = new Set((deps.excludeOrigins ?? []).map(originOf));
  }

  async judge(input: ReferInput): Promise<Ruling> {
    const claim = (input.claim ?? "").trim().slice(0, 2000);
    const ruling = await this.rule({ ...input, claim });
    this.log.push({ at: Date.now(), claim: claim.slice(0, 200), verdict: ruling.verdict });
    if (this.log.length > (this.deps.historySize ?? 200)) this.log.shift();
    this.counts.set(ruling.verdict, (this.counts.get(ruling.verdict) ?? 0) + 1);
    return ruling;
  }

  /** How many rulings of each kind so far, for spotting a referee that rejects everything or accepts everything. */
  stats(): Record<string, number> { return Object.fromEntries(this.counts); }
  recent(n = 20) { return this.log.slice(-n); }

  private async rule(input: ReferInput): Promise<Ruling> {
    const { claim } = input;
    const reasons: string[] = [];
    const base = { claim, findings: [] as Finding[], agreeWeight: 0, opposeWeight: 0, limits: [] as string[] };
    const done = (verdict: Verdict, confidence: number, extra: Partial<Ruling> = {}): Ruling => {
      const action: RefereeAction = verdict === "supported" ? "accept" : verdict === "contradicted" || verdict === "mistake" ? "reject" : verdict === "unverifiable" ? "ignore" : "hold";
      const reliability = verdict === "supported" ? confidence : action === "hold" ? 0.25 : 0;
      return { ...base, verdict, action, confidence: Math.min(MAX_CONFIDENCE, Math.max(0, confidence)), reliability, reasons, ...extra };
    };

    // Not a claim that can be right or wrong: say so rather than guess.
    const why = notAFactClaim(claim);
    if (why) { reasons.push(`not checkable: ${why}`); return done("unverifiable", 0.8); }

    // 1-3. Things that can be proven wrong without asking anyone.
    const calcs = [
      ...equationsIn(claim),
      ...(input.calculations ?? []).map(c => ({ ...c, tolerance: 1e-9 })),
    ];
    let verified = 0, wrong = 0;
    for (const c of calcs) {
      try {
        const v = this.math.verify(c.expression, c.claimed, (c as any).vars ?? {}, c.tolerance);
        if (v.verified) verified++;
        else { wrong++; reasons.push(`recomputed "${c.expression}" = ${+v.actual.toPrecision(12)}, claim says ${c.claimed}`); }
      } catch { /* an expression the engine cannot read is not evidence either way */ }
    }
    if (wrong) return done("mistake", 0.97);

    if (input.code?.length) {
      if (!this.deps.testCode) reasons.push("code was not tested: no sandbox runner supplied");
      else for (const code of input.code) {
        try {
          const r = await this.deps.testCode(code);
          if (!r.passed) { reasons.push(`code failed: ${r.detail}`); return done("mistake", 0.95); }
        } catch (e) { reasons.push(`code could not be tested: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }

    const sentences = claim.split(/(?<=[.!?])\s+/);
    const triples = sentences.map(s => extractTriple(s)).filter((t): t is NonNullable<typeof t> => t !== null);
    for (let i = 0; i < triples.length; i++) for (let j = i + 1; j < triples.length; j++) {
      const a = triples[i], b = triples[j];
      if (norm(a.subject) === norm(b.subject) && norm(a.object) === norm(b.object) && OPPOSITE_RELATION.get(a.relation.toLowerCase()) === b.relation.toLowerCase()) {
        reasons.push(`the claim contradicts itself: "${a.subject} ${a.relation} ${a.object}" and "${b.subject} ${b.relation} ${b.object}"`);
        return done("mistake", 0.9);
      }
    }
    if (this.deps.mistakes) {
      const lessons = this.deps.mistakes.lessons(claim);
      if (lessons.length) reasons.push(`${lessons.length} known failure pattern(s) match this kind of task (informational)`);
    }

    // A claim that is only arithmetic, and the arithmetic checked out, needs no witnesses.
    if (verified > 0 && contentTerms(claim.replace(/[\d\s+\-*/^().=]+/g, " ")).length < 3) {
      reasons.push(`recomputed ${verified} calculation(s) independently: all correct`);
      return done("supported", 0.97);
    }

    // 4-5. Evidence: outside sources, then the AI's own memory at half weight.
    const { evidence, answered } = await this.gather(claim, reasons);
    const own = input.source ? originOf(input.source) : "";
    const findings: Finding[] = [];
    const seen: Array<{ terms: string[]; stance: string }> = [];
    const trustOf = new Map<string, number>();
    // A source that answered "nothing found" is information (possibly a new idea); one that failed is not.
    let anyEvidence = answered > 0;
    const claimTerms = [...new Set(contentTerms(claim))];

    for (const ev of evidence) {
      const memory = ev.kind === "memory";
      const origin = memory ? "memory" : originOf(ev.origin);
      if (!memory && (origin === own || this.excluded.has(origin))) continue; // a claim cannot vouch for itself
      const best = this.bestSentence(claimTerms, ev.text);
      if (!best || best.relevance < MIN_RELEVANCE) { findings.push({ origin, stance: "off-topic", sentence: best?.sentence ?? "", relevance: best?.relevance ?? 0, why: "does not address the claim" }); continue; }
      const st = stanceOf(claim, best.sentence, best.relevance);
      const stance = st.opposes ? "opposes" : "agrees";
      // A mirror copies the whole passage; two independent sites merely both state the fact. So compare the
      // whole text, not the matching sentence, which is mostly the claim's own words in both.
      const terms = contentTerms(ev.text.slice(0, MAX_EVIDENCE_CHARS));
      if (seen.some(s => s.stance === stance && jaccard(s.terms, terms) >= 0.85)) continue;
      seen.push({ terms, stance });
      findings.push({ origin, stance, sentence: best.sentence, relevance: +best.relevance.toFixed(2), why: st.why });
      trustOf.set(origin, Math.max(trustOf.get(origin) ?? 0, memory ? MEMORY_WEIGHT : Math.max(0.1, Math.min(3, ev.trust ?? 1))));
    }
    for (const f of this.memoryFindings(claim)) { findings.push(f); anyEvidence = true; }

    // One vote per origin: the weight of its best-supported stance; a tie is a mixed source and says nothing.
    const votes = new Map<string, { agrees: number; opposes: number }>();
    for (const f of findings) {
      if (f.stance === "off-topic") continue;
      const v = votes.get(f.origin) ?? { agrees: 0, opposes: 0 };
      v[f.stance]++;
      votes.set(f.origin, v);
    }
    let agreeWeight = 0, opposeWeight = 0;
    for (const [origin, v] of votes) {
      const w = origin === "memory" ? MEMORY_WEIGHT : (trustOf.get(origin) ?? 1);
      if (v.agrees > v.opposes) agreeWeight += w;
      else if (v.opposes > v.agrees) opposeWeight += w;
    }
    base.findings = findings; base.agreeWeight = agreeWeight; base.opposeWeight = opposeWeight;
    if (findings.some(f => f.stance !== "off-topic")) base.limits = [LIMITS_STANCE];

    if (agreeWeight > 0 && opposeWeight > 0) {
      reasons.push(`independent evidence is split: ${agreeWeight} for, ${opposeWeight} against; a person should look`);
      return done("disputed", 0.5);
    }
    if (agreeWeight >= this.needed) {
      reasons.push(`${agreeWeight} independent vote(s) agree and none oppose`);
      return done("supported", 0.55 + 0.15 * agreeWeight);
    }
    if (opposeWeight >= this.needed) {
      reasons.push(`${opposeWeight} independent vote(s) oppose and none agree`);
      return done("contradicted", 0.55 + 0.15 * opposeWeight);
    }
    if (opposeWeight > 0) {
      reasons.push(opposeWeight <= MEMORY_WEIGHT ? "only the AI's own memory opposes it, which can be wrong too; held for a person" : "one source opposes it and nothing agrees; held for a person");
      return done("disputed", 0.4);
    }
    if (!anyEvidence) {
      reasons.push("no evidence source answered, so nothing was checked");
      return done("unchecked", 0.2);
    }
    reasons.push(agreeWeight > 0
      ? `only ${agreeWeight} of the ${this.needed} independent votes needed agree: held as a hypothesis, not a fact`
      : "nothing found agrees or opposes it: a possible new idea or an unverified one, held as a hypothesis until it is corroborated");
    return done("unconfirmed", 0.3);
  }

  private bestSentence(claimTerms: string[], text: string): { sentence: string; relevance: number } | null {
    if (claimTerms.length === 0) return null;
    let best: { sentence: string; relevance: number } | null = null;
    for (const sentence of sentencesOf(text)) {
      const have = new Set(contentTerms(sentence));
      let hit = 0;
      for (const t of claimTerms) if (have.has(t)) hit++;
      if (hit < Math.min(2, claimTerms.length)) continue;
      const relevance = hit / claimTerms.length;
      if (!best || relevance > best.relevance) best = { sentence, relevance };
    }
    return best;
  }

  private async gather(claim: string, reasons: string[]): Promise<{ evidence: Evidence[]; answered: number }> {
    const sources = this.deps.sources ?? [];
    if (!sources.length) { reasons.push("no outside evidence source is configured"); return { evidence: [], answered: 0 }; }
    let failed = 0;
    const lists = await Promise.all(sources.map(async src => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const got = await Promise.race([
          Promise.resolve(src(claim)),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), this.timeoutMs); }),
        ]);
        return (Array.isArray(got) ? got : []).filter(e => e && typeof e.text === "string" && typeof e.origin === "string").slice(0, MAX_EVIDENCE_PER_SOURCE);
      } catch { failed++; return []; } finally { if (timer) clearTimeout(timer); }
    }));
    if (failed) reasons.push(`${failed} evidence source(s) failed or timed out; silence is not agreement`);
    return { evidence: lists.flat(), answered: sources.length - failed };
  }

  /** What the AI already holds about this claim, as half-weight memory evidence. */
  private memoryFindings(claim: string): Finding[] {
    const kg = this.deps.knowledge;
    const t = extractTriple(claim);
    if (!kg || !t) return [];
    const opposite = OPPOSITE_RELATION.get(t.relation.toLowerCase());
    const out: Finding[] = [];
    const holds = (rel: string) => kg.current(t.subject, rel).find(n => norm(n.concept.name) === norm(t.object) && n.relation.confidence >= 0.5);
    if (holds(t.relation.toLowerCase())) out.push({ origin: "memory", stance: "agrees", sentence: `${t.subject} ${t.relation} ${t.object}`, relevance: 1, why: "already held" });
    if (opposite && holds(opposite)) out.push({ origin: "memory", stance: "opposes", sentence: `${t.subject} ${opposite} ${t.object}`, relevance: 1, why: "the opposite is already held" });
    return out;
  }
}

/** A bounded shelf for claims that are not yet facts: possible new ideas, disputes, anything unchecked. */
export interface HeldClaim { id: number; claim: string; verdict: Verdict; since: number; checks: number; source?: string }

export class Quarantine {
  private held: HeldClaim[] = [];
  private nextId = 1;
  constructor(private readonly cap = 200, private readonly maxAgeMs = 14 * 24 * 3600_000, private readonly maxChecks = 6) {}

  add(ruling: Ruling, source?: string): HeldClaim | null {
    if (ruling.action !== "hold") return null;
    const known = this.held.find(h => norm(h.claim) === norm(ruling.claim));
    if (known) { known.verdict = ruling.verdict; return known; }
    const h: HeldClaim = { id: this.nextId++, claim: ruling.claim, verdict: ruling.verdict, since: Date.now(), checks: 0, source };
    this.held.push(h);
    if (this.held.length > this.cap) this.held.shift();
    return h;
  }

  list(): HeldClaim[] { return [...this.held]; }
  size(): number { return this.held.length; }
  drop(id: number): void { this.held = this.held.filter(h => h.id !== id); }

  /**
   * Judge every held claim again, now that more may be known. Supported ones are released (returned, and
   * removed); rejected ones are dropped; the rest stay until they age out or have been checked too often.
   * Disputed claims never leave on their own: a person decides those.
   */
  async recheck(referee: Referee, now = Date.now()): Promise<Array<{ held: HeldClaim; ruling: Ruling }>> {
    const released: Array<{ held: HeldClaim; ruling: Ruling }> = [];
    for (const h of [...this.held]) {
      if (now - h.since > this.maxAgeMs) { this.drop(h.id); continue; }
      const ruling = await referee.judge({ claim: h.claim, source: h.source });
      h.checks++; h.verdict = ruling.verdict;
      if (ruling.action === "accept") { this.drop(h.id); released.push({ held: h, ruling }); }
      else if (ruling.action === "reject" || ruling.action === "ignore") this.drop(h.id);
      else if (h.checks >= this.maxChecks && ruling.verdict !== "disputed") this.drop(h.id);
    }
    return released;
  }
}

export interface RefereedLearn { ruling: Ruling; learned?: LearnResult; held?: HeldClaim | null }

/**
 * The gate: nothing reaches the knowledge graph on the strength of how it was worded. Supported claims are
 * learned at the reliability the evidence earned; possible new ideas and disputes go to the quarantine shelf;
 * false claims, mistakes and non-claims are not learned at all.
 */
export async function refereedLearn(
  referee: Referee, learner: AutonomousLearner, quarantine: Quarantine,
  information: string, opts: LearnOptions & { source?: string; code?: string[] } = {},
): Promise<RefereedLearn> {
  const { source, code, ...learnOpts } = opts;
  const ruling = await referee.judge({ claim: information, source, code });
  if (ruling.action === "accept") return { ruling, learned: learner.learn(information, { ...learnOpts, reliability: ruling.reliability }) };
  if (ruling.action === "hold") return { ruling, held: quarantine.add(ruling, source) };
  return { ruling };
}

/** Releases whatever the quarantine can now prove, into the learner. Run it when new sources or knowledge arrive. */
export async function releaseProven(referee: Referee, learner: AutonomousLearner, quarantine: Quarantine): Promise<Array<{ held: HeldClaim; ruling: Ruling; learned: LearnResult }>> {
  const out = [];
  for (const r of await quarantine.recheck(referee)) out.push({ ...r, learned: learner.learn(r.held.claim, { reliability: r.ruling.reliability }) });
  return out;
}
