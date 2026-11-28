#!/usr/bin/env node
/**
 * Look at the echo step from the command line. Node built-ins only.
 *
 *   node training/echo/run.mjs plan                                  every domain and level, and how many legal tunes exist
 *   node training/echo/run.mjs tunes --domain music --level 0 [--limit 20] [--shuffle --seed 7]
 *                                                                    list the legal tunes (all of them, or in seeded random order)
 *   node training/echo/run.mjs samples --domain music --level 1 --task next [--count 5] [--seed 1]
 *                                                                    print training samples as JSON lines (bytes in hex)
 */
import { DOMAINS, byId } from './domains.mjs';
import { makeSample, tasksFor, TASKS } from './echo.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const hex = (u8) => Buffer.from(u8).toString('hex');

function domainArg() {
  const d = byId(opt('domain', ''));
  if (!d) {
    console.error(`--domain must be one of: ${DOMAINS.map((x) => x.id).join(', ')}`);
    process.exit(2);
  }
  return d;
}

if (cmd === 'plan') {
  for (const d of DOMAINS) {
    console.log(`${String(d.tag).padStart(2)}. ${d.id.padEnd(10)} ${d.name}`);
    console.log(`    tasks: ${tasksFor(d).join(', ')}`);
    d.levels.forEach((len, lv) => console.log(`    level ${lv}: ${String(len).padStart(3)} symbols, ${d.walk.total(len)} legal tunes`));
  }
} else if (cmd === 'tunes') {
  const d = domainArg();
  const level = Number(opt('level', 0));
  const len = d.levels[level];
  const limit = Number(opt('limit', 20));
  const src = has('shuffle') ? d.walk.shuffled(len, Number(opt('seed', 1))) : d.walk.enumerate(len);
  console.log(`${d.id} level ${level}: ${d.walk.total(len)} legal tunes of ${len} symbols${has('shuffle') ? ' (seeded random order, none repeated)' : ''}`);
  let i = 0;
  for (const t of src) {
    if (i++ >= limit) break;
    console.log(d.show(t));
  }
} else if (cmd === 'samples') {
  const d = domainArg();
  const task = opt('task', 'echo');
  if (!(task in TASKS) || !tasksFor(d).includes(task)) {
    console.error(`${d.id} supports: ${tasksFor(d).join(', ')}`);
    process.exit(2);
  }
  const level = Number(opt('level', 0));
  const seed = Number(opt('seed', 1));
  for (let i = 0; i < Number(opt('count', 5)); i++) {
    const s = makeSample(d, task, level, seed, i);
    console.log(JSON.stringify({ meta: s.meta, input: hex(s.input), target: hex(s.target) }));
  }
} else {
  console.log('usage: node training/echo/run.mjs plan | tunes --domain D [--level N] [--limit N] [--shuffle --seed S] | samples --domain D --task T [--level N] [--count N] [--seed S]');
  process.exit(cmd ? 2 : 0);
}
