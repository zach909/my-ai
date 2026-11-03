/** node:net for the phone: no raw sockets. Only the address checks work. */
import { notOnPhone } from './host';
export function isIPv4(s: string): boolean { return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s); }
export function isIPv6(s: string): boolean { return s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s); }
export function isIP(s: string): 0 | 4 | 6 { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }
export function connect(): never { throw notOnPhone('A raw network connection'); }
export const createConnection = connect;
export function createServer(): never { throw notOnPhone('A raw network server'); }
export class Socket { constructor() { throw notOnPhone('A raw network connection'); } }
export default { isIP, isIPv4, isIPv6, connect, createConnection, createServer, Socket };
