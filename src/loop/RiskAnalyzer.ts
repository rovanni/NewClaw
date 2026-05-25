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
import { Goal, PlanStep } from './GoalTypes';

const log = createLogger('RiskAnalyzer');

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

        // ── 0. Constraints duras do ReflectionMemory (bloqueantes) ───────────
        // Ferramentas com ≥90% de falha recente viram proibições absolutas.
        // Se o plano viola uma constraint, bloqueamos antes de qualquer execução.
        const constraints = this.reflectionMemory.buildConstraints(goal.objective.slice(0, 150));
        if (constraints.length > 0) {
            for (const c of constraints) risks.push(`[CONSTRAINT] ${c}`);

            const violatingConstraint = this.findViolatingConstraint(plan, constraints);
            if (violatingConstraint) {
                log.warn(`[RiskAnalyzer] goal=${goal.id} BLOCKED by hard constraint: ${violatingConstraint}`);
                return {
                    risks,
                    adjustedPlan: plan,
                    planAdjusted: false,
                    blocked: true,
                    blockReason: violatingConstraint,
                };
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
                risks.push(`Step "${step.description}": usa '${firstToken}' (pacote: ${pkg}) — pode não estar instalado no servidor`);
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
     * Retorna a primeira constraint que o plano viola, ou null se nenhuma for violada.
     *
     * Lógica: extrai a ferramenta proibida de cada constraint e verifica se ela
     * está presente no plano. Isso evita falsos positivos de constraints globais
     * (goal_blocker_*) bloquearem goals que não usam a ferramenta problemática.
     *
     * Retornar a constraint exata (em vez de boolean) permite que o log informe
     * qual regra foi violada, não apenas constraints[0] (que era sempre "web_search").
     */
    private findViolatingConstraint(plan: PlanStep[], constraints: string[]): string | null {
        const planTools = new Set(plan.map(s => s.toolName).filter(Boolean) as string[]);

        for (const constraint of constraints) {
            // Extrai nome da ferramenta de textos como "A ferramenta 'web_search' falhou..."
            // Só bloqueia se essa ferramenta está efetivamente no plano atual.
            const toolMatch = constraint.match(/'([a-z][a-z0-9_]*)'/i);
            if (toolMatch && planTools.has(toolMatch[1])) return constraint;

            // Casos especiais: pip install e python3 -m venv são detectados via args de exec_command
            for (const step of plan) {
                const cmdValue = String(step.toolArgs?.command ?? step.toolArgs?.cmd ?? '');
                if (/pip install/i.test(constraint) && /pip\s+install/i.test(cmdValue)) return constraint;
                if (/python3 -m venv/i.test(constraint) && /python3\s+-m\s+venv/i.test(cmdValue)) return constraint;
            }
        }
        return null;
    }


    private async reviewPlanWithLLM(goal: Goal, plan: PlanStep[]): Promise<{
        risks: string[];
        adjustedPlan: PlanStep[];
        planAdjusted: boolean;
    }> {
        const stepsStr = plan
            .map((s, i) => `${i + 1}. [${s.toolName ?? 'agentloop'}] ${s.description}`)
            .join('\n');

        const prompt = `Você é um analisador de riscos de execução. Revise este plano antes de executá-lo.

OBJETIVO: ${goal.objective}

PLANO:
${stepsStr}

Ferramentas disponíveis: exec_command, read, write, edit, web_search, web_navigate, memory_search, read_document, list_workspace, send_document, send_audio

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
            // 90s allows models with extended thinking (kimi-k2.6, gemma4) to finish
            // JSON output after deep reasoning — 45s caused truncated JSON errors in prod.
            const result = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                90_000,
            );

            if (result.status !== 'success') {
                log.warn('[RiskAnalyzer] LLM review failed — using original plan');
                return { risks: [], adjustedPlan: plan, planAdjusted: false };
            }

            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);

            const detectedRisks: string[] = Array.isArray(parsed.risks) ? parsed.risks : [];

            if (!parsed.plan || !Array.isArray(parsed.plan) || parsed.plan.length === 0) {
                return { risks: detectedRisks, adjustedPlan: plan, planAdjusted: false };
            }

            // Valida tools do plano ajustado
            const adjustedPlan: PlanStep[] = parsed.plan.slice(0, 5).map((s: Record<string, unknown>, i: number) => {
                const rawTool = s.toolName ? String(s.toolName) : undefined;
                const resolvedTool = rawTool && this.toolRegistry.get(rawTool) ? rawTool : undefined;
                if (rawTool && !resolvedTool) {
                    log.warn(`[RiskAnalyzer] tool '${rawTool}' não existe — step sem tool`);
                }
                return {
                    id: String(s.id ?? `step_${i + 1}`),
                    description: String(s.description ?? 'Execute step'),
                    toolName: resolvedTool,
                    toolArgs: resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
                        ? s.toolArgs as Record<string, unknown>
                        : undefined,
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
