import { configStore, providersStore } from '../state.js';
import { showToast } from '../components/Toast.js';
import { initDropdowns, updateDropdownModels } from '../components/ModelDropdown.js';
import { addCustomProvider, removeCustomProvider, editCustomProvider, getCloudCatalog, testCustomProvider, getLocalModels, serveLocalModel, stopLocalModel } from '../api.js';
import { loadProviders, doSave, guideBox } from '../app.js';

// Funções (não const) porque t() precisa ser avaliado a cada render() — se fossem consts de
// módulo, ficariam presas no idioma ativo no momento em que o arquivo foi importado pela primeira
// vez e nunca atualizariam depois de uma troca de idioma (mesma classe de bug do header — ver
// newclawSetLang() em shared.js).
/**
 * As 6 categorias de tarefa MAIS os 3 componentes internos, na mesma lista — porque para quem usa
 * são a mesma decisão: "qual modelo cuida disto?". A diferença é só onde a chave é gravada
 * (`chat` vs `plannerModel`), detalhe de implementação que não deveria vazar para a tela.
 *
 * Antes os 3 internos eram campos de TEXTO LIVRE: o usuário tinha que digitar o nome exato do
 * modelo, com tag e tudo (`gemma-4-12B-it-Q4_K_M.gguf`), enquanto as outras 6 se escolhiam
 * clicando numa tabela. Um erro de digitação virava um 404 em runtime, sem aviso na tela — e para
 * um usuário leigo simplesmente não havia como acertar (relatado em 02/08/2026).
 */
function getCategoryMeta() {
  return [
    { key: 'chat',      icon: '💬', label: 'Chat' },
    { key: 'code',      icon: '💻', label: t('route_code_cat') },
    { key: 'vision',    icon: '👁️', label: t('route_vision_cat') },
    { key: 'light',     icon: '⚡', label: t('route_light_cat') },
    { key: 'analysis',  icon: '📊', label: t('route_analysis_cat') },
    { key: 'execution', icon: '🧠', label: t('route_execution_cat') },
    { key: 'classifierModel', icon: '🔎', label: t('classifier_model_label'), internal: true, desc: t('ml_classifier_desc') },
    { key: 'plannerModel',  icon: '📋', label: 'GoalPlanner',       internal: true, desc: t('internal_planner_desc') },
    { key: 'riskModel',     icon: '🛡️', label: 'RiskAnalyzer',      internal: true, desc: t('internal_risk_desc') },
    { key: 'observerModel', icon: '🔬', label: 'ObserverValidator', internal: true, desc: t('internal_observer_desc') },
  ];
}

/** Chaves dos componentes internos — usadas para distinguir o que é categoria de tarefa (que tem
 *  `provider_<cat>` próprio) do que é componente interno (que não tem). */
const INTERNAL_KEYS = ['classifierModel', 'plannerModel', 'riskModel', 'observerModel'];

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
  // Componentes internos: mesma exigência mínima de 'code' e pelo mesmo motivo — não existe
  // "modelo tecnicamente incapaz de planejar ou avaliar risco", só modelos melhores ou piores
  // nisso. Filtrar por tool_calling aqui esconderia modelos perfeitamente utilizáveis.
  plannerModel: 'chat', riskModel: 'chat', observerModel: 'chat', classifierModel: 'chat',
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

/** Label do provider criado automaticamente ao carregar um modelo local pelo dashboard. Fixo de
 *  propósito: carregar outro modelo depois reaponta ESTE provider em vez de acumular um por
 *  modelo já carregado alguma vez. */
const LOCAL_PROVIDER_LABEL = 'Modelo local';

const CUSTOM_PROVIDER_PRESETS = [
  { label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1' },
  { label: 'LM Studio',  baseUrl: 'http://localhost:1234/v1' },
  { label: 'vLLM',       baseUrl: 'http://localhost:8000/v1' },
  { label: 'llamafile',  baseUrl: 'http://localhost:8080/v1' },
];

function getCapabilityLabels() {
  return {
    chat: t('ml_cap_chat'), vision: t('ml_cap_vision'), embedding: t('ml_cap_embedding'),
    reasoning: t('ml_cap_reasoning'), code: t('ml_cap_code'), tool_calling: t('ml_cap_toolcalling'),
  };
}

/**
 * Quatro abas, não cinco. "Visão Geral" era uma aba inteira para 4 linhas de status e um guia —
 * respondia "o sistema está pronto?", pergunta que faz mais sentido respondida NO LUGAR onde o
 * usuário age (escolher o modelo) do que numa parada separada antes dele. O conteúdo não foi
 * removido: virou a faixa de status no topo de "Escolher Modelo", que passa a ser a primeira aba
 * — é o que a maioria das pessoas vem fazer aqui (2026-08-02).
 */
function getTabs() {
  // Ordem = a sequência de dependência real, a mesma que o guia de primeira vez já numerava:
  // é preciso ter um provedor para ter modelos, e ter modelos para poder escolher um. Antes as
  // abas estavam noutra ordem e a tela contradizia o próprio texto de ajuda (2026-08-02).
  return [
    { id: 'providers', icon: '🔌', label: t('ml_tab_providers') },
    { id: 'registry',  icon: '📚', label: t('ml_tab_registry') },
    { id: 'routing',   icon: '🧭', label: t('ml_tab_routing') },
    { id: 'advanced',  icon: '⚙️', label: t('ml_tab_advanced') },
  ];
}

// Estado local do filtro do Model Registry — reiniciado a cada render() (troca de página).
let registrySearch = '';
let registryFilters = new Set();

// Estado local do seletor de categoria em Routing — idem.
let routingSelectedCategory = 'chat';
let routingPendingModel = null;
// Provider do modelo pendente — anda junto com routingPendingModel porque a escolha é o PAR
// (modelo, provider): o mesmo nome de modelo pode existir em endpoints diferentes.
let routingPendingProvider = '';

// Estado local do toggle Instalados/Cloud no Registry — idem. cloudCatalog é lazy (só busca no
// remoto quando o usuário troca pro modo cloud, não no carregamento da página).
let registryMode = 'installed';
let cloudCatalog = null;

// Modelos em disco — mesmo padrão lazy do cloudCatalog: só varre a pasta quando o usuário entra
// no modo Local. `localConfigured` distingue "nenhuma pasta informada" (estado inicial normal,
// nada de errado) de "pasta informada mas vazia/ilegível" — mensagens diferentes.
let localCatalog = null;
let localConfigured = false;
let localError = '';
// Executável de servidor achado na pasta (null = não há, e a UI precisa DIZER isso em vez de
// deixar o usuário sem entender por que não consegue usar um modelo que está ali listado) e
// modelo carregado por este dashboard agora.
let localServerBinary = null;
let localRunning = null;

// Label do provider custom sendo editado no momento (null = formulário em modo "adicionar
// novo"). Achado real (2026-07-31): sem edição, corrigir uma URL digitada errada ou trocar o
// modelo exigia apagar o card inteiro e recriar do zero — e não havia como desfazer uma adição
// feita sem querer (ex.: clique duplo) a não ser apagando.
let editingProviderLabel = null;

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

      <!-- Faixa de status — ACIMA das abas, de propósito: responde "está tudo certo?" em qualquer
           aba, sem gastar uma aba inteira nem obrigar a navegar até ela. Era a antiga "Visão
           Geral", que só informava e por isso quase ninguém abria; informação que vale sempre
           deve estar sempre visível, não atrás de um clique (2026-08-02). -->
      <div class="overview-card ml-statusbar">
        <div class="overview-row"><span class="overview-label">${t('ml_ov_provider')}</span><span class="overview-value"><span class="dot" id="ov-dot"></span> <span id="ov-provider">—</span></span></div>
        <div class="overview-row"><span class="overview-label">${t('ml_ov_models')}</span><span class="overview-value" id="ov-count">—</span></div>
        <div class="overview-row"><span class="overview-label">${t('ml_ov_defaultmodel')}</span><span class="overview-value" id="ov-defaultmodel">—</span></div>
        <div class="overview-row"><span class="overview-label">${t('ml_ov_ready')}</span><span class="overview-value" id="ov-ready">—</span></div>
      </div>
      <div id="ov-coherence" style="display:none;margin-bottom:14px;"></div>
      <!-- "Seu modelo local não está carregado" + ação. Ver checkLocalModelDown(). -->
      <div id="ov-localdown" style="display:none;margin-bottom:14px;"></div>

      <div class="ml-tabs" id="ml-tabs">
        ${tabs.map((tab, i) => `<button type="button" class="ml-tab${i === 0 ? ' active' : ''}" data-tab="${tab.id}">${tab.icon} ${tab.label}${tab.id === 'routing' ? ' <span id="ml-routingTabWarn" style="display:none;">⚠️</span>' : ''}</button>`).join('')}
      </div>

      <!-- ═══ Registry ═══ -->
      <div class="ml-panel" data-panel="registry">
        ${guideBox(t('ml_tab_registry_guide'))}

        <!-- Buscar/instalar do catálogo — agrupado num card próprio (2026-07-25): toggle+busca+
             filtros+tabela estavam soltos direto no fundo da página, sem borda, inconsistente com
             o resto (Download rápido, Catálogo etc. já são cards).
             PROMOVIDO AO TOPO DA ABA (2026-08-02): o seletor Instalados/Nuvem/Meus arquivos vinha
             depois do card de métricas e do "Download rápido", e em 1280x900 nascia FORA da tela —
             quem tinha modelos no próprio computador não descobria a opção sem rolar a página
             (relatado pelo usuário: "não encontrei aonde colocar o caminho"). A escolha da origem
             é a primeira decisão desta aba, então é o primeiro elemento dela. -->
        <div class="ml-static-card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
            <!-- Terceiro modo, irmão de Instalados/Cloud: arquivos de modelo que o usuário já tem
                 no disco. Mesma tabela, mesma busca, mesmos filtros de capacidade — o modo só troca
                 a ORIGEM da lista, exatamente como o modo Cloud já fazia. -->
            <div class="cat-selector" id="mr-modeToggle" style="margin-bottom:0;">
              <button type="button" class="cat-btn active" data-mode="installed">${t('ml_mode_installed')}</button>
              <button type="button" class="cat-btn" data-mode="cloud">${t('ml_mode_cloud')}</button>
              <button type="button" class="cat-btn" data-mode="local">${t('ml_mode_local')}</button>
            </div>
            <button class="btn btn-primary btn-sm" id="ml-syncBtn">${t('ml_ov_syncbtn')}</button>
          </div>
          <!-- Pasta de modelos locais — sem valor padrão no código de propósito: cada sistema
               operacional (e cada usuário) guarda seus modelos em um lugar diferente, e um caminho
               embutido só funcionaria na máquina de quem o escreveu. -->
          <div id="mr-localDirRow" style="display:none;margin-bottom:14px;">
            <label class="form-label">${t('ml_local_dir_label')}</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <input type="text" class="form-input" id="mr-localDir" placeholder="${t('ml_local_dir_placeholder')}" style="flex:1;min-width:220px;">
              <button class="btn btn-primary btn-sm" id="mr-localScanBtn">${t('ml_local_scan_btn')}</button>
            </div>
            <div class="form-hint" style="margin-top:6px;">${t('ml_local_dir_hint')}</div>
            <!-- Explica o estado atual e o próximo passo. Ver updateLocalExplainer(). -->
            <div id="mr-localExplain" style="display:none;margin-top:12px;"></div>
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

        <!-- Download rápido (Ollama) — desceu para depois da tabela (2026-08-02): é um atalho de
             conveniência para 5 modelos populares, não a ação principal da aba; ocupava o topo e
             empurrava a escolha da origem para fora da tela. -->
        <details class="cfg-details">
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

        <!-- Catálogo de Modelos — local canônico único das métricas de catálogo (2026-07-25).
             Também desceu: é informação de acompanhamento, não o começo do fluxo. -->
        <details class="cfg-details">
          <summary>${t('ml_cat_count')}</summary>
          <div class="cfg-details-body">
            <div class="overview-card">
              <div class="overview-row"><span class="overview-label">${t('ml_cat_count')}</span><span class="overview-value" id="cat-count">—</span></div>
              <div class="overview-row"><span class="overview-label">${t('ml_cat_lastsync')}</span><span class="overview-value" id="cat-lastsync">—</span></div>
              <div class="overview-row"><span class="overview-label">${t('ml_cat_origin')}</span><span class="overview-value" id="cat-origin">—</span></div>
              <div class="overview-row"><span class="overview-label">${t('ml_cat_syncstatus')}</span><span class="overview-value"><span class="dot" id="cat-dot"></span> <span id="cat-syncstatus">—</span></span></div>
            </div>
          </div>
        </details>
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
            <!-- Dois grupos, um mecanismo só: tarefas do dia a dia e componentes internos do
                 agente. Separados por rótulo para não misturar conceitos, mas escolhidos
                 exatamente do mesmo jeito — clicando na tabela abaixo. -->
            <div class="cat-group-label">${t('ml_cat_group_tasks')}</div>
            <div class="cat-selector" id="rt-catSelector">
              ${categoryMeta.filter(c => !c.internal).map((c, i) => `<button type="button" class="cat-btn${i === 0 ? ' active' : ''}" data-cat="${c.key}"><span>${c.icon} ${c.label}</span><span class="cat-btn-model" id="rt-catmodel-${c.key}">—</span></button>`).join('')}
            </div>
            <div class="cat-group-label">${t('ml_cat_group_internal')} <span id="ml-internalBadge" style="display:none;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;background:rgba(255,160,0,.15);color:#f59e0b;border:1px solid rgba(255,160,0,.3);">⚠️ ${t('internal_unconfigured_badge')}</span></div>
            <div class="cat-selector" id="rt-catSelectorInternal">
              ${categoryMeta.filter(c => c.internal).map(c => `<button type="button" class="cat-btn" data-cat="${c.key}"><span>${c.icon} ${c.label}</span><span class="cat-btn-model" id="rt-catmodel-${c.key}">—</span></button>`).join('')}
            </div>
            <div class="form-hint" id="rt-catDesc" style="margin:8px 0 4px;"></div>

            <div class="rt-picker-header">
              <div class="rt-picker-info">
                <span class="overview-label">${t('ml_routing_current')}</span>
                <span class="rt-current-model" id="rt-currentModel">—</span>
              </div>
              <div class="rt-picker-info" id="rt-pendingWrap" style="display:none;">
                <span class="overview-label">${t('ml_routing_selected')}</span>
                <span class="rt-pending-model" id="rt-pendingModel">—</span>
              </div>
              <!-- Atalho de configuração inicial: um modelo bom o bastante para tudo, e só depois
                   troca-se o que precisa ser diferente (tipicamente Visão). Sem ele, uma
                   instalação nova exige 10 seleções em sequência antes de o sistema ficar
                   utilizável — pedido do usuário em 02/08/2026, e é o caminho que a maioria
                   percorre: começar simples, ajustar um caso depois. -->
              <button class="btn btn-ghost btn-sm" id="rt-applyAllBtn" disabled>${t('ml_routing_apply_all')}</button>
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
            <!-- O MODELO do classificador saiu daqui (2026-08-02): virou mais um slot no seletor
                 acima, escolhido por clique como todos os outros. Só o ENDEREÇO continua aqui —
                 é uma URL, não um modelo, e não faz sentido escolher numa lista de modelos. -->
            <div class="form-group">
              <label class="form-label">${t('classifier_server_label')}</label>
              <input type="text" class="form-input" id="ml-classifierServer" placeholder="http://localhost:11434" style="max-width:320px;">
            </div>
          </div>
        </details>

        <!-- Os campos de texto livre dos Modelos Internos foram REMOVIDOS (2026-08-02): os três
             agora são escolhidos no mesmo seletor das categorias, clicando na tabela. Manter os
             dois caminhos deixaria duas fontes de verdade na mesma tela para o mesmo valor. -->
        <div id="ml-internalWarning" style="display:none;margin-top:14px;padding:10px 14px;border-radius:8px;background:rgba(255,160,0,.08);border:1px solid rgba(255,160,0,.3);font-size:.82rem;line-height:1.5;color:var(--text-main);">
          ⚠️ <strong>${t('internal_warn_title')}</strong> ${t('internal_warn_body')}
        </div>
      </div>

      <!-- ═══ Providers (primeira aba: é o passo 1 do fluxo) ═══ -->
      <div class="ml-panel active" data-panel="providers">
        <!-- Guia de primeira vez fica aqui, no começo do caminho que ele mesmo descreve. -->
        ${guideBox(t('ml_ov_guide'))}
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

        <details class="cfg-details" id="ml-addProvDetails">
          <summary id="ml-addProvSummary">${t('ml_add_provider_title')}</summary>
          <div class="cfg-details-body">
            <div class="chips" style="margin-bottom:10px;" id="ml-addProvPresets">
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
              <div class="form-group">
                <label class="form-label">${t('ml_provider_model_optional')}</label>
                <input type="text" class="form-input" id="ml-newProvModel" placeholder="${t('ml_optional_placeholder')}">
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" id="ml-testProvBtn">${t('ml_provider_test_btn')}</button>
              <button class="btn btn-primary btn-sm" id="ml-addProvBtn">${t('ml_add_btn')}</button>
              <button class="btn btn-ghost btn-sm" id="ml-cancelEditProvBtn" style="display:none;">${t('ml_cancel_btn')}</button>
            </div>
            <!-- Resultado do teste de conexão — some a cada nova tentativa e reaparece com o
                 veredito. Lista os modelos que o endpoint expõe: em servidor de modelo único
                 (llamafile) é assim que o usuário descobre o id aceito, sem adivinhar. -->
            <div id="ml-testProvResult" style="display:none;margin-top:12px;"></div>
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
  populateDefaultProviderOptions(s.customProviders || []); // ANTES de setar .value — senão um
  // customProvider salvo como defaultProvider (ex.: llamafile local) não existiria ainda como
  // <option> e o browser ignoraria silenciosamente a atribuição, voltando pro primeiro item.
  el('ml-defaultProvider').value  = s.defaultProvider || 'ollama';
  el('ollamaModel').value         = s.ollamaModel || '';
  el('mr-localDir')  && (el('mr-localDir').value = s.localModelsDir || '');
  el('ml-classifierServer').value = r.classifierServer || '';
  el('ml-visionServer').value     = r.visionServer     || '';
  // plannerModel/riskModel/observerModel não têm mais input próprio — são escolhidos no seletor
  // de categorias, e renderCategoryPicker() já mostra o valor atual em cada botão.

  toggleOllamaSection(s.defaultProvider);
  updatePipeline(r);
  updateEffectiveConfig(r, s.defaultProvider);
  updateProviderHints(s.defaultProvider);
  updateModelStatus(providersStore.get('models') || [], r);
  checkInternalModels();

  // Provider select
  el('ml-defaultProvider').addEventListener('change', e => {
    applyDefaultProviderChange(e.target.value);
  });

  // Ollama main model
  el('ollamaModel').addEventListener('input', e => { cs.set('ollamaModel', e.target.value); updateOverview(); });

  // O modelo do classificador não tem mais campo próprio — é o slot 🔎 do seletor de categorias.

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
    populateDefaultProviderOptions(s.customProviders || [], r[`provider_${cat}`] || '', sel);
    sel.value = r[`provider_${cat}`] || '';
    sel.addEventListener('change', e => {
      const mr = { ...cs.get('modelRouter') };
      // '' e não undefined — ver o comentário no botão Aplicar: escolher "— herdar padrão —" aqui
      // precisa APAGAR o override no servidor, e uma chave undefined some no JSON.stringify.
      mr[`provider_${cat}`] = e.target.value || '';
      cs.set('modelRouter', mr);
      updateProviderHints(cs.get('defaultProvider'));
    });
  });

  // Os componentes internos não têm mais listener de digitação: são escolhidos pelo seletor de
  // categorias (wireCategoryPicker), que já grava em modelRouter e persiste no Aplicar.

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
  const ddIds = ['ollamaModel'];
  updateDropdownModels(providersStore.get('models') || []);
  initDropdowns(ddIds);

  // ── Tabs ─────────────────────────────────────────────────────
  wireTabs(container);

  // ── Overview + Provider grid + Model Registry table ──────────
  registrySearch = '';
  registryFilters = new Set();
  registryMode = 'installed';
  cloudCatalog = null;
  localCatalog = null;
  localConfigured = false;
  localError = '';
  routingSelectedCategory = 'chat';
  routingPendingModel = null;
  routingPendingProvider = '';
  editingProviderLabel = null;

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
    // Os componentes internos agora são escolhidos pelo mesmo seletor, então o aviso de
    // "não configurado" precisa sumir assim que o usuário escolhe um — antes ele dependia do
    // evento de digitação dos campos de texto, que não existem mais.
    checkInternalModels();
    // O aviso de configuração inconsistente depende de modelo+provedor: precisa reavaliar assim
    // que qualquer um dos dois muda, não só no polling de saúde (senão o usuário troca um modelo
    // e o aviso só aparece — ou some — segundos depois, parecendo aleatório).
    checkConfigCoherence();
  });
  const unsubCustomProviders = cs.on('customProviders', custom => {
    renderProviderGrid();
    populateDefaultProviderOptions(custom || [], el('ml-defaultProvider')?.value);
  });

  // "Carregar agora" do aviso de modelo local fora do ar. Delegação no container porque o bloco é
  // recriado a cada atualização de status.
  document.getElementById('ov-localdown')?.addEventListener('click', async e => {
    const file = e.target.closest('[data-reload-local]')?.dataset.reloadLocal;
    if (!file) return;
    const btn = e.target.closest('[data-reload-local]');
    btn.disabled = true;
    const started = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      btn.textContent = `${t('ml_local_serving')} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      await serveLocalModel(file);
      clearInterval(timer);
      showToast(t('ml_local_served_toast', { model: file }), 'success');
      await loadProviders(true);
    } catch (err) {
      clearInterval(timer);
      showToast('❌ ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = t('ml_local_down_btn');
    }
  });

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
    const tabWarn = el('ml-routingTabWarn');
    if (badge)   badge.style.display   = unconfigured ? 'inline' : 'none';
    if (warning) warning.style.display = unconfigured ? 'block'  : 'none';
    if (tabWarn) tabWarn.style.display = unconfigured ? 'inline' : 'none';
    // Não há mais <details> para abrir: os componentes internos estão sempre visíveis no seletor.
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

/**
 * Saúde do provider que está de fato em uso (o padrão), seja ele o Ollama ou um endpoint
 * OpenAI-Compatible. Antes a Visão Geral rotulava com o nome do provider padrão mas reportava
 * SEMPRE o estado do Ollama — quem usa outro provider via "Provedor: llamafile — Offline" com o
 * llamafile perfeitamente no ar, e "Sistema pronto: ⚠️ Não" sem nada de errado. ModelRegistryService
 * já publica health de todo provider descoberto (nativo e custom); é só perguntar ao certo.
 */
function activeProviderHealth() {
  const s = configStore.snap();
  const prov = s.defaultProvider || 'ollama';
  const health = providersStore.get('health') || [];
  const entry = health.find(h => h.provider === prov);
  if (prov === 'ollama' || !entry) {
    // Ollama tem contadores próprios já mantidos pelo polling; sem entrada de health (provider
    // de nuvem por API key, que não expõe /models) cai no mesmo caminho de antes.
    return {
      provider: prov,
      online: !!providersStore.get('ollamaOnline'),
      count: providersStore.get('ollamaModelCount') || 0,
      error: health.find(h => h.provider === 'ollama')?.error,
    };
  }
  return { provider: prov, online: !!entry.online, count: entry.modelCount || 0, error: entry.error };
}

function updateOverview() {
  const cs = configStore;
  const s = cs.snap();
  const h = activeProviderHealth();
  // O modelo roteado para conversa é o que o sistema de fato usa quando o usuário fala com ele —
  // e é sempre escolha explícita dele. Vem antes de currentModel porque este último, num provider
  // de modelo único, é o placeholder 'default' (o servidor ignora o campo e serve o que carregou):
  // exibir "Modelo padrão: default" não informa nada. Sem adivinhar nada: se nenhum dos dois
  // estiver definido, continua '—'.
  const r = cs.get('modelRouter') || {};
  const defaultModel = r.chat || s.currentModel || s.ollamaModel || '';

  const el = id => document.getElementById(id);
  const providerLabel = PROV_LABELS[s.defaultProvider] || s.defaultProvider || '—';
  const statusText = h.online ? t('ml_ov_online') : (h.error || t('ml_ov_offline'));
  el('ov-provider')     && (el('ov-provider').textContent = `${providerLabel} — ${statusText}`);
  el('ov-dot')          && (el('ov-dot').className = `dot ${h.online ? 'online' : 'offline'}`);
  el('ov-count')        && (el('ov-count').textContent = `${h.count} ${t('ml_ov_available_suffix')}`);
  el('ov-defaultmodel') && (el('ov-defaultmodel').textContent = defaultModel || '—');

  // "Sistema pronto pra uso?" — agregado das 3 condições acima, é a resposta que a Visão Geral
  // deve dar (nunca uma ação); detalhe operacional (sync, catálogo) mora só em Instalar Modelo.
  const ready = h.online && h.count > 0 && !!defaultModel;
  el('ov-ready') && (el('ov-ready').textContent = ready ? t('ml_ov_ready_yes') : t('ml_ov_ready_no'));

  checkConfigCoherence();
  checkLocalModelDown();
  updateCatalogCard();
}

/**
 * Avisa quando o provedor em uso é um endpoint local que não está respondendo, mas o dashboard
 * sabe qual modelo estava carregado — o cenário de "reiniciei o computador".
 *
 * Não religa sozinho de propósito: o servidor local ocupa a GPU, e quem reiniciou a máquina pode
 * estar querendo usá-la para outra coisa (jogar, renderizar). Subir um modelo de vários GB sem
 * ninguém pedir seria tomar um recurso caro por conta própria. Então: informa, explica e oferece
 * o botão — a decisão continua sendo de quem está na frente da máquina.
 */
function checkLocalModelDown() {
  const box = document.getElementById('ov-localdown');
  if (!box) return;
  const cs = configStore;
  const prov = cs.get('defaultProvider') || 'ollama';
  const isCustom = (cs.get('customProviders') || []).some(p => p.label === prov);
  const last = providersStore.get('lastKnownLocalModel');
  const health = (providersStore.get('health') || []).find(h => h.provider === prov);

  // Só quando as três coisas batem: o provedor em uso é local, ele não respondeu ao discovery, e
  // existe um modelo conhecido para oferecer. Sem qualquer uma delas não há o que dizer.
  if (!isCustom || !last || (health && health.online)) { box.style.display = 'none'; return; }

  box.style.display = '';
  box.className = 'ml-test-result ml-test-fail';
  box.innerHTML = `
    <div class="ml-test-title">${t('ml_local_down_title', { model: esc(last.file) })}</div>
    <div class="form-hint" style="margin:6px 0;">${t('ml_local_down_hint')}</div>
    <button type="button" class="btn btn-primary btn-sm" data-reload-local="${esc(last.file)}">${t('ml_local_down_btn')}</button>`;
}

/**
 * Avisa quando um modelo escolhido pertence a um provedor DIFERENTE do que está em uso.
 *
 * Nasceu de uma falha real (02/08/2026): trocar o provedor deixava as categorias apontando para
 * modelos do provedor anterior, e o sistema continuava funcionando — até o próximo restart, quando
 * respondia `404 model not found`. O realinhamento automático em applyDefaultProviderChange() cobre
 * a troca feita pela UI; esta checagem cobre a CLASSE inteira: configuração vinda do .env editado à
 * mão, de uma versão anterior, de um provider removido, ou de um modelo desinstalado do Ollama.
 *
 * Só reporta o que dá para afirmar: um modelo ausente do catálogo não é acusado de nada — não há
 * como saber a que provedor pertence, e inventar um veredito seria pior que ficar calado.
 */
function checkConfigCoherence() {
  const box = document.getElementById('ov-coherence');
  if (!box) return;
  const cs = configStore;
  const catalog = providersStore.get('catalog') || [];
  if (!catalog.length) { box.style.display = 'none'; return; }

  const providerOf = Object.fromEntries(catalog.map(m => [m.id, m.provider]));
  const prov = cs.get('defaultProvider') || 'ollama';
  const mr = cs.get('modelRouter') || {};
  const labels = { chat: 'Chat', code: t('route_code_cat'), vision: t('route_vision_cat'),
                   light: t('route_light_cat'), analysis: t('route_analysis_cat'), execution: t('route_execution_cat') };

  const problems = [];
  for (const [cat, label] of Object.entries(labels)) {
    const model = mr[cat];
    if (!model) continue;
    // Um provider por categoria explícito manda nessa categoria — comparar contra o padrão daria
    // um falso alarme em quem configurou justamente essa combinação de propósito.
    const effective = mr[`provider_${cat}`] || prov;
    const owner = providerOf[model];
    if (owner && owner !== effective) problems.push({ label, model, owner, effective });
  }

  if (!problems.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.className = 'ml-test-result ml-test-fail';
  box.innerHTML = `
    <div class="ml-test-title">${t('ml_coherence_title')}</div>
    <div class="form-hint" style="margin:6px 0;">${t('ml_coherence_hint')}</div>
    <ul style="margin:0;padding-left:18px;">
      ${problems.map(p => `<li>${t('ml_coherence_item', { cat: esc(p.label), model: esc(p.model), owner: esc(p.owner), provider: esc(p.effective) })}</li>`).join('')}
    </ul>`;
}

/** Card "Catálogo de Modelos" (Instalar Modelo) — local canônico único pras métricas de catálogo
 * (contagem, última sincronização, origem, estado); Visão Geral só reflete prontidão agregada. */
function updateCatalogCard() {
  const cs = configStore;
  const s = cs.snap();
  // Mesma fonte da Visão Geral: o card diz "origem: <provider padrão>", então a contagem e o
  // estado ao lado precisam ser DESSE provider — não do Ollama por omissão.
  const h = activeProviderHealth();
  const lastSync = providersStore.get('lastSync');

  const el = id => document.getElementById(id);
  el('cat-count')      && (el('cat-count').textContent = `${h.count} ${t('ml_ov_available_suffix')}`);
  el('cat-lastsync')   && (el('cat-lastsync').textContent = lastSync ? new Date(lastSync).toLocaleTimeString() : '—');
  el('cat-origin')     && (el('cat-origin').textContent = PROV_LABELS[s.defaultProvider] || s.defaultProvider || '—');
  el('cat-syncstatus') && (el('cat-syncstatus').textContent = h.online ? t('ml_ov_online') : (h.error || t('ml_ov_offline')));
  el('cat-dot')        && (el('cat-dot').className = `dot ${h.online ? 'online' : 'offline'}`);
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
  // Usado por todos os cards (Ollama e custom) para marcar qual é o principal hoje e esconder o
  // botão de "usar como principal" naquele que já é — precisa vir antes do primeiro card.
  const isCurrentDefault = label => label === (s.defaultProvider || 'ollama');

  // Ollama (sempre presente — provider local/cloud padrão)
  cards.push(`
    <div class="provider-card wide">
      <div class="provider-head">
        <div class="provider-name">🦙 Ollama <span class="badge badge-local">local</span><span class="badge badge-cloud">cloud</span>${isCurrentDefault('ollama') ? `<span class="badge badge-primary">${t('ml_provider_role_primary')}</span>` : ''}</div>
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
      <!-- O card do Ollama não tinha nenhum botão: quem trocasse para um provider local não
           encontrava o caminho de volta (só existia "Usar como Fallback" no card do OUTRO
           provider, um rótulo que não diz "voltar para o Ollama"). Percurso de volta testado como
           usuário em 02/08/2026. Mesmo mecanismo dos demais cards, nada novo. -->
      ${isCurrentDefault('ollama') ? '' : `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
        <button class="btn btn-ghost btn-sm" data-use-as-primary="ollama">${t('ml_provider_use_as_primary_btn')}</button>
      </div>`}
    </div>`);

  // Custom providers (OpenAI-Compatible) — cada um pode ser usado como PRINCIPAL (tentado
  // primeiro em toda requisição) ou como FALLBACK (papel padrão: só entra automaticamente se
  // todo o resto falhar, via getFallbackOrder() no ProviderFactory — nenhuma ação extra
  // necessária). O botão aqui é só um atalho pro mesmo mecanismo do <select> "Provider padrão"
  // (defaultProvider) — não introduz nenhum conceito novo, só um jeito mais direto de acionar
  // o que já existe sem precisar navegar até outra seção da página.
  for (const p of (s.customProviders || [])) {
    const h = healthByProvider[p.label];
    const isPrimary = isCurrentDefault(p.label);
    cards.push(`
      <div class="provider-card">
        <div class="provider-head">
          <div class="provider-name">🔗 ${esc(p.label)} <span class="badge badge-cloud">OpenAI-Compatible</span>${isPrimary ? `<span class="badge badge-primary">${t('ml_provider_role_primary')}</span>` : ''}</div>
          <div class="provider-health" data-health="${esc(p.label)}">
            <span class="dot ${h ? (h.online ? 'online' : 'offline') : ''}"></span>
            <span>${h ? (h.online ? t('ollama_models_count', { n: h.modelCount }) : t('offline')) : '—'}</span>
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:8px;word-break:break-all;">${esc(p.baseUrl)}</div>
        <div class="form-hint" style="margin-bottom:8px;">${isPrimary ? t('ml_provider_role_primary_hint') : t('ml_provider_role_fallback_hint')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${isPrimary
            ? `<button class="btn btn-ghost btn-sm" data-use-as-fallback="${esc(p.label)}">${t('ml_provider_use_as_fallback_btn')}</button>`
            : `<button class="btn btn-ghost btn-sm" data-use-as-primary="${esc(p.label)}">${t('ml_provider_use_as_primary_btn')}</button>`}
          <button class="btn btn-ghost btn-sm" data-edit-provider="${esc(p.label)}">${t('ml_edit_btn')}</button>
          <button class="btn btn-ghost btn-sm btn-remove-key" data-remove-provider="${esc(p.label)}">${t('ml_remove_btn')}</button>
        </div>
      </div>`);
  }

  // Cloud providers (API key cards)
  for (const cp of CLOUD_PROVIDERS) {
    const hasKey = s[`has${cp.key.charAt(0).toUpperCase() + cp.key.slice(1)}Key`];
    const isPrimary = isCurrentDefault(cp.key);
    cards.push(`
      <div class="provider-card">
        <div class="provider-head">
          <div class="provider-name">${cp.icon} ${cp.name}${isPrimary ? `<span class="badge badge-primary">${t('ml_provider_role_primary')}</span>` : ''}</div>
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
        <!-- Só com chave configurada: eleger como principal um provider sem credencial deixaria
             o sistema apontando para algo que não pode responder. -->
        ${hasKey && !isPrimary ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" data-use-as-primary="${cp.key}">${t('ml_provider_use_as_primary_btn')}</button>
        </div>` : ''}
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
      return;
    }

    // "Usar como Principal" / "Usar como Fallback" — atalho direto no card do provider custom
    // pro mesmo mecanismo do <select> "Provider padrão" (ver applyDefaultProviderChange acima).
    // "Fallback" aqui significa voltar ao Ollama (o padrão de fábrica) — não existe um conceito
    // de "nenhum principal": sempre há exatamente um provider preferido, os demais entram na
    // ordem de fallback automaticamente (getFallbackOrder no ProviderFactory).
    const useAsPrimary = e.target.closest('[data-use-as-primary]')?.dataset.useAsPrimary;
    if (useAsPrimary) {
      // Toast do "virou principal" PRIMEIRO: applyDefaultProviderChange pode emitir logo depois o
      // aviso de modelos reajustados, que é a informação mais importante das duas — se viesse
      // antes, seria substituída na tela e o usuário nunca saberia que os modelos mudaram.
      showToast(t('ml_provider_set_primary_toast', { label: useAsPrimary }), 'success');
      applyDefaultProviderChange(useAsPrimary);
      return;
    }
    const useAsFallback = e.target.closest('[data-use-as-fallback]')?.dataset.useAsFallback;
    if (useAsFallback) {
      applyDefaultProviderChange('ollama');
      showToast(t('ml_provider_set_fallback_toast', { label: useAsFallback }), 'success');
      return;
    }

    const editProvider = e.target.closest('[data-edit-provider]')?.dataset.editProvider;
    if (editProvider) {
      startEditingCustomProvider(editProvider);
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
    const apiKeyRaw = document.getElementById('ml-newProvKey')?.value.trim();
    const model   = document.getElementById('ml-newProvModel')?.value.trim();
    if (!label || !baseUrl) { showToast(t('ml_provider_fill_required'), 'error'); return; }

    const btn = document.getElementById('ml-addProvBtn');
    btn.disabled = true; // evita duplo-clique disparar 2 requisições (ex.: rede lenta)
    try {
      if (editingProviderLabel) {
        // Campo de senha em branco → apiKey undefined → PUT preserva a chave já salva
        // (ver editCustomProvider em api.js). Label não muda (é a chave do provider).
        await editCustomProvider(editingProviderLabel, { baseUrl, apiKey: apiKeyRaw || undefined, model: model || undefined });
        cs.set('customProviders', (cs.get('customProviders') || []).map(p =>
          p.label === editingProviderLabel
            ? { ...p, baseUrl, model: model || undefined, hasKey: apiKeyRaw ? true : p.hasKey }
            : p
        ));
        showToast(t('ml_provider_updated_toast', { label: editingProviderLabel }), 'success');
        stopEditingCustomProvider();
      } else {
        await addCustomProvider({ label, baseUrl, apiKey: apiKeyRaw || undefined, model: model || undefined });
        cs.set('customProviders', [...(cs.get('customProviders') || []), { label, baseUrl, model: model || undefined, hasKey: !!apiKeyRaw }]);
        showToast(t('ml_provider_added_toast', { label }), 'success');
        document.getElementById('ml-newProvLabel').value = '';
        document.getElementById('ml-newProvUrl').value   = '';
        document.getElementById('ml-newProvKey').value   = '';
        document.getElementById('ml-newProvModel').value = '';
      }
    } catch (err) { showToast('Erro: ' + err.message, 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('ml-cancelEditProvBtn')?.addEventListener('click', () => stopEditingCustomProvider());

  // Testar conexão — antes de cadastrar. Sem isto, um endereço errado (ou o servidor local
  // desligado) só se revelava depois de salvar, indiretamente, num dot cinza no card.
  document.getElementById('ml-testProvBtn')?.addEventListener('click', async () => {
    const baseUrl = document.getElementById('ml-newProvUrl')?.value.trim();
    const apiKey  = document.getElementById('ml-newProvKey')?.value.trim();
    const out = document.getElementById('ml-testProvResult');
    if (!baseUrl) { showToast(t('ml_provider_fill_url'), 'error'); return; }

    const btn = document.getElementById('ml-testProvBtn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = t('ml_provider_testing');
    if (out) { out.style.display = ''; out.innerHTML = `<div class="form-hint">${t('ml_provider_testing')}</div>`; }
    try {
      const r = await testCustomProvider({ baseUrl, apiKey: apiKey || undefined });
      renderProviderTestResult(r);
    } catch (err) {
      renderProviderTestResult({ online: false, models: [], error: err.message });
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // Clicar num modelo listado pelo teste preenche o campo "Modelo" — o id vem do servidor do
  // próprio usuário, então não há o que digitar errado. Delegação: o conteúdo é recriado a cada
  // teste. (Para endpoints de modelo único o campo pode ficar vazio; o servidor ignora o campo.)
  document.getElementById('ml-testProvResult')?.addEventListener('click', e => {
    const pick = e.target.closest('[data-pick-model]')?.dataset.pickModel;
    if (!pick) return;
    const input = document.getElementById('ml-newProvModel');
    if (input) input.value = pick;
    showToast(t('ml_provider_model_picked', { model: pick }), 'success');
  });
}

/** Veredito do teste de conexão. Em caso de falha mostra a mensagem real do servidor/rede —
 *  nunca um "erro" genérico: é ela que diz se o problema é porta errada, servidor desligado ou
 *  caminho sem o /v1 no fim. */
function renderProviderTestResult(r) {
  const out = document.getElementById('ml-testProvResult');
  if (!out) return;
  out.style.display = '';
  if (!r.online) {
    out.innerHTML = `
      <div class="ml-test-result ml-test-fail">
        <div class="ml-test-title">❌ ${t('ml_provider_test_fail')}</div>
        <div class="ml-test-detail">${esc(r.error || '')}</div>
        <div class="form-hint" style="margin-top:6px;">${t('ml_provider_test_hint')}</div>
      </div>`;
    return;
  }
  const models = r.models || [];
  out.innerHTML = `
    <div class="ml-test-result ml-test-ok">
      <div class="ml-test-title">✅ ${t('ml_provider_test_ok', { n: models.length })}</div>
      ${models.length
        ? `<div class="form-hint" style="margin:6px 0;">${t('ml_provider_test_pick_hint')}</div>
           <div class="chips">${models.map(m => `<div class="chip" data-pick-model="${esc(m)}">${esc(m)}</div>`).join('')}</div>`
        : `<div class="form-hint" style="margin-top:6px;">${t('ml_provider_test_nomodels')}</div>`}
    </div>`;
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
function buildModelRows(models, { selectable = false, selectedId = null, currentId = null, installedIds = null, localFiles = false, runningFile = null, canServe = false } = {}) {
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
    // Arquivo em disco: o que importa saber é se ALGUM servidor já o está servindo agora — é a
    // diferença entre "posso escolher e usar" e "preciso carregá-lo antes". Fato verificado pelo
    // discovery (o id exposto pelo servidor é o nome do arquivo), nunca inferido.
    // Três estados distintos, cada um com a ação que faz sentido nele:
    //  - é o modelo que ESTE dashboard carregou  → pode descarregar (libera a RAM da máquina)
    //  - está sendo servido por fora             → só informa; não é nosso processo para encerrar
    //  - está no disco, parado                   → carregar, se houver executável de servidor
    const lastCell = localFiles
      ? (runningFile && m.id === runningFile
          ? `<span class="model-installed-badge">${t('ml_local_served_badge')}</span>
             <button type="button" class="btn btn-ghost btn-sm" data-unload-local="1">${t('ml_local_unload_btn')}</button>`
          : m.served
            ? `<span class="model-installed-badge">${t('ml_local_served_badge')}</span>`
            : canServe
              ? `<button type="button" class="btn btn-primary btn-sm" data-serve-local="${esc(m.id)}">${t('ml_local_serve_btn')}</button>`
              : `<span class="model-notserved-badge" title="${t('ml_local_notserved_hint')}">${t('ml_local_notserved_badge')}</span>`)
      : installedIds
        ? (installedIds.has(m.id)
            ? `<span class="model-installed-badge">${t('ml_installed_badge')}</span>`
            : `<button type="button" class="btn btn-primary btn-sm" data-activate-cloud="${esc(m.id)}">${t('ml_install_btn')}</button>`)
        : `<span class="dot online" style="display:inline-block;"></span> ${t('ml_available_status')}`;
    const sizeBadge = (localFiles && m.sizeBytes)
      ? ` <span class="model-size-badge">${esc(formatBytes(m.sizeBytes))}</span>` : '';
    return `
    <tr class="${rowClass}" data-model-id="${esc(m.id)}" data-model-provider="${esc(m.provider)}">
      ${selectable ? `<td class="model-radio-cell">${isSelected ? '🔘' : '⚪'}</td>` : ''}
      <td class="model-table-id">${esc(m.id)}${sizeBadge}${isCurrent ? ` <span class="model-current-badge">${t('ml_current_badge')}</span>` : ''}</td>
      <td><span class="badge badge-${m.provider === 'ollama' ? 'local' : 'cloud'}">${esc(m.provider)}</span></td>
      <td>${(m.capabilities || []).map(c => `<span class="model-cap-tag">${capLabels[c] || c}</span>`).join(' ')}</td>
      <td>${esc(formatContextWindow(m.contextWindow))}</td>
      <td>${lastCell}</td>
    </tr>`;
  }).join('');
}

/**
 * Varre a pasta de modelos locais. Usa o valor digitado no campo (permite conferir um caminho
 * antes de salvá-lo) e cai para a pasta já salva na configuração quando o campo está vazio.
 */
async function loadLocalModels() {
  const typed = document.getElementById('mr-localDir')?.value.trim();
  try {
    const r = await getLocalModels(typed || undefined);
    localCatalog = r.models || [];
    localConfigured = !!r.configured;
    localError = r.error || '';
    localServerBinary = r.serverBinary || null;
    localRunning = r.running || null;
  } catch (err) {
    localCatalog = [];
    localConfigured = true;
    localError = err.message;
    localServerBinary = null;
    localRunning = null;
  }
}

/**
 * Explica, em texto, o que está acontecendo e o que o usuário pode fazer. Existe porque a versão
 * anterior desta aba apenas listava arquivos e escrevia "Não carregado" — sem nada que dissesse
 * que era preciso carregar um modelo, nem como (relatado pelo usuário em 2026-08-02: "como a
 * pessoa vai saber que tem que subir? não tem nada explicando no navegador"). Uma tela que mostra
 * um estado sem oferecer nem explicar a ação correspondente é uma tela incompleta.
 */
function updateLocalExplainer() {
  const box = document.getElementById('mr-localExplain');
  if (!box) return;
  if (localRunning) {
    box.className = 'ml-test-result ml-test-ok';
    box.innerHTML = `<div class="ml-test-title">${t('ml_local_running_title', { model: esc(localRunning.file) })}</div>
      <div class="form-hint">${t('ml_local_running_hint')}</div>`;
  } else if (localServerBinary) {
    box.className = 'ml-guide-box';
    box.innerHTML = t('ml_local_ready_hint', { binary: esc(localServerBinary) });
  } else {
    // Sem executável: o usuário PRECISA saber por que não há botão, senão a tela vira um mistério.
    box.className = 'ml-test-result ml-test-fail';
    box.innerHTML = `<div class="ml-test-title">${t('ml_local_nobinary_title')}</div>
      <div class="form-hint">${t('ml_local_nobinary_hint')}</div>`;
  }
  box.style.display = '';
}

/** Busca + filtro de capability — mesmo critério nos três modos (Instalados/Cloud/Local). */
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

  // O campo de pasta só faz sentido no modo Local — nos outros dois a origem é remota.
  const dirRow = document.getElementById('mr-localDirRow');
  if (dirRow) dirRow.style.display = registryMode === 'local' ? '' : 'none';

  if (registryMode === 'local') {
    if (localCatalog === null) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">${t('ml_local_loading')}</td></tr>`;
      await loadLocalModels();
      if (registryMode !== 'local') return; // usuário trocou de modo durante a varredura
    }
    if (!localConfigured) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">${t('ml_local_notconfigured')}</td></tr>`;
      return;
    }
    if (localError) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">${t('ml_local_dir_error')} <code>${esc(localError)}</code></td></tr>`;
      return;
    }
    const filtered = filterCatalog(localCatalog);
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="padding:20px;color:var(--text-soft);">
        ${localCatalog.length === 0 ? t('ml_local_empty') : t('ml_no_match_filter')}</td></tr>`;
      return;
    }
    tbody.innerHTML = buildModelRows(filtered, {
      localFiles: true,
      runningFile: localRunning?.file || null,
      canServe: !!localServerBinary,
    });
    updateLocalExplainer();
    return;
  }

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

  // Pasta de modelos locais: digitar guarda no configStore (o Salvar global persiste, como
  // qualquer outro campo da página); buscar varre na hora, sem exigir salvar antes.
  const dirInput = document.getElementById('mr-localDir');
  dirInput?.addEventListener('input', e => configStore.set('localModelsDir', e.target.value));
  dirInput?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('mr-localScanBtn')?.click(); });

  document.getElementById('mr-localScanBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('mr-localScanBtn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = t('ml_local_scanning');
    try {
      localCatalog = null;   // força nova varredura em vez de reusar o resultado anterior
      await renderModelTable();
      const n = (localCatalog || []).length;
      if (localError) {
        showToast('❌ ' + localError, 'error');
      } else {
        // Buscar com sucesso É a declaração "esta é a minha pasta" — persistir aqui evita a
        // armadilha observada ao percorrer a tela como usuário leigo (2026-08-02): os modelos
        // apareciam listados, mas "Usar este modelo" respondia "nenhuma pasta configurada",
        // porque carregar usa a pasta SALVA e o usuário ainda não tinha clicado em Salvar. Pedir
        // um Salvar entre ver a lista e usar um item dela não faz sentido para quem está usando.
        await doSave();
        showToast(t('ml_local_found_toast', { n }), 'success');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // Delegação — sobrevive ao innerHTML do tbody sendo trocado a cada renderModelTable().
  document.getElementById('mr-tbody')?.addEventListener('click', async e => {
    // ── Carregar um modelo que está no disco ────────────────────────────────
    const serveBtn = e.target.closest('[data-serve-local]');
    if (serveBtn) {
      const file = serveBtn.dataset.serveLocal;
      serveBtn.disabled = true;
      showToast(t('ml_local_serving_toast', { model: file }), 'success');
      // Contador de tempo no próprio botão: um .gguf de 16 GB leva minutos e o único sinal antes
      // era a palavra "Carregando…" parada — indistinguível de travamento, e o usuário clicava de
      // novo. Ver o tempo correr é a prova barata de que algo está acontecendo.
      const startedAt = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        serveBtn.textContent = `${t('ml_local_serving')} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      tick();
      const timer = setInterval(tick, 1000);
      try {
        const r = await serveLocalModel(file);
        clearInterval(timer);
        // Carregar o modelo e não conectá-lo ao NewClaw deixaria o trabalho pela metade: o
        // usuário clicou em "usar", não em "iniciar um servidor". O provider é criado (ou
        // reapontado) aqui reusando as mesmas rotas de provider custom já existentes.
        await ensureLocalProvider(r.url, file);
        showToast(t('ml_local_served_toast', { model: file }), 'success');
        await loadProviders(true);   // catálogo e saúde refletem o modelo recém-carregado
        localCatalog = null;
        await renderModelTable();
      } catch (err) {
        clearInterval(timer);
        showToast('❌ ' + (err.message === 'no_server_binary' ? t('ml_local_nobinary_title') : err.message), 'error');
        serveBtn.disabled = false;
        serveBtn.textContent = t('ml_local_serve_btn');
      }
      return;
    }

    // ── Descarregar (libera a memória ocupada pelo modelo) ──────────────────
    if (e.target.closest('[data-unload-local]')) {
      try {
        await stopLocalModel();
        showToast(t('ml_local_unloaded_toast'), 'success');
        localCatalog = null;
        await renderModelTable();
        await loadProviders(true);
      } catch (err) { showToast('❌ ' + err.message, 'error'); }
      return;
    }

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

  // Modelo atribuído visível em cada botão — o slot se explica sem precisar clicar. Inclui os
  // componentes internos, que agora vivem no mesmo seletor.
  getCategoryMeta().forEach(c => {
    const sub = document.getElementById(`rt-catmodel-${c.key}`);
    if (sub) sub.textContent = r[c.key] || '—';
  });

  // Descrição do que aquele slot faz — os componentes internos precisam dela (ninguém sabe o que
  // é um "ObserverValidator" de cabeça); as categorias de tarefa se explicam pelo nome.
  const descEl = document.getElementById('rt-catDesc');
  if (descEl) {
    const meta = getCategoryMeta().find(c => c.key === routingSelectedCategory);
    descEl.textContent = meta?.desc || '';
    descEl.style.display = meta?.desc ? '' : 'none';
  }

  const pendingWrap = document.getElementById('rt-pendingWrap');
  const pendingEl = document.getElementById('rt-pendingModel');
  const showPending = !!routingPendingModel && routingPendingModel !== currentModel;
  if (pendingWrap) pendingWrap.style.display = showPending ? '' : 'none';
  if (pendingEl && showPending) pendingEl.textContent = routingPendingModel;

  const applyBtn = document.getElementById('rt-applyBtn');
  if (applyBtn) applyBtn.disabled = !showPending;
  // "Usar para tudo" continua disponível mesmo sem seleção pendente: aplicar a todos os slots o
  // modelo que já está neste é uma ação legítima (e comum) — só exige que exista algum modelo.
  const applyAllBtn = document.getElementById('rt-applyAllBtn');
  if (applyAllBtn) applyAllBtn.disabled = !(routingPendingModel || currentModel);

  const tbody = document.getElementById('rt-tbody');
  if (tbody) {
    tbody.innerHTML = buildModelRows(compatible, { selectable: true, selectedId: routingPendingModel || currentModel, currentId: currentModel });
  }
}

function wireCategoryPicker(container) {
  // Os dois grupos (tarefas e componentes internos) são um seletor só do ponto de vista da
  // seleção: escolher em um desmarca o outro, porque a tabela abaixo serve a um alvo por vez.
  const allCatBtns = container.querySelectorAll('#rt-catSelector .cat-btn, #rt-catSelectorInternal .cat-btn');
  allCatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      allCatBtns.forEach(b => b.classList.toggle('active', b === btn));
      routingSelectedCategory = btn.dataset.cat;
      routingPendingModel = null;
      routingPendingProvider = '';
      renderCategoryPicker();
    });
  });

  // Delegação de evento — sobrevive a innerHTML sendo trocado a cada renderCategoryPicker().
  document.getElementById('rt-tbody')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-model-id]');
    if (!tr) return;
    routingPendingModel = tr.dataset.modelId;
    routingPendingProvider = tr.dataset.modelProvider || '';
    renderCategoryPicker();
  });

  // ── "Usar para tudo" ──────────────────────────────────────────────────────
  document.getElementById('rt-applyAllBtn')?.addEventListener('click', async e => {
    const model = routingPendingModel || (configStore.get('modelRouter') || {})[routingSelectedCategory];
    if (!model) return;
    const cs = configStore;
    const mr = { ...(cs.get('modelRouter') || {}) };
    const catalog = providersStore.get('catalog') || [];
    const info = catalog.find(m => m.id === model);
    const provider = routingPendingProvider || info?.provider || '';
    const def = cs.get('defaultProvider') || 'ollama';

    // Slots que este modelo NÃO consegue atender ficam como estão. É melhor manter o modelo de
    // visão anterior do que apontar Visão para um modelo que não processa imagem — e o aviso
    // explica o que foi pulado, para a exceção não virar surpresa depois.
    const skipped = [];
    for (const meta of getCategoryMeta()) {
      const required = CATEGORY_CAPABILITY[meta.key];
      if (required && info?.capabilities && !info.capabilities.includes(required)) {
        skipped.push(meta.label);
        continue;
      }
      mr[meta.key] = model;
      if (!meta.internal && provider) {
        mr[`provider_${meta.key}`] = provider === def ? '' : provider;
      }
    }
    cs.set('modelRouter', mr);

    const btn = e.currentTarget;
    btn.disabled = true;
    try { await doSave(); } finally { btn.disabled = false; }
    routingPendingModel = null;
    routingPendingProvider = '';
    renderCategoryPicker();
    updateProviderHints(def);
    showToast(skipped.length
      ? t('ml_routing_applied_all_partial', { model, skipped: skipped.join(', ') })
      : t('ml_routing_applied_all', { model }), 'success');
  });

  document.getElementById('rt-applyBtn')?.addEventListener('click', async e => {
    if (!routingPendingModel) return;
    const cs = configStore;
    const mr = { ...cs.get('modelRouter') };
    mr[routingSelectedCategory] = routingPendingModel;

    // Modelo e provider são UMA escolha, não duas. Cada linha do catálogo já sabe de qual
    // provider o modelo veio (ModelInfo.provider, vindo do discovery) — antes esse dado era
    // descartado no Aplicar e o provider da categoria continuava apontando para outro lugar,
    // então escolher um modelo de um endpoint local mandava o nome dele para o Ollama. Grava-se
    // o par junto, o que elimina a classe inteira de "modelo existe, mas no provider errado".
    // `provider_<cat>` só existe para as 6 categorias de tarefa; componentes internos não têm
    // provider próprio (usam o padrão), então gravar aqui criaria uma chave que ninguém lê.
    if (routingPendingProvider && !INTERNAL_KEYS.includes(routingSelectedCategory)) {
      const def = cs.get('defaultProvider') || 'ollama';
      // Igual ao provider padrão → limpa o override e deixa herdar (o "— herdar padrão —" do
      // select por perfil). Assim trocar o Provider padrão depois continua valendo para todas as
      // categorias que não escolheram um provider diferente de propósito.
      // String vazia, NUNCA undefined: o POST /api/config funde com {...antigo, ...novo} e
      // JSON.stringify descarta chaves undefined — o campo nem chegaria ao servidor e o override
      // anterior sobreviveria calado. Achado rodando a app de verdade (2026-08-01): a tela já
      // mostrava "Herdando", mas o .env continuava com o PROVIDER_<CAT> antigo. '' é falsy tanto
      // em persistConfigToEnv (`|| ''`) quanto no ModelProfileRegistry (`if (config[key])`),
      // então significa exatamente "sem override" nas duas pontas.
      mr[`provider_${routingSelectedCategory}`] =
        routingPendingProvider === def ? '' : routingPendingProvider;
      const sel = document.getElementById(`ml-prov-${routingSelectedCategory}`);
      if (sel) sel.value = mr[`provider_${routingSelectedCategory}`] || '';
    }
    cs.set('modelRouter', mr);
    updateProviderHints(cs.get('defaultProvider'));
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
    routingPendingProvider = '';
    renderCategoryPicker();
  });
}

/**
 * Garante que existe um provider apontando para o servidor local recém-carregado, e que ele é o
 * provider padrão. Reusa addCustomProvider/editCustomProvider (as mesmas rotas do cadastro manual)
 * em vez de um caminho paralelo — um único mecanismo de provider, dois pontos de entrada na UI.
 */
async function ensureLocalProvider(url, file) {
  const cs = configStore;
  // Apontar TAMBÉM as categorias do Model Router para o modelo carregado. Sem isto o roteador
  // continuava pedindo o modelo que estava configurado antes (ex.: 'glm-5.2:cloud', do Ollama)
  // ao provider local — visto ao vivo em 02/08: `provider=Modelo local/glm-5.2:cloud`. Servidores
  // de modelo único ignoram o campo e funcionam por acidente; LM Studio/vLLM responderiam "modelo
  // não encontrado". Como o servidor local serve UM modelo, todas as categorias vão para ele de
  // qualquer forma — deixar nomes de outro provider ali seria só uma mentira na tela.
  if (file) {
    const mr = { ...(cs.get('modelRouter') || {}) };
    ['chat', 'code', 'vision', 'light', 'analysis', 'execution'].forEach(cat => { mr[cat] = file; });
    // Componentes internos (GoalPlanner/RiskAnalyzer/ObserverValidator) e o classificador também:
    // eles pedem modelo pelo nome como qualquer outro, e ficavam com nomes de modelo do Ollama
    // depois de trocar para um provider local — observado ao vivo, 02/08.
    mr.classifierModel = file;
    mr.plannerModel = file;
    mr.riskModel = file;
    mr.observerModel = file;
    cs.set('modelRouter', mr);
  }
  const existing = (cs.get('customProviders') || []).find(p => p.label === LOCAL_PROVIDER_LABEL);
  if (existing) {
    await editCustomProvider(LOCAL_PROVIDER_LABEL, { baseUrl: url });
    cs.set('customProviders', (cs.get('customProviders') || []).map(p =>
      p.label === LOCAL_PROVIDER_LABEL ? { ...p, baseUrl: url } : p));
  } else {
    await addCustomProvider({ label: LOCAL_PROVIDER_LABEL, baseUrl: url });
    cs.set('customProviders', [...(cs.get('customProviders') || []), { label: LOCAL_PROVIDER_LABEL, baseUrl: url, hasKey: false }]);
  }
  applyDefaultProviderChange(LOCAL_PROVIDER_LABEL);
  await doSave();
}

/** Tamanho de arquivo em disco — fato lido do filesystem, não estimativa. */
function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 ** 2))} MB`;
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
// internalCompRow() foi removida com os campos de texto livre dos componentes internos
// (2026-08-02) — eles passaram a ser escolhidos pelo seletor de categorias, na tabela.

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

// O <select> de provider padrão (linha ~348) só listava os 6 providers nativos, hardcoded no
// template — um customProvider (LM Studio/vLLM/llamafile local) nunca aparecia como opção,
// mesmo já sendo um provider "de verdade" no ProviderFactory (ver addCustomProvider()). Sem
// isso, não havia como escolher via UI usar o modelo local como PRIMÁRIO — só como fallback
// automático (que já funciona por conta da ordem de getFallbackOrder(), sem UI nenhuma).
// Idempotente: remove as <option> customizadas antigas antes de reinserir, então pode ser
// chamada de novo sempre que customProviders mudar sem duplicar nem acumular opções obsoletas.
// Generalizada (2026-07-31) para popular QUALQUER <select> de provider — antes só cobria
// "Provider padrão" (ml-defaultProvider); "Provider por perfil" (ml-prov-${cat}, um por
// categoria: chat/code/vision/light/analysis/execution) tinha a MESMA lista hardcoded e o
// MESMO buraco, achado ao investigar como o usuário selecionaria um modelo llamafile por
// categoria depois de cadastrar o provider.
function populateDefaultProviderOptions(customProviders, preserveValue, selectEl) {
    const select = selectEl || document.getElementById('ml-defaultProvider');
    if (!select) return;
    const currentValue = preserveValue ?? select.value;
    select.querySelectorAll('option[data-custom-provider]').forEach(opt => opt.remove());
    for (const p of (customProviders || [])) {
        if (!p?.label) continue;
        const opt = document.createElement('option');
        opt.value = p.label;
        opt.dataset.customProvider = 'true';
        opt.textContent = `🔗 ${p.label} (OpenAI-Compatible)`;
        select.appendChild(opt);
    }
    if (currentValue && select.querySelector(`option[value="${CSS.escape(currentValue)}"]`)) {
        select.value = currentValue;
    }
}

/**
 * Único ponto que muda o provider padrão (principal) — usado pelo <select> "Provider padrão"
 * E pelos botões "Usar como Principal/Fallback" nos cards de provider custom (mesmo mecanismo,
 * dois pontos de entrada na UI, sem duplicar lógica). cs.set('defaultProvider', ...) já dispara
 * o rastreio de "alterações não salvas" (configStore.on('*', ...) em app.js) — o usuário ainda
 * precisa clicar em Salvar pra persistir, igual a qualquer outro campo desta página.
 */
/**
 * Reaponta os modelos por categoria quando o provider padrão muda, para modelos que o NOVO
 * provider realmente serve.
 *
 * Sem isto, trocar de provider deixava a configuração quebrada de um jeito especialmente cruel:
 * as categorias continuavam com os modelos do provider anterior (ex.: voltar do modelo local para
 * o Ollama mantinha `MODEL_CHAT=Qwen2.5-...gguf`), e como o registro de perfis já estava carregado
 * em memória, tudo parecia funcionar — até o próximo restart, quando o Ollama respondia
 * `404 model not found`. Reproduzido ao vivo em 02/08/2026: a falha só apareceu depois de reiniciar.
 *
 * Não adivinha nada: só troca modelos cujo provider de origem é CONHECIDO pelo catálogo e difere
 * do novo provider, e o destino é um modelo que o próprio usuário já configurou (o modelo
 * principal do Ollama, ou o modelo do provider custom). Sem destino conhecido, não mexe.
 */
function realignRouterToProvider(prov) {
    const cs = configStore;
    const catalog = providersStore.get('catalog') || [];
    if (!catalog.length) return null;
    const providerOf = Object.fromEntries(catalog.map(m => [m.id, m.provider]));

    let target = '';
    if (prov === 'ollama') {
        target = cs.get('ollamaModel') || '';
    } else {
        const custom = (cs.get('customProviders') || []).find(p => p.label === prov);
        target = custom?.model || catalog.find(m => m.provider === prov)?.id || '';
    }
    if (!target) return null;

    const mr = { ...(cs.get('modelRouter') || {}) };
    const keys = ['chat', 'code', 'vision', 'light', 'analysis', 'execution', 'classifierModel', 'plannerModel', 'riskModel', 'observerModel'];
    // Um modelo ausente do catálogo (ex.: modelo de nuvem ainda não instalado) fica como está —
    // não dá para afirmar a que provider pertence, e o certo diante de dado desconhecido é não mexer.
    const stale = keys.filter(k => mr[k] && providerOf[mr[k]] && providerOf[mr[k]] !== prov);
    if (!stale.length) return null;

    stale.forEach(k => { mr[k] = target; });
    cs.set('modelRouter', mr);
    ['chat', 'code', 'vision', 'light', 'analysis', 'execution'].forEach(cat => {
        const sel = document.getElementById(`ml-prov-${cat}`);
        if (sel && mr[`provider_${cat}`]) { mr[`provider_${cat}`] = ''; sel.value = ''; }
    });
    return { count: stale.length, target };
}

function applyDefaultProviderChange(prov) {
    const cs = configStore;
    cs.set('defaultProvider', prov);
    const realigned = realignRouterToProvider(prov);
    if (realigned) {
        // Avisar sempre: o usuário precisa saber que os modelos mudaram junto com o provider —
        // uma troca silenciosa de modelo é tão confusa quanto a configuração quebrada de antes.
        showToast(t('ml_provider_models_realigned', { n: realigned.count, model: realigned.target }), 'success');
    }
    const select = document.getElementById('ml-defaultProvider');
    if (select) select.value = prov;
    toggleOllamaSection(prov);
    updateProviderHints(prov);
    updateEffectiveConfig(cs.get('modelRouter') || {}, prov);
    updateOverview();
    renderProviderGrid(); // atualiza os badges/botões "Principal"/"Usar como..." nos cards
}

/**
 * Abre o formulário "Adicionar provider" em modo edição, pré-preenchido com os dados do
 * provider custom clicado. Label fica travada (não é editável — é a chave de identidade do
 * provider; renomear equivale a remover+adicionar, já coberto pelos botões existentes). apiKey
 * fica em branco de propósito mesmo se já configurada (nunca ecoa segredo salvo de volta pro
 * campo) — o placeholder avisa que deixar em branco preserva a chave atual.
 */
function startEditingCustomProvider(label) {
    const p = (configStore.get('customProviders') || []).find(cp => cp.label === label);
    if (!p) return;
    editingProviderLabel = label;

    const details = document.getElementById('ml-addProvDetails');
    if (details) details.open = true;

    const labelInput = document.getElementById('ml-newProvLabel');
    if (labelInput) { labelInput.value = p.label; labelInput.disabled = true; }
    const urlInput = document.getElementById('ml-newProvUrl');
    if (urlInput) urlInput.value = p.baseUrl || '';
    const keyInput = document.getElementById('ml-newProvKey');
    if (keyInput) { keyInput.value = ''; keyInput.placeholder = p.hasKey ? t('ml_provider_key_unchanged_placeholder') : t('ml_optional_placeholder'); }
    const modelInput = document.getElementById('ml-newProvModel');
    if (modelInput) modelInput.value = p.model || '';

    const summary = document.getElementById('ml-addProvSummary');
    if (summary) summary.textContent = t('ml_edit_provider_title', { label: p.label });
    const presets = document.getElementById('ml-addProvPresets');
    if (presets) presets.style.display = 'none'; // presets são só pra criar novo, não fazem sentido editando
    const addBtn = document.getElementById('ml-addProvBtn');
    if (addBtn) addBtn.textContent = t('save_btn');
    const cancelBtn = document.getElementById('ml-cancelEditProvBtn');
    if (cancelBtn) cancelBtn.style.display = '';

    details?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Volta o formulário "Adicionar provider" ao modo normal (criar novo) — chamado após salvar
 *  uma edição com sucesso, ou pelo botão Cancelar. */
function stopEditingCustomProvider() {
    editingProviderLabel = null;
    const labelInput = document.getElementById('ml-newProvLabel');
    if (labelInput) { labelInput.value = ''; labelInput.disabled = false; }
    const urlInput = document.getElementById('ml-newProvUrl');
    if (urlInput) urlInput.value = '';
    const keyInput = document.getElementById('ml-newProvKey');
    if (keyInput) { keyInput.value = ''; keyInput.placeholder = t('ml_optional_placeholder'); }
    const modelInput = document.getElementById('ml-newProvModel');
    if (modelInput) modelInput.value = '';

    const summary = document.getElementById('ml-addProvSummary');
    if (summary) summary.textContent = t('ml_add_provider_title');
    const presets = document.getElementById('ml-addProvPresets');
    if (presets) presets.style.display = '';
    const addBtn = document.getElementById('ml-addProvBtn');
    if (addBtn) addBtn.textContent = t('ml_add_btn');
    const cancelBtn = document.getElementById('ml-cancelEditProvBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
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
