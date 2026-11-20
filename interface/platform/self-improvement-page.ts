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
</style>

<main>
  <h1>Self-improvement</h1>

  <div class="tabs">
    <button class="tab-button active" data-tab="overview">Overview</button>
    <button class="tab-button" data-tab="skills">Skills</button>
    <button class="tab-button" data-tab="reasoning">Reasoning</button>
    <button class="tab-button" data-tab="history">History</button>
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
  }
</script>`;
}
