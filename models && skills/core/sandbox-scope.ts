/**
 * A sandbox for ONE call.
 *
 * The danger protocol's sandbox is a standing state of the agent: on or off
 * for everything it does. The security model (security-model.ts) needs a
 * smaller thing: "run this one request, and only this one, inside the sandbox".
 * This is that, and nothing else. It carries a single flag along with the
 * running code (AsyncLocalStorage, like user-context.ts), so the flag follows
 * the awaits and timers the call starts and cannot leak into a call running at
 * the same moment for someone else.
 *
 * What the flag does is decided where the work is done, not here:
 *   - danger-protocol.ts `sandboxRoot()` answers with the sandbox folder while
 *     the flag is set, which is what the access layer (access-manager.ts) asks
 *     for every check, so it then refuses everything outside that folder
 *     (terminals, windows, processes, services, devices, the network) and holds
 *     file access inside it.
 *   - plugins/file-system.ts confines every path to the sandbox folder while
 *     the flag is set, symlinks followed.
 *
 * It is a hard wall only for what goes through those two places. A tool that
 * reaches the outside some other way (email, messages, a web page, a publish)
 * is not contained by this flag, so the security model never answers "sandbox"
 * for one (CONTAINABLE in security-model.ts); it refuses it instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<true>();

/** Run `fn` with the sandbox flag set. Everything it starts sees the same flag. */
export function runSandboxed<T>(fn: () => T): T {
  return scope.run(true, fn);
}

/** Whether the running code is inside a one-call sandbox. */
export function inSandboxScope(): boolean {
  return scope.getStore() === true;
}
