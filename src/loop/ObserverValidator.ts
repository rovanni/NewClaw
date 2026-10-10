/**
 * ObserverValidator — LLM-based post-execution quality checker
 * Uses OBSERVER_MODEL (default: qwen3.5:cloud only when the default provider is Ollama) to validate responses
 * Only runs when tools are executed, not for simple conversations
 */

import { ProviderFactory } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { createHash } from 'crypto';
import { ANALYSIS_INTENT_PATTERN } from '../shared/analysisIntentPattern';
import { TIPO_SAIDA_CONTRA_EVIDENCIA, type DecisaoDeGrounding } from '../validation/tipos/saidaContraEvidencia';
import { obterMotor } from '../validation/motorPadrao';
import type { DecisaoDeQualidade } from '../validation/tipos/demaisTipos';
const log = createLogger('Observervalidator');

export type FailureType = 'incomplete_response' | 'read_only' | 'future_action' | 'tool_error' | 'other' | 'none';

export interface ValidationResult {
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
    validationSkipped?: boolean;
    failureType?: FailureType;
    /** Gravador de voo (ADR-013): id do registro deste julgamento, quando houve julgamento. */
    avaliacaoId?: string;
}

/**
 * Resultado da fase de commit de resposta (Q4 pré-envio).
 * Determina se a resposta pode ser enviada ao usuário ou deve ser bloqueada/corrigida.
 */
export interface ResponseCommit {
    valid: boolean;
    hallucinationRisk: number;   // 0.0 – 1.0
    blocked: boolean;
    blockReason?: string;
    correctedResponse?: string;
    validationMs: number;
    failureType?: FailureType;
}

// ── C1 · Groundedness (ADR-010) ──────────────────────────────────────────────
// Contrato SEPARADO do de alucinação de ação acima. Aquele pergunta "a resposta afirma
// sucesso de uma ferramenta que falhou?"; este pergunta "as afirmações factuais da resposta
// são sustentadas pela evidência?". São perguntas distintas, com políticas de falha distintas,
// e por isso não compartilham `ResponseCommit`.

/** Estado epistemológico da resposta quanto a groundedness. Ver ADR-010 §5 e §10. */
export type GroundingState =
    /** avaliado; toda afirmação derivada tem suporte */
    | 'VALIDATED'
    /** avaliado; ao menos uma afirmação é determinada como não sustentada */
    | 'REJECTED'
    /** a resposta não apresenta afirmação derivada de evidência — C1 não se aplica */
    | 'NOT_APPLICABLE'
    /** há afirmação, mas a evidência disponível não a determina */
    | 'NOT_EVALUABLE'
    /** o juiz não produziu conclusão (timeout, erro, saída inválida, provedor indisponível) */
    | 'UNVALIDATED';

export type ClaimVerdict = 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_EVALUABLE';

export interface GroundedClaim {
    claim: string;
    /** ids de evidência declarados pelo juiz; vazio = nenhuma evidência pertinente identificada */
    evidence: string[];
    verdict: ClaimVerdict;
}

/** Uma evidência candidata do turno, derivada de ExecutionTrace (ADR-010 §4). */
export interface EvidenceItem {
    id: string;
    tool: string;
    input?: string;
    output: string;
}

/**
 * Quanto do texto de cada evidência vai para o LOG opcional (`TRACE_CONTENT=true`). Só tamanho de log:
 * o juiz recebe a evidência INTEIRA (nada é cortado; o que não cabe no teto do motor é "não avaliável").
 */
const TRACE_EVIDENCE_LOG_CHARS = 2000;
// ── Observabilidade do juiz de grounding (`[GROUNDING-TRACE]`) ───────────────────────────────
// Só fatos, nenhuma interpretação: o que o juiz recebeu (tamanho de cada evidência e se foi
// cortada), o que devolveu (TODAS as afirmações com veredito e evidência citada, não só a
// primeira) e por qual caminho a função saiu. Nasceu de um goal real de 25 min em que a resposta
// final foi bloqueada 4 vezes por "NOT_EVALUABLE" e o log não permitia dizer se as afirmações
// rejeitadas eram legítimas (issue 048).
//
// Dois níveis, porque evidência e resposta carregam conteúdo do usuário:
//   - SEMPRE: estrutura (tamanhos, vereditos, ids, truncamento, hash da resposta). Sem texto de evidência.
//   - `TRACE_CONTENT=true` (opt-in, vale também para `[GOAL-INTENT]`): também o texto da resposta, o texto EXATO de cada
//     evidência como o juiz a viu, e a saída crua do juiz. Para investigação, não para uso corrente.

export interface GroundingTraceContext {
    traceId?: string;
    conversationId?: string;
    /** De qual goal/step veio o texto avaliado (quando o turno faz parte de um goal). */
    goalId?: string;
    stepId?: string;
    stepDescription?: string;
    planGeneration?: number;
    /**
     * O pedido ORIGINAL do usuário. Sprint V3 (Informação Completa para Decidir): entra no prompt do
     * julgamento como CONTEXTO, numa seção própria — nunca como evidência. Não vai para o
     * `[GROUNDING-TRACE]` (só o tamanho); o gravador de voo o grava com TRACE_CONTENT.
     */
    userRequest?: string;
    /**
     * `initial` = julgamento da resposta do turno; `partial-revalidation` = revalidação da resposta
     * parcial; `shadow-extended` = a execução em sombra com evidência ampliada (nunca vira decisão).
     */
    phase?: 'initial' | 'partial-revalidation' | 'shadow-extended' | 'shadow-model';
}

interface GroundingEvidenceFact {
    id: string;
    tool: string;
    inputChars: number;
    outputChars: number;
    /** Quantos chars o juiz de fato viu (= outputChars, salvo corte por orçamento — issue 051). */
    sentChars: number;
    truncated: boolean;
}

interface GroundingTraceRecord {
    v: number;
    phase: string;
    traceId?: string;
    conversationId?: string;
    goalId?: string;
    stepId?: string;
    stepDescription?: string;
    planGeneration?: number;
    /** skipped_no_evidence | prompt_too_long | judge_failed | judge_error | malformed_judge_output | verdict */
    outcome: string;
    state?: GroundingState;
    elapsedMs: number;
    budgetMs: number;
    responseChars: number;
    promptChars?: number;
    judgeOutputChars?: number;
    judgeStatus?: string;
    judgeError?: string;
    evidences: GroundingEvidenceFact[];
    claims?: Array<{ claim: string; verdict: string; evidence: string[] }>;
    claimCounts?: { SUPPORTED: number; NOT_SUPPORTED: number; NOT_EVALUABLE: number };
    /** Só sai no log com GROUNDING_TRACE_CONTENT=true. */
    judgeRaw?: string;
}

export interface GroundingVerdict {
    state: GroundingState;
    claims: GroundedClaim[];
    /** motivo legível para log/auditoria — nunca vai ao usuário */
    reason: string;
    elapsedMs: number;
    /** de onde veio o orçamento de tempo (shared/auxTimeout.ts) */
    budgetMs: number;
    budgetOrigin: 'medido' | 'padrao';
    /** Gravador de voo (ADR-013): id do registro deste julgamento, para o consumidor gravar o efeito. */
    avaliacaoId?: string;
}

// ── Deterministic pre-checks ─────────────────────────────────────────────────
// Short-circuits LLM validation for obvious cases (~80% of tool calls).
// Ordered from most-specific to least-specific.

const TOOL_ERROR_PATTERN = /^\[(?:ERRO|FALHA|ERROR)\]|^Error:|^Erro:/i;

const KNOWN_GOOD_TOOLS: Array<{
    tool: string | RegExp;
    resultPattern: RegExp;
    minResponseLen: number;
    reason: string;
    confidence: number;
}> = [
    { tool: 'weather',       resultPattern: /\d+°C|temperatura|chuva|umidade|vento|previsão/i, minResponseLen: 30, reason: 'Dados meteorológicos válidos e resposta completa',   confidence: 0.92 },
    { tool: 'memory_search', resultPattern: /\w{10}/,                                          minResponseLen: 15, reason: 'Busca na memória com resultado e resposta fornecida', confidence: 0.85 },
    { tool: 'web_search',    resultPattern: /\w{50}/,                                          minResponseLen: 50, reason: 'Busca web com resultado e resposta fornecida',         confidence: 0.82 },
    { tool: /^crypto/,       resultPattern: /\$|R\$|BTC|ETH|USD|BRL|\d+[.,]\d{2}/i,          minResponseLen: 20, reason: 'Dados financeiros obtidos e resposta fornecida',       confidence: 0.90 },
    { tool: /^(exec_command|file_read)/, resultPattern: /\w{5}/, minResponseLen: 10, reason: 'Comando executado com saída e resposta fornecida', confidence: 0.80 },
];

export class ObserverValidator {
    private providerFactory: ProviderFactory;

    constructor(providerFactory: ProviderFactory, observerModel: string = process.env.OBSERVER_MODEL || '') {
        this.providerFactory = providerFactory;
        // O modelo do juiz é UM só para todos os tipos de validação e mora no motor único (ADR-014).
        if (observerModel) obterMotor(providerFactory).definirModeloDoJuiz(observerModel);
    }

    /**
     * Issue 068: o código não escolhe modelo para o juiz — sem OBSERVER_MODEL (painel ou .env) a chamada sai sem modelo e o
     * provedor usa o próprio padrão. Desde a troca ao motor único (ADR-014), esse modelo vale para TODOS os tipos de
     * validação, e este método só o repassa ao motor (`updateConfig` do painel chega aqui).
     */
    setModel(model: string): void {
        if (model) obterMotor(this.providerFactory).definirModeloDoJuiz(model);
    }

    // ── Deterministic pre-check (no LLM) ─────────────────────────────────────

    private deterministicCheck(
        toolUsed: string,
        toolResult: string,
        finalResponse: string
    ): ValidationResult | null {

        // 1. Tool returned an explicit error or empty result
        if (TOOL_ERROR_PATTERN.test(toolResult.trim()) || toolResult.trim().length < 3) {
            return { approved: false, reason: 'Ferramenta retornou erro ou resultado vazio', confidence: 0.95, suggestedFix: 'Tentar abordagem alternativa', failureType: 'tool_error' };
        }

        // 2. No final response yet (inline call before loop finishes) — skip LLM
        if (!finalResponse || finalResponse.trim().length < 15) {
            return { approved: true, reason: 'Ferramenta executou com saída disponível (resposta ainda não gerada)', confidence: 0.6, validationSkipped: true, failureType: 'none' };
        }

        // 3. Final response is clearly an error or refusal
        if (/^(desculp|lament|infelizmente|não (consig|poss)|sorry|I (can't|cannot))/i.test(finalResponse.trim().slice(0, 60))) {
            return { approved: false, reason: 'Resposta final indica falha ou recusa', confidence: 0.85, suggestedFix: 'Verificar disponibilidade da ferramenta ou usar alternativa', failureType: 'other' };
        }

        // 4. Known-good tool + valid result + adequate response
        for (const rule of KNOWN_GOOD_TOOLS) {
            const toolMatches = typeof rule.tool === 'string' ? toolUsed === rule.tool : rule.tool.test(toolUsed);
            if (toolMatches && rule.resultPattern.test(toolResult) && finalResponse.length >= rule.minResponseLen) {
                return { approved: true, reason: rule.reason, confidence: rule.confidence, failureType: 'none' };
            }
        }

        // No deterministic conclusion — fall through to LLM
        return null;
    }

    /**
     * Qualidade da resposta final: pré-checagens determinísticas para os casos óbvios (sem LLM) e, nos demais, o motor
     * único — tipo `qualidade_da_resposta` (troca M3, ADR-014, 09/10/2026). Pergunta, checklist, entradas (pedido,
     * resposta e resultados de TODAS as ferramentas do turno, íntegros), prazo, modelo e registro no gravador de voo são do
     * descritor e do motor; aqui ficam só as entradas deste consumidor e a tradução para `ValidationResult`.
     *
     * @param signal - AbortSignal tied to the caller's timeout. When the signal fires the
     *   provider call is abandoned and the method returns a skipped result instead of logging
     *   a confusing approved=false after the turn already ended.
     */
    async validate(
        userMessage: string,
        intent: string,
        toolUsed: string,
        toolResult: string,
        finalResponse: string,
        signal?: AbortSignal,
        /** Sprint V6: todas as ferramentas do turno. Sem isto, só `toolUsed`/`toolResult` (a última). */
        ferramentasDoTurno?: Array<{ tool: string; output: string }>,
    ): Promise<ValidationResult> {
        // Try deterministic check first — avoids LLM entirely for obvious cases
        const deterministic = this.deterministicCheck(toolUsed, toolResult, finalResponse);
        if (deterministic) {
            const tag = deterministic.validationSkipped ? '⏭️ skipped' : deterministic.approved ? '✅' : '❌';
            log.info(`${tag} [DETERMINISTIC] approved=${deterministic.approved} confidence=${deterministic.confidence} reason="${deterministic.reason}"`);
            if (!deterministic.validationSkipped) {
                log.info('GOAL_VALIDATION_PATH',
                    `validation_path=deterministic tool=${toolUsed}` +
                    ` approved=${deterministic.approved} confidence=${deterministic.confidence}` +
                    ` evidence_rule="${deterministic.reason}"`
                );
            }
            return deterministic;
        }

        if (signal?.aborted) {
            return { approved: true, reason: 'Validation cancelled before LLM call', confidence: 0, validationSkipped: true };
        }

        const ferramentas = ferramentasDoTurno && ferramentasDoTurno.length > 0 ? ferramentasDoTurno : [{ tool: toolUsed, output: toolResult }];
        const startTime = Date.now();
        try {
            const { adaptado: d, veredito, semVeredito } = await obterMotor(this.providerFactory).validar<DecisaoDeQualidade>('qualidade_da_resposta', {
                pedido: userMessage, resposta: finalResponse, intencao: intent,
                ferramentas: ferramentas.map((f, i) => `[${i + 1}] ferramenta=${f.tool}\n${f.output}`).join('\n\n'),
            }, { phase: 'qualidade', signal });
            const elapsed = Date.now() - startTime;

            // If the signal aborted while the LLM was running, discard the result silently.
            // This prevents the orphaned "approved=false" log that appears after the timeout
            // already fired and the turn has ended — confusing but actionless.
            if (signal?.aborted) {
                log.info(`[OBSERVER] Result discarded — signal aborted after ${elapsed}ms (post-turn advisory window closed)`);
                return { approved: true, reason: 'Validation result discarded after abort', confidence: 0, validationSkipped: true };
            }
            if (semVeredito) {
                log.warn(`Validation error: ${veredito.naoAvaliavelPorque}, skipping`);
                return { approved: false, reason: `Observer error: ${veredito.naoAvaliavelPorque}`, confidence: 0, validationSkipped: true, failureType: 'other', avaliacaoId: veredito.avaliacaoId };
            }

            const llmPath = d.confidence >= 0.7 ? 'llm_high_confidence' : 'llm_low_confidence';
            log.info(`${d.approved ? '✅' : '❌'} approved=${d.approved} confidence=${d.confidence} reason="${d.reason}" elapsed=${elapsed}ms`);
            log.info('GOAL_VALIDATION_PATH',
                `validation_path=${llmPath} tool=${toolUsed}` +
                ` approved=${d.approved} confidence=${d.confidence} elapsed_ms=${elapsed}`
            );
            return {
                approved: d.approved, reason: d.reason, confidence: d.confidence,
                suggestedFix: d.suggestedFix, failureType: d.failureType as FailureType, avaliacaoId: veredito.avaliacaoId,
            };
        } catch (error) {
            if (signal?.aborted) {
                return { approved: true, reason: 'Validation aborted', confidence: 0, validationSkipped: true, failureType: 'none' };
            }
            log.warn(`Validation error: ${errorMessage(error)}, skipping`);
            return { approved: false, reason: `Observer error: ${errorMessage(error)}`, confidence: 0, validationSkipped: true, failureType: 'other' };
        }
    }

    // ── Response Commit Phase (Q4 pré-envio) ─────────────────────────────────

    /**
     * Valida a resposta final ANTES do envio ao usuário.
     * Detecta alucinações de ação (afirmar sucesso quando a tool falhou).
     * Corre com timeout externo de 5 s — retorna {blocked:false} em caso de timeout.
     */
    async validateResponseCommit(
        userMessage: string,
        toolUsed: string,
        toolResult: string,
        finalResponse: string,
        signal?: AbortSignal,
        /** Sprint V6: todas as ferramentas do turno, para o julgamento de qualidade (o cheque determinístico usa a última). */
        ferramentasDoTurno?: Array<{ tool: string; output: string }>,
    ): Promise<ResponseCommit> {
        const t0 = Date.now();

        // Sem tool → sem risco de alucinação de ação
        if (!toolUsed || !toolResult) {
            return { valid: true, hallucinationRisk: 0, blocked: false, validationMs: 0 };
        }

        // ── Verificação determinística rápida (sem LLM) ────────────────────
        const deterministic = this.deterministicCheck(toolUsed, toolResult, finalResponse);

        if (deterministic) {
            const elapsed = Date.now() - t0;
            if (deterministic.approved || deterministic.validationSkipped) {
                return { valid: true, hallucinationRisk: 0.1, blocked: false, validationMs: elapsed };
            }
            // Tool falhou com alta confiança — verificar se a resposta admite isso
            const responseAdmitsFailure = /(?:não consegui|não foi possível|falhou|erro|problema|tente novamente|desculpe|lamento|não pude)/i
                .test(finalResponse.slice(0, 250));
            if (responseAdmitsFailure) {
                // Resposta honesta — não bloquear
                return { valid: true, hallucinationRisk: 0.2, blocked: false, validationMs: elapsed };
            }
            // Resposta afirma sucesso mas tool falhou → possível alucinação
            const hallucinationRisk = deterministic.confidence;
            const blocked = hallucinationRisk >= 0.7;
            log.warn(`[COMMIT] Deterministic hallucination check: risk=${hallucinationRisk.toFixed(2)} blocked=${blocked} tool=${toolUsed}`);
            return {
                valid: false,
                hallucinationRisk,
                blocked,
                blockReason: deterministic.reason,
                failureType: deterministic.failureType,
                correctedResponse: blocked
                    ? this.buildCorrectedResponse(deterministic.failureType || 'other', deterministic.reason, deterministic.suggestedFix, userMessage)
                    : undefined,
                validationMs: elapsed,
            };
        }

        // ── Verificação via LLM (casos ambíguos) ──────────────────────────
        if (signal?.aborted) {
            return { valid: true, hallucinationRisk: 0, blocked: false, validationMs: Date.now() - t0 };
        }

        const llmResult = await this.validate(userMessage, userMessage, toolUsed, toolResult, finalResponse, signal, ferramentasDoTurno);
        const elapsed = Date.now() - t0;

        if (llmResult.approved || llmResult.validationSkipped) {
            return { valid: true, hallucinationRisk: Math.max(0, 1 - llmResult.confidence) * 0.5, blocked: false, validationMs: elapsed };
        }

        // O LLM rejeitou a qualidade (ex: não atendeu plenamente).
        // Isso NÃO é necessariamente uma alucinação de ação, apenas uma resposta insatisfatória.
        // Bloquear a resposta esconde a interação do usuário e gera loops de "erro interno/cortada".
        // Só sinalizamos valid=false para métricas/memória, mas NÃO bloqueamos a mensagem.
        const hallucinationRisk = llmResult.confidence * 0.5;
        const blocked = false;
        
        return {
            valid: false,
            hallucinationRisk,
            blocked,
            blockReason: llmResult.reason,
            validationMs: elapsed,
        };
    }

    private buildCorrectedResponse(failureType: FailureType, reason: string, suggestedFix: string | undefined, userMessage: string): string {
        // Log completo para auditoria — nunca expor reason/suggestedFix crus ao usuário
        log.info(`[OBSERVER-BLOCK] type="${failureType}" reason="${reason}"${suggestedFix ? ` | fix="${suggestedFix}"` : ''}`);

        if (failureType === 'incomplete_response') {
            return 'Minha resposta anterior foi cortada antes de terminar. Tente novamente — ' +
                   'vou tentar responder de forma mais direta e completa.';
        }
        if (failureType === 'read_only') {
            if (ANALYSIS_INTENT_PATTERN.test(userMessage)) {
                return 'Não consegui confirmar que a tarefa foi concluída. Tente novamente ou peça de forma mais específica.';
            }
            return 'Não consegui completar: o arquivo é grande demais para processar em um único turno. ' +
                   'Tente novamente — posso usar uma abordagem diferente para modificá-lo diretamente.';
        }
        if (failureType === 'future_action') {
            return 'Fiz alterações, mas não consegui confirmar que o resultado final atende ao que você pediu. ' +
                   'Peça para eu revisar e confirmar o que foi aplicado, ou repita o pedido com mais detalhes.';
        }

        return 'Não consegui completar a tarefa solicitada. ' +
               'Por favor, tente novamente ou reformule o pedido com mais detalhes.';
    }

    // ── C1 · Groundedness (ADR-010) ──────────────────────────────────────────

    /**
     * Verifica se as afirmações factuais da resposta são sustentadas pelas evidências do turno.
     *
     * UM julgamento por resposta, com múltiplas afirmações no mesmo contexto (ADR-010 §6):
     * medido em 13,1s contra 22,0s de quatro chamadas separadas. A decomposição em afirmações e
     * a etapa de aplicabilidade acontecem dentro da mesma chamada — não há segundo LLM para isso.
     *
     * Orçamento derivado por getBudgetAuxiliar, perfil `validacao` (ADR-010 §8) — nenhuma
     * constante de timeout nova. Sem medição de latência, o mecanismo devolve o padrão do perfil
     * e declara que é padrão.
     *
     * FAIL-CLOSED, ao contrário de validateResponseCommit(): timeout, erro, provedor indisponível
     * e saída estruturalmente inválida produzem `UNVALIDATED` — que NÃO autoriza entrega. Timeout
     * nunca vira REJECTED nem NOT_EVALUABLE: não houve conclusão, e só UNVALIDATED é revalidável
     * sem regerar a resposta (ADR-010 §9).
     */
    async validateGrounding(
        response: string,
        evidences: EvidenceItem[],
        signal?: AbortSignal,
        /** Só observabilidade (`[GROUNDING-TRACE]`): quem chama e em que fase. Não influencia o julgamento. */
        traceCtx?: GroundingTraceContext,
    ): Promise<GroundingVerdict> {
        const t0 = Date.now();
        const orcamento = this.providerFactory.getBudgetAuxiliar('validacao');
        const base = { budgetMs: orcamento.timeoutMs, budgetOrigin: orcamento.origem };

        // Fatos do julgamento para o log. A evidência vai INTEIRA (nada é cortado; se o conjunto não couber no teto do
        // motor, o resultado é UNVALIDATED — nunca um veredito sobre um pedaço).
        const evidenceFacts: GroundingEvidenceFact[] = evidences.map(e => ({
            id: e.id, tool: e.tool, inputChars: (e.input ?? '').length, outputChars: e.output.length, sentChars: e.output.length, truncated: false,
        }));
        const emit = (outcome: string, extra: Partial<GroundingTraceRecord> = {}): void => {
            ObserverValidator.traceGrounding({
                v: 1, phase: traceCtx?.phase ?? 'initial', traceId: traceCtx?.traceId, conversationId: traceCtx?.conversationId,
                goalId: traceCtx?.goalId, stepId: traceCtx?.stepId, stepDescription: traceCtx?.stepDescription, planGeneration: traceCtx?.planGeneration,
                outcome, elapsedMs: Date.now() - t0, budgetMs: orcamento.timeoutMs,
                responseChars: response.length, evidences: evidenceFacts, ...extra,
            }, response, evidences);
        };

        // Sem evidência não há afirmação derivada de ferramenta a verificar. Não é aprovação:
        // é o domínio de C1 não se aplicar (ADR-010 §10).
        if (evidences.length === 0 || !response.trim()) {
            emit('skipped_no_evidence', { state: 'NOT_APPLICABLE' });
            return { state: 'NOT_APPLICABLE', claims: [], reason: 'nenhuma evidência de ferramenta no turno', elapsedMs: 0, ...base };
        }

        // Troca M1/M2 (ADR-014, 09/10/2026): quem julga é o motor único, tipo `saida_contra_evidencia`. As regras do contrato
        // ADR-010 §5 (SUPPORTED só por determinação positiva; ausência de contradição não é suporte; o que o assistente
        // redigiu ou diz que fez não é dado obtido) são o checklist do descritor — e, diferente do juiz antigo, a citação
        // de cada veredito é CONFERIDA pelo código (o trecho tem de existir literalmente nas evidências). A resposta e as
        // evidências entram inteiras; sem veredito (modelo fora, prazo, saída inválida, acima do teto) vale UNVALIDATED,
        // que não autoriza entrega (ADR-010 §9).
        const blocoEvidencias = evidences
            .map(e => `[${e.id}] ferramenta=${e.tool}${e.input ? ` args=${e.input}` : ''}\n${e.output}`)
            .join('\n\n');
        try {
            const r = await obterMotor(this.providerFactory).validar<DecisaoDeGrounding>(TIPO_SAIDA_CONTRA_EVIDENCIA, {
                pedido: traceCtx?.userRequest?.trim() || undefined, resposta: response, evidencias: blocoEvidencias,
            }, { traceId: traceCtx?.traceId, conversationId: traceCtx?.conversationId, goalId: traceCtx?.goalId, stepId: traceCtx?.stepId, phase: traceCtx?.phase ?? 'initial', signal });
            if (r.semVeredito) {
                const porque = r.veredito.naoAvaliavelPorque ?? 'n/d';
                log.warn(`[GROUNDING] juiz não concluiu (${porque.slice(0, 80)}) — UNVALIDATED`);
                // O caminho de saída do trace sai do desfecho ESTRUTURADO do motor (nunca de leitura de texto).
                const outcome = r.desfecho === 'saida_invalida' ? 'malformed_judge_output' : r.desfecho === 'acima_do_teto' ? 'prompt_too_long' : r.desfecho === 'erro' ? 'judge_error' : 'judge_failed';
                emit(outcome, { state: 'UNVALIDATED', judgeError: porque.slice(0, 120), judgeRaw: r.saidaBruta, judgeOutputChars: r.saidaBruta?.length });
                return { state: 'UNVALIDATED', claims: [], reason: `juiz não concluiu: ${porque.slice(0, 120)}`, elapsedMs: Date.now() - t0, ...base, avaliacaoId: r.veredito.avaliacaoId };
            }
            const { state, claims } = r.adaptado;
            emit('verdict', {
                state,
                claims: claims.map(c => ({ claim: c.claim.slice(0, 200), verdict: c.verdict, evidence: c.evidence })),
                claimCounts: ObserverValidator.countClaims(claims),
                judgeRaw: r.saidaBruta, judgeOutputChars: r.saidaBruta?.length,
            });
            return { state, claims, reason: ObserverValidator.describeGrounding(state, claims), elapsedMs: Date.now() - t0, ...base, avaliacaoId: r.veredito.avaliacaoId };
        } catch (err) {
            // Timeout, abort, erro de rede, provedor/modelo indisponível — todos significam a
            // mesma coisa: o juiz não concluiu. Nunca é aprovação (ADR-010 §9).
            log.warn(`[GROUNDING] juiz não concluiu (${String(err).slice(0, 80)}) — UNVALIDATED`);
            emit('judge_error', { state: 'UNVALIDATED', judgeError: String(err).slice(0, 120) });
            return { state: 'UNVALIDATED', claims: [], reason: `juiz não concluiu: ${String(err).slice(0, 120)}`, elapsedMs: Date.now() - t0, ...base };
        }
    }

    private static countClaims(claims: GroundedClaim[]): { SUPPORTED: number; NOT_SUPPORTED: number; NOT_EVALUABLE: number } {
        return {
            SUPPORTED: claims.filter(c => c.verdict === 'SUPPORTED').length,
            NOT_SUPPORTED: claims.filter(c => c.verdict === 'NOT_SUPPORTED').length,
            NOT_EVALUABLE: claims.filter(c => c.verdict === 'NOT_EVALUABLE').length,
        };
    }

    /** Emite `[GROUNDING-TRACE]` (ver o bloco de tipos no topo do arquivo). Nunca lança. */
    private static traceGrounding(rec: GroundingTraceRecord, response: string, evidences: EvidenceItem[]): void {
        // Limite só do TEXTO QUE VAI PARA O LOG — nunca do que o juiz recebe (a resposta entra inteira no prompt).
        const capForLog = (text: string, limit: number): string => text.slice(0, limit);
        try {
            const out: Record<string, unknown> = { ...rec, responseHash: createHash('sha1').update(response).digest('hex').slice(0, 8) };
            delete out.judgeRaw;
            if (process.env.TRACE_CONTENT === 'true') {
                out.responseText = capForLog(response, 6000);
                out.evidenceSent = evidences.map(e => ({
                    id: e.id, tool: e.tool,
                    input: capForLog(e.input ?? '', 200),
                    output: capForLog(e.output, TRACE_EVIDENCE_LOG_CHARS),
                }));
                if (rec.judgeRaw !== undefined) out.judgeRaw = capForLog(rec.judgeRaw, 4000);
            }
            log.info('[GROUNDING-TRACE] ' + JSON.stringify(out));
        } catch { /* observabilidade nunca pode afetar o julgamento */ }
    }

    private static describeGrounding(state: GroundingState, claims: GroundedClaim[]): string {
        const falha = claims.find(c => c.verdict === 'NOT_SUPPORTED') ?? claims.find(c => c.verdict === 'NOT_EVALUABLE');
        const total = `${claims.length} afirmação(ões)`;
        return falha ? `${state}: ${total}; primeira não sustentada: "${falha.claim.slice(0, 120)}"` : `${state}: ${total}`;
    }
}