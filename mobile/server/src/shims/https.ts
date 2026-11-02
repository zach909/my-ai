/** node:https for the phone: outbound requests from the engine go through fetch, which the host provides; this module is only the shape. */
import { notOnPhone } from './host';
export function request(): never { throw notOnPhone('Making a request with node:https'); }
export function get(): never { throw notOnPhone('Making a request with node:https'); }
export class Agent { constructor(_o?: unknown) {} destroy(): void {} }
export const globalAgent = new Agent();
export default { request, get, Agent, globalAgent };
