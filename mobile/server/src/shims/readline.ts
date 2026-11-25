/** node:readline for the phone: there is no terminal. */
import { EventEmitter } from './events';
export function createInterface(): EventEmitter & { close(): void; question(q: string, cb: (a: string) => void): void; prompt(): void; setPrompt(): void } {
  const i = new EventEmitter() as any;
  i.close = () => { i.emit('close'); }; i.question = () => {}; i.prompt = () => {}; i.setPrompt = () => {};
  return i;
}
export default { createInterface };
