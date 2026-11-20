/**
 * Code mode: tell a coding message from any other, say what kind of coding job it is, and say how hard it looks.
 *
 * Four jobs, the same four the chat is asked to do every day:
 *   write      make code: a function, a script, a query, a test, a refactor
 *   explain    say what code does or how something works
 *   debug      find out why something fails, from an error, a stack trace or "it does not work"
 *   technical  everything else that is engineering rather than typing: complexity, design, performance, review
 *
 * And two levels of difficulty, because the cost of a hard debugging session is not the cost of "how do I reverse
 * a list". A hard job gets more of the dial (core/effort.ts: more checks, and at the top a second way tried and
 * compared); a plain one is held at a steady setting so it does not spend what it does not need. Auto route
 * (core/auto-route.ts) calls `adjustEffortForCode` after its own estimate; a dial set by hand, or instant, always wins.
 *
 * Be plain about what this is. It is not a language model and does not read the message for meaning: it counts and
 * matches patterns, the same way auto-route's effort estimate does, and it shows every reason so a surprising choice
 * can be argued with. It does not change which engine answers (engine-chooser.ts still decides that, and borrowing
 * another computer is still off unless the owner turned it on). Nothing here is sent anywhere or imported from
 * anywhere; the messages never leave this process.
 *
 * Wrong in both directions is possible, and the order of the rules below is what settles a tie:
 * an error or stack trace means debug (even when the person says "explain"), then a debugging word, then explain,
 * then write, then technical.
 */

export type CodeTask = "write" | "explain" | "debug" | "technical";
export type CodeDifficulty = "simple" | "complex";

export interface CodeIntent {
  task: CodeTask;
  difficulty: CodeDifficulty;
  /** 0 for a plain job, rising by one for each thing that makes it harder. Complex starts at 2. */
  score: number;
  /** The language the message names or shows, or null when it does not say. */
  language: string | null;
  hasCode: boolean;
  hasTrace: boolean;
  /** Why it was read this way, in plain words, for the details panel. */
  reasons: string[];
}

/* ---------------------------------------------------------------- patterns */

const FENCE = /```([A-Za-z0-9+#_-]*)/;
/** A line that looks like source: a declaration, an import, an arrow, a block opener or closer, a statement end. */
const CODE_LINE = /^\s*(?:(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|interface|struct|impl|import|from\s+\S+\s+import|const|let|var|public|private|#include|using)\b|.*(?:=>|[{};]\s*$|\)\s*:\s*$))/;

/** Frames of a stack trace, either style: "    at name (file:1:2)" and 'File "x.py", line 3'. */
const JS_FRAME = /^\s+at\s+\S.*:\d+(?::\d+)?\)?\s*$/gm;
const PY_FRAME = /^\s*File ".*", line \d+/gm;
const TRACE = /Traceback \(most recent call last\)|segmentation fault|\bpanic:|exit (?:code|status) [1-9]\d*|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ValueError|KeyError|IndexError|AttributeError|ImportError|ModuleNotFoundError|NullPointerException|ClassNotFoundException|StackOverflowError|OutOfMemoryError)\b|\bcannot read propert|\bundefined is not\b|\bENOENT\b|\bEADDRINUSE\b/i;

const LANGS: Array<[string, RegExp]> = [
  ["typescript", /\btypescript\b|\.tsx?\b|```(?:ts|tsx|typescript)\b/i],
  ["javascript", /\bjavascript\b|\bnode\.?js\b|\bnpm\b|\.(?:jsx?|mjs|cjs)\b|```(?:js|jsx|javascript)\b/i],
  ["python", /\bpython\d?\b|\.py\b|```(?:py|python)\b|Traceback \(most recent call last\)/i],
  ["rust", /\brust\b|\.rs\b|```rust\b|\bcargo\b|\brustc\b/i],
  ["go", /\bgolang\b|\.go\b|```go\b|\bgoroutines?\b/i],
  ["java", /\bjava\b(?!script)|\.java\b|```java\b|\bNullPointerException\b/i],
  ["c++", /c\+\+|\.(?:cpp|hpp|cc)\b|```(?:cpp|c\+\+)\b/i],
  ["c#", /(?:^|[^\w])c#|\bcsharp\b|\.cs\b|```(?:cs|csharp)\b/i],
  ["c", /```c\b|\.c\b(?!\+)|\.h\b|\bsegfault\b|\bsegmentation fault\b/i],
  ["ruby", /\bruby\b|\.rb\b|```(?:rb|ruby)\b/i],
  ["php", /\bphp\b|```php\b/i],
  ["swift", /\bswift(?:ui)?\b|```swift\b/i],
  ["kotlin", /\bkotlin\b|\.kt\b|```(?:kt|kotlin)\b/i],
  ["sql", /\bsql\b|```sql\b|\bpostgres(?:ql)?\b|\bsqlite\b|\bmysql\b/i],
  ["bash", /\bbash\b|\bshell script\b|```(?:sh|bash|shell)\b/i],
  ["html/css", /\bhtml\b|\bcss\b|```(?:html|css)\b/i],
];

/** Words that say the message is about software. At least one of these (or code, a trace or a language) is needed. */
const CODE_NOUN = /\b(code|codebase|source code|function|method|script|program|api|endpoint|query|regex|regular expression|component|module|library|compiler|parser|algorithm|unit tests?|test suite|cli|repo|repository|commit|bug|variable|loop|array|database|schema|server|dockerfile|json|yaml|webhook|framework|runtime)\b/i;
const TECH_TERM = /\b(big[- ]?o|time complexity|space complexity|algorithms?|data structures?|design patterns?|architecture|microservices?|concurren(?:cy|t)|thread[- ]safe|race conditions?|deadlocks?|memory leaks?|latency|throughput|benchmarks?|profil(?:e|ing)|cache invalidation|database index(?:es)?|shard(?:s|ing)?|replica(?:s|tion)?|idempoten\w+|api design|rest api|graphql|oauth|ci\/cd|kubernetes|docker|sql injection|xss|csrf|vulnerabilit(?:y|ies)|code review)\b/i;

/** Some sign that a question or request is being put, so a software word on its own ("my favourite word is algorithm") is not read as a job. */
const ASK = /\?|\b(?:should|compare|versus|vs|which|recommend|review|design|choose|trade-?offs?|best way|pros and cons|how|what|why|can you|could you|help)\b/i;
const DEBUG = /\b(debug(?:ging)?|bugs?|buggy|fix(?:es|ing)?|broken|errors?|exceptions?|crash(?:es|ed|ing)?|fail(?:s|ed|ing|ure|ures)?|doesn'?t work|isn'?t working|not working|won'?t (?:compile|run|build|start)|stack ?trace|traceback|regression|hangs?|freez(?:es|ing)|wrong (?:output|result|answer)|unexpected(?:ly)?|why (?:is|does|do|am|isn'?t|doesn'?t|won'?t|can'?t))\b/i;
const EXPLAIN = /\b(explain|what (?:is|does|do)|what'?s|walk me through|how does|how do(?:es)? .{0,40} work|break (?:this|it) down|describe|help me understand|understand|eli5|annotate)\b/i;
const WRITE = /\b(write|implement|create|generate|build|make|scaffold|refactor|rewrite|convert|port|translate|automate|how (?:do|can|could|would|should) (?:i|you|we)|code (?:up|a|an)|script (?:that|to)|add (?:a|an|the)\b.{0,30}\b(?:function|method|test|endpoint|feature|flag|option))\b/i;

/* What makes a job hard. One of the first group is enough to count double: these are the bugs that do not show up on cue. */
const HARD = /\b(race conditions?|deadlocks?|livelock|memory leaks?|heap corruption|use[- ]after[- ]free|segfault|segmentation fault|heisenbug|intermittent(?:ly)?|flaky|non-?determinis\w+|only (?:happens|fails|breaks) (?:in|on|when|sometimes|under)|in production|under load|can'?t (?:reproduce|repro)|sometimes (?:fails|works|crashes)|distributed|concurren(?:cy|t)|multi-?thread\w*|out of memory|oom)\b/i;
/** Signs a job is wide rather than deep. Global so each different one counts (two separate signs make a job complex). */
const WIDE = /\b(across (?:the )?(?:\w+ )?(?:files|modules|services|repos?|codebase)|multiple (?:files|modules|services|repos?)|(?:whole|entire) (?:codebase|project|repo)|architecture|migrat(?:e|ion)|design a system|end[- ]to[- ]end|performance|optimi[sz]e|vulnerabilit(?:y|ies)|security)\b/gi;
const STUCK = /\b(tried (?:everything|many|several|all)|already tried|still (?:fails|broken|happens|crashes)|no idea why|can'?t figure)\b/i;

/* ------------------------------------------------------------------ detect */

function languageOf(text: string): string | null {
  const fenced = FENCE.exec(text);
  if (fenced && fenced[1]) {
    const tag = fenced[1].toLowerCase();
    for (const [name, re] of LANGS) if (re.test("```" + tag + "\n")) return name;
  }
  for (const [name, re] of LANGS) if (re.test(text)) return name;
  return null;
}

/**
 * Read one message. Null means it is not a coding message and should be handled exactly as before: this never
 * guesses "code" without a sign of it (code, a trace, a named language, or a word that is about software).
 */
export function detectCodeIntent(prompt: string): CodeIntent | null {
  const text = typeof prompt === "string" ? prompt : "";
  if (!text.trim()) return null;

  const fenced = FENCE.test(text);
  const codeLines = text.split(/\r?\n/).filter(l => CODE_LINE.test(l)).length;
  const hasCode = fenced || codeLines >= 2;
  const frames = (text.match(JS_FRAME) ?? []).length + (text.match(PY_FRAME) ?? []).length;
  const hasTrace = frames >= 1 || TRACE.test(text);
  const language = languageOf(text);
  const noun = CODE_NOUN.test(text);
  const tech = TECH_TERM.test(text);

  if (!hasCode && !hasTrace && language === null && !noun && !tech) return null;

  // What kind of job. The first rule that fits wins; the order is the tie-break.
  const reasons: string[] = [];
  let task: CodeTask;
  if (hasTrace) { task = "debug"; reasons.push(frames > 0 ? `an error with ${frames} stack frame${frames === 1 ? "" : "s"}` : "an error message"); }
  else if (DEBUG.test(text) && (hasCode || noun || language !== null || tech)) { task = "debug"; reasons.push("asks why something fails or how to fix it"); }
  else if (EXPLAIN.test(text) && (hasCode || noun || language !== null)) { task = "explain"; reasons.push("asks what code does or how it works"); }
  else if (WRITE.test(text) && (noun || language !== null || hasCode)) { task = "write"; reasons.push("asks for code to be written or changed"); }
  else if (tech && ASK.test(text)) { task = "technical"; reasons.push("an engineering question (design, complexity, performance, review)"); }
  else if (hasCode) { task = "technical"; reasons.push("code with no clear ask"); }
  else return null; // a software word on its own, with no ask, is not a coding job

  // How hard. Each sign adds to the score; two or more makes it complex.
  let score = 0;
  const hard = HARD.exec(text);
  if (hard) { score += 2; reasons.push(`a hard kind of problem ("${hard[0].toLowerCase()}")`); }
  const wide = new Set((text.match(WIDE) ?? []).map(w => w.toLowerCase()));
  if (wide.size > 0) { score += Math.min(2, wide.size); reasons.push(`reaches across files, services or the design ("${Array.from(wide).slice(0, 2).join('", "')}")`); }
  if (frames >= 6) { score += 1; reasons.push("a deep stack trace"); }
  if (codeLines > 40) { score += 1; reasons.push(`${codeLines} lines of code`); }
  if (text.length > 1500) { score += 1; reasons.push("a long message"); }
  if (STUCK.test(text)) { score += 1; reasons.push("already tried and still stuck"); }
  const difficulty: CodeDifficulty = score >= 2 ? "complex" : "simple";

  return { task, difficulty, score, language, hasCode, hasTrace, reasons };
}

/* ------------------------------------------------------------------ effort */

/** A plain coding job is held here at most: "steady", two checks. It is a ceiling on the estimate, never a floor. */
export const CODE_SIMPLE_CEILING = 40;
/** A hard job gets at least this much: "thorough", three checks. Debugging is the harder kind of hard, so it gets more. */
export const CODE_COMPLEX_FLOOR = 60;
export const CODE_COMPLEX_DEBUG_FLOOR = 75;
/** A very hard one (score 3 or more) goes to the top, where the mesh also tries a second way and compares. */
export const CODE_VERY_HARD_FLOOR = 90;

/**
 * The message with the code taken out: fenced blocks, stack frames and lines that look like source. What is left is
 * the person's own words, which is what says how big the job is. Pasting forty lines does not make "why does this
 * fail?" a bigger ask than the same question with three, and auto route's size estimate counts code as extra work.
 */
export function askOf(prompt: string): string {
  const text = typeof prompt === "string" ? prompt : "";
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split(/\r?\n/)
    .filter(l => !CODE_LINE.test(l) && !/^\s+at\s+\S.*:\d+(?::\d+)?\)?\s*$/.test(l) && !/^\s*File ".*", line \d+/.test(l))
    .join("\n")
    .trim();
}

export interface CodeEffort {
  level: number;
  /** One plain line saying what was changed and why, or null when the estimate was left alone. */
  note: string | null;
}

/**
 * Move an effort estimate (0-100) to suit a coding job.
 *   hard job   raised to a floor (never lowered).
 *   plain job  held under a ceiling, but never below what the ask alone earned: `askLevel` is the estimate for the
 *              message with the code taken out (see `askOf`), so a long, careful or many-part request keeps its effort
 *              and only the weight of pasted code is let go.
 *   not code   comes back untouched.
 * Call it only when the effort is an estimate: a dial the person set by hand, or instant, is theirs and must not be moved.
 */
export function adjustEffortForCode(level: number, intent: CodeIntent | null, askLevel = 0): CodeEffort {
  if (!intent) return { level, note: null };
  const label = `${intent.task}${intent.language ? ` (${intent.language})` : ""}`;
  if (intent.difficulty === "complex") {
    const floor = intent.score >= 3 ? CODE_VERY_HARD_FLOOR
      : intent.task === "debug" ? CODE_COMPLEX_DEBUG_FLOOR
      : CODE_COMPLEX_FLOOR;
    if (level >= floor) return { level, note: null };
    return { level: floor, note: `hard ${label} job: effort raised from ${level} to ${floor}` };
  }
  const ceiling = Math.max(CODE_SIMPLE_CEILING, Math.round(askLevel));
  if (level > ceiling) {
    return { level: ceiling, note: `plain ${label} job: the code itself does not add effort, held at ${ceiling} instead of ${level}` };
  }
  return { level, note: null };
}
