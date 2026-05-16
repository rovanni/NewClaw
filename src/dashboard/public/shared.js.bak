/* newclaw-shared.js - Unified theme, nav, header for all pages */

const NEWCLAW_KEY = 'newclaw_';

// i18n State
const TRANSLATIONS = {
  'pt-BR': {
    chat: "💬 Chat",
    config: "⚙️ Config",
    traces: "🧠 Traces",
    memory: "💾 Memória",
    graph: "🕸️ Grafo",
    review: "🧪 Revisão",
    help: "❓ Ajuda",
    theme_toggle: "Alternar Tema",
    lang_toggle: "Mudar Idioma",

    // Chat status
    status_thinking: "🤔 Pensando...",
    status_sending: "📡 Enviando...",
    status_receiving: "📥 Recebendo resposta...",
    status_processing: "⚙️ Processando...",
    status_tool: "🔧 Executando ferramenta...",
    status_error: "❌ Erro",
    status_bar_model: "Modelo",
    status_bar_uptime: "Uptime",
    status_bar_memory: "Memória",

    // Chat
    conv_sidebar_title: "📋 Conversas",
    new_conv: "+ Nova",
    mic_title: "Falar",
    msg_placeholder: "Digite sua mensagem...",
    tts_title: "Ouvir respostas",
    send_title: "Enviar",

    // Memory
    memory_search_title: "🔍 Buscar na Memória",
    memory_search_placeholder: "Buscar nós por nome ou conteúdo...",
    search: "Buscar",
    detail_title: "📄 Detalhe",
    select_node_detail: "Selecione um nó para ver detalhes",

    // Config
    status_title: "📊 Status",
    model_title: "🤖 Modelo LLM",
    provider_label: "Provedor",
    ollama_model_label: "Modelo Ollama",
    ollama_models_label: "Modelos Disponíveis",
    ollama_pull_label: "Baixar Modelo",
    ollama_url_label: "Ollama URL",
    ollama_key_label: "Ollama API Key (cloud)",
    lang_label: "Idioma",
    iterations_label: "Iterações Máximas",
    memory_window_label: "Janela de Memória",
    keys_title: "🔑 Outros Provedores",
    system_prompt_title: "💬 System Prompt",
    system_prompt_label: "Instruções do Sistema",
    tools_title: "🛠️ Ferramentas",
    save_btn: "💾 Salvar",
    restart_btn: "🔄 Salvar & Reiniciar",
    reset_btn: "🔄 Resetar",

    // Traces
    traces_title: "📋 Execuções (Traces)",
    avg_duration_label: "Duração Média",
    completed_label: "Completados",
    errors_label: "Erros",
    detail_pane_title: "🔍 Detalhe",
    waiting_msg: "Aguardando...",
    select_trace_msg: "Selecione uma execução",
    new_node: "+ No Grafo",
    back_to_controls: "❮ Voltar",
    save_success: "Salvo com sucesso!",
    delete_confirm_node: "Tem certeza que deseja deletar este nó e todas as suas relações?",
    node_name_placeholder: "Nome do nó...",
    node_content_placeholder: "Conteúdo/Descrição do nó...",

    // Graph UI
    graph_controls: "Controles do Grafo",
    node_selection: "Seleção de Nós",
    source_node: "Nó de Origem",
    target_node: "Nó de Destino",
    select_from_graph: "Selecionar no Grafo",
    relation_type: "Tipo de Relação",
    create_relation: "Criar Relação",
    remove_relation: "Remover Relação",
    center_node: "Centralizar Nó",
    graph_tools: "Ferramentas do Grafo",
    legend: "Legenda",
    search_node_placeholder: "Buscar nó...",
    all_types: "Todos",
    relation_created: "Relação criada com sucesso!",
    relation_removed: "Relação removida!",
    relation_error: "Erro na operação",
    confirm_remove: "Remover esta relação?",
    select_source_msg: "🔗 Clique no nó de ORIGEM",
    select_target_msg: "🔗 Agora clique no nó de DESTINO",
    node_count_label: "{n} nós, {e} arestas",

    // Help
    about_title: "🪐 Sobre o NewClaw",
    voice_title: "🔊 Voz",
    theme_title: "🌙 Tema",
    env_title: "⚙️ Variáveis (.env)",
    architecture_title: "🔧 Arquitetura",

    // Graph Relationships
    rel_prefers: "prefere",
    rel_works_on: "trabalha em",
    rel_belongs_to: "pertence a",
    rel_uses: "usa",
    rel_runs_on: "executa em",
    rel_related_to: "relacionado a",
    rel_depends_on: "depende de",
    rel_owns: "possui",
    rel_references: "referencia",
    rel_contains: "contém",
    rel_created: "criou",
    rel_reads: "lê",
    rel_writes: "escreve",
    rel_custom: "-- Personalizada --",

    // Node Types
    type_identity: "Identidade",
    type_preference: "Preferência",
    type_project: "Projeto",
    type_skill: "Habilidade",
    type_context: "Contexto",
    type_fact: "Fato",

    // Common
    save: "Salvar",
    cancel: "Cancelar",
    delete: "Excluir",
    loading: "Carregando...",
    error: "Erro",
    success: "Sucesso"
  },
  'en-US': {
    chat: "💬 Chat",
    config: "⚙️ Config",
    traces: "🧠 Traces",
    memory: "💾 Memory",
    graph: "🕸️ Graph",
    review: "🧪 Review",
    help: "❓ Help",
    theme_toggle: "Toggle Theme",
    lang_toggle: "Change Language",
    
    // Chat status
    status_thinking: "🤔 Thinking...",
    status_sending: "📡 Sending...",
    status_receiving: "📥 Receiving response...",
    status_processing: "⚙️ Processing...",
    status_tool: "🔧 Running tool...",
    status_error: "❌ Error",
    status_bar_model: "Model",
    status_bar_uptime: "Uptime",
    status_bar_memory: "Memory",
    
    // Chat
    conv_sidebar_title: "📋 Conversations",
    new_conv: "+ New",
    mic_title: "Speak",
    msg_placeholder: "Type your message...",
    tts_title: "Listen to responses",
    send_title: "Send",

    // Memory
    memory_search_title: "🔍 Search Memory",
    memory_search_placeholder: "Search nodes by name or content...",
    search: "Search",
    detail_title: "📄 Detail",
    select_node_detail: "Select a node to see details",

    // Config
    status_title: "📊 Status",
    model_title: "🤖 LLM Model",
    provider_label: "Provider",
    ollama_model_label: "Ollama Model",
    ollama_models_label: "Available Models",
    ollama_pull_label: "Pull Model",
    ollama_url_label: "Ollama URL",
    ollama_key_label: "Ollama API Key (cloud)",
    lang_label: "Language",
    iterations_label: "Max Iterations",
    memory_window_label: "Memory Window",
    keys_title: "🔑 Other Providers",
    system_prompt_title: "💬 System Prompt",
    system_prompt_label: "System Instructions",
    tools_title: "🛠️ Tools",
    save_btn: "💾 Save",
    restart_btn: "🔄 Save & Restart",
    reset_btn: "🔄 Reset",

    // Traces
    traces_title: "📋 Execution Traces",
    avg_duration_label: "Avg Duration",
    completed_label: "Completed",
    errors_label: "Errors",
    detail_pane_title: "🔍 Detail",
    waiting_msg: "Waiting...",
    select_trace_msg: "Select a trace",
    new_node: "+ New Node",
    back_to_controls: "❮ Back",
    save_success: "Saved successfully!",
    delete_confirm_node: "Are you sure you want to delete this node and all its relationships?",
    node_name_placeholder: "Node name...",
    node_content_placeholder: "Node content/description...",

    // Graph UI
    graph_controls: "Graph Controls",
    node_selection: "Node Selection",
    source_node: "Source Node",
    target_node: "Target Node",
    select_from_graph: "Select from Graph",
    relation_type: "Relation Type",
    create_relation: "Create Relation",
    remove_relation: "Remove Relation",
    center_node: "Center Node",
    graph_tools: "Graph Tools",
    legend: "Legend",
    search_node_placeholder: "Search node...",
    all_types: "All",
    relation_created: "Relation created successfully!",
    relation_removed: "Relation removed!",
    relation_error: "Operation error",
    confirm_remove: "Remove this relation?",
    select_source_msg: "🔗 Click the SOURCE node",
    select_target_msg: "🔗 Now click the TARGET node",
    node_count_label: "{n} nodes, {e} edges",

    // Help
    about_title: "🪐 About NewClaw",
    voice_title: "🔊 Voice",
    theme_title: "🌙 Theme",
    env_title: "⚙️ Variables (.env)",
    architecture_title: "🔧 Architecture",

    // Graph Relationships
    rel_prefers: "prefers",
    rel_works_on: "works on",
    rel_belongs_to: "belongs to",
    rel_uses: "uses",
    rel_runs_on: "runs on",
    rel_related_to: "related to",
    rel_depends_on: "depends on",
    rel_owns: "owns",
    rel_references: "references",
    rel_contains: "contains",
    rel_created: "created",
    rel_reads: "reads",
    rel_writes: "writes",
    rel_custom: "-- Custom --",

    // Node Types
    type_identity: "Identity",
    type_preference: "Preference",
    type_project: "Project",
    type_skill: "Skill",
    type_context: "Context",
    type_fact: "Fact",

    // Common
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    loading: "Loading...",
    error: "Error",
    success: "Success"
  },
  'es-ES': {
    chat: "💬 Chat",
    config: "⚙️ Config",
    traces: "🧠 Traces",
    memory: "💾 Memoria",
    graph: "🕸️ Grafo",
    review: "🧪 Revisión",
    help: "❓ Ayuda",
    theme_toggle: "Cambiar Tema",
    lang_toggle: "Cambiar Idioma",

    // Chat
    conv_sidebar_title: "📋 Conversaciones",
    new_conv: "+ Nueva",
    mic_title: "Hablar",
    msg_placeholder: "Escribe tu mensaje...",
    tts_title: "Escuchar respuestas",
    send_title: "Enviar",

    // Memory
    memory_search_title: "🔍 Buscar en Memoria",
    memory_search_placeholder: "Buscar nodos por nombre o contenido...",
    search: "Buscar",
    detail_title: "📄 Detalle",
    select_node_detail: "Seleccione un nodo para ver detalles",

    // Config
    status_title: "📊 Estado",
    model_title: "🤖 Modelo LLM",
    provider_label: "Proveedor",
    ollama_model_label: "Modelo Ollama",
    ollama_models_label: "Modelos Disponibles",
    ollama_pull_label: "Descargar Modelo",
    ollama_url_label: "URL de Ollama",
    ollama_key_label: "Clave API de Ollama (cloud)",
    lang_label: "Idioma",
    iterations_label: "Iteraciones Máximas",
    memory_window_label: "Ventana de Memoria",
    keys_title: "🔑 Otros Proveedores",
    system_prompt_title: "💬 System Prompt",
    system_prompt_label: "Instrucciones del Sistema",
    tools_title: "🛠️ Herramientas",
    save_btn: "💾 Guardar",
    restart_btn: "🔄 Guardar y Reiniciar",
    reset_btn: "🔄 Resetear",

    // Traces
    traces_title: "📋 Trazas (Traces)",
    avg_duration_label: "Duración Media",
    completed_label: "Completados",
    errors_label: "Errores",
    detail_pane_title: "🔍 Detalle",
    waiting_msg: "Esperando...",
    select_trace_msg: "Seleccione una traza",
    new_node: "+ Nuevo Nodo",
    back_to_controls: "❮ Volver",
    save_success: "¡Guardado com éxito!",
    delete_confirm_node: "¿Estás seguro de que quieres eliminar este nodo y todas sus relaciones?",
    node_name_placeholder: "Nombre del nodo...",
    node_content_placeholder: "Contenido/descripción del nodo...",

    // Graph UI
    graph_controls: "Controles del Grafo",
    node_selection: "Selección de Nodos",
    source_node: "Nodo de Origen",
    target_node: "Nodo de Destino",
    select_from_graph: "Seleccionar en el Grafo",
    relation_type: "Tipo de Relación",
    create_relation: "Crear Relación",
    remove_relation: "Eliminar Relación",
    center_node: "Centrar Nodo",
    graph_tools: "Herramientas del Grafo",
    legend: "Leyenda",
    search_node_placeholder: "Buscar nodo...",
    all_types: "Todos",
    relation_created: "¡Relación creada con éxito!",
    relation_removed: "¡Relación eliminada!",
    relation_error: "Error en la operación",
    confirm_remove: "¿Eliminar esta relación?",
    select_source_msg: "🔗 Haz clic en el nodo de ORIGEN",
    select_target_msg: "🔗 Ahora haz clic en el nodo de DESTINO",
    node_count_label: "{n} nodos, {e} aristas",

    // Help
    about_title: "🪐 Sobre NewClaw",
    voice_title: "🔊 Voz",
    theme_title: "🌙 Tema",
    env_title: "⚙️ Variables (.env)",
    architecture_title: "🔧 Arquitectura",

    // Graph Relationships
    rel_prefers: "prefiere",
    rel_works_on: "trabaja en",
    rel_belongs_to: "pertenece a",
    rel_uses: "usa",
    rel_runs_on: "ejecuta en",
    rel_related_to: "relacionado con",
    rel_depends_on: "depende de",
    rel_owns: "posee",
    rel_references: "referencia",
    rel_contains: "contiene",
    rel_created: "creó",
    rel_reads: "lee",
    rel_writes: "escribe",
    rel_custom: "-- Personalizada --",

    // Node Types
    type_identity: "Identidad",
    type_preference: "Preferencia",
    type_project: "Proyecto",
    type_skill: "Habilidad",
    type_context: "Contexto",
    type_fact: "Hecho",

    // Common
    save: "Guardar",
    cancel: "Cancelar",
    delete: "Eliminar",
    loading: "Cargando...",
    error: "Error",
    success: "Éxito"
  }
};

let CURRENT_LANG = localStorage.getItem(NEWCLAW_KEY + 'lang') || 'pt-BR';

function newclawGetLang() { return CURRENT_LANG; }

function newclawSetLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  CURRENT_LANG = lang;
  localStorage.setItem(NEWCLAW_KEY + 'lang', lang);
  document.documentElement.lang = lang;
  newclawApplyI18n();
  // Trigger custom event for pages that need to re-render complex components (like the graph)
  window.dispatchEvent(new CustomEvent('newclaw-lang-changed', { detail: { lang } }));
}

function t(key, data = {}) {
  const lang = TRANSLATIONS[CURRENT_LANG] ? CURRENT_LANG : 'en-US';
  let text = TRANSLATIONS[lang][key] || TRANSLATIONS['en-US'][key] || key;
  Object.keys(data).forEach(k => {
    text = text.replace(`{${k}}`, data[k]);
  });
  return text;
}

function newclawApplyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
  });
}

// Theme
function newclawInitTheme() {
  const theme = localStorage.getItem(NEWCLAW_KEY + 'theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

function newclawToggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(NEWCLAW_KEY + 'theme', next);
  const btn = document.getElementById('newclaw-theme-btn');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}

// Build header HTML
function newclawHeader(activePage) {
  const theme = localStorage.getItem(NEWCLAW_KEY + 'theme') || 'dark';
  const themeIcon = theme === 'dark' ? '☀️' : '🌙';

  const pages = [
    { href: '/', label: t('chat'), id: 'chat' },
    { href: '/config', label: t('config'), id: 'config' },
    { href: '/traces', label: t('traces'), id: 'traces' },
    { href: '/memory', label: t('memory'), id: 'memory' },
    { href: '/memory-graph', label: t('graph'), id: 'memory-graph' },
    { href: '/memory-review', label: t('review'), id: 'memory-review' },
    { href: '/help', label: t('help'), id: 'help' },
  ];

  const navLinks = pages.map(p =>
    `<a href="${p.href}" ${p.id === activePage ? 'class="active"' : ''}>${p.label}</a>`
  ).join('');

  const langOptions = Object.keys(TRANSLATIONS).map(l =>
    `<option value="${l}" ${l === CURRENT_LANG ? 'selected' : ''}>${l === 'pt-BR' ? '🇧🇷 PT' : l === 'en-US' ? '🇺🇸 EN' : '🇪🇸 ES'}</option>`
  ).join('');

  return '<div class="newclaw-header">' +
    '<div class="newclaw-header-left">' +
      '<div class="newclaw-header-logo">🪐</div>' +
      '<div>' +
        '<div class="newclaw-header-title">NewClaw</div>' +
      '</div>' +
    '</div>' +
    '<div class="newclaw-header-right">' +
      '<div class="newclaw-nav">' + navLinks + '</div>' +
      '<div class="newclaw-lang-selector">' +
        '<select onchange="newclawSetLang(this.value)">' +
          langOptions +
        '</select>' +
      '</div>' +
      '<button class="newclaw-btn-icon" id="newclaw-theme-btn" onclick="newclawToggleTheme()" data-i18n-title="theme_toggle" title="' + t('theme_toggle') + '">' + themeIcon + '</button>' +
    '</div>' +
  '</div>';
}

// Auto-init
document.addEventListener('DOMContentLoaded', async () => {
  newclawInitTheme();

  // Try to fetch default language from server if not set in localStorage
  if (!localStorage.getItem(NEWCLAW_KEY + 'lang')) {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.success && data.config.language) {
        let lang = data.config.language;
        // Map common codes to our specific variants if needed
        if (lang === 'pt') lang = 'pt-BR';
        if (lang === 'en') lang = 'en-US';
        if (lang === 'es') lang = 'es-ES';

        if (TRANSLATIONS[lang]) {
          CURRENT_LANG = lang;
          localStorage.setItem(NEWCLAW_KEY + 'lang', lang);
        }
      }
    } catch (e) {
      console.warn('[i18n] Failed to fetch server config for language');
    }
  }

  document.documentElement.lang = CURRENT_LANG;
  newclawApplyI18n();
});
