/**
 * ObserverValidator — LLM-based post-execution quality checker
 * Uses a fast model (qwen3.5:cloud) to validate responses
 * Only runs when tools are executed, not for simple conversations
 */

import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('Observervalidator');

export interface ValidationResult {
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
    validationSkipped?: boolean;
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
}

const OBSERVER_PROMPT = `Você é um agente observador responsável por validar a qualidade das ações de um assistente virtual.

Analise as informações abaixo:

1. Solicitação do usuário:
"{userMessage}"

2. Intenção identificada:
{intent}

3. Ferramenta executada:
{toolUsed}

4. Resultado da ferramenta:
{toolResult}

5. Resposta final ao usuário:
"{finalResponse}"

Avalie se a ação executada está correta e se a resposta atende plenamente à solicitação do usuário.

Responda APENAS em JSON:
{"approved": true/false, "reason": "explicação curta", "confidence": 0.0-1.0, "suggested_fix": "ação sugerida caso não aprovado"}`;

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
    private observerModel: string;
    private providerFactory: ProviderFactory;

    constructor(providerFactory: ProviderFactory, observerModel: string = 'qwen3.5:cloud') {
        this.providerFactory = providerFactory;
        this.observerModel = observerModel;
    }

    // ── Deterministic pre-check (no LLM) ─────────────────────────────────────

    private deterministicCheck(
        toolUsed: string,
        toolResult: string,
        finalResponse: string
    ): ValidationResult | null {

        // 1. Tool returned an explicit error or empty result
        if (TOOL_ERROR_PATTERN.test(toolResult.trim()) || toolResult.trim().length < 3) {
            return { approved: false, reason: 'Ferramenta retornou erro ou resultado vazio', confidence: 0.95, suggestedFix: 'Tentar abordagem alternativa' };
        }

        // 2. No final response yet (inline call before loop finishes) — skip LLM
        if (!finalResponse || finalResponse.trim().length < 15) {
            return { approved: true, reason: 'Ferramenta executou com saída disponível (resposta ainda não gerada)', confidence: 0.6, validationSkipped: true };
        }

        // 3. Final response is clearly an error or refusal
        if (/^(desculp|lament|infelizmente|não (consig|poss)|sorry|I (can't|cannot))/i.test(finalResponse.trim().slice(0, 60))) {
            return { approved: false, reason: 'Resposta final indica falha ou recusa', confidence: 0.85, suggestedFix: 'Verificar disponibilidade da ferramenta ou usar alternativa' };
        }

        // 4. Known-good tool + valid result + adequate response
        for (const rule of KNOWN_GOOD_TOOLS) {
            const toolMatches = typeof rule.tool === 'string' ? toolUsed === rule.tool : rule.tool.test(toolUsed);
            if (toolMatches && rule.resultPattern.test(toolResult) && finalResponse.length >= rule.minResponseLen) {
                return { approved: true, reason: rule.reason, confidence: rule.confidence };
            }
        }

        // No deterministic conclusion — fall through to LLM
        return null;
    }

    /**
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
    ): Promise<ValidationResult> {
        // Try deterministic check first — avoids LLM entirely for obvious cases
        const deterministic = this.deterministicCheck(toolUsed, toolResult, finalResponse);
        if (deterministic) {
            const tag = deterministic.validationSkipped ? '⏭️ skipped' : deterministic.approved ? '✅' : '❌';
            log.info(`${tag} [DETERMINISTIC] approved=${deterministic.approved} confidence=${deterministic.confidence} reason="${deterministic.reason}"`);
            return deterministic;
        }

        if (signal?.aborted) {
            return { approved: true, reason: 'Validation cancelled before LLM call', confidence: 0, validationSkipped: true };
        }

        const prompt = OBSERVER_PROMPT
            .replace('{userMessage}', userMessage.slice(0, 500))
            .replace('{intent}', intent)
            .replace('{toolUsed}', toolUsed)
            .replace('{toolResult}', toolResult.slice(0, 1000))
            .replace('{finalResponse}', finalResponse.slice(0, 500));

        const messages: LLMMessage[] = [
            { role: 'system', content: 'Você é um validador de qualidade. Responda APENAS com JSON válido.' },
            { role: 'user', content: prompt }
        ];

        try {
            const startTime = Date.now();
            const response = await this.providerFactory.getProviderWithModel(this.observerModel).chat(messages, undefined, { signal });
            const elapsed = Date.now() - startTime;

            // If the signal aborted while the LLM was running, discard the result silently.
            // This prevents the orphaned "approved=false" log that appears after the timeout
            // already fired and the turn has ended — confusing but actionless.
            if (signal?.aborted) {
                log.info(`[OBSERVER] Result discarded — signal aborted after ${elapsed}ms (post-turn advisory window closed)`);
                return { approved: true, reason: 'Validation result discarded after abort', confidence: 0, validationSkipped: true };
            }

            const content = (response.content || '').trim();

            // Extract JSON from response
            const jsonMatch = content.match(/\{[^}]*"approved"[^}]*\}/s);
            if (!jsonMatch) {
                log.warn(`No JSON found in response, skipping validation. Elapsed: ${elapsed}ms`);
                return { approved: false, reason: 'Observer returned non-JSON', confidence: 0, validationSkipped: true };
            }

            const result = JSON.parse(jsonMatch[0]);
            log.info(`${result.approved ? '✅' : '❌'} approved=${result.approved} confidence=${result.confidence} reason="${result.reason}" elapsed=${elapsed}ms`);

            return {
                approved: !!result.approved,
                reason: result.reason || '',
                confidence: Number(result.confidence) || 0.5,
                suggestedFix: result.suggested_fix || result.suggestedFix || undefined
            };
        } catch (error) {
            if (signal?.aborted) {
                return { approved: true, reason: 'Validation aborted', confidence: 0, validationSkipped: true };
            }
            log.warn(`Validation error: ${errorMessage(error)}, skipping`);
            return { approved: false, reason: `Observer error: ${errorMessage(error)}`, confidence: 0, validationSkipped: true };
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
                correctedResponse: blocked
                    ? this.buildCorrectedResponse(deterministic.reason, deterministic.suggestedFix)
                    : undefined,
                validationMs: elapsed,
            };
        }

        // ── Verificação via LLM (casos ambíguos) ──────────────────────────
        if (signal?.aborted) {
            return { valid: true, hallucinationRisk: 0, blocked: false, validationMs: Date.now() - t0 };
        }

        const llmResult = await this.validate(userMessage, userMessage, toolUsed, toolResult, finalResponse, signal);
        const elapsed = Date.now() - t0;

        if (llmResult.approved || llmResult.validationSkipped) {
            return { valid: true, hallucinationRisk: Math.max(0, 1 - llmResult.confidence) * 0.5, blocked: false, validationMs: elapsed };
        }

        const hallucinationRisk = llmResult.confidence;
        const blocked = hallucinationRisk >= 0.7;
        return {
            valid: false,
            hallucinationRisk,
            blocked,
            blockReason: llmResult.reason,
            correctedResponse: blocked
                ? this.buildCorrectedResponse(llmResult.reason, llmResult.suggestedFix)
                : undefined,
            validationMs: elapsed,
        };
    }

    private buildCorrectedResponse(reason: string, suggestedFix?: string): string {
        const base = 'Não consegui completar esta ação corretamente.';
        if (reason) {
            return `${base} ${reason}.${suggestedFix ? ` ${suggestedFix}.` : ' Tente reformular a solicitação ou use uma abordagem diferente.'}`;
        }
        return `${base} Tente reformular a solicitação ou use uma abordagem diferente.`;
    }
}