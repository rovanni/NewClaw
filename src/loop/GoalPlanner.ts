/**
 * GoalPlanner — Decomposição de goals em planos executáveis.
 *
 * Dois modos:
 *   plan()   — plano inicial a partir do objetivo do usuário
 *   replan() — novo plano após blocker, consultando memória de reflexão
 *
 * A memória de reflexão (ReflectionMemory) informa o LLM sobre padrões de
 * falha passados, para que replans evitem repetir erros conhecidos.
 *
 * Output: PlanStep[] — lista de steps com toolName, toolArgs e fallbackSteps.
 */

import path from 'path';
import { createLogger } from '../shared/AppLogger';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ToolRegistry } from '../core/ToolRegistry';
import { SkillLoader } from '../skills/SkillLoader';
import { PromptComposer } from '../core/PromptComposer';
import { Goal, GoalBlocker, PlanStep, SuccessCriterion, CriterionCheck, GoalProgressModel } from './GoalTypes';
import { StrategyDiversityGuard } from './StrategyDiversityGuard';

const log = createLogger('GoalPlanner');

/** Resultado do planejamento: steps + estratégia textual (usada como cycleFocus). */
export interface PlanResult {
    steps: PlanStep[];
    strategy: string;
    adjustedRoadmap?: string[];
    /** Checklist de critérios verificáveis que provam a conclusão do goal. Gerado APENAS no plan inicial. */
    successCriteria?: SuccessCriterion[];
}

// ── Contratos de ferramentas — injetado em todos os prompts de planejamento ──
//
// Esclarece três categorias que o LLM frequentemente confunde:
//   1. Tools registradas: chamáveis pelo nome no plano
//   2. Binários do sistema: existem no servidor, mas SÓ via exec_command
//   3. Skills de contexto: instruções comportamentais, NÃO são tools chamáveis
// Gera a seção de contratos de tools dinamicamente a partir da lista real de tools
// registradas no ToolRegistry — evita hardcode e garante que tools de terceiros
// (instaladas via plugin/skill) sejam automaticamente reconhecidas pelo planner.
function buildToolContracts(callableTools: string[]): string {
    return `
CATEGORIAS DE FERRAMENTAS — leia antes de planejar:

▶ TOOLS CHAMÁVEIS (use o nome exato no campo toolName):
  ${callableTools.join(', ')}

▶ BINÁRIOS DO SISTEMA (use SEMPRE via exec_command — não são toolNames):
  python3  → exec_command: {"command": "python3 /workspace/script.py"}
  pandoc   → exec_command: {"command": "pandoc input.md -o output.html --standalone"}
  ffmpeg   → exec_command: {"command": "ffmpeg -i entrada.mp4 saida.mp3"}
  node/npm → exec_command: {"command": "node script.js"}

▶ SKILLS DE CONTEXTO (instruções no prompt — NUNCA são toolNames):
  pptx-generator, content-validator, html-pdf-converter, system-provisioner
  → São guias de comportamento. Não aparecem no campo toolName.

SCHEMAS OBRIGATÓRIOS (use caminhos RELATIVOS ao workspace — sem prefixo de servidor):
  send_document:   {"file_path": "arquivo.pptx"}
  read:            {"path": "arquivo.html"}
  write:           {"path": "arquivo.md", "content": "..."}
  edit:            {"path": "arquivo.md", "oldText": "...", "newText": "..."}
  exec_command:    {"command": "pandoc slides.md -o slides.pptx"}
  memory_write:    {"action": "create", "type": "fact", "name": "nome_do_nó", "content": "conteúdo completo"}
                   OU {"action": "update", "id": "node_id_existente", "content": "novo conteúdo"}
                   OU {"action": "connect", "from": "id_origem", "to": "id_destino", "relation": "tipo"}
  crypto_analysis: {"type": "detail", "symbol": "zec"}
                   OU {"type": "top100"} OU {"type": "sangrando"} OU {"type": "gainers"} OU {"type": "losers"}
  web_navigate:    {"action": "search", "query": "texto de busca"}
                   OU {"action": "open", "url": "https://exemplo.com"}
                   OU {"action": "follow_link", "url": "https://exemplo.com", "link_text": "texto do link"}

⚠️  send_document SEM file_path será bloqueado automaticamente pelo sistema.
⚠️  memory_write SEM action ou com action="" será bloqueado — forneça SEMPRE a action correta.
⚠️  memory_write com action="create" EXIGE content — nunca chame create sem content.
⚠️  crypto_analysis com type="detail" EXIGE symbol (ex: "btc", "zec", "sol") — use chamadas separadas por moeda.
⚠️  web_navigate SEM action ou com action inválida será bloqueado — use EXATAMENTE: search | open | follow_link.
⚠️  web_navigate action=search EXIGE query. action=open EXIGE url. action=follow_link EXIGE url + link_text.
⚠️  analyze_workspace_groups: APENAS para agrupar documentos/slides/HTML criados pelo agente para organização.
    NUNCA use para: analisar dependências de código, buscar referências a bibliotecas (ollama, openai, etc.),
    listar imports, ou qualquer tarefa de análise de código-fonte.
    Para essas tarefas use: exec_command com grep/find, ou read para ler arquivos específicos.
`.trim();
}

// ── Tool descriptions (injeta apenas ferramentas não-óbvias pelo nome) ───────

const STANDARD_TOOLS = new Set([
    'write', 'edit', 'read', 'exec_command', 'web_search', 'web_navigate',
    'send_document', 'send_audio', 'memory_search', 'memory_write', 'memory_admin',
    'list_workspace', 'refresh_workspace', 'read_document', 'ssh_exec',
    'schedule', 'weather', 'crypto_analysis', 'api_request', 'cmi_inspect',
]);

function buildToolDescriptions(toolNames: string[]): string {
    const lines: string[] = [];
    for (const name of toolNames) {
        if (STANDARD_TOOLS.has(name)) continue; // nome já diz o que faz
        const tool = ToolRegistry.get(name);
        if (!tool?.description) continue;
        const firstSentence = tool.description.split(/[.!?]\s/)[0].trim().slice(0, 150);
        lines.push(`  ${name}: ${firstSentence}`);
    }
    return lines.length > 0 ? `\nFerramentas não-óbvias (leia antes de planejar):\n${lines.join('\n')}\n` : '';
}

// ── Prompt templates ─────────────────────────────────────────────────────────

function buildPlanPrompt(goal: Goal, availableTools: string[], skillContext?: string, runtimeContext?: string, capabilityContext?: string, skillsSummary?: string, activeMilestone?: string, toolDescriptions?: string): string {
    const goalText  = `${goal.objective} ${goal.userIntent}`;
    const capBlock  = PromptComposer.buildCompactEnv(capabilityContext ?? '', goalText, skillsSummary);
    const skillBlock = skillContext
        ? `\nINSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente):\n${skillContext}\n`
        : '';
    const memContext = runtimeContext ? PromptComposer.enforceMemoryBudget(runtimeContext) : '';
    const contextBlock = memContext
        ? `\nCONTEXTO (memória + feedback de ciclos anteriores):\n${memContext}\n`
        : '';

    const userPaths = extractUnixPaths(goal.userIntent);
    const pathsBlock = userPaths.length > 0
        ? `\nPATHS MENCIONADOS PELO USUÁRIO — copie LITERALMENTE para toolArgs (não encurte nem reconstrua):\n${userPaths.map(p => `  ${p}`).join('\n')}\n`
        : '';

    const milestoneInstruction = activeMilestone
        ? `\n⚠️ CONSTRUÇÃO INCREMENTAL ATIVA:
Foque APENAS em planejar passos para resolver o Marco Atual. NÃO tente resolver o objetivo global ou outros marcos do roadmap ainda.
MARCO ATUAL A SER RESOLVIDO: ${activeMilestone}\n`
        : '';

    const CONTENT_REF_PATTERN = /\b(esse|aquele|este|aquela|aquele)\s+conteúdo\b|o\s+que\s+eu\s+enviei|com\s+(esse|este|aquele|aquela)\s+conteúdo|usando\s+(aquele|esse|este)\s+conteúdo|\besse\s+material\b|\baquele\s+material\b/i;
    const hasContentRef = CONTENT_REF_PATTERN.test(goal.userIntent);
    const contentRefBlock = hasContentRef
        ? `\n⚠️ REFERÊNCIA A CONTEÚDO ANTERIOR DETECTADA: O usuário está referenciando conteúdo enviado anteriormente nesta conversa ou sessão.
ESTRATÉGIA OBRIGATÓRIA — siga exatamente esta ordem:
  1. Use memory_search para recuperar dados relevantes salvos sobre o tema.
  2. Use read nos arquivos do CONTEXTO (ARQUIVOS ENVIADOS AO USUÁRIO NESTA SESSÃO) que possam conter o conteúdo original — use os paths exatos listados.
  3. Se não houver arquivos entregues, use read no workspace para localizar arquivos relacionados ao tema.
  PROIBIDO: NÃO use web_search — o conteúdo referenciado está nas mensagens anteriores ou em arquivos do workspace, não na internet.\n`
        : '';

    const roadmapAdjustmentInstruction = goal.allowRoadmapAdjustment
        ? `\n- AJUSTE DO ROADMAP: Se você descobrir novas dependências, blockers ou a necessidade de reordenar os marcos, você pode retornar o roadmap inteiro redefinido e atualizado na propriedade JSON "adjustedRoadmap" (máximo de 3 a 5 marcos). Caso contrário, omita essa propriedade.\n`
        : '';

    return `Você é um planejador de tarefas. Decomponha o objetivo abaixo em steps executáveis com ferramentas.

OBJETIVO GLOBAL: ${goal.objective}
INTENÇÃO ORIGINAL: ${goal.userIntent}
${milestoneInstruction}
${pathsBlock}${contentRefBlock}${capBlock ? `\n${capBlock}\n` : ''}${skillBlock}${contextBlock}
Ferramentas disponíveis (use EXATAMENTE esses nomes): ${availableTools.join(', ')}
${toolDescriptions ?? ''}
${buildToolContracts(availableTools)}

Responda APENAS com JSON válido (sem markdown):
{
  "steps": [
    {
      "id": "step_1",
      "description": "descrição curta do que este step faz",
      "toolName": "write",
      "toolArgs": {
        "path": "index.html",
        "content": "<!DOCTYPE html>\n<html lang=\"pt-BR\">\n<head><meta charset=\"UTF-8\"><title>Título</title></head>\n<body><h1>Conteúdo real aqui</h1></body>\n</html>"
      },
      "fallbackSteps": []
    }
  ],
  "strategy": "descrição de 1 linha da estratégia geral",
  "adjustedRoadmap": ["Marco 1...", "Marco 2..."],
  "successCriteria": [
    { "id": "c1", "description": "O que deve ser verdade quando o objetivo estiver concluído", "check": "tool_succeeded|output_contains|output_not_contains|file_exists", "tool": "nome_da_tool", "value": "texto opcional para contains/not_contains" }
  ]
}

CRITÉRIOS DE SUCESSO (successCriteria) — máximo 3, verificados deterministicamente:
- tool_succeeded: algum attempt da tool teve resultado de sucesso. Ex: envio de arquivo → { "check": "tool_succeeded", "tool": "send_document" }
- output_not_contains: output de attempt bem-sucedido NÃO contém value. Ex: nome substituído → { "check": "output_not_contains", "tool": "exec_command", "value": "NomeAntigo" }
- output_contains: output contém value. Ex: conteúdo esperado existe → { "check": "output_contains", "tool": "exec_command", "value": "NovoConteudo" }
- file_exists: exec_command retornou output não-vazio (arquivo encontrado). Ex: arquivo criado → { "check": "file_exists", "tool": "exec_command" }
Inclua SEMPRE um critério tool_succeeded para send_document quando o objetivo envolve entrega de arquivo.

⚠️ GERAÇÃO DE CONTEÚDO EXTENSO (slides, relatórios, HTML completo, documentos) — LEIA PRIMEIRO:
Quando o objetivo exige criar um artefato extenso (apresentação, relatório, HTML de slides, documento longo):
  → NÃO coloque o content dentro do toolArgs do step "write".
  → OMITA toolName no step de síntese — o AgentLoop gerará o conteúdo real em runtime com os dados dos steps anteriores.
  → Padrão correto para "criar slides HTML sobre Scrum":
     Step 1: web_search (pesquisar)
     Step 2: {sem toolName} "Gere o HTML completo dos slides de Scrum com Reveal.js usando os dados pesquisados acima"
     Step 3: send_document (entregar)
  → O AgentLoop tem acesso ao output de web_search/read e produzirá o artefato real — você não pode pré-gerar isso no JSON do plano.
  → Qualquer write step com content curto ou placeholder será BLOQUEADO automaticamente pelo sistema.

CRIAÇÃO DE CONTEÚDO — regras para steps com "write" (conteúdo ESTÁTICO, não depende de pesquisa):
- O campo "content" DEVE conter o conteúdo COMPLETO e funcional do arquivo.
- O WriteTool grava literalmente o que está em "content" — nenhum sistema posterior irá completar ou expandir o texto.
- NUNCA use: TODO, placeholder, stub, comentário genérico, "HTML Content", "CSS Content", "JS Content", "conteúdo será adicionado depois".
- HTML: gere documento completo com <!DOCTYPE>, <head> e <body> totalmente preenchidos.
- README: gere documentação real, não "# Título\n(em construção)".
- CSS: gere regras funcionais com seletores e propriedades reais.
- JavaScript: gere código executável, não "// implementar aqui".
- Se o artefato for extenso, inclua pelo menos a estrutura completa com conteúdo representativo em cada seção.

Regras:
- Máximo 6 steps por plano
- Cada step usa UMA ferramenta
- toolArgs deve ser um objeto com os argumentos da ferramenta
- Use APENAS os nomes de ferramenta listados acima — não invente nomes
- Se não precisar de ferramenta específica, omita toolName e toolArgs
- CRÍTICO: se o objetivo menciona caminhos de arquivo, use-os EXATAMENTE como listados em "PATHS MENCIONADOS" — não encurte, não reconstrua
${roadmapAdjustmentInstruction}
ARGS OBRIGATÓRIOS POR FERRAMENTA:
- edit: SEMPRE forneça oldText+newText (substituição) OU startLine+endLine+content (patch) OU append=true+content. Nunca chame edit sem esses parâmetros.
- send_document: SEMPRE forneça file_path com o caminho completo do arquivo. Nunca chame send_document sem file_path.
- list_workspace: aceita caminho relativo (ex: "jogos/tower_defense") ou absoluto.
- read: aceita caminho relativo ao workspace ou absoluto.
- memory_write: SEMPRE forneça action (create|update|connect|delete|merge|reinforce). Para create: forneça type + name + content. Para update: forneça id + content. Para connect: forneça from + to + relation. Nunca chame memory_write sem action.
  TIPOS DE NÓ — escolha o correto para garantir persistência:
    "fact"       → dados pessoais do usuário (portfolio, posições, watchlists, histórico). Decay muito lento. USE ESTE para dados que o usuário forneceu explicitamente.
    "preference" → preferências e configurações do usuário.
    "project"    → projetos e objetivos em andamento.
    "knowledge"  → informações técnicas aprendidas.
    "context"    → dados efêmeros de sessão (desaparecem em dias). NÃO use para dados que o usuário precisa recuperar depois.
- crypto_analysis: SEMPRE forneça type (sangrando|gainers|losers|top100|detail). Para type="detail": forneça symbol (ex: "zec", "btc", "sol"). Para múltiplas moedas específicas: use steps separados, um por moeda.
- web_navigate: SEMPRE forneça action (search|open|follow_link). Para search: forneça query. Para open: forneça url (https://...). Para follow_link: forneça url + link_text.

COLETA EM LOTE (quando o objetivo exige buscar dados para N itens do mesmo tipo, N > 6):
- NÃO enumere um step por item — o limite de 6 steps deixaria itens sem cobertura.
- Use no máximo 2 steps:
  1. memory_search — verifique o que já está salvo sobre esses itens.
  2. Sem toolName (AgentLoop): inclua na description a lista COMPLETA de itens e instrua explicitamente a iterar sobre todos. Ex: "busque crypto_analysis para BTC, ETH, SOL, River, ZEC e Pi individualmente e consolide os resultados".
- O AgentLoop executará a iteração completa automaticamente — não limite a lista.`.trim();
}

function buildProgressBlock(progressModel: GoalProgressModel): string {
    if (progressModel.components.length === 0) return '';

    const lines: string[] = [];
    lines.push('PROGRESSO ATUAL DO OBJETIVO:');
    for (const c of progressModel.components) {
        const icon = c.status === 'completed' ? '✓' : c.status === 'failed' ? '✗' : '○';
        const evidencePart = c.evidence ? ` — ${c.evidence.slice(0, 80)}` : '';
        lines.push(`  ${icon} ${c.label}${evidencePart}`);
    }
    lines.push(`  Progresso: ${progressModel.overallPercent}% (${progressModel.components.filter(c => c.status === 'completed').length}/${progressModel.components.length} componentes)`);

    const pending = progressModel.components.filter(c => c.status !== 'completed');
    if (pending.length > 0) {
        lines.push(`FOCO: resolva apenas os componentes pendentes — ${pending.map(c => c.label).join('; ')}`);
    }

    return lines.join('\n');
}

function buildReplanPrompt(goal: Goal, blocker: GoalBlocker, reflectionHint: string, availableTools: string[], runtimeContext?: string, capabilityContext?: string, skillsSummary?: string, activeMilestone?: string, skillContext?: string, diversityBlock?: string, progressModel?: GoalProgressModel): string {
    const goalText            = `${goal.objective} ${goal.userIntent}`;
    const compressedRefl      = PromptComposer.compressReflection(reflectionHint);
    const capBlock            = PromptComposer.buildCompactEnv(capabilityContext ?? '', goalText, skillsSummary, compressedRefl);
    const skillBlock          = skillContext ? `\nINSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente para este replan):\n${skillContext}\n` : '';

    const strategiesBlock = goal.strategiesTried.length > 0
        ? `\nEstratégias já tentadas: ${goal.strategiesTried.join('; ')}\n`
        : '';

    const blockersBlock = goal.blockers.length > 0
        ? `\nBlockers anteriores: ${goal.blockers.map(b => `${b.kind}: ${b.description}`).join('; ')}\n`
        : '';

    const reflectionBlock = !capBlock && reflectionHint
        ? `\nHistórico de erros: ${reflectionHint.split('\n').slice(1, 3).join(' | ')}\n`
        : '';

    const memContext = runtimeContext ? PromptComposer.enforceMemoryBudget(runtimeContext) : '';
    const contextBlock = memContext
        ? `\nCONTEXTO (memória + feedback):\n${memContext}\n`
        : '';

    // Detecta loop de pip/venv: se já falhou 2+ vezes por environment_limit relacionado a
    // pip ou venv, injeta diretiva crítica para forçar abordagem sem instalação de pacotes.
    // O modelo tende a ignorar as regras gerais de PEP 668 quando o blocker não menciona
    // explicitamente "ensurepip" — esta diretiva específica quebra o loop.
    const envLimitPipVenvCount = goal.blockers.filter(b =>
        b.kind === 'environment_limit' &&
        /pep\s*668|pip\s*install|venv|ensurepip|externally.managed/i.test(b.description ?? '')
    ).length;
    const pipVenvLoopDirective = envLimitPipVenvCount >= 2
        ? `\n⛔ LOOP DETECTADO (${envLimitPipVenvCount} tentativas pip/venv falharam):
NÃO use pip install NEM python3 -m venv — ambos estão bloqueados neste ambiente.
ESTRATÉGIAS VÁLIDAS sem instalação:
  1. python3 -c "import zipfile, shutil, os; ..." — módulo zipfile é built-in, não precisa de pip
  2. Use ferramentas nativas disponíveis no ambiente (verifique capabilities antes de planejar)
  3. sed -i 's/Jader/Novo Nome/g' arquivo.xml — para edição de XML dentro de zips
Escolha UMA dessas abordagens. Qualquer plano com pip ou venv será bloqueado automaticamente.\n`
        : '';

    // Guard S3: exec_command repetitivo — proíbe a tool quando bloqueou 2+ vezes neste goal.
    // O modelo tende a voltar para exec_command em replans mesmo após bloqueios repetidos
    // (missing_tool ou tool_error), porque o StrategyDiversityGuard opera por "estratégia textual"
    // e não por nome de tool. Esta diretiva é um freio explícito por nome.
    const execCommandBlockerCount = goal.blockers.filter(
        b => b.toolName === 'exec_command' || (b.kind === 'tool_error' && /exec_command|marp|pandoc|html2pdf/i.test(b.description))
    ).length;
    const execCommandBanDirective = execCommandBlockerCount >= 2
        ? `\n⛔ exec_command BLOQUEADO (${execCommandBlockerCount} falhas neste goal):
exec_command falhou repetidamente — NÃO inclua exec_command em nenhum step deste replan.
ALTERNATIVAS obrigatórias:
  • Para gerar HTML/slides: use {sem toolName} — AgentLoop sintetiza diretamente com Reveal.js via CDN (sem conversão)
  • Para converter arquivos: use a skill correspondente via {sem toolName} descrevendo a conversão desejada
  • Para enviar resultado: use send_document com o arquivo já criado via write ou AgentLoop
  Qualquer step com toolName="exec_command" será descartado automaticamente.\n`
        : '';

    const priorIncompletes = goal.blockers.filter(b => b.kind === 'goal_incomplete').length;
    const priorAnalysisOnly = goal.strategiesTried.filter(s =>
        /anali[sz]|leitura|ler |audit|mapear|verificar|identificar|diagnosticar/i.test(s)
    ).length;
    const stuckInAnalysis = blocker.kind === 'goal_incomplete' &&
        (priorIncompletes >= 1 || priorAnalysisOnly >= 2);

    const implementDirective = stuckInAnalysis
        ? `\nALERTA: LOOP DE ANÁLISE DETECTADO — ciclos anteriores só fizeram leitura sem implementar.
OBRIGATÓRIO neste replan:
  1. NÃO planeje mais steps somente de read/exec_command/list_workspace — contexto já foi coletado.
  2. IMPLEMENTE usando write ou edit para modificar os arquivos necessários.
  3. ENTREGUE: inclua step final que confirme o resultado ao usuário (send_document ou write com resumo).
  Um plano que só lê arquivos sem modificar/entregar será rejeitado novamente.\n`
        : '';

    // Diretiva específica para content_stub: orienta o modelo a usar AgentLoop (sem toolName)
    // em vez de tentar escrever content estático no plano JSON. Acionada quando o WriteTool
    // bloqueou por CONTENT-STUB-GATE ou quando o GoalEvaluator classificou como content_stub.
    const contentStubCount = goal.blockers.filter(b => b.kind === 'content_stub').length;
    const contentStubDirective = (contentStubCount >= 1 || blocker.kind === 'content_stub')
        ? `\n⚠️ ERRO DE CONTEÚDO PLACEHOLDER — tentativas anteriores gravaram stubs em vez de conteúdo real.
CAUSA: o step "write" teve o campo "content" com um placeholder (ex: "[Conteúdo completo da aula]", "... (HTML completo) ...").
SOLUÇÃO OBRIGATÓRIA neste replan:
  1. NÃO use toolName="write" com content estático para documentos extensos (slides, HTML, relatórios).
  2. OMITA toolName no step de síntese — o AgentLoop gerará o conteúdo REAL com contexto dos steps anteriores.
  3. Padrão CORRETO:
     {"id":"step_2","description":"Gere o HTML completo dos slides de Scrum com Reveal.js usando os dados pesquisados acima"} (sem toolName, sem toolArgs)
  4. O AgentLoop tem acesso ao output de web_search/read e produzirá o artefato final — você NÃO precisa pré-gerar content.
  Qualquer step com toolName="write" e content curto/placeholder será bloqueado novamente.\n`
        : '';

    const milestoneInstruction = activeMilestone
        ? `\n⚠️ CONSTRUÇÃO INCREMENTAL ATIVA:
Proponha uma nova estratégia para resolver o Marco Atual. NÃO tente resolver o objetivo global ou outros marcos do roadmap ainda.
MARCO ATUAL A SER RESOLVIDO: ${activeMilestone}\n`
        : '';

    const roadmapAdjustmentInstruction = goal.allowRoadmapAdjustment
        ? `\n- AJUSTE DO ROADMAP: Se você descobrir novas dependências, blockers ou a necessidade de reordenar os marcos, você pode sugerir o roadmap inteiro redefinido e atualizado na propriedade JSON "adjustedRoadmap" (máximo de 3 a 5 marcos). Caso contrário, omita essa propriedade.\n`
        : '';

    // P4: dica de retry com args corrigidos quando o blocker é de arg inválido/ausente
    const lastFailedTool = [...(goal.currentPlan ?? [])].reverse().find(s => s.status === 'failed')?.toolName;
    const retryHint = (blocker.kind === 'goal_incomplete' && lastFailedTool)
        ? `\n⚡ DICA DE CORREÇÃO: A ferramenta "${lastFailedTool}" foi executada mas não produziu o resultado esperado. Antes de trocar de estratégia, considere se pode reutilizar "${lastFailedTool}" com argumentos corrigidos (ex: dry_run=false, path completo, etc.).\n`
        : '';

    // Dica específica quando o blocker é estouro de contexto por leitura de arquivo grande
    const ratioLimitHint = /ratio.?limit|estouro.*contexto|context.*overflow|contexto.*cresceu|limite.*técnico.*sistema|proporção.*contexto|html.*não.*foi.*criado|não.*gerou.*html|apenas.*txt|apenas.*texto.*criado|arquivo.*html.*ausente|entregável.*não.*produzido/i.test(blocker.description)
        ? `\n⚡ DICA CRÍTICA (ESTOURO DE CONTEXTO): A estratégia anterior falhou porque ler o arquivo inteiro no contexto excedeu o limite de proporção (ratio_limit). ` +
          `Para modificar arquivos HTML/texto grandes (> 8KB), use exec_command com Python/sed DIRETO — nunca read + write:\n` +
          `  Exemplo: exec_command → python3 -c "c=open('workspace/arquivo.html').read(); open('workspace/arquivo.html','w').write('<div>CAPA</div>\\\\n'+c)"\n` +
          `  Isso processa o arquivo SEM injetar o conteúdo no contexto do LLM.\n`
        : '';

    const diversitySection = diversityBlock ? `\n${diversityBlock}\n` : '';
    const progressSection = progressModel ? `\n${buildProgressBlock(progressModel)}\n` : '';

    return `Você é um planejador de tarefas. Um blocker foi detectado. Proponha uma NOVA estratégia.

OBJETIVO GLOBAL: ${goal.objective}
${milestoneInstruction}
BLOCKER ATUAL: ${blocker.description} (tipo: ${blocker.kind})
AÇÕES SUGERIDAS PELO SISTEMA: ${blocker.suggestedActions.join('; ')}${retryHint}${ratioLimitHint}
${pipVenvLoopDirective}${execCommandBanDirective}${contentStubDirective}${implementDirective}${skillBlock}${capBlock}${strategiesBlock}${blockersBlock}${reflectionBlock}${contextBlock}${progressSection}${diversitySection}
IMPORTANTE: Não repita estratégias já tentadas. Proponha abordagem genuinamente diferente.

${buildToolContracts(availableTools)}

Responda APENAS com JSON válido (sem markdown):
{
  "steps": [
    {
      "id": "step_1",
      "description": "descrição curta",
      "toolName": "nome_da_ferramenta",
      "toolArgs": { "argumento": "valor" }
    }
  ],
  "strategy": "descrição de 1 linha da nova estratégia",
  "adjustedRoadmap": ["Marco 1...", "Marco 2..."]
}

Máximo 3 steps. Se o blocker for 'missing_tool', inclua step de instalação como primeiro step.
${roadmapAdjustmentInstruction}
REFERÊNCIA DE ARGS OBRIGATÓRIOS:
- edit: SEMPRE forneça oldText+newText (para substituição) OU startLine+endLine+content (para patch) OU append=true+content. Nunca chame edit sem esses parâmetros.
- send_document: SEMPRE forneça file_path com o caminho completo do arquivo. Nunca chame send_document sem file_path.
- list_workspace: aceita caminho relativo (ex: "jogos/tower_defense") OU absoluto. Passe apenas a subpasta desejada.
- read: aceita caminho relativo ao workspace ou absoluto. Para diretórios, lista automaticamente o conteúdo.
- memory_write: SEMPRE forneça action (create|update|connect|delete|merge|reinforce). Para create: forneça type + name + content. Para update: forneça id + content. Para connect: forneça from + to + relation.
  TIPOS — use "fact" para dados pessoais do usuário (portfolio, watchlist, posições); "preference" para preferências; "context" APENAS para dados efêmeros de sessão (some em dias).
- crypto_analysis: SEMPRE forneça type (sangrando|gainers|losers|top100|detail). Para type="detail": forneça symbol (ex: "zec", "btc"). Para múltiplas moedas: use steps separados.
- web_navigate: SEMPRE forneça action (search|open|follow_link). Para search: forneça query. Para open: forneça url (https://...). Para follow_link: forneça url + link_text.

COLETA EM LOTE (quando o objetivo exige buscar dados para N itens do mesmo tipo, N > 6):
- NÃO enumere um step por item — o limite de 6 steps deixaria itens sem cobertura.
- Use no máximo 2 steps:
  1. memory_search — verifique o que já está salvo sobre esses itens.
  2. Sem toolName (AgentLoop): inclua na description a lista COMPLETA de itens e instrua a iterar sobre todos. Ex: "busque crypto_analysis para BTC, ETH, SOL, River, ZEC e Pi individualmente e consolide".
- O AgentLoop executará a iteração completa — não limite a lista.

REGRAS CRÍTICAS para blocker 'environment_limit':
- Se o blocker mencionar PEP 668 ou 'externally-managed':
  → NÃO use pip install direto nem --break-system-packages.
  → Use venv: python3 -m venv venv && venv/bin/pip install <pacote> && venv/bin/python script.py
  → Se venv também falhar, use módulos built-in do Python (zipfile, json, csv, os, shutil).
- Se o blocker mencionar 'ensurepip not available' ou 'python3-venv não instalado':
  → NÃO use python3 -m venv. Use módulos built-in ou skills disponíveis (ver INSTRUÇÕES DE SKILL acima).
  → Verifique capabilities do ambiente antes de planejar qualquer comando de conversão.`.trim();
}

function buildRoadmapPrompt(goal: Goal, availableTools: string[], skillContext?: string, _runtimeContext?: string, capabilityContext?: string, skillsSummary?: string): string {
    const capBlock = PromptComposer.buildCompactEnv(capabilityContext ?? '', goal.objective, skillsSummary);
    const skillBlock = skillContext ? `\nINSTRUÇÕES DE SKILL:\n${skillContext}\n` : '';
    
    return `Você é um arquiteto de software especialista em desenvolvimento ágil e seguro. Crie um roadmap de desenvolvimento incremental para o objetivo abaixo.
    
OBJETIVO GLOBAL DO USUÁRIO: ${goal.objective}
INTENÇÃO ORIGINAL: ${goal.userIntent}
${capBlock ? `\n${capBlock}\n` : ''}${skillBlock}
Ferramentas disponíveis: ${availableTools.join(', ')}

Divida o desenvolvimento em um roadmap de 3 a 5 marcos (milestones) sequenciais e incrementais.
Regras do Roadmap Incremental:
1. O Marco 1 DEVE ser de análise de arquitetura, dependências, capabilities do ambiente e estruturação inicial.
2. Cada marco seguinte deve ser extremamente focado (ex: "criar map.js", "criar tower.js"), contendo apenas uma parte lógica que possa ser executada e validada de forma independente.
3. Não crie marcos genéricos ou grandes demais. Menos é mais: queremos ciclos pequenos e auditáveis.

Responda APENAS com JSON válido (sem markdown, sem tags, sem texto extra):
{
  "roadmap": [
    "Marco 1: Explorar o ambiente, analisar dependências e estruturar a inicialização do projeto.",
    "Marco 2: Implementar o mapa..."
  ]
}`.trim();
}

// Extrai caminhos Unix absolutos do texto (mínimo 2 segmentos: /a/b ou mais).
// Usado para preservar caminhos literais informados pelo usuário no prompt de planejamento.
// Aceita um caminho se, após normalização, ele apontar para dentro do WORKSPACE_DIR.
// Rejeita apenas caminhos fora do workspace ou tentativas de path traversal.
function extractUnixPaths(text: string): string[] {
    const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));
    // Remove URLs antes de extrair para não capturar paths locais embutidos em URLs
    const sanitized = text
        .replace(/file:\/\/\/[^\s"')]+/gi, '')
        .replace(/https?:\/\/[^\s"')]+/gi, '');
    const matches = sanitized.match(/\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) ?? [];
    return [...new Set(matches)].filter(p => {
        // Aceita somente se o path, após normalização, pertencer ao WORKSPACE_DIR.
        // Rejeita paths de outras máquinas, paths de sistema e tentativas de traversal.
        const rel = path.relative(workspaceDir, path.normalize(p));
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
}

const PLACEHOLDER_ARG_PATTERN =
    /\b(caminho_do|path_to|arquivo_identificado|the_file_path|nome_do_arquivo|your_file|nome_arquivo)\b|\{[a-zA-Z_][a-zA-Z0-9_]{0,40}\}|\/path\/to\/|\/caminho\/do\/|\{\{step_\d+\.output\}\}/i;

// WRITE-CONTENT-STUB: detecta content placeholder em steps write — converte para AgentLoop.
// Espelha o CONTENT-STUB-GATE do WriteTool, mas atua antes da execução, durante o parse do plano.
// O modelo (gemma4:31b-cloud) tende a gerar {"toolName":"write","content":"<67-char-stub>"} em vez de
// omitir toolName para que o AgentLoop sintetize o conteúdo real a partir de web_search anteriores.
const WRITE_CONTENT_STUB_PATTERNS: RegExp[] = [
    /\.\.\.\s*\(.*?conteúdo/i,
    /\(conteúdo\s+(completo|da\s+aula|real)\b/i,
    /\[conteúdo\s*(completo|real|aqui|será|abrang)/i,
    /\[.*?completo.*?abrang/i,
    /<html>\s*<body>\s*\.\.\./i,
    /\[TODO[^\]]*\]/i,
    /\[inserir\s+aqui\]/i,
    /conteúdo será adicionado depois/i,
    /\(em\s+construção\)/i,
    /HTML\s+Content\b|CSS\s+Content\b|JS\s+Content\b/i,
];

// ── Aliases de ferramentas: nomes que LLMs inventam → nome real no ToolRegistry ──
const TOOL_ALIASES: Record<string, string> = {
    provide_file: 'send_document',
    deliver_file: 'send_document',
    download_file: 'send_document',
    upload_file: 'send_document',
    send_file: 'send_document',
    file_send: 'send_document',
    send: 'send_document',
    run_command: 'exec_command',
    execute: 'exec_command',
    execute_command: 'exec_command',
    shell: 'exec_command',
    bash: 'exec_command',
    search_web: 'web_search',
    browse: 'web_navigate',
    read_file: 'read',
    open_file: 'read',
    cat_file: 'read',
    get_file: 'read',
    list_files: 'list_workspace',
    ls: 'list_workspace',
};

// ── Validação de args obrigatórios ────────────────────────────────────────────

export function detectMissingRequiredArgs(tool: string, args: Record<string, unknown>): string | null {
    if (tool === 'read' && !args['path']) {
        return "sem 'path' obrigatório";
    }
    if (tool === 'write' && !args['path']) {
        return "sem 'path' obrigatório";
    }
    if (tool === 'edit') {
        const hasReplace = args['oldText'] !== undefined && args['newText'] !== undefined;
        const hasPatch   = args['startLine'] !== undefined && args['endLine'] !== undefined && args['content'] !== undefined;
        const hasAppend  = args['append'] === true && args['content'] !== undefined;
        if (!hasReplace && !hasPatch && !hasAppend) {
            return "sem args obrigatórios (oldText+newText | startLine+endLine+content | append+content)";
        }
    }
    if (tool === 'send_document' && !args['file_path']) {
        return "sem 'file_path' obrigatório";
    }
    if (tool === 'send_audio' && !args['file_path']) {
        return "sem 'file_path' obrigatório";
    }
    if (tool === 'read_document' && !args['filename'] && !args['file_path'] && !args['path']) {
        return "sem 'filename' obrigatório";
    }
    if (tool === 'web_navigate') {
        const action = String(args['action'] ?? '').trim();
        const VALID_NAVIGATE_ACTIONS = new Set(['search', 'open', 'follow_link']);
        if (!action) return "sem 'action' obrigatório (use: search|open|follow_link)";
        if (!VALID_NAVIGATE_ACTIONS.has(action)) return `action='${action}' inválida — use: search|open|follow_link`;
        if (action === 'search' && !args['query']) return "action=search exige 'query'";
        if (action === 'open' && !args['url']) return "action=open exige 'url'";
        if (action === 'follow_link' && (!args['url'] || !args['link_text'])) return "action=follow_link exige 'url' + 'link_text'";
    }
    return null;
}

// ── GoalPlanner ───────────────────────────────────────────────────────────────

// Configurável via PLANNER_MODEL — usar nome de modelo compatível com DEFAULT_PROVIDER
// Ollama: 'gemma4:31b-cloud' | OpenRouter: 'google/gemini-2.0-flash' | Gemini: 'gemini-2.0-flash'
const PLANNER_MODEL_DEFAULT = process.env.PLANNER_MODEL || 'gemma4:31b-cloud';

export class GoalPlanner {
    private model: string = PLANNER_MODEL_DEFAULT;
    private skillContext: string | undefined;
    private readonly skillLoader = new SkillLoader();
    private skillsSummaryCache: { summary: string; loadedAt: number } | null = null;
    private static readonly SKILLS_CACHE_TTL_MS = 60_000;

    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    setModel(model: string): void {
        if (model) this.model = model;
    }

    private loadSkillsSummary(): string {
        if (this.skillsSummaryCache &&
            Date.now() - this.skillsSummaryCache.loadedAt < GoalPlanner.SKILLS_CACHE_TTL_MS) {
            return this.skillsSummaryCache.summary;
        }
        try {
            const skills = this.skillLoader.loadAll();
            const summary = skills.length === 0
                ? ''
                : skills.map(s => `  - ${s.name}: ${s.description}`).join('\n');
            this.skillsSummaryCache = { summary, loadedAt: Date.now() };
            return summary;
        } catch {
            return '';
        }
    }

    private async callPlannerLLM(messages: LLMMessage[], timeoutMs: number): Promise<{ status: string; content: string }> {
        const provider = this.providerFactory.getProviderWithModel(this.model);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await provider.chat(messages, undefined, { signal: controller.signal, timeoutMs });
            return { status: 'success', content: response.content };
        } catch (err) {
            const msg = String(err);
            if (msg.includes('abort') || msg.includes('timed out') || msg.includes('timeout')) {
                return { status: 'timeout', content: '' };
            }
            return { status: 'error', content: '' };
        } finally {
            clearTimeout(timer);
        }
    }

    setSkillContext(context: string): void {
        this.skillContext = context || undefined;
    }

    /**
     * Expõe a lista de skills disponíveis para Q1 (contextualize) e Q2 (RiskAnalyzer).
     * Reutiliza a instância e o cache já existentes — sem nova instância de SkillLoader.
     */
    getAvailableSkills(): import('../skills/SkillLoader').Skill[] {
        return this.skillLoader.loadAll();
    }

    async plan(goal: Goal, runtimeContext?: string, capabilityContext?: string, activeMilestone?: string): Promise<PlanResult> {
        log.info(`[GoalPlanner] plan start goal=${goal.id} model=${this.model} contextLen=${runtimeContext?.length ?? 0}`);

        const availableTools = ToolRegistry.getEnabled().map(t => t.name);
        const skillsSummary  = this.loadSkillsSummary();
        const toolDescriptions = buildToolDescriptions(availableTools);
        const prompt         = buildPlanPrompt(goal, availableTools, this.skillContext, runtimeContext, capabilityContext, skillsSummary, activeMilestone, toolDescriptions);
        const capBlock       = PromptComposer.buildCompactEnv(capabilityContext ?? '', `${goal.objective} ${goal.userIntent}`, skillsSummary);
        const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

        PromptComposer.recordPlan(prompt.length, capBlock.length, 0, runtimeContext?.length ?? 0);

        try {
            // S7: 90s para planos iniciais — goals complexos (slides, relatórios, código extenso)
            // precisam de mais tempo que os 45s originais. O stream aborta com 458 chars e o sistema
            // cai no fallbackPlan (AgentLoop sem web_search), gerando slides sem pesquisa.
            const result = await this.callPlannerLLM(messages, 90_000);

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] plan failed: model=${this.model} status=${result.status} raw="${result.content.slice(0, 150)}"`);
                return this.fallbackPlan(goal);
            }

            let parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                log.warn(`[GoalPlanner] plan empty after parse: model=${this.model} raw="${result.content.slice(0, 200)}"`);
                const retried = await this.retryWithMinimalPrompt(goal, 'plan');
                if (retried) parsed = retried;
                else return this.fallbackPlan(goal);
            }

            const steps = this.prependPathValidation(goal, parsed.steps);
            log.info(`[GoalPlanner] plan ok: steps=${steps.length} strategy="${parsed.strategy}" tools=[${steps.map(s => s.toolName ?? 'agentloop').join(',')}]`);
            PromptComposer.logMetrics();
            return { steps, strategy: parsed.strategy };
        } catch (err) {
            log.warn(`[GoalPlanner] plan exception: model=${this.model} err="${String(err).slice(0, 100)}"`);
            return this.fallbackPlan(goal);
        }
    }

    async replan(goal: Goal, blocker: GoalBlocker, runtimeContext?: string, capabilityContext?: string, activeMilestone?: string, progressModel?: GoalProgressModel): Promise<PlanResult> {
        log.info(`[GoalPlanner] replan start goal=${goal.id} model=${this.model} blocker=${blocker.kind} contextLen=${runtimeContext?.length ?? 0}`);

        // P4 observabilidade: registra a decisão de replanejamento com causa raiz detectável
        const lastFailedStep = [...(goal.currentPlan ?? [])].reverse()
            .find(s => s.status === 'failed');
        const lastTool = lastFailedStep?.toolName;
        const retryWithCorrectedArgs = blocker.kind === 'goal_incomplete' && lastTool
            ? `retry ${lastTool} with corrected args`
            : 'new_strategy';
        log.info(
            `[REPLAN-DECISION]` +
            ` goal=${goal.id}` +
            ` failed_step=${lastFailedStep?.id ?? 'none'}` +
            ` failed_tool=${lastTool ?? 'none'}` +
            ` root_cause=${blocker.kind}` +
            ` blocker_desc="${blocker.description.slice(0, 120)}"` +
            ` selected_strategy=${retryWithCorrectedArgs}` +
            ` replan_budget=${goal.replanBudget}`
        );

        const reflectionHint = this.reflectionMemory.buildContextHint(
            blocker.toolName ? `tool_${blocker.toolName}` : blocker.kind
        );
        if (reflectionHint) {
            log.debug(`[GoalPlanner] reflectionHint injected (${reflectionHint.length} chars)`);
        }

        const skillsSummary     = this.loadSkillsSummary();
        const availableTools    = ToolRegistry.getEnabled().map(t => t.name);
        const compressedRefl    = PromptComposer.compressReflection(reflectionHint);
        const goalText          = `${goal.objective} ${goal.userIntent}`;
        const capBlock          = PromptComposer.buildCompactEnv(capabilityContext ?? '', goalText, skillsSummary, compressedRefl);
        const diversityConstraints = StrategyDiversityGuard.buildConstraints(goal);
        log.debug(
            `[GoalPlanner] diversity constraints:` +
            ` forbidden=${diversityConstraints.forbiddenFingerprints.length}` +
            ` exhausted=${diversityConstraints.exhaustedTools.length}`
        );
        const prompt            = buildReplanPrompt(goal, blocker, reflectionHint, availableTools, runtimeContext, capabilityContext, skillsSummary, activeMilestone, this.skillContext, diversityConstraints.promptBlock, progressModel);
        const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

        PromptComposer.recordReplan();
        PromptComposer.recordPlan(prompt.length, capBlock.length, compressedRefl.length, runtimeContext?.length ?? 0);

        try {
            const result = await this.callPlannerLLM(messages, 45_000);

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] replan failed: model=${this.model} status=${result.status} raw="${result.content.slice(0, 150)}"`);
                return this.emergencyFallback(goal, blocker);
            }

            let parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                log.warn(`[GoalPlanner] replan empty after parse: model=${this.model} raw="${result.content.slice(0, 200)}"`);
                const retried = await this.retryWithMinimalPrompt(goal, 'replan');
                if (retried) parsed = retried;
                else return this.emergencyFallback(goal, blocker);
            }

            const steps = this.prependPathValidation(goal, parsed.steps);
            log.info(`[GoalPlanner] replan ok: steps=${steps.length} strategy="${parsed.strategy}" tools=[${steps.map(s => s.toolName ?? 'agentloop').join(',')}]`);

            const prevTools = (goal.currentPlan ?? []).map(s => (s as { toolName?: string }).toolName ?? 'agentloop').join(',');
            const newTools  = steps.map(s => s.toolName ?? 'agentloop').join(',');
            const prevStrategy = goal.cycleFocus ?? '';
            log.info('REPLAN_DIFF',
                `goal=${goal.id}` +
                ` prev_tools="${prevTools}"` +
                ` new_tools="${newTools}"` +
                ` structurally_identical=${prevTools === newTools}` +
                ` strategy_changed=${prevStrategy !== parsed.strategy}` +
                ` prev_strategy="${prevStrategy.slice(0, 80)}"` +
                ` new_strategy="${parsed.strategy.slice(0, 80)}"`
            );

            PromptComposer.logMetrics();
            return { steps, strategy: parsed.strategy };
        } catch (err) {
            log.warn(`[GoalPlanner] replan exception: model=${this.model} err="${String(err).slice(0, 100)}"`);
            return this.emergencyFallback(goal, blocker);
        }
    }

    async planRoadmap(goal: Goal, runtimeContext?: string, capabilityContext?: string): Promise<string[]> {
        log.info(`[GoalPlanner] planRoadmap start goal=${goal.id} model=${this.model}`);

        const availableTools = ToolRegistry.getEnabled().map(t => t.name);
        const skillsSummary  = this.loadSkillsSummary();
        const prompt         = buildRoadmapPrompt(goal, availableTools, this.skillContext, runtimeContext, capabilityContext, skillsSummary);
        const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

        try {
            const result = await this.callPlannerLLM(messages, 45_000);

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] planRoadmap failed status=${result.status}`);
                return this.fallbackRoadmap(goal);
            }

            const cleaned = result.content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();
            const parsed = JSON.parse(cleaned);
            const roadmap = Array.isArray(parsed.roadmap) ? parsed.roadmap : [];
            
            if (roadmap.length === 0) {
                return this.fallbackRoadmap(goal);
            }
            
            log.info(`[GoalPlanner] planned roadmap with ${roadmap.length} milestones`);
            return roadmap;
        } catch (err) {
            log.warn(`[GoalPlanner] planRoadmap exception: ${String(err)}`);
            return this.fallbackRoadmap(goal);
        }
    }

    private fallbackRoadmap(goal: Goal): string[] {
        return [
            "Marco 1: Analisar os requisitos do projeto, dependências do ambiente e preparar a estrutura de diretórios.",
            `Marco 2: Implementar e testar as funcionalidades necessárias para atingir o objetivo: ${goal.objective}`
        ];
    }

    // ── Parsing ───────────────────────────────────────────────────────────────

    private parsePlanResponse(content: string): PlanResult {
        try {
            const cleaned = content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();

            const parsed = JSON.parse(cleaned);
            const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
            const adjustedRoadmap = Array.isArray(parsed.adjustedRoadmap) ? parsed.adjustedRoadmap : undefined;

            // P1 — telemetria de truncamento: mede se o limite de 6 steps está descartando
            // steps relevantes do LLM sem alterar comportamento do slice.
            const rawCount = rawSteps.length;
            const truncatedCount = Math.max(0, rawCount - 6);
            const containsWrite = rawSteps.some((s: Record<string, unknown>) => String(s['toolName'] ?? '') === 'write');
            const containsWriteInTruncated = rawSteps.slice(6).some((s: Record<string, unknown>) => String(s['toolName'] ?? '') === 'write');
            if (rawCount > 0) {
                log.info(
                    `[PLANNER-METRICS]` +
                    ` rawSteps=${rawCount}` +
                    ` truncatedSteps=${truncatedCount}` +
                    ` wasTruncated=${truncatedCount > 0}` +
                    ` containsWrite=${containsWrite}` +
                    ` writeInTruncated=${containsWriteInTruncated}`
                );
            }

            const steps: PlanStep[] = rawSteps.slice(0, 6).map((s: Record<string, unknown>, i: number) => {
                const rawToolName = s.toolName ? String(s.toolName) : undefined;

                // Resolve alias antes de validar (ex: provide_file → send_document)
                const canonicalName = rawToolName
                    ? (TOOL_ALIASES[rawToolName] ?? rawToolName)
                    : undefined;

                // Valida se a tool existe no ToolRegistry.
                let resolvedTool = canonicalName && ToolRegistry.get(canonicalName)
                    ? canonicalName
                    : undefined;

                if (rawToolName && !resolvedTool) {
                    log.warn(`[GoalPlanner] tool '${rawToolName}' não existe no ToolRegistry — step será tratado sem tool`);
                } else if (canonicalName && canonicalName !== rawToolName) {
                    log.info(`[GoalPlanner] tool alias '${rawToolName}' → '${canonicalName}'`);
                }

                // Item 8: Detectar placeholder paths em toolArgs.
                // Se algum argumento é um placeholder (caminho_do_*, <path>, {file}),
                // remove toolName/toolArgs para forçar AgentLoop a resolver o caminho real.
                let toolArgs: Record<string, unknown> | undefined = resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
                    ? s.toolArgs as Record<string, unknown>
                    : undefined;

                if (resolvedTool && toolArgs) {
                    const placeholderEntry = Object.entries(toolArgs).find(
                        ([, v]) => typeof v === 'string' && PLACEHOLDER_ARG_PATTERN.test(v)
                    );
                    if (placeholderEntry) {
                        log.warn(`[GoalPlanner] step ${i + 1} has placeholder arg ${placeholderEntry[0]}="${String(placeholderEntry[1]).slice(0, 80)}" — converting to AgentLoop step`);
                        resolvedTool = undefined;
                        toolArgs = undefined;
                    }
                }

                // WRITE-CONTENT-STUB: detecta write steps com conteúdo placeholder e converte para AgentLoop.
                // Quando o model gera {"toolName":"write","content":"<82-char-stub>"}, a execução
                // "succeeds" mas grava lixo — o GoalExecutionLoop gasta todo o replanBudget em
                // exec_command/ssh_exec antes de perceber que o artefato é inválido.
                // A conversão para AgentLoop faz o LLM sintetizar o conteúdo REAL em runtime,
                // com acesso ao output dos steps anteriores (web_search, read, etc.).
                if (resolvedTool === 'write' && toolArgs?.content) {
                    const contentStr = String(toolArgs.content);
                    const stubMatch = WRITE_CONTENT_STUB_PATTERNS.find(p => p.test(contentStr));
                    if (stubMatch) {
                        log.warn(
                            `[GoalPlanner] step ${i + 1}: write content stub detectado ` +
                            `(${contentStr.length} chars, pattern="${stubMatch.source.slice(0, 50)}") ` +
                            `— convertendo para AgentLoop step`
                        );
                        resolvedTool = undefined;
                        toolArgs = undefined;
                    }
                }

                // Valida args obrigatórios de ferramentas que falham silenciosamente
                // quando chamadas sem os parâmetros corretos. Converte para AgentLoop
                // (sem toolName) para que o LLM resolva com contexto completo, em vez
                // de deixar a tool explodir com erro de parâmetro obrigatório.
                // Validate required args even when toolArgs is absent (e.g. send_document without file_path).
                // Previously the check was skipped when toolArgs was undefined, letting invalid steps
                // pass through to the RiskAnalyzer instead of being caught here.
                if (resolvedTool) {
                    const missing = detectMissingRequiredArgs(resolvedTool, toolArgs ?? {});
                    if (missing) {
                        log.warn(`[GoalPlanner] step ${i + 1}: '${resolvedTool}' ${missing} — converting to AgentLoop step`);
                        resolvedTool = undefined;
                        toolArgs = undefined;
                    }
                }

                return {
                    id: String(s.id ?? `step_${i + 1}`),
                    description: String(s.description ?? 'Execute step'),
                    toolName: resolvedTool,
                    toolArgs,
                    fallbackSteps: [],
                    status: 'pending' as const,
                };
            });

            // Parseia e valida os successCriteria
            const VALID_CHECKS = new Set<string>(['tool_succeeded', 'output_not_contains', 'output_contains', 'file_exists']);
            const rawCriteria = Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [];
            const successCriteria: SuccessCriterion[] = rawCriteria
                .slice(0, 3)
                .filter((c: Record<string, unknown>) => c.id && c.description && VALID_CHECKS.has(String(c.check ?? '')))
                .map((c: Record<string, unknown>): SuccessCriterion => ({
                    id: String(c.id),
                    description: String(c.description),
                    check: String(c.check) as CriterionCheck,
                    tool: c.tool ? String(c.tool) : undefined,
                    value: c.value ? String(c.value) : undefined,
                    status: 'pending',
                }));

            return { steps, strategy: String(parsed.strategy ?? ''), adjustedRoadmap, successCriteria };
        } catch {
            return { steps: [], strategy: '' };
        }
    }

    // ── Injeção determinística de validação de paths ──────────────────────────

    /**
     * Quando o userIntent menciona caminhos Unix absolutos, injeta um step de
     * verificação (exec_command ls) ANTES do primeiro step do plano.
     *
     * Motivação: o LLM de planejamento frequentemente trunca ou reconstrói paths
     * (ex: omite "workspace/" do meio do caminho), causando falhas de "No such
     * file or directory" que consomem todo o replanBudget em navegação de
     * diretório. Verificar o path com os dados literais do usuário, antes de
     * qualquer operação de escrita/leitura, falha rápido na primeira tentativa e
     * direciona o replan com a informação correta.
     *
     * Não injeta quando:
     *   - O plano não tem steps com exec_command/edit/read/write (sem file ops)
     *   - O primeiro step já é uma verificação de path (test -d, ls, find)
     *   - Nenhum path Unix foi encontrado no userIntent
     */
    private prependPathValidation(goal: Goal, steps: PlanStep[]): PlanStep[] {
        const userPaths = extractUnixPaths(goal.userIntent);
        if (userPaths.length === 0) return steps;

        // Só injeta se o plano envolve operações de arquivo
        const hasFileOps = steps.some(s =>
            s.toolName === 'exec_command' || s.toolName === 'edit' ||
            s.toolName === 'read' || s.toolName === 'write'
        );
        if (!hasFileOps) return steps;

        // Não injeta se o primeiro step já é uma verificação de path
        const firstCmd = String(steps[0]?.toolArgs?.command ?? '');
        if (steps[0]?.toolName === 'exec_command' && /\btest\s+-[de]\b|\bls\s|\bfind\s/.test(firstCmd)) {
            return steps;
        }

        const topPaths = userPaths.slice(0, 2);
        const checkCmd = topPaths
            .map(p => `ls "${p}" 2>/dev/null && echo "PATH_OK: ${p}" || echo "PATH_MISSING: ${p}"`)
            .join('; ');

        const validationStep: PlanStep = {
            id: 'step_path_check',
            description: `Verificar existência do(s) caminho(s): ${topPaths.join(', ')}`,
            toolName: 'exec_command',
            toolArgs: { command: checkCmd },
            status: 'pending',
            fallbackSteps: [],
        };

        log.info(`[GoalPlanner] path validation step injected for ${topPaths.length} path(s): ${topPaths.join(', ')}`);
        return [validationStep, ...steps];
    }

    // ── Retry minimal — quando o modelo usa thinking-only e o JSON parse falha ──

    private buildMinimalPrompt(goal: Goal): string {
        const tools = ToolRegistry.getEnabled().map(t => t.name).join(', ');
        return `Objetivo: ${goal.objective}
Ferramentas disponíveis: ${tools}

Decomponha em 2-3 steps executáveis. Responda APENAS com JSON válido (sem markdown):
{"steps":[{"id":"step_1","description":"descrição","toolName":"nome_da_tool","toolArgs":{"arg":"valor"}}],"strategy":"estratégia em 1 linha"}

Regras:
- Use EXATAMENTE os nomes de ferramenta listados acima
- Para arquivos grandes use exec_command com Python/sed em vez de read+write
- O step final deve ser send_document quando o resultado for um arquivo`.trim();
    }

    private async retryWithMinimalPrompt(goal: Goal, context: 'plan' | 'replan'): Promise<PlanResult | null> {
        const prompt = this.buildMinimalPrompt(goal);
        const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
        log.info(`[GoalPlanner] retry_minimal context=${context} goal=${goal.id} promptLen=${prompt.length}`);
        try {
            const result = await this.callPlannerLLM(messages, 30_000);
            if (result.status !== 'success' || !result.content) return null;
            const parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                log.warn(`[GoalPlanner] retry_minimal also empty: raw="${result.content.slice(0, 120)}"`);
                return null;
            }
            log.info(`[GoalPlanner] retry_minimal ok: steps=${parsed.steps.length} strategy="${parsed.strategy}"`);
            return parsed;
        } catch {
            return null;
        }
    }

    // ── Fallbacks sem LLM ─────────────────────────────────────────────────────

    private fallbackPlan(goal: Goal): PlanResult {
        // Plano minimalista: passa o objetivo direto para o AgentLoop sem decomposição
        return {
            steps: [{
                id: 'step_direct',
                description: `Executar diretamente: ${goal.objective.slice(0, 100)}`,
                status: 'pending',
                fallbackSteps: [],
            }],
            strategy: '',
        };
    }

    private emergencyFallback(goal: Goal, blocker: GoalBlocker): PlanResult {
        // Se o blocker é missing_tool, tenta uma instalação genérica
        if (blocker.kind === 'missing_tool' && blocker.toolName) {
            return {
                steps: [
                    {
                        id: 'step_install',
                        description: `Instalar ${blocker.toolName}`,
                        toolName: 'exec_command',
                        toolArgs: { command: `which ${blocker.toolName} || echo "NOT FOUND"` },
                        status: 'pending',
                        fallbackSteps: [],
                    },
                    {
                        id: 'step_retry',
                        description: `Tentar novamente após verificação`,
                        status: 'pending',
                        fallbackSteps: [],
                    },
                ],
                strategy: `instalar ${blocker.toolName} e retry`,
            };
        }

        // Fallback genérico: tenta o objetivo com instrução diferente
        return {
            steps: [{
                id: 'step_fallback',
                description: `Abordagem alternativa para: ${goal.objective.slice(0, 100)}`,
                status: 'pending',
                fallbackSteps: [],
            }],
            strategy: '',
        };
    }
}
