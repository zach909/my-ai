// Stages 3-6: clean -> classify (good/bad) -> de-duplicate -> knowledge extraction.
// Input : training_data/knowledge/raw/<source>/   (only sources that are use='train' feed training collections)
// Output: processed/collections/<name>.jsonl  documents for retrieval / text components (each keeps source, licence, evidence level)
//         processed/kb/<name>.kb             symbolic knowledge in KL (reason/lang.mjs)
//         processed/eval/<name>.jsonl        benchmark material (eval-only sources and held-out splits)
//         processed/quality.json             counts for every stage, so data quality is measured, not assumed
import { dir, path, existsSync, readFileSync, writeFileSync, readJson, readJsonl, writeJson, writeJsonl, csvObjects, today } from './util.mjs';
import { clean, dedup } from './text.mjs';
import { classifyText, classifyCode } from './safety.mjs';
import { byId } from './sources/index.mjs';

const raw = (id, f) => path.join(dir('raw', id), f);
const have = (id, f) => existsSync(raw(id, f));
export const sym = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const cp = (hex) => 'u' + hex.toLowerCase();

function meta(id, extra = {}) { const s = byId(id); return { source: id, license: s.license, nc: !!s.nc, sa: !!s.sa, use: s.use, ...extra }; }

// ---------- extractors: each returns { docs?, kb?, evalRows? } ----------
const X = {};

X.scifact = () => {
  if (!have('scifact', 'corpus.jsonl')) return null;
  const corpus = readJsonl(raw('scifact', 'corpus.jsonl'));
  const docs = corpus.map((d) => ({ id: 'scifact:' + d.doc_id, title: d.title, text: d.title + '. ' + d.abstract.join(' '), sentences: d.abstract, url: 'https://allenai.org/data/scifact', level: 'peer-reviewed-abstract', ...meta('scifact') }));
  const ev = {};
  for (const sp of ['train', 'dev']) if (have('scifact', `claims_${sp}.jsonl`)) ev[sp] = readJsonl(raw('scifact', `claims_${sp}.jsonl`));
  return { docs, evalSets: { scifact_claims: ev } };
};

X.qasper = () => {
  if (!have('qasper', 'qasper-dev-v0.3.json')) return null;
  const docs = [], papers = { train: [], dev: [] };
  for (const sp of ['train', 'dev']) {
    if (!have('qasper', `qasper-${sp}-v0.3.json`)) continue;
    const j = readJson(raw('qasper', `qasper-${sp}-v0.3.json`));
    for (const [pid, p] of Object.entries(j)) {
      docs.push({ id: 'qasper:' + pid, title: p.title, text: p.title + '. ' + p.abstract, url: 'https://arxiv.org/abs/' + pid, level: 'preprint-abstract', ...meta('qasper') });
      const paras = []; for (const s of p.full_text) for (const t of s.paragraphs) if (t.length > 40) paras.push(t);
      const idx = new Map(paras.map((t, i) => [t, i])); const qs = [];
      for (const q of p.qas) {
        const ev = new Set(); let answerable = false;
        for (const a of q.answers) { const an = a.answer; if (!an.unanswerable) answerable = true; for (const e of an.evidence || []) if (idx.has(e)) ev.add(idx.get(e)); }
        if (ev.size) qs.push({ q: q.question, ev: [...ev], answerable });
      }
      if (qs.length) papers[sp].push({ paper: pid, paragraphs: paras, qs });
    }
  }
  return { docs, evalSets: { qasper_evidence: papers } };
};

X.arxiv = () => {
  const docs = [];
  for (const cat of ['cs.LG', 'physics.optics', 'q-bio.NC', 'astro-ph.CO']) {
    if (!have('arxiv', `arxiv-${cat}.xml`)) continue;
    const xml = readFileSync(raw('arxiv', `arxiv-${cat}.xml`), 'utf8');
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1]; const g = (t) => ((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();
      const id = g('id').replace(/^https?:\/\/arxiv\.org\/abs\//, '');
      docs.push({ id: 'arxiv:' + id, title: g('title'), text: g('title') + '. ' + g('summary'), url: g('id'), category: cat, published: g('published'), level: 'preprint-abstract', ...meta('arxiv') });
    }
  }
  return docs.length ? { docs } : null;
};

X.xv6 = () => {
  const docs = [], files = ['proc', 'vm', 'spinlock', 'syscall', 'pipe', 'file', 'fs', 'trap'];
  for (const f of files) {
    if (!have('xv6', `kernel__${f}.c`)) continue;
    const src = readFileSync(raw('xv6', `kernel__${f}.c`), 'utf8'); const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([a-z_0-9]+)\(/i);
      let o = -1; if (m && !/^(if|for|while|switch|return|sizeof)$/.test(m[1])) for (let t = i; t <= i + 4 && t < lines.length; t++) if (lines[t] === '{') { o = t; break; }
      if (o > 0 && !lines.slice(i, o).some((l) => /;\s*$/.test(l))) {
        let j = o; while (j < lines.length && lines[j] !== '}') j++;
        let c = i - 2; while (c >= 0 && /^\s*(\/\/|\/?\*|\*\/)/.test(lines[c])) c--;
        const text = lines.slice(c + 1, j + 1).join('\n');
        docs.push({ id: `xv6:${f}.c:${m[1]}`, title: `${m[1]} (xv6 kernel/${f}.c)`, text, lang: 'c', url: `https://github.com/mit-pdos/xv6-riscv/blob/riscv/kernel/${f}.c`, level: 'reviewed-teaching-code', ...meta('xv6') });
      }
    }
  }
  return docs.length ? { docs } : null;
};

X.musiccaps = () => {
  if (!have('musiccaps', 'musiccaps-public.csv')) return null;
  const docs = csvObjects(readFileSync(raw('musiccaps', 'musiccaps-public.csv'), 'utf8')).map((r) => ({ id: 'musiccaps:' + r.ytid, title: 'music clip ' + r.ytid, text: r.caption, aspects: r.aspect_list, url: 'https://github.com/google-research-datasets/musiccaps', level: 'expert-annotation', ...meta('musiccaps') }));
  return { docs };
};
X.clotho = () => {
  if (!have('clotho', 'clotho_captions_development.csv')) return null;
  const rows = csvObjects(readFileSync(raw('clotho', 'clotho_captions_development.csv'), 'utf8'));
  return { evalSets: { clotho_captions: rows.map((r) => ({ file: r.file_name, captions: [1, 2, 3, 4, 5].map((i) => r['caption_' + i]).filter(Boolean) })) } };
};

X.maestro = () => {
  if (!have('maestro', 'maestro-v3.0.0.json')) return null;
  const j = readJson(raw('maestro', 'maestro-v3.0.0.json')); const n = Object.keys(j.canonical_title);
  const kb = [], docs = [], seen = new Set();
  for (const k of n) {
    const title = j.canonical_title[k], comp = j.canonical_composer[k], year = j.year[k], dur = j.duration[k];
    const id = 'perf' + k; kb.push(`FACT m${k}.c: composed_by(${id}, ${sym(comp)}) src=maestro:v3.0.0`, `FACT m${k}.t: performed_year(${id}, y${year}) src=maestro:v3.0.0`);
    kb.push(`FACT m${k}.k: is_a(${id}, piano_performance) src=maestro:v3.0.0`);
    docs.push({ id: 'maestro:' + k, title, text: `${title} by ${comp}, performed ${year}, ${Math.round(dur)} seconds, piano.`, url: 'https://magenta.tensorflow.org/datasets/maestro', level: 'curated-metadata', ...meta('maestro') });
    seen.add(comp);
  }
  return { docs, kb: { name: 'music', lines: kb } };
};

X.audioset = () => {
  if (!have('audioset', 'ontology.json')) return null;
  const o = readJson(raw('audioset', 'ontology.json')); const byMid = new Map(o.map((c) => [c.id, c]));
  const count = new Map(); for (const c of o) count.set(sym(c.name), (count.get(sym(c.name)) || 0) + 1);
  const nm = (c) => (count.get(sym(c.name)) > 1 ? sym(c.name) + '_' + sym(c.id.replace(/\//g, '')) : sym(c.name));
  const kb = ['RULE ont.trans: IF is_a(X,Y) & is_a(Y,Z) THEN is_a(X,Z) @1 src=audioset-ontology'], docs = [];
  for (const c of o) {
    for (const ch of c.child_ids) { const cc = byMid.get(ch); if (cc) kb.push(`FACT o.${sym(c.id)}.${sym(ch)}: is_a(${nm(cc)}, ${nm(c)}) src=audioset-ontology`); }
    if (c.description) docs.push({ id: 'audioset:' + c.id, title: c.name, text: c.name + ': ' + c.description, url: 'https://research.google.com/audioset/ontology/', level: 'curated-ontology', ...meta('audioset') });
  }
  return { docs, kb: { name: 'sound_ontology', lines: kb } };
};

X.fsd50k = () => {
  if (!have('fsd50k', 'vocabulary.csv')) return null;
  const lines = readFileSync(raw('fsd50k', 'vocabulary.csv'), 'utf8').trim().split('\n').map((l) => l.split(','));
  return { kb: { name: 'fsd50k', lines: lines.map(([i, name, mid]) => `FACT fsd.${i}: fsd_label(${sym(name)}, ${sym(mid)}) src=fsd50k:vocabulary`) } };
};

const ESC_GROUPS = ['animals', 'natural_soundscapes_and_water', 'human_non_speech', 'interior_domestic', 'exterior_urban'];
X.esc50 = () => {
  if (!have('esc50', 'esc50.csv')) return null;
  const rows = csvObjects(readFileSync(raw('esc50', 'esc50.csv'), 'utf8')); const seen = new Map();
  for (const r of rows) seen.set(r.category, Number(r.target));
  const kb = [...seen].flatMap(([c, t]) => [`FACT esc.${sym(c)}: esc_class(${sym(c)}, c${t}) src=esc50`, `FACT esc.g.${sym(c)}: sound_group(${sym(c)}, ${ESC_GROUPS[Math.floor(t / 10)]}) src=esc50:readme`]);
  return { kb: { name: 'esc50', lines: kb } };
};

X.ucd = () => {
  if (!have('ucd', 'UnicodeData.txt')) return null;
  const kb = ['RULE ucd.letter_u: IF gen_cat(C, lu) THEN is_letter(C) src=unicode', 'RULE ucd.letter_l: IF gen_cat(C, ll) THEN is_letter(C) src=unicode', 'RULE ucd.symbol: IF gen_cat(C, so) THEN is_symbol(C) src=unicode', 'RULE ucd.digit: IF gen_cat(C, nd) THEN is_digit(C) src=unicode', 'FUNC char_name/2 gen_cat/2 lower_of/2'];
  const docs = []; let n = 0;
  for (const l of readFileSync(raw('ucd', 'UnicodeData.txt'), 'utf8').split('\n')) {
    const f = l.split(';'); if (f.length < 14 || /<.*>/.test(f[1]) || f[2] === 'Cc') continue;
    const c = cp(f[0]); n++;
    kb.push(`FACT ucd.${c}.n: char_name(${c}, ${sym(f[1])}) src=unicode:UCD`, `FACT ucd.${c}.g: gen_cat(${c}, ${f[2].toLowerCase()}) src=unicode:UCD`);
    if (f[13]) kb.push(`FACT ucd.${c}.l: lower_of(${c}, ${cp(f[13])}) src=unicode:UCD`);
    if (n % 40 === 0) docs.push({ id: 'ucd:' + c, title: f[1], text: `U+${f[0]} ${f[1]} general category ${f[2]}`, url: 'https://www.unicode.org/ucd/', level: 'standard', ...meta('ucd') });
  }
  return { docs, kb: { name: 'unicode', lines: kb } };
};
X.emoji = () => {
  if (!have('emoji', 'emoji-test.txt')) return null;
  const kb = [], docs = []; let group = '', sub = '';
  for (const l of readFileSync(raw('emoji', 'emoji-test.txt'), 'utf8').split('\n')) {
    let m;
    if ((m = l.match(/^# group: (.*)/))) group = m[1]; else if ((m = l.match(/^# subgroup: (.*)/))) sub = m[1];
    else if ((m = l.match(/^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*\S+\s+E[\d.]+\s+(.*)$/))) {
      const id = 'e' + m[1].trim().toLowerCase().replace(/ /g, '_');
      kb.push(`FACT em.${id}.g: emoji_group(${id}, ${sym(group)}) src=unicode:emoji-test`, `FACT em.${id}.n: emoji_name(${id}, ${sym(m[2])}) src=unicode:emoji-test`);
      if (kb.length % 25 === 0) docs.push({ id: 'emoji:' + id, title: m[2], text: `emoji ${m[2]} in group ${group}, subgroup ${sub}`, url: 'https://unicode.org/emoji/charts/', level: 'standard', ...meta('emoji') });
    }
  }
  return kb.length ? { docs, kb: { name: 'emoji', lines: kb } } : null;
};
X.cldr = () => {
  if (!have('cldr', 'annotations-en.json')) return null;
  const a = readJson(raw('cldr', 'annotations-en.json')).annotations.annotations; const kb = [];
  for (const [ch, v] of Object.entries(a)) { const id = 'e' + [...ch].map((c) => c.codePointAt(0).toString(16)).join('_'); for (const k of v.default || []) kb.push(`FACT cl.${id}.${sym(k)}: emoji_keyword(${id}, ${sym(k)}) src=unicode:cldr`); }
  return { kb: { name: 'cldr', lines: kb } };
};

// ---------- driver ----------
export function extractAll() {
  const out = dir('processed'); const quality = { generated: today(), sources: {}, collections: {}, kb: {}, eval: {} };
  const cols = { science: [], code: [], 'audio-text': [], symbols: [], music: [] };
  const domainOf = { scifact: 'science', qasper: 'science', arxiv: 'science', xv6: 'code', musiccaps: 'audio-text', audioset: 'audio-text', maestro: 'music', ucd: 'symbols', emoji: 'symbols' };
  for (const [id, fn] of Object.entries(X)) {
    let r = null; try { r = fn(); } catch (e) { quality.sources[id] = { error: e.message }; continue; }
    if (!r) { quality.sources[id] = { skipped: 'raw data not present' }; continue; }
    const s = byId(id); const st = quality.sources[id] = { use: s.use, docs: r.docs?.length || 0, kbLines: r.kb?.lines.length || 0 };
    if (r.kb) { writeFileSync(path.join(dir('processed', 'kb'), r.kb.name + '.kb'), `# generated from ${id} (${s.license}); do not edit\n` + r.kb.lines.join('\n') + '\n'); quality.kb[r.kb.name] = { source: id, lines: r.kb.lines.length }; }
    if (r.evalSets) for (const [n, v] of Object.entries(r.evalSets)) { writeJson(path.join(dir('processed', 'eval'), n + '.json'), v); quality.eval[n] = { source: id }; }
    if (r.docs && domainOf[id]) {
      if (s.use !== 'train') { st.note = 'use != train: not added to training collections'; continue; }
      const rej = { cls: {}, examples: [] };
      const kept = r.docs.map((d) => ({ ...d, text: d.lang ? d.text : clean(d.text), title: clean(d.title) })).filter((d) => d.text.length >= 20).filter((d) => {
        const c = d.lang ? classifyCode(d.text) : classifyText(d.text);
        if (c.cls === 'GOOD') return true;
        rej.cls[c.cls] = (rej.cls[c.cls] || 0) + 1; if (rej.examples.length < 3) rej.examples.push({ id: d.id, cls: c.cls, reasons: c.reasons }); return false;
      });
      st.afterClean = kept.length; st.rejectedByClassifier = rej; cols[domainOf[id]].push(...kept);
    }
  }
  for (const [name, docs] of Object.entries(cols)) {
    if (!docs.length) continue;
    const { kept, dropped } = dedup(docs, { key: (d) => d.text, threshold: 0.9 });
    writeJsonl(path.join(dir('processed', 'collections'), name + '.jsonl'), kept);
    quality.collections[name] = { in: docs.length, out: kept.length, dropped, sources: [...new Set(kept.map((d) => d.source))], nc: kept.some((d) => d.nc), sa: kept.some((d) => d.sa) };
  }
  writeJson(path.join(out, 'quality.json'), quality);
  return quality;
}
