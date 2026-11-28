/**
 * compose.js -- the "more complex things" layer of the extension builder.
 *
 * The builder (builder.js) defines each neuron and trains it. A trained neuron is a lookup: it recalls what it was
 * trained on and does not generalise (measured: 27 of 30 recalled, 1 of 40 on new questions). Complex behaviour
 * therefore comes from COMPOSITION: a skill is built out of smaller skills, and the whole is checked by running it.
 *
 *   code skill     a function (string in, string out). Exact and general, because it is code.
 *   learned skill  a neuron the builder trained, asked through builder.answer(). Refuses (returns null) when its
 *                  best answer is not clearly ahead of the runner-up, instead of guessing.
 *   composed skill an ordered list of other skills; each one's output is the next one's input. A composed skill can be
 *                  a step of another, so skills nest. A step that fails stops the chain and says where.
 *
 * Every composed skill can carry tests (input, expected). verify() RUNS them and reports; nothing is trusted because it
 * trained or because someone said so. Safety: skills must exist before a skill uses them, so a cycle cannot be written.
 *
 * Pure JS, no imports, no Node-only APIs: the visual editor loads builder files directly in the browser, so this must too.
 */

export class SkillGraph {
    /** `builder` and `projectId` are only needed for learned skills. */
    constructor({ builder = null, projectId = null } = {}) {
        this.builder = builder;
        this.projectId = projectId;
        this.skills = new Map();
    }

    #claim(name) {
        if (typeof name !== 'string' || !name) throw new Error('a skill needs a name');
        if (this.skills.has(name)) throw new Error(`skill "${name}" already exists`);
    }

    /** An executable skill. `fn` takes a string and returns a string (or null/undefined to say it cannot). */
    defineCode(name, fn, { doc = '' } = {}) {
        this.#claim(name);
        if (typeof fn !== 'function') throw new Error(`skill "${name}": fn must be a function`);
        this.skills.set(name, { kind: 'code', name, fn, doc, tests: [] });
        return this;
    }

    /** A skill answered by a trained neuron of the builder project. Refuses when the call is too close to trust. */
    defineLearned(name, { minMargin = 0.05, doc = '' } = {}) {
        this.#claim(name);
        if (!this.builder || this.projectId == null) throw new Error(`skill "${name}": a learned skill needs a builder and a projectId`);
        this.skills.set(name, { kind: 'learned', name, minMargin, doc, tests: [] });
        return this;
    }

    /** A skill made of other skills, run in order. Every step must already exist (so no cycles). */
    compose(name, steps, { doc = '' } = {}) {
        this.#claim(name);
        if (!Array.isArray(steps) || steps.length === 0) throw new Error(`skill "${name}": compose needs at least one step`);
        for (const s of steps) if (!this.skills.has(s)) throw new Error(`skill "${name}": step "${s}" is not defined yet`);
        this.skills.set(name, { kind: 'composed', name, steps: [...steps], doc, tests: [] });
        return this;
    }

    /** Attach checks to a skill: [{ input, expected }]. They are run by verify(), never assumed. */
    contract(name, tests) {
        const s = this.#get(name);
        s.tests.push(...tests.map(t => ({ input: String(t.input), expected: String(t.expected) })));
        return this;
    }

    #get(name) {
        const s = this.skills.get(name);
        if (!s) throw new Error(`no skill named "${name}"`);
        return s;
    }

    /** Run one skill. Returns { ok, output, trace, failedAt }. `trace` lists every step's input and output, nested. */
    run(name, input) {
        const s = this.#get(name);
        const text = String(input);
        if (s.kind === 'composed') {
            const trace = [];
            let cur = text;
            for (const step of s.steps) {
                const r = this.run(step, cur);
                trace.push({ step, input: cur, output: r.output, ok: r.ok, ...(r.trace.length ? { trace: r.trace } : {}) });
                if (!r.ok) return { ok: false, output: null, trace, failedAt: step };
                cur = r.output;
            }
            return { ok: true, output: cur, trace, failedAt: null };
        }
        let out;
        try {
            out = s.kind === 'code' ? s.fn(text) : this.#learned(s, text);
        } catch (e) {
            return { ok: false, output: null, trace: [], failedAt: name, error: String(e && e.message ? e.message : e) };
        }
        if (out === null || out === undefined) return { ok: false, output: null, trace: [], failedAt: name };
        return { ok: true, output: String(out), trace: [], failedAt: null };
    }

    #learned(s, text) {
        const a = this.builder.answer(this.projectId, text);
        return a && a.margin >= s.minMargin ? a.answer : null;
    }

    /** Run a skill's contract. Passing means every test produced exactly the expected output when run. */
    verify(name) {
        const s = this.#get(name);
        const failures = [];
        for (const t of s.tests) {
            const r = this.run(name, t.input);
            if (!r.ok || r.output !== t.expected) failures.push({ input: t.input, expected: t.expected, got: r.output, failedAt: r.failedAt });
        }
        return { skill: name, total: s.tests.length, passed: s.tests.length - failures.length, failures, verified: s.tests.length > 0 && failures.length === 0 };
    }

    /** Verify every skill that has tests. A project is only as trustworthy as its least-checked piece, so this also lists skills with none. */
    verifyAll() {
        const results = [], untested = [];
        for (const [name, s] of this.skills) (s.tests.length ? results.push(this.verify(name)) : untested.push(name));
        return { results, untested, allVerified: results.length > 0 && results.every(r => r.verified) };
    }

    /** The skill's structure as a tree, for the debugger and the editor. */
    describe(name) {
        const s = this.#get(name);
        return s.kind === 'composed'
            ? { name, kind: 'composed', doc: s.doc, steps: s.steps.map(x => this.describe(x)) }
            : { name, kind: s.kind, doc: s.doc };
    }
}
