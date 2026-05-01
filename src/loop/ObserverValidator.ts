/**
 * ObserverValidator — LLM-based post-execution quality checker
 * Uses a fast model (qwen3.5:cloud) to validate responses
 * Only runs when tools are executed, not for simple conversations
 */

import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Observervalidator');

export interface ValidationResult {
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
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

export class ObserverValidator {
    private observerModel: string;
    private providerFactory: ProviderFactory;

    constructor(providerFactory: ProviderFactory, observerModel: string = 'qwen3.5:cloud') {
        this.providerFactory = providerFactory;
        this.observerModel = observerModel;
    }

    async validate(
        userMessage: string,
        intent: string,
        toolUsed: string,
        toolResult: string,
        finalResponse: string
    ): Promise<ValidationResult> {
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
                log.info(`No JSON found in response, assuming approved. Elapsed: ${elapsed}ms`);
                return { approved: true, reason: 'Observer returned non-JSON, assuming OK', confidence: 0.5 };
            }

            const result = JSON.parse(jsonMatch[0]);
            log.info(`${result.approved ? '✅' : '❌'} approved=${result.approved} confidence=${result.confidence} reason="${result.reason}" elapsed=${elapsed}ms`);

            return {
                approved: !!result.approved,
                reason: result.reason || '',
                confidence: Number(result.confidence) || 0.5,
                suggestedFix: result.suggested_fix || result.suggestedFix || undefined
            };
        } catch (error: any) {
            log.info(`Error: ${error.message}, assuming approved`);
            return { approved: true, reason: 'Observer failed, assuming OK', confidence: 0.3 };
        }
    }
}