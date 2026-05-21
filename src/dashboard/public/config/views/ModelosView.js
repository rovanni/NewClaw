import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';
import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';

const ROUTE_MAP = {
  modelChat: 'chat', modelCode: 'code', modelVision: 'vision',
  modelLight: 'light', modelAnalysis: 'analysis', modelExecution: 'execution',
  classifierModel: 'classifierModel',
};

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🤖 ${t('sidebar_models')}</h1>
        <p>${t('models_page_desc')}</p>
      </div>

      <!-- Pipeline visual -->
      <div class="pipeline-wrap">
        <div class="pipeline-title">${t('pipeline_title')}</div>
        <div class="pipeline">
          <div class="pipe-node">
            <div class="pipe-box">
              <div class="pipe-icon">📩</div>
              <div class="pipe-label">${t('pipe_input')}</div>
              <div class="pipe-value">${t('pipe_message')}</div>
            </div>
          </div>
          <div class="pipe-arrow">→</div>
          <div class="pipe-node" style="min-width:130px;">
            <div class="pipe-box accent">
              <div class="pipe-icon">🔎</div>
              <div class="pipe-label">${t('pipe_classifier')}</div>
              <div class="pipe-value" id="ml-pipeClassifier">—</div>
            </div>
          </div>
          <div class="pipe-arrow">→</div>
          <div class="pipe-node">
            <div class="pipe-box">
              <div class="pipe-icon">📂</div>
              <div class="pipe-label">${t('pipe_category')}</div>
              <div class="pipe-value">${t('pipe_detected')}</div>
            </div>
          </div>
          <div class="pipe-arrow">→</div>
          <div class="pipe-expand">
            <div class="pipe-route"><span class="pipe-route-icon">💬</span><span class="pipe-route-cat">chat</span><span class="pipe-route-model" id="ml-pr-chat">—</span></div>
            <div class="pipe-route"><span class="pipe-route-icon">💻</span><span class="pipe-route-cat">${t('route_code_cat')}</span><span class="pipe-route-model" id="ml-pr-code">—</span></div>
            <div class="pipe-route"><span class="pipe-route-icon">👁️</span><span class="pipe-route-cat">${t('route_vision_cat')}</span><span class="pipe-route-model" id="ml-pr-vision">—</span></div>
            <div class="pipe-route"><span class="pipe-route-icon">⚡</span><span class="pipe-route-cat">${t('route_light_cat')}</span><span class="pipe-route-model" id="ml-pr-light">—</span></div>
            <div class="pipe-route"><span class="pipe-route-icon">📊</span><span class="pipe-route-cat">${t('route_analysis_cat')}</span><span class="pipe-route-model" id="ml-pr-analysis">—</span></div>
            <div class="pipe-route"><span class="pipe-route-icon">🧠</span><span class="pipe-route-cat">${t('route_execution_cat')}</span><span class="pipe-route-model" id="ml-pr-execution">—</span></div>
          </div>
        </div>
      </div>

      <!-- Route cards -->
      <details class="cfg-details" open>
        <summary>${t('edit_routes_title')}</summary>
        <div class="cfg-details-body">
          <div class="route-grid">
            ${routeCard('modelChat',     '💬', 'Chat',                      t('route_chat_desc'),     'glm-5.1:cloud')}
            ${routeCard('modelCode',     '💻', t('route_code_cat'),         t('route_code_desc'),     'gemma4:e4b')}
            ${routeCard('modelVision',   '👁️', t('route_vision_cat'),      t('route_vision_desc'),   'gemma4:e4b')}
            ${routeCard('modelLight',    '⚡', t('route_light_cat'),        t('route_light_desc'),    'gemma4:e4b')}
            ${routeCard('modelAnalysis', '📊', t('route_analysis_cat'),     t('route_analysis_desc'), 'glm-5:cloud')}
            ${routeCard('modelExecution','🧠', t('route_execution_cat'),    t('route_execution_desc'),'kimi-k2.6:cloud')}
          </div>
        </div>
      </details>

      <!-- Provider + Classifier -->
      <details class="cfg-details">
        <summary>${t('provider_classifier_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-group">
            <label class="form-label">${t('default_provider_label')}</label>
            <select class="form-select" id="ml-defaultProvider" style="max-width:280px;">
              <option value="ollama">Ollama (Local + Cloud)</option>
              <option value="gemini">Google Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq</option>
            </select>
          </div>
          <div id="ml-ollamaSection">
            <div class="form-group">
              <label class="form-label">${t('main_ollama_model_label')} <span class="badge badge-cloud">cloud</span></label>
              <div class="model-select-container" id="container-ollamaModel">
                <input type="text" class="model-select-input" autocomplete="off" id="ollamaModel" placeholder="glm-5.1:cloud">
                <svg class="msa" width="11" height="11" fill="#98a8c2" viewBox="0 0 16 16"><path d="M8 11L3 6h10z"/></svg>
                <div class="model-dropdown" id="dropdown-ollamaModel"></div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">${t('download_models_label')}</label>
              <div class="chips" style="margin-bottom:8px;">
                <div class="chip" data-pull="qwen2.5:7b">qwen2.5:7b</div>
                <div class="chip" data-pull="llama3.1:8b">llama3.1:8b</div>
                <div class="chip" data-pull="gemma4:31b-cloud">gemma4:31b-cloud</div>
                <div class="chip" data-pull="mistral:7b">mistral:7b</div>
                <div class="chip" data-pull="deepseek-coder-v2:16b">deepseek-coder-v2:16b</div>
              </div>
              <div style="display:flex;gap:8px;">
                <input type="text" id="ml-customPull" placeholder="modelo:tag"
                  style="flex:1;max-width:180px;padding:7px 10px;font-size:.77rem;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-main);outline:none;">
                <button class="btn btn-primary btn-sm" id="ml-pullBtn">⬇️ Pull</button>
              </div>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t('classifier_model_label')}</label>
              <div class="model-select-container" id="container-classifierModel">
                <input type="text" class="model-select-input" autocomplete="off" id="classifierModel" placeholder="gemma4:31b-cloud">
                <svg class="msa" width="11" height="11" fill="#98a8c2" viewBox="0 0 16 16"><path d="M8 11L3 6h10z"/></svg>
                <div class="model-dropdown" id="dropdown-classifierModel"></div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">${t('classifier_server_label')}</label>
              <input type="text" class="form-input" id="ml-classifierServer" placeholder="http://localhost:11434">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">${t('vision_server_label')}</label>
            <input type="text" class="form-input" id="ml-visionServer" placeholder="http://localhost:11434" style="max-width:320px;">
          </div>
        </div>
      </details>
    </div>`;

  const cs = configStore;
  const s  = cs.snap();
  const r  = s.modelRouter || {};
  const el = id => document.getElementById(id);

  // Populate inputs from configStore
  el('ml-defaultProvider').value  = s.defaultProvider || 'ollama';
  el('ollamaModel').value         = s.ollamaModel || '';
  el('modelChat').value           = r.chat      || '';
  el('modelCode').value           = r.code      || '';
  el('modelVision').value         = r.vision    || '';
  el('modelLight').value          = r.light     || '';
  el('modelAnalysis').value       = r.analysis  || '';
  el('modelExecution').value      = r.execution || '';
  el('classifierModel').value     = r.classifierModel  || '';
  el('ml-classifierServer').value = r.classifierServer || '';
  el('ml-visionServer').value     = r.visionServer     || '';

  toggleOllamaSection(s.defaultProvider);
  updatePipeline(r);

  // Bind provider select
  el('ml-defaultProvider').addEventListener('change', e => {
    cs.set('defaultProvider', e.target.value);
    toggleOllamaSection(e.target.value);
  });

  // Bind ollamaModel
  el('ollamaModel').addEventListener('input', e => cs.set('ollamaModel', e.target.value));

  // Bind route inputs to configStore.modelRouter
  Object.keys(ROUTE_MAP).forEach(inputId => {
    const inputEl = el(inputId);
    if (!inputEl) return;
    inputEl.addEventListener('input', e => {
      const mr = { ...cs.get('modelRouter') };
      mr[ROUTE_MAP[inputId]] = e.target.value;
      cs.set('modelRouter', mr);
    });
  });

  // Bind classifier server / vision server
  el('ml-classifierServer').addEventListener('input', e => {
    const mr = { ...cs.get('modelRouter') };
    mr.classifierServer = e.target.value;
    cs.set('modelRouter', mr);
  });
  el('ml-visionServer').addEventListener('input', e => {
    const mr = { ...cs.get('modelRouter') };
    mr.visionServer = e.target.value;
    cs.set('modelRouter', mr);
  });

  // Pull chips
  container.querySelectorAll('.chip[data-pull]').forEach(chip => {
    chip.addEventListener('click', () => doPull(chip.dataset.pull));
  });
  el('ml-pullBtn').addEventListener('click', () => {
    const name = el('ml-customPull').value.trim();
    if (name) doPull(name);
  });

  // Init model dropdowns
  const ddIds = ['ollamaModel','modelChat','modelCode','modelVision','modelLight','modelAnalysis','modelExecution','classifierModel'];
  updateDropdownModels(providersStore.get('models') || []);
  initDropdowns(ddIds);

  // Subscribe to providersStore for model list
  const unsubModels = providersStore.on('models', models => updateDropdownModels(models));

  // Subscribe to configStore for pipeline updates
  const unsubRouter = cs.on('modelRouter', mr => updatePipeline(mr));

  return () => { unsubModels(); unsubRouter(); };
}

function routeCard(id, icon, label, sub, placeholder) {
  return `
    <div class="route-card">
      <div class="route-card-header">
        <span class="route-card-icon">${icon}</span>
        <div><div class="route-card-label">${label}</div><div class="route-card-sub">${sub}</div></div>
      </div>
      <div class="model-select-container" id="container-${id}">
        <input type="text" class="model-select-input" autocomplete="off" id="${id}" placeholder="${placeholder}">
        <svg class="msa" width="11" height="11" fill="#98a8c2" viewBox="0 0 16 16"><path d="M8 11L3 6h10z"/></svg>
        <div class="model-dropdown" id="dropdown-${id}"></div>
      </div>
    </div>`;
}

function toggleOllamaSection(provider) {
  const s = document.getElementById('ml-ollamaSection');
  if (s) s.style.display = provider === 'ollama' ? 'block' : 'none';
}

function updatePipeline(r) {
  const short = m => m ? (m.length > 16 ? m.slice(0, 14) + '…' : m) : '—';
  const el    = id => document.getElementById(id);
  const s = r || {};
  el('ml-pipeClassifier') && (el('ml-pipeClassifier').textContent = short(s.classifierModel));
  el('ml-pr-chat')        && (el('ml-pr-chat').textContent        = short(s.chat));
  el('ml-pr-code')        && (el('ml-pr-code').textContent        = short(s.code));
  el('ml-pr-vision')      && (el('ml-pr-vision').textContent      = short(s.vision));
  el('ml-pr-light')       && (el('ml-pr-light').textContent       = short(s.light));
  el('ml-pr-analysis')    && (el('ml-pr-analysis').textContent    = short(s.analysis));
  el('ml-pr-execution')   && (el('ml-pr-execution').textContent   = short(s.execution));
}

async function doPull(name) {
  if (!name?.trim()) return;
  name = name.trim();
  showToast('⬇️ Baixando "' + name + '"...', 'success');
  const f = window.newclawFetch || fetch;
  try {
    const res  = await f('/api/ollama/pull', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:name }) });
    const data = await res.json();
    if (data.success) {
      showToast('✅ "' + name + '" pronto!', 'success');
      const inp = document.getElementById('ollamaModel');
      if (inp) inp.value = name;
      configStore.set('ollamaModel', name);
    } else {
      showToast('❌ ' + (data.error || 'desconhecido'), 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}
