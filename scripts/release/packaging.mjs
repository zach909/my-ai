/**
 * Shared helpers for the platform packagers (Linux, Windows, macOS):
 * artifact names, permission normalisation, and the one desktop entry text.
 * Node built-ins only.
 */
import { chmodSync, cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'NeuroClaw';
export const APP_ID = 'neuroclaw';
export const APP_SUMMARY = 'Local-first AI agent: one engine on this computer, no account and no cloud required.';

/** Chrome/Debian use different architecture names; artifacts and the manifest use x64 and arm64. */
export const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' };

export function artifactName({ version, platform, arch, ext }) {
  return `neuroclaw-${version}-${platform}-${arch}.${ext}`;
}

/** Directories 755, files 644, so a package never carries the build machine's umask. Executables are set afterwards. */
export function normalizeModes(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { chmodSync(p, 0o755); normalizeModes(p); }
    else chmodSync(p, 0o644);
  }
  chmodSync(dir, 0o755);
}

export function desktopEntry({ exec }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_NAME}`,
    `Comment=${APP_SUMMARY}`,
    `Exec=${exec}`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=Utility;Science;',
    'Keywords=AI;agent;chat;assistant;',
    'StartupNotification=false',
    `StartupWMClass=${APP_ID}`,
    '',
  ].join('\n');
}

export const APP_URL = 'https://github.com/zach909/my-ai';
export const APP_DESKTOP_ID = `${APP_ID}.desktop`;

/** AppStream metadata: what GNOME Settings > Apps, GNOME Software and KDE Discover read to show the app's name, summary, link and icon. */
export function metainfo({ version, date }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${APP_ID}</id>
  <metadata_license>CC0-1.0</metadata_license>
  <name>${APP_NAME}</name>
  <summary>${APP_SUMMARY}</summary>
  <description>
    <p>${APP_NAME} runs one AI engine on this computer and opens it in its own window. It needs no account and no cloud, and it opens no network port.</p>
  </description>
  <launchable type="desktop-id">${APP_DESKTOP_ID}</launchable>
  <url type="homepage">${APP_URL}</url>
  <url type="bugtracker">${APP_URL}/issues</url>
  <developer_name>zach909</developer_name>
  <provides><binary>${APP_ID}</binary></provides>
  <categories><category>Utility</category></categories>
  <releases><release version="${version}" date="${date}"/></releases>
</component>
`;
}

export function writeFile(file, text, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
}

export function copyTree(from, to) {
  cpSync(from, to, { recursive: true });
}
