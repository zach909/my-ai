/**
 * The editor page (/editor): a visual editor for each kind of file the agent
 * can edit, with a live diff so the text can be double-checked before and after
 * it is saved.
 *
 * - code and plain text: line numbers, Tab indents, find.
 * - Markdown: the text beside a rendered preview.
 * - JSON: a form of typed fields beside the raw text, with parse errors shown.
 * - every kind: a Changes panel (the diff against what is on disk) and, after a
 *   save, a read-back check that the file on disk is exactly what was sent.
 *
 * `/editor?path=docs/README.md` opens a file directly, so the agent can point a
 * person at what it changed. Wears the house look (AGENTS.md, VISUAL STYLE): the
 * server adds the ring and background. Plain DOM calls and textContent, never
 * innerHTML with data, so a file's text can never run as markup. Nothing is
 * fetched from anywhere but this server.
 */
export const EDITOR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Editor</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; background:#110c0e; color:#f8ede9; }
  main { position:relative; z-index:1; max-width:1200px; margin:0 auto; padding:24px 14px 80px; display:grid; gap:16px;
         grid-template-columns:minmax(0,300px) minmax(0,1fr); align-items:start; }
  @media (max-width:820px) { main { grid-template-columns:minmax(0,1fr); } }
  h1 { font-size:22px; margin:4px 6px 0; grid-column:1/-1; }
  section { padding:18px 20px; }
  a { color:#efd0c8; }
  .dim { color:rgba(248,237,233,.62); font-size:13px; }
  #files { max-height:70vh; overflow:auto; margin-top:10px; }
  .file { display:block; width:100%; text-align:left; padding:7px 12px; margin:3px 0; border-radius:999px; font-size:13px; cursor:pointer;
          color:inherit; background:rgba(255,240,232,.05); border:1px solid rgba(255,228,218,.12); overflow-wrap:anywhere; font:inherit; font-size:13px; }
  .file:hover { background:rgba(227,169,157,.16); }
  .file.sel { border-color:rgba(227,169,157,.55); background:rgba(227,169,157,.14); }
  .chip { display:inline-block; padding:2px 10px; margin-left:6px; border-radius:999px; font-size:12px; border:1px solid rgba(255,228,218,.2);
          background:rgba(255,238,230,.07); color:rgba(248,237,233,.62); }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:10px 0; }
  .grow { flex:1 1 160px; min-width:0; }
  .ok { color:#8fe3a8; } .err { color:#ff9aa8; }
  .pane { display:grid; gap:12px; grid-template-columns:minmax(0,1fr); }
  .pane.two { grid-template-columns:repeat(2,minmax(0,1fr)); }
  @media (max-width:820px) { .pane.two { grid-template-columns:minmax(0,1fr); } }
  .code { display:flex; border-radius:24px; overflow:hidden; border:1px solid rgba(255,228,218,.2); background:rgba(0,0,0,.28); }
  .gutter { margin:0; padding:12px 8px 12px 14px; text-align:right; color:rgba(248,237,233,.35); user-select:none; overflow:hidden;
            font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; }
  textarea.ta { flex:1; min-width:0; min-height:420px; max-height:70vh; padding:12px 14px; border:0; outline:0; resize:vertical; background:transparent; color:#f8ede9;
                font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; overflow:auto; tab-size:2; }
  .tree { border-radius:24px; border:1px solid rgba(255,228,218,.2); background:rgba(0,0,0,.2); padding:12px 14px; max-height:70vh; overflow:auto; font-size:13px; }
  .tree .node { margin:4px 0 4px 14px; } .tree .k { color:#efd0c8; margin-right:6px; }
  .tree input[type=text], .tree input[type=number] { font:inherit; color:inherit; background:rgba(255,238,230,.07); border:1px solid rgba(255,228,218,.2);
                border-radius:999px; padding:3px 10px; min-width:80px; max-width:100%; }
  .tree input[type=checkbox] { accent-color:#e3a99d; }
  .tree summary { cursor:pointer; } .tree .tp { color:rgba(248,237,233,.45); font-size:12px; margin-left:6px; }
  .md { border-radius:24px; border:1px solid rgba(255,228,218,.2); background:rgba(0,0,0,.2); padding:12px 18px; max-height:70vh; overflow:auto; font-size:14px; line-height:1.55; }
  .md h1,.md h2,.md h3 { margin:12px 0 6px; } .md code { background:rgba(255,238,230,.1); border-radius:8px; padding:1px 6px; }
  .md pre { background:rgba(0,0,0,.35); border-radius:18px; padding:10px 14px; overflow:auto; } .md p { margin:6px 0; } .md li { margin:2px 0; }
  .diff { border-radius:24px; border:1px solid rgba(255,228,218,.2); background:rgba(0,0,0,.28); max-height:46vh; overflow:auto; padding:8px 0;
          font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .dl { display:flex; white-space:pre-wrap; overflow-wrap:anywhere; padding:0 14px; }
  .dl b { flex:none; width:2.6em; font-weight:400; color:rgba(248,237,233,.35); user-select:none; }
  .dl.add { background:rgba(143,227,168,.13); } .dl.del { background:rgba(255,154,168,.13); } .dl.gap { color:rgba(248,237,233,.35); }
  #find { max-width:200px; }
</style>
</head>
<body class="nc-soft">
<main>
  <h1>Editor</h1>
  <section class="nc-glass">
    <div class="dim">Every file here is text the agent can edit. Pick one to open it in the editor made for its kind.</div>
    <input id="filter" class="nc-input" placeholder="Filter files" style="width:100%;box-sizing:border-box;margin-top:10px" aria-label="Filter files">
    <div id="files" role="list"></div>
  </section>
  <section class="nc-glass" id="work">
    <div id="head" class="row"><span class="dim">No file open.</span></div>
    <div id="msg" class="dim" style="min-height:20px"></div>
    <div id="editor"></div>
    <h3 style="margin:16px 4px 6px;font-size:15px">Changes <span id="stat" class="dim"></span></h3>
    <div id="diff" class="diff"><div class="dl gap"><b></b>Nothing to compare yet.</div></div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var st = { path: null, kind: null, text: '', saved: '', hash: null, readOnly: false, files: [] };
  var diffTimer = 0, diffSeq = 0, ta = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(url, body) {
    var opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(url, opt).then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
  }
  function say(text, cls) { var m = $('msg'); m.textContent = text || ''; m.className = cls || 'dim'; }

  // ---- file list
  function drawFiles() {
    var q = $('filter').value.trim().toLowerCase(), box = $('files'), n = 0;
    box.textContent = '';
    st.files.forEach(function (f) {
      if (q && f.path.toLowerCase().indexOf(q) < 0) return;
      if (++n > 400) return;
      var b = el('button', 'file' + (f.path === st.path ? ' sel' : ''), f.path);
      b.type = 'button';
      if (f.readOnly) b.appendChild(el('span', 'chip', 'read only'));
      b.onclick = function () { openFile(f.path); };
      box.appendChild(b);
    });
    if (!n) box.appendChild(el('div', 'dim', 'No files match.'));
    else if (n > 400) box.appendChild(el('div', 'dim', 'Showing the first 400. Type to narrow it down.'));
  }

  // ---- opening and saving
  function dirty() { return st.path !== null && st.text !== st.saved; }
  function openFile(p) {
    if (dirty() && !confirm('Discard unsaved changes to ' + st.path + '?')) return;
    say('Opening…');
    api('/api/editor/file?path=' + encodeURIComponent(p)).then(function (j) {
      if (j.error) { say(j.error, 'err'); return; }
      st.path = j.path; st.kind = j.kind; st.text = st.saved = j.content; st.hash = j.hash; st.readOnly = !!j.readOnly;
      try { history.replaceState(null, '', '/editor?path=' + encodeURIComponent(j.path)); } catch (e) {}
      say('');
      drawFiles(); drawHead(); drawEditor(); refreshDiff();
    });
  }
  function drawHead() {
    var h = $('head'); h.textContent = '';
    var t = el('strong', 'grow', st.path); t.style.overflowWrap = 'anywhere'; h.appendChild(t);
    h.appendChild(el('span', 'chip', st.kind));
    if (st.readOnly) h.appendChild(el('span', 'chip', 'read only: guards the no-third-party rule'));
    var save = el('button', 'nc-btn primary', 'Save'); save.type = 'button'; save.id = 'save'; save.disabled = st.readOnly;
    save.onclick = doSave; h.appendChild(save);
    var rev = el('button', 'nc-btn', 'Revert'); rev.type = 'button';
    rev.onclick = function () { setText(st.saved, true); say('Reverted to what is on disk.'); };
    h.appendChild(rev);
  }
  function doSave() {
    if (!dirty()) { say('Nothing has changed.'); return; }
    say('Saving…');
    api('/api/editor/save', { path: st.path, content: st.text, baseHash: st.hash }).then(function (j) {
      if (j.ok && j.verified) {
        st.saved = st.text; st.hash = j.hash;
        say('Saved and read back from disk: it matches (' + j.diff.added + ' added, ' + j.diff.removed + ' removed).', 'ok');
        refreshDiff();
      } else say(j.error || 'The save failed.', 'err');
    });
  }

  // ---- text state shared by every editor
  function setText(t, redraw) {
    st.text = t;
    if (redraw) drawEditor();
    refreshDiff();
  }
  function refreshDiff() {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(function () {
      if (st.path === null) return;
      var seq = ++diffSeq;
      api('/api/editor/diff', { path: st.path, content: st.text }).then(function (j) {
        if (seq !== diffSeq || j.error) { if (j.error) say(j.error, 'err'); return; }
        drawDiff(j.diff);
      });
    }, 200);
  }
  function drawDiff(d) {
    var box = $('diff'); box.textContent = '';
    $('stat').textContent = d.same ? '(identical to disk)' : '(' + d.added + ' added, ' + d.removed + ' removed)';
    if (d.same) { box.appendChild(el('div', 'dl gap', 'No changes.')); return; }
    // Show changed lines with three lines of context either side; gaps are folded.
    var show = new Array(d.lines.length), i, j;
    for (i = 0; i < d.lines.length; i++) if (d.lines[i].t !== ' ') for (j = Math.max(0, i - 3); j <= Math.min(d.lines.length - 1, i + 3); j++) show[j] = true;
    var folded = false;
    d.lines.forEach(function (l, k) {
      if (!show[k]) { if (!folded) { var g = el('div', 'dl gap'); g.appendChild(el('b', null, '…')); g.appendChild(el('span', null, 'unchanged lines')); box.appendChild(g); folded = true; } return; }
      folded = false;
      var row = el('div', 'dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''));
      row.appendChild(el('b', null, l.t === ' ' ? String(l.a) : l.t === '+' ? '+' + l.b : '-' + l.a));
      row.appendChild(el('span', null, l.s === '' ? ' ' : l.s));
      box.appendChild(row);
    });
  }

  // ---- editors
  function drawEditor() {
    var box = $('editor'); box.textContent = ''; ta = null;
    var pane = el('div', 'pane' + (st.kind === 'markdown' || st.kind === 'json' ? ' two' : ''));
    if (st.kind === 'json') {
      var treeBox = el('div', 'tree'); pane.appendChild(treeBox);
      pane.appendChild(codeArea(function () { drawTree(treeBox); }));
      drawTree(treeBox);
    } else if (st.kind === 'markdown') {
      pane.appendChild(codeArea(null));
      var prev = el('div', 'md'); pane.appendChild(prev); prev.id = 'preview'; drawMarkdown(prev);
      ta.addEventListener('input', function () { drawMarkdown(prev); });
    } else pane.appendChild(codeArea(null, true));
    box.appendChild(pane);
    if (st.kind === 'code' || st.kind === 'text') {
      var row = el('div', 'row');
      var f = el('input', 'nc-input'); f.id = 'find'; f.placeholder = 'Find'; f.setAttribute('aria-label', 'Find in file');
      var info = el('span', 'dim');
      function find(dir) {
        var q = f.value; if (!q) return;
        var from = dir > 0 ? ta.selectionEnd : ta.selectionStart - 1;
        var at = dir > 0 ? st.text.indexOf(q, from) : st.text.lastIndexOf(q, from);
        if (at < 0) at = dir > 0 ? st.text.indexOf(q) : st.text.lastIndexOf(q);
        if (at < 0) { info.textContent = 'Not found'; return; }
        ta.focus(); ta.setSelectionRange(at, at + q.length);
        info.textContent = 'Line ' + (st.text.slice(0, at).split('\\n').length);
      }
      f.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); } };
      var nx = el('button', 'nc-btn', 'Next'); nx.type = 'button'; nx.onclick = function () { find(1); };
      var pv = el('button', 'nc-btn', 'Previous'); pv.type = 'button'; pv.onclick = function () { find(-1); };
      row.appendChild(f); row.appendChild(pv); row.appendChild(nx); row.appendChild(info);
      box.appendChild(row);
    }
  }
  function codeArea(onChange, withNumbers) {
    var wrap = el('div', 'code'), gut = el('pre', 'gutter');
    ta = el('textarea', 'ta'); ta.value = st.text; ta.spellcheck = false; ta.readOnly = st.readOnly; ta.setAttribute('aria-label', 'File text');
    function numbers() {
      var n = st.text.split('\\n').length, s = '';
      for (var i = 1; i <= n; i++) s += i + '\\n';
      gut.textContent = s;
    }
    ta.addEventListener('input', function () { st.text = ta.value; numbers(); refreshDiff(); if (onChange) onChange(); });
    ta.addEventListener('scroll', function () { gut.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey && !st.readOnly) {
        e.preventDefault();
        var a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + '  ' + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + 2;
        ta.dispatchEvent(new Event('input'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(); }
    });
    wrap.appendChild(gut); wrap.appendChild(ta); numbers();
    return wrap;
  }

  // ---- Markdown preview, built from DOM nodes so file text is never markup
  function inline(parent, s) {
    var re = /(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\\[[^\\]]+\\]\\([^)]+\\))/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      var t = m[0];
      if (t[0] === '\`') parent.appendChild(el('code', null, t.slice(1, -1)));
      else if (t.slice(0, 2) === '**') parent.appendChild(el('strong', null, t.slice(2, -2)));
      else if (t[0] === '*') parent.appendChild(el('em', null, t.slice(1, -1)));
      else { var mm = /\\[([^\\]]+)\\]\\(([^)]+)\\)/.exec(t); var a = el('a', null, mm[1]); if (/^(https?:|\\/|#)/.test(mm[2])) { a.href = mm[2]; a.rel = 'noopener'; } parent.appendChild(a); }
      last = m.index + t.length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }
  function drawMarkdown(box) {
    box.textContent = '';
    var lines = st.text.split('\\n'), i = 0, list = null;
    while (i < lines.length) {
      var l = lines[i], m;
      if (/^\`\`\`/.test(l)) { var code = []; i++; while (i < lines.length && !/^\`\`\`/.test(lines[i])) code.push(lines[i++]); i++; box.appendChild(el('pre', null, code.join('\\n'))); list = null; continue; }
      if ((m = /^(#{1,3})\\s+(.*)$/.exec(l))) { var h = el('h' + m[1].length); inline(h, m[2]); box.appendChild(h); list = null; }
      else if ((m = /^\\s*[-*]\\s+(.*)$/.exec(l)) || (m = /^\\s*\\d+\\.\\s+(.*)$/.exec(l))) {
        if (!list) { list = el(/^\\s*\\d/.test(l) ? 'ol' : 'ul'); box.appendChild(list); }
        var li = el('li'); inline(li, m[1]); list.appendChild(li);
      } else if (l.trim() === '') list = null;
      else { var p = el('p'); inline(p, l); box.appendChild(p); list = null; }
      i++;
    }
  }

  // ---- JSON form: typed fields that rewrite the raw text
  function drawTree(box) {
    box.textContent = '';
    var data;
    try { data = JSON.parse(st.text); } catch (e) { box.appendChild(el('div', 'err', 'Not valid JSON yet: ' + e.message)); return; }
    function commit() { st.text = JSON.stringify(data, null, 2) + (st.text.slice(-1) === '\\n' ? '\\n' : ''); if (ta) ta.value = st.text; refreshDiff(); }
    function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
    function build(parent, key, holder, hk) {
      var v = holder[hk], t = typeOf(v), node = el('div', 'node');
      if (t === 'object' || t === 'array') {
        var d = el('details'); d.open = true;
        var s = el('summary'); s.appendChild(el('span', 'k', key)); s.appendChild(el('span', 'tp', t + ' (' + Object.keys(v).length + ')')); d.appendChild(s);
        Object.keys(v).forEach(function (k) { build(d, k, v, t === 'array' ? Number(k) : k); });
        node.appendChild(d);
      } else {
        node.appendChild(el('span', 'k', key));
        var inp;
        if (t === 'boolean') { inp = el('input'); inp.type = 'checkbox'; inp.checked = v; inp.onchange = function () { holder[hk] = inp.checked; commit(); }; }
        else if (t === 'number') { inp = el('input'); inp.type = 'number'; inp.step = 'any'; inp.value = String(v); inp.oninput = function () { if (inp.value !== '' && isFinite(Number(inp.value))) { holder[hk] = Number(inp.value); commit(); } }; }
        else if (t === 'string') { inp = el('input'); inp.type = 'text'; inp.value = v; inp.oninput = function () { holder[hk] = inp.value; commit(); }; }
        else inp = el('span', 'dim', 'null');
        inp.disabled = st.readOnly; node.appendChild(inp); node.appendChild(el('span', 'tp', t));
      }
      parent.appendChild(node);
    }
    var root = { '(root)': data };
    build(box, '(root)', root, '(root)');
  }

  // ---- start
  $('filter').oninput = drawFiles;
  window.addEventListener('beforeunload', function (e) { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  api('/api/editor/files').then(function (j) {
    if (j.error) { say(j.error, 'err'); return; }
    st.files = j.files; drawFiles();
    var want = new URLSearchParams(location.search).get('path');
    if (want) openFile(want);
  });
})();
</script>
</body>
</html>`;
