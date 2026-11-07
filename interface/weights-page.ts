/**
 * The Weights page (/weights): the net maker, the net skill maker, the weight
 * editor and the compiler, in one place.
 *
 * Wears the house look (see AGENTS.md, VISUAL STYLE): the server adds the ring
 * and background, this page only uses the shared tokens and shapes. Plain DOM
 * calls and textContent, never innerHTML with data, so nothing a net, a neuron
 * or a piece of code is named can run as markup. Nothing is fetched from
 * anywhere but this server.
 */
export const WEIGHTS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weights</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; background:#110c0e; color:#f8ede9; }
  main { position:relative; z-index:1; max-width:900px; margin:0 auto; padding:28px 16px 90px; display:grid; grid-template-columns:minmax(0,1fr); gap:18px; }
  h1 { font-size:22px; margin:6px 6px 0; }
  h2 { font-size:17px; margin:0 0 4px; }
  section { padding:24px 26px; }
  p { margin:6px 0 12px; font-size:14px; line-height:1.5; }
  a { color:#ffc4b4; }
  .links { margin:0 8px; font-size:14px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:10px 0; }
  .row > .grow { flex:1 1 140px; min-width:0; }
  textarea.nc-input { border-radius:24px; width:100%; box-sizing:border-box; min-height:150px; resize:vertical; font:13px ui-monospace, Menlo, Consolas, monospace; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0 0; font:13px/1.5 ui-monospace, Menlo, Consolas, monospace; color:rgba(248,237,233,.85); }
  .chip { display:inline-block; padding:2px 10px; margin:2px 4px 2px 0; border-radius:999px; font-size:12px;
          border:1px solid rgba(255,228,218,.2); background:rgba(255,238,230,.07); color:rgba(248,237,233,.62); }
  .chip.frozen { color:#ffc4b4; border-color:rgba(255,154,132,.5); }
  .chip.io { color:#8fe3a8; border-color:rgba(143,227,168,.4); }
  .line { padding:8px 14px; margin:6px 0; border-radius:24px; font-size:13px; line-height:1.45;
          background:rgba(255,240,232,.06); border:1px solid rgba(255,228,218,.14); }
  .line.hot { border-color:rgba(255,154,132,.5); background:rgba(255,154,132,.1); }
  .line.ro { opacity:.6; }
  #msg { min-height:20px; margin:0 8px; font-size:14px; }
  .err { color:#ff9aa8; } .on { color:#8fe3a8; }
  [hidden] { display:none !important; }
</style>
</head>
<body class="nc-soft">
<main>
  <h1>Weights</h1>
  <div class="links"><a href="/">Back to the agent</a></div>
  <div id="msg" class="nc-dim"></div>

  <section class="nc-glass">
    <h2>Make a net</h2>
    <p class="nc-dim">Write a program. <b>kind="network"</b> makes a network of its own (the net maker). <b>kind="skill"</b> grafts the neurons into the live AI (the net skill maker) and asks you to confirm first.</p>
    <textarea class="nc-input" id="src" spellcheck="false">kind="network"
neurons="8"
"n1"@input="hello"
"n1"@response="hi there"
"n2"@input="goodbye"
"n2"@response="see you later"
"n3"@frozen="now"
train="responses"</textarea>
    <div class="row">
      <button class="nc-btn primary" id="make">Make it</button>
      <label class="nc-dim"><input type="checkbox" id="confirm"> I know a skill changes the live AI</label>
    </div>
    <div id="made" class="nc-dim"></div>
  </section>

  <section class="nc-glass" id="editor" hidden>
    <h2>Look at the weights, run, change a little</h2>
    <p class="nc-dim">Type something to highlight a neuron as hard as it can be driven, and say what you want the output to be. It shows which weights decide the result and which way each should move. Every change is small, logged and can be undone. A frozen neuron cannot be edited.</p>
    <div class="row">
      <input class="nc-input grow" id="text" placeholder="Type (highlights a neuron)" autocomplete="off">
      <input class="nc-input grow" id="goal" placeholder="What the output should say" autocomplete="off">
    </div>
    <div class="row">
      <button class="nc-btn" id="respond">Run</button>
      <button class="nc-btn primary" id="view">Explain the weights</button>
      <button class="nc-btn" id="step">One small step</button>
      <button class="nc-btn" id="improve">Keep going (up to 10)</button>
      <button class="nc-btn" id="undo">Undo last</button>
    </div>
    <div id="neurons"></div>
    <pre id="out"></pre>
    <div id="lines"></div>
  </section>

  <section class="nc-glass">
    <h2>The compiler</h2>
    <p class="nc-dim">Write a numeric function and see the weights it becomes. Straight-line arithmetic compiles exactly; other numeric functions are fitted; anything else is only recognised, and it says so.</p>
    <div class="row">
      <input class="nc-input grow" id="code" value="(x) => 2*x + 1" autocomplete="off" spellcheck="false">
      <input class="nc-input" id="cin" value="3" style="width:110px" autocomplete="off" title="Inputs, comma separated">
      <button class="nc-btn primary" id="compile">Compile</button>
    </div>
    <pre id="cout"></pre>
  </section>
</main>
<script>
(function () {
  var net = null;
  var $ = function (id) { return document.getElementById(id); };
  function say(t, bad) { var m = $('msg'); m.textContent = t || ''; m.className = bad ? 'err' : 'nc-dim'; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || (j.errors || []).join('; ') || ('Error ' + r.status)); return j; }); });
  }
  function chips(info) {
    var box = $('neurons'); box.textContent = '';
    info.neurons.forEach(function (n) {
      var c = document.createElement('span'); c.className = 'chip';
      if (info.frozen.indexOf(n) >= 0) { c.className += ' frozen'; c.textContent = n + ' (frozen)'; }
      else if (n === info.inputNeuron || n === info.outputNeuron) { c.className += ' io'; c.textContent = n + (n === info.inputNeuron ? ' (input)' : ' (output)'); }
      else c.textContent = n;
      box.appendChild(c);
    });
  }
  function trainingText(t) {
    if (!t) return 'No training was asked for.';
    var s = 'Training (' + t.mode + '): ' + (t.converged ? 'every response met' : 'not all met');
    if (t.recall) s += ', ' + t.recall.correct + ' of ' + t.recall.total + ' land on their own response';
    if (t.skipped && t.skipped.length) s += '. Skipped (frozen): ' + t.skipped.join(', ');
    if (t.predict) s += '. Next-byte accuracy on text held back: ' + Math.round(t.predict.accuracy * 100) + '% (guessing the commonest byte: ' + Math.round(t.predict.baseline * 100) + '%; ' + Math.round(t.predict.heldOutSeen * 100) + '% of that text was already seen in training)';
    return s + '.';
  }
  function show(info) {
    net = info; $('editor').hidden = false; chips(info);
    var w = info.warnings && info.warnings.length ? ' ' + info.warnings.join(' ') : '';
    $('made').textContent = 'Made ' + info.kind + ' "' + info.name + '" with ' + info.neurons.length + ' neurons. ' + trainingText(info.training) + w;
  }
  function sel() { return { text: $('text').value, goal: $('goal').value || undefined }; }
  function need() { if (!net) { say('Make a net first.', true); return false; } return true; }

  $('make').onclick = function () {
    say('Making it...');
    post('/api/nets', { source: $('src').value, confirm: $('confirm').checked })
      .then(function (j) { say('Done.'); show(j); })
      .catch(function (e) { say(e.message, true); });
  };
  $('respond').onclick = function () {
    if (!need()) return;
    post('/api/nets/' + net.id + '/respond', { text: $('text').value }).then(function (j) {
      $('out').textContent = 'Typed text highlighted ' + j.drove + '. Closest response: ' + (j.response === null ? '(none declared)' : '"' + j.response + '"') + ' (similarity ' + j.similarity.toFixed(2) + ')';
    }).catch(function (e) { say(e.message, true); });
  };
  $('view').onclick = function () {
    if (!need()) return;
    post('/api/nets/' + net.id + '/view', sel()).then(function (j) {
      $('out').textContent = j.text_summary;
      var box = $('lines'); box.textContent = '';
      j.lines.forEach(function (l) {
        var d = document.createElement('div');
        d.className = 'line' + (l.share > 0.2 ? ' hot' : '') + (l.editable ? '' : ' ro');
        d.textContent = l.suggestion;
        if (l.editable) {
          [['raise', 0.05], ['lower', -0.05]].forEach(function (p) {
            var b = document.createElement('button'); b.className = 'nc-btn'; b.style.marginLeft = '8px'; b.textContent = p[0];
            b.onclick = function () {
              post('/api/nets/' + net.id + '/nudge', { target: l.target, source: l.source, dim: l.dim, delta: p[1], reason: 'by hand' })
                .then(function (r) { say('Changed ' + l.source + ' to ' + l.target + ' (dimension ' + l.dim + ') from ' + r.edit.before.toFixed(3) + ' to ' + r.edit.after.toFixed(3) + '.'); })
                .catch(function (e) { say(e.message, true); });
            };
            d.appendChild(b);
          });
        }
        box.appendChild(d);
      });
    }).catch(function (e) { say(e.message, true); });
  };
  function stepper(path, extra) {
    if (!need()) return;
    var s = sel(); if (!s.goal) { say('Say what the output should be.', true); return; }
    post('/api/nets/' + net.id + '/' + path, Object.assign({ text: s.text, goal: s.goal }, extra || {}))
      .then(function (j) {
        if (j.steps) $('out').textContent = 'Went ' + j.steps.length + ' step(s). Distance from the goal: ' + j.before.toFixed(4) + ' to ' + j.after.toFixed(4) + '.\\n' + j.steps.map(function (r, i) { return (i + 1) + '. ' + r.note; }).join('\\n');
        else $('out').textContent = j.note;
      }).catch(function (e) { say(e.message, true); });
  }
  $('step').onclick = function () { stepper('step'); };
  $('improve').onclick = function () { stepper('improve', { steps: 10 }); };
  $('undo').onclick = function () {
    if (!need()) return;
    post('/api/nets/' + net.id + '/undo', { count: 1 }).then(function (j) { say(j.undone.length ? 'Undid the last change.' : 'Nothing to undo.'); }).catch(function (e) { say(e.message, true); });
  };
  $('compile').onclick = function () {
    var inputs = $('cin').value.split(',').map(function (x) { return parseFloat(x); }).filter(function (x) { return isFinite(x); });
    post('/api/compile', { code: $('code').value, inputs: inputs }).then(function (j) { $('cout').textContent = j.summary; }).catch(function (e) { say(e.message, true); });
  };
})();
</script>
</body>
</html>
`;
