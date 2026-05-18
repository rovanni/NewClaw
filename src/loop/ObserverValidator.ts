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
        if (/^(desculp|lament|não (consig|poss)|sorry|I (can't|cannot))/i.test(finalResponse.trim().slice(0, 60))) {
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

    async validate(
        userMessage: string,
        intent: string,
        toolUsed: string,
        toolResult: string,
        finalResponse: string
    ): Promise<ValidationResult> {
        // Try deterministic check first — avoids LLM entirely for obvious cases
        const deterministic = this.deterministicCheck(toolUsed, toolResult, finalResponse);
        if (deterministic) {
            const tag = deterministic.validationSkipped ? '⏭️ skipped' : deterministic.approved ? '✅' : '❌';
            log.info(`${tag} [DETERMINISTIC] approved=${deterministic.approved} confidence=${deterministic.confidence} reason="${deterministic.reason}"`);
            return deterministic;
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
            const response = await this.providerFactory.getProviderWithModel(this.observerModel).chat(messages);
            const elapsed = Date.now() - startTime;

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
            log.warn(`Validation error: ${errorMessage(error)}, skipping`);
            return { approved: false, reason: `Observer error: ${errorMessage(error)}`, confidence: 0, validationSkipped: true };
        }
    }
}