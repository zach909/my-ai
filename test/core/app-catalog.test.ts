/**
 * App catalog: an app's commands, each with a short entry in the app's own words, published as a wiki page
 * the AI is handed when it looks for a skill for that app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppCatalogError, buildAppSkill, collectApp, parseHelp, renderAppPage } from '../../models && skills/core/app-catalog.js';
import { buildAgentCapabilities } from '../../models && skills/core/agent-capabilities.js';

const GIT_HELP = `usage: git [-v | --version] [-h | --help] <command> [<args>]

These are common Git commands used in various situations:

start a working area
   clone     Clone a repository into a new directory
   init      Create an empty Git repository

work on the current change
   add       Add file contents to the index
   commit    Record changes to the repository
             (this description wraps onto a second line)

Options:
  -v, --version     Print the version
      --no-pager    Do not pipe output into a pager
`;

describe('parseHelp', () => {
  test('finds usage, subcommands with their descriptions, and options', () => {
    const h = parseHelp(GIT_HELP);
    expect(h.usage).toContain('git [-v');
    expect(h.commands.map((c) => c.name)).toEqual(['clone', 'init', 'add', 'commit']);
    expect(h.commands.find((c) => c.name === 'commit')!.summary).toBe('Record changes to the repository (this description wraps onto a second line)');
    expect(h.options.map((o) => o.name)).toEqual(['-v, --version', '--no-pager']);
  });
  test('a command with no description says so instead of getting an invented one', () => {
    const h = parseHelp('Commands:\n  alpha\n  beta     Does beta\n');
    expect(h.commands.find((c) => c.name === 'beta')!.summary).toBe('Does beta');
  });
});

describe('collectApp / buildAppSkill', () => {
  let tmp: string;
  let prevStore: string | undefined;
  beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'app-catalog-')); prevStore = process.env.NEUROCLAW_STORE_DIR; process.env.NEUROCLAW_STORE_DIR = path.join(tmp, 'store'); });
  afterEach(() => { if (prevStore === undefined) delete process.env.NEUROCLAW_STORE_DIR; else process.env.NEUROCLAW_STORE_DIR = prevStore; rmSync(tmp, { recursive: true, force: true }); });

  const fakeBin = (name: string) => { const dir = path.join(tmp, 'bin'); mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); return dir; };

  test('a command-line app: its --help becomes commands and options', () => {
    const binDir = fakeBin('git');
    const c = collectApp('git', { pathVar: binDir, run: () => GIT_HELP, desktopDirs: [] });
    expect(c.commands).toHaveLength(4);
    expect(c.sources[0]).toMatch(/^git --help \(run on this computer/);
  });

  test('a graphical app: the app and its declared actions become controls, and the page says what is not read', () => {
    const dir = path.join(tmp, 'applications'); mkdirSync(dir);
    writeFileSync(path.join(dir, 'org.example.Browse.desktop'),
      '[Desktop Entry]\nType=Application\nName=Browse\nComment=Browse the web\nExec=browse %u\nActions=new-window;private;\n\n' +
      '[Desktop Action new-window]\nName=New Window\nExec=browse --new-window\n\n[Desktop Action private]\nName=New Private Window\nComment=Open a window that keeps no history\nExec=browse --private\n');
    const c = collectApp('browse', { pathVar: '', desktopDirs: [dir] });
    expect(c.controls.map((e) => e.name)).toEqual(['Open Browse', 'New Window', 'New Private Window']);
    expect(c.controls[1].summary).toBe('Runs: browse --new-window');
    expect(c.notes.join(' ')).toMatch(/accessibility/);
  });

  test('an app that is not here throws a plain error and publishes nothing', () => {
    expect(() => buildAppSkill('nonexistent-app-xyz', { pathVar: '', desktopDirs: [] })).toThrow(AppCatalogError);
  });

  test('bad names are refused before anything runs', () => {
    for (const bad of ['', '../x', 'a b', 'a;b', '-h']) expect(() => collectApp(bad, { run: () => { throw new Error('ran'); } })).toThrow(AppCatalogError);
  });

  test('the page names every command up front, and the AI is handed the entries when it searches for the app', () => {
    const binDir = fakeBin('git');
    const { page } = buildAppSkill('git', { pathVar: binDir, run: () => GIT_HELP, desktopDirs: [] });
    expect(page.name).toBe('apps/git');
    expect(page.description).toMatch(/commit/);
    const caps = buildAgentCapabilities({} as never);
    const found = caps.searchWiki!('how do I commit with git') as string[];
    const hit = found.find((l) => l.startsWith('wiki/apps/git'))!;
    expect(hit).toContain('### commit');
    expect(hit).toContain('Record changes to the repository');
  });

  test('renderAppPage never invents text for a command the app did not describe', () => {
    const p = renderAppPage({ app: 'x', about: '', usage: '', commands: [{ name: 'go', summary: '(the app gives no description)' }], options: [], controls: [], sources: ['x --help'], notes: [] });
    expect(p.content).toContain('### go\n(the app gives no description)');
  });
});
