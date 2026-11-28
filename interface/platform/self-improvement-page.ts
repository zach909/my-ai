/**
 * Self-improvement — view the engine's learning progress and metrics.
 * Displays learning metrics, skill improvements, and optimization data.
 */

export function selfImprovementPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Self-improvement</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: linear-gradient(135deg, #110c0e 0%, #1b1216 100%);
    color: #f8ede9;
    font-family: ui-rounded, system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.5;
  }
  main {
    max-width: 56rem;
    margin: 0 auto;
    padding: 24px;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 24px;
    color: #efd0c8;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    border-bottom: 1px solid rgba(227,169,157, 0.2);
    flex-wrap: wrap;
  }
  .tab-button {
    padding: 12px 16px;
    background: transparent;
    border: none;
    color: rgba(248, 237, 233, 0.62);
    font-family: inherit;
    font-size: 1rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab-button.active {
    color: #efd0c8;
    border-bottom-color: #e3a99d;
  }
  .tab-content {
    display: none;
  }
  .tab-content.active {
    display: block;
  }
  .metric {
    background: rgba(227,169,157, 0.08);
    border: 1px solid rgba(227,169,157, 0.2);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .metric h2 {
    margin: 0 0 12px;
    font-size: 1.1rem;
    color: #efd0c8;
  }
  .metric-value {
    font-size: 2.5rem;
    color: #e3a99d;
    font-weight: 500;
    margin-bottom: 8px;
  }
  .metric-label {
    color: rgba(248, 237, 233, 0.62);
    font-size: 0.95rem;
  }
  .progress-bar {
    width: 100%;
    height: 12px;
    background: rgba(227,169,157, 0.1);
    border-radius: 6px;
    overflow: hidden;
    margin-top: 12px;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #e3a99d 0%, #efd0c8 100%);
    border-radius: 6px;
    transition: width 0.3s ease;
  }
  .info {
    background: rgba(227,169,157, 0.04);
    border-left: 3px solid #e3a99d;
    padding: 16px;
    border-radius: 4px;
    margin-bottom: 24px;
  }
  .info p {
    margin: 0;
    color: rgba(248, 237, 233, 0.75);
    font-size: 0.95rem;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  @media (min-width: 640px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .stat-box {
    background: rgba(227,169,157, 0.06);
    border: 1px solid rgba(227,169,157, 0.15);
    border-radius: 8px;
    padding: 12px;
  }
  .stat-label {
    color: rgba(248, 237, 233, 0.62);
    font-size: 0.85rem;
  }
  .stat-value {
    color: #efd0c8;
    font-size: 1.3rem;
    font-weight: 500;
    margin-top: 4px;
  }
  button {
    background: rgba(227,169,157, 0.16);
    border: 1px solid rgba(227,169,157, 0.5);
    color: #efd0c8;
    padding: 10px 20px;
    border-radius: 999px;
    font-family: inherit;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover {
    background: rgba(227,169,157, 0.24);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sd-row {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 10px 0;
    border-top: 1px solid rgba(255, 228, 218, 0.2);
  }
  .sd-row:first-of-type {
    border-top: none;
  }
  .sd-dim {
    color: rgba(248, 237, 233, 0.62);
    font-size: 0.9rem;
  }
  .sd-line {
    padding: 8px 12px;
    margin: 6px 0;
    border-radius: 16px;
    font-size: 0.92rem;
    overflow-wrap: anywhere;
  }
  .sd-debugger {
    background: rgba(227, 169, 157, 0.1);
    border: 1px solid rgba(227, 169, 157, 0.25);
  }
  .sd-critic {
    background: rgba(255, 240, 232, 0.07);
    border: 1px solid rgba(255, 228, 218, 0.2);
  }
  .sd-who {
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #e3a99d;
    margin-right: 8px;
  }
  .sd-kept { color: #8fe3a8; }
  .sd-undone { color: #ff9aa8; }
</style>

<main>
  <h1>Self-improvement</h1>

  <div class="tabs">
    <button class="tab-button active" data-tab="overview">Overview</button>
    <button class="tab-button" data-tab="skills">Skills</button>
    <button class="tab-button" data-tab="reasoning">Reasoning</button>
    <button class="tab-button" data-tab="history">History</button>
    <button class="tab-button" data-tab="selfdebug">Self-debug</button>
  </div>

  <div id="overview" class="tab-content active">
    <div class="info">
      <p><strong>Learning and improvement metrics</strong> from the engine's interactions, skill development, and system optimizations.</p>
    </div>
    <div id="overview-content"></div>
  </div>

  <div id="skills" class="tab-content">
    <div id="skills-content"></div>
  </div>

  <div id="reasoning" class="tab-content">
    <div id="reasoning-content"></div>
  </div>

  <div id="history" class="tab-content">
    <div id="history-content"></div>
  </div>

  <div id="selfdebug" class="tab-content">
    <div class="info">
      <p><strong>Self-debug.</strong> The AI runs a net's own test cases, sees which answers are wrong or weak, looks at the weights behind them and what happened to those weights last time, changes a few a little, and has a critic re-measure. A change that helps and breaks nothing is kept; anything else is undone. When weights cannot fix a wrong answer it makes a skill with the Extension Builder, and after enough skills it proposes a plugin that stays off until you approve it. The two voices in a run are a structured review computed from the measurements, not a language model.</p>
    </div>
    <div id="selfdebug-content"></div>
  </div>
</main>

<script>
  var TABS = ['overview', 'skills', 'reasoning', 'history'];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(v) { return v == null ? 'no data yet' : v + '%'; }
  function stat(label, value) {
    return '<div class="stat-box"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div></div>';
  }
  function meter(title, valueText, label, percent) {
    var w = percent == null ? 0 : Math.max(0, Math.min(100, percent));
    return '<div class="metric"><h2>' + esc(title) + '</h2><div class="metric-value">' + esc(valueText) + '</div>'
      + '<div class="metric-label">' + esc(label) + '</div>'
      + '<div class="progress-bar"><div class="progress-fill" style="width: ' + w + '%"></div></div></div>';
  }
  function empty(text) { return '<div class="metric"><div class="metric-label">' + esc(text) + '</div></div>'; }

  document.querySelectorAll('.tab-button').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var tabName = e.currentTarget.dataset.tab;
      document.querySelectorAll('.tab-button').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      e.currentTarget.classList.add('active');
      document.getElementById(tabName).classList.add('active');
      loadTabContent(tabName);
    });
  });

  loadTabContent('overview');

  async function loadTabContent(tab) {
    var target = document.getElementById(tab + '-content');
    if (tab === 'selfdebug') { return loadSelfDebug(); }
    try {
      var res = await fetch('/api/self-improvement?tab=' + encodeURIComponent(tab));
      if (!res.ok) {
        var why = '';
        try { why = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
        throw new Error('Could not load this tab (HTTP ' + res.status + (why ? ': ' + why : '') + ')');
      }
      var data = await res.json();
      var show = { overview: displayOverview, skills: displaySkills, reasoning: displayReasoning, history: displayHistory }[tab];
      target.innerHTML = show(data);
    } catch (e) {
      target.innerHTML = '<div style="color: #e3a99d;">' + esc(e.message) + '</div>';
    }
  }

  function displayOverview(d) {
    var a = d.directAnswers, r = d.drills, x = d.experiments;
    if (!a.attempts && !r.total && !x.attempts) {
      return empty('Nothing recorded yet. This fills in as you chat, as skill drills run and as improvement experiments run on this machine.');
    }
    return meter('Direct answers', pct(a.ratePercent), a.matched + ' of ' + a.attempts + ' chat messages were answered straight from a trained skill', a.ratePercent)
      + meter('Skill drills that improved', r.finished ? Math.round((r.improved / r.finished) * 100) + '%' : 'no data yet',
          r.improved + ' of ' + r.finished + ' finished drills raised held-out accuracy', r.finished ? (r.improved / r.finished) * 100 : null)
      + '<div class="metric"><h2>Counts</h2><div class="grid">'
      + stat('Drills run', r.total) + stat('Skills drilled', r.skillsDrilled)
      + stat('Experiment targets', x.targets) + stat('Experiment attempts', x.attempts)
      + stat('Sandbox failures', x.sandboxFailures) + stat('Chat messages tracked', a.attempts)
      + '</div></div>';
  }

  function displaySkills(list) {
    if (!list.length) return empty('No skill has been drilled yet.');
    return list.map(function (s) {
      var line = s.lastBefore != null && s.lastAfter != null ? 'last drill: ' + s.lastBefore + '% to ' + s.lastAfter + '%' : 'no finished drill yet';
      return meter(s.name, s.improvedDrills + ' of ' + s.drills + ' drills improved', line, s.drills ? (s.improvedDrills / s.drills) * 100 : null);
    }).join('');
  }

  function displayReasoning(d) {
    if (!d.attempts) return empty('No chat messages have been tracked yet. Each one is logged as a live test of whether a trained skill can answer it directly.');
    var html = meter('Direct-answer rate, all time', pct(d.ratePercent), d.matched + ' of ' + d.attempts + ' messages', d.ratePercent)
      + meter('Direct-answer rate, latest ' + d.recentCount, pct(d.recentRatePercent), 'the most recent messages only', d.recentRatePercent)
      + '<div class="metric"><h2>Match quality</h2><div class="grid">'
      + stat('Average similarity', d.averageSimilarity == null ? 'no data yet' : d.averageSimilarity)
      + stat('Messages tracked', d.attempts) + '</div></div>';
    if (d.topSkills.length) {
      html += '<div class="metric"><h2>Skills that answered most</h2><div class="grid">'
        + d.topSkills.map(function (s) { return stat(s.name, s.count); }).join('') + '</div></div>';
    }
    return html;
  }

  function displayHistory(events) {
    if (!events.length) return empty('No drills or experiments have run yet.');
    return events.map(function (e) {
      return '<div class="metric"><h2>' + esc(e.label) + '</h2><div class="metric-label">'
        + esc(e.kind) + ' &middot; ' + esc(new Date(e.at).toLocaleString()) + ' &middot; ' + esc(e.detail) + '</div></div>';
    }).join('');
  // ---- Self-debug. Built with DOM nodes and textContent only: what a run says can include text a person typed. ----
  function sdEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function sdWhen(ms) { return new Date(ms).toLocaleString(); }
  function sdNum(x) { return typeof x === 'number' && isFinite(x) ? x.toFixed(4) : '-'; }
  async function sdPost(path, body) {
    var res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  function sdCard(title) {
    var card = sdEl('div', 'metric');
    card.appendChild(sdEl('h2', '', title));
    return card;
  }
  function sdRun(net, button) {
    var confirmLive = false;
    if (net.kind === 'skill') {
      confirmLive = window.confirm('This net is part of the live AI. A run changes its weights. Continue?');
      if (!confirmLive) return;
    }
    button.disabled = true;
    button.textContent = 'Running...';
    sdPost('/api/self-improvement/self-debug/run', { net: net.id, confirm: confirmLive })
      .then(function () { return loadSelfDebug(); })
      .catch(function (e) { button.disabled = false; button.textContent = 'Run'; window.alert(e.message); });
  }
  async function sdShowRun(id, into) {
    into.textContent = '';
    into.appendChild(sdEl('div', 'sd-dim', 'Loading...'));
    try {
      var res = await fetch('/api/self-improvement/self-debug/sessions/' + encodeURIComponent(id));
      var s = await res.json();
      if (!res.ok) throw new Error(s.error || 'Could not load that run');
      into.textContent = '';
      s.dialogue.forEach(function (d) {
        var line = sdEl('div', 'sd-line ' + (d.speaker === 'critic' ? 'sd-critic' : 'sd-debugger'));
        line.appendChild(sdEl('span', 'sd-who', d.speaker));
        line.appendChild(document.createTextNode(d.text));
        into.appendChild(line);
      });
      if (s.observations && s.observations.length) {
        into.appendChild(sdEl('div', 'sd-dim', 'Seen, but no weight can fix these:'));
        s.observations.forEach(function (o) { into.appendChild(sdEl('div', 'sd-dim', o)); });
      }
    } catch (e) {
      into.textContent = '';
      into.appendChild(sdEl('div', 'sd-undone', e.message));
    }
  }
  async function loadSelfDebug() {
    var root = document.getElementById('selfdebug-content');
    try {
      var res = await fetch('/api/self-improvement/self-debug');
      if (!res.ok) throw new Error('Could not load self-debug (' + res.status + ')');
      var d = await res.json();
      root.textContent = '';

      var top = sdCard('Background pass');
      var topRow = sdEl('div', 'sd-row');
      topRow.appendChild(sdEl('div', 'sd-dim', d.auto ? 'On: every ten minutes it looks at the nets that are not part of the live AI.' : 'Off. Nothing runs unless you press Run.'));
      var toggle = sdEl('button', '', d.auto ? 'Turn off' : 'Turn on');
      toggle.addEventListener('click', function () {
        sdPost('/api/self-improvement/self-debug/auto', { enabled: !d.auto }).then(loadSelfDebug).catch(function (e) { window.alert(e.message); });
      });
      topRow.appendChild(toggle);
      top.appendChild(topRow);
      root.appendChild(top);

      var nets = sdCard('Nets');
      if (!d.nets.length) nets.appendChild(sdEl('div', 'sd-dim', 'No nets yet. Make one in the weight editor and it appears here.'));
      d.nets.forEach(function (n) {
        var row = sdEl('div', 'sd-row');
        var left = sdEl('div');
        left.appendChild(sdEl('div', '', n.name + (n.kind === 'skill' ? ' (live AI)' : '')));
        left.appendChild(sdEl('div', 'sd-dim', n.correct + ' of ' + n.cases + ' right, ' + n.confident + ' clearly; total error ' + sdNum(n.totalLoss)));
        row.appendChild(left);
        var run = sdEl('button', '', 'Run');
        run.disabled = d.running || n.cases === 0;
        run.addEventListener('click', function () { sdRun(n, run); });
        row.appendChild(run);
        nets.appendChild(row);
      });
      root.appendChild(nets);

      if (d.pendingPlugins.length) {
        var pend = sdCard('Plugins waiting for you');
        pend.appendChild(sdEl('div', 'sd-dim', 'Written by self-debug from skills it made. Installed off. They do nothing until you approve.'));
        d.pendingPlugins.forEach(function (p) {
          var row = sdEl('div', 'sd-row');
          var left = sdEl('div');
          left.appendChild(sdEl('div', '', p.id));
          left.appendChild(sdEl('div', 'sd-dim', p.why));
          row.appendChild(left);
          var buttons = sdEl('div');
          var yes = sdEl('button', '', 'Approve');
          var no = sdEl('button', '', 'Deny');
          yes.addEventListener('click', function () {
            sdPost('/api/self-improvement/self-debug/plugins/' + encodeURIComponent(p.id) + '/approve').then(loadSelfDebug).catch(function (e) { window.alert(e.message); });
          });
          no.addEventListener('click', function () {
            sdPost('/api/self-improvement/self-debug/plugins/' + encodeURIComponent(p.id) + '/deny').then(loadSelfDebug).catch(function (e) { window.alert(e.message); });
          });
          buttons.appendChild(yes);
          buttons.appendChild(document.createTextNode(' '));
          buttons.appendChild(no);
          row.appendChild(buttons);
          pend.appendChild(row);
        });
        root.appendChild(pend);
      }

      var runs = sdCard('Runs');
      if (!d.sessions.length) runs.appendChild(sdEl('div', 'sd-dim', 'No runs yet.'));
      d.sessions.forEach(function (s) {
        var row = sdEl('div', 'sd-row');
        var left = sdEl('div');
        left.appendChild(sdEl('div', '', s.net + ' - ' + sdWhen(s.startedAt)));
        var line = s.before.correct + '/' + s.before.cases + ' right (' + s.before.confident + ' clearly) to ' + s.after.correct + '/' + s.after.cases + ' (' + s.after.confident + ' clearly); error ' + sdNum(s.before.totalLoss) + ' to ' + sdNum(s.after.totalLoss);
        left.appendChild(sdEl('div', 'sd-dim', line));
        var detail = sdEl('div', 'sd-dim');
        detail.appendChild(sdEl('span', 'sd-kept', s.kept + ' kept'));
        detail.appendChild(document.createTextNode(', '));
        detail.appendChild(sdEl('span', 'sd-undone', s.undone + ' undone'));
        var extra = ' - stopped: ' + s.stopReason + (s.restored ? ' (restored to before)' : '') + (s.skills.length ? ' - ' + s.skills.length + ' skill(s)' : '') + (s.plugins.length ? ' - ' + s.plugins.length + ' plugin proposal(s)' : '');
        detail.appendChild(document.createTextNode(extra));
        left.appendChild(detail);
        row.appendChild(left);
        var more = sdEl('button', '', 'Read it');
        var body = sdEl('div');
        var open = false;
        more.addEventListener('click', function () {
          open = !open;
          more.textContent = open ? 'Hide' : 'Read it';
          body.textContent = '';
          if (open) sdShowRun(s.id, body);
        });
        row.appendChild(more);
        runs.appendChild(row);
        runs.appendChild(body);
      });
      root.appendChild(runs);

      var trust = sdCard('Weights the history looks at');
      if (!d.trustedWeights.length) trust.appendChild(sdEl('div', 'sd-dim', 'None yet. Each run adds to this: which weights carried a big share of what a neuron heard, and whether editing them helped.'));
      d.trustedWeights.forEach(function (w) {
        var row = sdEl('div', 'sd-row');
        row.appendChild(sdEl('div', '', w.key));
        row.appendChild(sdEl('div', 'sd-dim', 'big input ' + w.bigInput + ' of ' + w.examined + ' looks; edits ' + w.kept + ' kept, ' + w.undone + ' undone'));
        trust.appendChild(row);
      });
      root.appendChild(trust);
    } catch (e) {
      root.textContent = '';
      root.appendChild(sdEl('div', 'sd-undone', e.message));
    }
  }

  function displayHistory(data) {
    const html = \`
      <div style="color: rgba(248, 237, 233, 0.75);">
        <p>Learning history and improvement timeline coming soon.</p>
      </div>
    \`;
    document.getElementById('history-content').innerHTML = html;
  }
</script>`;
}
