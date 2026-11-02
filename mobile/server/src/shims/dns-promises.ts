/** node:dns/promises for the phone: a WebView cannot look up addresses itself; the network does it when a request is made. */
import { notOnPhone } from './host';
export async function lookup(): Promise<never> { throw notOnPhone('Looking up an address'); }
export async function resolve(): Promise<never> { throw notOnPhone('Looking up an address'); }
export default { lookup, resolve };
