/**
 * StepSemanticValidator — Valida se o output de uma tool é semanticamente
 * relevante para a intenção do step.
 *
 * Problema: GoalEvaluator marca steps como 'success' quando toolResult.success=true,
 * mesmo que o output não responda a intenção do step (ex: crypto_analysis retorna
 * dados de ENA/BCH quando o step pede River/ZEC/Pi).
 *
 * Solução: após um step marcado como 'success' pelo avaliador heurístico, uma
 * validação leve verifica se o output endereça o que o step pretendia.
 *
 * Design:
 * - Fast path determinístico: verifica termos-chave do step no output (sem LLM)
 * - Slow path LLM: apenas quando o fast path é inconclusivo (confidence < THRESHOLD)
 * - Timeout curto (8s) para não bloquear o ciclo
 */

import { createLogger } from '../shared/AppLogger';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { PlanStep } from './GoalTypes';

const log = createLogger('StepSemanticValidator');

const VALIDATOR_MODEL = process.env['SEMANTIC_VALIDATOR_MODEL'] ?? 'gemma4:31b-cloud';
const FAST_PATH_CONFIDENCE_THRESHOLD = 0.72;
const LLM_MISMATCH_CONFIDENCE_THRESHOLD = 0.80;
const TIMEOUT_MS = 8_000;

export type SemanticValidationResult =
    | 'relevant'       // output endereça a intenção do step
    | 'mismatch'       // output não é relevante para a intenção
    | 'unverifiable';  // não foi possível determinar (timeout, erro LLM, output vazio)

export interface StepSemanticValidation {
    result: SemanticValidationResult;
    confidence: number;
    reason?: string;
    /** true se a validação foi resolvida pelo fast path determinístico (sem LLM) */
    usedFastPath: boolean;
    /**
     * true quando o resultado é 'mismatch' com alta confiança — o caller deve
     * tratar o outcome do step como 'partial' (retry) em vez de 'success'.
     */
    shouldDowngradeToPartial: boolean;
}

const STOPWORDS = new Set([
    'para', 'com', 'sem', 'uma', 'uns', 'ela', 'ele', 'que', 'não', 'por', 'mas',
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were',
    'sobre', 'dos', 'das', 'nos', 'nas', 'seu', 'sua', 'seus', 'suas',
]);

export class StepSemanticValidator {
    constructor(private readonly providerFactory: ProviderFactory) {}

    /**
     * Valida se `toolOutput` é semanticamente relevante para a intenção de `step`.
     * Chama LLM apenas quando o fast path não é conclusivo.
     */
    async validate(
        step: PlanStep,
        toolOutput: string,
        goalIntent?: string,
    ): Promise<StepSemanticValidation> {
        if (!toolOutput || toolOutput.trim().length < 15) {
            return {
                result: 'unverifiable',
                confidence: 0.5,
                reason: 'output vazio ou muito curto',
                usedFastPath: true,
                shouldDowngradeToPartial: false,
            };
        }

        const fastResult = this.fastPathCheck(step, toolOutput);
        log.debug(
            `[StepSemanticValidator] fast_path step=${step.id}` +
            ` tool=${step.toolName ?? 'agentloop'}` +
            ` result=${fastResult.result} confidence=${fastResult.confidence.toFixed(2)}`
        );

        if (fastResult.confidence >= FAST_PATH_CONFIDENCE_THRESHOLD) {
            return {
                ...fastResult,
                shouldDowngradeToPartial:
                    fastResult.result === 'mismatch' &&
                    fastResult.confidence >= LLM_MISMATCH_CONFIDENCE_THRESHOLD,
            };
        }

        // Slow path: LLM call para casos ambíguos
        const llmResult = await this.llmValidate(step, toolOutput, goalIntent);
        return {
            ...llmResult,
            shouldDowngradeToPartial:
                llmResult.result === 'mismatch' &&
                llmResult.confidence >= LLM_MISMATCH_CONFIDENCE_THRESHOLD,
        };
    }

    private fastPathCheck(step: PlanStep, output: string): Omit<StepSemanticValidation, 'shouldDowngradeToPartial'> {
        const descLower = step.description.toLowerCase();
        const outputLower = output.toLowerCase();

        const tokens = descLower
            .replace(/[^a-z0-9áéíóúãõâêôçàü\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 3 && !STOPWORDS.has(t));

        const argTokens: string[] = [];
        if (step.toolArgs) {
            for (const v of Object.values(step.toolArgs)) {
                if (typeof v === 'string' && v.length > 2) {
                    argTokens.push(
                        ...v.toLowerCase().split(/[\s,/\\]+/).filter(t => t.length > 2 && !STOPWORDS.has(t))
                    );
                }
            }
        }

        const allKeyTerms = [...new Set([...tokens, ...argTokens])].slice(0, 20);
        if (allKeyTerms.length === 0) {
            return {
                result: 'unverifiable',
                confidence: 0.5,
                reason: 'sem termos-chave extraíveis da descrição do step',
                usedFastPath: true,
            };
        }

        const hits = allKeyTerms.filter(t => outputLower.includes(t));
        const hitRate = hits.length / allKeyTerms.length;

        if (hitRate >= 0.35) {
            return {
                result: 'relevant',
                confidence: Math.min(0.95, 0.50 + hitRate * 0.55),
                reason: `${hits.length}/${allKeyTerms.length} termos-chave encontrados no output`,
                usedFastPath: true,
            };
        }

        return {
            result: 'unverifiable',
            confidence: 0.30 + hitRate * 0.40,
            reason: `apenas ${hits.length}/${allKeyTerms.length} termos-chave no output — escalando para LLM`,
            usedFastPath: true,
        };
    }

    private async llmValidate(
        step: PlanStep,
        toolOutput: string,
        goalIntent?: string,
    ): Promise<Omit<StepSemanticValidation, 'shouldDowngradeToPartial'>> {
        const truncatedOutput = toolOutput.slice(0, 600);
        const lines = [
            'Você é um validador de relevância de resultado de ferramentas.',
            '',
            `Intenção do step: "${step.description}"`,
            goalIntent ? `Objetivo do usuário: "${goalIntent.slice(0, 200)}"` : '',
            `Ferramenta executada: ${step.toolName ?? 'agentloop'}`,
            '',
            'Output da ferramenta (truncado a 600 chars):',
            '"""',
            truncatedOutput,
            '"""',
            '',
            'O output acima ENDEREÇA a intenção do step?',
            'Responda APENAS com JSON: {"result": "relevant"|"mismatch"|"unverifiable", "confidence": 0.0-1.0, "reason": "curta em português"}',
            'Exemplo de mismatch: step pede cotações de BTC/ZEC mas output lista dados de ETH/ENA; step pede criar arquivo mas output é erro genérico.',
        ].filter(Boolean);

        const messages: LLMMessage[] = [{ role: 'user', content: lines.join('\n') }];
        const provider = this.providerFactory.getProviderWithModel(VALIDATOR_MODEL);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await provider.chat(messages, undefined, { signal: controller.signal, timeoutMs: TIMEOUT_MS });
            clearTimeout(timer);

            const cleaned = response.content
                .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { result: 'unverifiable', confidence: 0.5, reason: 'LLM sem JSON válido', usedFastPath: false };
            }

            const parsed = JSON.parse(jsonMatch[0]) as { result?: string; confidence?: number; reason?: string };
            const result = (['relevant', 'mismatch', 'unverifiable'] as const).includes(parsed.result as SemanticValidationResult)
                ? (parsed.result as SemanticValidationResult)
                : 'unverifiable';

            const confidence = typeof parsed.confidence === 'number'
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0.6;

            log.info(
                `[StepSemanticValidator] LLM step=${step.id}` +
                ` tool=${step.toolName ?? 'agentloop'}` +
                ` result=${result} confidence=${confidence.toFixed(2)}` +
                ` reason="${(parsed.reason ?? '').slice(0, 80)}"`
            );

            return { result, confidence, reason: parsed.reason, usedFastPath: false };
        } catch (err) {
            clearTimeout(timer);
            log.debug(`[StepSemanticValidator] LLM error: ${String(err).slice(0, 80)} — unverifiable`);
            return { result: 'unverifiable', confidence: 0.5, reason: 'erro na validação LLM', usedFastPath: false };
        }
    }
}
