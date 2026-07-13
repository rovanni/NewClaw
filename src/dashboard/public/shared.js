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
    reasoning_chip_label: "Raciocinou por {n}s",
    reasoning_chip_label_generic: "Raciocinou",
    today_label: "Hoje",

    // Chat
    conv_sidebar_title: "Recentes",
    new_conv: "Nova conversa",
    search_conv_placeholder: "Buscar conversas",
    agent_active_label: "Agente ativo",
    no_conversations_found: "Nenhuma conversa encontrada",
    composer_disclaimer: "NewClaw pode cometer erros. Considere verificar informações importantes.",
    mic_title: "Ditar",
    msg_placeholder: "Pergunte ao NewClaw…",
    tts_title: "Ouvir resposta",
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
    success: "Sucesso",

    // Sidebar
    sidebar_operation: "Operação",
    sidebar_models: "Modelos",
    sidebar_tools: "Ferramentas",
    sidebar_security: "Segurança",
    sidebar_advanced: "Avançado",
    sidebar_update: "Atualização",
    sidebar_backup: "Backup",
    sidebar_integrations: "Integrações",

    // Integrations view
    integrations_page_desc: "Instale e gerencie extensões e integrações do NewClaw com outros softwares.",
    pptx_addin_title: "Suplemento PowerPoint",
    pptx_addin_desc: "Gere slides e apresentações diretamente dentro do Microsoft PowerPoint usando o NewClaw.",
    req_label: "Requisitos:",
    req_pptx: "Windows, Office 365 ou 2019+, Node.js instalado.",
    pptx_remote_not_supported: "A instalação remota neste servidor não é suportada. O suplemento precisa ser instalado localmente em um computador Windows com o PowerPoint disponível.",
    pptx_install_unavailable: "Instalação Indisponível",
    pptx_install_windows: "Instalar neste Servidor Windows",
    pptx_install_confirm: "Deseja instalar o suplemento neste Servidor Windows? Isso compilará e registrará o add-in localmente.",
    pptx_installing: "Instalando neste servidor Windows...",
    pptx_status_unknown: "Status desconhecido/continue verificando",
    pptx_status_unavailable: "Status da instalação indisponível; o servidor pode ter sido reiniciado.",
    pptx_install_success_toast: "Instalação concluída no servidor Windows.",
    pptx_install_success: "Instalação concluída no servidor",
    pptx_install_failed_toast: "Falha na instalação. Verifique os logs.",
    pptx_install_failed: "Erro na instalação no servidor",
    pptx_install_error: "Erro na instalação",
    pptx_uninstall_btn: "Desinstalar Suplemento",
    pptx_uninstalling: "Desinstalando...",
    pptx_uninstall_confirm: "Deseja remover o suplemento do PowerPoint deste servidor?",

    // Update view
    update_page_desc: "Verifique e aplique atualizações do NewClaw.",
    update_channel_title: "Canal de atualização",
    update_channel_desc: "Escolha como o NewClaw recebe atualizações — igual ao Windows Update.",
    update_channel_stable: "Stable (recomendado) — versões oficiais, máxima estabilidade",
    update_channel_preview: "Preview — novidades antecipadas, pode conter bugs",
    update_channel_dev: "Development — escolha manualmente qualquer branch",
    update_channel_stable_short: "Stable",
    update_channel_preview_short: "Preview",
    update_channel_dev_short: "Development",
    update_channel_branch_label: "Branch:",
    update_channel_branch_loading: "Carregando branches…",
    update_channel_branch_empty: "Nenhuma branch encontrada",
    update_channel_current_prefix: "Canal atual:",
    update_channel_installed_version: "versão instalada:",
    update_version_title: "Status da versão",
    update_checking: "Verificando status da atualização...",
    update_checking_progress: "🔄 Verificando atualizações…",
    update_check_btn: "🔍 Verificar Agora",
    update_apply_btn: "⬆️ Atualizar e Reiniciar",
    update_available_label: "⬆️ Atualização disponível",
    update_commits_label: "commits disponíveis para atualização",
    update_commit_label: "commit disponível para atualização",
    update_uptodate: "✅ Sistema atualizado",
    update_version_label: "versão",
    update_error_prefix: "❌ Erro ao verificar:",
    update_changelog_label: "O que será atualizado:",
    update_confirm: "Iniciar atualização e reiniciar o NewClaw?\n\nO sistema ficará indisponível por alguns minutos.",
    update_in_progress: "⏳ Atualização em andamento… o sistema será reiniciado automaticamente.",
    update_started_toast: "⬆️ Atualização iniciada. Aguarde o reinício.",
    update_timeout_warn: "⚠️ Reinício demorou mais que o esperado. Verifique os logs.",

    // Backup view
    backup_page_desc: "Crie backups manuais e configure a retenção automática.",
    backup_schedule_title: "🕐 Agendamento",
    backup_schedule_info: "O backup automático do banco é gerenciado pelo <strong>crontab do sistema</strong> (<code>backup_db.sh</code>, a cada 6h). Para alterar o intervalo, edite o crontab no servidor. Os arquivos gerados aparecem automaticamente na lista abaixo.",
    backup_retention_title: "🗑️ Retenção",
    backup_retention_label: "Manter últimos N backups por tipo",
    backup_retention_hint: "Ao criar um novo backup, os mais antigos são removidos automaticamente para manter o limite configurado. Conta separado por tipo (sistema e banco de dados).",
    backup_retention_save_btn: "Salvar",
    backup_manual_title: "📦 Backup Manual",
    backup_system_btn: "📄 Backup do Sistema (.env)",
    backup_db_btn: "🗄️ Backup do Banco de Dados",
    backup_path_hint: "Arquivos salvos em <code>data/backups/</code>.",
    backup_list_title: "📋 Backups Disponíveis",
    backup_loading: "Carregando…",
    backup_empty: "Nenhum backup encontrado.",
    backup_load_error: "Erro ao carregar backups.",
    backup_col_file: "Arquivo",
    backup_col_size: "Tamanho",
    backup_col_date: "Data",
    backup_download: "⬇️ baixar",
    backup_invalid_retention: "❌ Valor inválido",
    backup_saved_retention: "✅ Retenção salva: últimos {n} backups por tipo",
    backup_creating_toast: "⏳ Criando backup do {label}...",
    backup_created_toast: "✅ Backup criado: {name} ({size})",
    backup_restore_btn: "🔄 restaurar",
    backup_restore_confirm: "Restaurar a partir de \"{name}\"?\n\nUm backup de segurança do estado atual será criado automaticamente.\nO sistema será reiniciado após a restauração (pode levar ~40s).",
    backup_restoring_toast: "⏳ Restaurando… o sistema será reiniciado em breve.",
    backup_restored_toast: "✅ Restauração iniciada. Aguarde o reinício (~40s).",
    backup_upload_title: "📤 Enviar Backup",
    backup_upload_btn: "📁 Escolher arquivo (.bak ou .db)",
    backup_upload_hint: "Envie um arquivo de backup baixado anteriormente para adicioná-lo à lista.",
    backup_upload_invalid: "❌ Selecione um arquivo .bak ou .db",
    backup_uploading_toast: "⏳ Enviando arquivo…",
    backup_uploaded_toast: "✅ Arquivo enviado: {name}",

    // Dashboard view
    status_verifying: "Verificando...",
    active_model_label: "modelo ativo",
    metric_active_skills: "Skills ativas",
    metric_proposed: "Propostas",
    metric_patterns: "Padrões",
    metric_top_tool: "Tool líder",
    activity_tools_title: "Atividade — Top Ferramentas por Uso",
    cognitive_patterns_title: "Padrões Cognitivos Recentes",
    channels_section_title: "Canais",
    waiting_data: "Aguardando dados...",
    no_patterns_yet: "Padrões surgem com o uso. Nenhum ainda.",
    no_channel_data: "Dados de canal indisponíveis.",
    online: "Online",
    offline: "Offline",
    tg_connected: "Conectado",
    tg_cooldown: "Cooldown após conflito",
    tg_reconnecting: "Reconectando...",
    tg_conflict: "Conflito de polling",
    tg_disconnected: "Desconectado",
    behavior_settings: "Configurações de Comportamento",
    iterations_hint: "Loops por ciclo de raciocínio (1–20)",
    memory_window_hint: "Mensagens mantidas no contexto ativo",

    // Models view
    models_page_desc: "Roteamento inteligente — cada tipo de tarefa usa o modelo mais adequado",
    pipeline_title: "Fluxo de Decisão — ModelRouter",
    pipe_input: "Entrada",
    pipe_message: "Mensagem",
    pipe_classifier: "Classificador",
    pipe_category: "Categoria",
    pipe_detected: "Detectada",
    route_code_cat: "código",
    route_vision_cat: "visão",
    route_light_cat: "leve",
    route_analysis_cat: "análise",
    route_execution_cat: "execução",
    route_chat_desc: "Conversas gerais",
    route_code_desc: "Programação",
    route_vision_desc: "Imagens / OCR",
    route_light_desc: "Respostas rápidas",
    route_analysis_desc: "Cripto / Mercado",
    route_execution_desc: "Tools / Raciocínio",
    edit_routes_title: "🎛️ Editar Rotas de Modelo",
    default_provider_label: "Provider Padrão",
    main_ollama_model_label: "Modelo Ollama Principal",
    download_models_label: "Download de Modelos",
    classifier_model_label: "Modelo Classificador",
    classifier_server_label: "Servidor Classificador",
    vision_server_label: "Servidor Visão",
    provider_classifier_title: "🔌 Provider & Classificador",
    provider_per_profile_title: "🔌 Provider por Perfil (opcional)",
    provider_per_profile_hint: "Sobrescreve o provider padrão para cada categoria. Deixe em branco para usar o provider padrão.",
    internal_models_title: "⚙️ Modelos dos Componentes Internos",
    internal_models_hint: "Modelos usados pelo GoalPlanner, RiskAnalyzer e ObserverValidator. Devem ser compatíveis com o provider padrão.",
    effective_config_title: "Configuração Efetiva",
    provider_active_label: "Provider Ativo",
    internal_planner_desc: "Planejamento de objetivos e decomposição de tarefas complexas",
    internal_risk_desc: "Análise de risco e validação de segurança antes da execução",
    internal_observer_desc: "Validação e observação contínua dos resultados das ações",
    internal_unconfigured_badge: "não configurados",
    routing_diag_title: "Última Decisão de Roteamento",
    routing_diag_waiting: "Aguardando primeira decisão de roteamento...",
    prov_inherit_default: "padrão",
    prov_inheriting: "Herdando",
    prov_overriding: "Sobrescrevendo",
    rd_message: "Mensagem",
    rd_classifier: "Classificador",
    rd_category: "Categoria",
    rd_model: "Modelo Escolhido",
    rd_provider: "Provider",
    rd_elapsed: "Tempo de Decisão",

    // Advanced view
    advanced_page_desc: "System prompt e configurações especializadas",
    system_prompt_placeholder: "Instruções personalizadas do sistema...",
    system_prompt_hint_text: "Deixe vazio para usar o prompt padrão",
    reset_form_title: "🔄 Reset de Formulário",
    reset_form_desc: "Restaura os valores padrão — não salva automaticamente.",
    reset_values_btn: "🔄 Resetar Valores",
    reset_confirm: "Resetar para valores padrão?",
    reset_done_toast: "🔄 Resetado.",

    // Providers view
    providers_page_desc: "Conexões com LLMs e gerenciamento de chaves",
    server_url_label: "URL do Servidor",
    test_connection_btn: "🔍 Testar Conexão",
    ollama_models_count: "{n} modelos",
    testing_ollama: "🔍 Testando Ollama...",
    ollama_ok: "✅ Ollama OK — {n} modelos",
    ollama_not_found: "❌ Ollama não encontrado",
    key_missing: "✗ Ausente",

    // Tools view
    tools_page_desc: "Módulos operacionais do agente — uso real calculado dos padrões aprendidos",
    search_tools_placeholder: "🔍  Buscar ferramentas...",
    loading_modules: "Carregando módulos...",
    no_tools_available: "Nenhuma ferramenta disponível.",
    no_usage_data: "Sem dados de uso",

    // Skills view
    skills_page_desc: "Sistema de aprendizado autônomo — skills emergem de padrões de uso real",
    metric_active: "Ativas",
    metric_awaiting_review: "Aguardando revisão",
    metric_patterns_registered: "Padrões registrados",
    agent_skills_title: "Skills do Agente",
    detected_patterns_title: "Padrões Detectados",
    no_skills_yet: "Nenhuma skill registrada ainda.",
    no_patterns_detected: "Padrões ainda não detectados.",
    approve_btn: "✓ Aprovar",
    reject_btn: "✗ Rejeitar",
    deactivate_btn: "⏸ Desativar",
    reactivate_btn: "▶ Reativar",
    delete_skill_confirm: "Excluir esta skill permanentemente?",
    skill_approved_toast: "✅ Skill aprovada.",
    skill_rejected_toast: "🛑 Skill rejeitada.",
    skill_reactivated_toast: "✅ Skill reativada.",
    skill_deactivated_toast: "⏸ Skill desativada.",
    skill_deleted_toast: "🗑 Skill excluída.",
    badge_active: "ATIVA",
    badge_inactive: "INATIVA",
    badge_rejected: "REJEITADA",
    badge_proposed: "PROPOSTA",
    priority_label: "prioridade",

    // Security view
    security_page_desc: "Controle de acesso e usuários autorizados",
    telegram_whitelist_title: "📱 Telegram — Whitelist de Usuários",
    authorized_ids_label: "IDs Autorizados",
    telegram_ids_hint: "IDs numéricos separados por vírgula · use @userinfobot para descobrir o seu",
    dashboard_password_title: "🔑 Senha do Dashboard",
    new_password_label: "Nova Senha",
    new_password_placeholder: "Nova senha (mín. 6 caracteres)",
    confirm_password_label: "Confirmar Nova Senha",
    confirm_password_placeholder: "Repita a nova senha",
    save_password_btn: "💾 Salvar Senha",
    disable_auth_btn: "🔓 Desativar Autenticação",
    auth_check_failed: "Não foi possível verificar o status de autenticação.",
    enter_new_pass_toast: "⚠️ Informe a nova senha.",
    pass_too_short_toast: "⚠️ A senha deve ter pelo menos 6 caracteres.",
    pass_mismatch_toast: "❌ As senhas não coincidem.",
    pass_saved_toast: "✅ Senha salva! Você será solicitado a fazer login novamente.",
    disable_auth_confirm: "Desativar a autenticação? O dashboard ficará acessível sem senha.",
    auth_disabled_toast: "🔓 Autenticação desativada.",
    auth_active_label: "Autenticação ATIVA",
    auth_active_desc: "o dashboard exige senha para acesso.",
    auth_no_pass_desc: "Autenticação ativada mas sem senha definida.",
    auth_disabled_label: "Sem autenticação",
    auth_open_desc: "qualquer pessoa na rede pode acessar o dashboard."
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
    reasoning_chip_label: "Reasoned for {n}s",
    reasoning_chip_label_generic: "Reasoned",
    today_label: "Today",
    
    // Chat
    conv_sidebar_title: "Recent",
    new_conv: "New conversation",
    search_conv_placeholder: "Search conversations",
    agent_active_label: "Agent active",
    no_conversations_found: "No conversations found",
    composer_disclaimer: "NewClaw can make mistakes. Consider checking important information.",
    mic_title: "Dictate",
    msg_placeholder: "Ask NewClaw…",
    tts_title: "Listen to response",
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
    success: "Success",

    // Sidebar
    sidebar_operation: "Operation",
    sidebar_models: "Models",
    sidebar_tools: "Tools",
    sidebar_security: "Security",
    sidebar_advanced: "Advanced",
    sidebar_update: "Update",
    sidebar_backup: "Backup",
    sidebar_integrations: "Integrations",

    // Integrations view
    integrations_page_desc: "Install and manage NewClaw extensions and integrations with other software.",
    pptx_addin_title: "PowerPoint Add-in",
    pptx_addin_desc: "Generate slides and presentations directly inside Microsoft PowerPoint using NewClaw.",
    req_label: "Requirements:",
    req_pptx: "Windows, Office 365 or 2019+, Node.js installed.",
    pptx_remote_not_supported: "Remote installation on this server is not supported. The add-in must be installed locally on a Windows computer with PowerPoint available.",
    pptx_install_unavailable: "Installation Unavailable",
    pptx_install_windows: "Install on this Windows Server",
    pptx_install_confirm: "Do you want to install the add-in on this Windows Server? This will compile and register the add-in locally.",
    pptx_installing: "Installing on this Windows server...",
    pptx_status_unknown: "Unknown status/keep checking",
    pptx_status_unavailable: "Installation status unavailable; server may have restarted.",
    pptx_install_success_toast: "Installation completed on Windows server.",
    pptx_install_success: "Installation completed on server",
    pptx_install_failed_toast: "Installation failed. Check logs.",
    pptx_install_failed: "Error installing on server",
    pptx_install_error: "Installation error",
    pptx_uninstall_btn: "Uninstall Add-in",
    pptx_uninstalling: "Uninstalling...",
    pptx_uninstall_confirm: "Do you want to remove the PowerPoint add-in from this server?",

    // Update view
    update_page_desc: "Check and apply NewClaw updates.",
    update_channel_title: "Update channel",
    update_channel_desc: "Choose how NewClaw receives updates — like Windows Update.",
    update_channel_stable: "Stable (recommended) — official releases, maximum stability",
    update_channel_preview: "Preview — early access to new features, may contain bugs",
    update_channel_dev: "Development — manually pick any branch",
    update_channel_stable_short: "Stable",
    update_channel_preview_short: "Preview",
    update_channel_dev_short: "Development",
    update_channel_branch_label: "Branch:",
    update_channel_branch_loading: "Loading branches…",
    update_channel_branch_empty: "No branches found",
    update_channel_current_prefix: "Current channel:",
    update_channel_installed_version: "installed version:",
    update_version_title: "Version status",
    update_checking: "Checking update status...",
    update_checking_progress: "🔄 Checking for updates…",
    update_check_btn: "🔍 Check Now",
    update_apply_btn: "⬆️ Update and Restart",
    update_available_label: "⬆️ Update available",
    update_commits_label: "commits available to update",
    update_commit_label: "commit available to update",
    update_uptodate: "✅ System up to date",
    update_version_label: "version",
    update_error_prefix: "❌ Error checking:",
    update_changelog_label: "What will be updated:",
    update_confirm: "Start update and restart NewClaw?\n\nThe system will be unavailable for a few minutes.",
    update_in_progress: "⏳ Update in progress… the system will restart automatically.",
    update_started_toast: "⬆️ Update started. Waiting for restart.",
    update_timeout_warn: "⚠️ Restart took longer than expected. Check the logs.",

    // Backup view
    backup_page_desc: "Create manual backups and configure automatic retention.",
    backup_schedule_title: "🕐 Scheduling",
    backup_schedule_info: "Automatic database backup is managed by the <strong>system crontab</strong> (<code>backup_db.sh</code>, every 6h). To change the interval, edit the crontab on the server. Files generated by crontab appear automatically in the list below.",
    backup_retention_title: "🗑️ Retention",
    backup_retention_label: "Keep last N backups per type",
    backup_retention_hint: "When a new backup is created, the oldest ones are automatically removed to maintain the configured limit. Counted separately by type (system and database).",
    backup_retention_save_btn: "Save",
    backup_manual_title: "📦 Manual Backup",
    backup_system_btn: "📄 System Backup (.env)",
    backup_db_btn: "🗄️ Database Backup",
    backup_path_hint: "Files saved in <code>data/backups/</code>.",
    backup_list_title: "📋 Available Backups",
    backup_loading: "Loading…",
    backup_empty: "No backups found.",
    backup_load_error: "Error loading backups.",
    backup_col_file: "File",
    backup_col_size: "Size",
    backup_col_date: "Date",
    backup_download: "⬇️ download",
    backup_invalid_retention: "❌ Invalid value",
    backup_saved_retention: "✅ Retention saved: last {n} backups per type",
    backup_creating_toast: "⏳ Creating {label} backup...",
    backup_created_toast: "✅ Backup created: {name} ({size})",
    backup_restore_btn: "🔄 restore",
    backup_restore_confirm: "Restore from \"{name}\"?\n\nA safety backup of the current state will be created automatically.\nThe system will restart after restore (may take ~40s).",
    backup_restoring_toast: "⏳ Restoring… the system will restart shortly.",
    backup_restored_toast: "✅ Restore initiated. Waiting for restart (~40s).",
    backup_upload_title: "📤 Upload Backup",
    backup_upload_btn: "📁 Choose file (.bak or .db)",
    backup_upload_hint: "Upload a previously downloaded backup file to add it to the list.",
    backup_upload_invalid: "❌ Please select a .bak or .db file",
    backup_uploading_toast: "⏳ Uploading file…",
    backup_uploaded_toast: "✅ File uploaded: {name}",

    // Dashboard view
    status_verifying: "Checking...",
    active_model_label: "active model",
    metric_active_skills: "Active skills",
    metric_proposed: "Proposed",
    metric_patterns: "Patterns",
    metric_top_tool: "Top tool",
    activity_tools_title: "Activity — Top Tools by Usage",
    cognitive_patterns_title: "Recent Cognitive Patterns",
    channels_section_title: "Channels",
    waiting_data: "Waiting for data...",
    no_patterns_yet: "Patterns emerge with use. None yet.",
    no_channel_data: "Channel data unavailable.",
    online: "Online",
    offline: "Offline",
    tg_connected: "Connected",
    tg_cooldown: "Cooldown after conflict",
    tg_reconnecting: "Reconnecting...",
    tg_conflict: "Polling conflict",
    tg_disconnected: "Disconnected",
    behavior_settings: "Behavior Settings",
    iterations_hint: "Loops per reasoning cycle (1–20)",
    memory_window_hint: "Messages kept in active context",

    // Models view
    models_page_desc: "Intelligent routing — each task type uses the most suitable model",
    pipeline_title: "Decision Flow — ModelRouter",
    pipe_input: "Input",
    pipe_message: "Message",
    pipe_classifier: "Classifier",
    pipe_category: "Category",
    pipe_detected: "Detected",
    route_code_cat: "code",
    route_vision_cat: "vision",
    route_light_cat: "light",
    route_analysis_cat: "analysis",
    route_execution_cat: "execution",
    route_chat_desc: "General conversations",
    route_code_desc: "Programming",
    route_vision_desc: "Images / OCR",
    route_light_desc: "Fast responses",
    route_analysis_desc: "Crypto / Market",
    route_execution_desc: "Tools / Reasoning",
    edit_routes_title: "🎛️ Edit Model Routes",
    default_provider_label: "Default Provider",
    main_ollama_model_label: "Main Ollama Model",
    download_models_label: "Download Models",
    classifier_model_label: "Classifier Model",
    classifier_server_label: "Classifier Server",
    vision_server_label: "Vision Server",
    provider_classifier_title: "🔌 Provider & Classifier",
    provider_per_profile_title: "🔌 Provider per Profile (optional)",
    provider_per_profile_hint: "Overrides the default provider per category. Leave blank to use the default provider.",
    internal_models_title: "⚙️ Internal Component Models",
    internal_models_hint: "Models used by GoalPlanner, RiskAnalyzer and ObserverValidator. Must be compatible with the default provider.",
    effective_config_title: "Effective Configuration",
    provider_active_label: "Active Provider",
    internal_planner_desc: "Goal planning and complex task decomposition",
    internal_risk_desc: "Risk analysis and security validation before execution",
    internal_observer_desc: "Continuous validation and observation of action results",
    internal_unconfigured_badge: "not configured",
    routing_diag_title: "Last Routing Decision",
    routing_diag_waiting: "Waiting for first routing decision...",
    prov_inherit_default: "default",
    prov_inheriting: "Inheriting",
    prov_overriding: "Overriding",
    rd_message: "Message",
    rd_classifier: "Classifier",
    rd_category: "Category",
    rd_model: "Selected Model",
    rd_provider: "Provider",
    rd_elapsed: "Decision Time",

    // Advanced view
    advanced_page_desc: "System prompt and specialized settings",
    system_prompt_placeholder: "Custom system instructions...",
    system_prompt_hint_text: "Leave empty to use the default prompt",
    reset_form_title: "🔄 Form Reset",
    reset_form_desc: "Restores default values — does not save automatically.",
    reset_values_btn: "🔄 Reset Values",
    reset_confirm: "Reset to default values?",
    reset_done_toast: "🔄 Reset done.",

    // Providers view
    providers_page_desc: "LLM connections and key management",
    server_url_label: "Server URL",
    test_connection_btn: "🔍 Test Connection",
    ollama_models_count: "{n} models",
    testing_ollama: "🔍 Testing Ollama...",
    ollama_ok: "✅ Ollama OK — {n} models",
    ollama_not_found: "❌ Ollama not found",
    key_missing: "✗ Missing",

    // Tools view
    tools_page_desc: "Agent operational modules — real usage calculated from learned patterns",
    search_tools_placeholder: "🔍  Search tools...",
    loading_modules: "Loading modules...",
    no_tools_available: "No tools available.",
    no_usage_data: "No usage data",

    // Skills view
    skills_page_desc: "Autonomous learning system — skills emerge from real usage patterns",
    metric_active: "Active",
    metric_awaiting_review: "Awaiting review",
    metric_patterns_registered: "Registered patterns",
    agent_skills_title: "Agent Skills",
    detected_patterns_title: "Detected Patterns",
    no_skills_yet: "No skills registered yet.",
    no_patterns_detected: "Patterns not yet detected.",
    approve_btn: "✓ Approve",
    reject_btn: "✗ Reject",
    deactivate_btn: "⏸ Deactivate",
    reactivate_btn: "▶ Reactivate",
    delete_skill_confirm: "Delete this skill permanently?",
    skill_approved_toast: "✅ Skill approved.",
    skill_rejected_toast: "🛑 Skill rejected.",
    skill_reactivated_toast: "✅ Skill reactivated.",
    skill_deactivated_toast: "⏸ Skill deactivated.",
    skill_deleted_toast: "🗑 Skill deleted.",
    badge_active: "ACTIVE",
    badge_inactive: "INACTIVE",
    badge_rejected: "REJECTED",
    badge_proposed: "PROPOSED",
    priority_label: "priority",

    // Security view
    security_page_desc: "Access control and authorized users",
    telegram_whitelist_title: "📱 Telegram — User Whitelist",
    authorized_ids_label: "Authorized IDs",
    telegram_ids_hint: "Numeric IDs separated by comma · use @userinfobot to find yours",
    dashboard_password_title: "🔑 Dashboard Password",
    new_password_label: "New Password",
    new_password_placeholder: "New password (min. 6 characters)",
    confirm_password_label: "Confirm New Password",
    confirm_password_placeholder: "Repeat new password",
    save_password_btn: "💾 Save Password",
    disable_auth_btn: "🔓 Disable Authentication",
    auth_check_failed: "Could not verify authentication status.",
    enter_new_pass_toast: "⚠️ Enter the new password.",
    pass_too_short_toast: "⚠️ Password must be at least 6 characters.",
    pass_mismatch_toast: "❌ Passwords do not match.",
    pass_saved_toast: "✅ Password saved! You will be prompted to log in again.",
    disable_auth_confirm: "Disable authentication? The dashboard will be accessible without a password.",
    auth_disabled_toast: "🔓 Authentication disabled.",
    auth_active_label: "Authentication ACTIVE",
    auth_active_desc: "the dashboard requires a password to access.",
    auth_no_pass_desc: "Authentication enabled but no password set.",
    auth_disabled_label: "No authentication",
    auth_open_desc: "anyone on the network can access the dashboard."
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
    conv_sidebar_title: "Recientes",
    today_label: "Hoy",
    new_conv: "Nueva conversación",
    search_conv_placeholder: "Buscar conversaciones",
    agent_active_label: "Agente activo",
    no_conversations_found: "No se encontraron conversaciones",
    composer_disclaimer: "NewClaw puede cometer errores. Considere verificar la información importante.",
    mic_title: "Dictar",
    msg_placeholder: "Pregúntale a NewClaw…",
    tts_title: "Escuchar respuesta",
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
    success: "Éxito",

    // Sidebar
    sidebar_operation: "Operación",
    sidebar_models: "Modelos",
    sidebar_tools: "Herramientas",
    sidebar_security: "Seguridad",
    sidebar_advanced: "Avanzado",
    sidebar_update: "Actualización",
    sidebar_backup: "Copia de seguridad",

    // Update view
    update_page_desc: "Verifique y aplique actualizaciones de NewClaw.",
    update_channel_title: "Canal de actualización",
    update_channel_desc: "Elija cómo NewClaw recibe actualizaciones — igual que Windows Update.",
    update_channel_stable: "Stable (recomendado) — versiones oficiales, máxima estabilidad",
    update_channel_preview: "Preview — novedades anticipadas, puede contener errores",
    update_channel_dev: "Development — elija manualmente cualquier branch",
    update_channel_stable_short: "Stable",
    update_channel_preview_short: "Preview",
    update_channel_dev_short: "Development",
    update_channel_branch_label: "Branch:",
    update_channel_branch_loading: "Cargando branches…",
    update_channel_branch_empty: "No se encontraron branches",
    update_channel_current_prefix: "Canal actual:",
    update_channel_installed_version: "versión instalada:",
    update_version_title: "Estado de la versión",
    update_checking: "Verificando estado de la actualización...",
    update_checking_progress: "🔄 Buscando actualizaciones…",
    update_check_btn: "🔍 Verificar Ahora",
    update_apply_btn: "⬆️ Actualizar y Reiniciar",
    update_available_label: "⬆️ Actualización disponible",
    update_commits_label: "commits disponibles para actualizar",
    update_commit_label: "commit disponible para actualizar",
    update_uptodate: "✅ Sistema actualizado",
    update_version_label: "versión",
    update_error_prefix: "❌ Error al verificar:",
    update_changelog_label: "Qué se actualizará:",
    update_confirm: "¿Iniciar actualización y reiniciar NewClaw?\n\nEl sistema no estará disponible por unos minutos.",
    update_in_progress: "⏳ Actualización en curso… el sistema se reiniciará automáticamente.",
    update_started_toast: "⬆️ Actualización iniciada. Esperando reinicio.",
    update_timeout_warn: "⚠️ El reinicio tardó más de lo esperado. Revise los logs.",

    // Backup view
    backup_page_desc: "Crea copias de seguridad manuales y configura la retención automática.",
    backup_schedule_title: "🕐 Programación",
    backup_schedule_info: "La copia de seguridad automática de la base de datos es gestionada por el <strong>crontab del sistema</strong> (<code>backup_db.sh</code>, cada 6h). Para cambiar el intervalo, edite el crontab en el servidor.",
    backup_retention_title: "🗑️ Retención",
    backup_retention_label: "Mantener últimas N copias por tipo",
    backup_retention_hint: "Al crear una nueva copia, las más antiguas se eliminan automáticamente para mantener el límite configurado.",
    backup_retention_save_btn: "Guardar",
    backup_manual_title: "📦 Copia Manual",
    backup_system_btn: "📄 Copia del Sistema (.env)",
    backup_db_btn: "🗄️ Copia de Base de Datos",
    backup_path_hint: "Archivos guardados en <code>data/backups/</code>.",
    backup_list_title: "📋 Copias Disponibles",
    backup_loading: "Cargando…",
    backup_empty: "No se encontraron copias de seguridad.",
    backup_load_error: "Error al cargar las copias.",
    backup_col_file: "Archivo",
    backup_col_size: "Tamaño",
    backup_col_date: "Fecha",
    backup_download: "⬇️ descargar",
    backup_invalid_retention: "❌ Valor inválido",
    backup_saved_retention: "✅ Retención guardada: últimas {n} copias por tipo",
    backup_creating_toast: "⏳ Creando copia de {label}...",
    backup_created_toast: "✅ Copia creada: {name} ({size})",
    backup_restore_btn: "🔄 restaurar",
    backup_restore_confirm: "¿Restaurar desde \"{name}\"?\n\nSe creará automáticamente un backup de seguridad del estado actual.\nEl sistema se reiniciará tras la restauración (puede tardar ~40s).",
    backup_restoring_toast: "⏳ Restaurando… el sistema se reiniciará en breve.",
    backup_restored_toast: "✅ Restauración iniciada. Esperando reinicio (~40s).",
    backup_upload_title: "📤 Subir Backup",
    backup_upload_btn: "📁 Elegir archivo (.bak o .db)",
    backup_upload_hint: "Suba un archivo de backup descargado previamente para agregarlo a la lista.",
    backup_upload_invalid: "❌ Seleccione un archivo .bak o .db",
    backup_uploading_toast: "⏳ Subiendo archivo…",
    backup_uploaded_toast: "✅ Archivo subido: {name}",

    // Dashboard view
    status_verifying: "Verificando...",
    active_model_label: "modelo activo",
    metric_active_skills: "Skills activas",
    metric_proposed: "Propuestas",
    metric_patterns: "Patrones",
    metric_top_tool: "Tool líder",
    activity_tools_title: "Actividad — Top Herramientas por Uso",
    cognitive_patterns_title: "Patrones Cognitivos Recientes",
    channels_section_title: "Canales",
    waiting_data: "Esperando datos...",
    no_patterns_yet: "Los patrones emergen con el uso. Ninguno aún.",
    no_channel_data: "Datos de canal no disponibles.",
    online: "Online",
    offline: "Offline",
    tg_connected: "Conectado",
    tg_cooldown: "Cooldown tras conflicto",
    tg_reconnecting: "Reconectando...",
    tg_conflict: "Conflicto de polling",
    tg_disconnected: "Desconectado",
    behavior_settings: "Configuración de Comportamiento",
    iterations_hint: "Bucles por ciclo de razonamiento (1–20)",
    memory_window_hint: "Mensajes mantenidos en contexto activo",

    // Models view
    models_page_desc: "Enrutamiento inteligente — cada tipo de tarea usa el modelo más adecuado",
    pipeline_title: "Flujo de Decisión — ModelRouter",
    pipe_input: "Entrada",
    pipe_message: "Mensaje",
    pipe_classifier: "Clasificador",
    pipe_category: "Categoría",
    pipe_detected: "Detectada",
    route_code_cat: "código",
    route_vision_cat: "visión",
    route_light_cat: "ligero",
    route_analysis_cat: "análisis",
    route_execution_cat: "ejecución",
    route_chat_desc: "Conversaciones generales",
    route_code_desc: "Programación",
    route_vision_desc: "Imágenes / OCR",
    route_light_desc: "Respuestas rápidas",
    route_analysis_desc: "Cripto / Mercado",
    route_execution_desc: "Tools / Razonamiento",
    edit_routes_title: "🎛️ Editar Rutas de Modelo",
    default_provider_label: "Proveedor Predeterminado",
    main_ollama_model_label: "Modelo Ollama Principal",
    download_models_label: "Descargar Modelos",
    classifier_model_label: "Modelo Clasificador",
    classifier_server_label: "Servidor Clasificador",
    vision_server_label: "Servidor Visión",
    provider_classifier_title: "🔌 Proveedor y Clasificador",
    provider_per_profile_title: "🔌 Proveedor por Perfil (opcional)",
    provider_per_profile_hint: "Reemplaza el proveedor predeterminado por categoría. Déjelo en blanco para usar el proveedor predeterminado.",
    internal_models_title: "⚙️ Modelos de Componentes Internos",
    internal_models_hint: "Modelos usados por GoalPlanner, RiskAnalyzer y ObserverValidator. Deben ser compatibles con el proveedor predeterminado.",
    effective_config_title: "Configuración Efectiva",
    provider_active_label: "Proveedor Activo",
    internal_planner_desc: "Planificación de objetivos y descomposición de tareas complejas",
    internal_risk_desc: "Análisis de riesgo y validación de seguridad antes de la ejecución",
    internal_observer_desc: "Validación y observación continua de los resultados de las acciones",
    internal_unconfigured_badge: "no configurados",
    routing_diag_title: "Última Decisión de Enrutamiento",
    routing_diag_waiting: "Esperando primera decisión de enrutamiento...",
    prov_inherit_default: "predeterminado",
    prov_inheriting: "Heredando",
    prov_overriding: "Sobreescribiendo",
    rd_message: "Mensaje",
    rd_classifier: "Clasificador",
    rd_category: "Categoría",
    rd_model: "Modelo Elegido",
    rd_provider: "Proveedor",
    rd_elapsed: "Tiempo de Decisión",

    // Advanced view
    advanced_page_desc: "System prompt y configuraciones especializadas",
    system_prompt_placeholder: "Instrucciones personalizadas del sistema...",
    system_prompt_hint_text: "Deje vacío para usar el prompt predeterminado",
    reset_form_title: "🔄 Reinicio del Formulario",
    reset_form_desc: "Restaura los valores predeterminados — no guarda automáticamente.",
    reset_values_btn: "🔄 Restablecer Valores",
    reset_confirm: "¿Restablecer valores predeterminados?",
    reset_done_toast: "🔄 Restablecido.",

    // Providers view
    providers_page_desc: "Conexiones con LLMs y gestión de claves",
    server_url_label: "URL del Servidor",
    test_connection_btn: "🔍 Probar Conexión",
    ollama_models_count: "{n} modelos",
    testing_ollama: "🔍 Probando Ollama...",
    ollama_ok: "✅ Ollama OK — {n} modelos",
    ollama_not_found: "❌ Ollama no encontrado",
    key_missing: "✗ Ausente",

    // Tools view
    tools_page_desc: "Módulos operacionales del agente — uso real calculado de los patrones aprendidos",
    search_tools_placeholder: "🔍  Buscar herramientas...",
    loading_modules: "Cargando módulos...",
    no_tools_available: "No hay herramientas disponibles.",
    no_usage_data: "Sin datos de uso",

    // Skills view
    skills_page_desc: "Sistema de aprendizaje autónomo — skills emergen de patrones de uso real",
    metric_active: "Activas",
    metric_awaiting_review: "Esperando revisión",
    metric_patterns_registered: "Patrones registrados",
    agent_skills_title: "Skills del Agente",
    detected_patterns_title: "Patrones Detectados",
    no_skills_yet: "Ninguna skill registrada aún.",
    no_patterns_detected: "Patrones aún no detectados.",
    approve_btn: "✓ Aprobar",
    reject_btn: "✗ Rechazar",
    deactivate_btn: "⏸ Desactivar",
    reactivate_btn: "▶ Reactivar",
    delete_skill_confirm: "¿Eliminar esta skill permanentemente?",
    skill_approved_toast: "✅ Skill aprobada.",
    skill_rejected_toast: "🛑 Skill rechazada.",
    skill_reactivated_toast: "✅ Skill reactivada.",
    skill_deactivated_toast: "⏸ Skill desactivada.",
    skill_deleted_toast: "🗑 Skill eliminada.",
    badge_active: "ACTIVA",
    badge_inactive: "INACTIVA",
    badge_rejected: "RECHAZADA",
    badge_proposed: "PROPUESTA",
    priority_label: "prioridad",

    // Security view
    security_page_desc: "Control de acceso y usuarios autorizados",
    telegram_whitelist_title: "📱 Telegram — Lista blanca de usuarios",
    authorized_ids_label: "IDs Autorizados",
    telegram_ids_hint: "IDs numéricos separados por coma · usa @userinfobot para encontrar el tuyo",
    dashboard_password_title: "🔑 Contraseña del Dashboard",
    new_password_label: "Nueva Contraseña",
    new_password_placeholder: "Nueva contraseña (mín. 6 caracteres)",
    confirm_password_label: "Confirmar Nueva Contraseña",
    confirm_password_placeholder: "Repita la nueva contraseña",
    save_password_btn: "💾 Guardar Contraseña",
    disable_auth_btn: "🔓 Desactivar Autenticación",
    auth_check_failed: "No se pudo verificar el estado de autenticación.",
    enter_new_pass_toast: "⚠️ Ingrese la nueva contraseña.",
    pass_too_short_toast: "⚠️ La contraseña debe tener al menos 6 caracteres.",
    pass_mismatch_toast: "❌ Las contraseñas no coinciden.",
    pass_saved_toast: "✅ Contraseña guardada. Se le solicitará iniciar sesión de nuevo.",
    disable_auth_confirm: "¿Desactivar la autenticación? El dashboard estará accesible sin contraseña.",
    auth_disabled_toast: "🔓 Autenticación desactivada.",
    auth_active_label: "Autenticación ACTIVA",
    auth_active_desc: "el dashboard requiere contraseña para acceder.",
    auth_no_pass_desc: "Autenticación activada pero sin contraseña definida.",
    auth_disabled_label: "Sin autenticación",
    auth_open_desc: "cualquier persona en la red puede acceder al dashboard."
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
  ];

  const navLinks = pages.map(p => {
    const label = p.label.replace(/^\S+\s+/, ''); // strip leading emoji from translation string
    return `<a href="${p.href}" ${p.id === activePage ? 'class="active"' : ''}>${label}</a>`;
  }).join('');

  const langShort = { 'pt-BR': 'PT-BR', 'en-US': 'EN-US', 'es-ES': 'ES-ES' };
  const langOptions = Object.keys(TRANSLATIONS).map(l =>
    `<option value="${l}" ${l === CURRENT_LANG ? 'selected' : ''}>${langShort[l] || l}</option>`
  ).join('');

  const initials = 'U';

  return '<div class="newclaw-header">' +
    '<div class="newclaw-header-left">' +
      '<div class="newclaw-header-logo">N</div>' +
      '<div class="newclaw-header-title">NewClaw</div>' +
    '</div>' +
    '<nav class="newclaw-tabs">' + navLinks + '</nav>' +
    '<div class="newclaw-header-right">' +
      '<div id="newclaw-host-badge" class="newclaw-host-badge"></div>' +
      '<div class="newclaw-lang-selector">' +
        '<select onchange="newclawSetLang(this.value)">' +
          langOptions +
        '</select>' +
      '</div>' +
      '<button class="newclaw-btn-icon" id="newclaw-theme-btn" onclick="newclawToggleTheme()" data-i18n-title="theme_toggle" title="' + t('theme_toggle') + '">' + themeIcon + '</button>' +
      '<div class="newclaw-avatar" title="' + t('chat') + '">' + initials + '</div>' +
    '</div>' +
  '</div>';
}

// Auto-init

// ── Auth System ──────────────────────────────────────────────────
const NEWCLAW_AUTH_KEY = NEWCLAW_KEY + 'auth_token';

function newclawGetToken() {
  return localStorage.getItem(NEWCLAW_AUTH_KEY) || '';
}

function newclawSetToken(token) {
  if (token) localStorage.setItem(NEWCLAW_AUTH_KEY, token);
  else localStorage.removeItem(NEWCLAW_AUTH_KEY);
}

function newclawIsAuthenticated() { return !!newclawGetToken(); }

async function newclawFetch(url, options = {}) {
  const token = newclawGetToken();
  if (token) {
    options.headers = options.headers || {};
    if (options.headers instanceof Headers) options.headers.set('Authorization', 'Bearer ' + token);
    else options.headers['Authorization'] = 'Bearer ' + token;
  }
  options.credentials = options.credentials || 'same-origin';
  const res = await fetch(url, options);
  if (res.status === 401) { newclawSetToken(''); newclawShowLogin(); throw new Error('Unauthorized'); }
  return res;
}

function newclawShowLogin() {
  if (document.getElementById('newclaw-login-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'newclaw-login-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:system-ui,sans-serif;';
  const lang = CURRENT_LANG || 'pt-BR';
  const isPtBR = lang === 'pt-BR', isEnUS = lang === 'en-US';
  const labelPass = isEnUS ? 'Password' : isPtBR ? 'Senha' : 'Contraseña';
  const btnLogin = isEnUS ? 'Login' : isPtBR ? 'Entrar' : 'Entrar';
  const titleText = isEnUS ? '🔒 Authentication Required' : isPtBR ? '🔒 Autenticação Necessária' : '🔒 Autenticación Requerida';
  const hintText = isEnUS ? 'Enter the dashboard password' : isPtBR ? 'Digite a senha do dashboard' : 'Ingrese la contraseña del dashboard';
  const errInvalid = isEnUS ? 'Invalid password' : isPtBR ? 'Senha inválida' : 'Contraseña inválida';
  overlay.innerHTML = '<div style="background:var(--bg-surface,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:12px;padding:32px;width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.5);"><h2 style="color:var(--text-main,#eee);margin:0 0 8px;font-size:1.2rem;">' + titleText + '</h2><p style="color:var(--text-muted,#888);margin:0 0 20px;font-size:0.85rem;">' + hintText + '</p><form id="newclaw-login-form"><input type="password" id="newclaw-login-pass" placeholder="' + labelPass + '" autofocus style="width:100%;padding:10px 14px;background:var(--bg-input,#111);border:1px solid var(--border-color,#333);border-radius:8px;color:var(--text-main,#eee);font-size:0.9rem;box-sizing:border-box;outline:none;"><div id="newclaw-login-error" style="color:#f44;margin-top:8px;font-size:0.8rem;display:none;"></div><button type="submit" style="width:100%;margin-top:16px;padding:10px;background:var(--accent,#6c63ff);color:#fff;border:none;border-radius:8px;font-size:0.9rem;cursor:pointer;">' + btnLogin + '</button></form></div>';
  document.body.appendChild(overlay);
  const form = document.getElementById('newclaw-login-form');
  const errorDiv = document.getElementById('newclaw-login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('newclaw-login-pass').value;
    if (!password) return;
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password }) });
      const data = await res.json();
      if (data.success && data.token) { newclawSetToken(data.token); overlay.remove(); window.location.reload(); }
      else { errorDiv.textContent = errInvalid; errorDiv.style.display = 'block'; document.getElementById('newclaw-login-pass').value = ''; document.getElementById('newclaw-login-pass').focus(); }
    } catch (err) { errorDiv.textContent = errInvalid; errorDiv.style.display = 'block'; }
  });
  document.getElementById('newclaw-login-pass').focus();
}

async function newclawCheckAuth() {
  const token = newclawGetToken();
  if (!token) {
    try { const res = await newclawFetch('/api/config'); if (res.status === 401) { newclawShowLogin(); return false; } return true; } catch { return true; }
  }
  try { const res = await newclawFetch('/api/config'); return res.status !== 401; } catch { return false; }
}
document.addEventListener('DOMContentLoaded', async () => {
  newclawInitTheme();
  newclawCheckAuth();

  // Try to fetch default language from server if not set in localStorage
  if (!localStorage.getItem(NEWCLAW_KEY + 'lang')) {
    try {
      const res = await newclawFetch('/api/config');
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
