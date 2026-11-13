import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  classifyTask, looksLikeSecret, historyToMessages, routeAndAsk, routerStatus, webEndpoint, WEB_THRESHOLD,
} from '../../plugins/llm-router.js';

interface Seen { path: string; auth: string | undefined; body: any }

/** A tiny fake chat server. `reply` builds the JSON for one request. */
async function fake(reply: (seen: Seen) => { status?: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const s: Seen = { path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      const out = reply(s);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const ollamaOk = (text: string) => ({ body: { message: { role: 'assistant', content: text } } });
const openaiOk = (text: string) => ({ body: { choices: [{ message: { role: 'assistant', content: text } }] } });
const BIG = 'Design and implement a rate limiter for our API, then write the tests, and finally explain the trade-offs step by step.';

const KEYS = ['NEUROCLAW_AI_ROUTE', 'NEUROCLAW_OLLAMA_URL', 'NEUROCLAW_OLLAMA_MODEL', 'NEUROCLAW_WEB_AI_URL', 'NEUROCLAW_WEB_AI_MODEL', 'NEUROCLAW_WEB_AI_KEY', 'NEUROCLAW_WEB_AI_FORMAT'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.restoreAllMocks(); });

describe('classifyTask', () => {
  it('keeps small talk local', () => {
    for (const m of ['hi', 'what time is it in Tokyo?', 'thanks!', 'who wrote Hamlet?']) {
      const v = classifyTask(m);
      expect(v.tier, m).toBe('local');
      expect(v.score).toBeLessThan(WEB_THRESHOLD);
    }
  });

  it('sends a big job to the web and says why', () => {
    const v = classifyTask(BIG);
    expect(v.tier).toBe('web');
    expect(v.reasons.join(' ')).toMatch(/build, analysis or write-up/);
  });

  it('counts a long message with code as big', () => {
    const v = classifyTask('Why does this fail?\n```js\n' + 'const x = 1;\n'.repeat(60) + '```');
    expect(v.tier).toBe('web');
  });

  it('lets a /web or /local prefix decide, and strips it', () => {
    expect(classifyTask('/web hi')).toMatchObject({ tier: 'web', prompt: 'hi' });
    expect(classifyTask('/local ' + BIG)).toMatchObject({ tier: 'local', prompt: BIG });
  });

  it('lets NEUROCLAW_AI_ROUTE override the size check', () => {
    process.env.NEUROCLAW_AI_ROUTE = 'local';
    expect(classifyTask(BIG).tier).toBe('local');
    process.env.NEUROCLAW_AI_ROUTE = 'web';
    expect(classifyTask('hi').tier).toBe('web');
  });

  it('weighs a long conversation', () => {
    const long = ['user: ' + 'x'.repeat(2500), 'ai: ' + 'y'.repeat(2500)];
    expect(classifyTask('can you also review that and then make it shorter', long).score)
      .toBeGreaterThan(classifyTask('can you also review that and then make it shorter').score);
  });
});

describe('looksLikeSecret', () => {
  it('catches keys, tokens and passwords', () => {
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe(true);
    expect(looksLikeSecret('my key is AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksLikeSecret('use sk-abcdefghijklmnop1234 here')).toBe(true);
    expect(looksLikeSecret('password: hunter2hunter2')).toBe(true);
    expect(looksLikeSecret('api_key = abcd1234efgh')).toBe(true);
  });
  it('leaves ordinary text alone', () => {
    expect(looksLikeSecret('How do I reset my password?')).toBe(false);
    expect(looksLikeSecret(BIG)).toBe(false);
  });
});

describe('historyToMessages', () => {
  it('turns "role: text" lines into chat messages and keeps the last eight', () => {
    const h = Array.from({ length: 10 }, (_, i) => (i % 2 ? `ai: a${i}` : `user: u${i}`));
    const m = historyToMessages(h);
    expect(m).toHaveLength(8);
    expect(m[0]).toEqual({ role: 'user', content: 'u2' });
    expect(m[1]).toEqual({ role: 'assistant', content: 'a3' });
    expect(historyToMessages(['no role here', 'user:   '])).toEqual([]);
  });
});

describe('webEndpoint', () => {
  it('does not exist until a URL is set, and never has a default provider', () => {
    expect(webEndpoint()).toBeNull();
    expect(routerStatus().web.configured).toBe(false);
  });
  it('refuses plain http off this machine, embedded credentials and junk', () => {
    for (const bad of ['http://example.com/v1', 'https://user:pw@example.com/v1', 'not a url', 'ftp://example.com']) {
      process.env.NEUROCLAW_WEB_AI_URL = bad;
      expect(webEndpoint(), bad).toBeNull();
    }
    process.env.NEUROCLAW_WEB_AI_URL = 'http://127.0.0.1:9000/v1';
    expect(webEndpoint()).not.toBeNull();
    process.env.NEUROCLAW_WEB_AI_URL = 'https://example.com/v1/';
    expect(webEndpoint()?.url).toBe('https://example.com/v1');
  });
  it('never reports the key in the status', () => {
    process.env.NEUROCLAW_WEB_AI_URL = 'https://example.com/v1';
    process.env.NEUROCLAW_WEB_AI_KEY = 'super-secret-value';
    const s = JSON.stringify(routerStatus());
    expect(s).not.toContain('super-secret-value');
    expect(routerStatus().web.hasKey).toBe(true);
  });
});

describe('routeAndAsk', () => {
  it('answers small talk with the local model and never touches the web', async () => {
    const local = await fake(() => ollamaOk('hello!'));
    const web = await fake(() => openaiOk('WEB'));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small:q4';
      process.env.NEUROCLAW_WEB_AI_URL = web.base;
      const a = await routeAndAsk('hi');
      expect(a).toMatchObject({ text: 'hello!', tier: 'local', model: 'small:q4' });
      expect(local.seen[0].path).toBe('/api/chat');
      expect(local.seen[0].body).toMatchObject({ model: 'small:q4', stream: false, messages: [{ role: 'user', content: 'hi' }] });
      expect(web.seen).toHaveLength(0);
    } finally { await local.close(); await web.close(); }
  });

  it('sends a big job to the web (openai format) with the key, and not to the local model', async () => {
    const local = await fake(() => ollamaOk('LOCAL'));
    const web = await fake(() => openaiOk('the long answer'));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small:q4';
      process.env.NEUROCLAW_WEB_AI_URL = web.base + '/v1';
      process.env.NEUROCLAW_WEB_AI_MODEL = 'big:fp16';
      process.env.NEUROCLAW_WEB_AI_KEY = 'k-123';
      const a = await routeAndAsk(BIG, ['user: earlier', 'ai: sure']);
      expect(a).toMatchObject({ text: 'the long answer', tier: 'web', model: 'big:fp16' });
      expect(web.seen[0].path).toBe('/v1/chat/completions');
      expect(web.seen[0].auth).toBe('Bearer k-123');
      expect(web.seen[0].body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(local.seen).toHaveLength(0);
    } finally { await local.close(); await web.close(); }
  });

  it('speaks the ollama wire format to the web endpoint when asked', async () => {
    const web = await fake(() => ollamaOk('from a bigger ollama'));
    try {
      process.env.NEUROCLAW_WEB_AI_URL = web.base;
      process.env.NEUROCLAW_WEB_AI_FORMAT = 'ollama';
      process.env.NEUROCLAW_WEB_AI_MODEL = 'big';
      const a = await routeAndAsk(BIG);
      expect(a).toMatchObject({ text: 'from a bigger ollama', tier: 'web' });
      expect(web.seen[0].path).toBe('/api/chat');
    } finally { await web.close(); }
  });

  it('falls back to the local model when the web call fails', async () => {
    const local = await fake(() => ollamaOk('local to the rescue'));
    const web = await fake(() => ({ status: 500 }));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small';
      process.env.NEUROCLAW_WEB_AI_URL = web.base;
      const a = await routeAndAsk(BIG);
      expect(a).toMatchObject({ text: 'local to the rescue', tier: 'local' });
      expect(a?.reasons.join(' ')).toMatch(/web AI failed/);
    } finally { await local.close(); await web.close(); }
  });

  it('stays local when no web AI is configured', async () => {
    const local = await fake(() => ollamaOk('ok'));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small';
      const a = await routeAndAsk(BIG);
      expect(a?.tier).toBe('local');
      expect(a?.reasons.join(' ')).toMatch(/no web AI is configured/);
    } finally { await local.close(); }
  });

  it('never sends a secret to the web, even for a big job', async () => {
    const local = await fake(() => ollamaOk('kept local'));
    const web = await fake(() => openaiOk('WEB'));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small';
      process.env.NEUROCLAW_WEB_AI_URL = web.base;
      const a = await routeAndAsk(BIG + '\npassword: correcthorsebattery');
      expect(a?.tier).toBe('local');
      expect(web.seen).toHaveLength(0);
      // ...and a secret earlier in the conversation counts too.
      const b = await routeAndAsk(BIG, ['user: here is my key AKIAABCDEFGHIJKLMNOP']);
      expect(b?.tier).toBe('local');
      expect(web.seen).toHaveLength(0);
    } finally { await local.close(); await web.close(); }
  });

  it('uses the first installed model when none is named', async () => {
    const local = await fake(s => s.path === '/api/tags' ? { body: { models: [{ name: 'first:7b' }, { name: 'second' }] } } : ollamaOk('hi'));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      const a = await routeAndAsk('hi');
      expect(a?.model).toBe('first:7b');
    } finally { await local.close(); }
  });

  it('returns null, not an error, when nothing can answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEUROCLAW_OLLAMA_URL = 'http://127.0.0.1:9';
    process.env.NEUROCLAW_OLLAMA_MODEL = 'small';
    expect(await routeAndAsk('hi')).toBeNull();
  });

  it('treats an empty model reply as a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const local = await fake(() => ollamaOk('   '));
    try {
      process.env.NEUROCLAW_OLLAMA_URL = local.base;
      process.env.NEUROCLAW_OLLAMA_MODEL = 'small';
      expect(await routeAndAsk('hi')).toBeNull();
    } finally { await local.close(); }
  });
});
