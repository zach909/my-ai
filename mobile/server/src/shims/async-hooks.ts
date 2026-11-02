/**
 * node:async_hooks for the phone: AsyncLocalStorage. The engine uses it to know which person a request belongs to.
 * A phone has one person, so the store is held for as long as the function that was given it is running (and until
 * its promise settles); requests that overlap see the same person anyway.
 */
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  private depth = 0;
  run<R>(store: T, fn: (...a: any[]) => R, ...args: any[]): R {
    const previous = this.store;
    this.store = store; this.depth++;
    const restore = () => { if (--this.depth === 0) this.store = previous; };
    let result: R;
    try { result = fn(...args); } catch (e) { restore(); throw e; }
    if (result && typeof (result as any).then === 'function') { (result as any).then(restore, restore); return result; }
    restore();
    return result;
  }
  exit<R>(fn: (...a: any[]) => R, ...args: any[]): R { const s = this.store; this.store = undefined; try { return fn(...args); } finally { this.store = s; } }
  getStore(): T | undefined { return this.store; }
  enterWith(store: T): void { this.store = store; }
  disable(): void { this.store = undefined; }
}
export class AsyncResource { constructor(_t?: string) {} runInAsyncScope<R>(fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R { return fn.apply(thisArg, args); } }
export default { AsyncLocalStorage, AsyncResource };
