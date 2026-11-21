/**
 * Draft, then fill: write a long thing in two stages.
 *
 *   1. The main AI writes only the OUTLINE: a title for each piece, and for each
 *      piece which hive mind should write it:
 *
 *          # Why cities should plant more trees
 *          ## Introduction
 *          /hivemind writer
 *          hook the reader and state the claim
 *          ## The evidence
 *          /hivemind researcher
 *          /subagent
 *          ## Counter-arguments
 *          /hivemind team critics
 *
 *      `/hivemind <name>` picks who writes that piece (any hive agent by role or
 *      id, or a brand-new one by that name; `/hivemind team <name>` summons a
 *      whole sub-team). Swapping a piece to a different hive is changing that
 *      one word. `/subagent` marks the piece as ready to hand off; a piece with a
 *      `/hivemind` line is handed off either way, and a piece with neither goes
 *      to the default hive.
 *   2. Each sub-agent fills in just its own piece (several at once), seeing the
 *      whole outline so the pieces fit together.
 *   3. The main AI then reads the assembled draft and answers one of:
 *          OK                       -> send it to the user as it is
 *          REDO 2: <note>           -> piece 2 goes back to its sub-agent with the note
 *          REWRITE 2: <new text>    -> the main AI edits piece 2 itself
 *      After any change it reads the draft again. It stops at `OK`, or after
 *      `maxRounds` reads, and the result says which of those happened.
 *
 * Nothing here knows how to think or what a hive is: the callbacks in
 * `DraftDeps` do that (in the live system they are the real runner and the real
 * HiveMind; in tests they are stubs). No imports, no third-party code.
 */

export interface HiveRef {
  /** Role or id of an existing hive agent, or the name to summon a new one under. */
  name: string;
  /** True for `/hivemind team <name>`: a whole sub-team, not one agent. */
  team: boolean;
}

export interface DraftSection {
  /** 1-based, the number the reviewer uses in REDO / REWRITE. */
  index: number;
  title: string;
  /** What this piece should cover, in the main AI's own words. May be empty. */
  brief: string;
  hive: HiveRef | null;
  text: string;
  /** Who actually wrote the current text: a hive agent id, or "main" after a REWRITE. */
  writtenBy: string;
  /** How many times it was redone or rewritten after the first fill. */
  revisions: number;
  /** Set when the piece could not be written; `text` then holds a visible placeholder. */
  error?: string;
}

export interface Outline {
  title: string;
  sections: DraftSection[];
  /** True when the outline text had no usable sections and a generic one was used instead. */
  usedFallback: boolean;
}

export interface FillContext {
  documentTitle: string;
  /** Every section title in order, so a piece knows what its neighbours cover. */
  outlineTitles: string[];
  /** Extra instruction when this is a REDO, otherwise undefined. */
  note?: string;
  /** The piece's earlier text on a REDO, otherwise undefined. */
  previousText?: string;
}

export interface DraftDeps {
  /** The main AI: used to write the outline and to review. */
  think(prompt: string): Promise<string>;
  /** A sub-agent from the hive writes one piece. Returns the text and who wrote it. */
  fill(section: DraftSection, hive: HiveRef, ctx: FillContext): Promise<{ text: string; by: string }>;
  /** Optional progress lines ("outline ready", "piece 2 written", ...). */
  onProgress?(line: string): void;
}

export interface DraftOptions {
  /** Hive used for a piece that names none. Default "writer". */
  defaultHive?: string;
  /** How many times the main AI may read the draft. Default 3. */
  maxRounds?: number;
  /** Pieces filled at the same time. Default 3. */
  concurrency?: number;
  /** A ready-made outline (e.g. typed by the user). Skips the main AI's outline step. */
  outline?: string;
}

export interface DraftResult {
  title: string;
  /** The finished document as markdown: the title, then each piece under its heading. */
  markdown: string;
  sections: DraftSection[];
  /** "approved": the main AI said OK. "max-rounds": it was still asking for changes when it ran out of reads. */
  status: "approved" | "max-rounds";
  rounds: number;
  /** Titles of pieces that could not be written (their text is a visible placeholder). */
  failed: string[];
  usedFallbackOutline: boolean;
  /** One line per step, for showing the user how it was made. */
  trace: string[];
}

const GENERIC_SECTIONS = ["Introduction", "Main points", "Conclusion"];

const HIVEMIND_RE = /\/hive\s?mind\b[ \t]*(team\b)?[ \t]*([^\n/]*)/i;
const SUBAGENT_RE = /\/sub[-\s]?agent\b/i;

/** The outline prompt the main AI sees. Exported so the exact wording can be checked. */
export function outlinePrompt(topic: string): string {
  return (
    `Write the OUTLINE ONLY for: ${topic}\n` +
    `Do not write the content itself. Use exactly this shape:\n` +
    `# <document title>\n` +
    `## <piece title>\n` +
    `/hivemind <role that should write it, e.g. writer, researcher, critic>\n` +
    `<one line saying what the piece must cover>\n` +
    `Repeat the ## block for every piece, in order.`
  );
}

/**
 * Read an outline. Forgiving on purpose, because the outline comes from a model:
 * headings (`#`..`######`), or numbered / bulleted lines when there are no headings.
 * A lone first `#` heading is the document title. Everything between two headings is
 * that piece's brief, except the `/hivemind` and `/subagent` marker lines.
 */
export function parseOutline(raw: string, fallbackTitle = "Draft"): Outline {
  const lines = raw.replace(/\r/g, "").split("\n");
  type Head = { level: number; title: string };
  const headingOf = (line: string): Head | null => {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    return m ? { level: m[1].length, title: m[2] } : null;
  };
  const hasHeadings = lines.some(l => headingOf(l));
  const listOf = (line: string): string | null => {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/);
    return m ? m[1] : null;
  };

  let title = fallbackTitle;
  let titleTaken = false;
  const blocks: Array<{ title: string; body: string[] }> = [];
  let docTitleLevel = 0;
  if (hasHeadings) {
    const heads = lines.map(headingOf).filter((h): h is Head => !!h);
    // A single level-1 heading in front of deeper ones is the title, not a piece.
    if (heads[0].level === 1 && heads.length > 1 && heads.slice(1).every(h => h.level > 1)) docTitleLevel = 1;
  }

  for (const line of lines) {
    const head = hasHeadings ? headingOf(line) : null;
    const item = !hasHeadings ? listOf(line) : null;
    if (head) {
      if (docTitleLevel && head.level === docTitleLevel && !titleTaken) {
        title = stripMarkers(head.title) || fallbackTitle;
        titleTaken = true;
        continue;
      }
      blocks.push({ title: head.title, body: [] });
    } else if (item !== null && !HIVEMIND_RE.test(line) && !SUBAGENT_RE.test(line)) {
      blocks.push({ title: item, body: [] });
    } else if (blocks.length) {
      blocks[blocks.length - 1].body.push(line);
    }
  }

  const sections: DraftSection[] = [];
  for (const b of blocks) {
    // Markers may sit on the heading line itself ("## Evidence /hivemind researcher") or on their own lines.
    const joined = [b.title, ...b.body].join("\n");
    const hm = joined.match(HIVEMIND_RE);
    let hive: HiveRef | null = null;
    if (hm) {
      const name = hm[2].trim().replace(/[.,;:]+$/, "");
      if (name) hive = { name, team: !!hm[1] };
    }
    const cleanTitle = stripMarkers(b.title);
    if (!cleanTitle) continue;
    const brief = b.body
      .map(stripMarkers)
      .filter(l => l.trim())
      .join(" ")
      .trim();
    sections.push({ index: 0, title: cleanTitle, brief, hive, text: "", writtenBy: "", revisions: 0 });
  }

  let usedFallback = false;
  if (!sections.length) {
    usedFallback = true;
    for (const t of GENERIC_SECTIONS) sections.push({ index: 0, title: t, brief: "", hive: null, text: "", writtenBy: "", revisions: 0 });
  }
  sections.forEach((s, i) => (s.index = i + 1));
  return { title, sections, usedFallback };
}

function stripMarkers(s: string): string {
  return s
    .replace(new RegExp(HIVEMIND_RE.source, "gi"), "")
    .replace(new RegExp(SUBAGENT_RE.source, "gi"), "")
    .trim();
}

/** What the main AI said after reading the draft. */
export type ReviewVerdict =
  | { kind: "ok" }
  | { kind: "changes"; redo: Array<{ index: number; note: string }>; rewrite: Array<{ index: number; text: string }> };

/**
 * Read the main AI's review. `REDO n: note` and `REWRITE n: text` (the text may run on
 * over several lines until the next directive). Any directive wins over a stray "OK".
 * An answer with no directive counts as OK. If it did not actually say so, `understood`
 * is false: looping on an unreadable answer would never end, so the caller treats it as
 * OK and records that in the trace.
 */
export function parseReview(raw: string, sectionCount: number): { verdict: ReviewVerdict; understood: boolean } {
  const redo: Array<{ index: number; note: string }> = [];
  const rewrite: Array<{ index: number; text: string }> = [];
  let current: { kind: "redo" | "rewrite"; index: number; parts: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.parts.join("\n").trim();
    if (current.kind === "redo") redo.push({ index: current.index, note: text });
    else if (text) rewrite.push({ index: current.index, text });
    current = null;
  };
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^\s*(REDO|REWRITE)\s+#?(\d+)\s*[:\-]?\s*(.*)$/i);
    if (m) {
      flush();
      const index = Number(m[2]);
      if (index >= 1 && index <= sectionCount) current = { kind: m[1].toLowerCase() as "redo" | "rewrite", index, parts: [m[3]] };
      continue;
    }
    if (current) current.parts.push(line);
  }
  flush();
  if (redo.length || rewrite.length) return { verdict: { kind: "changes", redo, rewrite }, understood: true };
  const understood = /^\s*(ok|okay|approved?|good|looks good|lgtm|yes)\b/i.test(raw);
  return { verdict: { kind: "ok" }, understood };
}

function reviewPrompt(title: string, sections: DraftSection[]): string {
  const body = sections.map(s => `[${s.index}] ## ${s.title}\n${s.text}`).join("\n\n");
  return (
    `You are the editor. Read this draft titled "${title}".\n` +
    `Answer with exactly one of:\n` +
    `OK\n` +
    `or, one per line, any of:\n` +
    `REDO <piece number>: <what the sub-agent should fix>\n` +
    `REWRITE <piece number>: <the replacement text, written by you>\n\n` +
    body
  );
}

/** A sub-agent sometimes repeats the heading it was given; drop it so the piece does not show it twice. */
function stripLeadingHeading(text: string, title: string): string {
  const lines = text.replace(/\r/g, "").trim().split("\n");
  const first = lines[0]?.replace(/^#{1,6}\s*/, "").replace(/[*_`]/g, "").trim().toLowerCase();
  if (first && first === title.trim().toLowerCase() && lines.length > 1) return lines.slice(1).join("\n").trim();
  return lines.join("\n").trim();
}

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(runners);
}

export function assemble(title: string, sections: DraftSection[]): string {
  return `# ${title}\n\n` + sections.map(s => `## ${s.title}\n\n${s.text}`).join("\n\n") + "\n";
}

export async function draftDocument(topic: string, deps: DraftDeps, opts: DraftOptions = {}): Promise<DraftResult> {
  const defaultHive = opts.defaultHive?.trim() || "writer";
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const trace: string[] = [];
  const say = (line: string) => {
    trace.push(line);
    deps.onProgress?.(line);
  };

  // 1. Outline.
  let rawOutline = opts.outline;
  if (rawOutline === undefined) {
    rawOutline = await deps.think(outlinePrompt(topic));
    say("main AI wrote the outline");
  } else {
    say("using the outline you gave");
  }
  const outline = parseOutline(rawOutline, topic.trim().slice(0, 80) || "Draft");
  if (outline.usedFallback) say("the outline had no readable pieces, so a generic three-piece outline was used");
  const { title, sections } = outline;
  const outlineTitles = sections.map(s => s.title);
  say(`${sections.length} pieces: ${outlineTitles.join(" | ")}`);

  // 2. Fill each piece through its hive.
  const failed = new Set<number>();
  const fillOne = async (section: DraftSection, note?: string) => {
    const hive = section.hive ?? { name: defaultHive, team: false };
    try {
      const out = await deps.fill(section, hive, { documentTitle: title, outlineTitles, note, previousText: note ? section.text : undefined });
      const text = stripLeadingHeading(out.text ?? "", section.title);
      if (!text) throw new Error("the sub-agent returned nothing");
      section.text = text;
      section.writtenBy = out.by;
      section.error = undefined;
      failed.delete(section.index);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      section.error = reason;
      failed.add(section.index);
      if (!section.text) section.text = `[This piece could not be written: ${reason}]`;
    }
  };
  await mapLimit(sections, concurrency, async s => {
    await fillOne(s);
    say(`piece ${s.index} "${s.title}" ${s.error ? "FAILED: " + s.error : "written by " + s.writtenBy}`);
  });

  // 3. The main AI reads it, and changes it, until it says OK or runs out of reads.
  let status: DraftResult["status"] = "max-rounds";
  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;
    const reply = await deps.think(reviewPrompt(title, sections));
    const { verdict, understood } = parseReview(reply, sections.length);
    if (verdict.kind === "ok") {
      say(understood ? `read ${rounds}: main AI said OK` : `read ${rounds}: main AI's answer was not a clear OK or a change request; treated as OK`);
      status = "approved";
      break;
    }
    for (const r of verdict.rewrite) {
      const s = sections[r.index - 1];
      s.text = r.text;
      s.writtenBy = "main";
      s.revisions++;
      s.error = undefined;
      failed.delete(s.index);
      say(`read ${rounds}: main AI rewrote piece ${s.index}`);
    }
    // A piece the main AI rewrote itself is not also sent back to a sub-agent.
    const rewritten = new Set(verdict.rewrite.map(r => r.index));
    const redo = verdict.redo.filter(r => !rewritten.has(r.index));
    await mapLimit(redo, concurrency, async r => {
      const s = sections[r.index - 1];
      await fillOne(s, r.note || "improve this piece");
      s.revisions++;
      say(`read ${rounds}: piece ${s.index} sent back to its sub-agent${s.error ? " and FAILED again: " + s.error : ""}`);
    });
    if (rounds >= maxRounds) say(`stopped after ${maxRounds} reads; the main AI was still asking for changes`);
  }

  return {
    title,
    markdown: assemble(title, sections),
    sections,
    status,
    rounds,
    failed: [...failed].sort((a, b) => a - b).map(i => sections[i - 1].title),
    usedFallbackOutline: outline.usedFallback,
    trace,
  };
}
