#!/usr/bin/env node
/**
 * Fixed-name copies of the release files, so one link always downloads the newest build:
 *
 *   neuroclaw-1.2.3-linux-x64.deb   ->  neuroclaw-linux-x64.deb
 *   neuroclaw-chrome-extension-1.2.3.zip -> neuroclaw-chrome-extension.zip
 *
 *   node scripts/release/latest-aliases.mjs <artifactsDir>
 *
 * GitHub serves  <repo>/releases/latest/download/<file>  for the newest published release, but only by exact file
 * name, and the real names carry the version. The copies are byte-identical, so SHA256SUMS for the versioned
 * file covers them too; release-manifest.json ignores them (it only lists the versioned names). Node built-ins only.
 */
import { copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authority } from './version.mjs';

/** The fixed name for a versioned release file, or null when the file is not one. */
export function aliasName(name, version) {
  if (!name.startsWith('neuroclaw-') || !name.includes(`-${version}`)) return null;
  if (!/\.(deb|tar\.gz|exe|zip|dmg|apk)$/.test(name)) return null;
  const alias = name.replace(`-${version}`, '');
  return alias === name ? null : alias;
}

export function writeAliases(dir, version = authority()) {
  const made = [];
  for (const name of readdirSync(dir).sort()) {
    const alias = aliasName(name, version);
    if (alias) { copyFileSync(path.join(dir, name), path.join(dir, alias)); made.push(alias); }
  }
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: latest-aliases.mjs <artifactsDir>'); process.exit(2); }
  for (const a of writeAliases(path.resolve(dir))) console.log(a);
}
