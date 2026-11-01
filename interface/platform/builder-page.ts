/**
 * Extension Builder — interface for creating and editing extensions.
 * Allows users to create custom extensions with real code editing and testing.
 */

export function builderPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extension Builder</title>
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
    max-width: 64rem;
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
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  @media (min-width: 768px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .card {
    background: rgba(255, 154, 132, 0.08);
    border: 1px solid rgba(255, 154, 132, 0.2);
    border-radius: 12px;
    padding: 20px;
  }
  .card h2 {
    margin: 0 0 12px;
    font-size: 1.1rem;
    color: #ffc4b4;
  }
  .card p {
    margin: 0 0 16px;
    color: rgba(248, 237, 233, 0.75);
    font-size: 0.95rem;
  }
  .form-group {
    margin-bottom: 16px;
  }
  label {
    display: block;
    margin-bottom: 8px;
    color: #ffc4b4;
    font-size: 0.95rem;
  }
  input, textarea {
    width: 100%;
    padding: 10px 12px;
    background: rgba(248, 237, 233, 0.05);
    border: 1px solid rgba(255, 154, 132, 0.3);
    color: #f8ede9;
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.95rem;
  }
  textarea {
    resize: vertical;
    min-height: 200px;
    font-family: 'Courier New', monospace;
  }
  button {
    background: rgba(255, 154, 132, 0.16);
    border: 1px solid rgba(255, 154, 132, 0.5);
    color: #ffc4b4;
    padding: 10px 20px;
    border-radius: 999px;
    font-family: inherit;
    cursor: pointer;
    font-size: 0.95rem;
    display: inline-block;
    margin-right: 8px;
  }
  button:hover {
    background: rgba(255, 154, 132, 0.24);
  }
  .info {
    background: rgba(255, 154, 132, 0.04);
    border-left: 3px solid #ff9a84;
    padding: 16px;
    border-radius: 4px;
    margin-bottom: 24px;
  }
  .info p {
    margin: 0;
    color: rgba(248, 237, 233, 0.75);
    font-size: 0.95rem;
  }
</style>

<main>
  <h1>Extension Builder</h1>

  <div class="tabs">
    <button class="tab-button active" data-tab="create">Create</button>
    <button class="tab-button" data-tab="my-extensions">My Extensions</button>
    <button class="tab-button" data-tab="templates">Templates</button>
  </div>

  <div id="create" class="tab-content active">
    <div class="info">
      <p><strong>Build an extension</strong> from NeuroLang: neurons, values and definitions that join the network. Built extensions are saved in extension-builder/extensions.</p>
    </div>
    <div class="card">
      <h2>New Extension</h2>
      <div class="form-group">
        <label>Extension Name</label>
        <input type="text" id="extName" placeholder="my-awesome-extension">
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="extDesc" placeholder="What does your extension do?">
      </div>
      <div class="form-group">
        <label>NeuroLang code (see the Templates tab)</label>
        <textarea id="extCode" placeholder="name=&quot;greeter&quot;"></textarea>
      </div>
      <div class="form-group"><label><input type="checkbox" id="extQuantize"> Quantize to 8 bits when saving</label></div>
      <button onclick="saveExtension()">Build Extension</button>
      <p id="build-result" role="status"></p>
    </div>
  </div>

  <div id="my-extensions" class="tab-content">
    <div id="extensions-list"></div>
  </div>

  <div id="templates" class="tab-content">
    <div class="grid">
      <div class="card">
        <h2>Skill Plugin</h2>
        <p>Extend the engine's skill library with new capabilities.</p>
        <button onclick="useTemplate('skill')">Use Template</button>
      </div>
      <div class="card">
        <h2>Tool Integration</h2>
        <p>Integrate external tools and APIs.</p>
        <button onclick="useTemplate('tool')">Use Template</button>
      </div>
      <div class="card">
        <h2>Data Processor</h2>
        <p>Process and transform data streams.</p>
        <button onclick="useTemplate('processor')">Use Template</button>
      </div>
      <div class="card">
        <h2>UI Component</h2>
        <p>Add custom interface elements.</p>
        <button onclick="useTemplate('ui')">Use Template</button>
      </div>
    </div>
  </div>
</main>

<script>
  function h(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }

  document.querySelectorAll('.tab-button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tab-button').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      b.classList.add('active');
      document.getElementById(b.dataset.tab).classList.add('active');
      if (b.dataset.tab === 'my-extensions') loadMyExtensions();
    });
  });

  function setResult(text, isError) {
    var box = document.getElementById('build-result');
    box.textContent = text;
    box.style.color = isError ? '#ff9a84' : '';
  }

  async function saveExtension() {
    var name = document.getElementById('extName').value.trim();
    var description = document.getElementById('extDesc').value.trim();
    var code = document.getElementById('extCode').value;
    var quantize = document.getElementById('extQuantize').checked;
    if (!name || !code.trim()) { setResult('Name and NeuroLang code are both required.', true); return; }
    setResult('Building...');
    try {
      var res = await fetch('/api/extension/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: description, code: code, quantize: quantize })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var errs = Array.isArray(data.errors) ? data.errors.map(function (e) { return typeof e === 'string' ? e : JSON.stringify(e); }) : [];
        setResult('Build failed: ' + (errs.length ? errs.join('; ') : (data.error || 'HTTP ' + res.status)), true);
        return;
      }
      var neurons = (data.neurons || []).map(function (n) { return n.name; }).join(', ') || 'none';
      setResult('Built "' + data.name + '": ' + data.stats.neuronCount + ' neuron(s) (' + neurons + '), saved as ' + data.savedAs + '.', false);
    } catch (e) {
      setResult('Error: ' + e.message, true);
    }
  }

  async function loadMyExtensions() {
    var list = document.getElementById('extensions-list');
    list.replaceChildren(h('div', 'Loading...'));
    try {
      var res = await fetch('/api/extension/list');
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      var exts = data.extensions || [];
      if (!exts.length) { list.replaceChildren(h('div', 'No extensions yet. Build one in the Create tab.')); return; }
      list.replaceChildren.apply(list, exts.map(function (ext) {
        var card = h('div', null, 'card');
        card.appendChild(h('h2', ext.name));
        card.appendChild(h('p', ext.neurons + ' neuron(s)' + (ext.quantized ? ', quantized to ' + ext.bits + ' bits' : '') + ' - ' + ext.file));
        return card;
      }));
    } catch (e) {
      var err = h('div', 'Could not load extensions: ' + e.message);
      err.style.color = '#ff9a84';
      list.replaceChildren(err);
    }
  }

  function useTemplate(type) {
    var templates = {
      skill: 'name="greeter"\\n"greeter"@value="3"\\n"greeter"@definition="Hello! How can I help?"',
      tool: 'name="lookup"\\n"lookup"@value="5"\\n"lookup"@definition="Looking that up for you."\\nname="answer"\\n"answer"@connections=".lookup*0.8"',
      processor: 'name="input_layer"\\n"input_layer"@value="10"\\nname="hidden_layer"\\n"hidden_layer"@connections=".input_layer*0.5"\\nname="output_layer"\\n"output_layer"@connections=".hidden_layer*0.5"',
      ui: 'name="button_label"\\n"button_label"@value="2"\\n"button_label"@definition="Click me"'
    };
    document.getElementById('extCode').value = templates[type] || '';
    document.querySelector('[data-tab="create"]') && document.querySelector('[data-tab="create"]').click();
  }
</script>`;
}
