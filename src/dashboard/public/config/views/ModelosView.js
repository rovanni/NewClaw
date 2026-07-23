import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';
import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';
import { addCustomProvider, removeCustomProvider, getCloudCatalog } from '../api.js';
import { loadProviders } from '../app.js';

const CATEGORY_META = [
  { key: 'chat',      icon: '💬', label: 'Chat' },
  { key: 'code',      icon: '💻', label: 'Código' },
  { key: 'vision',    icon: '👁️', label: 'Visão' },
  { key: 'light',     icon: '⚡', label: 'Leve' },
  { key: 'analysis',  icon: '📊', label: 'Análise' },
  { key: 'execution', icon: '🧠', label: 'Execução' },
];

// Capability mínima exigida por categoria — reaproveita as capabilities já calculadas no
// discovery (ModelRegistryService/modelCapabilityHeuristics), nenhuma regra nova é criada aqui.
const CATEGORY_CAPABILITY = {
  chat: 'chat', light: 'chat', analysis: 'chat',
  code: 'code', vision: 'vision', execution: 'tool_calling',
};

const PROV_LABELS = {
  ollama: 'Ollama (Local + Cloud)', gemini: 'Google Gemini',
  openrouter: 'OpenRouter', deepseek: 'DeepSeek', groq: 'Groq',
  anthropic: 'Anthropic (Claude)',
};

const CLOUD_PROVIDERS = [
  { key: 'gemini',     icon: '✨', name: 'Google Gemini',    placeholder: 'AIza...' },
  { key: 'deepseek',   icon: '🌊', name: 'DeepSeek',         placeholder: 'sk-...' },
  { key: 'groq',       icon: '⚡', name: 'Groq',             placeholder: 'gsk_...' },
  { key: 'openrouter', icon: '🔀', name: 'OpenRouter',       placeholder: 'sk-or-...' },
  { key: 'anthropic',  icon: '🧠', name: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
];

const CUSTOM_PROVIDER_PRESETS = [
  { label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1' },
  { label: 'LM Studio',  baseUrl: 'http://localhost:1234/v1' },
  { label: 'vLLM',       baseUrl: 'http://localhost:8000/v1' },
];

const CAPABILITY_LABELS = {
  chat: '💬 Chat', vision: '👁️ Vision', embedding: '🧬 Embedding',
  reasoning: '🧠 Reasoning', code: '💻 Code', tool_calling: '🔧 Function Calling',
};

const TABS = [
  { id: 'overview',  icon: '📡', label: 'Overview' },
  { id: 'registry',  icon: '📚', label: 'Registry' },
  { id: 'routing',   icon: '🧭', label: 'Routing' },
  { id: 'providers', icon: '🔌', label: 'Providers' },
  { id: 'advanced',  icon: '⚙️', label: 'Advanced' },
];

// Estado local do filtro do Model Registry — reiniciado a cada render() (troca de página).
let registrySearch = '';
let registryFilters = new Set();

// Estado local do seletor de categoria em Routing — idem.
let routingSelectedCategory = 'chat';
let routingPendingModel = null;

// Estado local do toggle Instalados/Cloud no Registry — idem. cloudCatalog é lazy (só busca no
// remoto quando o usuário troca pro modo cloud, não no carregamento da página).
let registryMode = 'installed';
let cloudCatalog = null;

export function render(container) {
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🤖 ${t('sidebar_models')}</h1>
        <p>${t('models_page_desc')}</p>
      </div>

      <div class="ml-tabs" id="ml-tabs">
        ${TABS.map((tab, i) => `<button type="button" class="ml-tab${i === 0 ? ' active' : ''}" data-tab="${tab.id}">${tab.icon} ${tab.label}</button>`).join('')}
      </div>

      <!-- ═══ Overview ═══ -->
      <div class="ml-panel active" data-panel="overview">
        <div class="overview-card">
          <div class="overview-row"><span class="overview-label">Provider</span><span class="overview-value" id="ov-provider">—</span></div>
          <div class="overview-row"><span class="overview-label">Status</span><span class="overview-value"><span class="dot" id="ov-dot"></span> <span id="ov-status">—</span></span></div>
          <div class="overview-row"><span class="overview-label">Modelos</span><span class="overview-value" id="ov-count">—</span></div>
          <div class="overview-row"><span class="overview-label">Última sincronização</span><span class="overview-value" id="ov-lastsync">—</span></div>
          <div class="overview-row"><span class="overview-label">Modelo padrão</span><span class="overview-value" id="ov-defaultmodel">—</span></div>
        </div>
        <button class="btn btn-primary btn-sm" id="ml-syncBtn" style="margin-top:14px;">🔄 Sincronizar Modelos</button>
      </div>

      <!-- ═══ Registry ═══ -->
      <div class="ml-panel" data-panel="registry">
        <div class="cat-selector" id="mr-modeToggle">
          <button type="button" class="cat-btn active" data-mode="installed">📦 Instalados</button>
          <button type="button" class="cat-btn" data-mode="cloud">☁️ Disponíveis na nuvem</button>
        </div>
        <div class="model-registry-toolbar">
          <input type="text" class="form-input" id="mr-search" placeholder="Buscar modelo..." style="max-width:260px;">
          <div class="model-filter-chips" id="mr-filters">
            ${Object.keys(CAPABILITY_LABELS).map(cap => `<div class="chip" data-cap="${cap}">${CAPABILITY_LABELS[cap]}</div>`).join('')}
          </div>
        </div>
        <div class="model-pull-bar">
          <input type="text" class="form-input" id="mr-pullInput" placeholder="Puxar modelo pelo nome exato (ex: kimi-k2.6:cloud)" style="max-width:340px;">
          <button class="btn btn-primary btn-sm" id="mr-pullBtn">⬇️ Puxar</button>
          <span class="form-hint">Não achou na lista "Disponíveis na nuvem"? Registre pelo nome exato aqui.</span>
        </div>
        <div class="model-table-wrap">
          <table class="model-table">
            <thead>
              <tr><th>Nome</th><th>Provider</th><th>Capabilities</th><th>Status</th><th>Context</th></tr>
            </thead>
            <tbody id="mr-tbody"></tbody>
          </table>
        </div>
      </div>

      <!-- ═══ Routing ═══ -->
      <div class="ml-panel" data-panel="routing">
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

        <!-- Fluxo — recolhido por padrão: muda pouco na prática, não precisa ficar sempre visível -->
        <details class="cfg-details">
          <summary>${t('pipeline_title')}</summary>
          <div class="pipeline-wrap">
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
        </details>

        <!-- Seleção de modelo por categoria — reutiliza a tabela do Model Registry como seletor,
             em vez de 6 dropdowns/autocompletes independentes (Sprint UX-002). -->
        <div class="cfg-details">
          <div class="cfg-details-body">
            <div class="cat-selector" id="rt-catSelector">
              ${CATEGORY_META.map((c, i) => `<button type="button" class="cat-btn${i === 0 ? ' active' : ''}" data-cat="${c.key}">${c.icon} ${c.label}</button>`).join('')}
            </div>

            <div class="rt-picker-header">
              <div class="rt-picker-info">
                <span class="overview-label">Modelo atual</span>
                <span class="rt-current-model" id="rt-currentModel">—</span>
              </div>
              <div class="rt-picker-info" id="rt-pendingWrap" style="display:none;">
                <span class="overview-label">→ Selecionado</span>
                <span class="rt-pending-model" id="rt-pendingModel">—</span>
              </div>
              <button class="btn btn-primary btn-sm" id="rt-applyBtn" disabled>✅ Aplicar</button>
            </div>

            <div class="model-table-wrap">
              <table class="model-table">
                <thead>
                  <tr><th></th><th>Nome</th><th>Provider</th><th>Capabilities</th><th>Status</th><th>Context</th></tr>
                </thead>
                <tbody id="rt-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Provider padrão + Classificador -->
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
                <option value="anthropic">🧠 Anthropic (Claude)</option>
              </select>
            </div>
            <div id="ml-ollamaSection">
              <div class="form-group">
                <label class="form-label">${t('main_ollama_model_label')} <span class="badge badge-cloud">cloud</span></label>
                <div class="model-select-container" id="container-ollamaModel">
                  <input type="text" class="model-select-input" autocomplete="off" id="ollamaModel" placeholder="glm-5.2:cloud">
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
      </div>

      <!-- ═══ Providers ═══ -->
      <div class="ml-panel" data-panel="providers">
        <div class="provider-toolbar">
          <span class="form-hint" id="ml-lastSync">Última sincronização: —</span>
        </div>
        <div class="provider-grid" id="ml-providerGrid"></div>

        <details class="cfg-details">
          <summary>➕ Adicionar provider OpenAI-Compatible (LM Studio / vLLM / OpenAI / custom)</summary>
          <div class="cfg-details-body">
            <div class="chips" style="margin-bottom:10px;">
              ${CUSTOM_PROVIDER_PRESETS.map(p => `<div class="chip" data-preset="${p.label}" data-url="${p.baseUrl}">${p.label}</div>`).join('')}
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Nome</label>
                <input type="text" class="form-input" id="ml-newProvLabel" placeholder="Ex: LM Studio">
              </div>
              <div class="form-group">
                <label class="form-label">Base URL</label>
                <input type="text" class="form-input" id="ml-newProvUrl" placeholder="http://localhost:1234/v1">
              </div>
              <div class="form-group">
                <label class="form-label">API Key (opcional)</label>
                <input type="password" class="form-input" id="ml-newProvKey" placeholder="Opcional">
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="ml-addProvBtn">Adicionar</button>
          </div>
        </details>
      </div>

      <!-- ═══ Advanced ═══ -->
      <div class="ml-panel" data-panel="advanced">
        <details class="cfg-details" id="ml-internalDetails" open>
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
      </div>
    </div>`;

  const cs = configStore;
  const s  = cs.snap();
  const r  = s.modelRouter || {};
  const el = id => document.getElementById(id);

  // Populate inputs
  el('ml-defaultProvider').value  = s.defaultProvider || 'ollama';
  el('ollamaModel').value         = s.ollamaModel || '';
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
    updateOverview();
  });

  // Ollama main model
  el('ollamaModel').addEventListener('input', e => { cs.set('ollamaModel', e.target.value); updateOverview(); });

  // Classifier model (os 6 modelos de categoria agora são selecionados via rt-tbody, não digitados)
  el('classifierModel').addEventListener('input', e => {
    const mr = { ...cs.get('modelRouter') };
    mr.classifierModel = e.target.value;
    cs.set('modelRouter', mr);
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

  // Init model dropdowns (só os 2 campos que ainda são texto livre — o resto usa o seletor)
  const ddIds = ['ollamaModel', 'classifierModel'];
  updateDropdownModels(providersStore.get('models') || []);
  initDropdowns(ddIds);

  // ── Tabs ─────────────────────────────────────────────────────
  wireTabs(container);

  // ── Overview + Provider grid + Model Registry table ──────────
  registrySearch = '';
  registryFilters = new Set();
  registryMode = 'installed';
  cloudCatalog = null;
  routingSelectedCategory = 'chat';
  routingPendingModel = null;

  renderProviderGrid();
  renderModelTable();
  renderCategoryPicker();
  updateOverview();
  wireProviderOverview();
  wireModelRegistry(container);
  wireCategoryPicker(container);

  // Subscribe to providersStore
  const unsubModels = providersStore.on('models', models => {
    updateDropdownModels(models);
    updateModelStatus(models, cs.get('modelRouter') || {});
  });
  const unsubCatalog = providersStore.on('catalog', () => { renderModelTable(); renderCategoryPicker(); });
  // Atualização leve (só dots/texto de saúde) — NUNCA um renderProviderGrid() completo aqui:
  // isso recriaria os <input> do card (URL/API key) a cada poll e apagaria o que o usuário
  // estivesse digitando no meio de uma edição.
  const unsubHealthSync = providersStore.on('*', () => { updateProviderHealthUI(); updateOverview(); });

  // Subscribe to configStore router
  const unsubRouter = cs.on('modelRouter', mr => {
    updatePipeline(mr);
    updateEffectiveConfig(mr, cs.get('defaultProvider'));
    updateModelStatus(providersStore.get('models') || [], mr);
    renderCategoryPicker();
  });
  const unsubCustomProviders = cs.on('customProviders', () => renderProviderGrid());

  // Routing diagnostics
  if (window._newclawLastRoutingDecision) {
    updateRoutingDiag(window._newclawLastRoutingDecision);
  }
  const diagHandler = e => updateRoutingDiag(e.detail);
  window.addEventListener('newclaw-routing-decision', diagHandler);

  return () => {
    unsubModels();
    unsubCatalog();
    unsubHealthSync();
    unsubRouter();
    unsubCustomProviders();
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

// ─── Tabs ────────────────────────────────────────────────────

function wireTabs(container) {
  const tabs   = container.querySelectorAll('.ml-tab');
  const panels = container.querySelectorAll('.ml-panel');
  tabs.forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.toggle('active', b === tabBtn));
      panels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabBtn.dataset.tab));
    });
  });
}

// ─── Overview ───────────────────────────────────────────────

function updateOverview() {
  const cs = configStore;
  const s = cs.snap();
  const health = providersStore.get('health') || [];
  const ollamaHealth = health.find(h => h.provider === 'ollama');
  const ollamaOnline = providersStore.get('ollamaOnline');
  const ollamaCount  = providersStore.get('ollamaModelCount') || 0;
  const lastSync     = providersStore.get('lastSync');

  const el = id => document.getElementById(id);
  el('ov-provider')     && (el('ov-provider').textContent = PROV_LABELS[s.defaultProvider] || s.defaultProvider || '—');
  el('ov-dot')          && (el('ov-dot').className = `dot ${ollamaOnline ? 'online' : 'offline'}`);
  el('ov-status')       && (el('ov-status').textContent = ollamaOnline ? 'Online' : (ollamaHealth?.error || 'Offline'));
  el('ov-count')        && (el('ov-count').textContent = `${ollamaCount} disponíveis`);
  el('ov-lastsync')     && (el('ov-lastsync').textContent = lastSync ? new Date(lastSync).toLocaleTimeString() : '—');
  el('ov-defaultmodel') && (el('ov-defaultmodel').textContent = s.currentModel || s.ollamaModel || '—');
}

// ─── Provider Overview ─────────────────────────────────────────

function renderProviderGrid() {
  const grid = document.getElementById('ml-providerGrid');
  if (!grid) return;
  const cs = configStore;
  const s = cs.snap();
  const health = providersStore.get('health') || [];
  const healthByProvider = Object.fromEntries(health.map(h => [h.provider, h]));
  const ollamaHealth = healthByProvider['ollama'];
  const ollamaOnline = providersStore.get('ollamaOnline');
  const ollamaCount  = providersStore.get('ollamaModelCount') || 0;

  const cards = [];

  // Ollama (sempre presente — provider local/cloud padrão)
  cards.push(`
    <div class="provider-card wide">
      <div class="provider-head">
        <div class="provider-name">🦙 Ollama <span class="badge badge-local">local</span><span class="badge badge-cloud">cloud</span></div>
        <div class="provider-health" data-health="ollama">
          <span class="dot ${ollamaOnline ? 'online' : 'offline'}"></span>
          <span>${ollamaOnline ? `${ollamaCount} modelos` : (ollamaHealth?.error || 'offline')}</span>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('server_url_label') || 'Endpoint'}</label>
          <input type="text" class="form-input" id="pv-ollamaUrl" placeholder="http://localhost:11434" value="${esc(s.ollamaUrl || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">API Key (cloud)</label>
          <input type="password" class="form-input" id="pv-ollamaApiKey" placeholder="Opcional">
        </div>
      </div>
    </div>`);

  // Custom providers (OpenAI-Compatible)
  for (const p of (s.customProviders || [])) {
    const h = healthByProvider[p.label];
    cards.push(`
      <div class="provider-card">
        <div class="provider-head">
          <div class="provider-name">🔗 ${esc(p.label)} <span class="badge badge-cloud">OpenAI-Compatible</span></div>
          <div class="provider-health" data-health="${esc(p.label)}">
            <span class="dot ${h ? (h.online ? 'online' : 'offline') : ''}"></span>
            <span>${h ? (h.online ? `${h.modelCount} modelos` : 'offline') : '—'}</span>
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:8px;word-break:break-all;">${esc(p.baseUrl)}</div>
        <button class="btn btn-ghost btn-sm btn-remove-key" data-remove-provider="${esc(p.label)}">✕ Remover</button>
      </div>`);
  }

  // Cloud providers (API key cards)
  for (const cp of CLOUD_PROVIDERS) {
    const hasKey = s[`has${cp.key.charAt(0).toUpperCase() + cp.key.slice(1)}Key`];
    cards.push(`
      <div class="provider-card">
        <div class="provider-head">
          <div class="provider-name">${cp.icon} ${cp.name}</div>
          <div class="provider-health"><span class="dot ${hasKey ? 'online' : 'offline'}"></span></div>
        </div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <div class="api-key-group">
            <input type="password" class="form-input" id="pv-${cp.key}Key" placeholder="${cp.placeholder}">
            <span class="api-key-status">${hasKey ? '✓ OK' : t('key_missing') || 'não configurada'}</span>
            <button class="btn btn-ghost btn-sm btn-remove-key" data-remove-key="${cp.key}" style="${hasKey ? '' : 'display:none'}" title="Remover chave">✕</button>
          </div>
        </div>
      </div>`);
  }

  grid.innerHTML = cards.join('');
  updateLastSync();
}

/**
 * Atualiza só os dots/texto de saúde dos cards já renderizados, sem tocar nos <input> —
 * usado no polling periódico para não apagar o que o usuário estiver digitando.
 */
function updateProviderHealthUI() {
  const health = providersStore.get('health') || [];
  const healthByProvider = Object.fromEntries(health.map(h => [h.provider, h]));
  const ollamaOnline = providersStore.get('ollamaOnline');
  const ollamaCount  = providersStore.get('ollamaModelCount') || 0;

  const ollamaEl = document.querySelector('[data-health="ollama"]');
  if (ollamaEl) {
    const ollamaHealth = healthByProvider['ollama'];
    ollamaEl.querySelector('.dot').className = `dot ${ollamaOnline ? 'online' : 'offline'}`;
    ollamaEl.querySelector('span:last-child').textContent = ollamaOnline ? `${ollamaCount} modelos` : (ollamaHealth?.error || 'offline');
  }

  for (const [label, h] of Object.entries(healthByProvider)) {
    if (label === 'ollama') continue;
    const elHealth = document.querySelector(`[data-health="${CSS.escape(label)}"]`);
    if (!elHealth) continue;
    elHealth.querySelector('.dot').className = `dot ${h.online ? 'online' : 'offline'}`;
    elHealth.querySelector('span:last-child').textContent = h.online ? `${h.modelCount} modelos` : 'offline';
  }
  updateLastSync();
}

function wireProviderOverview() {
  const cs = configStore;
  const el = id => document.getElementById(id);

  el('ml-syncBtn')?.addEventListener('click', async () => {
    showToast('🔄 Sincronizando...', 'success');
    await loadProviders(true);
    showToast('✅ Sincronizado', 'success');
  });

  document.getElementById('ml-providerGrid')?.addEventListener('input', e => {
    if (e.target.id === 'pv-ollamaUrl')    cs.set('ollamaUrl', e.target.value);
    if (e.target.id === 'pv-ollamaApiKey') cs.set('ollamaApiKey', e.target.value);
    CLOUD_PROVIDERS.forEach(cp => {
      if (e.target.id === `pv-${cp.key}Key`) cs.set(`${cp.key}Key`, e.target.value);
    });
  });

  document.getElementById('ml-providerGrid')?.addEventListener('click', async e => {
    const removeKey = e.target.closest('[data-remove-key]')?.dataset.removeKey;
    if (removeKey) {
      if (!confirm(`Remover a API key do ${removeKey}?`)) return;
      try {
        const f = window.newclawFetch || fetch;
        const res = await f(`/api/providers/key/${removeKey}`, { method: 'DELETE' });
        if ((await res.json()).success) {
          const hasKey = `has${removeKey.charAt(0).toUpperCase() + removeKey.slice(1)}Key`;
          cs.set(hasKey, false);
          showToast(`Chave ${removeKey} removida`, 'success');
          renderProviderGrid();
        }
      } catch (err) { showToast('Erro ao remover chave: ' + err.message, 'error'); }
      return;
    }
    const removeProvider = e.target.closest('[data-remove-provider]')?.dataset.removeProvider;
    if (removeProvider) {
      if (!confirm(`Remover o provider "${removeProvider}"?`)) return;
      try {
        await removeCustomProvider(removeProvider);
        cs.set('customProviders', (cs.get('customProviders') || []).filter(p => p.label !== removeProvider));
        showToast(`Provider "${removeProvider}" removido`, 'success');
      } catch (err) { showToast('Erro: ' + err.message, 'error'); }
    }
  });

  // Presets do formulário de custom provider
  document.querySelectorAll('.chip[data-preset]').forEach(chip => {
    chip.addEventListener('click', () => {
      const labelInput = document.getElementById('ml-newProvLabel');
      const urlInput   = document.getElementById('ml-newProvUrl');
      if (labelInput) labelInput.value = chip.dataset.preset;
      if (urlInput)   urlInput.value   = chip.dataset.url;
    });
  });

  document.getElementById('ml-addProvBtn')?.addEventListener('click', async () => {
    const label   = document.getElementById('ml-newProvLabel')?.value.trim();
    const baseUrl = document.getElementById('ml-newProvUrl')?.value.trim();
    const apiKey  = document.getElementById('ml-newProvKey')?.value.trim();
    if (!label || !baseUrl) { showToast('Preencha nome e Base URL', 'error'); return; }
    try {
      await addCustomProvider({ label, baseUrl, apiKey: apiKey || undefined });
      cs.set('customProviders', [...(cs.get('customProviders') || []), { label, baseUrl, hasKey: !!apiKey }]);
      showToast(`Provider "${label}" adicionado`, 'success');
      document.getElementById('ml-newProvLabel').value = '';
      document.getElementById('ml-newProvUrl').value   = '';
      document.getElementById('ml-newProvKey').value   = '';
    } catch (err) { showToast('Erro: ' + err.message, 'error'); }
  });
}

function updateLastSync() {
  const el = document.getElementById('ml-lastSync');
  if (!el) return;
  const ts = providersStore.get('lastSync');
  el.textContent = 'Última sincronização: ' + (ts ? new Date(ts).toLocaleTimeString() : '—');
}

// ─── Model Registry (tabela reutilizada — browse em Registry, seleção em Routing) ─────

/**
 * Gera as linhas <tr> do catálogo. Único ponto de renderização de linha de modelo — a tabela de
 * consulta (Registry, modos Instalados/Cloud) e o seletor por categoria (Routing) chamam esta
 * mesma função, em vez de duplicar a lógica de escapamento/badges/capability tags (Sprint UX-002).
 *
 * installedIds !== null implica "modo cloud": a última coluna vira ação de instalar em vez de
 * status, e modelos já instalados ganham um badge "Instalado" em vez do botão — nunca escondidos.
 */
function buildModelRows(models, { selectable = false, selectedId = null, currentId = null, installedIds = null } = {}) {
  if (!models.length) {
    return `<tr><td colspan="${selectable ? 6 : 5}" class="empty" style="padding:20px;color:var(--text-soft);">Nenhum modelo encontrado.</td></tr>`;
  }
  return models.map(m => {
    const isCurrent = !!currentId && m.id === currentId;
    const isSelected = selectable && !!selectedId && m.id === selectedId;
    const rowClass = [selectable ? 'model-row-selectable' : '', isCurrent ? 'model-row-current' : ''].filter(Boolean).join(' ');
    const lastCell = installedIds
      ? (installedIds.has(m.id)
          ? `<span class="model-installed-badge">✓ Instalado</span>`
          : `<button type="button" class="btn btn-primary btn-sm" data-activate-cloud="${esc(m.id)}">⬇️ Instalar</button>`)
      : `<span class="dot online" style="display:inline-block;"></span> Disponível`;
    return `
    <tr class="${rowClass}" data-model-id="${esc(m.id)}">
      ${selectable ? `<td class="model-radio-cell">${isSelected ? '🔘' : '⚪'}</td>` : ''}
      <td class="model-table-id">${esc(m.id)}${isCurrent ? ' <span class="model-current-badge">atual</span>' : ''}</td>
      <td><span class="badge badge-${m.provider === 'ollama' ? 'local' : 'cloud'}">${esc(m.provider)}</span></td>
      <td>${(m.capabilities || []).map(c => `<span class="model-cap-tag">${CAPABILITY_LABELS[c] || c}</span>`).join(' ')}</td>
      <td>${lastCell}</td>
      <td>${esc(formatContextWindow(m.contextWindow))}</td>
    </tr>`;
  }).join('');
}

/** Busca + filtro de capability — mesmo critério nos dois modos (Instalados/Cloud). */
function filterCatalog(list) {
  const term = registrySearch.toLowerCase();
  return list.filter(m => {
    if (term && !m.id.toLowerCase().includes(term)) return false;
    if (registryFilters.size > 0 && !m.capabilities?.some(c => registryFilters.has(c))) return false;
    return true;
  });
}

async function renderModelTable() {
  const tbody = document.getElementById('mr-tbody');
  if (!tbody) return;

  if (registryMode === 'cloud') {
    if (cloudCatalog === null) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">Carregando catálogo cloud...</td></tr>`;
      cloudCatalog = await getCloudCatalog();
      if (registryMode !== 'cloud') return; // usuário trocou de modo enquanto o fetch rodava
    }
    const filtered = filterCatalog(cloudCatalog);
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">
        ${cloudCatalog.length === 0 ? 'Catálogo cloud indisponível no momento — tente novamente mais tarde.' : 'Nenhum modelo bate com a busca/filtro.'}
      </td></tr>`;
      return;
    }
    const installedIds = new Set((providersStore.get('catalog') || []).map(m => m.id));
    tbody.innerHTML = buildModelRows(filtered, { installedIds });
    return;
  }

  const catalog = providersStore.get('catalog') || [];
  const filtered = filterCatalog(catalog);
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">
      ${catalog.length === 0 ? 'Nenhum modelo descoberto ainda — clique em "Sincronizar Modelos" na aba Overview.' : 'Nenhum modelo bate com a busca/filtro.'}
    </td></tr>`;
    return;
  }
  tbody.innerHTML = buildModelRows(filtered);
}

function wireModelRegistry(container) {
  const searchInput = document.getElementById('mr-search');
  searchInput?.addEventListener('input', e => {
    registrySearch = e.target.value;
    renderModelTable();
  });

  container.querySelectorAll('#mr-filters .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cap = chip.dataset.cap;
      if (registryFilters.has(cap)) { registryFilters.delete(cap); chip.classList.remove('chip-active'); }
      else { registryFilters.add(cap); chip.classList.add('chip-active'); }
      renderModelTable();
    });
  });

  container.querySelectorAll('#mr-modeToggle .cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#mr-modeToggle .cat-btn').forEach(b => b.classList.toggle('active', b === btn));
      registryMode = btn.dataset.mode;
      renderModelTable();
    });
  });

  // Delegação — sobrevive ao innerHTML do tbody sendo trocado a cada renderModelTable().
  document.getElementById('mr-tbody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-activate-cloud]');
    if (!btn) return;
    const name = btn.dataset.activateCloud;
    btn.disabled = true;
    btn.textContent = '⏳ Instalando...';
    await pullIntoRegistry(name); // já ressincroniza o catálogo local (loadProviders(true))
    renderModelTable(); // badge "Instalado" substitui o botão automaticamente
  });

  const pullInput = document.getElementById('mr-pullInput');
  const triggerPull = () => {
    const name = pullInput?.value.trim();
    if (!name) return;
    pullIntoRegistry(name).then(() => { if (registryMode === 'cloud') renderModelTable(); });
    pullInput.value = '';
  };
  document.getElementById('mr-pullBtn')?.addEventListener('click', triggerPull);
  pullInput?.addEventListener('keydown', e => { if (e.key === 'Enter') triggerPull(); });
}

// ─── Seletor de modelo por categoria (Routing) ────────────────────────

function renderCategoryPicker() {
  const cs = configStore;
  const r = cs.get('modelRouter') || {};
  const currentModel = r[routingSelectedCategory] || '';
  const requiredCap = CATEGORY_CAPABILITY[routingSelectedCategory];
  const catalog = providersStore.get('catalog') || [];
  // Filtra por compatibilidade usando as capabilities já calculadas no discovery — nunca lista
  // um modelo incompatível (ex: nomic-embed na categoria Visão).
  const compatible = catalog.filter(m => !requiredCap || m.capabilities?.includes(requiredCap));

  const curEl = document.getElementById('rt-currentModel');
  if (curEl) curEl.textContent = currentModel || '(não configurado)';

  const pendingWrap = document.getElementById('rt-pendingWrap');
  const pendingEl = document.getElementById('rt-pendingModel');
  const showPending = !!routingPendingModel && routingPendingModel !== currentModel;
  if (pendingWrap) pendingWrap.style.display = showPending ? '' : 'none';
  if (pendingEl && showPending) pendingEl.textContent = routingPendingModel;

  const applyBtn = document.getElementById('rt-applyBtn');
  if (applyBtn) applyBtn.disabled = !showPending;

  const tbody = document.getElementById('rt-tbody');
  if (tbody) {
    tbody.innerHTML = buildModelRows(compatible, { selectable: true, selectedId: routingPendingModel || currentModel, currentId: currentModel });
  }
}

function wireCategoryPicker(container) {
  container.querySelectorAll('#rt-catSelector .cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#rt-catSelector .cat-btn').forEach(b => b.classList.toggle('active', b === btn));
      routingSelectedCategory = btn.dataset.cat;
      routingPendingModel = null;
      renderCategoryPicker();
    });
  });

  // Delegação de evento — sobrevive a innerHTML sendo trocado a cada renderCategoryPicker().
  document.getElementById('rt-tbody')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-model-id]');
    if (!tr) return;
    routingPendingModel = tr.dataset.modelId;
    renderCategoryPicker();
  });

  document.getElementById('rt-applyBtn')?.addEventListener('click', () => {
    if (!routingPendingModel) return;
    const cs = configStore;
    const mr = { ...cs.get('modelRouter') };
    mr[routingSelectedCategory] = routingPendingModel;
    cs.set('modelRouter', mr);
    const catLabel = CATEGORY_META.find(c => c.key === routingSelectedCategory)?.label || routingSelectedCategory;
    showToast(`Modelo de ${catLabel} atualizado para "${routingPendingModel}"`, 'success');
    routingPendingModel = null;
    renderCategoryPicker();
  });
}

function formatContextWindow(tokens) {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

// ─── HTML helpers ─────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
        <option value="anthropic">Anthropic (Claude)</option>
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
  const escd = s => String(s || '—').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML = `
    <div class="routing-diag-grid">
      <div class="routing-diag-row"><span class="rd-label">${t('rd_message')}</span><span class="rd-value">${escd(decision.message)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_classifier')}</span><span class="rd-value">${escd(decision.classifier)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_category')}</span><span class="rd-value rd-cat">${escd(decision.category)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_model')}</span><span class="rd-value rd-model">${escd(decision.model)}</span></div>
      <div class="routing-diag-row"><span class="rd-label">${t('rd_provider')}</span><span class="rd-value">${escd(decision.provider)}</span></div>
      ${decision.elapsed != null ? `<div class="routing-diag-row"><span class="rd-label">${t('rd_elapsed')}</span><span class="rd-value">${escd(decision.elapsed)} ms</span></div>` : ''}
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

/** POST /api/ollama/pull cru — único ponto de chamada desse endpoint nesta view. */
async function pullOllamaModel(name) {
  const f = window.newclawFetch || fetch;
  const res = await f('/api/ollama/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
  return res.json();
}

/** Pull a partir de Routing → Provider & Classificador: também define como "Modelo Ollama Principal". */
async function doPull(name) {
  if (!name?.trim()) return;
  name = name.trim();
  showToast('⬇️ Baixando "' + name + '"...', 'success');
  try {
    const data = await pullOllamaModel(name);
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

/**
 * Pull a partir do Registry: só registra o modelo no Ollama e ressincroniza o catálogo — não
 * mexe no "Modelo Ollama Principal" (esse pull é pra ampliar o catálogo, não pra trocar de modelo).
 */
async function pullIntoRegistry(name) {
  if (!name?.trim()) return;
  name = name.trim();
  showToast('⬇️ Registrando "' + name + '"...', 'success');
  try {
    const data = await pullOllamaModel(name);
    if (data.success) {
      showToast('✅ "' + name + '" adicionado ao catálogo!', 'success');
      await loadProviders(true);
    } else {
      showToast('❌ ' + (data.error || 'desconhecido'), 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}
