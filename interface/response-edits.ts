/**
 * Edits to a reply zip: define later, use the definitions first, then review every edit until none are left.
 *
 * Three parts, all pure (no tool, no file, no mesh):
 *
 *   DEFINITIONS. The AI may write `{{name}}` in a reply and define `name` later (response/definitions.json). Before anything
 *   else happens to the text, every `{{name}}` is replaced by its definition. A definition may use other definitions;
 *   a loop, a missing name or a chain that is too deep is reported and the marker is left in the text as it was.
 *
 *   EDITS. An edit says: in this file, replace this exact text with that. It starts `pending`. Nothing is changed in the
 *   zip until a reviewer, a different agent from the one that wrote the edit, has read it and approved it. The edit's
 *   `find` must match exactly once, or it cannot be applied and is sent back.
 *
 *   THE LOOP. An edit that is not approved is not dropped: it goes back to the author with the reviewer's comments to
 *   be rewritten, then to the reviewer again, round after round, until no edit is left unapproved (or the author
 *   withdraws it). If the rounds run out first the result says `done: false` and keeps the edits that are still open;
 *   it never reports success it did not reach.
 */

export type EditStatus = "pending" | "approved" | "rejected";

export interface EditComment {
  by: "reviewer" | "author" | "system";
  text: string;
}

export interface Edit {
  id: string;
  /** The file inside the zip the edit is for, e.g. `response/reply.md`. */
  file: string;
  /** Exact text to replace. Must occur exactly once in the file at the time the edit is applied. */
  find: string;
  replace: string;
  note?: string;
  status: EditStatus;
  comments: EditComment[];
}

export const MAX_EDITS = 200;
export const MAX_DEFINITIONS = 200;
export const MAX_FIELD = 100_000;
export const MAX_COMMENTS_PER_EDIT = 50;
const MAX_DEPTH = 10;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MARKER_RE = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (s: string, n = MAX_FIELD): string => (s.length > n ? s.slice(0, n) : s);

/** Definitions rebuilt from untrusted input: valid names, string values only. */
export function normalizeDefinitions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!isObj(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_DEFINITIONS) break;
    if (NAME_RE.test(k) && typeof v === "string") { out[k] = clip(v); n++; }
  }
  return out;
}

export interface Resolved {
  text: string;
  /** Names used but never defined. */
  missing: string[];
  /** Names that lead back to themselves. */
  loops: string[];
}

/** Put each `{{name}}` back as its definition, definitions inside definitions included. */
export function resolveDefinitions(text: string, defs: Record<string, string>): Resolved {
  const missing = new Set<string>();
  const loops = new Set<string>();
  const expand = (s: string, stack: string[]): string =>
    s.replace(MARKER_RE, (whole, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(defs, name)) { missing.add(name); return whole; }
      if (stack.includes(name)) { loops.add(name); return whole; }
      if (stack.length >= MAX_DEPTH) { loops.add(name); return whole; }
      return expand(defs[name], [...stack, name]);
    });
  return { text: expand(text, []), missing: [...missing].sort(), loops: [...loops].sort() };
}

/** Edits rebuilt field by field. Anything that is not an edit is dropped; the status of an incoming edit is trusted only as far as the three known words. */
export function normalizeEdits(raw: unknown): Edit[] {
  if (!Array.isArray(raw)) return [];
  const out: Edit[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_EDITS) break;
    if (!isObj(r) || typeof r.id !== "string" || !ID_RE.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.file !== "string" || typeof r.find !== "string" || typeof r.replace !== "string" || !r.find) continue;
    seen.add(r.id);
    const status: EditStatus = r.status === "approved" || r.status === "rejected" ? r.status : "pending";
    const comments: EditComment[] = [];
    if (Array.isArray(r.comments)) {
      for (const c of r.comments) {
        if (comments.length >= MAX_COMMENTS_PER_EDIT) break;
        if (isObj(c) && typeof c.text === "string") comments.push({ by: c.by === "author" || c.by === "system" ? c.by : "reviewer", text: clip(c.text, 2000) });
      }
    }
    const edit: Edit = { id: r.id, file: clip(r.file, 200), find: clip(r.find), replace: clip(r.replace), status, comments };
    if (typeof r.note === "string" && r.note) edit.note = clip(r.note, 2000);
    out.push(edit);
  }
  return out;
}

/** Edits that are not approved yet: waiting for a reviewer, or sent back for a rewrite. When this is empty the zip has no edits left. */
export const open = (edits: Edit[]): Edit[] => edits.filter(e => e.status !== "approved");
export const isSettled = (edits: Edit[]): boolean => open(edits).length === 0;

const replaceOnce = (text: string, find: string, replace: string): string | null => {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) return null;
  return text.slice(0, at) + replace + text.slice(at + find.length);
};

/** Why an edit cannot be applied to `text` right now, or null if it can. */
export function whyNot(text: string | undefined, edit: Edit): string | null {
  if (text === undefined) return `There is no file ${edit.file} in the zip.`;
  const at = text.indexOf(edit.find);
  if (at < 0) return "The text to replace is not in the file (it may have been changed by an earlier edit).";
  if (text.indexOf(edit.find, at + 1) >= 0) return "The text to replace appears more than once; quote more of it so it matches one place.";
  return null;
}

export interface Settled {
  files: Map<string, string>;
  edits: Edit[];
}

/**
 * Apply the approved edits to the files, in order, to the files `inScope` accepts.
 * An approved edit that no longer fits is not applied and goes back to `rejected` with the reason, so it is sent back
 * instead of quietly lost. Edits that are pending or rejected change nothing.
 */
export function applyApproved(files: Map<string, string>, edits: Edit[], inScope: (file: string) => boolean = () => true): Settled {
  const out = new Map(files);
  const next = edits.map(e => ({ ...e, comments: [...e.comments] }));
  for (const e of next) {
    if (e.status !== "approved" || !inScope(e.file)) continue;
    const why = whyNot(out.get(e.file), e);
    const result = why ? null : replaceOnce(out.get(e.file)!, e.find, e.replace);
    if (result === null) {
      e.status = "rejected";
      e.comments.push({ by: "system", text: why ?? "The edit could not be applied." });
    } else out.set(e.file, result);
  }
  return { files: out, edits: next };
}

const find = (edits: Edit[], id: string): Edit => {
  const e = edits.find(x => x.id === id);
  if (!e) throw new Error(`No edit ${id}.`);
  return e;
};

/** The reviewer's decision on one pending edit. Approving needs the edit to fit the file as it is now (pass `current`). */
export function decide(edits: Edit[], id: string, approve: boolean, comment = "", current?: string): Edit[] {
  const target = find(edits, id);
  if (target.status === "approved") return edits;
  const blocked = approve ? whyNot(current, target) : null;
  return edits.map(e => {
    if (e.id !== id) return e;
    const comments = [...e.comments];
    if (comment) comments.push({ by: "reviewer", text: clip(comment, 2000) });
    if (blocked) { comments.push({ by: "system", text: blocked }); return { ...e, status: "rejected" as const, comments }; }
    return { ...e, status: approve ? ("approved" as const) : ("rejected" as const), comments };
  });
}

export interface Revision {
  find?: string;
  replace?: string;
  note?: string;
  comment?: string;
}

/** The author rewrites a rejected edit; it goes back to pending for the reviewer. Only a rejected edit can be revised. */
export function revise(edits: Edit[], id: string, patch: Revision): Edit[] {
  const target = find(edits, id);
  if (target.status !== "rejected") throw new Error(`Edit ${id} is ${target.status}; only a rejected edit is rewritten.`);
  if (patch.find !== undefined && !patch.find) throw new Error("An edit's find text cannot be empty.");
  return edits.map(e => {
    if (e.id !== id) return e;
    const comments = [...e.comments];
    if (patch.comment) comments.push({ by: "author", text: clip(patch.comment, 2000) });
    const next: Edit = {
      ...e,
      find: patch.find !== undefined ? clip(patch.find) : e.find,
      replace: patch.replace !== undefined ? clip(patch.replace) : e.replace,
      status: "pending",
      comments,
    };
    if (patch.note !== undefined) next.note = clip(patch.note, 2000);
    return next;
  });
}

/** Take a rejected edit out for good: the author gives up on it. */
export function withdraw(edits: Edit[], id: string): Edit[] {
  find(edits, id);
  return edits.filter(e => e.id !== id);
}

export interface ReviewLoopOptions {
  files: Map<string, string>;
  edits: Edit[];
  /** The separate agent that reads the zip. Gets the edit and the file as it stands now; says yes or no, with a reason. */
  reviewer(edit: Edit, current: string | undefined): Promise<{ approve: boolean; comment?: string }> | { approve: boolean; comment?: string };
  /** The agent that wrote the edits. Gets a rejected edit with its comments; returns a rewrite, or null to give up on it. */
  author(edit: Edit, current: string | undefined): Promise<Revision | null> | Revision | null;
  /** Most rounds before it stops and says it is not done. Default 8. */
  maxRounds?: number;
}

export interface ReviewLoopResult {
  /** True only when no edit is left unapproved. */
  done: boolean;
  rounds: number;
  files: Map<string, string>;
  edits: Edit[];
}

/**
 * Keep going until no edits are left: the reviewer decides every pending edit, the author rewrites (or withdraws) every
 * rejected one, then the approved edits are applied, and again. An edit is only ever applied after the reviewer
 * approved it.
 */
export async function runReviewLoop(opts: ReviewLoopOptions): Promise<ReviewLoopResult> {
  const maxRounds = Math.max(1, Math.floor(opts.maxRounds ?? 8));
  let edits = opts.edits.map(e => ({ ...e, comments: [...e.comments] }));
  const files = new Map(opts.files);
  let rounds = 0;
  while (!isSettled(edits) && rounds < maxRounds) {
    rounds++;
    for (const e of edits.filter(x => x.status === "rejected")) {
      const patch = await opts.author(e, files.get(e.file));
      edits = patch ? revise(edits, e.id, patch) : withdraw(edits, e.id);
    }
    for (const e of edits.filter(x => x.status === "pending")) {
      const verdict = await opts.reviewer(e, files.get(e.file));
      edits = decide(edits, e.id, verdict.approve === true, verdict.comment ?? "", files.get(e.file));
      // An approved edit is applied at once (decide() already checked it fits), so the next edit is judged against
      // the text it will really meet.
      if (find(edits, e.id).status === "approved") {
        const text = files.get(e.file);
        const result = text === undefined ? null : replaceOnce(text, e.find, e.replace);
        if (result !== null) files.set(e.file, result);
      }
    }
  }
  return { done: isSettled(edits), rounds, files, edits };
}
