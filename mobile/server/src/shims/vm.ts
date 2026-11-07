/** node:vm for the phone: a code sandbox cannot be made safely here, so running code in one is refused in plain words. */
import { notOnPhone } from './host';
export class Script { constructor(_code?: string, _o?: unknown) { throw notOnPhone('Running code in a sandbox'); } runInContext(): never { throw notOnPhone('Running code in a sandbox'); } runInNewContext(): never { throw notOnPhone('Running code in a sandbox'); } }
export function createContext(o: object = {}): object { return o; }
export function isContext(): boolean { return false; }
export function runInContext(): never { throw notOnPhone('Running code in a sandbox'); }
export function runInNewContext(): never { throw notOnPhone('Running code in a sandbox'); }
export function runInThisContext(): never { throw notOnPhone('Running code in a sandbox'); }
export default { Script, createContext, isContext, runInContext, runInNewContext, runInThisContext };
