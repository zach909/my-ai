/**
 * Tool scripts: a short script that runs features and tools for the agent, instead of one call per chat turn.
 *
 *   const events = await tools.call("calendar", "list events tomorrow");
 *   const mail   = await tools.call("email", "read unread from alice");
 *   return events + "\n" + mail;
 *
 * ── Why a separate process ─────────────────────────────────────────────
 *
 * The existing sandbox (plugins/extensions/coding.ts, runSandboxed) is safe because NOTHING from this app is inside
 * it. The moment a script is handed one function to call tools with, that function is a way out: in node:vm a
 * script can climb from it to the real process (`tools.call.constructor("return process")()`) and run commands.
 * Tested here, not assumed. So the script does not run in this process at all.
 *
 * It runs in a child process started with Node's own permission model (`--permission`, a built-in; no library):
 *   - no file reads or writes, no child processes, no worker threads, no native addons;
 *   - no environment variables, a small memory ceiling, a hard time limit, and string-eval switched off;
 *   - inside that, a vm context with an empty global, so a script sees only `tools` and `console`.
 * The only way out of the child is its stdout, carrying JSON lines. A tool request is plain text: a tool name and a
 * request string. No object, function or handle ever crosses.
 *
 * ── Every call goes through the gate, one at a time ────────────────────
 *
 * Each `tools.call` is handed to the caller-supplied `call` function, which in the server is
 * PluginRegistry.runTool: the same gate chat uses (danger protocol, owner-only rule, the approval queue). A risky
 * tool is HELD for a person. The script then stops at that call: it does not wait, retry or work around it. Approving
 * the held call runs that one call once, by itself (the registry's normal approval path); the rest of the script
 * does not continue afterwards. Calls run one at a time even if the script starts several at once.
 *
 * ── What this does NOT do (stated plainly) ─────────────────────────────
 *
 *   - Node's permission model in the versions this project runs on does not restrict the NETWORK. A script that
 *     breaks out of the vm context (the vm is a convenience, not a wall) still could not touch a file, start a
 *     program or read the app's memory or approvals, but it could open a network connection. If that matters,
 *     run the engine with no route out, which is a property of where it runs, not of this file.
 *   - It fails closed: if this Node cannot start a child with `--permission` (an old Node, a phone runtime), the
 *     script does not run. It never falls back to running unrestricted.
 *   - A script cannot start another script (the `scripts` tool is blocked for it).
 *   - Limits: a number of calls, total time, code size, request size and output size. Hitting one stops the script.
 */

import { spawn, type ChildProcess } from "node:child_process";

/* ------------------------------------------------------------------ types */

export type CallStatus = "ran" | "held" | "refused" | "declined" | "unavailable";
/** Same shape as PluginRegistry.runTool's answer, so the registry's method can be passed straight in. */
export interface ToolCallResult { status: CallStatus; text: string }
export type ToolCaller = (tool: string, input: string) => Promise<ToolCallResult>;

export interface ScriptLimits {
  /** Total time for the whole script, in ms. */
  timeoutMs: number;
  maxCalls: number;
  maxCodeChars: number;
  /** The longest request one call may carry. */
  maxInputChars: number;
  /** The most characters of printed output and of the returned value kept. */
  maxOutputChars: number;
}

export const SCRIPT_LIMITS: ScriptLimits = { timeoutMs: 60_000, maxCalls: 20, maxCodeChars: 8_000, maxInputChars: 4_000, maxOutputChars: 20_000 };
/** A script may not start a script. */
export const SCRIPT_BLOCKED_TOOLS: readonly string[] = ["scripts"];
/** The sync part of a script (a loop with no awaits) is cut off after this long, inside the child. */
const SYNC_TIMEOUT_MS = 5_000;
/** If the child writes more than this to stdout in total, it is killed. */
const MAX_STDOUT_BYTES = 1_000_000;
const TOOL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface ScriptCall { tool: string; input: string; status: CallStatus | "blocked" | "invalid" | "limit"; ms: number }
export type ScriptStop = "held" | "timeout" | "too-many-calls" | "too-much-output" | "error" | "could-not-start";

export interface ScriptResult {
  /** True only when the script ran to its end and returned. */
  ok: boolean;
  /** What the script returned, as text, or null. */
  value: string | null;
  /** What it printed with console.log. */
  output: string;
  calls: ScriptCall[];
  /** Why it stopped early, or null when it finished (ok or with an error of its own: see `message`). */
  stopped: ScriptStop | null;
  /** Set when `stopped` is "held": the call that is waiting for a person. */
  held: { tool: string; request: string; message: string } | null;
  /** One plain sentence saying what happened. */
  message: string;
  ms: number;
}

/* -------------------------------------------------------------- the child */

/**
 * The program the child runs (CommonJS, passed with -e: nothing is read from disk, which the permission model forbids
 * anyway). It reads one `run` message, runs the code in a vm context that holds only `tools` and `console`, and asks
 * the parent for every tool call by writing a line to stdout and waiting for the answer on stdin.
 */
const CHILD_SOURCE = String.raw`
const vm = require('node:vm');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const waiting = new Map();
let seq = 0;
let buf = '';
const show = (v) => { if (typeof v === 'string') return v; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); } };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.t === 'run') run(m.code, m.tools, m.syncMs);
    else if (m.t === 'result') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  }
});
async function run(code, toolIds, syncMs) {
  const logs = [];
  const call = (tool, input) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => m.status === 'ran' ? resolve(m.text) : reject(new Error(m.status + ': ' + m.text)));
    out({ t: 'call', id, tool, input });
  });
  const ctx = vm.createContext(
    { tools: Object.freeze({ call, list: () => toolIds.slice() }), console: { log: (...a) => { logs.push(a.map(show).join(' ')); } } },
    { codeGeneration: { strings: false, wasm: false } },
  );
  try {
    const result = new vm.Script('(async () => {\n' + code + '\n})()', { filename: 'script.js' }).runInContext(ctx, { timeout: syncMs });
    const v = await result;
    out({ t: 'done', ok: true, value: v === undefined ? null : show(v), logs });
  } catch (e) {
    out({ t: 'done', ok: false, error: String((e && e.message) || e), logs });
  }
}
`;

/**
 * Flags for the child, without the program. Every one is a Node built-in. Exported so a test can start a child with
 * exactly these flags and a probe in place of the program, and see what is and is not denied.
 */
export function scriptChildFlags(): string[] {
  return [
    "--permission",                            // no fs, no child processes, no workers, no addons
    "--disallow-code-generation-from-strings", // no eval / new Function, which is how a script climbs out of a vm context
    "--max-old-space-size=128",
    "--input-type=commonjs",
  ];
}

const childArgs = (): string[] => [...scriptChildFlags(), "-e", CHILD_SOURCE];

/* ----------------------------------------------------------------- the run */

export interface RunDeps {
  /** Start the child. Replaceable so a test can check what would be started; the default is node:child_process. */
  spawnChild?: (args: string[]) => ChildProcess;
  now?: () => number;
}

function defaultSpawn(args: string[]): ChildProcess {
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {},
    windowsHide: true,
  });
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n[cut]" : s);

/**
 * Run a script. `call` is how a tool call reaches the gate (PluginRegistry.runTool in the server); `tools` is the
 * list of tool names the script may see with `tools.list()`. Never throws: every outcome is a ScriptResult.
 */
export function runScript(
  code: string,
  call: ToolCaller,
  tools: string[] = [],
  limits: Partial<ScriptLimits> = {},
  deps: RunDeps = {},
): Promise<ScriptResult> {
  const lim: ScriptLimits = { ...SCRIPT_LIMITS, ...limits };
  const now = deps.now ?? Date.now;
  const started = now();
  const calls: ScriptCall[] = [];
  const text = typeof code === "string" ? code : "";

  const result = (r: Partial<ScriptResult> & { message: string }): ScriptResult => ({
    ok: false, value: null, output: "", calls, stopped: null, held: null, ms: now() - started, ...r,
  });

  if (!text.trim()) return Promise.resolve(result({ message: "There is no script to run." }));
  if (text.length > lim.maxCodeChars) return Promise.resolve(result({ message: `The script is too long (${text.length} characters; the limit is ${lim.maxCodeChars}).` }));

  const visible = tools.filter(t => TOOL_NAME.test(t) && !SCRIPT_BLOCKED_TOOLS.includes(t.toLowerCase()));

  return new Promise<ScriptResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = (deps.spawnChild ?? defaultSpawn)(childArgs());
    } catch (e) {
      resolve(result({ stopped: "could-not-start", message: `The script could not be started: ${e instanceof Error ? e.message : String(e)}` }));
      return;
    }

    let settled = false;
    let logs: string[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let buf = "";
    // Calls run strictly one at a time, in the order they arrive.
    let queue: Promise<void> = Promise.resolve();

    const finish = (r: ScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ ...r, output: clip(logs.join("\n"), lim.maxOutputChars), ms: now() - started });
    };
    const timer = setTimeout(() => finish(result({ stopped: "timeout", message: `The script was stopped after ${Math.round(lim.timeoutMs / 1000)} seconds.` })), lim.timeoutMs);

    const reply = (m: object): void => {
      try { child.stdin?.write(JSON.stringify(m) + "\n"); } catch { /* the child is gone; finish() handles it */ }
    };

    const handleCall = async (m: { id: number; tool: unknown; input: unknown }): Promise<void> => {
      if (settled) return;
      const t0 = now();
      const tool = typeof m.tool === "string" ? m.tool.trim() : "";
      const input = m.input;
      const note = (status: ScriptCall["status"]): void => { calls.push({ tool: tool.slice(0, 64), input: typeof input === "string" ? input.slice(0, 200) : "", status, ms: now() - t0 }); };

      if (typeof input !== "string" || !TOOL_NAME.test(tool)) { note("invalid"); reply({ t: "result", id: m.id, status: "refused", text: "A call needs a tool name and a request written as text." }); return; }
      if (input.length > lim.maxInputChars) { note("invalid"); reply({ t: "result", id: m.id, status: "refused", text: `That request is too long (limit ${lim.maxInputChars} characters).` }); return; }
      if (SCRIPT_BLOCKED_TOOLS.includes(tool.toLowerCase())) { note("blocked"); reply({ t: "result", id: m.id, status: "refused", text: "A script cannot start a script." }); return; }
      if (calls.length >= lim.maxCalls) {
        note("limit");
        finish(result({ stopped: "too-many-calls", message: `The script was stopped: it made more than ${lim.maxCalls} tool calls.` }));
        return;
      }

      let answer: ToolCallResult;
      try {
        answer = await call(tool, input);
      } catch (e) {
        answer = { status: "declined", text: `It failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (settled) return;
      const status: CallStatus = answer && typeof answer.status === "string" ? answer.status : "declined";
      const body = answer && typeof answer.text === "string" ? answer.text : "";
      note(status);
      if (status === "held") {
        // The gate is waiting for a person. The script does not wait with it, and does not go on.
        finish(result({
          stopped: "held",
          held: { tool, request: input.slice(0, 200), message: body },
          message: `The script stopped at its call to ${tool}: it needs your approval first. Approving it runs that one call; the rest of the script does not continue.`,
        }));
        return;
      }
      reply({ t: "result", id: m.id, status, text: body });
    };

    const onLine = (line: string): void => {
      let m: { t?: string; id?: number; tool?: unknown; input?: unknown; ok?: boolean; value?: string | null; error?: string; logs?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === "call" && typeof m.id === "number") {
        queue = queue.then(() => handleCall(m as { id: number; tool: unknown; input: unknown })).catch(() => undefined);
      } else if (m.t === "done") {
        // Let any call that is mid-flight settle first: a held call must win over the script's own ending.
        queue = queue.then(() => {
          if (settled) return;
          logs = Array.isArray(m.logs) ? m.logs.map(String) : [];
          if (m.ok) finish(result({ ok: true, value: m.value == null ? null : clip(String(m.value), lim.maxOutputChars), message: "The script finished." }));
          else finish(result({ message: `The script failed: ${clip(String(m.error ?? "unknown error"), 400)}` }));
        });
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) { finish(result({ stopped: "too-much-output", message: "The script was stopped: it wrote too much." })); return; }
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { if (stderr.length < 2000) stderr += d; });
    child.on("error", (e) => finish(result({ stopped: "could-not-start", message: `The script could not be started: ${e.message}` })));
    child.on("exit", (code, signal) => {
      // An exit before a "done" line: the child died (out of memory, killed, or a Node that does not know --permission).
      queue = queue.then(() => {
        if (settled) return;
        const why = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
        const unsupported = /bad option|--permission|not allowed in NODE_OPTIONS/i.test(stderr);
        finish(result({
          stopped: unsupported ? "could-not-start" : "error",
          message: unsupported
            ? "The script was not run: this Node cannot start a child process with its permission model, and a script is never run without it."
            : `The script ended without a result (${signal ?? `exit ${code}`})${why ? `: ${why}` : ""}.`,
        }));
      });
    });

    reply({ t: "run", code: text, tools: visible, syncMs: SYNC_TIMEOUT_MS });
  });
}

/** The text a person reads in chat: what happened, what it printed, what it returned, and each call with its status. */
export function describeScriptResult(r: ScriptResult): string {
  const lines: string[] = [r.message];
  if (r.held) lines.push(`Waiting for approval: ${r.held.tool}: "${r.held.request}"`, r.held.message);
  if (r.output) lines.push("", "Printed:", r.output);
  if (r.value) lines.push("", "Returned:", r.value);
  if (r.calls.length) {
    lines.push("", "Calls:");
    r.calls.forEach((c, i) => lines.push(`${i + 1}. ${c.tool}: ${c.status} (${c.ms} ms)`));
  }
  return lines.join("\n");
}
