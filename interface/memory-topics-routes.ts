/**
 * HTTP routes for the folder-tree memory (models && skills/core/memory-folders.ts),
 * so the Memory tab, the owner and other tools can browse, search and edit
 * the same notes the agent keeps.
 *
 * Behind the server's normal gate, like every /api route. Every write reads a
 * JSON body (parseBody insists on a JSON content type, which is the server's
 * guard against another tab posting here). Per person: the store follows
 * dataDir(), so each account sees only its own notes.
 *
 *   GET    /api/memory-topics                      the whole tree
 *   GET    /api/memory-topics?folder=projects      one subtree
 *   GET    /api/memory-topics/search?q=garden      notes ranked by topic words
 *   GET    /api/memory-topics/note?path=a/b        one note with its text
 *   PUT    /api/memory-topics/note                 {path, content}  create or replace
 *   POST   /api/memory-topics/append               {path, text}     add a dated line
 *   POST   /api/memory-topics/move                 {from, to}       re-file a note or folder
 *   DELETE /api/memory-topics?path=a/b[&recursive=1]  forget a note or folder
 */

import type http from "node:http";
import { MemoryFolderError, MemoryFolders } from "../models && skills/core/memory-folders.js";

export interface MemoryTopicsContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
}

const BODY_LIMIT = 64 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isMemoryTopicsRoute = (pathname: string): boolean => pathname === "/api/memory-topics" || pathname.startsWith("/api/memory-topics/");

/** Returns true when the route was handled. */
export async function handleMemoryTopicsRoutes(ctx: MemoryTopicsContext): Promise<boolean> {
  if (!isMemoryTopicsRoute(ctx.pathname)) return false;
  try {
    return await route(ctx);
  } catch (err) {
    const status = err instanceof MemoryFolderError ? err.status : /Not logged in/.test(String((err as Error)?.message)) ? 401 : 500;
    ctx.sendJson(ctx.res, { error: err instanceof Error ? err.message : String(err) }, status);
    return true;
  }
}

async function route(ctx: MemoryTopicsContext): Promise<boolean> {
  const { pathname, method, req, res, url } = ctx;
  const send = (data: unknown, status = 200): true => {
    ctx.sendJson(res, data, status);
    return true;
  };
  const body = async (): Promise<Record<string, unknown>> => {
    const b = await ctx.parseBody(req, BODY_LIMIT);
    if (!isObj(b)) throw new MemoryFolderError("Expected a JSON object.");
    return b;
  };
  const store = new MemoryFolders();

  if (pathname === "/api/memory-topics" && method === "GET") {
    return send({ notes: store.count(), tree: store.tree(url.searchParams.get("folder") ?? "") });
  }

  if (pathname === "/api/memory-topics/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
    return send({ query: q, hits: store.search(q, limit) });
  }

  if (pathname === "/api/memory-topics/note") {
    if (method === "GET") return send(store.read(url.searchParams.get("path") ?? ""));
    if (method === "PUT") {
      const b = await body();
      return send(store.write(String(b.path ?? ""), typeof b.content === "string" ? b.content : ""));
    }
  }

  if (pathname === "/api/memory-topics/append" && method === "POST") {
    const b = await body();
    return send(store.append(String(b.path ?? ""), typeof b.text === "string" ? b.text : ""));
  }

  if (pathname === "/api/memory-topics/move" && method === "POST") {
    const b = await body();
    return send(store.move(String(b.from ?? ""), String(b.to ?? "")));
  }

  if (pathname === "/api/memory-topics" && method === "DELETE") {
    const removed = store.remove(url.searchParams.get("path") ?? "", { recursive: url.searchParams.get("recursive") === "1" });
    return send({ removed });
  }

  return false;
}
