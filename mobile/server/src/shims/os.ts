/** node:os for the phone: what a phone can truthfully say about itself. */
export const EOL = '\n';
export const devNull = '/dev/null';
export function platform(): string { return 'android'; }
export function type(): string { return 'Linux'; }
export function arch(): string { return 'arm64'; }
export function release(): string { return 'android'; }
export function version(): string { return 'android'; }
export function homedir(): string { return '/phone/home'; }
export function tmpdir(): string { return '/phone/tmp'; }
export function hostname(): string { return 'phone'; }
export function endianness(): 'LE' { return 'LE'; }
export function uptime(): number { return Math.round((typeof performance !== 'undefined' ? performance.now() : 0) / 1000); }
export function loadavg(): number[] { return [0, 0, 0]; }
export function cpus(): Array<{ model: string; speed: number; times: Record<string, number> }> {
  const n = Math.max(1, (globalThis as any).navigator?.hardwareConcurrency ?? 4);
  return Array.from({ length: n }, () => ({ model: 'phone', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
}
export function totalmem(): number { return ((globalThis as any).navigator?.deviceMemory ?? 4) * 1024 * 1024 * 1024; }
export function freemem(): number { return Math.round(totalmem() / 4); }
export function networkInterfaces(): Record<string, never[]> { return {}; }
export function userInfo(): { username: string; uid: number; gid: number; shell: string; homedir: string } {
  return { username: 'phone', uid: 0, gid: 0, shell: '', homedir: homedir() };
}
export default { EOL, devNull, platform, type, arch, release, version, homedir, tmpdir, hostname, endianness, uptime, loadavg, cpus, totalmem, freemem, networkInterfaces, userInfo };
