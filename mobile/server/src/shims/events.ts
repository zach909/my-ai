/** node:events for the phone: EventEmitter, written for this project (no library). */
type Listener = (...args: any[]) => void;

export class EventEmitter {
  private _events: Map<string | symbol, Array<{ fn: Listener; once: boolean }>> = new Map();
  private _max = 10;
  static defaultMaxListeners = 10;

  on(name: string | symbol, fn: Listener): this { return this.addListener(name, fn); }
  addListener(name: string | symbol, fn: Listener): this { this._add(name, fn, false, false); return this; }
  prependListener(name: string | symbol, fn: Listener): this { this._add(name, fn, false, true); return this; }
  once(name: string | symbol, fn: Listener): this { this._add(name, fn, true, false); return this; }
  prependOnceListener(name: string | symbol, fn: Listener): this { this._add(name, fn, true, true); return this; }
  off(name: string | symbol, fn: Listener): this { return this.removeListener(name, fn); }
  removeListener(name: string | symbol, fn: Listener): this {
    const list = this._events.get(name);
    if (!list) return this;
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this._events.delete(name);
    return this;
  }
  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this._events.clear(); else this._events.delete(name);
    return this;
  }
  emit(name: string | symbol, ...args: any[]): boolean {
    const list = this._events.get(name);
    if (!list || list.length === 0) {
      if (name === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error event: ${String(args[0])}`);
      return false;
    }
    for (const l of [...list]) {
      if (l.once) this.removeListener(name, l.fn);
      l.fn.apply(this, args);
    }
    return true;
  }
  listeners(name: string | symbol): Listener[] { return (this._events.get(name) ?? []).map((l) => l.fn); }
  rawListeners(name: string | symbol): Listener[] { return this.listeners(name); }
  listenerCount(name: string | symbol): number { return (this._events.get(name) ?? []).length; }
  eventNames(): Array<string | symbol> { return [...this._events.keys()]; }
  setMaxListeners(n: number): this { this._max = n; return this; }
  getMaxListeners(): number { return this._max; }

  private _add(name: string | symbol, fn: Listener, once: boolean, prepend: boolean): void {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    let list = this._events.get(name);
    if (!list) { list = []; this._events.set(name, list); }
    if (prepend) list.unshift({ fn, once }); else list.push({ fn, once });
  }
}

/** events.once(emitter, name): a promise for the first emission. */
export function once(emitter: EventEmitter, name: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const onError = (e: unknown) => { emitter.removeListener(name, onEvent); reject(e); };
    const onEvent = (...args: any[]) => { emitter.removeListener('error', onError); resolve(args); };
    emitter.once(name, onEvent);
    if (name !== 'error') emitter.once('error', onError);
  });
}

export default EventEmitter;
export { EventEmitter as EventEmitterClass };
