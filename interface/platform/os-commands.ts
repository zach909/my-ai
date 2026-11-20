/**
 * OS commands: the deepest AI OS layer, native on each system.
 *
 *   Linux    systemd, ps, ip, df, ls   (the tools every Linux install has)
 *   Windows  PowerShell cmdlets        (Get-Service, Get-Process, Get-Acl ...)
 *   macOS    launchctl, ps, ifconfig, df, sw_vers
 *
 * Every command is a fixed entry in a table below: a program and an argument list built from a validated
 * word, never a string handed to a shell. A request that is not in the table is refused, so nothing a model
 * writes is ever executed as code here. Commands that only look are "inspect"; commands that change
 * something (stop a service, end a process) are "control" and the plugin reports them as actions, so the
 * normal tool gate holds them for a person. Nothing here elevates: it runs as the signed-in user, and a
 * command the user is not allowed to run fails with the system's own message.
 *
 * Pure and testable: resolving a request never touches the machine, and running takes an injectable runner.
 * Node built-ins only.
 */

import { execFile } from 'node:child_process';

export type OsFamily = 'linux' | 'windows' | 'macos';
export type OsRisk = 'inspect' | 'control';

export interface OsInvocation {
  /** Program to run. */
  file: string;
  args: string[];
  /** Extra environment (used to pass values into PowerShell without building script text from them). */
  env?: Record<string, string>;
}

export interface ResolvedOsCommand {
  name: string;
  risk: OsRisk;
  invocation: OsInvocation;
}

export type OsParse = { ok: true; command: ResolvedOsCommand } | { ok: false; reason: string };

export function osFamily(platform: NodeJS.Platform = process.platform): OsFamily | null {
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return null;
}

const NAME_RE = /^[A-Za-z0-9_.@:+-]{1,128}$/;
const PID_RE = /^[0-9]{1,9}$/;
const MAX_PATH = 1024;

export const POWERSHELL = 'powershell.exe';
/** A fixed PowerShell script; the one variable part comes in through $env:OSAI_ARG, never inside the script text. */
function ps(script: string, arg?: string): OsInvocation {
  return {
    file: POWERSHELL,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    env: arg === undefined ? undefined : { OSAI_ARG: arg },
  };
}

interface Spec {
  name: string;
  risk: OsRisk;
  help: string;
  /** What the word after the command name must be: nothing, a service/unit name, a process id, or a path. */
  takes: 'none' | 'name' | 'pid' | 'path';
  build: Record<OsFamily, (arg: string, uid: number) => OsInvocation>;
}

const SPECS: Spec[] = [
  {
    name: 'info', risk: 'inspect', takes: 'none', help: 'Operating system name and version.',
    build: {
      linux: () => ({ file: 'uname', args: ['-a'] }),
      macos: () => ({ file: 'sw_vers', args: [] }),
      windows: () => ps('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | Format-List'),
    },
  },
  {
    name: 'uptime', risk: 'inspect', takes: 'none', help: 'How long the computer has been on.',
    build: {
      linux: () => ({ file: 'uptime', args: [] }),
      macos: () => ({ file: 'uptime', args: [] }),
      windows: () => ps('(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | Format-List Days,Hours,Minutes'),
    },
  },
  {
    name: 'processes', risk: 'inspect', takes: 'none', help: 'The busiest processes.',
    build: {
      linux: () => ({ file: 'ps', args: ['-eo', 'pid,user,pcpu,pmem,comm', '--sort=-pcpu'] }),
      macos: () => ({ file: 'ps', args: ['-Ao', 'pid,user,pcpu,pmem,comm', '-r'] }),
      windows: () => ps('Get-Process | Sort-Object CPU -Descending | Select-Object -First 40 Id,ProcessName,CPU,WorkingSet | Format-Table -AutoSize'),
    },
  },
  {
    name: 'services', risk: 'inspect', takes: 'none', help: 'Every service the system manages for you.',
    build: {
      linux: () => ({ file: 'systemctl', args: ['--user', 'list-units', '--type=service', '--no-pager', '--plain'] }),
      macos: () => ({ file: 'launchctl', args: ['list'] }),
      windows: () => ps('Get-Service | Sort-Object Status,Name | Format-Table -AutoSize Status,Name,DisplayName'),
    },
  },
  {
    name: 'service', risk: 'inspect', takes: 'name', help: 'Status of one service: service NAME.',
    build: {
      linux: (n) => ({ file: 'systemctl', args: ['--user', 'status', n, '--no-pager'] }),
      macos: (n, uid) => ({ file: 'launchctl', args: ['print', `gui/${uid}/${n}`] }),
      windows: (n) => ps('Get-Service -Name $env:OSAI_ARG | Format-List Name,DisplayName,Status,StartType', n),
    },
  },
  {
    name: 'network', risk: 'inspect', takes: 'none', help: 'Network interfaces and addresses.',
    build: {
      linux: () => ({ file: 'ip', args: ['-brief', 'address'] }),
      macos: () => ({ file: 'ifconfig', args: ['-a'] }),
      windows: () => ps('Get-NetIPAddress | Select-Object InterfaceAlias,IPAddress,PrefixLength,AddressFamily | Format-Table -AutoSize'),
    },
  },
  {
    name: 'disks', risk: 'inspect', takes: 'none', help: 'Disk space.',
    build: {
      linux: () => ({ file: 'df', args: ['-h'] }),
      macos: () => ({ file: 'df', args: ['-h'] }),
      windows: () => ps('Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize Name,Used,Free,Root'),
    },
  },
  {
    name: 'users', risk: 'inspect', takes: 'none', help: 'Who is signed in.',
    build: {
      linux: () => ({ file: 'who', args: [] }),
      macos: () => ({ file: 'who', args: [] }),
      windows: () => ps('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; Get-CimInstance Win32_LogonSession | Select-Object LogonId,LogonType,StartTime | Format-Table -AutoSize'),
    },
  },
  {
    name: 'permissions', risk: 'inspect', takes: 'path', help: 'Who may do what with a file or folder: permissions PATH.',
    build: {
      linux: (p) => ({ file: 'ls', args: ['-ld', '--', p] }),
      macos: (p) => ({ file: 'ls', args: ['-lde', '--', p] }),
      windows: (p) => ps('Get-Acl -LiteralPath $env:OSAI_ARG | Format-List Owner,AccessToString', p),
    },
  },
  {
    name: 'start', risk: 'control', takes: 'name', help: 'Start a service: start NAME.',
    build: {
      linux: (n) => ({ file: 'systemctl', args: ['--user', 'start', n] }),
      macos: (n, uid) => ({ file: 'launchctl', args: ['kickstart', `gui/${uid}/${n}`] }),
      windows: (n) => ps('Start-Service -Name $env:OSAI_ARG; Get-Service -Name $env:OSAI_ARG | Format-List Name,Status', n),
    },
  },
  {
    name: 'stop', risk: 'control', takes: 'name', help: 'Stop a service: stop NAME.',
    build: {
      linux: (n) => ({ file: 'systemctl', args: ['--user', 'stop', n] }),
      macos: (n, uid) => ({ file: 'launchctl', args: ['kill', 'TERM', `gui/${uid}/${n}`] }),
      windows: (n) => ps('Stop-Service -Name $env:OSAI_ARG; Get-Service -Name $env:OSAI_ARG | Format-List Name,Status', n),
    },
  },
  {
    name: 'restart', risk: 'control', takes: 'name', help: 'Restart a service: restart NAME.',
    build: {
      linux: (n) => ({ file: 'systemctl', args: ['--user', 'restart', n] }),
      macos: (n, uid) => ({ file: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${n}`] }),
      windows: (n) => ps('Restart-Service -Name $env:OSAI_ARG; Get-Service -Name $env:OSAI_ARG | Format-List Name,Status', n),
    },
  },
  {
    name: 'kill', risk: 'control', takes: 'pid', help: 'End a process by id: kill PID.',
    build: {
      linux: (n) => ({ file: 'kill', args: ['-TERM', n] }),
      macos: (n) => ({ file: 'kill', args: ['-TERM', n] }),
      windows: (n) => ps('Stop-Process -Id ([int]$env:OSAI_ARG)', n),
    },
  },
];

/** The commands this system offers, with a one-line help each. */
export function listOsCommands(platform: NodeJS.Platform = process.platform): Array<{ name: string; risk: OsRisk; help: string }> {
  if (!osFamily(platform)) return [];
  return SPECS.map(({ name, risk, help }) => ({ name, risk, help }));
}

/** Turn "service sshd" into a program and arguments, or say why not. Never runs anything. */
export function parseOsCommand(request: string, platform: NodeJS.Platform = process.platform, uid: number = process.getuid?.() ?? 0, ownPid: number = process.pid): OsParse {
  const family = osFamily(platform);
  if (!family) return { ok: false, reason: `OS commands are not offered on ${platform}.` };
  if (typeof request !== 'string') return { ok: false, reason: 'The request must be text.' };
  const text = request.trim().replace(/^os\s*:?\s+/i, '');
  const m = text.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!m) return { ok: false, reason: `Say a command: ${SPECS.map((s) => s.name).join(', ')}.` };
  const spec = SPECS.find((s) => s.name === m[1].toLowerCase());
  if (!spec) return { ok: false, reason: `Unknown OS command "${m[1].slice(0, 40)}". Offered: ${SPECS.map((s) => s.name).join(', ')}.` };
  const rest = (m[2] ?? '').trim();

  if (spec.takes === 'none') {
    if (rest) return { ok: false, reason: `"${spec.name}" takes no argument.` };
    return { ok: true, command: { name: spec.name, risk: spec.risk, invocation: spec.build[family]('', uid) } };
  }
  if (!rest) return { ok: false, reason: `${spec.help}` };
  if (/\s/.test(rest) && spec.takes !== 'path') return { ok: false, reason: `"${spec.name}" takes one word.` };
  if (spec.takes === 'name' && !NAME_RE.test(rest)) return { ok: false, reason: 'A service name may only use letters, digits and _ . @ : + -.' };
  if (spec.takes === 'pid') {
    if (!PID_RE.test(rest)) return { ok: false, reason: 'A process id is a whole number.' };
    const pid = Number(rest);
    if (pid <= 1) return { ok: false, reason: 'That process id is reserved.' };
    if (pid === ownPid) return { ok: false, reason: 'The engine will not end its own process.' };
  }
  if (spec.takes === 'path') {
    // eslint-disable-next-line no-control-regex
    if (rest.length > MAX_PATH || /[\x00-\x1f]/.test(rest)) return { ok: false, reason: 'That path is not valid.' };
    if (rest.startsWith('-') && family !== 'windows') return { ok: false, reason: 'Give a path (start it with ./ if it begins with a dash).' };
  }
  return { ok: true, command: { name: spec.name, risk: spec.risk, invocation: spec.build[family](rest, uid) } };
}

export interface OsRunResult { status: number | null; stdout: string; stderr: string; error?: string }
export type OsRunner = (inv: OsInvocation) => Promise<OsRunResult>;

/** The real runner: no shell, a time limit, a size limit, no window on Windows. */
export const realOsRunner: OsRunner = (inv) => new Promise((resolve) => {
  execFile(inv.file, inv.args, {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
    env: { ...process.env, ...(inv.env ?? {}) },
  }, (err, stdout, stderr) => {
    if (!err) return resolve({ status: 0, stdout, stderr });
    const e = err as NodeJS.ErrnoException & { code?: number | string };
    if (e.code === 'ENOENT') return resolve({ status: null, stdout: '', stderr: '', error: `${inv.file} is not on this computer.` });
    resolve({ status: typeof e.code === 'number' ? e.code : null, stdout: stdout ?? '', stderr: stderr ?? '', error: typeof e.code === 'number' ? undefined : e.message });
  });
});

/** Parse and run one OS command; the text is what the layer hands back. */
export async function runOsCommand(request: string, run: OsRunner = realOsRunner, platform: NodeJS.Platform = process.platform): Promise<{ ran: boolean; risk?: OsRisk; text: string }> {
  const parsed = parseOsCommand(request, platform);
  if (parsed.ok === false) return { ran: false, text: parsed.reason };
  const out = await run(parsed.command.invocation);
  const body = (out.stdout || out.stderr || '').trim();
  if (out.error) return { ran: true, risk: parsed.command.risk, text: `${parsed.command.name} failed: ${out.error}` };
  if (out.status !== 0) return { ran: true, risk: parsed.command.risk, text: `${parsed.command.name} exited with ${out.status}. ${body}`.trim() };
  return { ran: true, risk: parsed.command.risk, text: body || `${parsed.command.name}: done.` };
}
