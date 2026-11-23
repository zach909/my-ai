/**
 * Uploads: a file, or a whole folder, attached to a chat message.
 *
 * The page reads what the person picked (or dropped) and sends each file's raw bytes to
 * POST /api/uploads, one request per file, all under one batch id. The server keeps them in the
 * current user's own data folder (uploads/<batch>/<path>) and the chat turn then carries a note
 * built from them: small text files go in whole, everything else is listed by name and size.
 * Nothing is transcribed, converted or sent anywhere else; the bytes stay as they came.
 *
 * Node built-ins only.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

/** One file may be this big. Past it the upload is refused and the partial file removed. */
export const UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
/** One batch (one message's worth of attachments) holds at most this many files. */
export const UPLOAD_MAX_FILES = 500;
/** A text file is put into the message whole up to this size... */
export const INLINE_FILE_BYTES = 64 * 1024;
/** ...and all the inlined text of one message is held to this. */
export const INLINE_TOTAL_BYTES = 192 * 1024;
/** Header the page sends. A custom header forces a CORS preflight, which a foreign page cannot pass. */
export const UPLOAD_HEADER = 'x-nc-upload';

const BATCH_RE = /^[a-f0-9]{8,32}$/;

export function isBatchId(v: unknown): v is string {
  return typeof v === 'string' && BATCH_RE.test(v);
}

/**
 * A path from the page, made safe to join under a batch folder: forward slashes, no empty, `.` or
 * `..` parts, no control characters, bounded length. A name that is nothing after cleaning gets `file`.
 */
export function safeRelPath(raw: unknown): string {
  const parts = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(p => p.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter(p => p && p !== '.' && p !== '..')
    .slice(0, 40)
    .map(p => (p.length > 200 ? p.slice(0, 200) : p));
  return parts.join('/') || 'file';
}

export function uploadsRoot(dataDir: string): string {
  return path.join(dataDir, 'uploads');
}

/** The absolute place a file lands, or null if it would fall outside its batch folder. */
export function uploadTarget(dataDir: string, batch: string, rel: string): string | null {
  if (!isBatchId(batch)) return null;
  const base = path.resolve(uploadsRoot(dataDir), batch);
  const target = path.resolve(base, safeRelPath(rel));
  return target.startsWith(base + path.sep) ? target : null;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

export interface StoreResult { ok: boolean; status: number; path?: string; bytes?: number; error?: string }

/**
 * Stream a request body to its place on disk. Never holds the file in memory. Stops and cleans up
 * if it passes the size cap or the connection breaks.
 */
export function storeUpload(req: http.IncomingMessage, dataDir: string, batch: string, rel: string): Promise<StoreResult> {
  return new Promise((resolve) => {
    const clean = safeRelPath(rel);
    const target = uploadTarget(dataDir, batch, clean);
    if (!target) { resolve({ ok: false, status: 400, error: 'Bad batch or path.' }); return; }
    try {
      const base = path.resolve(uploadsRoot(dataDir), batch);
      if (existsSync(base) && !existsSync(target) && countFiles(base) >= UPLOAD_MAX_FILES) {
        resolve({ ok: false, status: 413, error: `Too many files in one message (limit ${UPLOAD_MAX_FILES}).` });
        return;
      }
      mkdirSync(path.dirname(target), { recursive: true });
    } catch (err) {
      resolve({ ok: false, status: 500, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out = createWriteStream(target);
    let bytes = 0;
    let done = false;
    const finish = (r: StoreResult) => {
      if (done) return;
      done = true;
      if (!r.ok) { out.destroy(); try { rmSync(target, { force: true }); } catch { /* nothing to clean */ } }
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > UPLOAD_MAX_BYTES) {
        // Stop writing; the rest of the body is read and thrown away so the socket stays usable for the 413.
        finish({ ok: false, status: 413, error: `That file is over the ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MB limit.` });
        return;
      }
      if (!done) out.write(chunk);
    });
    req.on('end', () => {
      if (done) return;
      out.end(() => finish(bytes === 0
        ? { ok: false, status: 400, error: 'The body was empty, so there is no file.' }
        : { ok: true, status: 200, path: clean, bytes }));
    });
    req.on('error', () => finish({ ok: false, status: 400, error: 'The upload was interrupted.' }));
    out.on('error', (err) => finish({ ok: false, status: 500, error: err.message }));
  });
}

/** Text if it has no NUL byte and decodes as UTF-8 without replacement characters. */
export function looksLikeText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return !buf.toString('utf8').includes('�');
}

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The note added to a chat message for a batch: one entry per file the page named. Text files that
 * fit go in whole; the rest (binary, or too big) are listed with their size and where they are kept.
 * Only files that really are in the batch folder are read.
 */
export function buildAttachmentNote(dataDir: string, batch: unknown, files: unknown): string {
  if (!isBatchId(batch) || !Array.isArray(files) || files.length === 0) return '';
  const lines: string[] = [];
  let inlined = 0;
  const seen = new Set<string>();
  for (const f of files.slice(0, UPLOAD_MAX_FILES)) {
    const rel = safeRelPath(f);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const target = uploadTarget(dataDir, batch, rel);
    let size = -1;
    try { if (target) size = statSync(target).size; } catch { /* not there */ }
    if (!target || size < 0) { lines.push(`- ${rel}: not received`); continue; }
    if (size <= INLINE_FILE_BYTES && inlined + size <= INLINE_TOTAL_BYTES) {
      const buf = readFileSync(target);
      if (looksLikeText(buf)) {
        inlined += size;
        lines.push(`--- ${rel} (${human(size)}) ---`, buf.toString('utf8'), `--- end ${rel} ---`);
        continue;
      }
    }
    lines.push(`- ${rel} (${human(size)}), kept at uploads/${batch}/${rel}`);
  }
  return lines.length ? `\n\n[Attached ${seen.size} file${seen.size === 1 ? '' : 's'}]\n${lines.join('\n')}` : '';
}

/**
 * The page side: Attach button, File and Folder pickers, drag and drop (folders too), a tray of what
 * is waiting, and the uploader. Plain DOM, no library. It never uses a backslash or a template
 * placeholder, because it is placed inside the page's own template string.
 *
 * ncUploads.install({ area }) puts the buttons and tray in place and returns
 *   { pending(): number, send(): Promise<{batch, files}|null>, clear() }
 */
export const UPLOAD_CLIENT_JS = `
var ncUploads = (function () {
  var SKIP = { '.git': 1, 'node_modules': 1, '.DS_Store': 1 };
  var MAX_FILES = ${UPLOAD_MAX_FILES};
  var items = [];          // { file, path }
  var tray, status, skipped = 0;

  function human(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function keep(path) {
    var parts = path.split('/');
    for (var i = 0; i < parts.length; i++) if (SKIP[parts[i]]) return false;
    return true;
  }
  function add(file, path) {
    path = path || file.webkitRelativePath || file.name;
    if (!keep(path)) { skipped++; return; }
    if (items.length >= MAX_FILES) { skipped++; return; }
    for (var i = 0; i < items.length; i++) if (items[i].path === path) { items[i].file = file; return; }
    items.push({ file: file, path: path });
  }
  function render() {
    tray.textContent = '';
    tray.hidden = items.length === 0 && !skipped && !status.textContent;
    // A folder shows as one chip with its file count, not as hundreds of chips.
    var groups = {}, order = [];
    items.forEach(function (it) {
      var top = it.path.indexOf('/') > 0 ? it.path.split('/')[0] : '';
      var key = top || it.path;
      if (!groups[key]) { groups[key] = { folder: !!top, n: 0, bytes: 0 }; order.push(key); }
      groups[key].n++; groups[key].bytes += it.file.size;
    });
    order.forEach(function (key) {
      var g = groups[key];
      var chip = document.createElement('span');
      chip.className = 'upload-chip';
      var label = document.createElement('span');
      label.textContent = (g.folder ? key + '/ (' + g.n + ' file' + (g.n === 1 ? '' : 's') + ', ' : key + ' (') + human(g.bytes) + ')';
      var x = document.createElement('button');
      x.type = 'button'; x.textContent = '\\u00d7';
      x.setAttribute('aria-label', 'Remove ' + key);
      x.onclick = function () {
        items = items.filter(function (it) { return (it.path.indexOf('/') > 0 ? it.path.split('/')[0] : it.path) !== key; });
        render();
      };
      chip.appendChild(label); chip.appendChild(x); tray.appendChild(chip);
    });
    if (skipped) {
      var s = document.createElement('span');
      s.className = 'nc-dim upload-note';
      s.textContent = skipped + ' skipped (.git, node_modules, or past ' + MAX_FILES + ' files)';
      tray.appendChild(s);
    }
    if (status.textContent) tray.appendChild(status);
  }
  function addList(list) { for (var i = 0; i < list.length; i++) add(list[i]); render(); }

  // A dropped folder arrives as an entry, not a file: walk it.
  function walk(entry, prefix, jobs) {
    if (entry.isFile) {
      jobs.push(new Promise(function (ok) {
        entry.file(function (f) { add(f, prefix + entry.name); ok(); }, function () { ok(); });
      }));
    } else if (entry.isDirectory) {
      jobs.push(new Promise(function (ok) {
        var reader = entry.createReader(), all = [];
        (function more() {
          reader.readEntries(function (batch) {
            if (!batch.length) { var inner = []; all.forEach(function (e) { walk(e, prefix + entry.name + '/', inner); }); Promise.all(inner).then(ok); return; }
            all = all.concat(Array.prototype.slice.call(batch)); more();
          }, function () { ok(); });
        })();
      }));
    }
  }

  function install(o) {
    var area = o.area;
    tray = document.createElement('div');
    tray.id = 'upload-tray'; tray.hidden = true;
    tray.setAttribute('aria-live', 'polite');
    status = document.createElement('span');
    status.className = 'nc-dim upload-note';
    area.parentNode.insertBefore(tray, area);

    var fileIn = document.createElement('input');
    fileIn.type = 'file'; fileIn.multiple = true; fileIn.hidden = true;
    var dirIn = document.createElement('input');
    dirIn.type = 'file'; dirIn.hidden = true;
    dirIn.setAttribute('webkitdirectory', ''); dirIn.setAttribute('directory', '');
    fileIn.onchange = function () { addList(fileIn.files); fileIn.value = ''; };
    dirIn.onchange = function () { addList(dirIn.files); dirIn.value = ''; };

    var wrap = document.createElement('span');
    wrap.id = 'upload-wrap'; wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'Attach a file or a folder');
    [['File', 'Attach one or more files', fileIn], ['Folder', 'Attach a whole folder', dirIn]].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'upload-btn'; btn.textContent = b[0]; btn.title = b[1];
      btn.onclick = function () { b[2].click(); };
      wrap.appendChild(btn);
    });
    wrap.appendChild(fileIn); wrap.appendChild(dirIn);
    area.insertBefore(wrap, o.before);

    // Drop anywhere on the page.
    var depth = 0;
    document.addEventListener('dragenter', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { depth++; document.body.classList.add('upload-drag'); }
    });
    document.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('upload-drag'); });
    document.addEventListener('dragover', function (e) { if (document.body.classList.contains('upload-drag')) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      depth = 0; document.body.classList.remove('upload-drag');
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      var jobs = [], list = e.dataTransfer.items;
      var entries = [];
      if (list) for (var i = 0; i < list.length; i++) {
        var en = list[i].webkitGetAsEntry && list[i].webkitGetAsEntry();
        if (en) entries.push(en);
      }
      if (entries.length) { entries.forEach(function (en) { walk(en, '', jobs); }); Promise.all(jobs).then(render); }
      else addList(e.dataTransfer.files);
    });
  }

  function rand() {
    var b = new Uint8Array(8); crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  // Upload everything waiting. Resolves { batch, files } when all went, or null when there was nothing.
  // Throws with a readable message if one fails; what is waiting stays, so a retry resends it.
  async function send() {
    if (!items.length) return null;
    var batch = rand(), done = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      status.textContent = 'Uploading ' + (i + 1) + ' of ' + items.length + ': ' + it.path;
      render();
      var r = await fetch('/api/uploads?batch=' + batch + '&path=' + encodeURIComponent(it.path), {
        method: 'POST', headers: { 'X-NC-Upload': '1' }, body: it.file
      });
      if (!r.ok) {
        var msg = 'Upload failed for ' + it.path;
        try { var j = await r.json(); if (j.error) msg += ': ' + j.error; } catch (e) {}
        status.textContent = ''; render();
        throw new Error(msg);
      }
      done.push(it.path);
    }
    return { batch: batch, files: done };
  }
  function clear() { items = []; skipped = 0; status.textContent = ''; render(); }
  return { install: install, send: send, clear: clear, pending: function () { return items.length; } };
})();
`;

export const UPLOAD_CSS = `
  #upload-wrap { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .upload-btn {
    background: rgba(255, 238, 230, 0.07);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 10px 16px;
    min-height: 44px;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    backdrop-filter: blur(12px);
    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .upload-btn:hover { background: rgba(227,169,157, 0.28); transform: translateY(-2px) scale(1.03); }
  .upload-btn:active { transform: translateY(0) scale(0.95); }
  #upload-tray {
    position: relative; z-index: 1;
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 8px 24px 0;
    background: rgba(20, 23, 28, 0.4);
    backdrop-filter: blur(30px);
    font-size: 12px;
  }
  #upload-tray[hidden] { display: none; }
  .upload-chip {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(227,169,157, 0.12);
    border: 1px solid rgba(227,169,157, 0.4);
    border-radius: 999px;
    padding: 4px 6px 4px 14px;
    max-width: 100%;
  }
  .upload-chip button {
    background: rgba(255, 238, 230, 0.07); color: var(--text);
    border: 1px solid var(--border); border-radius: 999px;
    width: 22px; height: 22px; line-height: 1; cursor: pointer; font-family: inherit;
  }
  body.upload-drag #chat-container { outline: 2px dashed rgba(227,169,157, 0.6); outline-offset: -12px; border-radius: 32px; }
  @media (max-width: 600px) { #upload-tray { padding: 8px 16px 0; } }
`;
