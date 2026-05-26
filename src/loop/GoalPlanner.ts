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

import { createLogger } from '../shared/AppLogger';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ToolRegistry } from '../core/ToolRegistry';
import { Goal, GoalBlocker, PlanStep } from './GoalTypes';

const log = createLogger('GoalPlanner');

// ── Prompt templates ─────────────────────────────────────────────────────────

/**
 * Converte o summary do CapabilityRegistry num bloco de restrições ativas para o planner.
 * Separa capabilities em seções explícitas com ✓/✗ e injeta regras estratégicas e exemplos.
 * O bloco é posicionado ANTES do contexto/memória para que o LLM o trate como constraint, não histórico.
 */
function buildCapabilityBlock(capabilityContext: string): string {
    const lines = capabilityContext.split('\n').map(l => l.trim()).filter(Boolean);

    // ── Extração estruturada do summary ──────────────────────────────────────
    let availableTools:   string[] = [];
    let unavailableTools: string[] = [];
    let workspaceLine    = '';
    let networkLine      = '';
    let executionLine    = '';

    for (const line of lines) {
        if (/indisponíveis/i.test(line)) {
            const m = line.match(/:\s*(.+)$/);
            if (m) unavailableTools = m[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (/^[•\-]?\s*ferramentas:/i.test(line)) {
            const m = line.match(/:\s*(.+)$/);
            if (m) availableTools = m[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (/workspace/i.test(line)) {
            workspaceLine = line.replace(/^[•\-]\s*/, '');
        } else if (/rede:/i.test(line)) {
            networkLine = line.replace(/^[•\-]\s*/, '');
        } else if (/execu/i.test(line)) {
            executionLine = line.replace(/^[•\-]\s*/, '');
        }
    }

    // ── Seção de ferramentas com ✓/✗ por item ────────────────────────────────
    const toolLines: string[] = [];
    for (const t of availableTools)   toolLines.push(`  - ${t} ✓`);
    for (const t of unavailableTools) toolLines.push(`  - ${t} ✗  ← NÃO USE`);
    const toolsSection = toolLines.length > 0
        ? `Ferramentas do sistema:\n${toolLines.join('\n')}`
        : 'Ferramentas do sistema: nenhuma detectada';

    // ── Seção de workspace ────────────────────────────────────────────────────
    const wsSection = workspaceLine
        ? `Workspace:\n  ${workspaceLine}`
        : '';

    // ── Seção de execução e rede ──────────────────────────────────────────────
    const execSection = [networkLine, executionLine]
        .filter(Boolean)
        .map(l => `  ${l}`)
        .join('\n');

    // ── Regras de planejamento estratégico ────────────────────────────────────
    const rules = `REGRAS DE PLANEJAMENTO (obrigatórias):
  - NUNCA gere exec_command usando binários marcados com ✗
  - NUNCA planeje steps que dependam de capabilities indisponíveis
  - NUNCA tente instalar binários do sistema (apt-get, brew, yum)
  - Escolha a estratégia com MAIOR CHANCE DE SUCESSO dado o ambiente acima

ORDEM DE PREFERÊNCIA ESTRATÉGICA:
  1. Ferramentas disponíveis marcadas com ✓
  2. Skills registradas ativas (use toolName da skill, não exec_command)
  3. Bibliotecas já instaladas (python-pptx, node modules, etc.)
  4. Estratégias sem dependências externas (HTML puro, JS puro, markdown)
  5. Instalação de pacotes Python/npm (somente se estritamente necessário)
  6. Estratégias experimentais (último recurso — inclua step de verificação)

EXEMPLOS OPERACIONAIS:
  - pandoc ✗ → use python-pptx, HTML puro ou markdown; NÃO gere exec_command pandoc
  - ffmpeg ✗ → use python moviepy/PIL ou peça arquivo já processado; NÃO gere exec_command ffmpeg
  - marp ✗ → use HTML/CSS puro ou python-pptx; NÃO gere npx marp
  - sudo ✗ → instale em /tmp ou ~/.local; NÃO use sudo pip install
  - path externo ✗ → peça para mover ao workspace; NÃO tente acessar /home/outro ou /var/www`;

    // ── Montagem final ────────────────────────────────────────────────────────
    const sections = [toolsSection, wsSection, execSection ? `Execução e rede:\n${execSection}` : '']
        .filter(Boolean)
        .join('\n\n');

    return `
CAPACIDADES REAIS DO AMBIENTE — restrições absolutas de planejamento (detectadas automaticamente):

${sections}

${rules}
`;
}

function buildPlanPrompt(goal: Goal, availableTools: string[], skillContext?: string, runtimeContext?: string, capabilityContext?: string): string {
    const capBlock     = capabilityContext ? buildCapabilityBlock(capabilityContext) : '';
    const skillBlock   = skillContext
        ? `\nINSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente):\n${skillContext}\n`
        : '';
    const contextBlock = runtimeContext
        ? `\nCONTEXTO (memória + feedback de ciclos anteriores):\n${runtimeContext}\n`
        : '';

    const userPaths = extractUnixPaths(goal.userIntent);
    const pathsBlock = userPaths.length > 0
        ? `\nPATHS MENCIONADOS PELO USUÁRIO — copie LITERALMENTE para toolArgs (não encurte nem reconstrua):\n${userPaths.map(p => `  ${p}`).join('\n')}\n`
        : '';

    return `Você é um planejador de tarefas. Decomponha o objetivo abaixo em steps executáveis com ferramentas.

OBJETIVO: ${goal.objective}
INTENÇÃO ORIGINAL: ${goal.userIntent}
${pathsBlock}${capBlock}${skillBlock}${contextBlock}
Ferramentas disponíveis (use EXATAMENTE esses nomes): ${availableTools.join(', ')}

Responda APENAS com JSON válido (sem markdown):
{
  "steps": [
    {
      "id": "step_1",
      "description": "descrição curta do que este step faz",
      "toolName": "nome_da_ferramenta",
      "toolArgs": { "argumento": "valor" },
      "fallbackSteps": []
    }
  ],
  "strategy": "descrição de 1 linha da estratégia geral"
}

Regras:
- Máximo 4 steps por plano
- Cada step usa UMA ferramenta
- toolArgs deve ser um objeto com os argumentos da ferramenta
- Use APENAS os nomes de ferramenta listados acima — não invente nomes
- Se não precisar de ferramenta específica, omita toolName e toolArgs
- CRÍTICO: se o objetivo menciona caminhos de arquivo, use-os EXATAMENTE como listados em "PATHS MENCIONADOS" — não encurte, não reconstrua

ARGS OBRIGATÓRIOS POR FERRAMENTA:
- edit: SEMPRE forneça oldText+newText (substituição) OU startLine+endLine+content (patch) OU append=true+content. Nunca chame edit sem esses parâmetros.
- list_workspace: aceita caminho relativo (ex: "jogos/tower_defense") ou absoluto.
- read: aceita caminho relativo ao workspace ou absoluto.`.trim();
}

function buildReplanPrompt(goal: Goal, blocker: GoalBlocker, reflectionHint: string, runtimeContext?: string, capabilityContext?: string): string {
    const capBlock = capabilityContext ? buildCapabilityBlock(capabilityContext) : '';

    const strategiesBlock = goal.strategiesTried.length > 0
        ? `\nEstratégias já tentadas: ${goal.strategiesTried.join('; ')}\n`
        : '';

    const blockersBlock = goal.blockers.length > 0
        ? `\nBlockers anteriores: ${goal.blockers.map(b => `${b.kind}: ${b.description}`).join('; ')}\n`
        : '';

    const reflectionBlock = reflectionHint
        ? `\nHistórico de erros similares:\n${reflectionHint}\n`
        : '';

    const contextBlock = runtimeContext
        ? `\nCONTEXTO (memória + feedback):\n${runtimeContext}\n`
        : '';

    return `Você é um planejador de tarefas. Um blocker foi detectado. Proponha uma NOVA estratégia.

OBJETIVO: ${goal.objective}
BLOCKER ATUAL: ${blocker.description} (tipo: ${blocker.kind})
AÇÕES SUGERIDAS PELO SISTEMA: ${blocker.suggestedActions.join('; ')}
${capBlock}${strategiesBlock}${blockersBlock}${reflectionBlock}${contextBlock}
IMPORTANTE: Não repita estratégias já tentadas. Proponha abordagem genuinamente diferente.

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
  "strategy": "descrição de 1 linha da nova estratégia"
}

Máximo 3 steps. Se o blocker for 'missing_tool', inclua step de instalação como primeiro step.

REFERÊNCIA DE ARGS OBRIGATÓRIOS:
- edit: SEMPRE forneça oldText+newText (para substituição) OU startLine+endLine+content (para patch) OU append=true+content. Nunca chame edit sem esses parâmetros.
- list_workspace: aceita caminho relativo (ex: "jogos/tower_defense") OU absoluto. Passe apenas a subpasta desejada.
- read: aceita caminho relativo ao workspace ou absoluto. Para diretórios, lista automaticamente o conteúdo.

REGRAS CRÍTICAS para blocker 'environment_limit':
- Se o blocker mencionar PEP 668 ou 'externally-managed':
  → NÃO use pip install direto nem --break-system-packages.
  → Use venv: python3 -m venv /tmp/venv && /tmp/venv/bin/pip install <pacote> && /tmp/venv/bin/python script.py
  → Alternativa mais simples: pandoc arquivo.md -o arquivo.pptx
- Se o blocker mencionar 'ensurepip not available' ou 'python3-venv não instalado':
  → NÃO use python3 -m venv. Use pandoc ou npx marp diretamente.
  → Estratégia correta: exec_command com "pandoc arquivo.md -o arquivo.pptx"`.trim();
}

// Extrai caminhos Unix absolutos do texto (mínimo 2 segmentos: /a/b ou mais).
// Usado para preservar caminhos literais informados pelo usuário no prompt de planejamento.
// Filtra caminhos que vêm de URLs (file://, http://) ou de paths do Windows (C:\, /Users/lucia)
// para evitar que o planner injete steps de validação com paths fora do servidor.
function extractUnixPaths(text: string): string[] {
    // Remove URLs file:// e http(s):// antes de extrair para não capturar paths locais do usuário
    const sanitized = text
        .replace(/file:\/\/\/[^\s"')]+/gi, '')   // remove file:/// URLs (Windows/Mac local)
        .replace(/https?:\/\/[^\s"')]+/gi, '');   // remove http(s):// URLs
    const matches = sanitized.match(/\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) ?? [];
    return [...new Set(matches)].filter(p => {
        // Rejeita caminhos que claramente pertencem ao ambiente local do usuário (não ao servidor)
        if (/^\/(Users|home\/(?!venus))[\/]/i.test(p)) return false;
        if (/^\/(C:|D:|Windows|Program Files)/i.test(p)) return false;
        return true;
    });
}

// Regex para detectar valores de argumento que são placeholders, não caminhos reais.
// Quando detectados em toolArgs, o step é convertido para AgentLoop para forçar
// resolução do caminho real antes de executar (evita exec_command com paths fictícios).
// \{[a-zA-Z_][a-zA-Z0-9_]{0,40}\} — só match em {simple_identifier}, não em código JS
// como { isPaused = !isPaused; } (que contém espaços e operadores).
// NOTA: A cláusula <tag> foi removida pois causava falso positivo com tags HTML legítimas
// como <html>, <body>, <canvas> — os placeholders reais são cobertos pelos keywords nomeados.
const PLACEHOLDER_ARG_PATTERN =
    /\b(caminho_do|path_to|arquivo_identificado|the_file_path|nome_do_arquivo|your_file|nome_arquivo)\b|\{[a-zA-Z_][a-zA-Z0-9_]{0,40}\}|\/path\/to\/|\/caminho\/do\//i;

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

// ── GoalPlanner ───────────────────────────────────────────────────────────────

// Modelo dedicado ao planning: gera JSON rápido e não entra em extended thinking.
// kimi-k2.6 e outros thinking models são inadequados pois raciocinam 45s+ sem produzir output.
const PLANNER_MODEL = 'gemma4:31b-cloud';

export class GoalPlanner {
    private skillContext: string | undefined;

    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    /**
     * Chama o LLM usando um modelo fixo para planning (não o default do Ollama).
     * Retorna { status, content } no mesmo formato que chatWithFallback usa internamente.
     */
    private async callPlannerLLM(messages: LLMMessage[], timeoutMs: number): Promise<{ status: string; content: string }> {
        const provider = this.providerFactory.getProviderWithModel(PLANNER_MODEL);
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

    /** Injeta skill context que será incluído no prompt de planejamento. */
    setSkillContext(context: string): void {
        this.skillContext = context || undefined;
    }

    async plan(goal: Goal, runtimeContext?: string, capabilityContext?: string): Promise<PlanStep[]> {
        log.info(`[GoalPlanner] plan start goal=${goal.id} model=${PLANNER_MODEL} contextLen=${runtimeContext?.length ?? 0}`);

        const availableTools = ToolRegistry.getEnabled().map(t => t.name);
        const messages: LLMMessage[] = [{ role: 'user', content: buildPlanPrompt(goal, availableTools, this.skillContext, runtimeContext, capabilityContext) }];

        try {
            const result = await this.callPlannerLLM(messages, 45_000);

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] plan failed: model=${PLANNER_MODEL} status=${result.status} raw="${result.content.slice(0, 150)}"`);
                return this.fallbackPlan(goal);
            }

            const parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                log.warn(`[GoalPlanner] plan empty after parse: model=${PLANNER_MODEL} raw="${result.content.slice(0, 200)}"`);
                return this.fallbackPlan(goal);
            }

            const steps = this.prependPathValidation(goal, parsed.steps);
            log.info(`[GoalPlanner] plan ok: steps=${steps.length} strategy="${parsed.strategy}" tools=[${steps.map(s => s.toolName ?? 'agentloop').join(',')}]`);
            return steps;
        } catch (err) {
            log.warn(`[GoalPlanner] plan exception: model=${PLANNER_MODEL} err="${String(err).slice(0, 100)}"`);
            return this.fallbackPlan(goal);
        }
    }

    async replan(goal: Goal, blocker: GoalBlocker, runtimeContext?: string, capabilityContext?: string): Promise<PlanStep[]> {
        log.info(`[GoalPlanner] replan start goal=${goal.id} model=${PLANNER_MODEL} blocker=${blocker.kind} contextLen=${runtimeContext?.length ?? 0}`);

        // Consulta memória de reflexão para evitar erros já conhecidos
        const reflectionHint = this.reflectionMemory.buildContextHint(
            blocker.toolName ? `tool_${blocker.toolName}` : blocker.kind
        );
        if (reflectionHint) {
            log.debug(`[GoalPlanner] reflectionHint injected (${reflectionHint.length} chars)`);
        }

        const messages: LLMMessage[] = [{
            role: 'user',
            content: buildReplanPrompt(goal, blocker, reflectionHint, runtimeContext, capabilityContext)
        }];

        try {
            const result = await this.callPlannerLLM(messages, 45_000);

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] replan failed: model=${PLANNER_MODEL} status=${result.status} raw="${result.content.slice(0, 150)}"`);
                return this.emergencyFallback(goal, blocker);
            }

            const parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                log.warn(`[GoalPlanner] replan empty after parse: model=${PLANNER_MODEL} raw="${result.content.slice(0, 200)}"`);
                return this.emergencyFallback(goal, blocker);
            }

            const steps = this.prependPathValidation(goal, parsed.steps);
            log.info(`[GoalPlanner] replan ok: steps=${steps.length} strategy="${parsed.strategy}" tools=[${steps.map(s => s.toolName ?? 'agentloop').join(',')}]`);
            return steps;
        } catch (err) {
            log.warn(`[GoalPlanner] replan exception: model=${PLANNER_MODEL} err="${String(err).slice(0, 100)}"`);
            return this.emergencyFallback(goal, blocker);
        }
    }

    // ── Parsing ───────────────────────────────────────────────────────────────

    private parsePlanResponse(content: string): { steps: PlanStep[]; strategy: string } {
        try {
            const cleaned = content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();

            const parsed = JSON.parse(cleaned);
            const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

            const steps: PlanStep[] = rawSteps.slice(0, 4).map((s: Record<string, unknown>, i: number) => {
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

                return {
                    id: String(s.id ?? `step_${i + 1}`),
                    description: String(s.description ?? 'Execute step'),
                    toolName: resolvedTool,
                    toolArgs,
                    fallbackSteps: [],
                    status: 'pending' as const,
                };
            });

            return { steps, strategy: String(parsed.strategy ?? '') };
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

    // ── Fallbacks sem LLM ─────────────────────────────────────────────────────

    private fallbackPlan(goal: Goal): PlanStep[] {
        // Plano minimalista: passa o objetivo direto para o AgentLoop sem decomposição
        return [{
            id: 'step_direct',
            description: `Executar diretamente: ${goal.objective.slice(0, 100)}`,
            status: 'pending',
            fallbackSteps: [],
        }];
    }

    private emergencyFallback(goal: Goal, blocker: GoalBlocker): PlanStep[] {
        // Se o blocker é missing_tool, tenta uma instalação genérica
        if (blocker.kind === 'missing_tool' && blocker.toolName) {
            return [
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
            ];
        }

        // Fallback genérico: tenta o objetivo com instrução diferente
        return [{
            id: 'step_fallback',
            description: `Abordagem alternativa para: ${goal.objective.slice(0, 100)}`,
            status: 'pending',
            fallbackSteps: [],
        }];
    }
}
