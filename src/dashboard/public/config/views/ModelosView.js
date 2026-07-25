import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';
import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';
import { addCustomProvider, removeCustomProvider, getCloudCatalog } from '../api.js';
import { loadProviders, doSave, guideBox } from '../app.js';

// Funções (não const) porque t() precisa ser avaliado a cada render() — se fossem consts de
// módulo, ficariam presas no idioma ativo no momento em que o arquivo foi importado pela primeira
// vez e nunca atualizariam depois de uma troca de idioma (mesma classe de bug do header — ver
// newclawSetLang() em shared.js).
function getCategoryMeta() {
  return [
    { key: 'chat',      icon: '💬', label: 'Chat' },
    { key: 'code',      icon: '💻', label: t('route_code_cat') },
    { key: 'vision',    icon: '👁️', label: t('route_vision_cat') },
    { key: 'light',     icon: '⚡', label: t('route_light_cat') },
    { key: 'analysis',  icon: '📊', label: t('route_analysis_cat') },
    { key: 'execution', icon: '🧠', label: t('route_execution_cat') },
  ];
}

// Capability mínima exigida por categoria — reaproveita as capabilities já calculadas no
// discovery (ModelRegistryService/modelCapabilityHeuristics), nenhuma regra nova é criada aqui.
//
// 'code' usa 'chat' (mesma exigência de chat/light/analysis), não 'code': diferente de vision e
// tool_calling — exigências técnicas reais, um modelo sem elas literalmente não processa imagem
// ou não chama ferramenta — não existe "modelo tecnicamente incapaz de código", só modelos mais
// ou menos especializados. Filtrar Código por capability 'code' escondia da lista modelos de
// propósito geral genuinamente capazes (achado 2026-07-25: glm-5.2:cloud, gpt-oss — sem "code" no
// nome nem flag real de FIM no Ollama, mas perfeitamente aptos). A tag "Código" continua aparecendo
// na tabela como informação — só não filtra mais quem pode ser escolhido.
const CATEGORY_CAPABILITY = {
  chat: 'chat', light: 'chat', analysis: 'chat',
  code: 'chat', vision: 'vision', execution: 'tool_calling',
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

function getCapabilityLabels() {
  return {
    chat: t('ml_cap_chat'), vision: t('ml_cap_vision'), embedding: t('ml_cap_embedding'),
    reasoning: t('ml_cap_reasoning'), code: t('ml_cap_code'), tool_calling: t('ml_cap_toolcalling'),
  };
}

function getTabs() {
  return [
    { id: 'overview',  icon: '📡', label: t('ml_tab_overview') },
    { id: 'registry',  icon: '📚', label: t('ml_tab_registry') },
    { id: 'routing',   icon: '🧭', label: t('ml_tab_routing') },
    { id: 'providers', icon: '🔌', label: t('ml_tab_providers') },
    { id: 'advanced',  icon: '⚙️', label: t('ml_tab_advanced') },
  ];
}

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
  const tabs = getTabs();
  const capLabels = getCapabilityLabels();
  const categoryMeta = getCategoryMeta();
  container.innerHTML = `
    <div class="page-view">
      <div class="page-header">
        <h1>🤖 ${t('sidebar_models')}</h1>
        <p>${t('models_page_desc')}</p>
      </div>

      <div class="ml-tabs" id="ml-tabs">
        ${tabs.map((tab, i) => `<button type="button" class="ml-tab${i === 0 ? ' active' : ''}" data-tab="${tab.id}">${tab.icon} ${tab.label}${tab.id === 'routing' ? ' <span id="ml-routingTabWarn" style="display:none;">⚠️</span>' : ''}</button>`).join('')}
      </div>

      <!-- ═══ Overview ═══ -->
      <div class="ml-panel active" data-panel="overview">
        ${guideBox(t('ml_ov_guide'))}
        <!-- Painel só-leitura: responde "o sistema está pronto?", sem ações operacionais (2026-07-25).
             Timestamp exato de sincronização e contagem detalhada têm local canônico único no card
             "Catálogo de Modelos" (Instalar Modelo) — aqui só o resumo de prontidão. -->
        <div class="overview-card">
          <div class="overview-row"><span class="overview-label">${t('ml_ov_provider')}</span><span class="overview-value"><span class="dot" id="ov-dot"></span> <span id="ov-provider">—</span></span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_ov_models')}</span><span class="overview-value" id="ov-count">—</span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_ov_defaultmodel')}</span><span class="overview-value" id="ov-defaultmodel">—</span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_ov_ready')}</span><span class="overview-value" id="ov-ready">—</span></div>
        </div>
      </div>

      <!-- ═══ Registry ═══ -->
      <div class="ml-panel" data-panel="registry">
        ${guideBox(t('ml_tab_registry_guide'))}

        <!-- Catálogo de Modelos — local canônico único das métricas de catálogo (2026-07-25):
             antes espalhadas entre o card da Visão Geral e o botão Sincronizar solto lá.
             Visão Geral agora só reflete prontidão agregada; aqui é o detalhe operacional. -->
        <div class="overview-card" style="margin-bottom:16px;">
          <div class="overview-row"><span class="overview-label">${t('ml_cat_count')}</span><span class="overview-value" id="cat-count">—</span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_cat_lastsync')}</span><span class="overview-value" id="cat-lastsync">—</span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_cat_origin')}</span><span class="overview-value" id="cat-origin">—</span></div>
          <div class="overview-row"><span class="overview-label">${t('ml_cat_syncstatus')}</span><span class="overview-value"><span class="dot" id="cat-dot"></span> <span id="cat-syncstatus">—</span></span></div>
        </div>

        <!-- Download rápido (Ollama) — relocado de "Escolher Modelo" (2026-07-25): é instalação,
             não seleção; pertence conceitualmente aqui, não na aba de roteamento. -->
        <details class="cfg-details" open>
          <summary>${t('download_models_label')}</summary>
          <div class="cfg-details-body">
            <div class="chips" style="margin-bottom:8px;">
              <div class="chip" data-pull="qwen2.5:7b">qwen2.5:7b</div>
              <div class="chip" data-pull="llama3.1:8b">llama3.1:8b</div>
              <div class="chip" data-pull="gemma4:31b-cloud">gemma4:31b-cloud</div>
              <div class="chip" data-pull="mistral:7b">mistral:7b</div>
              <div class="chip" data-pull="deepseek-coder-v2:16b">deepseek-coder-v2:16b</div>
            </div>
            <div style="display:flex;gap:8px;">
              <input type="text" id="ml-customPull" placeholder="modelo:tag" class="form-input"
                style="flex:1;max-width:180px;padding:7px 10px;font-size:.77rem;">
              <button class="btn btn-primary btn-sm" id="ml-pullBtn">⬇️ ${t('ml_pull_btn')}</button>
            </div>
          </div>
        </details>

        <!-- Buscar/instalar do catálogo — agrupado num card próprio (2026-07-25): toggle+busca+
             filtros+tabela estavam soltos direto no fundo da página, sem borda, inconsistente com
             o resto (Download rápido, Catálogo etc. já são cards). -->
        <div class="ml-static-card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
            <div class="cat-selector" id="mr-modeToggle" style="margin-bottom:0;">
              <button type="button" class="cat-btn active" data-mode="installed">${t('ml_mode_installed')}</button>
              <button type="button" class="cat-btn" data-mode="cloud">${t('ml_mode_cloud')}</button>
            </div>
            <button class="btn btn-primary btn-sm" id="ml-syncBtn">${t('ml_ov_syncbtn')}</button>
          </div>
          <div class="model-registry-toolbar">
            <input type="text" class="form-input" id="mr-search" placeholder="${t('ml_search_placeholder')}" style="max-width:260px;">
            <div class="model-filter-chips" id="mr-filters">
              <span class="model-filter-label">🔎 ${t('ml_filter_label')}</span>
              ${Object.keys(capLabels).map(cap => `<div class="chip" data-cap="${cap}">${capLabels[cap]}</div>`).join('')}
            </div>
          </div>
          <div class="model-table-wrap">
            <table class="model-table">
              <thead>
                <tr><th>${t('ml_col_name')}</th><th>${t('ml_col_provider')}</th><th>${t('ml_col_capabilities')}</th><th>${t('ml_col_context')}</th><th>${t('ml_col_status')}</th></tr>
              </thead>
              <tbody id="mr-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ═══ Routing ═══ -->
      <div class="ml-panel" data-panel="routing">
        ${guideBox(t('ml_tab_routing_guide'))}
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
              ${categoryMeta.map((c, i) => `<button type="button" class="cat-btn${i === 0 ? ' active' : ''}" data-cat="${c.key}"><span>${c.icon} ${c.label}</span><span class="cat-btn-model" id="rt-catmodel-${c.key}">—</span></button>`).join('')}
            </div>

            <div class="rt-picker-header">
              <div class="rt-picker-info">
                <span class="overview-label">${t('ml_routing_current')}</span>
                <span class="rt-current-model" id="rt-currentModel">—</span>
              </div>
              <div class="rt-picker-info" id="rt-pendingWrap" style="display:none;">
                <span class="overview-label">${t('ml_routing_selected')}</span>
                <span class="rt-pending-model" id="rt-pendingModel">—</span>
              </div>
              <button class="btn btn-primary btn-sm" id="rt-applyBtn" disabled>${t('ml_routing_apply')}</button>
            </div>

            <div class="model-table-wrap">
              <table class="model-table">
                <thead>
                  <tr><th></th><th>${t('ml_col_name')}</th><th>${t('ml_col_provider')}</th><th>${t('ml_col_capabilities')}</th><th>${t('ml_col_context')}</th><th>${t('ml_col_status')}</th></tr>
                </thead>
                <tbody id="rt-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Modelo Padrão + Classificador (Model Router) — volta pra "Escolher Modelo" (2026-07-25):
             são config de roteamento ("modelo padrão" e motor do Model Router), não infraestrutura
             de provider. Provider Padrão em si (qual backend usar) continua em Provedores. -->
        <details class="cfg-details">
          <summary>${t('default_model_classifier_title')}</summary>
          <div class="cfg-details-body">
            <div id="ml-ollamaSection">
              <div class="form-group">
                <label class="form-label">${t('main_ollama_model_label')} <span class="badge badge-cloud">cloud</span></label>
                <div class="model-select-container" id="container-ollamaModel">
                  <input type="text" class="model-select-input" autocomplete="off" id="ollamaModel" placeholder="glm-5.2:cloud">
                  <svg class="msa" width="11" height="11" fill="#98a8c2" viewBox="0 0 16 16"><path d="M8 11L3 6h10z"/></svg>
                  <div class="model-dropdown" id="dropdown-ollamaModel"></div>
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
          </div>
        </details>

        <!-- Modelos Internos — movido de "Avançado" (2026-07-25): são configuração de modelo
             (GoalPlanner/RiskAnalyzer/ObserverValidator), não config técnica de sistema. Pertencem
             conceitualmente ao Model Router, junto com o resto do que já está nesta aba. -->
        <details class="cfg-details" id="ml-internalDetails" open>
          <summary>
            ${t('internal_models_title')}
            <span id="ml-internalBadge" style="display:none;margin-left:8px;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;background:rgba(255,160,0,.15);color:#f59e0b;border:1px solid rgba(255,160,0,.3);">⚠️ ${t('internal_unconfigured_badge')}</span>
          </summary>
          <div class="cfg-details-body">
            <div id="ml-internalWarning" style="display:none;margin-bottom:14px;padding:10px 14px;border-radius:8px;background:rgba(255,160,0,.08);border:1px solid rgba(255,160,0,.3);font-size:.82rem;line-height:1.5;color:var(--text-main);">
              ⚠️ <strong>${t('internal_warn_title')}</strong> ${t('internal_warn_body')}
            </div>
            <div class="form-hint" style="margin-bottom:14px;">${t('internal_models_hint')}</div>
            <div class="internal-comp-list">
              ${internalCompRow('ml-plannerModel',  '📋', 'GoalPlanner',       t('internal_planner_desc'),  'gemma4:31b-cloud')}
              ${internalCompRow('ml-riskModel',     '🛡️', 'RiskAnalyzer',      t('internal_risk_desc'),     'gemma4:31b-cloud')}
              ${internalCompRow('ml-observerModel', '🔬', 'ObserverValidator', t('internal_observer_desc'), 'qwen3.5:cloud')}
            </div>
          </div>
        </details>

      </div>

      <!-- ═══ Providers ═══ -->
      <div class="ml-panel" data-panel="providers">
        ${guideBox(t('ml_tab_providers_guide'))}
        <div class="provider-grid" id="ml-providerGrid"></div>

        <!-- Provider padrão — infraestrutura/conexão, fica em Provedores. Modelo Ollama Principal
             e Classificador voltaram pra "Escolher Modelo" (2026-07-25): são config de roteamento
             ("Modelo padrão" e "Model Router"), não de infraestrutura de provider. -->
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
            <div class="form-group">
              <label class="form-label">${t('vision_server_label')}</label>
              <input type="text" class="form-input" id="ml-visionServer" placeholder="http://localhost:11434" style="max-width:320px;">
            </div>
          </div>
        </details>

        <!-- Provider por perfil — relocado de "Escolher Modelo" (2026-07-25), mesmo motivo. -->
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

        <details class="cfg-details">
          <summary>${t('ml_add_provider_title')}</summary>
          <div class="cfg-details-body">
            <div class="chips" style="margin-bottom:10px;">
              ${CUSTOM_PROVIDER_PRESETS.map(p => `<div class="chip" data-preset="${p.label}" data-url="${p.baseUrl}">${p.label}</div>`).join('')}
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">${t('ml_col_name')}</label>
                <input type="text" class="form-input" id="ml-newProvLabel" placeholder="Ex: LM Studio">
              </div>
              <div class="form-group">
                <label class="form-label">${t('ml_provider_baseurl_label')}</label>
                <input type="text" class="form-input" id="ml-newProvUrl" placeholder="http://localhost:1234/v1">
              </div>
              <div class="form-group">
                <label class="form-label">${t('ml_provider_apikey_optional')}</label>
                <input type="password" class="form-input" id="ml-newProvKey" placeholder="${t('ml_optional_placeholder')}">
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="ml-addProvBtn">${t('ml_add_btn')}</button>
          </div>
        </details>
      </div>

      <!-- ═══ Advanced ═══ -->
      <div class="ml-panel" data-panel="advanced">
        ${guideBox(t('ml_tab_advanced_guide'))}
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

  // Pull chips — mesmo comportamento do "Instalar" do Registry (pullIntoRegistry): baixa e
  // ressincroniza o catálogo, sem sobrescrever silenciosamente o "Modelo Ollama Principal".
  container.querySelectorAll('.chip[data-pull]').forEach(chip => {
    chip.addEventListener('click', () => pullIntoRegistry(chip.dataset.pull));
  });
  el('ml-pullBtn').addEventListener('click', () => {
    const name = el('ml-customPull').value.trim();
    if (name) pullIntoRegistry(name);
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
    const tabWarn = el('ml-routingTabWarn');
    if (badge)   badge.style.display   = unconfigured ? 'inline' : 'none';
    if (warning) warning.style.display = unconfigured ? 'block'  : 'none';
    if (tabWarn) tabWarn.style.display = unconfigured ? 'inline' : 'none';
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
  const defaultModel = s.currentModel || s.ollamaModel || '';

  const el = id => document.getElementById(id);
  const providerLabel = PROV_LABELS[s.defaultProvider] || s.defaultProvider || '—';
  const statusText = ollamaOnline ? t('ml_ov_online') : (ollamaHealth?.error || t('ml_ov_offline'));
  el('ov-provider')     && (el('ov-provider').textContent = `${providerLabel} — ${statusText}`);
  el('ov-dot')          && (el('ov-dot').className = `dot ${ollamaOnline ? 'online' : 'offline'}`);
  el('ov-count')        && (el('ov-count').textContent = `${ollamaCount} ${t('ml_ov_available_suffix')}`);
  el('ov-defaultmodel') && (el('ov-defaultmodel').textContent = defaultModel || '—');

  // "Sistema pronto pra uso?" — agregado das 3 condições acima, é a resposta que a Visão Geral
  // deve dar (nunca uma ação); detalhe operacional (sync, catálogo) mora só em Instalar Modelo.
  const ready = ollamaOnline && ollamaCount > 0 && !!defaultModel;
  el('ov-ready') && (el('ov-ready').textContent = ready ? t('ml_ov_ready_yes') : t('ml_ov_ready_no'));

  updateCatalogCard();
}

/** Card "Catálogo de Modelos" (Instalar Modelo) — local canônico único pras métricas de catálogo
 * (contagem, última sincronização, origem, estado); Visão Geral só reflete prontidão agregada. */
function updateCatalogCard() {
  const cs = configStore;
  const s = cs.snap();
  const health = providersStore.get('health') || [];
  const ollamaHealth = health.find(h => h.provider === 'ollama');
  const ollamaOnline = providersStore.get('ollamaOnline');
  const ollamaCount  = providersStore.get('ollamaModelCount') || 0;
  const lastSync     = providersStore.get('lastSync');

  const el = id => document.getElementById(id);
  el('cat-count')      && (el('cat-count').textContent = `${ollamaCount} ${t('ml_ov_available_suffix')}`);
  el('cat-lastsync')   && (el('cat-lastsync').textContent = lastSync ? new Date(lastSync).toLocaleTimeString() : '—');
  el('cat-origin')     && (el('cat-origin').textContent = PROV_LABELS[s.defaultProvider] || s.defaultProvider || '—');
  el('cat-syncstatus') && (el('cat-syncstatus').textContent = ollamaOnline ? t('ml_ov_online') : (ollamaHealth?.error || t('ml_ov_offline')));
  el('cat-dot')        && (el('cat-dot').className = `dot ${ollamaOnline ? 'online' : 'offline'}`);
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
          <span>${ollamaOnline ? t('ollama_models_count', { n: ollamaCount }) : (ollamaHealth?.error || t('offline'))}</span>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('server_url_label') || 'Endpoint'}</label>
          <input type="text" class="form-input" id="pv-ollamaUrl" placeholder="http://localhost:11434" value="${esc(s.ollamaUrl || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('ml_apikey_cloud_label')}</label>
          <input type="password" class="form-input" id="pv-ollamaApiKey" placeholder="${t('ml_optional_placeholder')}">
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
            <span>${h ? (h.online ? t('ollama_models_count', { n: h.modelCount }) : t('offline')) : '—'}</span>
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:8px;word-break:break-all;">${esc(p.baseUrl)}</div>
        <button class="btn btn-ghost btn-sm btn-remove-key" data-remove-provider="${esc(p.label)}">${t('ml_remove_btn')}</button>
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
          <label class="form-label">${t('ml_apikey_label')}</label>
          <div class="api-key-group">
            <input type="password" class="form-input" id="pv-${cp.key}Key" placeholder="${cp.placeholder}">
            <span class="api-key-status">${hasKey ? '✓ OK' : t('key_missing')}</span>
            <button class="btn btn-ghost btn-sm btn-remove-key" data-remove-key="${cp.key}" style="${hasKey ? '' : 'display:none'}" title="${t('ml_remove_btn')}">✕</button>
          </div>
        </div>
      </div>`);
  }

  grid.innerHTML = cards.join('');
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
    ollamaEl.querySelector('span:last-child').textContent = ollamaOnline ? t('ollama_models_count', { n: ollamaCount }) : (ollamaHealth?.error || t('offline'));
  }

  for (const [label, h] of Object.entries(healthByProvider)) {
    if (label === 'ollama') continue;
    const elHealth = document.querySelector(`[data-health="${CSS.escape(label)}"]`);
    if (!elHealth) continue;
    elHealth.querySelector('.dot').className = `dot ${h.online ? 'online' : 'offline'}`;
    elHealth.querySelector('span:last-child').textContent = h.online ? t('ollama_models_count', { n: h.modelCount }) : t('offline');
  }
}

function wireProviderOverview() {
  const cs = configStore;
  const el = id => document.getElementById(id);

  el('ml-syncBtn')?.addEventListener('click', async () => {
    showToast(t('ml_syncing_toast'), 'success');
    await loadProviders(true);
    showToast(t('ml_synced_toast'), 'success');
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
      if (!confirm(t('ml_remove_key_confirm', { provider: removeKey }))) return;
      try {
        const f = window.newclawFetch || fetch;
        const res = await f(`/api/providers/key/${removeKey}`, { method: 'DELETE' });
        if ((await res.json()).success) {
          const hasKey = `has${removeKey.charAt(0).toUpperCase() + removeKey.slice(1)}Key`;
          cs.set(hasKey, false);
          showToast(t('ml_key_removed_toast', { provider: removeKey }), 'success');
          renderProviderGrid();
        }
      } catch (err) { showToast('❌ ' + err.message, 'error'); }
      return;
    }
    const removeProvider = e.target.closest('[data-remove-provider]')?.dataset.removeProvider;
    if (removeProvider) {
      if (!confirm(t('ml_remove_provider_confirm', { label: removeProvider }))) return;
      try {
        await removeCustomProvider(removeProvider);
        cs.set('customProviders', (cs.get('customProviders') || []).filter(p => p.label !== removeProvider));
        showToast(t('ml_provider_removed_toast', { label: removeProvider }), 'success');
      } catch (err) { showToast('❌ ' + err.message, 'error'); }
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
    if (!label || !baseUrl) { showToast(t('ml_provider_fill_required'), 'error'); return; }
    try {
      await addCustomProvider({ label, baseUrl, apiKey: apiKey || undefined });
      cs.set('customProviders', [...(cs.get('customProviders') || []), { label, baseUrl, hasKey: !!apiKey }]);
      showToast(t('ml_provider_added_toast', { label }), 'success');
      document.getElementById('ml-newProvLabel').value = '';
      document.getElementById('ml-newProvUrl').value   = '';
      document.getElementById('ml-newProvKey').value   = '';
    } catch (err) { showToast('Erro: ' + err.message, 'error'); }
  });
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
    return `<tr><td colspan="${selectable ? 6 : 5}" class="empty" style="padding:20px;color:var(--text-soft);">${t('ml_none_found')}</td></tr>`;
  }
  const capLabels = getCapabilityLabels();
  return models.map(m => {
    const isCurrent = !!currentId && m.id === currentId;
    const isSelected = selectable && !!selectedId && m.id === selectedId;
    const rowClass = [selectable ? 'model-row-selectable' : '', isCurrent ? 'model-row-current' : ''].filter(Boolean).join(' ');
    // Ação/status sempre na ÚLTIMA coluna — é o que o usuário mais precisa clicar (instalar/
    // selecionar), fica mais fácil de achar no final da linha em vez de no meio da tabela.
    const lastCell = installedIds
      ? (installedIds.has(m.id)
          ? `<span class="model-installed-badge">${t('ml_installed_badge')}</span>`
          : `<button type="button" class="btn btn-primary btn-sm" data-activate-cloud="${esc(m.id)}">${t('ml_install_btn')}</button>`)
      : `<span class="dot online" style="display:inline-block;"></span> ${t('ml_available_status')}`;
    return `
    <tr class="${rowClass}" data-model-id="${esc(m.id)}">
      ${selectable ? `<td class="model-radio-cell">${isSelected ? '🔘' : '⚪'}</td>` : ''}
      <td class="model-table-id">${esc(m.id)}${isCurrent ? ` <span class="model-current-badge">${t('ml_current_badge')}</span>` : ''}</td>
      <td><span class="badge badge-${m.provider === 'ollama' ? 'local' : 'cloud'}">${esc(m.provider)}</span></td>
      <td>${(m.capabilities || []).map(c => `<span class="model-cap-tag">${capLabels[c] || c}</span>`).join(' ')}</td>
      <td>${esc(formatContextWindow(m.contextWindow))}</td>
      <td>${lastCell}</td>
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
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">${t('ml_cloud_loading')}</td></tr>`;
      cloudCatalog = await getCloudCatalog();
      if (registryMode !== 'cloud') return; // usuário trocou de modo enquanto o fetch rodava
    }
    const filtered = filterCatalog(cloudCatalog);
    if (filtered.length === 0) {
      const term = registrySearch.trim();
      // Nada no catálogo dos ~18 modelos cloud conhecidos bate com a busca — ainda assim pode ser
      // um modelo real (custom/privado) que só não está nessa lista. Em vez de um campo de "puxar"
      // separado (confundia com a busca), a própria busca sem resultado já oferece essa saída.
      const fallback = (cloudCatalog.length > 0 && term)
        ? `<div style="margin-top:10px;">${t('ml_not_found_hint', { term: esc(term) })} <button type="button" class="btn btn-ghost btn-sm" data-pull-term="${esc(term)}">${t('ml_try_pull_btn', { term: esc(term) })}</button></div>`
        : '';
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">
        ${cloudCatalog.length === 0 ? t('ml_cloud_unavailable') : t('ml_no_match_term', { term: esc(term) })}
        ${fallback}
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
      ${catalog.length === 0 ? t('ml_no_models_yet') : t('ml_no_match_filter')}
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
    const activateBtn = e.target.closest('[data-activate-cloud]');
    if (activateBtn) {
      const name = activateBtn.dataset.activateCloud;
      activateBtn.disabled = true;
      activateBtn.textContent = t('ml_installing_btn');
      await pullIntoRegistry(name); // já ressincroniza o catálogo local (loadProviders(true))
      renderModelTable(); // badge "Instalado" substitui o botão automaticamente
      return;
    }
    // Fallback: nada no catálogo cloud bateu com a busca, mas o usuário quer tentar o termo
    // digitado mesmo assim (ex: nome custom/privado que não está entre os ~18 conhecidos).
    const fallbackBtn = e.target.closest('[data-pull-term]');
    if (fallbackBtn) {
      const term = fallbackBtn.dataset.pullTerm;
      fallbackBtn.disabled = true;
      fallbackBtn.textContent = t('ml_trying_btn');
      await pullIntoRegistry(term);
      renderModelTable();
    }
  });
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
  if (curEl) curEl.textContent = currentModel || t('ml_routing_notconfigured');

  // Modelo atribuído visível em cada botão de categoria — o slot se explica sem precisar clicar.
  ['chat','code','vision','light','analysis','execution'].forEach(cat => {
    const sub = document.getElementById(`rt-catmodel-${cat}`);
    if (sub) sub.textContent = r[cat] || '—';
  });

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

  document.getElementById('rt-applyBtn')?.addEventListener('click', async e => {
    if (!routingPendingModel) return;
    const cs = configStore;
    const mr = { ...cs.get('modelRouter') };
    mr[routingSelectedCategory] = routingPendingModel;
    cs.set('modelRouter', mr);
    // Aplicar grava direto em disco (mesmo caminho do botão Salvar global) — clicar Aplicar e
    // precisar clicar num Salvar separado depois, em outro lugar da página, pra essa mudança
    // não se perder era o comportamento reportado como confuso (2026-07-25).
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await doSave();
    } finally {
      btn.disabled = false;
    }
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

/** Caixa de ajuda passo a passo no topo de cada aba — usuário leigo entende o que fazer ali
 * antes de ver a UI técnica embaixo. Um único ponto de estilo pras 5 abas (Overview/Registry/
 * Routing/Providers/Advanced), via classe dedicada em config.css (.ml-guide-box) — sem
 * max-width próprio, então ocupa a mesma largura da tabela/barra de busca abaixo dela. */
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

/** Lista vertical em vez de cards de grid (2026-07-25): descrições mais longas ficam legíveis em
 * largura total, e escala melhor se mais componentes internos forem adicionados no futuro — basta
 * uma linha nova, sem depender de reflow de grid. */
function internalCompRow(id, icon, name, desc, placeholder) {
  return `
    <div class="internal-comp-row">
      <div class="internal-comp-info">
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
      statusEl.title = t('ml_status_cloud');
    } else if (available.has(model)) {
      statusEl.className = 'dot online';
      statusEl.title = t('ml_status_local_ok');
    } else {
      statusEl.className = 'dot dot-missing';
      statusEl.title = t('ml_status_missing');
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

/**
 * Caminho único de download de modelo nesta view (Registry "Instalar", chips e Pull custom do
 * Routing): registra o modelo no Ollama e ressincroniza o catálogo. Nunca troca o "Modelo Ollama
 * Principal" nem nenhuma categoria — instalar amplia o catálogo; usar é decisão explícita do
 * usuário no Roteamento (o toast aponta esse próximo passo).
 */
async function pullIntoRegistry(name) {
  if (!name?.trim()) return;
  name = name.trim();
  showToast(t('ml_pulling_toast', { model: name }), 'success');
  try {
    const data = await pullOllamaModel(name);
    if (data.success) {
      showToast(t('ml_pull_registered_toast', { model: name }), 'success');
      await loadProviders(true);
    } else {
      showToast('❌ ' + (data.error || 'error'), 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}
