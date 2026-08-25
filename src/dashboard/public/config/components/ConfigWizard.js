/**
 * Assistente de Configuração — primeira aba de Modelos, orquestrador de capacidades já existentes
 * (Fase A/B documentadas em conversa; nenhum RFC formal escrito ainda).
 *
 * INCREMENTO 1 (2026-08-19): infraestrutura (PROVIDER_CAPABILITIES, máquina de estados,
 * WizardSession) + Tela 1 (Escolher Provider).
 * INCREMENTO 2 (2026-08-23): fluxo completo de Ollama (Local × Cloud) — o primeiro fluxo real,
 * escolhido de propósito por exercitar a fronteira mais importante do mecanismo (família com
 * submodo).
 * INCREMENTO 3 (2026-08-23): fluxo completo de Custom/OpenAI-Compatible (LM Studio/vLLM/
 * llamafile/OpenAI-oficial/gateway próprio) — confirmado por leitura direta do backend
 * (`routes/providers.ts`) que os presets NÃO são caminhos distintos: todos passam pelo mesmo
 * `testCustomProvider()`/`addCustomProvider()`/`editCustomProvider()` genéricos, só pré-preenchem
 * label+baseUrl. Nenhum backend novo. Achado nesta mesma entrega, corrigido nos dois fluxos já
 * conectados (Ollama e Custom): trocar `defaultProvider` deve sempre passar por
 * `applyDefaultProviderChange()` (realinha `modelRouter` contra o catálogo real), nunca um
 * `configStore.set()` direto — era exatamente essa proteção que faltava quando um nome de arquivo
 * `.gguf` sobrou em `modelRouter` e foi tratado como tag do Ollama (achado ao vivo, C2).
 * INCREMENTO 4 (2026-08-23): fluxo completo de Modelo Local (GGUF) — reaproveita
 * `LocalModelWizard.js` por inteiro no nível das APIs (`getLocalModels`/`serveLocalModel`/
 * `ensureLocalProvider`), não duplica nenhuma. Investigação prévia confirmou que
 * `ensureLocalProvider()` JÁ chama `applyDefaultProviderChange()` internamente — a família local
 * já está protegida contra a classe de bug do C2 de graça, só por reaproveitar a função como está,
 * sem reescrevê-la. `serveLocalModel()` já para o servidor anterior antes de subir outro (backend,
 * `models.ts`) — trocar de modelo com um já rodando não precisa de tratamento especial aqui.
 * mmproj/projetores multimodais (recurso real do backend) fica de fora do Wizard guiado, mesmo
 * precedente do `LocalModelWizard.js` original, que também nunca os expôs.
 *
 * NÃO importa de `ModelosView.js` (evita o ciclo já documentado em LocalModelWizard.js — os dois
 * arquivos se importariam mutuamente). `CLOUD_PROVIDERS`/`PROV_LABELS`/`LOCAL_PROVIDER_LABEL`/
 * `customPresets`/`computeSystemReady`/`applyDefaultProviderChange`/`ensureLocalProvider` chegam
 * por referência em mount() — são as MESMAS constantes/funções que as abas antigas (e o wizard
 * antigo) já usam, referenciadas, não duplicadas.
 *
 * LocalModelWizard.js (o "🧭 Assistente de Configuração Rápida" que já existe acima das abas)
 * NÃO foi tocado nem substituído por este arquivo — continua montado e funcional como está.
 */
import { configStore, providersStore } from '../state.js';
import { doSave, loadProviders } from '../app.js';
import { getCloudCatalog, testCustomProvider, addCustomProvider, editCustomProvider, getConfig, getLocalModels, serveLocalModel, browseLocalDirectory, triggerNativeDirectoryPicker } from '../api.js';
import { renderModelPickList } from './LocalModelPickList.js';

/** Ícones que não vêm de nenhuma constante reaproveitável hoje — Ollama só existe hardcoded inline
 *  no template de `ModelosView.js` (não há constante pra referenciar); "Outro" nunca teve ícone
 *  antes porque a aba Adicionar Modelo não trata endpoints custom como uma "opção de provider". */
const OLLAMA_ICON = '🦙';
const LOCAL_ICON = '🖥️';
const CUSTOM_ICON = '🔌';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * Capacidades por família — decisão da Fase B (2026-08-19): em vez de flags independentes
 * (`needsModelSelection`/`hasDefaultModel`) que podiam ficar inconsistentes entre si, o
 * comportamento de cada etapa é DERIVADO daqui. `modes` existe só pra Ollama (Local × Cloud);
 * `auth: true` nele descreve que o modo Cloud PODE exigir key — qual etapa realmente aparece é
 * resolvido por família+modo em `FAMILY_STEPS`, não só pela capability estática.
 */
const PROVIDER_CAPABILITIES = {
  local:       { family: 'local-gguf', capabilities: { discovery: true,  modelSelection: true,  modelPull: false, serving: true,  auth: false } },
  ollama:      { family: 'ollama',     capabilities: { discovery: true,  modelSelection: true,  modelPull: true,  serving: false, auth: true  }, modes: ['local', 'cloud'] },
  gemini:      { family: 'native',     capabilities: { discovery: true,  modelSelection: false, modelPull: false, serving: false, auth: true  } },
  deepseek:    { family: 'native',     capabilities: { discovery: true,  modelSelection: false, modelPull: false, serving: false, auth: true  } },
  groq:        { family: 'native',     capabilities: { discovery: true,  modelSelection: false, modelPull: false, serving: false, auth: true  } },
  openrouter:  { family: 'native',     capabilities: { discovery: true,  modelSelection: false, modelPull: false, serving: false, auth: true  } },
  anthropic:   { family: 'native',     capabilities: { discovery: true,  modelSelection: false, modelPull: false, serving: false, auth: true  } },
  custom:      { family: 'custom',     capabilities: { discovery: true,  modelSelection: true,  modelPull: false, serving: false, auth: true  } },
};

/** "Tem modelo default" nunca foi um fato independente — é sempre a mesma pergunta que
 *  `!capabilities.modelSelection` já responde (só os 5 nativos dispensam seleção, porque só eles
 *  têm um modelo embutido no construtor do provider). Deriva em vez de guardar duas verdades. */
function hasDefaultModel(providerId) {
  return !PROVIDER_CAPABILITIES[providerId].capabilities.modelSelection;
}

/** Ordem oficial da Tela 1 — decidida explicitamente, não alterar sem justificar tecnicamente. */
const PROVIDER_ORDER = ['local', 'ollama', 'gemini', 'deepseek', 'groq', 'openrouter', 'anthropic', 'custom'];

/** Resolve ícone+label de exibição sem duplicar as constantes já existentes em ModelosView.js. */
function getProviderDisplay(providerId, { cloudProviders, provLabels, localProviderLabel }) {
  if (providerId === 'local') return { icon: LOCAL_ICON, label: localProviderLabel };
  if (providerId === 'ollama') return { icon: OLLAMA_ICON, label: provLabels.ollama };
  if (providerId === 'custom') return { icon: CUSTOM_ICON, label: t('ml_cw_provider_custom') };
  const cloud = cloudProviders.find(p => p.key === providerId);
  return { icon: cloud?.icon || '', label: cloud?.name || provLabels[providerId] || providerId };
}

/**
 * Lista de etapas por família — cada uma dona da própria sequência (Fase B: "family → subgrafo
 * específico", não STEP_1→STEP_2→STEP_3 fixo pra todo mundo).
 *
 * Ollama NÃO tem uma etapa de discovery separada: achado do Incremento 2, ao ler `GET
 * /api/providers` de verdade — a mesma resposta que confirma a conexão (`health`) já vem com o
 * catálogo de modelos (`providers.ollama.models`), porque `loadProviders()` busca os dois juntos.
 * Uma etapa "descobrindo..." própria seria uma tela vazia repetindo o que "Testar conexão" (na
 * etapa de configuração) já fez — por isso o desenho original da Fase B (com `ollamaDiscovery`
 * separado) foi corrigido aqui, dentro da própria campanha C2, como já combinado.
 *
 * A mesma correção vale pra Custom: `testCustomProvider()` já devolve `online` + `models` numa
 * chamada só — uma etapa "customTesting" separada seria a mesma tela vazia de novo.
 */
const FAMILY_STEPS = {
  native:       ['choose', 'credential', 'validating', 'conclusion'],
  ollama:       ['choose', 'ollamaMode', 'ollamaConfig', 'ollamaModelSelect', 'conclusion'],
  custom:       ['choose', 'customEndpoint', 'customModelSelect', 'conclusion'],
  // localServing/localConfirming (desenho original da Fase B) viraram um "localLoading" só:
  // achado no C4 — a tela genérica "conclusion" já checa computeSystemReady() e já reage ao
  // mesmo listener de providersStore que "confirmando → pronto" precisava, pra QUALQUER família
  // (não só Ollama). Uma etapa "confirming" própria pro Local seria a mesma tela redundante que
  // já foi cortada duas vezes (ollamaDiscovery no C2, customTesting no C3).
  'local-gguf': ['choose', 'localFolder', 'localModelSelect', 'localLoading', 'conclusion'],
};

/**
 * Estado da sessão do Wizard — vive só em memória (closure do mount()), nunca em
 * `localStorage`/`configStore` diretamente. Sem campo `dirty`: a regra decidida na Fase B
 * ("salva quando uma DECISÃO for confirmada, nunca a cada evidência") é aplicada literalmente no
 * fluxo de Ollama — `ollamaConfig` só persiste ao clicar "Testar conexão" (a confirmação real de
 * que aquele endereço/chave é o que o usuário quer), e `ollamaModelSelect` só persiste ao avançar
 * com um modelo escolhido — nunca a cada tecla digitada.
 */
function createWizardSession() {
  return {
    provider: null,
    family: null,
    ollamaMode: undefined,
    customLabel: undefined,
    evidence: {},
    selectedModel: undefined,
    currentStep: 'choose',
    // Achado ao vivo (QA final, 2026-08-23): entrada transitória do usuário — o que está
    // ATUALMENTE digitado num campo, ainda não testado nem salvo — nunca tinha um lugar próprio
    // pra viver. `evidence` guarda o que já foi CONFIRMADO por um teste bem-sucedido; `configStore`
    // guarda o que já foi SALVO; nenhum dos dois é "o que a pessoa está tentando corrigir agora".
    // Sem isto, uma falha de validação (URL errada, pasta inexistente, endpoint fora do ar) fazia
    // o campo reverter pro valor salvo antigo ou ficar vazio — confirmado de forma independente em
    // 3 famílias (Local/pasta, Ollama/URL, Custom/label+URL). Mesma distinção que já existe pra
    // config (evidência ≠ decisão ≠ persistência), uma quarta categoria: persistido ≠ confirmado ≠
    // evidência ≠ entrada transitória. Cada render*() lê daqui primeiro; cada input escreve aqui
    // via bindDraft(), nunca via configStore/DOM lido de volta no meio de um clique.
    draft: {},
  };
}

function stepsFor(session) {
  return session.family ? FAMILY_STEPS[session.family] : ['choose'];
}

/** Condição objetiva por etapa — nunca "campo não vazio", sempre um fato já verificado. */
function canAdvance(session) {
  switch (session.currentStep) {
    case 'choose':            return !!session.provider;
    case 'ollamaMode':        return !!session.ollamaMode;
    case 'ollamaConfig':      return session.evidence.configOk === true;
    case 'ollamaModelSelect': return true; // seleção recomendada, não obrigatória (Ollama)
    case 'customEndpoint':    return session.evidence.configOk === true;
    case 'customModelSelect': return true; // idem — recomendada, não obrigatória (Custom)
    // localFolder: sem "Próximo" genérico liberado por seleção — a única transição real é o
    // clique numa linha específica de modelo, que já dispara o carregamento (mandatório aqui,
    // ao contrário de Ollama/Custom: um servidor local sempre serve UM arquivo específico, não
    // há "pular e usar o que já tinha"). localFolder é a única com condição própria.
    case 'localFolder':       return session.evidence.configOk === true;
    default:               return false;   // etapas ainda placeholder, ou com transição própria
  }
}

function next(session) {
  if (!canAdvance(session)) return session;
  const steps = stepsFor(session);
  const idx = steps.indexOf(session.currentStep);
  if (idx === -1 || idx === steps.length - 1) return session;
  return { ...session, currentStep: steps[idx + 1] };
}

function back(session) {
  const steps = stepsFor(session);
  const idx = steps.indexOf(session.currentStep);
  if (idx <= 0) return session;
  // Voltar pra "choose" precisa zerar o que foi acumulado — trocar de provider não pode deixar
  // evidence/selectedModel de um provider antigo vazando pro próximo (risco mapeado na Fase A).
  if (steps[idx - 1] === 'choose') {
    return { provider: null, family: null, ollamaMode: undefined, evidence: {}, selectedModel: undefined, currentStep: 'choose', draft: {} };
  }
  // Sair de ollamaConfig pra ollamaMode invalida a config testada — trocar Local↔Cloud exige
  // testar de novo (a URL pode continuar valendo, mas a key só faz sentido em Cloud).
  if (steps[idx - 1] === 'ollamaMode') {
    return { ...session, evidence: {}, currentStep: 'ollamaMode' };
  }
  return { ...session, currentStep: steps[idx - 1] };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mountConfigWizard(container, { cloudProviders, provLabels, localProviderLabel, customPresets, computeSystemReady, applyDefaultProviderChange, ensureLocalProvider }) {
  if (!container) return () => {};

  let destroyed = false;
  let busy = false; // uma ação de rede em andamento (testar conexão / confirmar modelo)
  let session = createWizardSession();
  let configError = ''; // erro da última tentativa de "Testar conexão", exibido inline
  // Painel do WebDirectoryPicker (campanha FP–FP.6.3): null = fechado; objeto = navegação aberta,
  // { dir, ceiling, canGoUp, parent, subdirs }. Vive fora de `session` de propósito — é estado de
  // UI transitório da MESMA natureza de `busy`/`configError`, nunca precisa sobreviver a um
  // back()/next() nem é uma das 4 categorias já estabelecidas (persistido/confirmado/evidência/
  // draft) do WizardSession.
  let browseState = null;

  function render() {
    if (destroyed) return;
    const steps = stepsFor(session);
    // Achado QA (campanha FP, UX-01, 2026-08-24): com o painel do WebDirectoryPicker aberto, o
    // rodapé do Wizard ficava visível ao lado do rodapé do próprio painel — dois botões chamados
    // "Cancelar" ao mesmo tempo, um fechando só o painel, o outro reiniciando o Wizard inteiro.
    // O painel já é autossuficiente (Cancelar/Subir/Usar esta pasta) enquanto está aberto, então o
    // rodapé do Wizard só soma controle redundante e ambíguo — omitido nesse estado, não
    // desabilitado (evita a mesma ambiguidade com um botão "Cancelar" cinza mas ainda clicável).
    container.innerHTML = `
      <div class="ml-guide-box">
        <div class="ml-cw-progress" id="ml-cw-progress"></div>
        <div id="ml-cw-step"></div>
        ${browseState ? '' : `
        <div style="display:flex;justify-content:space-between;margin-top:14px;">
          <button type="button" class="btn btn-ghost btn-sm" id="ml-cw-cancel" ${busy ? 'disabled' : ''}>${t('ml_cw_btn_cancel')}</button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn btn-ghost btn-sm" id="ml-cw-back" ${session.currentStep === 'choose' || busy ? 'disabled' : ''}>${t('ml_cw_btn_back')}</button>
            ${session.currentStep === 'conclusion' ? '' : `<button type="button" class="btn btn-primary btn-sm" id="ml-cw-next" ${canAdvance(session) && !busy ? '' : 'disabled'}>${t('ml_cw_btn_next')}</button>`}
          </div>
        </div>`}
      </div>`;

    renderProgress(steps);
    const stepEl = document.getElementById('ml-cw-step');
    if (session.currentStep === 'choose') renderChooseProvider(stepEl);
    else if (session.family === 'ollama' && session.currentStep === 'ollamaMode') renderOllamaMode(stepEl);
    else if (session.family === 'ollama' && session.currentStep === 'ollamaConfig') renderOllamaConfig(stepEl);
    else if (session.family === 'ollama' && session.currentStep === 'ollamaModelSelect') renderOllamaModelSelect(stepEl);
    else if (session.family === 'custom' && session.currentStep === 'customEndpoint') renderCustomEndpoint(stepEl);
    else if (session.family === 'custom' && session.currentStep === 'customModelSelect') renderCustomModelSelect(stepEl);
    else if (session.family === 'local-gguf' && session.currentStep === 'localFolder') renderLocalFolder(stepEl);
    else if (session.family === 'local-gguf' && session.currentStep === 'localModelSelect') renderLocalModelSelect(stepEl);
    else if (session.family === 'local-gguf' && session.currentStep === 'localLoading') renderLocalLoading(stepEl);
    else if (session.family === 'native' && session.currentStep === 'credential') renderCredential(stepEl);
    else if (session.family === 'native' && session.currentStep === 'validating') renderValidating(stepEl);
    else if (session.currentStep === 'conclusion') renderConclusion(stepEl);
    else renderStub(stepEl);

    document.getElementById('ml-cw-cancel')?.addEventListener('click', () => {
      session = createWizardSession();
      configError = '';
      render();
    });
    document.getElementById('ml-cw-back')?.addEventListener('click', () => {
      session = back(session);
      configError = '';
      render();
    });
    document.getElementById('ml-cw-next')?.addEventListener('click', () => {
      // ollamaModelSelect é a única etapa onde "Próximo" também é a confirmação (salva a escolha,
      // se houver uma) — nas demais, avançar é só navegação: a persistência já aconteceu na ação
      // própria da etapa (ex.: "Testar conexão").
      if (session.family === 'ollama' && session.currentStep === 'ollamaModelSelect') {
        confirmOllamaModelSelection();
      } else if (session.family === 'custom' && session.currentStep === 'customModelSelect') {
        confirmCustomEntry();
      } else {
        session = next(session);
        render();
      }
    });
  }

  function renderProgress(steps) {
    const el = document.getElementById('ml-cw-progress');
    if (!el) return;
    const idx = steps.indexOf(session.currentStep);
    el.textContent = steps.map((s, i) => (i < idx ? '✓' : i === idx ? '●' : '○')).join('  ━━━  ');
  }

  function renderChooseProvider(el) {
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_choose_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_choose_hint')}</div>
      <div id="ml-cw-providerGrid" style="display:flex;flex-direction:column;gap:6px;"></div>`;
    const grid = document.getElementById('ml-cw-providerGrid');
    PROVIDER_ORDER.forEach(id => {
      const display = getProviderDisplay(id, { cloudProviders, provLabels, localProviderLabel });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm ${session.provider === id ? 'btn-primary' : 'btn-ghost'}`;
      btn.style.cssText = 'justify-content:flex-start;text-align:left;';
      btn.textContent = `${display.icon} ${display.label}`;
      btn.addEventListener('click', () => {
        session = { ...session, provider: id, family: PROVIDER_CAPABILITIES[id].family };
        render();
      });
      grid.appendChild(btn);
    });
  }

  function renderOllamaMode(el) {
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_ollama_mode_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_ollama_mode_hint')}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button type="button" class="btn btn-sm ${session.ollamaMode === 'local' ? 'btn-primary' : 'btn-ghost'}" id="ml-cw-ollamaLocal" style="justify-content:flex-start;text-align:left;">💻 ${t('ml_cw_ollama_mode_local')}</button>
        <button type="button" class="btn btn-sm ${session.ollamaMode === 'cloud' ? 'btn-primary' : 'btn-ghost'}" id="ml-cw-ollamaCloud" style="justify-content:flex-start;text-align:left;">☁️ ${t('ml_cw_ollama_mode_cloud')}</button>
      </div>`;
    document.getElementById('ml-cw-ollamaLocal')?.addEventListener('click', () => {
      session = { ...session, ollamaMode: 'local', evidence: {} };
      render();
    });
    document.getElementById('ml-cw-ollamaCloud')?.addEventListener('click', () => {
      session = { ...session, ollamaMode: 'cloud', evidence: {} };
      render();
    });
  }

  function renderOllamaConfig(el) {
    const isCloud = session.ollamaMode === 'cloud';
    const currentUrl = configStore.get('ollamaUrl') || DEFAULT_OLLAMA_URL;
    // Mesmo achado do Local (ver renderLocalFolder): semeia o draft com o valor pré-preenchido, senão
    // clicar "Testar conexão" sem antes editar o campo cairia no fallback DEFAULT_OLLAMA_URL — errado
    // se o valor já salvo fosse outro (ex.: um IP customizado) — em vez de usar o que está na tela.
    session.draft.ollamaUrl ??= currentUrl;
    el.innerHTML = `
      <div class="ml-test-title">${isCloud ? t('ml_cw_ollama_config_cloud_title') : t('ml_cw_ollama_config_local_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${isCloud ? t('ml_cw_ollama_config_cloud_hint') : t('ml_cw_ollama_config_local_hint')}</div>
      <div class="form-group">
        <label class="form-label" for="ml-cw-ollamaUrl">${t('ml_cw_ollama_url_label')}</label>
        <input type="text" class="form-input" id="ml-cw-ollamaUrl" value="${esc(session.draft.ollamaUrl ?? currentUrl)}">
      </div>
      ${isCloud ? `
      <div class="form-group" style="margin-top:8px;">
        <label class="form-label" for="ml-cw-ollamaKey">${t('ml_cw_ollama_key_label')}</label>
        <input type="password" class="form-input" id="ml-cw-ollamaKey" value="${esc(session.draft.ollamaKey ?? '')}" placeholder="${configStore.get('ollamaApiKey') ? '••••••••' : ''}">
      </div>` : ''}
      <button type="button" class="btn btn-primary btn-sm" id="ml-cw-ollamaTest" style="margin-top:10px;" ${busy ? 'disabled' : ''}>
        ${busy ? t('ml_cw_testing') : t('ml_cw_test_connection_btn')}
      </button>
      ${session.evidence.configOk ? `<div class="form-hint" style="margin-top:8px;color:var(--success,#2ecc71);">✓ ${t('ml_cw_ollama_connected', { count: session.evidence.modelCount ?? 0 })}</div>` : ''}
      ${configError ? `<div class="form-hint" style="margin-top:8px;color:var(--error,#e74c3c);">❌ ${esc(configError)}</div>` : ''}`;

    document.getElementById('ml-cw-ollamaTest')?.addEventListener('click', testOllamaConnection);
    // Achado durante o desenho do C3 (2026-08-23), corrigido aqui também: editar a URL/key DEPOIS
    // de um teste bem-sucedido não invalidava `evidence.configOk`, então "Próximo" continuava
    // liberado com uma configuração nunca testada de verdade — voltar um passo e voltar não
    // disparava o reset (só troca de modo Local↔Cloud disparava). Qualquer edição nos campos
    // depois de testado exige testar de novo.
    invalidateEvidenceOnEdit('ml-cw-ollamaUrl', 'ml-cw-ollamaKey');
    bindDraft('ml-cw-ollamaUrl', 'ollamaUrl');
    bindDraft('ml-cw-ollamaKey', 'ollamaKey');
  }

  /** Mantém `session.draft[key]` sincronizado com o que está de fato digitado no campo, a cada
   *  tecla — nunca via `render()` (que reconstrói o <input> do zero a partir de configStore/
   *  evidence e destruiria justamente o valor que ainda não foi confirmado). Todo render*() que
   *  tem campo de texto/senha usa isto; todo test*()/confirm*() lê de `session.draft`, nunca do
   *  DOM ou de configStore, então a ordem entre "ler o valor" e "mostrar carregando" deixa de
   *  importar — o valor já está capturado desde a primeira tecla. */
  function bindDraft(id, key) {
    document.getElementById(id)?.addEventListener('input', e => { session.draft[key] = e.target.value; });
  }

  /** Zera `evidence`/`configError` assim que o usuário edita um campo de conexão já testado —
   *  evita "Próximo" liberado com uma configuração diferente da que foi de fato validada.
   *  Reaproveitado por Ollama e Custom (mesmo risco, mesma correção, não duplicada por família). */
  function invalidateEvidenceOnEdit(...inputIds) {
    if (!session.evidence.configOk) return; // nada testado ainda — nada a invalidar
    inputIds.forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        if (!session.evidence.configOk) return;
        session = { ...session, evidence: {} };
        configError = '';
        render();
      }, { once: true });
    });
  }

  async function testOllamaConnection() {
    if (busy) return;
    // Lido de session.draft, NUNCA do DOM depois daqui — achado ao vivo (QA final, 2026-08-23):
    // render() (linha abaixo, pra mostrar "Testando...") reconstrói o <input> do zero a partir de
    // configStore, ANTES do valor digitado ser lido — ler o DOM depois disso já lia de volta o
    // <input> recém-recriado com o valor ANTIGO, não o que a pessoa acabou de digitar. session.draft
    // é atualizado a cada tecla (bindDraft), então já está correto não importa quando render() rodar.
    const url = (session.draft.ollamaUrl ?? '').trim() || DEFAULT_OLLAMA_URL;
    const key = (session.draft.ollamaKey ?? '').trim() || undefined;
    busy = true;
    configError = '';
    render();
    try {
      // Decisão confirmada (Fase B, correção de save): só grava porque o usuário clicou em
      // "Testar conexão", não a cada tecla digitada.
      configStore.set('ollamaUrl', url);
      if (session.ollamaMode === 'cloud' && key) configStore.set('ollamaApiKey', key);
      await doSave();
      if (destroyed) return;
      await loadProviders(true);
      if (destroyed) return;
      const health = providersStore.get('health') || [];
      const entry = health.find(h => h.provider === 'ollama');
      if (entry?.online) {
        session = { ...session, evidence: { configOk: true, modelCount: entry.modelCount || 0 } };
      } else {
        session = { ...session, evidence: {} };
        configError = entry?.error || t('ml_cw_ollama_offline_generic');
      }
    } catch (err) {
      if (destroyed) return;
      session = { ...session, evidence: {} };
      configError = err.message;
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  // Achado pelo /qa leigo (C4.5, 2026-08-23): a lista misturava modelos de chat com
  // nomic-embed-text:v1.5 (só embedding, não conversa) sem nenhuma distinção — um leigo podia
  // selecionar um modelo incapaz de conversar sem nenhum aviso. Reaproveita o mesmo filtro que
  // ModelosView.js:renderCategoryPicker() já usa pra categoria "chat" (CATEGORY_CAPABILITY.chat =
  // 'chat'): `capabilities` vem real do Ollama (/api/tags, via mapOllamaCapabilities() em
  // OllamaProvider.discoverModels()) — nunca regex em nome de modelo.
  function ollamaModelList() {
    const catalog = providersStore.get('catalog') || [];
    const chatCapable = m => m.capabilities?.includes('chat');
    const local = catalog.filter(m => m.provider === 'ollama' && chatCapable(m));
    if (session.ollamaMode !== 'cloud') return local;
    // Cloud: além do que o daemon já conhece (`local`, que pode incluir modelos :cloud já usados
    // antes), soma o catálogo remoto completo (mesma fonte que a aba Registry já usa no toggle
    // "Cloud") — sem isso, a lista mostraria só o que já foi usado, não o que está disponível.
    const cloud = (session.evidence.cloudCatalog || []).filter(chatCapable);
    const seen = new Set(local.map(m => m.id));
    return [...local, ...cloud.filter(m => !seen.has(m.id))];
  }

  function renderOllamaModelSelect(el) {
    const models = ollamaModelList();
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_ollama_models_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_ollama_models_hint')}</div>
      <div id="ml-cw-ollamaModelList" style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;"></div>
      ${models.length === 0 ? `<div class="form-hint" style="margin-top:8px;">${t('ml_cw_ollama_models_empty')}</div>` : ''}`;
    const list = document.getElementById('ml-cw-ollamaModelList');
    models.forEach(m => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `btn btn-sm ${session.selectedModel?.id === m.id ? 'btn-primary' : 'btn-ghost'}`;
      row.style.cssText = 'justify-content:flex-start;text-align:left;';
      row.textContent = m.id;
      row.addEventListener('click', () => {
        session = { ...session, selectedModel: { id: m.id, provider: 'ollama' } };
        render();
      });
      list.appendChild(row);
    });

    // Cloud: busca o catálogo remoto uma vez por entrada nesta etapa (mesma API que a aba
    // Registry já usa) — não bloqueia a etapa, só enriquece a lista quando chegar.
    if (session.ollamaMode === 'cloud' && !session.evidence.cloudCatalog && !session.evidence.cloudCatalogLoading) {
      session.evidence.cloudCatalogLoading = true;
      getCloudCatalog().then(models => {
        if (destroyed || session.currentStep !== 'ollamaModelSelect') return;
        session = { ...session, evidence: { ...session.evidence, cloudCatalog: models, cloudCatalogLoading: false } };
        render();
      }).catch(() => {
        if (destroyed) return;
        session = { ...session, evidence: { ...session.evidence, cloudCatalog: [], cloudCatalogLoading: false } };
      });
    }
  }

  async function confirmOllamaModelSelection() {
    if (busy) return;
    busy = true;
    render();
    try {
      if (session.selectedModel) {
        // Decisão confirmada — grava o par modelo+provider junto (regra 6 da Fase B: nunca só o
        // nome do modelo). O auto-pull de `doSave()` (app.js) já cobre um modelo Ollama ainda não
        // instalado — não duplicamos essa lógica aqui.
        //
        // applyDefaultProviderChange(), não configStore.set() direto: achado da investigação de
        // C4 (2026-08-23) — só essa função realinha modelRouter contra o catálogo real
        // (realignRouterToProvider()), a mesma proteção que teria evitado o 400 encontrado ao vivo
        // no C2 (nome de arquivo tratado como tag Ollama). Setar defaultProvider na mão, como este
        // código fazia antes, contornava essa proteção já existente.
        applyDefaultProviderChange('ollama');
        const router = { ...(configStore.get('modelRouter') || {}) };
        router.chat = session.selectedModel.id;
        configStore.set('modelRouter', router);
        await doSave();
        if (destroyed) return;
        // Achado ao vivo pelo /qa leigo (C4.5, 2026-08-23): sem isto, a Visão Geral (barra de
        // status acima do Wizard) ficava mostrando o provider ANTIGO com a faixa "Alteração ainda
        // não salva" mesmo depois do doSave() já ter persistido — não é bug de persistência, é
        // falta de invalidação. loadProviders(true) atualiza providersStore, que já dispara
        // updateOverview() via providersStore.on('*', ...) em ModelosView.js — o MESMO mecanismo
        // que confirmCustomEntry() (C3) e loadLocalModel() (C4) já usam depois do próprio doSave().
        // Esta era a única confirmação do Wizard sem essa chamada.
        await loadProviders(true);
        if (destroyed) return;
      }
      session = next(session);
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function renderCustomEndpoint(el) {
    // Mesmo achado do Local/Ollama: semeia o draft com o que já estava preenchido (reconfigurar um
    // provider já existente) — senão clicar "Testar conexão" sem editar nada leria campos vazios.
    session.draft.customLabel ??= session.customLabel ?? '';
    session.draft.customUrl ??= session.evidence.baseUrl ?? '';
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_custom_endpoint_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_custom_endpoint_hint')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;" id="ml-cw-customPresets"></div>
      <div class="form-group">
        <label class="form-label" for="ml-cw-customLabel">${t('ml_cw_custom_label_label')}</label>
        <input type="text" class="form-input" id="ml-cw-customLabel" value="${esc(session.draft.customLabel ?? session.customLabel ?? '')}">
      </div>
      <div class="form-group" style="margin-top:8px;">
        <label class="form-label" for="ml-cw-customUrl">${t('ml_cw_custom_url_label')}</label>
        <input type="text" class="form-input" id="ml-cw-customUrl" value="${esc(session.draft.customUrl ?? session.evidence.baseUrl ?? '')}" placeholder="http://localhost:1234/v1">
      </div>
      <div class="form-group" style="margin-top:8px;">
        <label class="form-label" for="ml-cw-customKey">${t('ml_cw_custom_key_label')}</label>
        <input type="password" class="form-input" id="ml-cw-customKey" value="${esc(session.draft.customKey ?? '')}">
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="ml-cw-customTest" style="margin-top:10px;" ${busy ? 'disabled' : ''}>
        ${busy ? t('ml_cw_testing') : t('ml_cw_test_connection_btn')}
      </button>
      ${session.evidence.configOk ? `<div class="form-hint" style="margin-top:8px;color:var(--success,#2ecc71);">✓ ${t('ml_cw_custom_connected', { count: session.evidence.models?.length ?? 0 })}</div>` : ''}
      ${configError ? `<div class="form-hint" style="margin-top:8px;color:var(--error,#e74c3c);">❌ ${esc(configError)}</div>` : ''}`;

    // Presets — mesma lista/dado que a aba Adicionar Modelo já usa (CUSTOM_PROVIDER_PRESETS,
    // referenciada por `customPresets`), mesmo comportamento de preencher label+baseUrl juntos.
    const presetsEl = document.getElementById('ml-cw-customPresets');
    (customPresets || []).forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = p.label;
      chip.addEventListener('click', () => {
        document.getElementById('ml-cw-customLabel').value = p.label;
        document.getElementById('ml-cw-customUrl').value = p.baseUrl;
        // .value= não dispara 'input' sozinho — sem isto, session.draft ficaria dessincronizado
        // do que a tela mostra assim que qualquer coisa forçasse um render() (ex.: erro depois).
        session.draft.customLabel = p.label;
        session.draft.customUrl = p.baseUrl;
        if (session.evidence.configOk) {
          session = { ...session, evidence: {} };
          configError = '';
          render();
        }
      });
      presetsEl.appendChild(chip);
    });

    document.getElementById('ml-cw-customTest')?.addEventListener('click', testCustomEndpoint);
    invalidateEvidenceOnEdit('ml-cw-customLabel', 'ml-cw-customUrl', 'ml-cw-customKey');
    bindDraft('ml-cw-customLabel', 'customLabel');
    bindDraft('ml-cw-customUrl', 'customUrl');
    bindDraft('ml-cw-customKey', 'customKey');
  }

  async function testCustomEndpoint() {
    if (busy) return;
    // Lido de session.draft — mesmo motivo do Ollama (bindDraft já mantém isto correto tecla a
    // tecla, independente de quando render() reconstruir o formulário).
    const label = (session.draft.customLabel ?? '').trim();
    const url = (session.draft.customUrl ?? '').trim();
    const key = (session.draft.customKey ?? '').trim();
    if (!label || !url) {
      configError = t('ml_cw_custom_label_required');
      render();
      return;
    }
    busy = true;
    configError = '';
    render();
    try {
      // Não persiste nada (mesmo endpoint que a aba Adicionar Modelo usa pra testar antes de
      // cadastrar) — evidência, não decisão. A decisão (add/editCustomProvider) só acontece em
      // confirmCustomEntry(), ao avançar da etapa seguinte com um modelo escolhido ou não.
      const result = await testCustomProvider({ baseUrl: url, apiKey: key || undefined });
      if (destroyed) return;
      if (result.online) {
        session = { ...session, customLabel: label, evidence: { configOk: true, baseUrl: url, apiKey: key, models: result.models || [] } };
      } else {
        session = { ...session, evidence: {} };
        configError = result.error || t('ml_cw_custom_offline_generic');
      }
    } catch (err) {
      if (destroyed) return;
      session = { ...session, evidence: {} };
      configError = err.message;
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function renderCustomModelSelect(el) {
    const models = session.evidence.models || [];
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_custom_models_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_custom_models_hint')}</div>
      <div id="ml-cw-customModelList" style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;"></div>
      ${models.length === 0 ? `<div class="form-hint" style="margin-top:8px;">${t('ml_cw_custom_models_empty')}</div>` : ''}`;
    const list = document.getElementById('ml-cw-customModelList');
    models.forEach(id => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `btn btn-sm ${session.selectedModel?.id === id ? 'btn-primary' : 'btn-ghost'}`;
      row.style.cssText = 'justify-content:flex-start;text-align:left;';
      row.textContent = id;
      row.addEventListener('click', () => {
        session = { ...session, selectedModel: { id, provider: session.customLabel } };
        render();
      });
      list.appendChild(row);
    });
  }

  async function confirmCustomEntry() {
    if (busy) return;
    busy = true;
    render();
    try {
      // Mesma identidade que a aba Adicionar Modelo já usa: se já existe um provider com esta
      // label, EDITA em vez de tentar ADICIONAR (que devolveria 400 "já existe") — mesma regra
      // que o formulário clássico aplica via `editingProviderLabel`, só que decidida aqui a partir
      // do que já está salvo, sem exigir um modo de edição na UI. `customProviders` mora em
      // `configStore` (confirmado em app.js/state.js), NUNCA em `providersStore` — achado ao vivo
      // 2026-08-23: ler da loja errada fazia a checagem nunca encontrar nada, e reconfigurar o
      // mesmo provider sempre tentava ADD de novo, batendo em 400 "já existe".
      const existing = (configStore.get('customProviders') || []).find(p => p.label === session.customLabel);
      const payload = {
        baseUrl: session.evidence.baseUrl,
        apiKey: session.evidence.apiKey || undefined,
        model: session.selectedModel?.id,
      };
      if (existing) {
        await editCustomProvider(session.customLabel, payload);
      } else {
        await addCustomProvider({ label: session.customLabel, ...payload });
      }
      if (destroyed) return;
      // Atualiza SÓ configStore.customProviders com o que o servidor tem de verdade agora — não
      // reconstrói a entrada localmente (divergiria do formato real) e, de propósito, não chama
      // loadConfig() (a função que o boot usa): ela faz `configStore.patch()` do config INTEIRO,
      // o que descartaria qualquer edição não salva que o usuário tenha em outra aba do painel
      // nesse meio-tempo. Só o campo que este fluxo realmente mudou é atualizado.
      const fresh = await getConfig();
      if (destroyed) return;
      configStore.set('customProviders', fresh.customProviders || []);
      // Decisão confirmada — assim como em Ollama, escolher/confirmar aqui é a declaração de que
      // este é o provider que o usuário quer usar pra conversar. applyDefaultProviderChange(), não
      // configStore.set() direto — mesmo motivo do Ollama (ver comentário em
      // confirmOllamaModelSelection): realinha modelRouter contra o catálogo real em vez de deixar
      // nomes de outro provider presos em categorias que agora apontam pra este.
      applyDefaultProviderChange(session.customLabel);
      if (session.selectedModel) {
        const router = { ...(configStore.get('modelRouter') || {}) };
        router.chat = session.selectedModel.id;
        configStore.set('modelRouter', router);
      }
      await doSave();
      if (destroyed) return;
      await loadProviders(true);
      if (destroyed) return;
      session = next(session);
    } catch (err) {
      if (destroyed) return;
      configError = err.message;
      session = { ...session, currentStep: 'customEndpoint', evidence: {} };
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function renderLocalFolder(el) {
    if (browseState) { renderDirectoryBrowsePanel(el); return; }
    const currentDir = session.evidence.dir || configStore.get('localModelsDir') || '';
    // Achado ao vivo (2026-08-23, logo após enviar a Sprint FQ pro ambiente real): session.draft só
    // era preenchido quando o usuário DIGITAVA num campo (evento 'input') — um campo pré-preenchido
    // pelo próprio sistema (pasta já salva de uma configuração anterior) nunca dispara esse evento,
    // então session.draft.localDir ficava undefined mesmo com o campo visualmente preenchido. Clicar
    // "Buscar modelos" sem antes editar o campo lia um valor vazio e não fazia nada, travando
    // silenciosamente o avanço — exatamente o cenário de quem já tinha a pasta certa configurada.
    // `??=` só semeia se ainda não houver draft (não sobrescreve o que o usuário já digitou).
    session.draft.localDir ??= currentDir;
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_wizard_step1_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_wizard_step1_hint')}</div>
      <div class="form-group">
        <label class="form-label" for="ml-cw-localDir">${t('ml_local_dir_label')}</label>
        <div style="display:flex;gap:6px;">
          <input type="text" class="form-input" id="ml-cw-localDir" placeholder="${t('ml_local_dir_placeholder')}" value="${esc(session.draft.localDir ?? currentDir)}" style="flex:1;">
          <button type="button" class="btn btn-ghost btn-sm" id="ml-cw-localBrowse" title="${t('ml_cw_browse_hint')}" ${busy ? 'disabled' : ''}>📁 ${t('ml_cw_browse_btn')}</button>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="ml-cw-localScan" style="margin-top:10px;" ${busy ? 'disabled' : ''}>
        ${busy ? t('ml_cw_testing') : t('ml_local_scan_btn')}
      </button>
      ${session.evidence.configOk ? `<div class="form-hint" style="margin-top:8px;color:var(--success,#2ecc71);">✓ ${t('ml_cw_local_scanned', { count: session.evidence.models?.length ?? 0 })}</div>` : ''}
      ${configError ? `<div class="form-hint" style="margin-top:8px;color:var(--error,#e74c3c);"><code>${esc(configError)}</code></div>` : ''}`;

    document.getElementById('ml-cw-localScan')?.addEventListener('click', testLocalFolder);
    document.getElementById('ml-cw-localBrowse')?.addEventListener('click', openDirectoryPicker);
    document.getElementById('ml-cw-localDir')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('ml-cw-localScan')?.click();
    });
    invalidateEvidenceOnEdit('ml-cw-localDir');
    bindDraft('ml-cw-localDir', 'localDir');
  }

  /**
   * Ponto único de entrada do Directory Picker (campanha FP–FP.6.3) — o Wizard nunca sabe se o
   * resultado veio de um diálogo nativo do SO ou do painel web; só reage a `session.draft.localDir`
   * ter mudado. Tenta nativo só se a política do ambiente permitir E a preferência não for 'web'
   * (`configStore.get('directoryPicker')`, vindo de GET /api/config — nunca uma sondagem própria
   * daqui). `unavailable` cai pro painel web em silêncio, sem expor o motivo ao usuário — a razão
   * interna existe só pra log/diagnóstico do lado do servidor.
   */
  async function openDirectoryPicker() {
    if (busy) return;
    const hint = (session.draft.localDir ?? '').trim();
    const dp = configStore.get('directoryPicker') || {};
    if (dp.policyAllowed && dp.preference !== 'web') {
      busy = true;
      render();
      try {
        const outcome = await triggerNativeDirectoryPicker(hint);
        if (destroyed) return;
        if (outcome.kind === 'selected') {
          session.draft.localDir = outcome.path;
          busy = false;
          await testLocalFolder();
          return;
        }
        if (outcome.kind === 'cancelled') {
          busy = false;
          render();
          return;
        }
        // outcome.kind === 'unavailable' — cai pro painel web abaixo, sem tratamento especial.
      } catch {
        // Falha de rede/inesperada na tentativa nativa — mesma regra: cai pro painel web em
        // silêncio, em vez de mostrar um erro técnico sobre um mecanismo interno.
      } finally {
        busy = false;
      }
    }
    await openWebBrowsePanel(hint);
  }

  async function openWebBrowsePanel(hint) {
    busy = true;
    render();
    try {
      const listing = await browseLocalDirectory({ hint });
      if (destroyed) return;
      browseState = listing;
    } catch (err) {
      if (destroyed) return;
      configError = err.message;
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  /** Navega dentro da MESMA sessão de painel — sempre reenvia o `hint` original (nunca o `dir`
   *  atual como se fosse um novo hint), porque é o `hint` original que fixa a raiz/teto no backend
   *  (`resolveEffectiveRoot`/`ceilingFor`); reenviar o `dir` atual como hint deixaria a fronteira
   *  "andar junto" com a navegação, na prática eliminando o teto. */
  async function navigateBrowsePanel(dir) {
    if (busy || !browseState || !dir) return;
    busy = true;
    render();
    try {
      const listing = await browseLocalDirectory({ hint: session.draft.localDir, dir });
      if (destroyed) return;
      browseState = listing;
    } catch (err) {
      if (destroyed) return;
      configError = err.message;
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function closeBrowsePanel() {
    browseState = null;
    render();
  }

  async function confirmBrowsePanel() {
    if (!browseState) return;
    session.draft.localDir = browseState.dir;
    browseState = null;
    await testLocalFolder();
  }

  function renderDirectoryBrowsePanel(el) {
    const st = browseState;
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_browse_title')}</div>
      <div class="form-hint" style="margin:6px 0 10px;"><code>${esc(st.dir)}</code></div>
      <div id="ml-cw-browseList" style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;margin-bottom:10px;"></div>
      ${st.subdirs.length === 0 && !st.error ? `<div class="form-hint" style="margin-bottom:10px;">${t('ml_cw_browse_empty')}</div>` : ''}
      ${st.error ? `<div class="form-hint" style="margin-bottom:10px;color:var(--error,#e74c3c);">❌ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <button type="button" class="btn btn-ghost btn-sm" id="ml-cw-browseCancel" ${busy ? 'disabled' : ''}>${t('ml_cw_btn_cancel')}</button>
        <div style="display:flex;gap:8px;">
          ${st.canGoUp ? `<button type="button" class="btn btn-ghost btn-sm" id="ml-cw-browseUp" ${busy ? 'disabled' : ''}>↑ ${t('ml_cw_browse_up')}</button>` : ''}
          <button type="button" class="btn btn-primary btn-sm" id="ml-cw-browseUse" ${busy ? 'disabled' : ''}>${t('ml_cw_browse_use')}</button>
        </div>
      </div>`;
    // DOM via createElement/textContent, não innerHTML de string — mesma disciplina que
    // renderLocalModelSelect já aplica pra nome de arquivo vindo do disco (CodeQL #14): nome de
    // pasta também vem de fs.readdirSync, nunca confiável como HTML.
    const list = document.getElementById('ml-cw-browseList');
    st.subdirs.forEach(d => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'btn btn-ghost btn-sm';
      row.style.cssText = 'justify-content:flex-start;text-align:left;width:100%;';
      row.textContent = `📁 ${d.name}`;
      row.disabled = busy;
      row.addEventListener('click', () => navigateBrowsePanel(d.path));
      list.appendChild(row);
    });
    document.getElementById('ml-cw-browseCancel')?.addEventListener('click', closeBrowsePanel);
    document.getElementById('ml-cw-browseUp')?.addEventListener('click', () => navigateBrowsePanel(st.parent));
    document.getElementById('ml-cw-browseUse')?.addEventListener('click', confirmBrowsePanel);
  }

  async function testLocalFolder() {
    if (busy) return;
    // Lido de session.draft — mesmo motivo do Ollama/Custom.
    const dir = (session.draft.localDir ?? '').trim();
    if (!dir) return;
    busy = true;
    configError = '';
    render();
    try {
      const r = await getLocalModels(dir);
      if (destroyed) return;
      if (r.error) {
        configError = r.error;
        session = { ...session, evidence: {} };
      } else {
        // Buscar com sucesso É a declaração "esta é a minha pasta" — mesmo critério que
        // LocalModelWizard.js já usa (saveDirAndRefresh), reaplicado aqui: persiste mesmo se
        // faltar o binário logo abaixo, porque a pasta em si já foi confirmada como válida.
        configStore.set('localModelsDir', dir);
        await doSave();
        if (destroyed) return;
        if (!r.serverBinary) {
          configError = `${t('ml_local_nobinary_title')} — ${t('ml_local_nobinary_hint')}`;
          session = { ...session, evidence: {} };
        } else {
          // Pasta válida SEM nenhum .gguf ainda é um resultado válido de busca (não um erro) —
          // avança pra próxima etapa, que mostra o estado vazio (mesmo padrão já usado em Custom
          // pra catálogo vazio: não travar aqui por falta de conteúdo, só por falha real).
          session = { ...session, evidence: { configOk: true, dir, models: r.models || [] } };
        }
      }
    } catch (err) {
      if (destroyed) return;
      configError = err.message;
      session = { ...session, evidence: {} };
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function renderLocalModelSelect(el) {
    const models = session.evidence.models || [];
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_wizard_step_load_title')}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_wizard_step_load_hint')}</div>
      <div id="ml-cw-localModelList" style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;"></div>
      ${models.length === 0 ? `<div class="form-hint" style="margin-top:8px;"><code>${esc(session.evidence.dir || '')}</code><br>${t('ml_local_empty')}</div>` : ''}
      ${configError ? `<div class="form-hint" style="margin-top:8px;color:var(--error,#e74c3c);">❌ ${esc(configError)}</div>` : ''}`;
    const list = document.getElementById('ml-cw-localModelList');
    // Renderização via LocalModelPickList.js, compartilhada com LocalModelWizard.js (mesma
    // disciplina de DOM via createElement/textContent que já corrigiu o CodeQL #14 — ver docstring
    // do módulo pra por que essa duplicação específica valia a pena eliminar).
    renderModelPickList(list, models, id => loadLocalModel(id));
  }

  function renderLocalLoading(el) {
    const elapsed = session.evidence.loadStartedAt ? Math.floor((Date.now() - session.evidence.loadStartedAt) / 1000) : 0;
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_local_serving')} ${esc(session.selectedModel?.id || '')}</div>
      <div class="form-hint" style="margin:8px 0;">${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}</div>`;
  }

  /** Mandatório pra esta família (ao contrário de Ollama/Custom): um servidor local sempre serve
   *  UM arquivo específico, não existe "pular e usar o padrão" — por isso o clique na linha já É
   *  a confirmação, sem um "Próximo" intermediário (mesma UX que LocalModelWizard.js já usa). */
  async function loadLocalModel(file) {
    if (busy) return;
    busy = true;
    configError = '';
    session = { ...session, selectedModel: { id: file, provider: 'local' }, currentStep: 'localLoading', evidence: { ...session.evidence, loadStartedAt: Date.now() } };
    render();
    const tickTimer = setInterval(() => { if (!destroyed && session.currentStep === 'localLoading') render(); }, 1000);
    try {
      const r = await serveLocalModel(file);
      if (destroyed) return;
      await ensureLocalProvider(r.url, file);
      if (destroyed) return;
      await loadProviders(true);
      if (destroyed) return;
      // NÃO usar next(session) aqui: essa transição é programática (guiada pelo carregamento real
      // ter terminado), não pelo botão "Próximo" genérico — canAdvance('localLoading') é `false`
      // de propósito (não existe navegação manual nesta etapa), então next() a trataria como
      // bloqueada e devolveria a sessão sem avançar. Achado ao vivo (2026-08-23): o carregamento
      // terminava de verdade (confirmado pelo log de rede) mas a tela ficava presa em "Carregando…".
      session = { ...session, currentStep: 'conclusion' };
    } catch (err) {
      if (destroyed) return;
      configError = err.message === 'no_server_binary' ? t('ml_local_nobinary_title') : err.message;
      session = { ...session, currentStep: 'localModelSelect' };
    } finally {
      clearInterval(tickTimer);
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  function renderConclusion(el) {
    const display = session.provider ? getProviderDisplay(session.provider, { cloudProviders, provLabels, localProviderLabel }) : null;
    // Custom: mostra a label específica que o usuário configurou ("LM Studio", "meu servidor"),
    // não o rótulo genérico "Outro / OpenAI-Compatible" da Tela 1 — é a identidade real salva.
    const title = session.family === 'custom' && session.customLabel
      ? `${CUSTOM_ICON} ${esc(session.customLabel)}`
      : (display ? `${display.icon} ${display.label}` : '');
    const ready = typeof computeSystemReady === 'function' ? computeSystemReady() : false;
    const model = session.selectedModel?.id || configStore.salvo('modelRouter')?.chat || configStore.salvo('ollamaModel') || '';
    // Custom sem modelo escolhido é diferente de um nativo sem modelo escolhido: o fallback
    // 'default' (ProviderFactory.ts) só funciona de verdade em servidores de modelo único
    // (llamafile) — um servidor real com vários modelos (LM Studio, vLLM, OpenAI oficial) rejeita
    // um id "default" que não existe. Por isso aqui NÃO se afirma "vai funcionar", ao contrário do
    // texto que uma família com fallback confiável (nativos) teria — honestidade sobre o que não
    // foi verificado (Nunca Adivinhar), não uma reprovação: pode ser exatamente o caso certo.
    const customNoModelCaveat = session.family === 'custom' && !model
      ? `<div class="form-hint" style="margin-top:6px;">⚠️ ${t('ml_cw_custom_no_model_caveat')}</div>`
      : '';
    el.innerHTML = `
      <div class="ml-test-title">${title}</div>
      <div class="form-hint" style="margin:8px 0;">
        ${ready ? `✓ ${t('ml_cw_conclusion_ready')}` : `⏳ ${t('ml_cw_conclusion_confirming')}`}
      </div>
      ${model ? `<div class="form-hint">${t('ml_cw_conclusion_model', { model: esc(model) })}</div>` : ''}
      ${customNoModelCaveat}
      <button type="button" class="btn btn-ghost btn-sm" id="ml-cw-finish" style="margin-top:10px;">${t('ml_cw_btn_finish')}</button>`;
    document.getElementById('ml-cw-finish')?.addEventListener('click', () => {
      session = createWizardSession();
      render();
    });
  }

  /** Coleta a API key do provider nativo escolhido (Gemini/DeepSeek/Groq/OpenRouter/Anthropic).
   *  Sem "Testar conexão" separado (diferente de Ollama/Custom): investigação de C5 confirmou que
   *  não existe como verificar uma key nativa sem persisti-la primeiro — ProviderFactory só
   *  registra os 5 nativos com a key vinda do config no construtor OU via updateCredential()
   *  (chamado por POST /api/config, o mesmo doSave() de sempre). A verificação real é o próprio
   *  discovery depois do save — por isso um único botão faz salvar+verificar juntos, e
   *  canAdvance('credential') não tem caso próprio (a transição pra 'validating' é sempre
   *  programática, nunca pelo "Próximo" genérico — mesmo motivo do 'localLoading' em C4). */
  function renderCredential(el) {
    const cp = (cloudProviders || []).find(c => c.key === session.provider);
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_native_credential_title', { name: cp?.name || session.provider })}</div>
      <div class="form-hint" style="margin:6px 0 12px;">${t('ml_cw_native_credential_hint')}</div>
      <div class="form-group">
        <label class="form-label" for="ml-cw-nativeKey">${t('ml_apikey_label')}</label>
        <input type="password" class="form-input" id="ml-cw-nativeKey" value="${esc(session.draft.nativeKey ?? '')}" placeholder="${esc(cp?.placeholder || '')}">
      </div>
      <button type="button" class="btn btn-primary btn-sm" id="ml-cw-nativeVerify" style="margin-top:10px;" ${busy ? 'disabled' : ''}>
        ${busy ? t('ml_cw_testing') : t('ml_cw_native_verify_btn')}
      </button>
      ${configError ? `<div class="form-hint" style="margin-top:8px;color:var(--error,#e74c3c);">❌ ${esc(configError)}</div>` : ''}`;
    document.getElementById('ml-cw-nativeVerify')?.addEventListener('click', confirmNativeCredential);
    bindDraft('ml-cw-nativeKey', 'nativeKey');
  }

  function renderValidating(el) {
    el.innerHTML = `
      <div class="ml-test-title">${t('ml_cw_native_validating_title')}</div>
      <div class="form-hint" style="margin:8px 0;">${t('ml_cw_native_validating_hint')}</div>`;
  }

  async function confirmNativeCredential() {
    if (busy) return;
    // Lido de session.draft — mesmo motivo do Ollama/Custom/Local: render() (linha abaixo, pra
    // mostrar a etapa 'validating') reconstrói o formulário inteiro; ler o DOM depois leria de
    // volta o campo já recriado, não o que foi digitado.
    const value = (session.draft.nativeKey ?? '').trim();
    if (!value) return;
    busy = true;
    configError = '';
    session = { ...session, currentStep: 'validating' };
    render();
    try {
      // 1ª fase: salva a key. Isso já persiste E hot-registra o provider no servidor
      // (ProviderFactory.updateCredential(), chamado dentro da própria rota POST /api/config) —
      // sem isto, discoverModels() não teria nada pra descobrir.
      configStore.set(`${session.provider}Key`, value);
      await doSave();
      if (destroyed) return;
      // 2ª fase: descobre de verdade. loadProviders(true) já dispara o mesmo
      // providersStore.on('*', ...) que atualiza a Visão Geral (mesma correção do ISSUE-001/C4.5).
      await loadProviders(true);
      if (destroyed) return;
      const health = providersStore.get('health') || [];
      const entry = health.find(h => h.provider === session.provider);
      if (entry?.online) {
        // Só troca o provider padrão DEPOIS de confirmar que a key funciona — ao contrário de
        // Ollama/Custom (que já chegam aqui com uma conexão pré-testada), uma key nativa nunca foi
        // testada antes deste ponto. Setar defaultProvider antes da confirmação deixaria o sistema
        // apontado pra um provider quebrado até o usuário perceber e corrigir.
        applyDefaultProviderChange(session.provider);
        await doSave();
        if (destroyed) return;
        // Achado da investigação de C5: computeSystemReady() exige `cs.salvo('currentModel')` não
        // vazio, mas nem doSave() nem loadProviders(true) atualizam esse campo — ele só vem de um
        // GET /api/config completo. Mesma disciplina de C3 (confirmCustomEntry()): busca só o
        // config fresco e atualiza SÓ currentModel, nunca configStore.patch() do objeto inteiro
        // (que descartaria edição não salva em outra aba). computeSystemReady() continua intocado —
        // só os dados que ele já lia foram atualizados.
        const fresh = await getConfig();
        if (destroyed) return;
        configStore.set('currentModel', fresh.currentModel);
        session = { ...session, currentStep: 'conclusion' };
      } else {
        configError = entry?.error || t('ml_cw_native_offline_generic');
        session = { ...session, currentStep: 'credential' };
      }
    } catch (err) {
      if (destroyed) return;
      configError = err.message;
      session = { ...session, currentStep: 'credential' };
    } finally {
      if (destroyed) return;
      busy = false;
      render();
    }
  }

  /** Placeholder das etapas ainda não conectadas — nenhuma família tem mais placeholder desde C5,
   *  fica como retaguarda defensiva pra qualquer estado inesperado (não deveria ser alcançável). */
  function renderStub(el) {
    const display = session.provider ? getProviderDisplay(session.provider, { cloudProviders, provLabels, localProviderLabel }) : null;
    el.innerHTML = `
      <div class="ml-test-title">🚧 ${t('ml_cw_wip_title')}</div>
      <div class="form-hint" style="margin:6px 0;">
        ${display ? esc(`${display.icon} ${display.label} — `) : ''}${esc(session.currentStep)}
      </div>
      <div class="form-hint">${t('ml_cw_wip_hint')}</div>`;
  }

  render();

  // Enquanto a tela de Conclusão estiver aberta, recalcula quando o polling de saúde já em
  // andamento trouxer novidade (ex.: um pull em segundo plano do auto-pull de doSave() termina) —
  // mesmo mecanismo já validado ao vivo no LocalModelWizard.js, reaproveitado aqui, não copiado.
  const unsubHealth = providersStore.on('*', () => {
    if (!destroyed && session.currentStep === 'conclusion') render();
  });

  return () => { destroyed = true; unsubHealth(); };
}

export { PROVIDER_CAPABILITIES, PROVIDER_ORDER, FAMILY_STEPS, hasDefaultModel, createWizardSession, next, back, canAdvance };
