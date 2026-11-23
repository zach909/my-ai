// Stage 1: data collection. Each fetcher downloads one source into training_data/knowledge/raw/<id>/ and writes
// a manifest (url, bytes, sha256, licence, access date). A source is fetched only if the catalog allows it
// (use != 'none') and the fetcher exists. Nothing is invented: a failed download is recorded as failed.
import { fetchBuf, sha256, dir, path, writeFileSync, readFileSync, existsSync, writeJson, readJson, today, untgz, unzip, sleep, csvObjects } from './util.mjs';
import { loadSources, byId } from './sources/index.mjs';

const ESC_CLASSES = ['dog', 'rooster', 'rain', 'crying_baby', 'siren', 'keyboard_typing'];
const XV6 = ['kernel/proc.c', 'kernel/vm.c', 'kernel/spinlock.c', 'kernel/syscall.c', 'kernel/pipe.c', 'kernel/file.c', 'kernel/fs.c', 'kernel/trap.c', 'LICENSE', 'README'];
const gh = (p) => `https://raw.githubusercontent.com/${p}`;

async function save(id, name, buf, url, files) {
  const d = dir('raw', id); writeFileSync(path.join(d, name), buf);
  files.push({ file: name, url, bytes: buf.length, sha256: sha256(buf) });
}

export const FETCHERS = {
  'maestro-metadata': async (id, f) => { const u = 'https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0.json'; await save(id, 'maestro-v3.0.0.json', await fetchBuf(u), u, f); },
  'musiccaps': async (id, f) => { const u = 'https://huggingface.co/datasets/google/MusicCaps/resolve/main/musiccaps-public.csv'; await save(id, 'musiccaps-public.csv', await fetchBuf(u), u, f); },
  'audioset-ontology': async (id, f) => { const u = gh('audioset/ontology/master/ontology.json'); await save(id, 'ontology.json', await fetchBuf(u), u, f); },
  'fsd50k-labels': async (id, f) => {
    const u = 'https://zenodo.org/api/records/4060432/files/FSD50K.ground_truth.zip/content';
    const z = unzip(await fetchBuf(u));
    for (const e of z) if (e.name.endsWith('vocabulary.csv')) await save(id, 'vocabulary.csv', e.data, u + '#vocabulary.csv', f);
  },
  'esc50': async (id, f) => {
    const mu = gh('karolpiczak/ESC-50/master/meta/esc50.csv'); const meta = await fetchBuf(mu); await save(id, 'esc50.csv', meta, mu, f);
    const rows = csvObjects(meta.toString('utf8')); const per = Number(process.env.ESC_PER_CLASS || 40);
    for (const cls of ESC_CLASSES) {
      const pick = rows.filter((r) => r.category === cls).slice(0, per);
      const todo = pick.filter((r) => !existsSync(path.join(dir('raw', id, 'audio'), r.filename)));
      for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(async (r) => {
        const au = gh('karolpiczak/ESC-50/master/audio/' + r.filename);
        writeFileSync(path.join(dir('raw', id, 'audio'), r.filename), await fetchBuf(au));
      }));
    }
    f.push({ file: 'audio/', url: gh('karolpiczak/ESC-50/master/audio/'), note: `${ESC_CLASSES.join(',')} x ${per} clips` });
  },
  'clotho': async (id, f) => { const u = 'https://zenodo.org/api/records/3490684/files/clotho_captions_development.csv/content'; await save(id, 'clotho_captions_development.csv', await fetchBuf(u), u, f);
    const l = 'https://zenodo.org/api/records/3490684/files/LICENSE/content'; await save(id, 'LICENSE', await fetchBuf(l), l, f); },
  'ucd': async (id, f) => { const u = 'https://unicode.org/Public/UCD/latest/ucd/UnicodeData.txt'; await save(id, 'UnicodeData.txt', await fetchBuf(u), u, f); },
  'emoji': async (id, f) => { const u = 'https://unicode.org/Public/emoji/latest/emoji-test.txt'; await save(id, 'emoji-test.txt', await fetchBuf(u), u, f); },
  'cldr': async (id, f) => { const u = gh('unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/en/annotations.json'); await save(id, 'annotations-en.json', await fetchBuf(u), u, f); },
  'xv6': async (id, f) => { for (const p of XV6) { const u = gh('mit-pdos/xv6-riscv/riscv/' + p); await save(id, p.replace('/', '__'), await fetchBuf(u), u, f); } },
  'scifact': async (id, f) => {
    const u = 'https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz';
    for (const e of untgz(await fetchBuf(u))) {
      const b = path.basename(e.name);
      if (/^(corpus|claims_(train|dev|test))\.jsonl$/.test(b) && !e.name.includes('cross_validation')) await save(id, b, Buffer.from(e.data), u + '#' + b, f);
    }
  },
  'qasper': async (id, f) => {
    const u = 'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz';
    for (const e of untgz(await fetchBuf(u))) { const b = path.basename(e.name); if (/\.json$/.test(b)) await save(id, b, Buffer.from(e.data), u + '#' + b, f); }
  },
  'arxiv': async (id, f) => {
    // arXiv API terms: at most one request per 3 seconds. 4 categories x 100 abstracts, metadata only (CC0).
    for (const cat of ['cs.LG', 'physics.optics', 'q-bio.NC', 'astro-ph.CO']) {
      const u = `https://export.arxiv.org/api/query?search_query=cat:${cat}&max_results=100&sortby=submittedDate&sortorder=descending`;
      await save(id, `arxiv-${cat}.xml`, await fetchBuf(u), u, f); await sleep(3500);
    }
  },
};

export async function collect(ids) {
  const sources = loadSources(); const report = [];
  for (const s of sources) {
    if (ids && !ids.includes(s.id)) continue;
    const entry = { id: s.id, name: s.name, licence: s.license, use: s.use, nc: !!s.nc, sa: !!s.sa, accessed: today(), files: [] };
    if (s.use === 'none') entry.status = 'skipped: catalogue says not ingestible (' + s.limits + ')';
    else if (!s.acquire) entry.status = 'not-fetched: ' + (s.use === 'reference' ? 'reference/pointer source' : 'too large or gated for this build') + ' - ' + s.limits;
    else {
      try { await FETCHERS[s.acquire](s.id, entry.files); entry.status = 'obtained'; }
      catch (e) { entry.status = 'failed: ' + e.message; }
    }
    if (entry.files.length) writeJson(path.join(dir('raw', s.id), 'MANIFEST.json'), entry);
    report.push({ ...entry, files: entry.files.length });
  }
  writeJson(path.join(dir('reports'), 'collect.json'), report);
  return report;
}

/** Stage 2: validation. Re-hash every raw file against its manifest; empty/missing files fail. */
export function validateRaw() {
  const problems = []; let ok = 0;
  for (const s of loadSources()) {
    const mf = path.join(dir('raw', s.id), 'MANIFEST.json'); if (!existsSync(mf)) continue;
    for (const f of readJson(mf).files) {
      if (!f.sha256) continue;
      const p = path.join(dir('raw', s.id), f.file);
      if (!existsSync(p)) { problems.push(`${s.id}/${f.file}: missing`); continue; }
      const b = readFileSync(p);
      if (!b.length) problems.push(`${s.id}/${f.file}: empty`); else if (sha256(b) !== f.sha256) problems.push(`${s.id}/${f.file}: hash mismatch`); else ok++;
    }
  }
  return { ok, problems };
}
