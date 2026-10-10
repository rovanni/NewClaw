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
import type { ProviderFactory } from '../core/ProviderFactory';
import { PlanStep } from './GoalTypes';
import { obterMotor } from '../validation/motorPadrao';
import type { DecisaoDoPasso } from '../validation/tipos/demaisTipos';

const log = createLogger('StepSemanticValidator');

const FAST_PATH_CONFIDENCE_THRESHOLD = 0.72;
const LLM_MISMATCH_CONFIDENCE_THRESHOLD = 0.80;

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

/**
 * Issue 056 (F3) — fatos ESTRUTURAIS da execução do step, registrados pelo sistema (não narrados pelo
 * modelo): o que o sub-turno chamou, o que falhou e que arquivos produziu. Antes o validador via só o texto
 * da resposta (600 chars) e "Ferramenta executada: agentloop": rebaixou um step que tinha gravado o arquivo
 * pedido ("o step pedia criar um arquivo com ferramenta de escrita, mas o output é só texto") e não tinha como
 * notar quando nenhuma escrita aconteceu. Entram como evidência para o LLM ponderar — nenhuma decisão
 * determinística nova (Preservação do Raciocínio).
 */
export interface StepExecutionFacts {
    toolsCalled: string[];
    toolsFailed: string[];
    /** undefined = o sistema não registra arquivos para este tipo de step (ex.: agentloop) — NÃO é "nenhum". */
    artifacts?: string[];
}

function describeFacts(facts: StepExecutionFacts): string[] {
    const list = (xs: string[]) => (xs.length > 0 ? [...new Set(xs)].slice(0, 12).join(', ') : 'nenhuma');
    return [
        'Fatos da execução (registrados pelo sistema, não pelo modelo):',
        `- Ferramentas chamadas: ${list(facts.toolsCalled)}`,
        `- Ferramentas que falharam: ${list(facts.toolsFailed)}`,
        `- Arquivos gravados/produzidos: ${facts.artifacts === undefined ? 'não registrado para este tipo de etapa' : facts.artifacts.length > 0 ? [...new Set(facts.artifacts)].slice(0, 8).join(', ') : 'nenhum'}`,
    ];
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
        facts?: StepExecutionFacts,
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
        const llmResult = await this.llmValidate(step, toolOutput, goalIntent, facts);
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

    /**
     * Troca M4 (ADR-014, 09/10/2026): quem julga é o motor único, tipo `resultado_do_passo` — a pergunta, as entradas
     * (pedido e resultado ÍNTEGROS; sem orçamento para o resultado inteiro o motor devolve "não avaliável", nunca um
     * veredito sobre um trecho), o prazo, o modelo e o registro no gravador de voo são do descritor e do motor. Aqui
     * ficam só as entradas deste consumidor e a escala de três estados que ele usa.
     */
    private async llmValidate(
        step: PlanStep,
        toolOutput: string,
        goalIntent?: string,
        facts?: StepExecutionFacts,
    ): Promise<Omit<StepSemanticValidation, 'shouldDowngradeToPartial' | 'shouldPromoteToConfidentSuccess'>> {
        try {
            const { adaptado } = await obterMotor(this.providerFactory).validar<DecisaoDoPasso>('resultado_do_passo', {
                pedido: goalIntent,
                resultado: toolOutput,
                passo: `Intenção do passo: ${step.description}\nFerramenta executada: ${step.toolName ?? 'agentloop'}`,
                fatos: facts ? describeFacts(facts).join('\n') : undefined,
            }, { stepId: step.id, phase: 'passo' });
            const confidence = Math.max(0, Math.min(1, adaptado.confidence));
            log.info(
                `[StepSemanticValidator] LLM step=${step.id}` +
                ` tool=${step.toolName ?? 'agentloop'}` +
                ` result=${adaptado.result} confidence=${confidence.toFixed(2)}` +
                ` reason="${(adaptado.reason ?? '').slice(0, 80)}"`
            );
            return { result: adaptado.result, confidence, reason: adaptado.reason, usedFastPath: false };
        } catch (err) {
            log.debug(`[StepSemanticValidator] erro no motor: ${String(err).slice(0, 80)} — unverifiable`);
            return { result: 'unverifiable', confidence: 0.5, reason: 'erro na validação LLM', usedFastPath: false };
        }
    }
}
