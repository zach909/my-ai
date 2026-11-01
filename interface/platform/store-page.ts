/**
 * The Store — catalogue of published skills, plugins, and shared content.
 * Fetches from backend APIs and displays: Store (skills/plugins), Wiki, Uploads, Community Chat.
 */

export function storePage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store</title>
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
    color: #ffc4b4;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    border-bottom: 1px solid rgba(255, 154, 132, 0.2);
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
    color: #ffc4b4;
    border-bottom-color: #ff9a84;
  }
  .tab-content {
    display: none;
  }
  .tab-content.active {
    display: block;
  }
  .card {
    background: rgba(255, 154, 132, 0.08);
    border: 1px solid rgba(255, 154, 132, 0.2);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h3 {
    margin: 0 0 8px;
    color: #ffc4b4;
  }
  .card p {
    margin: 0 0 12px;
    color: rgba(248, 237, 233, 0.75);
    font-size: 0.9rem;
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
  button {
    background: rgba(255, 154, 132, 0.16);
    border: 1px solid rgba(255, 154, 132, 0.5);
    color: #ffc4b4;
    padding: 8px 16px;
    border-radius: 999px;
    font-family: inherit;
    cursor: pointer;
    font-size: 0.9rem;
  }
  button:hover {
    background: rgba(255, 154, 132, 0.24);
  }
  .loading, .error {
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 16px;
  }
  .loading {
    background: rgba(255, 154, 132, 0.1);
    color: rgba(248, 237, 233, 0.75);
  }
  .error {
    background: rgba(255, 100, 100, 0.1);
    color: #ff9a84;
  }
</style>

<main>
  <h1>Store</h1>

  <div class="tabs">
    <button class="tab-button active" data-tab="store">Store</button>
    <button class="tab-button" data-tab="wiki">Wiki</button>
    <button class="tab-button" data-tab="uploads">Uploads</button>
    <button class="tab-button" data-tab="chat">Chat</button>
  </div>

  <div id="store" class="tab-content active">
    <div id="store-content"></div>
  </div>

  <div id="wiki" class="tab-content">
    <div id="wiki-content"></div>
  </div>

  <div id="uploads" class="tab-content">
    <div id="uploads-content"></div>
  </div>

  <div id="chat" class="tab-content">
    <div id="chat-content"></div>
  </div>
</main>

<script>
  function h(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function btn(label, fn) {
    var b = h('button', label);
    b.addEventListener('click', fn);
    return b;
  }
  function show(id, nodes) {
    var box = document.getElementById(id);
    box.replaceChildren.apply(box, nodes);
  }
  function note(text, cls) { return h('div', text, 'card ' + (cls || '')); }
  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  document.querySelectorAll('.tab-button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tab-button').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      b.classList.add('active');
      document.getElementById(b.dataset.tab).classList.add('active');
      loadTabContent(b.dataset.tab);
    });
  });

  loadTabContent('store');

  async function loadTabContent(tab) {
    var target = tab + '-content';
    show(target, [note('Loading...', 'loading')]);
    try {
      if (tab === 'store') displayStore(await api('/api/store'));
      else if (tab === 'wiki') displayWiki(await api('/api/wiki'));
      else if (tab === 'uploads') displayInstalled(await api('/api/store/installed'));
      else if (tab === 'chat') show(target, [note('The shared community chat is not built yet.')]);
    } catch (e) {
      show(target, [note('Could not load: ' + e.message, 'error')]);
    }
  }

  function displayStore(data) {
    var nodes = [];
    (data.kinds || []).forEach(function (kind) {
      var items = (data.catalog && data.catalog[kind]) || [];
      if (!items.length) return;
      nodes.push(h('h2', (data.labels && data.labels[kind]) || kind));
      items.forEach(function (item) {
        var card = h('div', null, 'card');
        card.appendChild(h('h3', item.title || item.name));
        card.appendChild(h('p', item.description || 'No description'));
        var meta = h('p', 'By ' + (item.author || 'unknown') + (item.updatedAt ? ' - updated ' + item.updatedAt.slice(0, 10) : ''));
        meta.style.opacity = '0.65';
        card.appendChild(meta);
        var status = h('p', '');
        card.appendChild(btn('Install', function () {
          status.textContent = 'Installing...';
          post('/api/store/install', { kind: kind, name: item.name })
            .then(function () { status.textContent = 'Installed. See the Uploads tab.'; })
            .catch(function (e) { status.textContent = 'Could not install: ' + e.message; });
        }));
        card.appendChild(status);
        nodes.push(card);
      });
    });
    show('store-content', nodes.length ? nodes : [note('The store has no published items yet.')]);
  }

  function displayWiki(data) {
    var pages = (data && data.pages) || [];
    var nodes = pages.map(function (page) {
      var card = h('div', null, 'card');
      card.appendChild(h('h3', page.title || page.name));
      card.appendChild(h('p', page.description || ''));
      var body = h('pre', '');
      body.style.whiteSpace = 'pre-wrap';
      body.hidden = true;
      var open = btn('Read', function () {
        if (!body.hidden) { body.hidden = true; open.textContent = 'Read'; return; }
        body.textContent = 'Loading...';
        body.hidden = false;
        api('/api/wiki/' + page.name.split('/').map(encodeURIComponent).join('/'))
          .then(function (p) { body.textContent = p.content || '(empty page)'; open.textContent = 'Hide'; })
          .catch(function (e) { body.textContent = 'Could not load: ' + e.message; });
      });
      card.appendChild(open);
      card.appendChild(body);
      return card;
    });
    show('wiki-content', nodes.length ? nodes : [note('No wiki pages yet.')]);
  }

  function displayInstalled(data) {
    var installed = (data && data.installed) || [];
    var outdated = (data && data.outdated) || [];
    var nodes = installed.map(function (item) {
      var card = h('div', null, 'card');
      card.appendChild(h('h3', item.title || item.name));
      card.appendChild(h('p', 'Type: ' + item.kind));
      var isOld = outdated.some(function (o) { return o.kind === item.kind && o.name === item.name; });
      if (isOld) card.appendChild(h('p', 'A newer version is published.'));
      var status = h('p', '');
      card.appendChild(btn('Uninstall', function () {
        post('/api/store/uninstall', { kind: item.kind, name: item.name })
          .then(function () { loadTabContent('uploads'); })
          .catch(function (e) { status.textContent = 'Could not uninstall: ' + e.message; });
      }));
      card.appendChild(status);
      return card;
    });
    show('uploads-content', nodes.length ? nodes : [note('Nothing installed yet.')]);
  }
</script>`;
}
