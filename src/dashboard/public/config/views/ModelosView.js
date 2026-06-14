import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';
import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';

const ROUTE_MAP = {
  modelChat: 'chat', modelCode: 'code', modelVision: 'vision',
  modelLight: 'light', modelAnalysis: 'analysis', modelExecution: 'execution',
  classifierModel: 'classifierModel',
};

const PROV_LABELS = {
  ollama: 'Ollama (Local + Cloud)', gemini: 'Google Gemini',
  openrouter: 'OpenRouter', deepseek: 'DeepSeek', groq: 'Groq',
};

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🤖 ${t('sidebar_models')}</h1>
        <p>${t('models_page_desc')}</p>
      </div>

      <!-- Configuração Efetiva -->
      <div class="cfg-efetiva">
        <div class="cfg-efetiva-title">📌 ${t('effective_config_title')}</div>
        <div class="cfg-efetiva-body">
          <div class="cfg-efetiva-routes">
            ${effRouteRow('chat',      '💬', 'Chat')}
            ${effRouteRow('code',      '💻', t('route_code_cat'))}
            ${effRouteRow('vision',    '👁️', t('route_vision_cat'))}
            ${effRouteRow('light',     '⚡', t('route_light_cat'))}
            ${effRouteRow('analysis',  '📊', t('route_analysis_cat'))}
            ${effRouteRow('execution', '🧠', t('route_execution_cat'))}
          </div>
          <div class="cfg-efetiva-meta">
            <div class="cfg-efetiva-meta-row">
              <span class="cfg-efetiva-meta-label">${t('provider_active_label')}</span>
              <span class="cfg-efetiva-meta-value" id="ml-eff-provider">—</span>
            </div>
            <div class="cfg-efetiva-meta-row">
              <span class="cfg-efetiva-meta-label">${t('classifier_model_label')}</span>
              <span class="cfg-efetiva-meta-value" id="ml-eff-classifier">—</span>
            </div>
          </div>
        </div>
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
            ${pipeRoute('chat',      '💬', 'chat')}
            ${pipeRoute('code',      '💻', t('route_code_cat'))}
            ${pipeRoute('vision',    '👁️', t('route_vision_cat'))}
            ${pipeRoute('light',     '⚡', t('route_light_cat'))}
            ${pipeRoute('analysis',  '📊', t('route_analysis_cat'))}
            ${pipeRoute('execution', '🧠', t('route_execution_cat'))}
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
              <option value="openrouter">🔀 OpenRouter</option>
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

      <!-- Provider por perfil -->
      <details class="cfg-details">
        <summary>${t('provider_per_profile_title')}</summary>
        <div class="cfg-details-body">
          <div class="form-hint" style="margin-bottom:12px;">${t('provider_per_profile_hint')}</div>
          <div class="route-grid">
            ${providerCard('chat',      '💬', 'Chat')}
            ${providerCard('code',      '💻', t('route_code_cat'))}
            ${providerCard('vision',    '👁️', t('route_vision_cat'))}
            ${providerCard('light',     '⚡', t('route_light_cat'))}
            ${providerCard('analysis',  '📊', t('route_analysis_cat'))}
            ${providerCard('execution', '🧠', t('route_execution_cat'))}
          </div>
        </div>
      </details>

      <!-- Modelos dos componentes internos -->
      <details class="cfg-details" id="ml-internalDetails">
        <summary>
          ${t('internal_models_title')}
          <span id="ml-internalBadge" style="display:none;margin-left:8px;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;background:rgba(255,160,0,.15);color:#f59e0b;border:1px solid rgba(255,160,0,.3);">⚠️ ${t('internal_unconfigured_badge')}</span>
        </summary>
        <div class="cfg-details-body">
          <div id="ml-internalWarning" style="display:none;margin-bottom:14px;padding:10px 14px;border-radius:8px;background:rgba(255,160,0,.08);border:1px solid rgba(255,160,0,.3);font-size:.82rem;line-height:1.5;color:var(--text-main);">
            ⚠️ <strong>Um ou mais modelos internos estão vazios.</strong> O sistema usará defaults, mas pode falhar se o provider ativo não os tiver disponíveis.<br>
            Preencha os campos abaixo e clique <strong>Salvar &amp; Reiniciar</strong>.
          </div>
          <div class="form-hint" style="margin-bottom:14px;">${t('internal_models_hint')}</div>
          <div class="internal-comp-grid">
            ${internalCompCard('ml-plannerModel',  '📋', 'GoalPlanner',       t('internal_planner_desc'),  'gemma4:31b-cloud')}
            ${internalCompCard('ml-riskModel',     '🛡️', 'RiskAnalyzer',      t('internal_risk_desc'),     'gemma4:31b-cloud')}
            ${internalCompCard('ml-observerModel', '🔬', 'ObserverValidator', t('internal_observer_desc'), 'qwen3.5:cloud')}
          </div>
        </div>
      </details>

      <!-- Diagnóstico de Roteamento -->
      <details class="cfg-details" id="ml-diagDetails">
        <summary>🔍 ${t('routing_diag_title')}</summary>
        <div class="cfg-details-body">
          <div id="ml-diagContent">
            <div class="routing-diag-empty">
              <span>📡</span>
              <span>${t('routing_diag_waiting')}</span>
            </div>
          </div>
        </div>
      </details>
    </div>`;

  const cs = configStore;
  const s  = cs.snap();
  const r  = s.modelRouter || {};
  const el = id => document.getElementById(id);

  // Populate inputs
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
  el('ml-plannerModel').value     = r.plannerModel  || '';
  el('ml-riskModel').value        = r.riskModel     || '';
  el('ml-observerModel').value    = r.observerModel || '';

  toggleOllamaSection(s.defaultProvider);
  updatePipeline(r);
  updateEffectiveConfig(r, s.defaultProvider);
  updateProviderHints(s.defaultProvider);
  updateModelStatus(providersStore.get('models') || [], r);
  checkInternalModels();

  // Provider select
  el('ml-defaultProvider').addEventListener('change', e => {
    const prov = e.target.value;
    cs.set('defaultProvider', prov);
    toggleOllamaSection(prov);
    updateProviderHints(prov);
    updateEffectiveConfig(cs.get('modelRouter') || {}, prov);
  });

  // Ollama main model
  el('ollamaModel').addEventListener('input', e => cs.set('ollamaModel', e.target.value));

  // Route inputs
  Object.keys(ROUTE_MAP).forEach(inputId => {
    const inputEl = el(inputId);
    if (!inputEl) return;
    inputEl.addEventListener('input', e => {
      const mr = { ...cs.get('modelRouter') };
      mr[ROUTE_MAP[inputId]] = e.target.value;
      cs.set('modelRouter', mr);
    });
  });

  // Classifier server / vision server
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

  // Per-profile provider selects
  ['chat','code','vision','light','analysis','execution'].forEach(cat => {
    const sel = el(`ml-prov-${cat}`);
    if (!sel) return;
    sel.value = r[`provider_${cat}`] || '';
    sel.addEventListener('change', e => {
      const mr = { ...cs.get('modelRouter') };
      mr[`provider_${cat}`] = e.target.value || undefined;
      cs.set('modelRouter', mr);
      updateProviderHints(cs.get('defaultProvider'));
    });
  });

  // Internal component models
  ['plannerModel','riskModel','observerModel'].forEach(key => {
    el(`ml-${key}`).addEventListener('input', e => {
      const mr = { ...cs.get('modelRouter') };
      mr[key] = e.target.value;
      cs.set('modelRouter', mr);
      checkInternalModels();
    });
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

  // Subscribe to providersStore
  const unsubModels = providersStore.on('models', models => {
    updateDropdownModels(models);
    updateModelStatus(models, cs.get('modelRouter') || {});
  });

  // Subscribe to configStore router
  const unsubRouter = cs.on('modelRouter', mr => {
    updatePipeline(mr);
    updateEffectiveConfig(mr, cs.get('defaultProvider'));
    updateModelStatus(providersStore.get('models') || [], mr);
  });

  // Routing diagnostics
  if (window._newclawLastRoutingDecision) {
    updateRoutingDiag(window._newclawLastRoutingDecision);
  }
  const diagHandler = e => updateRoutingDiag(e.detail);
  window.addEventListener('newclaw-routing-decision', diagHandler);

  return () => {
    unsubModels();
    unsubRouter();
    window.removeEventListener('newclaw-routing-decision', diagHandler);
  };

  function checkInternalModels() {
    const mr = cs.get('modelRouter') || {};
    const trim = v => (v || '').trim();
    const unconfigured = !trim(mr.plannerModel) || !trim(mr.riskModel) || !trim(mr.observerModel);
    const badge   = el('ml-internalBadge');
    const warning = el('ml-internalWarning');
    const details = el('ml-internalDetails');
    if (badge)   badge.style.display   = unconfigured ? 'inline' : 'none';
    if (warning) warning.style.display = unconfigured ? 'block'  : 'none';
    if (details && unconfigured) details.open = true;
  }
}

// ─── HTML helpers ─────────────────────────────────────────────

function effRouteRow(cat, icon, label) {
  return `
    <div class="cfg-efetiva-row">
      <span class="cfg-efetiva-row-icon">${icon}</span>
      <span class="cfg-efetiva-row-label">${label}</span>
      <span class="cfg-efetiva-row-arrow">→</span>
      <span class="cfg-efetiva-row-model" id="ml-eff-${cat}">—</span>
    </div>`;
}

function pipeRoute(cat, icon, label) {
  return `
    <div class="pipe-route">
      <span class="pipe-route-icon">${icon}</span>
      <span class="pipe-route-cat">${label}</span>
      <span class="pipe-route-model" id="ml-pr-${cat}">—</span>
      <span class="dot" id="ml-status-${cat}" title=""></span>
    </div>`;
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

function providerCard(cat, icon, label) {
  return `
    <div class="route-card">
      <div class="route-card-header">
        <span class="route-card-icon">${icon}</span>
        <div class="route-card-label">${label}</div>
      </div>
      <select class="form-select" id="ml-prov-${cat}" style="font-size:.78rem;">
        <option value="">— ${t('prov_inherit_default')} —</option>
        <option value="ollama">Ollama</option>
        <option value="openrouter">OpenRouter</option>
        <option value="gemini">Gemini</option>
        <option value="deepseek">DeepSeek</option>
        <option value="groq">Groq</option>
      </select>
      <div class="prov-hint" id="ml-prov-hint-${cat}"></div>
    </div>`;
}

function internalCompCard(id, icon, name, desc, placeholder) {
  return `
    <div class="internal-comp-card">
      <div class="internal-comp-header">
        <span class="internal-comp-icon">${icon}</span>
        <div>
          <div class="internal-comp-name">${name}</div>
          <div class="internal-comp-desc">${desc}</div>
        </div>
      </div>
      <input type="text" class="form-input" id="${id}" placeholder="${placeholder}" style="font-size:.8rem;">
    </div>`;
}

// ─── Reactive update functions ────────────────────────────────

function updateEffectiveConfig(r, defaultProvider) {
  const s = v => v || '—';
  ['chat','code','vision','light','analysis','execution'].forEach(cat => {
    const e = document.getElementById(`ml-eff-${cat}`);
    if (e) e.textContent = s(r[cat]);
  });
  const provEl = document.getElementById('ml-eff-provider');
  if (provEl) provEl.textContent = PROV_LABELS[defaultProvider] || defaultProvider || '—';
  const clsEl = document.getElementById('ml-eff-classifier');
  if (clsEl) clsEl.textContent = s(r.classifierModel);
}

function updateModelStatus(models, r) {
  const available = new Set(models || []);
  const isCloud = m => m && (m.endsWith(':cloud') || m.includes('-cloud'));
  ['chat','code','vision','light','analysis','execution'].forEach(cat => {
    const statusEl = document.getElementById(`ml-status-${cat}`);
    if (!statusEl) return;
    const model = r ? r[cat] : '';
    if (!model) {
      statusEl.className = 'dot';
      statusEl.title = '';
    } else if (isCloud(model)) {
      statusEl.className = 'dot dot-cloud';
      statusEl.title = 'Cloud';
    } else if (available.has(model)) {
      statusEl.className = 'dot online';
      statusEl.title = 'Disponível (local)';
    } else {
      statusEl.className = 'dot dot-missing';
      statusEl.title = 'Não instalado localmente';
    }
  });
}

function updateProviderHints(defaultProvider) {
  const provName = PROV_LABELS[defaultProvider] || defaultProvider || '—';
  ['chat','code','vision','light','analysis','execution'].forEach(cat => {
    const hint = document.getElementById(`ml-prov-hint-${cat}`);
    const sel  = document.getElementById(`ml-prov-${cat}`);
    if (!hint || !sel) return;
    const val = sel.value;
    if (!val) {
      hint.textContent = `↑ ${t('prov_inheriting')}: ${provName}`;
      hint.className = 'prov-hint prov-hint-inherit';
    } else {
      hint.textContent = `↑ ${t('prov_overriding')}: ${PROV_LABELS[val] || val}`;
      hint.className = 'prov-hint prov-hint-override';
    }
  });
}

function updateRoutingDiag(decision) {
  const el = document.getElementById('ml-diagContent');
  if (!el || !decision) return;
  const esc = s => String(s || '—').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML = `
    <div class="routing-diag-grid">
      <div class="routing-diag-row"><span class="rd-label">${t('rd_message')}</span><span class="rd-value">${esc(decision.message)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_classifier')}</span><span class="rd-value">${esc(decision.classifier)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_category')}</span><span class="rd-value rd-cat">${esc(decision.category)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_model')}</span><span class="rd-value rd-model">${esc(decision.model)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_provider')}</span><span class="rd-value">${esc(decision.provider)}</span></div>
      ${decision.elapsed != null ? `<div class="routing-diag-row"><span class="rd-label">${t('rd_elapsed')}</span><span class="rd-value">${esc(decision.elapsed)} ms</span></div>` : ''}
    </div>`;
  const details = document.getElementById('ml-diagDetails');
  if (details) details.open = true;
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
