/**
 * The workbench over HTTP, for the web page, the desktop app and editors.
 *
 *   GET  /api/workbench/status                 agents, commands, counts, warnings
 *   POST /api/workbench/run                    { prompt, agent?, session?, model? }  one turn (same as `neuroclaw run`)
 *   GET  /api/workbench/sessions               list;  GET /api/workbench/sessions/search?q=
 *   GET  /api/workbench/sessions/:id           header and messages
 *   POST /api/workbench/sessions/:id/fork      { at? }       POST .../rename { title }       POST .../share { days? }
 *   POST /api/workbench/shares/revoke          { token }
 *   GET  /api/workbench/checkpoints            GET /api/workbench/diff?id=
 *   POST /api/workbench/undo | redo            { force? }    POST /api/workbench/rewind { id, what, session?, force? }
 *   GET  /api/workbench/usage?days=            GET /api/workbench/mcp   (what is configured and whether it is usable)
 *   GET  /share/:token                         the read-only shared transcript (the one public path; the token is the key)
 *
 * Everything under /api/workbench is for the owner or an admin. Deliberately not here: adding a tool server, installing a
 * bundle, approving a project's hooks. Those start programs, so they are done at the command line (`neuroclaw wb ...`) by a
 * person at the computer, never by a web request.
 */
import type * as http from 'node:http';
import { injectAmbient } from '../ambient.js';
import type { Workbench } from './workbench.js';

export interface WorkbenchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
  isAdmin(): boolean;
  workbench(): Workbench;
  /** Run `fn` so the executor can reach this request's engine. */
  within<T>(fn: () => Promise<T>): Promise<T>;
}

export const isWorkbenchRoute = (p: string): boolean => p === '/api/workbench' || p.startsWith('/api/workbench/');
export const isSharePath = (p: string): boolean => /^\/share\/[A-Za-z0-9_-]{20,64}$/.test(p);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown, max = 20000): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

export async function handleWorkbenchRoutes(c: WorkbenchRouteContext): Promise<boolean> {
  const { pathname, method, res } = c;
  if (isSharePath(pathname) && method === 'GET') {
    const html = c.workbench().sessions.renderShare(pathname.slice('/share/'.length));
    if (html === null) { c.sendJson(res, { error: 'This link is not valid or has expired.' }, 404); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'" });
    res.end(injectAmbient(html));
    return true;
  }
  if (!isWorkbenchRoute(pathname)) return false;
  if (!c.isAdmin()) { c.sendJson(res, { error: 'Only the owner or an admin can use the workbench.' }, 403); return true; }
  const wb = c.workbench();
  const send = (d: unknown, s = 200) => { c.sendJson(res, d, s); return true; };
  const p = pathname;

  if (method === 'GET') {
    if (p === '/api/workbench/status') return send(wb.status());
    if (p === '/api/workbench/sessions') return send({ sessions: wb.sessions.list().slice(0, 200) });
    if (p === '/api/workbench/sessions/search') return send({ results: wb.sessions.search(c.url.searchParams.get('q') ?? '') });
    const sm = /^\/api\/workbench\/sessions\/([a-f0-9]{12})$/.exec(p);
    if (sm) { const s = wb.sessions.get(sm[1]); return s ? send(s) : send({ error: 'No such session.' }, 404); }
    if (p === '/api/workbench/checkpoints') return send({ checkpoints: wb.checkpoints.list().map(({ id, turn, label, at, undone, messages, before }) => ({ id, turn, label, at, undone: !!undone, messages, files: Object.keys(before) })) });
    if (p === '/api/workbench/diff') return send({ diff: wb.checkpoints.diff(c.url.searchParams.get('id') ?? '') });
    if (p === '/api/workbench/usage') return send(wb.usage.summary(Math.min(90, Math.max(1, Number(c.url.searchParams.get('days')) || 7))));
    if (p === '/api/workbench/mcp') return send({ servers: wb.mcp.configs().map(x => ({ name: x.name, scope: x.scope, transport: x.def.transport, problem: x.problem ?? null })) });
    return send({ error: 'No such workbench route.' }, 404);
  }

  if (method === 'POST') {
    // Not caught on purpose: parseBody refuses anything that is not application/json (415), which is what stops a
    // page on another site from posting here with a plain form. Swallowing that would turn every route below into a CSRF hole.
    const body = obj(await c.parseBody(c.req, 256 * 1024));
    if (p === '/api/workbench/run') {
      const prompt = str(body.prompt, 100_000);
      if (!prompt?.trim()) return send({ error: 'Say what to do (prompt).' }, 400);
      const r = await c.within(() => wb.turn({ prompt, agent: str(body.agent, 64), session: str(body.session, 12), model: str(body.model, 64) }));
      return send(r, r.blocked ? 403 : 200);
    }
    if (p === '/api/workbench/undo' || p === '/api/workbench/redo') { const r = p === '/api/workbench/undo' ? wb.checkpoints.undo({ force: body.force === true }) : wb.checkpoints.redo({ force: body.force === true }); return send(r, r.ok ? 200 : 409); }
    if (p === '/api/workbench/rewind') {
      const what = body.what === 'conversation' || body.what === 'both' ? body.what : 'code';
      const r = wb.rewind(str(body.id, 16) ?? '', what, str(body.session, 12), body.force === true);
      return send(r, r.ok ? 200 : 409);
    }
    if (p === '/api/workbench/shares/revoke') return send({ ok: wb.sessions.revoke(str(body.token, 64) ?? '') });
    const fm = /^\/api\/workbench\/sessions\/([a-f0-9]{12})\/(fork|rename|share)$/.exec(p);
    if (fm) {
      const [, id, verb] = fm;
      if (verb === 'fork') { const h = wb.sessions.fork(id, typeof body.at === 'number' ? body.at : undefined); return h ? send(h) : send({ error: 'No such session.' }, 404); }
      if (verb === 'rename') return send({ ok: wb.sessions.rename(id, str(body.title, 120) ?? '') });
      const r = wb.sessions.share(id, typeof body.days === 'number' ? body.days : undefined);
      return send(r, r.ok ? 200 : 409);
    }
    return send({ error: 'No such workbench route.' }, 404);
  }
  return send({ error: 'Method not allowed.' }, 405);
}
