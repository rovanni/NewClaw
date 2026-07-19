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

/**
 * ARCH-013: bar de confiança para promover um attempt 'partial' a 'success' quando o
 * veredito é 'relevant'. Deliberadamente MAIS BAIXO que LLM_MISMATCH_CONFIDENCE_THRESHOLD
 * (0.80, reservado para downgrade) — reusa o próprio bar que fastPathCheck já usa para decidir
 * "confiável o bastante para não precisar de LLM" (FAST_PATH_CONFIDENCE_THRESHOLD), em vez de
 * inventar um terceiro número. Downgrade e promoção não são simétricos por acidente: rebaixar
 * bloqueia progresso (custo alto de falso positivo, merece bar mais alto); promover só
 * confirma um 'partial' que já contava como progresso — bar mais baixo é aceitável.
 */
const PROMOTE_CONFIDENCE_THRESHOLD = FAST_PATH_CONFIDENCE_THRESHOLD;

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
    /**
     * ARCH-013: true quando o resultado é 'relevant' com confiança suficiente — o caller pode
     * promover um `GoalAttempt.result` já persistido como 'partial' (sucesso não-confirmado)
     * para 'success' confiante, sem precisar de uma 2ª chamada de LLM dedicada
     * (`escalateStepEvalToLLM`, removida — este veredito passa a ser a única fonte).
     */
    shouldPromoteToConfidentSuccess: boolean;
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
                shouldPromoteToConfidentSuccess: false,
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
                shouldPromoteToConfidentSuccess:
                    fastResult.result === 'relevant' &&
                    fastResult.confidence >= PROMOTE_CONFIDENCE_THRESHOLD,
            };
        }

        // Slow path: LLM call para casos ambíguos
        const llmResult = await this.llmValidate(step, toolOutput, goalIntent);
        return {
            ...llmResult,
            shouldDowngradeToPartial:
                llmResult.result === 'mismatch' &&
                llmResult.confidence >= LLM_MISMATCH_CONFIDENCE_THRESHOLD,
            shouldPromoteToConfidentSuccess:
                llmResult.result === 'relevant' &&
                llmResult.confidence >= PROMOTE_CONFIDENCE_THRESHOLD,
        };
    }

    private extractKeyTerms(step: PlanStep): string[] {
        const descLower = step.description.toLowerCase();

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

        return [...new Set([...tokens, ...argTokens])].slice(0, 20);
    }

    /**
     * Recorta o output para caber no prompt do LLM sem descartar a parte relevante.
     * Um slice(0, N) ingênuo perde o conteúdo quando ele aparece depois do corte —
     * ex: list_workspace lista diretórios (recursivos) antes de arquivos da raiz, então
     * um arquivo específico buscado pelo step pode só aparecer bem depois do byte 600.
     * Isso fez o validador LLM ver um trecho sem o arquivo e reportar 'mismatch' mesmo
     * com o arquivo presente no output completo (falso positivo de downgrade).
     */
    private extractRelevantSnippet(output: string, keyTerms: string[], maxLen: number): string {
        if (output.length <= maxLen) return output;

        const head = output.slice(0, maxLen);
        const headLower = head.toLowerCase();
        const outputLower = output.toLowerCase();

        // Termos genéricos (ex: "workspace") tendem a aparecer logo no cabeçalho do output
        // mesmo quando o termo que realmente importa (ex: "sanitize_memory") só aparece
        // depois do corte. Por isso não basta pegar o match mais cedo entre todos os termos —
        // o que importa é achar um termo que exista no texto completo mas NÃO no corte padrão.
        const missingTerm = keyTerms.find(t => outputLower.includes(t) && !headLower.includes(t));
        if (!missingTerm) return head;

        const idx = outputLower.indexOf(missingTerm);
        const start = Math.max(0, idx - Math.floor(maxLen / 3));
        return output.slice(start, start + maxLen);
    }

    private fastPathCheck(step: PlanStep, output: string): Omit<StepSemanticValidation, 'shouldDowngradeToPartial' | 'shouldPromoteToConfidentSuccess'> {
        const outputLower = output.toLowerCase();
        const allKeyTerms = this.extractKeyTerms(step);
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
    ): Promise<Omit<StepSemanticValidation, 'shouldDowngradeToPartial' | 'shouldPromoteToConfidentSuccess'>> {
        const truncatedOutput = this.extractRelevantSnippet(toolOutput, this.extractKeyTerms(step), 600);
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
