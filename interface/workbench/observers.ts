/**
 * The one place file changes are announced.
 *
 * Anything that is about to write or delete a file calls `fileWillChange(absolutePath)` first. Whoever is listening
 * (the workbench's checkpoint store, today) gets the path while the file still has its old content. A listener that
 * throws is ignored: a bookkeeping failure must never stop or change the write it was watching.
 */
type Listener = (absolutePath: string) => void;

const listeners = new Set<Listener>();

export function onFileWillChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function fileWillChange(absolutePath: string): void {
  for (const fn of listeners) { try { fn(absolutePath); } catch { /* never block the write */ } }
}
