/**
 * RiskAnalyzer — Quadrante 2 do Modelo Espiral.
 *
 * Responsabilidade: analisar o plano gerado (Q1) antes de executá-lo (Q3),
 * identificando riscos proativamente em vez de só descobri-los na falha.
 *
 * Verificações realizadas:
 *   1. Tools inexistentes no ToolRegistry (rápido, sem LLM)
 *   2. Padrões de falha conhecidos para tools do plano (ReflectionMemory)
 *   3. Revisão LLM do plano completo: steps faltantes, dependências, ordem
 *
 * Output: RiskReport com lista de riscos e plano possivelmente ajustado
 * (ex: adiciona step de verificação entre "criar arquivo" e "enviar arquivo").
 */

import { createLogger } from '../shared/AppLogger';
import { ToolRegistry } from '../core/ToolRegistry';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { permissionRegistry } from '../core/PermissionRegistry';
import { Goal, PlanStep } from './GoalTypes';
import { detectMissingRequiredArgs, WRITE_CONTENT_STUB_PATTERNS } from './GoalPlanner';
import { sanitizePlanSteps } from './planning/sanitizePlanSteps';
import { resolveToolAlias } from './planning/toolAliasResolver';

const log = createLogger('RiskAnalyzer');

// Modelo dedicado à revisão de riscos: gera JSON rápido e não entra em extended thinking.
// kimi-k2.6 e outros thinking models são inadequados — raciocinam 150s+ sem produzir output.
// Configurável via RISK_MODEL — usar nome compatível com DEFAULT_PROVIDER
// Ollama: 'gemma4:31b-cloud' | OpenRouter: 'google/gemini-2.0-flash' | Gemini: 'gemini-2.0-flash'
const RISK_REVIEW_MODEL_DEFAULT = process.env.RISK_MODEL || 'gemma4:31b-cloud';

// Binários universais presentes em qualquer shell POSIX sem necessidade de instalação —
// válido apenas para Linux/macOS. No Windows a MAIORIA destes não existe no cmd.exe (shell
// padrão do exec_command), ver checagem POSIX_ONLY_NO_WIN_EQUIVALENT logo abaixo, que cobre
// esse gap especificamente para osData.platform==='windows'. Checar via CapabilityRegistry
// causaria falso positivo em Linux/macOS — esses comandos não estão no TOOLS_TO_PROBE do
// EnvironmentProbe mas funcionam em qualquer ambiente Linux/macOS.
const SHELL_UNIVERSALS = new Set([
    'ls', 'cd', 'echo', 'cat', 'grep', 'find', 'pwd', 'mkdir', 'rm', 'cp', 'mv',
    'chmod', 'chown', 'which', 'test', 'head', 'tail', 'sort', 'uniq', 'wc',
    'touch', 'sed', 'awk', 'tr', 'cut', 'date', 'env', 'printf', 'tee', 'xargs',
    'sh', 'bash', 'python3', 'python', 'node', 'true', 'false', 'read',
]);

// S5: ferramentas fundamentais do agente — suas falhas são context-específicas
// (conteúdo inválido, rede fora, arquivo ausente), não estruturais/recorrentes.
// Buscar historical failure hints para elas no ReflectionMemory produz falsos positivos
// no Q2 ("web_search: Falha 100% (9/9)") quando as falhas vieram de contextos completamente
// diferentes. A CONTENT-STUB-GATE e outros gates já cobrem as falhas reais dessas tools.
const FUNDAMENTAL_AGENT_TOOLS = new Set([
    'write', 'read', 'edit', 'web_search', 'send_document', 'send_message',
    'memory_search', 'memory_write', 'list_workspace', 'analyze_workspace_groups',
]);

// Executáveis comumente usados em exec_command que podem não estar instalados.
// Chave: nome do executável (lowercase). Valor: pacote a instalar.
const KNOWN_SYSTEM_DEPS: Record<string, string> = {
    pandoc: 'pandoc',
    ffmpeg: 'ffmpeg',
    convert: 'imagemagick',
    magick: 'imagemagick',
    libreoffice: 'libreoffice',
    soffice: 'libreoffice',
    pdftotext: 'poppler-utils',
    pdfimages: 'poppler-utils',
    jq: 'jq',
    zip: 'zip',
    unzip: 'unzip',
    gs: 'ghostscript',
    ghostscript: 'ghostscript',
    exiftool: 'libimage-exiftool-perl',
    marp: '@marp-team/marp-cli (npm)',
    npx: 'npm',
};

export interface RiskReport {
    risks: string[];
    adjustedPlan: PlanStep[];
    planAdjusted: boolean;
    /** true quando o plano é inviável — GoalExecutionLoop deve abortar em vez de executar */
    blocked: boolean;
    /** Motivo do bloqueio (injetado no próximo replan como contexto) */
    blockReason?: string;
    /**
     * true quando >50% dos tool-steps não têm argumentos obrigatórios.
     * Diferente de `blocked`: não aborta o goal — força o GoalPlanner a replanejar
     * com feedback estruturado sobre os argumentos faltantes.
     */
    planRejected?: boolean;
    /** Feedback enviado ao GoalPlanner para guiar o próximo replan */
    rejectionReason?: string;
    /**
     * Skills detectadas que cobrem as ferramentas problemáticas do plano.
     * Cada entrada: { skillName, skillContext } para injetar no próximo replan.
     */
    skillHints?: Array<{ skillName: string; skillContext: string }>;
}

export class RiskAnalyzer {
    private model: string = RISK_REVIEW_MODEL_DEFAULT;

    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly toolRegistry: typeof ToolRegistry,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    setModel(model: string): void {
        if (model) this.model = model;
    }

    async analyze(
        goal: Goal,
        plan: PlanStep[],
        /** Skills disponíveis para detecção de [SKILL-HINT] (Sprint 3.7A). Parâmetro opcional — retrocompatível. */
        availableSkills?: import('../skills/SkillLoader').Skill[],
    ): Promise<RiskReport> {
        if (plan.length === 0) {
            return { risks: [], adjustedPlan: plan, planAdjusted: false, blocked: false };
        }

        const risks: string[] = [];

        // ── 0. Constraints duras do ReflectionMemory (cirurgia seletiva) ────
        // Ferramentas com ≥90% de falha recente viram proibições absolutas.
        // Em DEVELOPER/GOD mode: constraints ainda são registradas no log para rastreabilidade,
        // mas não bloqueiam nem removem steps — o agente tem autonomia para tentar mesmo assim.
        // S3a: "Para as ferramentas deste plano, existem falhas recorrentes de alta
        // confiança que deveriam virar constraint?" — antes passava texto livre do
        // objetivo do usuário como se fosse chave técnica (achado crítico da auditoria);
        // agora consulta por ferramenta real, uma pergunta por tool do plano.
        const planTools = plan.map(s => s.toolName).filter((t): t is string => Boolean(t));
        const bypassConstraints = permissionRegistry.can('bypass_reflection_constraints');
        const constraints = this.reflectionMemory.findHardConstraints(planTools);
        if (constraints.length > 0) {
            for (const c of constraints) {
                risks.push(bypassConstraints
                    ? `[CONSTRAINT-BYPASSED:${permissionRegistry.getMode()}] ${c}`
                    : `[CONSTRAINT] ${c}`
                );
            }

            if (!bypassConstraints) {
                const { prunedPlan, violatedConstraint } = this.pruneConstrainedSteps(plan, constraints);
                if (violatedConstraint) {
                    if (prunedPlan.length === 0) {
                        log.warn(`[RiskAnalyzer] goal=${goal.id} BLOCKED by hard constraint (plano vazio): ${violatedConstraint}`);
                        return {
                            risks,
                            adjustedPlan: plan,
                            planAdjusted: false,
                            blocked: true,
                            blockReason: violatedConstraint,
                        };
                    }
                    log.warn(`[RiskAnalyzer] goal=${goal.id} pruned ${plan.length - prunedPlan.length} step(s) violating constraint: ${violatedConstraint}`);
                    plan = prunedPlan;
                }
            } else {
                log.info(`[RiskAnalyzer] goal=${goal.id} constraints bypassed (mode=${permissionRegistry.getMode()}): ${constraints.length} constraint(s) ignored`);
            }
        }

        // ── 1. Verificação rápida sem LLM ────────────────────────────────────
        for (const step of plan) {
            if (!step.toolName) continue;

            if (!this.toolRegistry.get(step.toolName)) {
                risks.push(`Step "${step.description}": tool '${step.toolName}' não registrada`);
            }

            // S5: skip ferramentas fundamentais — histórico delas gera falsos positivos
            // S3a: "Existe falha recorrente para esta ferramenta especificamente?"
            if (!FUNDAMENTAL_AGENT_TOOLS.has(step.toolName)) {
                const hint = this.reflectionMemory.findToolFailures(step.toolName);
                if (hint) {
                    const firstLine = hint.split('\n').find(l => l.startsWith('-')) ?? hint;
                    risks.push(`Step "${step.description}": ${firstLine.slice(0, 120)}`);
                    // S7: 100% de falha histórica em exec_command → promove para BLOCK-HINT
                    // quando bypass_block_hints=false (SAFE/DEVELOPER). GOD mode ignora.
                    if (step.toolName === 'exec_command' && /100%/.test(firstLine) &&
                        !permissionRegistry.can('bypass_block_hints')) {
                        risks.push(
                            `[BLOCK-HINT] exec_command com 100% de falha histórica neste contexto — ` +
                            `prefira 'write' + 'send_document' sem subprocess externo`
                        );
                    }
                }
            }
        }

        // ── 1b. Detecção proativa de dependências em exec_command ────────────
        for (const step of plan) {
            if (step.toolName !== 'exec_command') continue;
            const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
            if (!cmdValue) continue;

            const tokens = cmdValue.trim().split(/\s+/).filter(t => t !== 'sudo' && t !== 'env' && !t.includes('='));
            const firstToken = (tokens[0] ?? '').toLowerCase().replace(/^.*\//, '');

            const pkg = KNOWN_SYSTEM_DEPS[firstToken];
            if (pkg) {
                // Obs #9: verifica se o CapabilityRegistry já tem resultado do probe para este binário.
                // probeResult=null significa cache frio (probe não foi executado) — NUNCA assuma disponível.
                // No ambiente de produção, binários externos raramente estão pré-instalados.
                const probeResult = CapabilityRegistry.getInstance().canSync(`tool.${firstToken}`);
                const knownUnavailable = probeResult === false;
                const probeUnknown    = probeResult === null;
                const riskReason = knownUnavailable
                    ? `usa '${firstToken}' — CONFIRMADO como NÃO instalado neste servidor (probe retornou false)`
                    : probeUnknown
                        ? `usa '${firstToken}' (pacote: ${pkg}) — disponibilidade desconhecida; assuma não instalado até probe confirmar`
                        : `usa '${firstToken}' (pacote: ${pkg}) — pode não estar instalado no servidor`;
                log.info(
                    `[RISK-CHECK] risk_source=1b_KNOWN_DEPS probe_result=${probeResult === null ? 'uncached' : probeResult} ` +
                    `binary=${firstToken} known_unavailable=${knownUnavailable} risk_reason="${riskReason}"`
                );
                risks.push(`Step "${step.description}": ${riskReason}`);
                // Se binário confirmado ausente, adiciona constraint explícita para o ReflectionMemory
                if (knownUnavailable || probeUnknown) {
                    risks.push(`[BLOCK-HINT] Não inclua steps exec_command com '${firstToken}' — use skills ou alternativas nativas`);
                }
            }

            // NOTA: as correções de marp/pandoc (--no-stdin ausente/inválido, arquivo de
            // entrada faltando) e o encaminhamento de cmdlets PowerShell foram movidos pra
            // dentro do próprio exec_command.ts (execute()). Viviam aqui e só rodavam quando
            // isComplexPlan() no GoalExecutionLoop decidia acionar o Q2 (>=3 steps, ou
            // exec_command+write/send juntos) — um plano de 1 step só com exec_command (o caso
            // mais comum) pulava o Q2 inteiro e as correções nunca eram aplicadas.
            // exec_command.ts roda incondicionalmente pra toda chamada, então é o único lugar
            // que garante a correção sempre.
        }

        // ── 1c. Pre-flight via CapabilityRegistry (síncrono, sem LLM) ────────
        // Verifica capabilities já cacheadas: não faz probe novo se o cache está frio.
        const capReg = CapabilityRegistry.getInstance();

        for (const step of plan) {
            if (!step.toolName) continue;

            // Web tools requerem internet
            if (step.toolName === 'web_search' || step.toolName === 'web_navigate') {
                const netOk = capReg.canSync('network.outbound');
                if (netOk === false) {
                    risks.push(`Step "${step.description}": sem acesso à internet (network.outbound=false)`);
                }
            }

            // exec_command: verifica primeiro token do comando nas capabilities de tools
            if (step.toolName === 'exec_command') {
                const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
                if (cmdValue) {
                    const tokens = cmdValue.trim().split(/\s+/).filter(t => t !== 'sudo' && t !== 'env' && !t.includes('='));
                    const firstToken = (tokens[0] ?? '').toLowerCase().replace(/^.*\//, '');
                    if (firstToken && !SHELL_UNIVERSALS.has(firstToken)) {
                        const toolOk = capReg.canSync(`tool.${firstToken}`);
                        if (toolOk === false) {
                            risks.push(`Step "${step.description}": binário '${firstToken}' não detectado no ambiente`);
                        }
                    }
                }
            }
        }

        // ── 1d. OS + Hardware feasibility (síncrono, sem LLM) ───────────────
        const osData  = capReg.getOSSync();
        const hwData  = capReg.getHardwareSync();

        if (osData) {
            for (const step of plan) {
                if (step.toolName !== 'exec_command') continue;
                const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
                if (!cmdValue) continue;
                const cmdLower = cmdValue.toLowerCase();

                // Comandos Linux/macOS executados em Windows
                if (osData.platform === 'windows') {
                    if (/\bapt(?:-get)?\b/.test(cmdLower))
                        risks.push(`Step "${step.description}": 'apt' não existe no Windows — use winget/choco`);
                    if (/\byum\b|\bdnf\b|\bpacman\b/.test(cmdLower))
                        risks.push(`Step "${step.description}": gerenciador de pacotes Linux em ambiente Windows`);
                    if (/\bchmod\b|\bchown\b/.test(cmdLower))
                        risks.push(`Step "${step.description}": 'chmod'/'chown' não existem no Windows`);

                    // Utilitários POSIX de SHELL_UNIVERSALS (ver acima) que NÃO existem no
                    // cmd.exe (shell padrão do exec_command no Windows) — 'ls'/'cat'/'head'/
                    // 'grep'/'which'/'find' etc. Até 02/07 isso só gerava um aviso aqui (o
                    // Q2), sem correção de fato: exec_command.ts (needsPowerShellWrap) só
                    // encaminhava para powershell.exe cmdlets Verbo-Substantivo (Get-ChildItem),
                    // nunca esses binários POSIX — reproduzido ao vivo em produção, 'ls' falhando
                    // repetidas vezes mesmo com este aviso presente no plano. O aviso não
                    // impedia a falha, só a documentava depois do fato.
                    // Fix real: exec_command.ts agora encaminha esses binários para o
                    // PowerShell incondicionalmente (mesma lista, ver POSIX_ONLY_NO_WIN_EQUIVALENT
                    // em exec_command.ts) — não depende do LLM reescrever o comando, então não
                    // há mais risco a reportar aqui.
                }

                // Comandos Windows executados em Linux/macOS
                if (osData.platform === 'linux' || osData.platform === 'macos') {
                    if (/\bpowershell\b|\bpwsh\b/.test(cmdLower))
                        risks.push(`Step "${step.description}": PowerShell pode não estar disponível em ${osData.platform}`);
                    if (/\bwinget\b|\bchoco\b/.test(cmdLower))
                        risks.push(`Step "${step.description}": gerenciador de pacotes Windows em ambiente ${osData.platform}`);
                }
            }
        }

        if (hwData) {
            for (const step of plan) {
                if (step.toolName !== 'exec_command') continue;
                const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
                if (!cmdValue) continue;
                const cmdLower = cmdValue.toLowerCase();

                // Detecção de CUDA sem GPU
                if (!hwData.gpuAvailable) {
                    if (/\bcuda\b|\bnvidia-smi\b|\btorch\b.*gpu|\btensorflow-gpu\b/.test(cmdLower)) {
                        risks.push(`Step "${step.description}": requer GPU/CUDA mas nenhuma GPU detectada no ambiente`);
                    }
                }

                // Processos pesados com pouca RAM livre
                const HEAVY_RAM_MB = 512;
                if (hwData.freeMemoryMB < HEAVY_RAM_MB) {
                    const isHeavy = /\bffmpeg\b|\blibreoffice\b|\bsoffice\b|\bchromium\b|\bchrome\b|\bpuppeteer\b/.test(cmdLower);
                    if (isHeavy) {
                        risks.push(`Step "${step.description}": processo pesado com apenas ${hwData.freeMemoryMB}MB RAM livre (mínimo recomendado: ${HEAVY_RAM_MB}MB)`);
                    }
                }

                // Pouco espaço em disco para downloads/geração de mídia
                const LOW_DISK_MB = 200;
                if (hwData.diskFreeMB > 0 && hwData.diskFreeMB < LOW_DISK_MB) {
                    const isDiskHeavy = /\bffmpeg\b|\bdownload\b|\bcp\b.*\.\b|\bwget\b|\bcurl\b.*-o/.test(cmdLower);
                    if (isDiskHeavy) {
                        risks.push(`Step "${step.description}": apenas ${hwData.diskFreeMB}MB livres no disco — operação pode falhar por falta de espaço`);
                    }
                }
            }
        }

        // ── 2. Revisão LLM do plano completo ────────────────────────────────
        const llmResult = await this.reviewPlanWithLLM(goal, plan);

        if (llmResult.risks.length > 0) risks.push(...llmResult.risks);

        // Propaga a rejeição computada por reviewPlanWithLLM() (CR#3/CR#4) — antes ficava
        // presa no método privado e nunca chegava no RiskReport público retornado por
        // analyze(), então nenhum chamador via GoalExecutionLoop recebia o sinal de fato
        // (só o texto de aviso, dentro de risks[], sobrevivia). Bug pré-existente confirmado
        // (git show HEAD), documentado em sessão anterior — este é o fix mínimo: só
        // propagação do estado já calculado, nenhuma regra de decisão nova.
        if (llmResult.planRejected) {
            return {
                risks,
                adjustedPlan: plan,
                planAdjusted: false,
                blocked: false,
                planRejected: true,
                rejectionReason: llmResult.rejectionReason,
            };
        }

        const finalPlan = llmResult.planAdjusted ? llmResult.adjustedPlan : plan;

        // ── 3. Verificar se plano final tem steps viáveis ────────────────────
        // Se TODAS as tools do plano são inválidas (hallucinations), bloqueamos.
        const toolSteps = finalPlan.filter(s => s.toolName);
        const invalidTools = toolSteps.filter(s => s.toolName && !this.toolRegistry.get(s.toolName));
        if (toolSteps.length > 0 && invalidTools.length === toolSteps.length) {
            const names = invalidTools.map(s => s.toolName).join(', ');
            const blockReason = `Plano contém apenas tools inválidas: ${names}`;
            log.warn(`[RiskAnalyzer] goal=${goal.id} BLOCKED — no viable tools`);
            return { risks, adjustedPlan: finalPlan, planAdjusted: llmResult.planAdjusted, blocked: true, blockReason };
        }

        const planAdjusted = llmResult.planAdjusted;
        if (risks.length > 0) {
            log.info(`[RiskAnalyzer] goal=${goal.id} risks=${risks.length} planAdjusted=${planAdjusted}`);
        }

        // Sprint 3.7A — Q2 Skill Hint: detecta se o plano usa exec_command para algo
        // que uma skill instalada poderia cobrir com instruções mais especializadas.
        // Retorna skill hints para o GoalPlanner injetar como skillContext no próximo replan.
        const skillHints: Array<{ skillName: string; skillContext: string }> = [];
        if (availableSkills && availableSkills.length > 0) {
            const execSteps = finalPlan.filter(s => s.toolName === 'exec_command');
            const seenSkills = new Set<string>();
            for (const step of execSteps) {
                const cmd = String(step.toolArgs?.command ?? '').toLowerCase();
                if (!cmd) continue;
                const coveringSkill = availableSkills.find(skill =>
                    !seenSkills.has(skill.name) &&
                    (skill.tools ?? []).includes('exec_command') &&
                    (skill.triggers ?? []).some(t => cmd.includes(t.toLowerCase()))
                );
                if (coveringSkill) {
                    log.info(
                        `[SKILL-HINT]` +
                        ` goal=${goal.id}` +
                        ` step=${step.id}` +
                        ` skill=${coveringSkill.name}` +
                        ` reason=exec_command_covered_by_skill` +
                        ` command="${cmd.slice(0, 60)}"`
                    );
                    seenSkills.add(coveringSkill.name);
                    skillHints.push({ skillName: coveringSkill.name, skillContext: coveringSkill.content });
                }
            }
        }

        return { risks, adjustedPlan: finalPlan, planAdjusted, blocked: false, skillHints: skillHints.length > 0 ? skillHints : undefined };
    }

    /**
     * Remove do plano os steps que violam constraints de ferramentas proibidas.
     * Retorna o plano podado e a primeira constraint violada encontrada (para log).
     *
     * Em vez de bloquear o goal inteiro quando um step usa web_search (por exemplo),
     * apenas esse step é removido do plano, preservando os demais.
     * Bloqueio total só ocorre se o plano ficar completamente vazio após a poda.
     */
    private pruneConstrainedSteps(plan: PlanStep[], constraints: string[]): {
        prunedPlan: PlanStep[];
        violatedConstraint: string | null;
    } {
        const prohibitedTools = new Set<string>();
        let violatedConstraint: string | null = null;

        for (const constraint of constraints) {
            const toolMatch = constraint.match(/'([a-z][a-z0-9_]*)'/i);
            if (toolMatch) {
                const toolName = toolMatch[1];
                if (plan.some(s => s.toolName === toolName)) {
                    prohibitedTools.add(toolName);
                    violatedConstraint ??= constraint;
                }
            }
        }

        // Casos especiais via args de exec_command
        const cmdConstraints: Array<{ pattern: RegExp; cmdPattern: RegExp; constraint: string }> = [];
        for (const constraint of constraints) {
            if (/pip install/i.test(constraint)) {
                cmdConstraints.push({ pattern: /pip install/i, cmdPattern: /pip\s+install/i, constraint });
            }
            if (/python3 -m venv/i.test(constraint)) {
                cmdConstraints.push({ pattern: /python3 -m venv/i, cmdPattern: /python3\s+-m\s+venv/i, constraint });
            }
        }

        const prunedPlan = plan.filter(step => {
            if (step.toolName && prohibitedTools.has(step.toolName)) return false;
            if (step.toolName === 'exec_command') {
                const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
                for (const cc of cmdConstraints) {
                    if (cc.cmdPattern.test(cmdValue)) {
                        violatedConstraint ??= cc.constraint;
                        return false;
                    }
                }
            }
            return true;
        });

        return { prunedPlan, violatedConstraint };
    }


    /**
     * Chama o LLM de revisão de riscos usando modelo fixo (não o default).
     * Mesmo padrão do GoalPlanner.callPlannerLLM — gemma4 não entra em extended thinking.
     */
    private async callRiskLLM(messages: LLMMessage[], timeoutMs: number): Promise<{ status: string; content: string }> {
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

    private async reviewPlanWithLLM(goal: Goal, plan: PlanStep[]): Promise<{
        risks: string[];
        adjustedPlan: PlanStep[];
        planAdjusted: boolean;
        planRejected?: boolean;
        rejectionReason?: string;
    }> {
        const stepsStr = plan
            .map((s, i) => `${i + 1}. [${s.toolName ?? 'agentloop'}] ${s.description}`)
            .join('\n');

        const prompt = `Você é um analisador de riscos de execução. Revise este plano antes de executá-lo.

OBJETIVO: ${goal.objective}

PLANO:
${stepsStr}

Ferramentas disponíveis: ${this.toolRegistry.getEnabled().map(t => t.name).join(', ')}

Verifique:
1. Há steps faltando? (ex: criar arquivo → verificar se criou → enviar; não pular o envio)
2. Algum step depende do output do anterior sem capturá-lo explicitamente?
3. A ordem está correta?
4. O resultado final será ENTREGUE ao usuário? (se o objetivo pede envio de arquivo, deve haver um step send_document)

Se o plano estiver completo e correto → retorne {"risks": [], "plan": null}
Se precisar de ajuste → retorne o plano completo corrigido.

⚠️ SCHEMAS OBRIGATÓRIOS ao adicionar ou ajustar steps:
  write:       {"path": "resultado.txt", "content": "conteúdo completo aqui"}
               — path e content são OBRIGATÓRIOS. Nunca adicione write sem ambos.
  web_navigate: {"action": "search", "query": "texto"} OU {"action": "open", "url": "https://..."} OU {"action": "follow_link", "url": "https://...", "link_text": "texto do link"}
               — action deve ser exatamente search, open ou follow_link. Nunca use outra string.

Responda APENAS com JSON válido (sem markdown, máximo 5 steps):
{"risks": ["risco 1"], "plan": [{"id": "step_1", "description": "...", "toolName": "...", "toolArgs": {...}}, ...]}
OU
{"risks": [], "plan": null}`;

        try {
            // gemma4:31b-cloud: gera JSON rápido sem extended thinking (60s é sobra).
            // chatWithFallback usava kimi-k2.6 que travava em 150s de thinking sem output.
            const result = await this.callRiskLLM(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                60_000,
            );

            if (result.status !== 'success') {
                log.warn('[RiskAnalyzer] LLM review failed — using original plan');
                return { risks: [], adjustedPlan: plan, planAdjusted: false };
            }

            const stripped = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            // Extrai apenas o objeto JSON, ignorando texto antes ou depois.
            // O modelo ocasionalmente retorna JSON válido seguido de explicações em prosa
            // que causam SyntaxError: "Unexpected non-whitespace character after JSON".
            const jsonMatch = stripped.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                log.warn('[RiskAnalyzer] LLM review response has no JSON object — using original plan');
                return { risks: [], adjustedPlan: plan, planAdjusted: false };
            }
            const parsed = JSON.parse(jsonMatch[0]);

            const detectedRisks: string[] = Array.isArray(parsed.risks) ? parsed.risks : [];

            if (!parsed.plan || !Array.isArray(parsed.plan) || parsed.plan.length === 0) {
                return { risks: detectedRisks, adjustedPlan: plan, planAdjusted: false };
            }

            // ── CR#3: Rejeitar plano quando maioria dos tool-steps tem args inválidos ──
            const rawSteps: Array<Record<string, unknown>> = parsed.plan.slice(0, 5);
            const toolStepsCount = rawSteps.filter(s => {
                const t = s.toolName ? String(s.toolName) : undefined;
                return t && this.toolRegistry.get(t);
            }).length;
            const invalidArgsCount = rawSteps.filter(s => {
                const t = s.toolName ? String(s.toolName) : undefined;
                if (!t || !this.toolRegistry.get(t)) return false;
                const args = (s.toolArgs && typeof s.toolArgs === 'object')
                    ? s.toolArgs as Record<string, unknown>
                    : {};
                return Boolean(detectMissingRequiredArgs(t, args));
            }).length;

            if (toolStepsCount > 0 && invalidArgsCount / toolStepsCount > 0.5) {
                const rejectionReason =
                    `Plano rejeitado: ${invalidArgsCount}/${toolStepsCount} tool-steps sem argumentos obrigatórios. ` +
                    `Para 'edit' inclua oldText+newText. Para 'send_document' inclua file_path. Para 'read' inclua path.`;
                log.warn(`[RiskAnalyzer] plan rejected (${invalidArgsCount}/${toolStepsCount} invalid args) — requesting structured replan`);
                return {
                    risks: [...detectedRisks, rejectionReason],
                    adjustedPlan: plan,   // devolve plano original sem degradação silenciosa
                    planAdjusted: false,
                    planRejected: true,
                    rejectionReason,
                };
            }

            // Pré-processamento específico do RiskAnalyzer, ANTES da sanitização comum:
            // send_document sem file_path tenta inferir do último 'write' anterior no mesmo
            // batch de steps — evita criar um AgentLoop aninhado só pra descobrir qual arquivo
            // enviar. Muta rawSteps diretamente para que sanitizePlanSteps() já veja o
            // file_path preenchido (e portanto não gere uma mutation de 'missing_args' para
            // este step). resolveToolAlias() aqui é uma melhoria pequena e deliberada: antes
            // desta consolidação, RiskAnalyzer não resolvia alias em NENHUM lugar, então um
            // 'provide_file' sem file_path nem chegava a tentar essa inferência.
            rawSteps.forEach((s, i) => {
                const rawTool = s.toolName ? String(s.toolName) : undefined;
                if (!rawTool || resolveToolAlias(rawTool) !== 'send_document') return;
                const toolArgs = (s.toolArgs && typeof s.toolArgs === 'object') ? s.toolArgs as Record<string, unknown> : undefined;
                if (toolArgs?.file_path) return;

                const lastWrite = rawSteps.slice(0, i).reverse().find(
                    (prev: Record<string, unknown>) =>
                        String(prev['toolName'] ?? '') === 'write' &&
                        prev['toolArgs'] &&
                        typeof prev['toolArgs'] === 'object' &&
                        (prev['toolArgs'] as Record<string, unknown>)['path']
                );
                if (!lastWrite) return; // sem write anterior: sanitizePlanSteps vai converter pra AgentLoop normalmente

                const inferredPath = String((lastWrite['toolArgs'] as Record<string, unknown>)['path']);
                s.toolArgs = { ...(toolArgs ?? {}), file_path: inferredPath };
                log.info(
                    `[STEP-MUTATION]` +
                    ` step=${String(s.id ?? `step_${i + 1}`)}` +
                    ` created_by=risk_analyzer` +
                    ` original_tool=send_document` +
                    ` new_tool=send_document` +
                    ` reason="file_path inferred from prior write: ${inferredPath}"` +
                    ` description="${String(s.description ?? '').slice(0, 80)}"`
                );
            });

            const sanitized = sanitizePlanSteps(
                rawSteps,
                this.toolRegistry,
                '[RiskAnalyzer] adjusted step',
                detectMissingRequiredArgs,
                WRITE_CONTENT_STUB_PATTERNS,
            );
            const adjustedPlan: PlanStep[] = sanitized.steps;

            // Pós-processamento específico do RiskAnalyzer: tools críticas (edit, exec_command)
            // com args ausentes NÃO são convertidas silenciosamente para agentloop — o plano é
            // rejeitado. `write` fica de fora: GoalPlanner.parsePlanResponse() já valida e
            // converte write-sem-path para agentloop antes de chegar aqui — qualquer write-sem-
            // path no adjusted plan foi adicionado pelo LLM de risco como step de síntese, e
            // convertê-lo para agentloop é o comportamento correto (não crítico).
            // [STEP-MUTATION] é emitido para toda mutation de 'missing_args' (crítica ou não) —
            // mesmo comportamento que existia antes desta consolidação.
            const CRITICAL_TOOLS = new Set(['edit', 'exec_command']);
            const criticalMutations: string[] = [];
            for (const m of sanitized.mutations) {
                if (m.reason !== 'missing_args') continue;
                log.info(
                    `[STEP-MUTATION]` +
                    ` step=${m.stepId}` +
                    ` created_by=risk_analyzer` +
                    ` original_tool=${m.originalTool}` +
                    ` new_tool=agentloop` +
                    ` reason="${m.detail}"` +
                    ` description="${m.description.slice(0, 80)}"`
                );
                if (CRITICAL_TOOLS.has(m.originalTool)) {
                    criticalMutations.push(`'${m.originalTool}' ${m.stepId}: args ausentes [${m.detail}]`);
                    log.warn(
                        `[RiskAnalyzer] critical mutation detected:` +
                        ` step=${m.stepId} tool=${m.originalTool} missing=${m.detail}` +
                        ` — will reject plan`
                    );
                }
            }

            // CR#4: rejeitar quando tools críticas precisariam virar agentloop por args ausentes
            if (criticalMutations.length > 0) {
                const rejectionReason =
                    `Plano rejeitado: ${criticalMutations.length} step(s) crítico(s) com argumentos obrigatórios ausentes — ` +
                    criticalMutations.join('; ') +
                    '. Replaneje fornecendo os argumentos corretos (path, content, command).';
                log.warn(`[RiskAnalyzer] plan rejected (critical_mutations): ${criticalMutations.join(', ')}`);
                return {
                    risks: [...detectedRisks, rejectionReason],
                    adjustedPlan: plan,
                    planAdjusted: false,
                    planRejected: true,
                    rejectionReason,
                };
            }

            const planAdjusted =
                adjustedPlan.length !== plan.length ||
                adjustedPlan.some((s, i) => s.toolName !== plan[i]?.toolName || s.description !== plan[i]?.description);

            log.info(`[RiskAnalyzer] LLM review: risks=${detectedRisks.length} planAdjusted=${planAdjusted} steps=${adjustedPlan.length}`);

            return {
                risks: detectedRisks,
                adjustedPlan: planAdjusted ? adjustedPlan : plan,
                planAdjusted,
            };
        } catch (err) {
            log.warn('[RiskAnalyzer] LLM review error — using original plan:', String(err));
            return { risks: [], adjustedPlan: plan, planAdjusted: false };
        }
    }
}
