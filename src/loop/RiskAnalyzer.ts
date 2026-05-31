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
import { Goal, PlanStep } from './GoalTypes';
import { detectMissingRequiredArgs } from './GoalPlanner';

const log = createLogger('RiskAnalyzer');

// Modelo dedicado à revisão de riscos: gera JSON rápido e não entra em extended thinking.
// kimi-k2.6 e outros thinking models são inadequados — raciocinam 150s+ sem produzir output.
const RISK_REVIEW_MODEL = 'gemma4:31b-cloud';

// Binários universais presentes em qualquer shell POSIX sem necessidade de instalação.
// Checar via CapabilityRegistry causaria falso positivo — esses comandos não estão no
// TOOLS_TO_PROBE do EnvironmentProbe mas funcionam em qualquer ambiente Linux/macOS.
const SHELL_UNIVERSALS = new Set([
    'ls', 'cd', 'echo', 'cat', 'grep', 'find', 'pwd', 'mkdir', 'rm', 'cp', 'mv',
    'chmod', 'chown', 'which', 'test', 'head', 'tail', 'sort', 'uniq', 'wc',
    'touch', 'sed', 'awk', 'tr', 'cut', 'date', 'env', 'printf', 'tee', 'xargs',
    'sh', 'bash', 'python3', 'python', 'node', 'true', 'false', 'read',
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
}

export class RiskAnalyzer {
    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly toolRegistry: typeof ToolRegistry,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    async analyze(goal: Goal, plan: PlanStep[]): Promise<RiskReport> {
        if (plan.length === 0) {
            return { risks: [], adjustedPlan: plan, planAdjusted: false, blocked: false };
        }

        const risks: string[] = [];

        // ── 0. Constraints duras do ReflectionMemory (cirurgia seletiva) ────
        // Ferramentas com ≥90% de falha recente viram proibições absolutas.
        // Em vez de bloquear o plano inteiro, removemos os steps que usam a
        // ferramenta proibida. Só bloqueamos se o plano ficar completamente vazio.
        // Passa planTools para filtrar constraints de tools que não estão no plano.
        const planTools = plan.map(s => s.toolName).filter((t): t is string => Boolean(t));
        const constraints = this.reflectionMemory.buildConstraints(goal.objective.slice(0, 150), planTools);
        if (constraints.length > 0) {
            for (const c of constraints) risks.push(`[CONSTRAINT] ${c}`);

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
                // Plano com steps problemáticos removidos — continua a execução
                log.warn(`[RiskAnalyzer] goal=${goal.id} pruned ${plan.length - prunedPlan.length} step(s) violating constraint: ${violatedConstraint}`);
                plan = prunedPlan;
            }
        }

        // ── 1. Verificação rápida sem LLM ────────────────────────────────────
        for (const step of plan) {
            if (!step.toolName) continue;

            if (!this.toolRegistry.get(step.toolName)) {
                risks.push(`Step "${step.description}": tool '${step.toolName}' não registrada`);
            }

            const hint = this.reflectionMemory.buildContextHint(`tool_${step.toolName}`);
            if (hint) {
                const firstLine = hint.split('\n').find(l => l.startsWith('-')) ?? hint;
                risks.push(`Step "${step.description}": ${firstLine.slice(0, 120)}`);
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
                // Obs #9: verifica se o CapabilityRegistry já tem resultado do probe para este binário
                const probeResult = CapabilityRegistry.getInstance().canSync(`tool.${firstToken}`);
                const riskReason = `usa '${firstToken}' (pacote: ${pkg}) — pode não estar instalado no servidor`;
                log.info(
                    `[RISK-CHECK] risk_source=1b_KNOWN_DEPS probe_result=${probeResult === null ? 'uncached' : probeResult} ` +
                    `binary=${firstToken} risk_reason="${riskReason}"`
                );
                risks.push(`Step "${step.description}": ${riskReason}`);
            }
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

        if (risks.length > 0) {
            log.info(`[RiskAnalyzer] goal=${goal.id} risks=${risks.length} planAdjusted=${llmResult.planAdjusted}`);
        }

        return { risks, adjustedPlan: finalPlan, planAdjusted: llmResult.planAdjusted, blocked: false };
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
        const provider = this.providerFactory.getProviderWithModel(RISK_REVIEW_MODEL);
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

            // Valida tools do plano ajustado
            const adjustedPlan: PlanStep[] = rawSteps.map((s: Record<string, unknown>, i: number) => {
                const rawTool = s.toolName ? String(s.toolName) : undefined;
                let resolvedTool = rawTool && this.toolRegistry.get(rawTool) ? rawTool : undefined;
                if (rawTool && !resolvedTool) {
                    log.warn(`[RiskAnalyzer] tool '${rawTool}' não existe — step sem tool`);
                }
                let toolArgs = resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
                    ? s.toolArgs as Record<string, unknown>
                    : undefined;

                // Mesma validação do parsePlanResponse: args obrigatórios ausentes
                // → converte para AgentLoop (sem toolName) para o LLM resolver com contexto.
                // Usa toolArgs ?? {} para capturar também o caso em que toolArgs é undefined
                // (ex: send_document gerado pelo LLM sem a chave toolArgs).
                if (resolvedTool) {
                    const missing = detectMissingRequiredArgs(resolvedTool, toolArgs ?? {});
                    if (missing) {
                        log.warn(`[RiskAnalyzer] adjusted step ${i + 1}: '${resolvedTool}' ${missing} — converting to AgentLoop step`);
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
