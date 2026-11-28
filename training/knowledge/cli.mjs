#!/usr/bin/env node
// Entry point for the .my-ai knowledge and training system.  node training/knowledge/cli.mjs <command>
import { loadSources, checkCatalog, probeAll, writeCitations } from './sources/index.mjs';
import { collect, validateRaw } from './collect.mjs';
import { extractAll } from './extract.mjs';
import { trainAll, status } from './train.mjs';
import { benchSafety, benchReasoning, benchFacts, benchDataQuality, benchScifact, benchQasper, benchCode, benchVerify, benchSourceVerification } from './evaluate.mjs';
import { currentRecord, loadArtifact, verifyRegistry, rollback, load as loadRegistry } from './registry.mjs';
import { deserialize } from './retrieval.mjs';
import { gate, classifyText, classifyCode } from './safety.mjs';
import { writeJson, dir, path, writeFileSync, REPO, today } from './util.mjs';
import { writeReport } from './report.mjs';

const [cmd, ...args] = process.argv.slice(2);
const J = (o) => console.log(JSON.stringify(o, null, 2));
const need = (v, what) => { if (!v) { console.error('usage: ' + what); process.exit(2); } return v; };

async function evalAll() {
  const out = { date: today(), components: {}, suites: {} };
  const sci = currentRecord('retriever.science'), code = currentRecord('retriever.code'), ver = currentRecord('verifier.claims'), au = currentRecord('audio.recognizer');
  // checkpoints/ is git-ignored, so a fresh checkout has registry entries but no artifact files. Say so instead of crashing.
  const artifact = (name) => { const a = loadArtifact(name); if (!a) (out.missingArtifacts ??= []).push(name); return a; };
  const sciArt = sci && artifact('retriever.science'), codeArt = code && artifact('retriever.code');
  if (sciArt) { const ix = deserialize(sciArt); out.components['retriever.science'] = { version: sci.version, ...benchScifact(ix, 'dev'), ...benchQasper(sci.params, 'dev', 120), ...benchSourceVerification(ix) }; if (ver) out.components['verifier.claims'] = { version: ver.version, ...benchVerify(ix, ver.params, 'dev') }; }
  if (codeArt) out.components['retriever.code'] = { version: code.version, ...benchCode(deserialize(codeArt)) };
  if (au) out.components['audio.recognizer'] = { version: au.version, ...au.metrics };
  for (const [n, f] of Object.entries({ safety: benchSafety, reasoning: benchReasoning, facts: benchFacts, dataQuality: benchDataQuality })) out.suites[n] = f();
  writeJson(path.join(dir('reports'), 'eval.json'), out); return out;
}

const commands = {
  async sources() { const p = checkCatalog(); if (p.length) { console.error(p.join('\n')); process.exit(1); } writeCitations(path.join(REPO, 'training', 'knowledge', 'CITATIONS.md')); writeJson(path.join(dir('.'), 'catalog.json'), loadSources()); console.log(`${loadSources().length} sources, catalogue complete; wrote CITATIONS.md`); },
  async probe() { J(await probeAll()); },
  async collect() { for (const r of await collect(args.length ? args : undefined)) console.log(r.id.padEnd(18), String(r.files).padStart(3), r.status.slice(0, 110)); },
  async validate() { const r = validateRaw(); J(r); if (r.problems.length) process.exit(1); },
  async extract() { J(extractAll()); },
  async train() { const r = trainAll({ tune: !args.includes('--no-tune') }); console.log('done'); },
  async eval() { J(await evalAll()); },
  async status() { J(status()); const p = verifyRegistry(); if (p.length) { console.error(p); process.exit(1); } },
  async rollback() { console.log('current ->', rollback(need(args[0], 'rollback <component> <version>'), need(args[1], 'rollback <component> <version>'))); },
  async research() { const { research } = await import('./research.mjs'); J(research(need(args.join(' '), 'research "<question>"'))); },
  async verify() { const { verify } = await import('./research.mjs'); const p = currentRecord('verifier.claims')?.params; J(verify(need(args.join(' '), 'verify "<claim>"'), p)); },
  async check() { const t = need(args.join(' '), 'check "<text or request>"'); J({ text: classifyText(t), gate: gate(t) }); },
  async report() { console.log(writeReport(await evalAll())); },
  async run() {
    await commands.sources(); await commands.collect(); await commands.validate(); extractAll(); trainAll(); const ev = await evalAll(); console.log(writeReport(ev));
  },
};
if (!commands[cmd]) { console.log('commands: ' + Object.keys(commands).join(' | ')); process.exit(cmd ? 2 : 0); }
commands[cmd]().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
