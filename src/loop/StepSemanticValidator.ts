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
import { DECISION_PROMPT_MAX_CHARS } from '../core/providerTypes';

const log = createLogger('StepSemanticValidator');

// Sem padrão embutido (issue 019): quando o operador não configura, quem decide o modelo é o
// provedor ativo — via getProviderWithModel() sem modelo. Um nome de modelo de NUVEM como padrão
// aqui era enviado ao provedor em uso, e numa instalação só-local ele não existe.
const VALIDATOR_MODEL = process.env['SEMANTIC_VALIDATOR_MODEL'] ?? '';
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

    private async llmValidate(
        step: PlanStep,
        toolOutput: string,
        goalIntent?: string,
        facts?: StepExecutionFacts,
    ): Promise<Omit<StepSemanticValidation, 'shouldDowngradeToPartial' | 'shouldPromoteToConfidentSuccess'>> {
        // Informação Completa para Decidir (Sprint V5): o resultado do passo é o OBJETO da decisão — vai inteiro, e o
        // pedido também. Antes: 600 chars escolhidos por coincidência de palavras-chave (uma heurística decidindo o que
        // o LLM podia ver) e 200 chars do pedido. Sem orçamento para o resultado inteiro, "unverifiable" (não avaliável),
        // que não rebaixa nem promove o passo — nunca um veredito sobre um trecho.
        const lines = [
            'Você é um validador de relevância de resultado de ferramentas.',
            '',
            `Intenção do step: "${step.description}"`,
            goalIntent ? `Pedido do usuário (íntegro): "${goalIntent}"` : '',
            `Ferramenta executada: ${step.toolName ?? 'agentloop'}`,
            ...(facts ? describeFacts(facts) : []),
            '',
            'Output da ferramenta (íntegro):',
            '"""',
            toolOutput,
            '"""',
            '',
            facts ? 'O output acima, junto com os fatos da execução, ENDEREÇA a intenção do step?' : 'O output acima ENDEREÇA a intenção do step?',
            'Responda APENAS com JSON: {"result": "relevant"|"mismatch"|"unverifiable", "confidence": 0.0-1.0, "reason": "curta em português"}',
            'Exemplo de mismatch: step pede cotações de BTC/ZEC mas output lista dados de ETH/ENA; step pede criar arquivo mas output é erro genérico.',
        ].filter(Boolean);

        const prompt = lines.join('\n');
        if (prompt.length > DECISION_PROMPT_MAX_CHARS) {
            log.info(`[StepSemanticValidator] step=${step.id} prompt de ${prompt.length} chars excede ${DECISION_PROMPT_MAX_CHARS} — não avaliável, sem chamar o LLM`);
            return { result: 'unverifiable', confidence: 0.5, reason: `resultado grande demais para avaliar inteiro (${toolOutput.length} chars)`, usedFastPath: false };
        }
        const messages: LLMMessage[] = [{ role: 'user', content: prompt }];

        // Reusa chatWithFallback em vez de getProviderWithModel() direto (D-08,
        // docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md) — mesmo mecanismo que
        // ObserverValidator (S258) já usa. getProviderWithModel() sem providerName cai sempre em
        // this.defaultProvider, sem nenhum fallback se essa única chamada falhar; chatWithFallback
        // tenta os demais providers antes de desistir, com o mesmo TIMEOUT_MS de hoje delimitando
        // cada tentativa. O fail-soft ("unverifiable") continua decidido aqui, não no
        // ProviderFactory — qualquer status diferente de 'success' cai no mesmo ramo.
        const result = await this.providerFactory.chatWithFallback(messages, undefined, undefined, TIMEOUT_MS, undefined, VALIDATOR_MODEL, { diag: { component: 'StepSemanticValidator', role: 'validator' } });
        if (result.status !== 'success') {
            log.debug(`[StepSemanticValidator] LLM falhou (status=${result.status}) — unverifiable`);
            return { result: 'unverifiable', confidence: 0.5, reason: 'erro na validação LLM', usedFastPath: false };
        }

        try {
            const cleaned = result.content
                .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { result: 'unverifiable', confidence: 0.5, reason: 'LLM sem JSON válido', usedFastPath: false };
            }

            const parsed = JSON.parse(jsonMatch[0]) as { result?: string; confidence?: number; reason?: string };
            const parsedResult = (['relevant', 'mismatch', 'unverifiable'] as const).includes(parsed.result as SemanticValidationResult)
                ? (parsed.result as SemanticValidationResult)
                : 'unverifiable';

            const confidence = typeof parsed.confidence === 'number'
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0.6;

            log.info(
                `[StepSemanticValidator] LLM step=${step.id}` +
                ` tool=${step.toolName ?? 'agentloop'}` +
                ` result=${parsedResult} confidence=${confidence.toFixed(2)}` +
                ` reason="${(parsed.reason ?? '').slice(0, 80)}"`
            );

            return { result: parsedResult, confidence, reason: parsed.reason, usedFastPath: false };
        } catch (err) {
            log.debug(`[StepSemanticValidator] erro ao interpretar resposta: ${String(err).slice(0, 80)} — unverifiable`);
            return { result: 'unverifiable', confidence: 0.5, reason: 'erro na validação LLM', usedFastPath: false };
        }
    }
}
