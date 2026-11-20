/**
 * What the Self-improvement page (interface/platform/self-improvement-page.ts) shows, worked out from the
 * three ledgers that are already being written on this machine. Nothing here invents a number: a ledger that
 * does not exist yet gives zeros and empty lists, and the page says so.
 *
 *   scoreboard   extension-builder/self-improvement-scoreboard.json   scripts/self-improve.mjs
 *   drills       extension-builder/skill-quality-history.json         scripts/skill-drill-agent.mjs
 *   attempts     extension-builder/skill-mesh-history.jsonl           src/lib/skill-mesh-metrics.ts
 */

export interface Ledgers {
  scoreboard: { targets?: Record<string, { bestScore?: number; history?: unknown[] }> };
  drills: { skills?: Record<string, { history?: unknown[] }> };
  attempts: Array<{ at: number; matched: boolean; similarity: number; matchedSkill?: string }>;
}

export type SelfImprovementTab = 'overview' | 'skills' | 'reasoning' | 'history';

interface Drill { at?: string; topic?: string; ok?: boolean; improved?: boolean; accuracyBefore?: number; accuracyAfter?: number; error?: string }
interface Experiment { at?: string; ok?: boolean; error?: string }

const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function drillsBySkill(l: Ledgers): Array<{ slug: string; runs: Drill[] }> {
  return Object.entries(l.drills.skills ?? {}).map(([slug, v]) => ({ slug, runs: asList<Drill>(v?.history) }));
}

export function selfImprovementTab(tab: SelfImprovementTab, l: Ledgers): unknown {
  const drills = drillsBySkill(l);
  const allDrills = drills.flatMap(d => d.runs);
  const finished = allDrills.filter(d => d.ok);
  const improved = finished.filter(d => d.improved);
  const matched = l.attempts.filter(a => a.matched);

  if (tab === 'overview') {
    const targets = Object.entries(l.scoreboard.targets ?? {});
    const experiments = targets.flatMap(([, t]) => asList<Experiment>(t?.history));
    return {
      directAnswers: { attempts: l.attempts.length, matched: matched.length, ratePercent: rate(matched.length, l.attempts.length) },
      drills: { total: allDrills.length, finished: finished.length, improved: improved.length, skillsDrilled: drills.filter(d => d.runs.length > 0).length },
      experiments: { targets: targets.length, attempts: experiments.length, sandboxFailures: experiments.filter(e => e.ok === false).length },
    };
  }

  if (tab === 'skills') {
    return drills
      .filter(d => d.runs.length > 0)
      .map(({ slug, runs }) => {
        const done = runs.filter(r => r.ok);
        const last = done[done.length - 1];
        const before = num(last?.accuracyBefore);
        const after = num(last?.accuracyAfter);
        return {
          name: slug,
          drills: runs.length,
          improvedDrills: done.filter(r => r.improved).length,
          lastBefore: before === null ? null : Math.round(before * 1000) / 10,
          lastAfter: after === null ? null : Math.round(after * 1000) / 10,
        };
      })
      .sort((a, b) => b.improvedDrills - a.improvedDrills || b.drills - a.drills);
  }

  if (tab === 'reasoning') {
    const bySkill = new Map<string, number>();
    for (const a of matched) if (a.matchedSkill) bySkill.set(a.matchedSkill, (bySkill.get(a.matchedSkill) ?? 0) + 1);
    const sims = l.attempts.map(a => a.similarity).filter(s => Number.isFinite(s));
    const recent = l.attempts.slice(-100);
    return {
      attempts: l.attempts.length,
      matched: matched.length,
      ratePercent: rate(matched.length, l.attempts.length),
      recentRatePercent: rate(recent.filter(a => a.matched).length, recent.length),
      recentCount: recent.length,
      averageSimilarity: sims.length ? Math.round((sims.reduce((s, x) => s + x, 0) / sims.length) * 1000) / 1000 : null,
      topSkills: [...bySkill.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    };
  }

  // history: every drill and experiment attempt, newest first.
  const events: Array<{ at: string; kind: 'drill' | 'experiment'; label: string; detail: string }> = [];
  for (const { slug, runs } of drills) {
    for (const r of runs) {
      if (!r.at) continue;
      const before = num(r.accuracyBefore);
      const after = num(r.accuracyAfter);
      const detail = !r.ok
        ? `failed${r.error ? `: ${r.error}` : ''}`
        : `${r.improved ? 'improved' : 'no gain'}${before !== null && after !== null ? `, ${Math.round(before * 1000) / 10}% to ${Math.round(after * 1000) / 10}%` : ''}`;
      events.push({ at: r.at, kind: 'drill', label: r.topic || slug, detail });
    }
  }
  for (const [target, t] of Object.entries(l.scoreboard.targets ?? {})) {
    for (const e of asList<Experiment>(t?.history)) {
      if (!e.at) continue;
      events.push({ at: e.at, kind: 'experiment', label: target, detail: e.ok ? 'sandbox run passed' : `sandbox run failed${e.error ? `: ${e.error}` : ''}` });
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
}

export function isSelfImprovementTab(v: string | null): v is SelfImprovementTab {
  return v === 'overview' || v === 'skills' || v === 'reasoning' || v === 'history';
}
