/**
 * HTTP routes for hosted mode (models && skills/core/hosted.ts): an account makes
 * tokens for its own NeuroClaw, the admin sets the limits.
 *
 *   GET    /api/hosted/status         is hosting on, the account's own usage; the admin also gets the limits and why it is locked
 *   GET    /api/hosted/tokens         your tokens (never the secret part)
 *   POST   /api/hosted/tokens         {label}  make one; the token is shown once, here, and never again
 *   DELETE /api/hosted/tokens/:id     revoke one of your own
 *   POST   /api/hosted/settings       admin only: {enabled?, dailyCu?, perMinute?, maxConcurrent?, maxQueue?, maxPromptChars?, maxTokensPerAccount?}
 *
 * The guests' own calls (/api/corona/v1/compute/run and /lease with a hosted
 * token) are in corona-routes.ts, next to the lease ones they stand beside.
 *
 * Tokens belong to accounts. The machine's owner, when no account exists, has
 * nothing to make a token for: make an account on /accounts first.
 */

import type http from "node:http";
import { getAccounts } from "../models && skills/core/accounts.js";
import { getHosted, HostedError, type HostedService } from "../models && skills/core/hosted.js";
import { isOwnerOrAdmin, who } from "../models && skills/core/user-context.js";
import { VaultError } from "../models && skills/core/vault.js";

export interface HostedRoutesContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  method: string;
  parseBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  sendJson(res: http.ServerResponse, data: unknown, status?: number): void;
}

export const isHostedRoute = (pathname: string): boolean => pathname.startsWith("/api/hosted/");

/** The server's hosted service, with "active" meaning an account that exists and is not disabled. */
export function hostedService(): HostedService {
  return getHosted(id => {
    try { return getAccounts().listUsers().some(u => u.id === id && u.disabledAt === null); } catch { return false; }
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns true when the route was handled. */
export async function handleHostedRoutes(ctx: HostedRoutesContext): Promise<boolean> {
  if (!isHostedRoute(ctx.pathname)) return false;
  const { pathname, method, req, res } = ctx;
  const send = (data: unknown, status = 200): true => { ctx.sendJson(res, data, status); return true; };
  try {
    const hosted = hostedService();
    const me = who();
    const admin = isOwnerOrAdmin();
    const accountId = (): string => {
      if (me.kind !== "user") throw new HostedError("Tokens belong to accounts. Make an account on /accounts first.", 400);
      return me.id;
    };

    if (pathname === "/api/hosted/status" && method === "GET") {
      const st = hosted.status();
      const usage = st.available && me.kind === "user" ? hosted.usage(me.id) : null;
      if (admin) return send({ ...st, usage });
      // Everyone else learns whether it is on and what their own day looks like, nothing about how it is set up.
      return send({ available: st.available, enabled: st.enabled, limits: st.settings ? { dailyCu: st.settings.dailyCu, perMinute: st.settings.perMinute, maxPromptChars: st.settings.maxPromptChars } : null, usage });
    }
    if (pathname === "/api/hosted/tokens" && method === "GET") {
      return send({ tokens: hosted.listTokens(accountId()) });
    }
    if (pathname === "/api/hosted/tokens" && method === "POST") {
      const id = accountId();
      const body = await ctx.parseBody(req, 4096);
      const st = hosted.status();
      // Locked is not the same as switched off, and the reason is the admin's to read, not a guest's.
      if (!st.available) throw new HostedError("Hosting is unavailable on this computer right now.", 503);
      if (!st.enabled) throw new HostedError("This computer is not hosting right now.", 403);
      const made = hosted.createToken(id, isObj(body) && typeof body.label === "string" ? body.label : "");
      return send({ ...made, note: "Copy this token now. It is not stored and cannot be shown again." }, 201);
    }
    const m = /^\/api\/hosted\/tokens\/([0-9a-f]{16})$/.exec(pathname);
    if (m && method === "DELETE") {
      return send({ revoked: hosted.revokeToken(accountId(), m[1]) });
    }
    if (pathname === "/api/hosted/settings" && method === "POST") {
      if (!admin) throw new HostedError("Only the admin can do that.", 403);
      return send({ settings: hosted.setSettings(await ctx.parseBody(req, 4096)) });
    }
    return false;
  } catch (err) {
    const status = err instanceof HostedError || err instanceof VaultError ? err.status : typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return send({ error: err instanceof Error ? err.message : String(err) }, status);
  }
}
