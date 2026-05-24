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

export interface RiskReport {
    risks: string[];
    adjustedPlan: PlanStep[];
    planAdjusted: boolean;
}

export class RiskAnalyzer {
    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly toolRegistry: typeof ToolRegistry,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    async analyze(goal: Goal, plan: PlanStep[]): Promise<RiskReport> {
        if (plan.length === 0) {
            return { risks: [], adjustedPlan: plan, planAdjusted: false };
        }

        const risks: string[] = [];

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

        // ── 2. Revisão LLM do plano completo ────────────────────────────────
        const llmResult = await this.reviewPlanWithLLM(goal, plan);

        if (llmResult.risks.length > 0) risks.push(...llmResult.risks);

        const finalPlan = llmResult.planAdjusted ? llmResult.adjustedPlan : plan;

        if (risks.length > 0) {
            log.info(`[RiskAnalyzer] goal=${goal.id} risks=${risks.length} planAdjusted=${llmResult.planAdjusted}`);
        }

        return { risks, adjustedPlan: finalPlan, planAdjusted: llmResult.planAdjusted };
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
            const result = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                20_000,
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
