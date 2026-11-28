/**
 * Offline mode and the one door out.
 *
 * With offline mode on, nothing in the workbench may reach a host that is not on this machine. Every outbound
 * request the workbench makes (tool-server HTTP, language-server downloads, anything added later) asks
 * `assertEgress(url)` first. Web search through the operator's own SearXNG stays allowed only when that instance
 * is on this machine; a SearXNG on another host is refused while offline mode is on.
 *
 * It is a check at the doors the workbench controls, not a firewall. A tool the agent starts on its own can still
 * open a socket; for that, use the operating system's own firewall or the sandbox. The error says so when it fires.
 */
import { readFileSync } from 'node:fs';
import { managedFile, workbenchRoot } from './paths.js';
import path from 'node:path';

let override: boolean | null = null;

export function setOffline(on: boolean | null): void { override = on; }

function managedOffline(): boolean {
  try { return JSON.parse(readFileSync(managedFile(), 'utf8'))?.offline === true; } catch { return false; }
}

let cached: { at: number; value: boolean } = { at: 0, value: false };

/** The owner's own switch, `"offline": true` in the workbench settings file. Re-read at most every two seconds. */
function userOffline(): boolean {
  const now = Date.now();
  if (now - cached.at < 2000) return cached.value;
  let v = false;
  try { v = JSON.parse(readFileSync(path.join(workbenchRoot(), 'settings.json'), 'utf8'))?.offline === true; } catch { /* not set */ }
  cached = { at: now, value: v };
  return v;
}

/** Offline when the administrator says so, or NEUROCLAW_OFFLINE=1, or the owner switched it on. An administrator's setting cannot be switched off from here. */
export function isOffline(): boolean {
  if (managedOffline()) return true;
  if (override !== null) return override;
  return (process.env.NEUROCLAW_OFFLINE ?? '').trim() === '1' || userOffline();
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

export function isLocalHost(host: string): boolean { return LOOPBACK.test(host.trim()); }

export class EgressBlocked extends Error {
  constructor(readonly url: string, readonly purpose: string) {
    super(`Offline mode is on, so ${purpose} may not reach ${url}. Only this machine (localhost) is allowed. Turn offline mode off to use it.`);
  }
}

export function assertEgress(url: string, purpose: string): void {
  if (!isOffline()) return;
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new EgressBlocked(url, purpose); }
  if (!isLocalHost(host)) throw new EgressBlocked(url, purpose);
}
