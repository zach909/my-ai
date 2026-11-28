#!/usr/bin/env node
/**
 * Writes the README's animations and its HTML version. Node built-ins only; every drawing is plain SVG with CSS
 * keyframes, so GitHub animates them inside README.md (as images) and a browser animates them in docs/index.html.
 *
 *   node scripts/release/build-readme.mjs [--check]
 *
 * Output:  docs/media/{hero,mesh,experts,bits,learning,private,extensions}.svg   and   docs/index.html
 * --check  fails when a committed file differs from what this script writes.
 *
 * The look is the project's (AGENTS.md): soft coral on warm dark, no blue, everything round, system rounded type,
 * no fonts or libraries fetched. Animation respects prefers-reduced-motion (it stops).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL } from './packaging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');

const C = { bg1: '#1b1216', bg0: '#110c0e', text: '#f8ede9', dim: 'rgba(248,237,233,.62)', coral: '#e3a99d', soft: '#efd0c8', deep: '#c98476', line: 'rgba(255,228,218,.2)', green: '#8fe3a8', yellow: '#f2d56b' };
const FONT = "ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'Segoe UI',sans-serif";

/** One animated card: 480x300, glass panel, caption underneath the drawing. */
function card({ id, title, caption, css = '', body, defs = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" width="480" height="300" role="img" aria-labelledby="t-${id}">
<title id="t-${id}">${title}</title>
<defs>
<linearGradient id="bg-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>
<radialGradient id="glow-${id}"><stop offset="0" stop-color="${C.coral}" stop-opacity=".35"/><stop offset="1" stop-color="${C.coral}" stop-opacity="0"/></radialGradient>
${defs}
</defs>
<style>
text{font-family:${FONT};fill:${C.text}}
.dim{fill:${C.dim}}
.line{fill:none;stroke:${C.line};stroke-width:1.5}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
${css}
</style>
<rect width="480" height="300" rx="32" fill="url(#bg-${id})"/>
<rect x=".75" y=".75" width="478.5" height="298.5" rx="31.5" fill="none" stroke="${C.line}"/>
${body}
<text x="240" y="276" text-anchor="middle" font-size="15" class="dim">${caption}</text>
</svg>
`;
}

/** The little agent: green body, tentacle lobes, eyes and the yellow smiley, at (x,y) with radius r. */
function agent(x, y, r, extra = '') {
  const lobes = Array.from({ length: 7 }, (_, t) => {
    const a = 0.38 + (t / 7) * Math.PI * 2;
    return `<circle cx="${(x + Math.cos(a) * r * 1.02).toFixed(1)}" cy="${(y + Math.sin(a) * r * 0.98 + r * 0.06).toFixed(1)}" r="${(r * 0.36).toFixed(1)}" fill="${C.green}"/>`;
  }).join('');
  const eye = (ex, ey, er) => `<circle cx="${(x + ex * r).toFixed(1)}" cy="${(y + ey * r).toFixed(1)}" r="${(er * r).toFixed(1)}" fill="#f8f2e6"/><circle cx="${(x + ex * r).toFixed(1)}" cy="${(y + ey * r).toFixed(1)}" r="${(er * r * 0.5).toFixed(1)}" fill="#1a1013"/>`;
  return `<g ${extra}>${lobes}<circle cx="${x}" cy="${y + r * 0.04}" r="${r}" fill="${C.green}"/>
${eye(-0.62, -0.5, 0.17)}${eye(0.66, -0.36, 0.14)}${eye(-0.74, 0.12, 0.11)}${eye(0.7, 0.28, 0.12)}
<circle cx="${x}" cy="${y + r * 0.1}" r="${r * 0.5}" fill="${C.yellow}"/>
<circle cx="${x - r * 0.18}" cy="${y + r * 0.0}" r="${r * 0.055}" fill="#33201a"/><circle cx="${x + r * 0.18}" cy="${y + r * 0.0}" r="${r * 0.055}" fill="#33201a"/>
<path d="M ${x - r * 0.26} ${y + r * 0.16} Q ${x} ${y + r * 0.42} ${x + r * 0.26} ${y + r * 0.16}" fill="none" stroke="#33201a" stroke-width="${Math.max(1.4, r * 0.05)}" stroke-linecap="round"/></g>`;
}

/** The coral cord: one smooth closed wave, six rises and six dips, seen at a tilt. */
function ring(cx, cy, R, width) {
  const pts = [];
  for (let n = 0; n <= 360; n++) {
    const th = (n / 360) * Math.PI * 2;
    const rad = R * (1.04 - 0.14 * (0.5 + 0.5 * Math.cos(12 * th)));
    pts.push([cx + rad * Math.cos(th), cy + rad * Math.sin(th) * 0.5 + R * 0.085 * Math.cos(6 * th) * 0.8]);
  }
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z';
}

const files = {};

// ---- hero: the cord flipping end over end around the glowing sphere, the agent inside ----
files['docs/media/hero.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360" role="img" aria-labelledby="t-hero">
<title id="t-hero">NeuroClaw: a coral cord turning around a glowing sphere with a small green agent inside</title>
<defs>
<linearGradient id="bgh-hero" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>
<radialGradient id="g-hero"><stop offset="0" stop-color="${C.coral}" stop-opacity=".45"/><stop offset="1" stop-color="${C.coral}" stop-opacity="0"/></radialGradient>
<radialGradient id="s-hero" cx=".38" cy=".32"><stop offset="0" stop-color="#5c2e36"/><stop offset="1" stop-color="#1c0e12"/></radialGradient>
<linearGradient id="c-hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.soft}"/><stop offset=".5" stop-color="${C.coral}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient>
</defs>
<style>
@keyframes flip{0%{transform:scale(1,.9) rotate(-4deg)}25%{transform:scale(1,.22) rotate(0)}50%{transform:scale(1,-.9) rotate(4deg)}75%{transform:scale(1,-.22) rotate(0)}100%{transform:scale(1,.9) rotate(-4deg)}}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes breathe{0%,100%{opacity:.7}50%{opacity:1}}
.ring{transform-origin:240px 180px;animation:flip 12s ease-in-out infinite}
.agent{animation:bob 4s ease-in-out infinite}
.glow{animation:breathe 4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect width="480" height="360" rx="44" fill="url(#bgh-hero)"/><rect x=".75" y=".75" width="478.5" height="358.5" rx="43.5" fill="none" stroke="${C.line}"/>
<circle class="glow" cx="240" cy="180" r="150" fill="url(#g-hero)"/>
<circle cx="240" cy="180" r="74" fill="url(#s-hero)" stroke="${C.coral}" stroke-opacity=".55" stroke-width="2"/>
<g class="agent">${agent(240, 182, 38)}</g>
<g class="ring"><path d="${ring(240, 180, 168)}" fill="none" stroke="url(#c-hero)" stroke-width="13" stroke-linejoin="round" stroke-linecap="round"/><path d="${ring(240, 180, 168)}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3" stroke-linejoin="round"/></g>
</svg>
`;

// ---- 1. neural mesh ----
{
  const N = [[90, 90], [90, 170], [150, 130], [200, 70], [200, 190], [260, 130], [320, 80], [320, 180], [390, 130], [240, 40], [240, 220]];
  const E = [[0, 2], [1, 2], [2, 3], [2, 4], [3, 5], [4, 5], [5, 6], [5, 7], [6, 8], [7, 8], [3, 9], [4, 10], [9, 6], [10, 7], [0, 3], [1, 4]];
  const edges = E.map(([a, b], i) => `<line x1="${N[a][0]}" y1="${N[a][1]}" x2="${N[b][0]}" y2="${N[b][1]}" class="line"/><line x1="${N[a][0]}" y1="${N[a][1]}" x2="${N[b][0]}" y2="${N[b][1]}" class="sig" style="animation-delay:${(i * 0.23).toFixed(2)}s"/>`).join('');
  const nodes = N.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="9" class="node" style="animation-delay:${(i * 0.31).toFixed(2)}s"/>`).join('');
  files['docs/media/mesh.svg'] = card({
    id: 'mesh', title: 'Neural mesh: every neuron talks to its neighbours and signals flow between them', caption: 'Neural mesh: every neuron talks to every other',
    css: `@keyframes flow{to{stroke-dashoffset:-24}}@keyframes pulse{0%,100%{fill:${C.deep};r:8}50%{fill:${C.soft};r:11}}
.sig{fill:none;stroke:${C.coral};stroke-width:2.5;stroke-dasharray:4 20;stroke-linecap:round;animation:flow 1.6s linear infinite}
.node{fill:${C.deep};animation:pulse 3s ease-in-out infinite}`,
    body: `<g transform="translate(0,-8)">${edges}${nodes}</g>`,
  });
}

// ---- 2. mixture of experts: a router sends each request to one expert ----
{
  const experts = [['code', 50], ['words', 100], ['logic', 150], ['memory', 200]];
  const ex = experts.map(([name, y], i) => `<g><rect x="340" y="${y - 6}" width="100" height="36" rx="18" class="exp" style="animation-delay:${i}s"/><text x="390" y="${y + 17}" text-anchor="middle" font-size="15">${name}</text></g>
`).join('');
  const pk = experts.map(([, y], i) => `<circle cx="76" cy="148" r="7" class="pkt" style="--mx:130px;--my:0px;--dx:264px;--dy:${y + 12 - 148}px;animation-delay:${i}s"/>`).join('');
  files['docs/media/experts.svg'] = card({
    id: 'moe', title: 'Mixture of experts: a router sends each request to the one expert that fits', caption: 'Mixture of experts: only the right specialist wakes up',
    css: `@keyframes lit{0%{fill:rgba(255,240,232,.07);stroke:${C.line}}5%,22%{fill:rgba(227,169,157,.3);stroke:${C.coral}}30%,100%{fill:rgba(255,240,232,.07);stroke:${C.line}}}
@keyframes go{0%{opacity:0;transform:translate(0,0)}3%{opacity:1}10%{opacity:1;transform:translate(var(--mx),var(--my))}22%{opacity:1;transform:translate(var(--dx),var(--dy))}27%,100%{opacity:0;transform:translate(var(--dx),var(--dy))}}
@keyframes hum{0%,100%{opacity:.75}50%{opacity:1}}
.exp{fill:rgba(255,240,232,.07);stroke:${C.line};stroke-width:1.5;animation:lit 4s ease-in-out infinite}
.pkt{fill:${C.soft};opacity:0;animation:go 4s ease-in-out infinite}
.router{animation:hum 2s ease-in-out infinite}`,
    body: `<circle cx="76" cy="148" r="22" fill="none" stroke="${C.coral}" stroke-width="2" stroke-opacity=".6"/><text x="76" y="182" text-anchor="middle" font-size="13" class="dim">request</text>
${pk}<rect class="router" x="170" y="118" width="70" height="60" rx="30" fill="rgba(227,169,157,.16)" stroke="${C.coral}" stroke-opacity=".55" stroke-width="1.5"/><text x="205" y="153" text-anchor="middle" font-size="14" fill="${C.soft}" style="fill:${C.soft}">router</text>
<path d="M98 148H170M240 148L340 60M240 148L340 110M240 148L340 160M240 148L340 210" class="line"/>${ex}`,
  });
}

// ---- 3. raw bits: no tokenizer ----
{
  const rows = Array.from({ length: 6 }, (_, r) => {
    const bits = Array.from({ length: 22 }, (_, i) => ((i * 7 + r * 5 + (i * r) % 3) % 3 === 0 ? '1' : '0')).join(' ');
    return `<text x="-260" y="${70 + r * 24}" font-size="17" class="bit" style="animation-duration:${(5 + r * 0.7).toFixed(1)}s;animation-delay:-${r * 1.3}s">${bits}</text>`;
  }).join('');
  files['docs/media/bits.svg'] = card({
    id: 'bits', title: 'Raw bits flowing into the mesh with no tokenizer', caption: 'Text, audio and images go in as raw bits: no tokenizer',
    css: `@keyframes run{from{transform:translateX(0)}to{transform:translateX(560px)}}@keyframes beat{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
.bit{fill:${C.coral};letter-spacing:2px;animation:run 6s linear infinite;opacity:.85;font-family:ui-monospace,Menlo,Consolas,monospace}
.core{transform-origin:400px 130px;animation:beat 1.6s ease-in-out infinite}`,
    body: `${rows}<rect x="330" y="0" width="150" height="300" fill="${C.bg1}"/><g class="core"><circle cx="400" cy="130" r="64" fill="url(#glow-bits)"/><circle cx="400" cy="130" r="42" fill="#2a1519" stroke="${C.coral}" stroke-opacity=".6" stroke-width="2"/>${agent(400, 132, 22)}</g>`,
    defs: '',
  });
}

// ---- 4. self-improvement: a repeated pattern becomes a permanent skill ----
files['docs/media/learning.svg'] = card({
  id: 'learn', title: 'Self-improvement: a pattern seen three times becomes a permanent skill', caption: 'Self-improving: patterns that repeat become skills',
  css: `@keyframes chip{0%,100%{opacity:0;transform:translateY(8px)}8%,60%{opacity:1;transform:translateY(0)}70%{opacity:0;transform:translate(60px,0)}}
@keyframes skill{0%,62%{opacity:0;transform:scale(.3)}72%,92%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.3)}}
@keyframes grow{0%,70%{stroke-dashoffset:140}85%,92%{stroke-dashoffset:0}100%{stroke-dashoffset:140;opacity:0}}
@keyframes count{0%,12%{opacity:0}16%,60%{opacity:1}66%,100%{opacity:0}}
.chipt{opacity:0;animation:chip 7s ease-in-out infinite}
.chip{fill:rgba(227,169,157,.2);stroke:${C.coral};stroke-width:1.5;animation:chip 7s ease-in-out infinite}
.skill{transform-box:fill-box;transform-origin:center;fill:rgba(143,227,168,.22);stroke:${C.green};stroke-width:2;animation:skill 7s ease-in-out infinite}
.tent{fill:none;stroke:${C.green};stroke-width:7;stroke-linecap:round;stroke-dasharray:140;animation:grow 7s ease-in-out infinite}
.cnt{animation:count 7s ease-in-out infinite}`,
  body: `<g>${[0, 1, 2].map((i) => `<rect class="chip" x="${52 + i * 70}" y="${96 + (i % 2) * 8}" width="56" height="34" rx="17" style="animation-delay:${i * 0.9}s"/><text x="${80 + i * 70}" y="${118 + (i % 2) * 8}" text-anchor="middle" font-size="13" class="chipt" style="animation-delay:${i * 0.9}s">fix</text>`).join('')}</g>
<text class="cnt dim" x="130" y="176" text-anchor="middle" font-size="14">seen 3 times</text>
<circle cx="360" cy="150" r="50" fill="#2a1519" stroke="${C.coral}" stroke-opacity=".6" stroke-width="2"/>
<path class="tent" d="M360 150 C 380 110, 420 110, 420 70"/><rect class="skill" x="396" y="40" width="60" height="34" rx="17"/><text class="skill" x="426" y="62" text-anchor="middle" font-size="13" style="fill:${C.green};animation-name:skill;stroke:none">skill</text>`,
});

// ---- 5. local-first and private ----
files['docs/media/private.svg'] = card({
  id: 'priv', title: 'Local first: the app runs in its own window on this computer and nothing leaves it', caption: 'Local-first: your own window, no cloud, no account',
  css: `@keyframes slide{0%,8%{opacity:0;transform:translateY(14px)}18%,86%{opacity:1;transform:translateY(0)}96%,100%{opacity:0}}
@keyframes lock{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes fade{0%,100%{opacity:.25}50%{opacity:.4}}
.b{animation:slide 7s ease-in-out infinite}
.lock{transform-box:fill-box;transform-origin:center;animation:lock 2.4s ease-in-out infinite}
.cloud{animation:fade 4s ease-in-out infinite}`,
  body: `<rect x="36" y="34" width="270" height="206" rx="28" fill="rgba(255,240,232,.07)" stroke="${C.line}" stroke-width="1.5"/>
<circle cx="64" cy="58" r="6" fill="${C.coral}"/><circle cx="84" cy="58" r="6" fill="${C.deep}" opacity=".7"/><circle cx="104" cy="58" r="6" fill="${C.line}"/>
<rect class="b" x="56" y="84" width="150" height="34" rx="17" fill="rgba(227,169,157,.18)" style="animation-delay:0s"/><text class="b" x="131" y="106" text-anchor="middle" font-size="14" style="animation-delay:0s">what can you do?</text>
<rect class="b" x="110" y="130" width="176" height="34" rx="17" fill="rgba(143,227,168,.16)" style="animation-delay:.7s"/><text class="b" x="198" y="152" text-anchor="middle" font-size="14" style="animation-delay:.7s">everything, right here</text>
<rect class="b" x="56" y="176" width="120" height="34" rx="17" fill="rgba(227,169,157,.18)" style="animation-delay:1.4s"/><text class="b" x="116" y="198" text-anchor="middle" font-size="14" style="animation-delay:1.4s">offline?</text>
<g class="cloud"><path d="M356 120a26 26 0 0 1 50-8a22 22 0 0 1 8 42H364a20 20 0 0 1-8-34z" fill="none" stroke="${C.dim}" stroke-width="3" style="stroke:rgba(248,237,233,.5)"/><path d="M350 170L424 96" stroke="#ff9aa8" stroke-width="5" stroke-linecap="round"/></g>
<text x="388" y="196" text-anchor="middle" font-size="14" class="dim">no cloud</text>
<g class="lock"><rect x="368" y="216" width="40" height="28" rx="10" fill="rgba(227,169,157,.2)" stroke="${C.coral}" stroke-width="2"/><path d="M376 216v-8a12 12 0 0 1 24 0v8" fill="none" stroke="${C.coral}" stroke-width="3" stroke-linecap="round"/></g>`,
});

// ---- 6. extensions and skills plug in ----
{
  const blocks = [[60, 60, 'code'], [60, 200, 'web'], [420, 60, 'files'], [420, 200, 'voice']];
  const b = blocks.map(([x, y, name], i) => `<g class="blk" style="--fx:${240 - x}px;--fy:${130 - y}px;animation-delay:${i * 1.2}s"><rect x="${x - 36}" y="${y - 17}" width="72" height="34" rx="17" fill="rgba(143,227,168,.18)" stroke="${C.green}" stroke-width="1.8"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-size="14">${name}</text></g>`).join('');
  files['docs/media/extensions.svg'] = card({
    id: 'ext', title: 'Extensions and skills plug into the mesh and become part of it', caption: 'Extensions: any skill plugs in without touching the core',
    css: `@keyframes plug{0%{opacity:0;transform:translate(0,0) scale(.8)}8%{opacity:1}40%{opacity:1;transform:translate(var(--fx),var(--fy)) scale(.5)}50%,100%{opacity:0;transform:translate(var(--fx),var(--fy)) scale(.2)}}
@keyframes ping{0%,35%{r:56;opacity:0}45%{opacity:.7}70%,100%{r:86;opacity:0}}
.blk{opacity:0;animation:plug 4.8s ease-in-out infinite}
.ping{fill:none;stroke:${C.green};stroke-width:2;animation:ping 4.8s ease-out infinite}`,
    body: `<circle cx="240" cy="130" r="86" fill="url(#glow-ext)"/><circle class="ping" cx="240" cy="130" r="56"/><circle cx="240" cy="130" r="56" fill="#2a1519" stroke="${C.coral}" stroke-opacity=".6" stroke-width="2"/>${agent(240, 132, 30)}${b}`,
  });
}

// ---- download buttons: images, because GitHub cannot style a link in README.md ----
const BUTTONS = [
  ['linux-deb', 'Download .deb', true], ['linux-tar', 'Download .tar.gz', false],
  ['windows-exe', 'Download .exe', true], ['windows-zip', 'Download .zip', false],
  ['macos-dmg', 'Download .dmg', true], ['macos-zip', 'Download .zip', false],
  ['android-apk', 'Download .apk', true], ['chrome-zip', 'Download .zip', true],
  ['source-zip', 'Source code .zip', false],
];
for (const [id, label, primary] of BUTTONS) {
  const w = 224, h = 52, fill = primary ? `url(#f-${id})` : C.bg1, ink = primary ? '#2a1519' : C.soft, edge = primary ? C.soft : C.coral;
  files[`docs/media/btn-${id}.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">
<title>${label}</title>
<defs><linearGradient id="f-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.soft}"/><stop offset="1" stop-color="${C.coral}"/></linearGradient></defs>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${(h - 2) / 2}" fill="${fill}" stroke="${edge}" stroke-width="2"/>
<path d="M32 17v14m-7-6l7 7l7-7M24 38h16" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-5) scale(1)"/>
<text x="${w / 2 + 18}" y="${h / 2 + 6}" text-anchor="middle" font-size="18" font-weight="700" style="fill:${ink};font-family:${FONT}">${label}</text>
</svg>
`;
}

// ---- the HTML README ----
const DL = `${APP_URL}/releases/latest/download`;
const downloads = [
  ['Linux', 'Debian, Ubuntu, Chromebook Linux', [['.deb', 'neuroclaw-linux-x64.deb'], ['.tar.gz', 'neuroclaw-linux-x64.tar.gz']], true],
  ['Windows', 'Installs for your user only', [['.exe', 'neuroclaw-windows-x64.exe'], ['.zip', 'neuroclaw-windows-x64.zip']]],
  ['macOS', 'Apple silicon', [['.dmg', 'neuroclaw-macos-arm64.dmg'], ['.zip', 'neuroclaw-macos-arm64.zip']]],
  ['Android', 'Sideload the .apk', [['.apk', 'neuroclaw-android-any.apk']]],
  ['Chrome', 'Chrome extension', [['.zip', 'neuroclaw-chrome-extension.zip']]],
];
const features = [
  ['mesh', 'Neural mesh', 'Fully connected neurons that talk to each other, with signals you can watch travel.'],
  ['experts', 'Mixture of experts', 'A router wakes only the specialist that fits the request, so it stays fast and small.'],
  ['bits', 'Raw bits, no tokenizer', 'Text, audio and images all enter the mesh as the bits they already are.'],
  ['learning', 'Self-improving', 'Patterns that keep repeating are promoted to permanent skills; repeated mistakes are penalised.'],
  ['private', 'Local-first and private', 'One engine on your computer in its own window. No account, no cloud, no open network port.'],
  ['extensions', 'Extensions and skills', 'Plug a skill in, change it or combine it without touching the core.'],
];
const dlHtml = downloads.map(([os, note, links, primary]) => `<div class="card dl"><h3>${os}</h3><p class="dim">${note}</p><div class="row">${links.map(([label, f], i) => `<a class="btn${i === 0 ? ' primary' : ''}" href="${DL}/${f}" download>Download ${label}</a>`).join('')}</div></div>`).join('\n');
const featHtml = features.map(([f, h, p]) => `<article class="card feat reveal"><img src="media/${f}.svg" alt="${h}" width="480" height="300" loading="lazy"><h3>${h}</h3><p class="dim">${p}</p></article>`).join('\n');

files['docs/index.html'] = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeuroClaw</title>
<meta name="description" content="A local-first AI agent on your own computer. Download it for Linux, Windows, macOS, Android or Chrome.">
<style>
:root{--bg0:${C.bg0};--bg1:${C.bg1};--text:${C.text};--dim:${C.dim};--coral:${C.coral};--soft:${C.soft};--deep:${C.deep};--line:${C.line};--green:${C.green};--spring:cubic-bezier(.34,1.56,.64,1)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 700px at 50% -10%,var(--bg1),var(--bg0));font:16px/1.55 ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'Segoe UI',sans-serif}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;background:radial-gradient(500px 400px at 20% 30%,rgba(227,169,157,.14),transparent 70%),radial-gradient(600px 500px at 80% 70%,rgba(201,132,118,.12),transparent 70%);animation:drift 24s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate(4%,3%) scale(1.08)}}
main{max-width:1080px;margin:0 auto;padding:0 20px 72px}
h1,h2,h3{line-height:1.15;margin:0}
h2{font-size:clamp(1.5rem,3.4vw,2rem);margin:64px 0 20px;text-align:center}
.dim{color:var(--dim)}
.hero{display:grid;justify-items:center;text-align:center;padding:40px 0 8px}
.hero img{width:min(420px,86vw);height:auto;filter:drop-shadow(0 20px 50px rgba(227,169,157,.2))}
.hero h1{font-size:clamp(2.2rem,6vw,3.4rem);margin-top:4px}
.hero p{max-width:640px;margin:14px 0 0}
.card{background:rgba(255,240,232,.07);border:1px solid var(--line);border-radius:32px;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 24px 60px rgba(0,0,0,.35),0 0 40px rgba(227,169,157,.06);backdrop-filter:blur(26px) saturate(1.5);-webkit-backdrop-filter:blur(26px) saturate(1.5)}
.downloads{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px}
.dl{padding:20px 16px;display:grid;gap:6px;align-content:start}
.dl h3{font-size:1.25rem}.dl p{margin:0 0 10px}
.row{display:flex;flex-wrap:wrap;gap:8px}
.btn{display:inline-block;white-space:nowrap;font-size:.92rem;padding:9px 14px;border-radius:999px;border:1px solid var(--line);background:rgba(255,238,230,.07);color:var(--text);text-decoration:none;font-weight:600;transition:transform .35s var(--spring),background .2s}
.btn:hover{transform:translateY(-2px) scale(1.03);background:rgba(255,238,230,.16)}
.btn:active{transform:scale(.95)}
.btn.primary{background:rgba(227,169,157,.16);border-color:rgba(227,169,157,.5);color:var(--soft)}
.btn.primary:hover{background:rgba(227,169,157,.28)}
.btn:focus-visible{outline:2px solid var(--coral);outline-offset:3px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px}
.feat{padding:14px 14px 22px;overflow:hidden}
.feat img{width:100%;height:auto;display:block;border-radius:22px;margin-bottom:14px}
.feat h3,.feat p{padding:0 10px}.feat p{margin:6px 0 0}
.reveal{opacity:0;transform:translateY(26px) scale(.98);transition:opacity .7s ease,transform .7s var(--spring)}
.reveal.in{opacity:1;transform:none}
.note{max-width:760px;margin:40px auto 0;padding:22px 26px;text-align:center}
.links{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
footer{margin-top:48px;text-align:center}
a{color:var(--soft)}
a:visited{color:var(--soft)}
code{background:rgba(255,238,230,.09);border-radius:999px;padding:2px 10px}
@media (prefers-reduced-motion:reduce){body::before{animation:none}.reveal{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
<section class="hero">
<img src="media/hero.svg" alt="A coral cord turning around a glowing sphere with a small green agent inside" width="480" height="360">
<h1>NeuroClaw</h1>
<p class="dim">A local-first AI agent on your own computer, powered by OneBrain, a neural mesh engine. No account, no cloud, no tokenizer.</p>
</section>

<h2>Download</h2>
<section class="downloads" aria-label="Downloads">
${dlHtml}
</section>
<p class="dim" style="text-align:center;margin-top:14px">Each button takes the newest published release. On iPhone and iPad it is not available yet.</p>

<h2>What it does</h2>
<section class="features">
${featHtml}
</section>

<section class="card note">
<p><strong>Run it from source:</strong> <code>npm run app</code> opens it in its own window. <code>npm run package</code> builds the installer for your system.</p>
<p class="dim">This is an educational project and it is in beta. We are not responsible for your actions or what the code does. By continuing you agree with this statement and the <a href="../PRIVACY.md">privacy policy</a> and <a href="../TERMS.md">terms and conditions</a>. Please spread the word.</p>
</section>

<footer>
<div class="links">
<a class="btn" href="FILE_GUIDE.md">What every file does</a>
<a class="btn" href="DEEP_DIVES.md">Engine deep-dives</a>
<a class="btn" href="PLATFORMS.md">Platforms</a>
<a class="btn" href="${APP_URL}">Source on GitHub</a>
</div>
</footer>
</main>
<script>
(function(){var els=[].slice.call(document.querySelectorAll('.reveal'));
if(!('IntersectionObserver' in window)){els.forEach(function(e){e.classList.add('in')});return}
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.15});
els.forEach(function(e){io.observe(e)})})();
</script>
</body>
</html>
`;

// ---- write or check ----
let bad = 0;
for (const [rel, text] of Object.entries(files)) {
  const abs = path.join(ROOT, rel);
  if (check) { if (!existsSync(abs) || readFileSync(abs, 'utf8') !== text) { console.error(`stale: ${rel}`); bad++; } continue; }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  console.log(`wrote ${rel} (${text.length} bytes)`);
}
if (bad) process.exit(1);
