/**
 * Two AIs, one front door: small talk goes to a small local model, big jobs go
 * to a web model. Think Google Assistant and Gemini: the same family of model,
 * one quantized and running on your own machine, the other full size and
 * hosted. Point both at the same model if you like (a q4 tag locally, the full
 * precision one on the web endpoint); the router does not care.
 *
 * Nothing here is a library. It is two HTTP calls made with Node's own fetch to
 * services the owner chooses:
 *
 *   local  an Ollama server (the owner's), NEUROCLAW_OLLAMA_URL, default
 *          http://127.0.0.1:11434. NEUROCLAW_OLLAMA_MODEL names the model; if it
 *          is unset the first model the server lists is used.
 *   web    any chat endpoint the owner picks. NO provider is built in and none
 *          is the default: until NEUROCLAW_WEB_AI_URL is set the web tier does
 *          not exist and nothing ever leaves the machine. NEUROCLAW_WEB_AI_MODEL
 *          names the model, NEUROCLAW_WEB_AI_KEY is the optional key (sent only
 *          to that URL, never logged or returned), and NEUROCLAW_WEB_AI_FORMAT
 *          is "openai" (default; POST <url>/chat/completions) or "ollama"
 *          (POST <url>/api/chat) for whichever wire format the endpoint speaks.
 *
 * Which tier answers is decided by classifyTask(): string and character counts
 * over the message, no tokenizer and no model call, so deciding costs nothing.
 * NEUROCLAW_AI_ROUTE=local|web|auto (default auto) overrides it for everything,
 * and a message that starts with "/web " or "/local " overrides it for that one.
 *
 * Failure is quiet and safe, never a hang or a crash:
 *   - the web call fails            -> the local model answers instead
 *   - the local call fails          -> null, and the caller's own mesh answers
 *   - nothing is configured at all  -> null
 * A message that looks like it carries a secret (a private key, a password, an
 * API token) is never sent to the web tier, whatever its size; it stays local.
 */

export type Tier = "local" | "web";

export interface TaskVerdict {
  tier: Tier;
  /** Higher means bigger. The web tier starts at WEB_THRESHOLD. */
  score: number;
  /** Plain-language reasons, for the details panel and for debugging a surprising choice. */
  reasons: string[];
  /** The message with any leading "/web " or "/local " removed. */
  prompt: string;
}

export interface RoutedAnswer {
  text: string;
  /** The tier that actually wrote the reply (not the one first picked, if the web call failed). */
  tier: Tier;
  model: string;
  /** Why this tier, and what happened on the way (a fallback, a secret held back). */
  reasons: string[];
}

export interface RouterStatus {
  route: "auto" | "local" | "web";
  local: { url: string; model: string | null };
  web: { configured: boolean; url: string | null; model: string | null; format: "openai" | "ollama"; hasKey: boolean };
}

export const WEB_THRESHOLD = 3;

const LOCAL_TIMEOUT_MS = 60_000;
const WEB_TIMEOUT_MS = 120_000;
const MAX_HISTORY_TURNS = 8;

/* ------------------------------------------------------------------ settings */

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function routeMode(): "auto" | "local" | "web" {
  const v = env("NEUROCLAW_AI_ROUTE").toLowerCase();
  return v === "local" || v === "web" ? v : "auto";
}

export function ollamaBaseUrl(): string {
  const raw = env("NEUROCLAW_OLLAMA_URL") || "http://127.0.0.1:11434";
  return (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, "");
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/**
 * The web endpoint, or null when it is unset or unacceptable. It must be https
 * (a key must not cross the internet in the clear), except for a loopback
 * address so a gateway on this machine works. No user:password in the URL.
 */
export function webEndpoint(): { url: string; model: string; format: "openai" | "ollama"; key: string } | null {
  const raw = env("NEUROCLAW_WEB_AI_URL");
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
  const format = env("NEUROCLAW_WEB_AI_FORMAT").toLowerCase() === "ollama" ? "ollama" : "openai";
  return { url: raw.replace(/\/+$/, ""), model: env("NEUROCLAW_WEB_AI_MODEL"), format, key: env("NEUROCLAW_WEB_AI_KEY") };
}

/** What is configured, with the key reduced to whether one exists. Safe to show anywhere. */
export function routerStatus(): RouterStatus {
  const web = webEndpoint();
  return {
    route: routeMode(),
    local: { url: ollamaBaseUrl(), model: env("NEUROCLAW_OLLAMA_MODEL") || null },
    web: {
      configured: web !== null,
      url: web ? new URL(web.url).origin : null,
      model: web ? web.model || null : null,
      format: web?.format ?? "openai",
      hasKey: !!web?.key,
    },
  };
}

/* ------------------------------------------------------------ classification */

/** Work that is a job rather than a chat. Words only count as a signal, never as a gate. */
const BIG_VERBS = /\b(design|architect|implement|refactor|debug|prove|derive|analy[sz]e|compare|research|investigate|plan|migrate|optimi[sz]e|audit|review|rewrite|translate|summari[sz]e|explain in detail|write (?:me )?(?:a|an|the) (?:essay|report|article|story|program|script|function|class|module|plan|proposal|spec|document|email|letter))\b/i;
const MULTI_STEP = /\b(step[- ]by[- ]step|first(?:ly)?\b.*\bthen\b|then\b.*\bfinally|after that|and then|at the same time|make sure (?:that )?it|end to end)\b/i;
const CODE_FENCE = /```|^\s{4,}\S.*[;{}]\s*$/m;

/**
 * Size up a message. Pure and instant: character and line counts and a few
 * patterns. A message routed "web" by a force prefix or NEUROCLAW_AI_ROUTE says
 * so in its reasons.
 */
export function classifyTask(message: string, history: string[] = []): TaskVerdict {
  const reasons: string[] = [];
  let prompt = message;

  const prefix = /^\s*\/(web|local)\b[ \t]*/i.exec(prompt);
  if (prefix) {
    prompt = prompt.slice(prefix[0].length);
    const tier = prefix[1].toLowerCase() as Tier;
    return { tier, score: tier === "web" ? WEB_THRESHOLD : 0, reasons: [`you asked for ${tier} with /${tier}`], prompt };
  }
  const forced = routeMode();
  if (forced !== "auto") {
    return { tier: forced, score: forced === "web" ? WEB_THRESHOLD : 0, reasons: [`NEUROCLAW_AI_ROUTE=${forced}`], prompt };
  }

  let score = 0;
  const text = prompt.trim();
  const lines = text.split(/\r?\n/).length;

  if (text.length > 1500) { score += 3; reasons.push(`long message (${text.length} characters)`); }
  else if (text.length > 600) { score += 2; reasons.push(`fairly long message (${text.length} characters)`); }
  else if (text.length > 300) { score += 1; reasons.push(`medium message (${text.length} characters)`); }

  if (CODE_FENCE.test(text)) { score += 2; reasons.push("contains code"); }
  if (lines > 12) { score += 1; reasons.push(`${lines} lines`); }
  if (MULTI_STEP.test(text)) { score += 1; reasons.push("asks for several steps"); }
  if (BIG_VERBS.test(text)) { score += 2; reasons.push("asks for a build, analysis or write-up"); }
  if (history.reduce((n, h) => n + h.length, 0) > 4000) { score += 1; reasons.push("long conversation to keep in view"); }
  if (text.length <= 80 && score === 0) reasons.push("short and plain");

  return { tier: score >= WEB_THRESHOLD ? "web" : "local", score, reasons, prompt };
}

/**
 * True when text looks like it carries a credential. Patterns are deliberately
 * wide: a false alarm costs one reply from the local model; a miss sends a
 * secret off the machine.
 */
export function looksLikeSecret(text: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(text) ||
    /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text) ||
    /\b(?:pass(?:word|wd|phrase)?|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer)\b\s*(?:is|[:=])\s*\S{6,}/i.test(text)
  );
}

/* ------------------------------------------------------------------- calls */

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** The runner hands history over as "role: text" strings; turn them back into chat messages. */
export function historyToMessages(history: string[] = []): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of history.slice(-MAX_HISTORY_TURNS)) {
    const m = /^(user|assistant|ai|agent|system)\s*:\s*([\s\S]*)$/i.exec(line);
    if (!m || !m[2].trim()) continue;
    const r = m[1].toLowerCase();
    out.push({ role: r === "user" ? "user" : r === "system" ? "system" : "assistant", content: m[2] });
  }
  return out;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).origin} answered ${res.status}`);
  return res.json();
}

/** Ollama's reply is { message: { content } }. */
function ollamaText(data: unknown): string {
  const c = (data as { message?: { content?: unknown } })?.message?.content;
  return typeof c === "string" ? c.trim() : "";
}

/** The chat-completions reply is { choices: [{ message: { content } }] }. */
function openaiText(data: unknown): string {
  const c = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c.trim() : "";
}

async function resolveLocalModel(): Promise<string> {
  const named = env("NEUROCLAW_OLLAMA_MODEL");
  if (named) return named;
  const res = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${ollamaBaseUrl()} answered ${res.status}`);
  const first = ((await res.json()) as { models?: Array<{ name?: unknown }> }).models?.find(m => typeof m.name === "string");
  if (!first) throw new Error("the Ollama server has no models installed");
  return first.name as string;
}

async function askLocal(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const model = await resolveLocalModel();
  const data = await postJson(`${ollamaBaseUrl()}/api/chat`, { model, messages, stream: false }, {}, LOCAL_TIMEOUT_MS);
  const text = ollamaText(data);
  if (!text) throw new Error("the local model wrote nothing");
  return { text, model };
}

async function askWeb(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const ep = webEndpoint();
  if (!ep) throw new Error("no web endpoint configured");
  const headers: Record<string, string> = ep.key ? { Authorization: `Bearer ${ep.key}` } : {};
  let data: unknown;
  if (ep.format === "ollama") {
    data = await postJson(`${ep.url}/api/chat`, { model: ep.model, messages, stream: false }, headers, WEB_TIMEOUT_MS);
  } else {
    const url = /\/chat\/completions$/.test(ep.url) ? ep.url : `${ep.url}/chat/completions`;
    data = await postJson(url, { model: ep.model, messages }, headers, WEB_TIMEOUT_MS);
  }
  const text = ep.format === "ollama" ? ollamaText(data) : openaiText(data);
  if (!text) throw new Error("the web model wrote nothing");
  return { text, model: ep.model };
}

/* ---------------------------------------------------------------- the router */

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pick a tier and get an answer. Returns null when no model could answer, so
 * the caller can fall through to its own (the mesh) rather than show an error.
 * Never throws.
 */
export async function routeAndAsk(message: string, history: string[] = []): Promise<RoutedAnswer | null> {
  const verdict = classifyTask(message, history);
  const reasons = [...verdict.reasons];
  const messages: ChatMessage[] = [...historyToMessages(history), { role: "user", content: verdict.prompt }];
  let tier = verdict.tier;

  if (tier === "web") {
    if (!webEndpoint()) {
      reasons.push("no web AI is configured (NEUROCLAW_WEB_AI_URL), so it stays local");
      tier = "local";
    } else if (looksLikeSecret(verdict.prompt) || history.some(looksLikeSecret)) {
      reasons.push("the conversation looks like it holds a secret, so it was not sent to the web and stays local");
      tier = "local";
    }
  }

  if (tier === "web") {
    try {
      const a = await askWeb(messages);
      return { ...a, tier: "web", reasons };
    } catch (e) {
      reasons.push(`the web AI failed (${why(e)}); the local model answers instead`);
    }
  }

  try {
    const a = await askLocal(messages);
    return { ...a, tier: "local", reasons };
  } catch (e) {
    console.warn(`[ai-router] no answer from the local model: ${why(e)} (${ollamaBaseUrl()})`);
    return null;
  }
}

/** The router is only worth calling when at least one tier is reachable on paper. */
export function routingEnabled(): boolean {
  return env("NEUROCLAW_AI_ROUTER") === "1";
}
