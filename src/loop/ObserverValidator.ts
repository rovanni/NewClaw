/**
 * ObserverValidator — LLM-based post-execution quality checker
 * Uses a fast model (qwen3.5:cloud) to validate responses
 * Only runs when tools are executed, not for simple conversations
 */

import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { ANALYSIS_INTENT_PATTERN } from '../shared/analysisIntentPattern';
const log = createLogger('Observervalidator');

/**
 * Extrai o primeiro objeto JSON válido contendo a chave "approved" de um conteúdo arbitrário.
 * Usa contagem de chaves para lidar com objetos aninhados e strings com caracteres especiais —
 * o regex simples /\{[^}]*"approved"[^}]*\}/ quebrava ao encontrar `}` dentro de reason ou
 * ao receber o campo thinking do qwen3.5 como fallback de conteúdo.
 */
function extractApprovedJson(content: string): Record<string, unknown> | null {
    // Tentativa direta: conteúdo inteiro é JSON válido
    try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if ('approved' in parsed) return parsed;
    } catch { /* continua */ }

    // Varredura por objetos JSON via contagem de chaves
    let i = 0;
    while (i < content.length) {
        const start = content.indexOf('{', i);
        if (start === -1) break;
        let depth = 0;
        let inString = false;
        let escape = false;
        let j = start;
        while (j < content.length) {
            const ch = content[j];
            if (escape) { escape = false; j++; continue; }
            if (ch === '\\' && inString) { escape = true; j++; continue; }
            if (ch === '"') { inString = !inString; j++; continue; }
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            j++;
        }
        if (depth === 0) {
            const candidate = content.slice(start, j + 1);
            try {
                const parsed = JSON.parse(candidate) as Record<string, unknown>;
                if ('approved' in parsed) return parsed;
            } catch { /* tenta próximo */ }
        }
        i = start + 1;
    }
    return null;
}

export type FailureType = 'incomplete_response' | 'read_only' | 'future_action' | 'tool_error' | 'other' | 'none';

export interface ValidationResult {
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
    validationSkipped?: boolean;
    failureType?: FailureType;
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

export interface GroundingVerdict {
    state: GroundingState;
    claims: GroundedClaim[];
    /** motivo legível para log/auditoria — nunca vai ao usuário */
    reason: string;
    elapsedMs: number;
    /** de onde veio o orçamento de tempo (shared/auxTimeout.ts) */
    budgetMs: number;
    budgetOrigin: 'medido' | 'padrao';
}

const CLAIM_VERDICTS: ReadonlySet<string> = new Set<ClaimVerdict>(['SUPPORTED', 'NOT_SUPPORTED', 'NOT_EVALUABLE']);

/**
 * Teto de caracteres do prompt do juiz. Não é limite de estilo nem economia de tokens: é a
 * fronteira a partir da qual deixa de ser possível AFIRMAR que o juiz recebeu a resposta inteira.
 *
 * A resposta NUNCA é truncada para caber aqui. Truncar produziria um veredito sobre um prefixo,
 * e esse veredito viraria `VALIDATED` sobre um texto que ninguém avaliou — o vazamento fail-open
 * que a ADR-010 §10 fecha ao exigir que só o avaliado seja entregue. Acima do teto o resultado é
 * `UNVALIDATED`: o juiz não concluiu sobre a resposta que seria entregue.
 *
 * Derivação: o menor contexto que o projeto assume em runtime é o padrão de `OLLAMA_NUM_CTX`
 * (32768 tokens — `OllamaProvider`), e num_ctx cobre entrada + saída. A ~3 chars/token em pt-BR
 * são ~98k chars no total; reservando a saída (o JSON de vereditos) e margem para a instrução,
 * o teto de ENTRADA fica em 60k. Conservador de propósito: errar para o lado do bloqueio é o
 * comportamento pedido nesta implementação.
 */
const GROUNDING_MAX_PROMPT_CHARS = 60_000;

// O contrato do juiz é o da ADR-010 §5, enunciado em termos gerais: nenhuma menção a ferramenta,
// domínio, unidade ou idioma. O exemplo de unidade indeterminada existe para tornar concreta a
// regra "ausência de contradição não é suporte" — é ilustração, não regra especial (ADR-010 §5).
//
// Duas lacunas fechadas aqui (16/08/2026, achado real — conversão de moeda bloqueada
// repetidamente): a agregação é tudo-ou-nada (`aggregateGrounding` — QUALQUER claim
// NOT_EVALUABLE derruba a resposta inteira), então uma categoria de claim mal-coberta pelo
// prompt bloqueia respostas onde tudo o mais está correto.
//
// 1. "transformação determinística" listava arredondamento/unidade/reformatação/tradução/
//    omissão de campos, mas não aritmética — então "evidência: 1 USD = R$5,19" + pergunta
//    "quanto é 9 dólares?" + resposta "R$46,71" virava NOT_EVALUABLE: nem o "9" nem o "46,71"
//    aparecem literalmente na evidência, e nenhuma das transformações listadas cobre combinar
//    um valor da evidência com um número de outra parte do contexto via operação aritmética.
// 2. Fatos triviais independentes de qualquer evidência (dia da semana de uma data, por
//    exemplo) também caíam em NOT_EVALUABLE — nenhuma evidência de ferramenta "trata do
//    assunto" porque nenhuma precisa tratar: não é um fato que dependa de fonte externa.
const GROUNDING_PROMPT = `Você verifica quais afirmações de uma RESPOSTA são sustentadas pelas EVIDÊNCIAS.

EVIDÊNCIAS:
{evidences}

RESPOSTA:
"""
{response}
"""

Para CADA afirmação factual da resposta, indique quais evidências a sustentam e o veredito.

- SUPPORTED: a evidência DETERMINA POSITIVAMENTE a afirmação — está presente nela, ou é obtida
  dela por transformação determinística (arredondamento, mudança de unidade declarada,
  reformatação, tradução, omissão de campos, ou cálculo aritmético — soma, subtração,
  multiplicação, divisão — que combina um valor da evidência com um número explícito em outra
  parte do contexto, como a pergunta do usuário).
- NOT_SUPPORTED: a evidência determina que a afirmação é falsa — contradiz, ou atribui o valor a
  um papel/entidade/momento diferente, ou acrescenta um fato que a evidência enumera e não contém.
- NOT_EVALUABLE: a evidência não determina a afirmação — não trata do assunto, é ambígua, é
  conflitante, ou não enumera a dimensão de que a afirmação fala.

REGRA CRÍTICA: ausência de contradição NÃO é suporte. Se a evidência não determina a afirmação,
o veredito é NOT_EVALUABLE, nunca SUPPORTED. Exemplo: evidência "X: 25" e afirmação "X está a
25°C" — o número aparece, mas a unidade não está determinada, então NÃO é SUPPORTED.

Opinião, recomendação, cortesia, comentário sobre o que você fez, e fato verificável por si só
sem depender de nenhuma fonte externa (ex: dia da semana correspondente a uma data, resultado de
um cálculo já classificado acima) não são afirmações que dependam de evidência — não os inclua.
Se a resposta não contiver nenhuma afirmação factual derivada das evidências, devolva a lista
vazia.

Responda APENAS com JSON:
{"claims":[{"claim":"...","evidence":["E1"],"verdict":"SUPPORTED|NOT_SUPPORTED|NOT_EVALUABLE"}]}`;

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
{"approved": true/false, "reason": "explicação curta", "confidence": 0.0-1.0, "suggested_fix": "ação sugerida caso não aprovado", "failure_type": "incomplete_response | read_only | future_action | tool_error | other | none"}`;

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

    constructor(providerFactory: ProviderFactory, observerModel: string = process.env.OBSERVER_MODEL || 'qwen3.5:cloud') {
        this.providerFactory = providerFactory;
        this.observerModel = observerModel;
    }

    setModel(model: string): void {
        if (model) this.observerModel = model;
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

            // Extrai o primeiro objeto JSON válido que contenha "approved" no conteúdo.
            // O regex simples [^}]* quebrava com objetos aninhados ou reason com aspas.
            // Aqui fazemos parse incremental por contagem de chaves para resistir a conteúdo complexo.
            const result = extractApprovedJson(content);
            if (!result) {
                log.warn(`No JSON found in response, skipping validation. Elapsed: ${elapsed}ms`);
                return { approved: false, reason: 'Observer returned non-JSON', confidence: 0, validationSkipped: true };
            }
            const conf = Number(result['confidence']) || 0.5;
            const llmPath = conf >= 0.7 ? 'llm_high_confidence' : 'llm_low_confidence';
            log.info(`${result['approved'] ? '✅' : '❌'} approved=${result['approved']} confidence=${conf} reason="${result['reason']}" elapsed=${elapsed}ms`);
            log.info('GOAL_VALIDATION_PATH',
                `validation_path=${llmPath} tool=${toolUsed}` +
                ` approved=${result['approved']} confidence=${conf} elapsed_ms=${elapsed}`
            );

            return {
                approved: !!result['approved'],
                reason: String(result['reason'] || ''),
                confidence: conf,
                suggestedFix: String(result['suggested_fix'] || result['suggestedFix'] || '') || undefined,
                failureType: (result['failure_type'] as FailureType) || 'other'
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

        const llmResult = await this.validate(userMessage, userMessage, toolUsed, toolResult, finalResponse, signal);
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
    ): Promise<GroundingVerdict> {
        const t0 = Date.now();
        const orcamento = this.providerFactory.getBudgetAuxiliar('validacao');
        const base = { budgetMs: orcamento.timeoutMs, budgetOrigin: orcamento.origem };

        // Sem evidência não há afirmação derivada de ferramenta a verificar. Não é aprovação:
        // é o domínio de C1 não se aplicar (ADR-010 §10).
        if (evidences.length === 0 || !response.trim()) {
            return { state: 'NOT_APPLICABLE', claims: [], reason: 'nenhuma evidência de ferramenta no turno', elapsedMs: 0, ...base };
        }

        // A EVIDÊNCIA é truncada; a RESPOSTA nunca é. A assimetria é o ponto:
        //
        // - Evidência cortada só empurra o veredito para NOT_EVALUABLE (o juiz deixa de ver o
        //   trecho que determinaria a afirmação) — direção que BLOQUEIA. E o corte é MARCADO,
        //   porque a ADR-010 §5 manda tratar evidência enumerativa/fechada como NOT_SUPPORTED
        //   quando a afirmação acrescenta item ausente, e um output cortado no meio parece
        //   exatamente uma lista fechada; sem a marca, evidência incompleta viraria determinação
        //   de falsidade sobre resposta correta.
        // - Resposta cortada empurra para o lado oposto: o juiz aprova o prefixo, o usuário
        //   recebe o texto inteiro, e o excedente vai entregue como se tivesse sido verificado.
        //   Isso é fail-open e não tem marca que conserte — o juiz não julga o que não recebeu.
        //
        // Por isso a resposta entra inteira e, se o conjunto não couber, o resultado é
        // UNVALIDATED (abaixo), nunca um julgamento parcial.
        const EVIDENCIA_CHARS = 2000, ARGS_CHARS = 200;
        const corta = (texto: string, limite: number, marca: string): string =>
            texto.length > limite ? `${texto.slice(0, limite)}\n${marca}` : texto;

        const blocoEvidencias = evidences.map(e =>
            `[${e.id}] ferramenta=${e.tool}${e.input ? ` args=${corta(e.input, ARGS_CHARS, '…[ARGS TRUNCADOS]')}` : ''}\n` +
            corta(e.output, EVIDENCIA_CHARS, '…[EVIDÊNCIA TRUNCADA — o texto acima está incompleto; não a trate como lista completa]')
        ).join('\n\n');

        // Substituição por FUNÇÃO, não por string: numa string de substituição, `$&`, `$\``,
        // `$'` e `$$` são padrões — e evidência real carrega cifrão (preço de ativo, variável de
        // shell). Com string, um `$&` no output do tool reescreveria o prompt do juiz.
        const prompt = GROUNDING_PROMPT
            .replace('{evidences}', () => blocoEvidencias)
            .replace('{response}', () => response);

        // Não cabe → não foi avaliado → UNVALIDATED. Nunca truncar para caber, nunca deixar o
        // provedor cortar em silêncio e devolver veredito sobre um prefixo.
        if (prompt.length > GROUNDING_MAX_PROMPT_CHARS) {
            log.warn(`[GROUNDING] prompt de ${prompt.length} chars excede ${GROUNDING_MAX_PROMPT_CHARS} — UNVALIDATED`);
            return {
                state: 'UNVALIDATED', claims: [],
                reason: `resposta não avaliável integralmente: prompt de ${prompt.length} chars excede o teto de ${GROUNDING_MAX_PROMPT_CHARS}`,
                elapsedMs: Date.now() - t0, ...base,
            };
        }

        const controller = new AbortController();
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), orcamento.timeoutMs);

        try {
            const llm = await this.providerFactory
                .getProviderWithModel(this.observerModel)
                .chat([{ role: 'user', content: prompt }], undefined, { signal: controller.signal, timeoutMs: orcamento.timeoutMs });

            const parsed = this.parseGroundingOutput(llm.content || '', evidences);
            if (!parsed) {
                log.warn(`[GROUNDING] saída do juiz sem estrutura válida — UNVALIDATED`);
                return { state: 'UNVALIDATED', claims: [], reason: 'saída do juiz estruturalmente inválida', elapsedMs: Date.now() - t0, ...base };
            }

            const state = ObserverValidator.aggregateGrounding(parsed);
            return { state, claims: parsed, reason: ObserverValidator.describeGrounding(state, parsed), elapsedMs: Date.now() - t0, ...base };
        } catch (err) {
            // Timeout, abort, erro de rede, provedor/modelo indisponível — todos significam a
            // mesma coisa: o juiz não concluiu. Nunca é aprovação (ADR-010 §9).
            log.warn(`[GROUNDING] juiz não concluiu (${String(err).slice(0, 80)}) — UNVALIDATED`);
            return { state: 'UNVALIDATED', claims: [], reason: `juiz não concluiu: ${String(err).slice(0, 120)}`, elapsedMs: Date.now() - t0, ...base };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onOuterAbort);
        }
    }

    /**
     * Validação ESTRUTURAL da saída do juiz (ADR-010 §16) — determinística, sem interpretação
     * semântica. Devolve null para qualquer desvio de forma; o chamador trata como UNVALIDATED.
     * Uma saída malformada nunca é "consertada": não há como saber o que o juiz quis dizer.
     */
    private parseGroundingOutput(content: string, evidences: EvidenceItem[]): GroundedClaim[] | null {
        const cleaned = content.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) return null;

        let raw: unknown;
        try { raw = JSON.parse(match[0]); } catch { return null; }
        if (!raw || typeof raw !== 'object') return null;

        const lista = (raw as { claims?: unknown }).claims;
        if (!Array.isArray(lista)) return null;

        const idsValidos = new Set(evidences.map(e => e.id));
        const out: GroundedClaim[] = [];
        for (const item of lista) {
            if (!item || typeof item !== 'object') return null;
            const o = item as Record<string, unknown>;
            const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
            const verdict = typeof o.verdict === 'string' ? o.verdict.toUpperCase() : '';
            if (!claim || !CLAIM_VERDICTS.has(verdict)) return null;

            const brutos = Array.isArray(o.evidence) ? o.evidence
                : typeof o.evidence === 'string' && o.evidence ? [o.evidence]
                : [];
            const evidence = brutos
                .filter((x): x is string => typeof x === 'string')
                .map(x => x.trim())
                .filter(x => idsValidos.has(x));

            // Um id inexistente é invenção do juiz sobre a própria proveniência — não pode
            // sustentar SUPPORTED. Rebaixa para NOT_EVALUABLE em vez de descartar o julgamento.
            const inventou = brutos.length > 0 && evidence.length === 0;
            out.push({
                claim,
                evidence,
                verdict: (inventou && verdict === 'SUPPORTED') ? 'NOT_EVALUABLE' : verdict as ClaimVerdict,
            });
        }
        return out;
    }

    /**
     * Agregação determinística por afirmação → estado da resposta (ADR-010 §5, §10).
     * Precedência: REJECTED > NOT_EVALUABLE > VALIDATED. Uma violação demonstrada é conclusão
     * mais forte que uma indeterminação, e qualquer indeterminação impede afirmar groundedness.
     */
    static aggregateGrounding(claims: GroundedClaim[]): GroundingState {
        if (claims.length === 0) return 'NOT_APPLICABLE';
        if (claims.some(c => c.verdict === 'NOT_SUPPORTED')) return 'REJECTED';
        if (claims.some(c => c.verdict === 'NOT_EVALUABLE')) return 'NOT_EVALUABLE';
        return 'VALIDATED';
    }

    private static describeGrounding(state: GroundingState, claims: GroundedClaim[]): string {
        const falha = claims.find(c => c.verdict === 'NOT_SUPPORTED') ?? claims.find(c => c.verdict === 'NOT_EVALUABLE');
        const total = `${claims.length} afirmação(ões)`;
        return falha ? `${state}: ${total}; primeira não sustentada: "${falha.claim.slice(0, 120)}"` : `${state}: ${total}`;
    }
}