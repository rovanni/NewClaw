/**
 * ProviderFactory — Troca dinâmica de LLMs
 * Suporta: Gemini, DeepSeek, Groq, OpenAI, OpenRouter, Anthropic, Ollama
 */

import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { circuitRegistry } from './CircuitBreaker';
import { getLocalRuntimeLifecycle } from './localRuntimeState';
import { LLMMessage, LLMResponse, ToolDefinition, LLMResult, AttemptInfo, FallbackReason, ToolCall, ILLMProvider, ChatOptions, CustomProviderConfig, SubstitutionPolicy, DEFAULT_SUBSTITUTION_POLICY, isSubstitutionPolicy, ChatFallbackOptions } from './providerTypes';
import { GeminiProvider } from './GeminiProvider';
import { DeepSeekProvider } from './DeepSeekProvider';
import { GroqProvider } from './GroqProvider';
import { getBudgetAuxiliar, PerfilAuxiliar, OrcamentoAuxiliar } from '../shared/auxTimeout';
import { OpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
import { OllamaProvider } from './OllamaProvider';
import { AnthropicProvider } from './AnthropicProvider';

// Nomes reservados pelos providers nativos — um customProvider com label colidente seria
// silenciosamente sobrescrito no Map (ou sobrescreveria o nativo, dependendo da ordem de
// registro), confundindo getFallbackOrder() e updateCredential()/removeCredential(). Ver
// addCustomProvider() abaixo.
//
// Exportado (campanha "Ollama API error: 404", Fase 3, S264): é a mesma lista, por valor, que
// `ModelProfileRegistry` precisa pra saber se um provider herdado é nativo (nunca serve arquivo
// de modelo local) antes de invalidar um par (modelo, provider) impossível — evita uma 3ª cópia
// do mesmo conjunto de 6 nomes (a 2ª já existe em getFallbackOrder(), por necessidade de ordem).
export const RESERVED_PROVIDER_NAMES = new Set(['gemini', 'deepseek', 'groq', 'openrouter', 'anthropic', 'ollama']);

// Re-export everything so all existing imports continue to work unchanged
export type { LLMMessage, LLMResponse, ToolCall, ToolDefinition, FallbackReason, AttemptInfo, LLMResult, MetricsSummary, ILLMProvider, ChatOptions, StreamChunk, SubstitutionPolicy } from './providerTypes';
export { TaskPriority } from './providerQueue';
export { GeminiProvider } from './GeminiProvider';
export { DeepSeekProvider } from './DeepSeekProvider';
export { GroqProvider } from './GroqProvider';
export { OpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
export { OllamaProvider } from './OllamaProvider';
export { AnthropicProvider } from './AnthropicProvider';

const log = createLogger('Providerfactory');

export class ProviderFactory {
    private providers: Map<string, ILLMProvider> = new Map();
    // Config original de cada provider custom registrado, guardada pelo mesmo motivo que `creds`
    // guarda as chaves dos nativos: getProviderWithModel() precisa CRIAR uma instância nova por
    // requisição (com outro modelo) sem mutar a instância compartilhada do Map. Sem isto não há
    // como reconstruir um OpenAIProvider — baseUrl/apiKey são privados na instância.
    private customConfigs: Map<string, CustomProviderConfig> = new Map();
    private defaultProvider: string;
    public readonly circuitBreakers: typeof circuitRegistry;
    // Credenciais guardadas para criar instâncias per-model sem mutar o provider compartilhado
    private creds: {
        geminiKey?: string;
        deepseekKey?: string;
        groqKey?: string;
        openrouterKey?: string;
        anthropicKey?: string;
        ollamaUrl: string;
        ollamaModel?: string;
        ollamaApiKey: string;
    };

    constructor(config: {
        geminiKey?: string;
        deepseekKey?: string;
        groqKey?: string;
        openrouterKey?: string;
        anthropicKey?: string;
        ollamaUrl?: string;
        ollamaModel?: string;
        ollamaApiKey?: string;
        defaultProvider: string;
        customProviders?: CustomProviderConfig[];
    }) {
        this.defaultProvider = config.defaultProvider || 'gemini';
        this.circuitBreakers = circuitRegistry;
        this.creds = {
            geminiKey:      config.geminiKey,
            deepseekKey:    config.deepseekKey,
            groqKey:        config.groqKey,
            openrouterKey:  config.openrouterKey,
            anthropicKey:   config.anthropicKey,
            ollamaUrl:      config.ollamaUrl      || 'http://localhost:11434',
            ollamaApiKey:   config.ollamaApiKey   || '',
            // Guardado para responder "qual modelo?" quando quem chama não especifica — ver
            // getProviderWithModel(). Antes só a instância compartilhada do Map sabia disso.
            ollamaModel:    config.ollamaModel    || '',
        };

        if (config.geminiKey)      this.providers.set('gemini',      new GeminiProvider(config.geminiKey));
        if (config.deepseekKey)    this.providers.set('deepseek',    new DeepSeekProvider(config.deepseekKey));
        if (config.groqKey)        this.providers.set('groq',        new GroqProvider(config.groqKey));
        if (config.openrouterKey)  this.providers.set('openrouter',  new OpenRouterProvider(config.openrouterKey));
        if (config.anthropicKey)   this.providers.set('anthropic',   new AnthropicProvider(config.anthropicKey));

        this.providers.set('ollama', new OllamaProvider(
            config.ollamaUrl || 'http://localhost:11434',
            config.ollamaModel || 'glm-5.2:cloud',
            config.ollamaApiKey || ''
        ));

        // Providers custom (LM Studio, vLLM, llamafile local etc.) — registrados por ÚLTIMO,
        // depois dos nativos, então uma label colidente com um nome reservado é logada e
        // ignorada em vez de sobrescrever silenciosamente o provider nativo correspondente.
        // Como não entram em getFallbackOrder()'s lista fixa (linha ~471), caem naturalmente
        // em "remaining" — último recurso do fallback automático, exatamente o comportamento
        // desejado (tenta Ollama/cloud primeiro, só usa o modelo local se tudo mais falhar).
        for (const custom of config.customProviders ?? []) {
            this.registerCustomProvider(custom);
        }
    }

    /** Retorna true se o provider foi de fato registrado (false = label vazia ou colidente). */
    private registerCustomProvider(custom: CustomProviderConfig): boolean {
        if (!custom.label?.trim() || !custom.baseUrl?.trim()) return false;
        if (RESERVED_PROVIDER_NAMES.has(custom.label)) {
            log.warn(`Custom provider "${custom.label}" ignorado — nome reservado por um provider nativo`);
            return false;
        }
        this.providers.set(custom.label, new OpenAIProvider(custom.apiKey || '', custom.model || 'default', custom.baseUrl, custom.label));
        this.customConfigs.set(custom.label, { ...custom });
        return true;
    }

    getProvider(name?: string): ILLMProvider {
        const providerName = name || this.defaultProvider;
        const provider = this.providers.get(providerName);
        if (!provider) {
            const first = this.providers.values().next().value;
            if (first) return first;
            throw new Error('Nenhum provider disponível. Configure ao menos uma API key.');
        }
        return provider;
    }

    /**
     * Cria uma instância dedicada do provider ativo com o modelo especificado.
     * Respeita defaultProvider — Gemini, OpenRouter, Groq etc. recebem seu próprio
     * modelo em vez de sempre criar um OllamaProvider.
     * providerName opcional permite sobrescrever o provider para um perfil específico.
     */
    /**
     * Instância dedicada do provider alvo com um modelo específico.
     *
     * `model` é OPCIONAL desde 05/08/2026 (issue 019): quem chama sem modelo está dizendo "use o
     * que este provedor serve", e não "escolha um por mim". Antes, componentes internos
     * (planner, análise de risco, validador semântico, classificadores) traziam um nome de
     * modelo de NUVEM embutido como padrão — e esse nome era enviado ao provedor ATIVO, que numa
     * instalação só-local não o serve. Sintoma real: `START provider=Modelo local/gemma4:31b-cloud`
     * numa instância sem nenhum provedor de nuvem configurado.
     *
     * Quem sabe qual modelo um provedor serve é o próprio provedor — `custom.model` para os
     * OpenAI-compatible, `OLLAMA_MODEL` para o Ollama. A decisão mora aqui, não espalhada em `??`
     * por cinco arquivos.
     */
    getProviderWithModel(model?: string, providerName?: string): ILLMProvider {
        const target = providerName ?? this.defaultProvider;
        switch (target) {
            case 'openrouter':
                if (this.creds.openrouterKey)
                    return new OpenRouterProvider(this.creds.openrouterKey, model);
                break;
            case 'gemini':
                if (this.creds.geminiKey)
                    return new GeminiProvider(this.creds.geminiKey, model);
                break;
            case 'groq':
                if (this.creds.groqKey)
                    return new GroqProvider(this.creds.groqKey, model);
                break;
            case 'deepseek':
                if (this.creds.deepseekKey)
                    return new DeepSeekProvider(this.creds.deepseekKey, model);
                break;
            case 'anthropic':
                if (this.creds.anthropicKey)
                    return new AnthropicProvider(this.creds.anthropicKey, model);
                break;
        }

        // Provider custom (qualquer endpoint OpenAI-Compatible: LM Studio, vLLM, llamafile,
        // OpenAI oficial, servidor próprio). Sem este bloco, `target` não batia em nenhum `case`
        // acima e a requisição caía no `return new OllamaProvider(...)` abaixo — ou seja: eleger
        // um provider custom como principal mandava a chamada para o Ollama silenciosamente, e o
        // endpoint do usuário nunca era chamado. Como todo perfil do ModelProfileRegistry já
        // nasce com um modelo preenchido, `modelOverride` é sempre truthy e este caminho é o
        // único usado pelo provider primário em chatWithFallback() — o provider custom era
        // inalcançável na prática, mesmo estando corretamente registrado no Map.
        const custom = this.customConfigs.get(target);
        if (custom) {
            // `model` (a escolha por categoria do Model Router) vence a config fixa do provider,
            // mesma precedência dos nativos acima. `custom.model` é o default de quem hospeda um
            // modelo só e nunca escolheu nada por categoria; 'default' é o placeholder aceito por
            // servidores de modelo único (llamafile serve o .gguf carregado e ignora o campo).
            return new OpenAIProvider(custom.apiKey || '', model || custom.model || 'default', custom.baseUrl, custom.label);
        }

        // Ollama (padrão) ou fallback quando a key do provider alvo não está configurada.
        // Sem modelo pedido, usa o configurado pelo operador (OLLAMA_MODEL).
        return new OllamaProvider(this.creds.ollamaUrl, model || this.creds.ollamaModel || undefined, this.creds.ollamaApiKey);
    }

    getAvailableProviders(): string[] { return Array.from(this.providers.keys()); }
    getDefaultProvider(): string { return this.defaultProvider; }

    /**
     * Orçamento de tempo para uma chamada LLM auxiliar, derivado da latência que este provedor
     * de fato apresenta — ver shared/auxTimeout.ts para o porquê de não ser um número fixo.
     *
     * Mora aqui porque o ProviderFactory é quem sabe as duas coisas ao mesmo tempo: qual
     * provedor será tentado primeiro e quanto ele tem levado. Assim o ponto de chamada declara
     * só a intenção ("isto é uma classificação") e não precisa conhecer o registro de circuitos.
     */
    getBudgetAuxiliar(perfil: PerfilAuxiliar): OrcamentoAuxiliar {
        return getBudgetAuxiliar(perfil, this.defaultProvider, {
            getLatenciaTipicaMs: (provedor: string) =>
                this.circuitBreakers.getOrCreate({ name: provedor }).getLatenciaTipicaMs(),
        });
    }

    setDefaultProvider(name: string): void {
        if (this.providers.has(name)) {
            this.defaultProvider = name;
        } else {
            throw new Error(`Provider "${name}" not available. Available: ${this.getAvailableProviders().join(', ')}`);
        }
    }

    /**
     * Chat with automatic fallback — tries next provider if current fails.
     *
     * ATOMICITY GUARANTEE:
     * - Each attempt gets its own AbortController and isolated buffers.
     * - Previous attempts are ALWAYS aborted before starting a new one.
     * - Only ONE response is returned — the LAST successful attempt.
     * - No partial content from failed attempts is ever included.
     */
    async chatWithFallback(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number, externalSignal?: AbortSignal, modelOverride?: string, opts?: ChatFallbackOptions): Promise<LLMResult> {
        if (externalSignal?.aborted) {
            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: [] };
        }

        // Política do recurso declarado. `semSubstituicao` exige que o provider preferido exista de
        // fato: declarar um provider que não está registrado não dá o que proteger, e nesse caso o
        // comportamento continua o de sempre.
        const politicaDeSubstituicao = this.resolveSubstitutionPolicy(preferredProvider);
        const semSubstituicao = politicaDeSubstituicao === 'estrita'
            && !!preferredProvider
            && this.providers.has(preferredProvider);

        const providerOrder = semSubstituicao
            ? [preferredProvider as string]
            : this.getFallbackOrder(preferredProvider);

        // `anunciada` só produz aviso quando quem chamou disse que este resultado vai ao usuário.
        // Ver ChatFallbackOptions para por que o opt-in é explícito em vez de inferido.
        const podeAnunciar = opts?.anunciarSubstituicao === true
            && politicaDeSubstituicao === 'anunciada'
            && !!preferredProvider;
        let substituicao: LLMResult['substitution'];

        const attemptLog: AttemptInfo[] = [];
        const MAX_RETRIES = 1;
        const RETRY_BACKOFF_MS = 10000 + Math.floor(Math.random() * 3000);
        const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const startTime = Date.now();

        let activeAbortController: AbortController | null = null;

        log.info(`[${requestId}] chatWithFallback START providers=[${providerOrder.join(',')}] timeout=${timeoutMs || 'none'}ms`);

        const activeProviders = providerOrder.filter(name => {
            const breaker = this.circuitBreakers.getOrCreate({ name });
            if (!breaker.canExecute()) {
                log.info(`[${requestId}] CIRCUIT-OPEN: Skipping '${name}' (failures: ${breaker.getFailureCount()})`);
                return false;
            }
            return true;
        });

        if (activeProviders.length === 0) {
            log.error(`[${requestId}] ALL_PROVIDERS_CIRCUIT_OPEN — no provider available`);
            return {
                status: 'error' as const,
                content: 'Todos os providers estão temporariamente indisponíveis. Tente novamente em alguns segundos.',
                attempts: attemptLog,
            };
        }

        log.info(`[${requestId}] Active providers after circuit check: [${activeProviders.join(',')}]`);

        // Dono do modelOverride: o provider PARA O QUAL aquele modelo foi escolhido — não "o
        // primeiro que sobrou". Um nome de modelo só existe dentro do provider que o serve.
        //
        // Antes isto era `activeProviders[0]`, e bastava o provider preferido cair (circuito
        // aberto ou falha) para o modelo dele ser aplicado ao PRÓXIMO da fila, que não o tem.
        // Visto em produção (02/08/2026): com um servidor local fora do ar, o Ollama passou a
        // receber `gemma-4-26B-A4B-it-Q4_K_M.gguf` e respondeu HTTP 404 em toda tentativa, até
        // `EXHAUSTED attempts=4` — o goal do usuário falhou inteiro tendo um provider saudável
        // disponível. Vale para qualquer par (provider A com modelo X → fallback B sem X), não
        // só para modelos locais.
        //
        // Os demais providers usam a instância compartilhada, com o modelo que cada um já tem
        // configurado — que é justamente o sentido de existir um fallback.
        const modelOverrideOwner = preferredProvider || this.defaultProvider;

        for (const providerName of activeProviders) {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                const attemptId = `${requestId}-${providerName}-${attempt}`;
                const attemptStart = Date.now();

                if (externalSignal?.aborted) {
                    if (activeAbortController) { activeAbortController.abort(); activeAbortController = null; }
                    log.info(`[${requestId}] External cancellation before attempt ${providerName}-${attempt}`);
                    return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                }

                if (activeAbortController) {
                    log.info(`[${requestId}] Aborting previous in-flight request before attempt ${attempt}`);
                    activeAbortController.abort();
                    activeAbortController = null;
                }

                const currentAbort = new AbortController();
                activeAbortController = currentAbort;

                // Link external signal so a cancel() from AgentLoop propagates into the provider HTTP call
                let onExternalAbort: (() => void) | null = null;
                if (externalSignal) {
                    onExternalAbort = () => currentAbort.abort();
                    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                }

                try {
                    const sharedProvider = this.providers.get(providerName);
                    if (!sharedProvider) break;
                    // Use a dedicated per-request instance for the primary provider so concurrent
                    // requests on different channels don't race to mutate the same shared object.
                    const provider = (modelOverride && providerName === modelOverrideOwner)
                        ? this.getProviderWithModel(modelOverride, providerName)
                        : sharedProvider;
                    const modelUsed = (provider instanceof OllamaProvider) ? provider.getModel() : (provider as { model?: string }).model || provider.name;

                    if (attempt > 0) {
                        log.info(`[${attemptId}] Retry ${attempt}/${MAX_RETRIES} after ${RETRY_BACKOFF_MS}ms backoff`);
                        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
                        if (externalSignal?.aborted) {
                            activeAbortController = null;
                            if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
                            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                        }
                    }

                    log.info(`[${attemptId}] START provider=${providerName}/${modelUsed} timeout=${timeoutMs || 'none'}ms`);

                    // Esta tentativa é uma substituição do recurso declarado? E, se for, ela sai da
                    // máquina do usuário? Só nesse caso o fato entra no prompt — trocar um provedor
                    // de nuvem por outro equivalente é resiliência ordinária (§1.2).
                    const ehSubstituicao = !!preferredProvider && providerName !== preferredProvider;
                    const deveAnunciar = podeAnunciar && ehSubstituicao
                        && this.substituicaoAtravessaFronteira(preferredProvider as string, providerName);
                    if (ehSubstituicao) {
                        substituicao = { declared: preferredProvider as string, used: providerName, announced: deveAnunciar };
                    }
                    if (deveAnunciar) {
                        log.info(`[${attemptId}] SUBSTITUICAO-ANUNCIADA: '${preferredProvider}' → '${providerName}' (sai da máquina do usuário; o fato foi entregue ao modelo para verbalizar).`);
                    }
                    const mensagensDoProvider = deveAnunciar
                        ? this.mensagensComFatoDaSubstituicao(messages, preferredProvider as string, providerName)
                        : messages;

                    const chatOptions: ChatOptions = { signal: currentAbort.signal, timeoutMs };
                    const chatPromise = provider.chat(mensagensDoProvider, tools, chatOptions);
                    let result: LLMResponse;

                    if (timeoutMs) {
                        const attemptTimeout = setTimeout(() => currentAbort.abort(), timeoutMs);
                        // Safety timeout is 15s longer than the abort: gives _consumeStream time to
                        // recover thinking-as-content after the abort fires (both are async operations
                        // and the Promise.race reject would otherwise beat the recovery resolution).
                        const safetyTimeoutMs = timeoutMs + 15000;
                        try {
                            result = await Promise.race([
                                chatPromise,
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error('Timeout')), safetyTimeoutMs)
                                )
                            ]);
                        } finally {
                            clearTimeout(attemptTimeout);
                        }
                    } else {
                        result = await chatPromise;
                    }

                    if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);

                    const hasContent = (result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0);
                    if (externalSignal?.aborted) {
                        log.info(`[${attemptId}] External cancellation after response — discarding`);
                        activeAbortController = null;
                        return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                    }
                    if (currentAbort.signal.aborted && !hasContent) {
                        log.warn(`[${attemptId}] ABORTED with no content — moving to next attempt`);
                        attemptLog.push({ provider: providerName, model: modelUsed, duration: Date.now() - attemptStart, status: 'error', errorMessage: 'Aborted — no content' });
                        activeAbortController = null;
                        continue;
                    }

                    activeAbortController = null;

                    if (!result.toolCalls || result.toolCalls.length === 0) {
                        const extractedCalls = this.extractLeakedToolCalls(result.content);
                        if (extractedCalls) {
                            log.info(`[${attemptId}] Extracted leaked tool call: ${extractedCalls[0].name}`);
                            result.toolCalls = extractedCalls;
                        } else {
                            // Extraction failed (truncated JSON) — strip the artifact from content
                            // so the user doesn't receive malformed JSON embedded in the response.
                            result.content = this.stripLeakedToolCallArtifacts(result.content);
                        }
                    }

                    const duration = Date.now() - attemptStart;

                    if ((result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0)) {
                        attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'success' });
                        // `duration` já era calculado aqui e só ia para o log. Passá-lo adiante
                        // alimenta a latência típica do provedor, de onde saem os orçamentos das
                        // chamadas auxiliares (ver getBudgetAuxiliar em shared/auxTimeout.ts).
                        this.circuitBreakers.getOrCreate({ name: providerName }).recordSuccess(duration);
                        log.info(`[${attemptId}] SUCCESS content=${result.content.length}chars thinking=${(result.thinking || '').length}chars toolCalls=${result.toolCalls?.length || 0} duration=${duration}ms`);
                        return {
                            status: 'success',
                            content: result.content,
                            thinking: result.thinking || undefined,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            attempts: attemptLog,
                            substitution: substituicao
                        };
                    }

                    attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'empty' });
                    log.warn(`[${attemptId}] Empty response, moving to next`);
                    break;
                } catch (error) {
                    const duration = Date.now() - attemptStart;
                    activeAbortController = null;
                    if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);

                    // External cancel trumps all other error classification
                    if (externalSignal?.aborted) {
                        log.info(`[${attemptId}] Cancelled by external signal`);
                        attemptLog.push({ provider: providerName, model: providerName, duration, status: 'cancelled', errorMessage: 'Cancelled' });
                        return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                    }

                    const prov = this.providers.get(providerName);
                    const modelUsed = (prov instanceof OllamaProvider) ? prov.getModel() : (prov as { model?: string })?.model || providerName;
                    const isTimeout = errorMessage(error)?.includes('Timeout');
                    // 'Empty response from stream' (OllamaProvider) é lançado deliberadamente
                    // "para que ProviderFactory possa retentar" (ver comentário na origem) — mas
                    // essa string nunca esteve nesta lista, então isRetryable sempre dava false e
                    // o pedido era descartado após 1 tentativa (attempts=1) em vez de retentar.
                    // Reproduzido ao vivo (auditoria 09/07): dezenas de "EMPTY after 1 chunks" em
                    // <3s cada — glitch transitório do provider, não erro permanente — cascateando
                    // em replans desnecessários (prompt cresce a cada replan) até esgotar o goal.
                    const isRetryable = isTimeout ||
                        errorMessage(error)?.includes('abort') ||
                        errorMessage(error)?.includes('ECONNRESET') ||
                        errorMessage(error)?.includes('fetch failed') ||
                        errorMessage(error)?.includes('network') ||
                        errorMessage(error)?.includes('Empty response from stream');

                    log.warn(`[${attemptId}] FAILED ${errorMessage(error)} duration=${duration}ms retryable=${isRetryable && attempt < MAX_RETRIES}`);
                    attemptLog.push({
                        provider: providerName,
                        model: modelUsed,
                        duration,
                        status: isTimeout ? 'timeout' : 'error',
                        errorMessage: errorMessage(error)
                    });

                    this.registrarFalhaSeForAvaria(providerName, errorMessage(error));

                    if (isRetryable && attempt < MAX_RETRIES) continue;
                    break;
                }
            }
        }

        // All streaming providers exhausted — try non-streaming fallback
        //
        // SEGUNDO caminho de substituição deste método, e por isso a política precisa valer aqui
        // também: este bloco troca o provider preferido pelo Ollama incondicionalmente. Gatear
        // apenas a ordem de fallback deixaria `estrita` decorativa — quem pediu o modelo local
        // receberia resposta do Ollama assim mesmo. É o mesmo tipo de bypass que a `ADR-005` §5.1
        // registrou ao descobrir que o gate de autorização vivia em um caminho de cinco.
        //
        // Quando o próprio preferido JÁ é o Ollama, isto não é substituição: é o mesmo recurso por
        // outro transporte, e `estrita` não tem o que proibir.
        const naoStreamingSubstituiria = preferredProvider !== 'ollama';
        const podeTentarNaoStreaming = !semSubstituicao || !naoStreamingSubstituiria;
        if (podeTentarNaoStreaming && attemptLog.every(a => a.status === 'timeout' || a.status === 'error')) {
            const ollamaProvider = this.providers.get('ollama');
            if (ollamaProvider instanceof OllamaProvider) {
                log.info(`[${requestId}] All streaming attempts failed — trying non-streaming fallback`);
                // Mesmo tratamento do laço acima: este bloco também substitui o recurso declarado, e
                // anunciar num caminho e calar no outro seria o defeito que a Sprint 021 encontrou
                // aqui (gate aplicado a uma das duas substituições).
                const ehSubstituicaoNaoStreaming = !!preferredProvider && preferredProvider !== 'ollama';
                const anunciarNaoStreaming = podeAnunciar && ehSubstituicaoNaoStreaming
                    && this.substituicaoAtravessaFronteira(preferredProvider as string, 'ollama');
                if (ehSubstituicaoNaoStreaming) {
                    substituicao = { declared: preferredProvider as string, used: 'ollama', announced: anunciarNaoStreaming };
                }
                const mensagensNaoStreaming = anunciarNaoStreaming
                    ? this.mensagensComFatoDaSubstituicao(messages, preferredProvider as string, 'ollama')
                    : messages;
                try {
                    const result = await ollamaProvider.fallbackNonStreaming(mensagensNaoStreaming, tools, timeoutMs);
                    if (result.content && result.content.trim()) {
                        attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'success' });
                        return {
                            status: 'success',
                            content: result.content,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            fallbackReason: 'streaming_failed',
                            attempts: attemptLog,
                            substitution: substituicao
                        };
                    }
                } catch (fallbackErr) {
                    attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'error', errorMessage: errorMessage(fallbackErr) });
                }
            }
        }

        const lastError = (attemptLog.length > 0 && attemptLog[attemptLog.length - 1]?.errorMessage)
            ? attemptLog[attemptLog.length - 1].errorMessage : '';
        const isTimeoutError = lastError?.includes('Timeout') || lastError?.includes('abort');
        log.error(`[${requestId}] EXHAUSTED attempts=${attemptLog.length}`);

        // Política `estrita`: a indisponibilidade É o resultado, e o motivo precisa ser distinguível
        // de um erro comum — senão quem lê não tem como saber que existia substituto e ele foi
        // recusado de propósito.
        //
        // `fallbackMessage` fixa em português mantém o débito de i18n do Core já declarado em
        // `ARCHITECTURE.md` ("Gaps conhecidos"). O caminho de transformar isto em fato para o LLM
        // verbalizar é a Sprint 022; aqui seria adiantar metade dela sem o mecanismo.
        if (semSubstituicao) {
            log.warn(`[${requestId}] POLITICA-ESTRITA: '${preferredProvider}' indisponível e nenhum substituto foi tentado.`);
            return {
                status: 'error',
                content: '',
                toolCalls: undefined,
                fallbackReason: 'policy_strict',
                fallbackMessage: `O recurso configurado ("${preferredProvider}") não respondeu. A política de substituição declarada para ele é "estrita", então nenhum outro provedor foi usado em seu lugar.`,
                attempts: attemptLog
            };
        }

        return {
            status: isTimeoutError ? 'timeout' : 'error',
            content: '',
            toolCalls: undefined,
            fallbackReason: isTimeoutError ? 'timeout' : 'error' as FallbackReason,
            fallbackMessage: 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.',
            attempts: attemptLog
        };
    }

    private extractLeakedToolCalls(content: string): ToolCall[] | undefined {
        if (!content) return undefined;
        try {
            const toolCallMatch = content.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i);
            if (toolCallMatch?.[1]) {
                const parsed = JSON.parse(toolCallMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
            const xmlMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
            if (xmlMatch?.[1]) {
                const parsed = JSON.parse(xmlMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
            const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
            if (jsonBlockMatch?.[1]) {
                const parsed = JSON.parse(jsonBlockMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
        } catch (e) {
            log.info(`Failed to parse leaked tool call: ${e}`);
        }
        return undefined;
    }

    /**
     * Strips truncated/malformed tool call JSON that leaked into plain-text content.
     * When extractLeakedToolCalls() cannot parse a tool call (e.g. stream cut mid-JSON),
     * the raw JSON fragment remains in the content and corrupts the response shown to the
     * user. This method removes it by truncating at the opening marker.
     */
    stripLeakedToolCallArtifacts(content: string): string {
        if (!content) return content;
        // Find the earliest marker position
        const markers = [
            content.search(/\[TOOL_CALL\]/i),
            content.search(/<tool_call>/i),
            content.search(/```json\s*\{[\s\S]{0,50}"name"/i),
        ].filter(pos => pos >= 0);
        if (markers.length === 0) return content;
        const cutAt = Math.min(...markers);
        const cleaned = content.slice(0, cutAt).trimEnd();
        log.info(`Stripped leaked tool call artifact at position ${cutAt} (content truncated from ${content.length} to ${cleaned.length} chars)`);
        return cleaned;
    }

    async classifyWithFallback(messages: LLMMessage[], timeoutMs: number = 120000): Promise<LLMResponse> {
        const providerOrder = this.getFallbackOrder();
        const errors: string[] = [];

        for (const providerName of providerOrder) {
            try {
                const provider = this.providers.get(providerName);
                if (!provider) continue;

                let result: LLMResponse;
                if (providerName === 'ollama' && provider instanceof OllamaProvider) {
                    result = await provider.classify(messages, timeoutMs);
                } else {
                    result = await Promise.race([
                        provider.chat(messages),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                    ]);
                }

                if (result.content && result.content.trim().length > 0) return result;
                errors.push(`${providerName}: empty response`);
            } catch (error) {
                errors.push(`${providerName}: ${errorMessage(error)}`);
            }
        }

        throw new Error(`Classification failed: ${errors.join('; ')}`);
    }

    /**
     * A troca de `declarado` por `usado` atravessa fronteira de localidade/custódia?
     * (`SOBERANIA_DA_CONFIGURACAO.md` §1.2)
     *
     * Hoje a checagem é uma só: o recurso declarado é local e o substituto não é — o processamento
     * sai da máquina do usuário, e passa a ser tratado por alguém que ele não escolheu. As duas
     * fronteiras coincidem nesse caso.
     *
     * Dois provedores de nuvem se cobrindo mutuamente NÃO atravessam fronteira: é a resiliência
     * ordinária que o §1.2 autoriza a ser silenciosa. Reaproveita `loopbackPortOf` em vez de
     * introduzir um segundo conceito de "isto é local".
     */
    private substituicaoAtravessaFronteira(declarado: string, usado: string): boolean {
        return this.rodaNaMaquinaDoUsuario(declarado) && !this.rodaNaMaquinaDoUsuario(usado);
    }

    /**
     * Este provider roda na máquina do usuário?
     *
     * Pergunta **diferente** da que `loopbackPortOf` responde, e por isso um método separado.
     * `loopbackPortOf` responde "é um runtime local gerenciado pelo NewClaw?" e alimenta o
     * diagnóstico de ciclo de vida (Sprint 020) — deliberadamente restrito a `customConfigs`, para
     * que um registro corrompido não possa afetar a contabilidade de falhas de mais ninguém
     * (`S205-4`).
     *
     * Aqui a pergunta é de **localidade**, e o Ollama nativo entra: ele não tem entrada em
     * `customConfigs`, mas o endereço dele é conhecido e quase sempre é a própria máquina. Sem isto,
     * um llamafile local caindo para um Ollama local seria anunciado como "saiu da sua máquina" —
     * um aviso falso, que é pior que aviso nenhum.
     */
    private rodaNaMaquinaDoUsuario(providerName: string): boolean {
        const baseUrl = providerName === 'ollama'
            ? this.creds.ollamaUrl
            : this.customConfigs.get(providerName)?.baseUrl;
        if (!baseUrl) return false;
        try {
            const { hostname } = new URL(String(baseUrl));
            return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
        } catch { return false; }
    }

    /**
     * As mesmas mensagens, mais o **fato** de que esta resposta não vem do recurso declarado.
     *
     * É fato + pedido de verbalização, nunca texto pronto: quem redige é o LLM, que já recebeu
     * `buildLanguageDirective` no system prompt e portanto responde no idioma da conversa. O Core
     * escrevendo a frase sairia sempre em português (`ARCHITECTURE.md`, "Gaps conhecidos") — é
     * exatamente o que a `RFC-004` decidiu parar de fazer, aplicado aqui.
     *
     * O array original nunca é mutado: quem o passou pode reusá-lo, e a próxima tentativa não pode
     * herdar o aviso da anterior.
     */
    private mensagensComFatoDaSubstituicao(messages: LLMMessage[], declarado: string, usado: string): LLMMessage[] {
        return [...messages, {
            role: 'system',
            content: `[FATO DO SISTEMA] O usuário configurou "${declarado}" para esta conversa, e esse recurso não respondeu. `
                + `Esta resposta está sendo gerada por "${usado}", um recurso diferente e fora da máquina do usuário.\n`
                + `Antes de responder ao pedido, avise isso em UMA frase curta, no mesmo idioma da conversa. `
                + `Não invente motivos técnicos nem detalhes que não estejam aqui. Depois responda normalmente.`,
        }];
    }

    /**
     * Política de substituição do recurso que o usuário declarou para esta chamada.
     *
     * Ordem: o que o próprio provider declara vence; senão, o padrão global (`SUBSTITUTION_POLICY`
     * no ambiente); senão, `anunciada` (`RFC-005` §1.3).
     *
     * **Sem provider preferido não há soberania a proteger** — ninguém declarou nada para esta
     * chamada, então a política é `livre` e o comportamento é o de sempre. É a mesma fronteira que
     * `SOBERANIA_DA_CONFIGURACAO.md` §1.1 estabelece: ausência de configuração não é declaração.
     */
    private resolveSubstitutionPolicy(preferredProvider?: string): SubstitutionPolicy {
        if (!preferredProvider) return 'livre';

        const doProvider = this.customConfigs.get(preferredProvider)?.substitutionPolicy;
        if (doProvider) return doProvider;

        const global = (process.env.SUBSTITUTION_POLICY || '').trim();
        if (!global) return DEFAULT_SUBSTITUTION_POLICY;
        if (isSubstitutionPolicy(global)) return global;

        log.warn(`SUBSTITUTION_POLICY inválida ("${global}") — usando "${DEFAULT_SUBSTITUTION_POLICY}". Valores aceitos: estrita, anunciada, livre.`);
        return DEFAULT_SUBSTITUTION_POLICY;
    }

    /**
     * Porta de loopback deste provider, ou `null` se ele não for um endpoint local.
     *
     * Só providers **custom** são considerados: o servidor de modelo local do NewClaw é sempre
     * registrado como um (`ADR-002` §2.7). Provider nativo — inclusive um Ollama em `localhost` —
     * nunca é gerenciado por nós, e por isso nem chega a consultar o ciclo de vida: o caminho dele
     * permanece byte-idêntico ao de antes desta mudança.
     */
    private loopbackPortOf(providerName: string): number | null {
        const baseUrl = this.customConfigs.get(providerName)?.baseUrl;
        if (!baseUrl) return null;
        let url: URL;
        try { url = new URL(String(baseUrl)); } catch { return null; }
        if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') return null;
        const port = Number(url.port);
        return Number.isFinite(port) && port > 0 ? port : null;
    }

    /**
     * Registra a falha no circuito **apenas quando ela representa avaria real**.
     *
     * `RFC-005` (taxonomia de estados de indisponibilidade): um runtime local que o usuário
     * desligou é estado normal, esperado e reversível com um clique — não é avaria, e contá-lo como
     * tal foi o que produziu `CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)` em produção.
     *
     * Regra, e o que ela deliberadamente NÃO muda:
     *
     * - provider que não é loopback (nuvem, Ollama, qualquer nativo) → conta, como sempre contou;
     * - loopback **sem registro** de ciclo de vida (ex.: llamafile subido à mão, fora do dashboard)
     *   → conta. Ausência de registro é ausência de gerenciamento, não indeterminação: o recurso
     *   foi declarado, logo espera-se que esteja de pé. Preservar isso é o que impede esta mudança
     *   de desligar o circuito de quem nunca usou o dashboard para carregar modelo;
     * - loopback gerenciado e **em execução** → conta (`avariado`: está de pé e falhou mesmo assim);
     * - loopback gerenciado e **parado** → NÃO conta (`parado_por_decisao`);
     * - registro ilegível → NÃO conta (`indeterminado`). Nunca inferir daqui
     *   (`NUNCA_ADIVINHAR.md`); o efeito fica contido aos endpoints de loopback, para que um JSON
     *   corrompido não possa desativar o circuito dos providers de nuvem.
     */
    private registrarFalhaSeForAvaria(providerName: string, mensagemErro: string): void {
        const breaker = this.circuitBreakers.getOrCreate({ name: providerName });
        const porta = this.loopbackPortOf(providerName);
        if (porta === null) { breaker.recordFailure(mensagemErro); return; }

        const cicloDeVida = getLocalRuntimeLifecycle(porta);
        if (cicloDeVida === 'parado') {
            log.info(`[RUNTIME-PARADO] '${providerName}' está declarado e desligado (porta ${porta}) — falha não contabilizada como avaria.`);
            return;
        }
        if (cicloDeVida === 'indeterminado') {
            log.warn(`[RUNTIME-INDETERMINADO] Não foi possível classificar o runtime de '${providerName}' (porta ${porta}) — falha não contabilizada como avaria.`);
            return;
        }
        breaker.recordFailure(mensagemErro);
    }

    /**
     * Chave de identidade de um endpoint — dois rótulos com a MESMA chave são o mesmo servidor.
     *
     * Normaliza só equivalência garantida: `localhost` e `127.0.0.1` são o mesmo host, barra final
     * não muda o destino, e o esquema não distingue o alvo. Nada além disso — nomes de máquina
     * diferentes PODEM resolver para o mesmo IP, mas afirmar isso sem consultar DNS seria
     * adivinhação (`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`).
     *
     * MESMA REGRA da tela de Modelos (`checkDuplicateEndpoints`, ModelosView.js) — o painel avisa
     * sobre a colisão e o motor precisa enxergá-la igual, senão um diz uma coisa e o outro faz
     * outra. A paridade entre as duas implementações é travada por teste (S190).
     */
    private static endpointKey(baseUrl: string, apiKey?: string): string {
        const url = String(baseUrl || '')
            .trim().toLowerCase()
            .replace(/\/+$/, '')
            .replace(/^https?:\/\//, '')
            .replace(/^localhost([:/]|$)/, '127.0.0.1$1');
        return `${url}|${apiKey || ''}`;
    }

    /**
     * Remove da cadeia de fallback rótulos que apontam para o MESMO endpoint com a MESMA
     * credencial — eles não oferecem resiliência nenhuma: se o primeiro falhou porque o servidor
     * caiu, o segundo falha pelo mesmo motivo, gastando outro timeout de conexão inteiro.
     *
     * Evidência real (log do operador, 04/08/2026): `providers=[Modelo local,ollama,llamafile]`,
     * com `Modelo local` e `llamafile` ambos em 127.0.0.1:8080 — três nomes, dois endereços. Com
     * o servidor local fora do ar, duas das três tentativas eram a mesma tentativa.
     *
     * Credencial entra na chave de propósito: dois rótulos no mesmo gateway com chaves de API
     * diferentes são contas diferentes e PODEM se cobrir mutuamente — esses continuam ambos.
     * Só colapsa o que é comprovadamente o mesmo caminho.
     */
    private dedupeByEndpoint(order: string[]): string[] {
        const seen = new Map<string, string>();
        const kept: string[] = [];
        for (const label of order) {
            const cfg = this.customConfigs.get(label);
            if (!cfg?.baseUrl) { kept.push(label); continue; }   // nativos: endpoint próprio
            const key = ProviderFactory.endpointKey(cfg.baseUrl, cfg.apiKey);
            const winner = seen.get(key);
            if (winner) {
                log.info(`[FALLBACK] "${label}" ignorado na cadeia — mesmo endpoint e credencial de "${winner}" (quem atende é "${winner}")`);
                continue;
            }
            seen.set(key, label);
            kept.push(label);
        }
        return kept;
    }

    private getFallbackOrder(preferred?: string): string[] {
        const all = Array.from(this.providers.keys());
        if (preferred && this.providers.has(preferred)) {
            return this.dedupeByEndpoint([preferred, ...all.filter(p => p !== preferred)]);
        }
        if (preferred) {
            log.warn(`Provider "${preferred}" requested but not available (missing credential?). Using default fallback order.`);
        }
        // defaultProvider (DEFAULT_PROVIDER / "Provider padrão" no dashboard) é a preferência
        // declarada pelo usuário — antes ela era ignorada aqui e a ordem começava sempre em
        // 'ollama', então escolher outro provider padrão (inclusive um custom) não tinha efeito
        // nenhum sobre qual provider era realmente tentado primeiro. Continua sendo só a ORDEM:
        // todos os demais seguem atrás, na mesma sequência de sempre, como fallback.
        const order = ['ollama', 'openrouter', 'anthropic', 'gemini', 'deepseek', 'groq'];
        const sorted = order.filter(p => this.providers.has(p));
        const remaining = all.filter(p => !sorted.includes(p));
        const byPriority = [...sorted, ...remaining];
        if (this.providers.has(this.defaultProvider)) {
            return this.dedupeByEndpoint([this.defaultProvider, ...byPriority.filter(p => p !== this.defaultProvider)]);
        }
        return this.dedupeByEndpoint(byPriority);
    }

    /**
     * Atualiza uma API key em runtime (chamado pelo dashboard após o usuário salvar).
     * Substitui a credential em creds e recria a instância do provider no mapa.
     */
    updateCredential(key: 'geminiKey' | 'deepseekKey' | 'groqKey' | 'openrouterKey' | 'anthropicKey', value: string): void {
        this.creds[key] = value;
        switch (key) {
            case 'geminiKey':     this.providers.set('gemini',     new GeminiProvider(value));        break;
            case 'deepseekKey':   this.providers.set('deepseek',   new DeepSeekProvider(value));      break;
            case 'groqKey':       this.providers.set('groq',       new GroqProvider(value));          break;
            case 'openrouterKey': this.providers.set('openrouter', new OpenRouterProvider(value));    break;
            case 'anthropicKey':  this.providers.set('anthropic',  new AnthropicProvider(value));     break;
        }
        log.info(`Credential updated and provider recreated: ${key.replace('Key', '')}`);
    }

    removeCredential(key: 'geminiKey' | 'deepseekKey' | 'groqKey' | 'openrouterKey' | 'anthropicKey'): void {
        this.creds[key] = undefined;
        switch (key) {
            case 'geminiKey':     this.providers.delete('gemini');     break;
            case 'deepseekKey':   this.providers.delete('deepseek');   break;
            case 'groqKey':       this.providers.delete('groq');       break;
            case 'openrouterKey': this.providers.delete('openrouter'); break;
            case 'anthropicKey':  this.providers.delete('anthropic');  break;
        }
        log.info(`Credential removed: ${key.replace('Key', '')}`);
    }

    /**
     * Registra (ou substitui, se a label já existir) um provider custom em runtime — chamado
     * pelo dashboard depois que o usuário salva um endpoint OpenAI-compatible (LM Studio, vLLM,
     * llamafile local etc.) via POST /providers/custom. Mesmo padrão de updateCredential(): a
     * config persistida (ctx.config.customProviders) e a instância viva no Map precisam ficar em
     * sincronia, senão o provider aparece na lista mas nunca participa do fallback de verdade.
     */
    addCustomProvider(custom: CustomProviderConfig): void {
        // Log de sucesso só quando de fato registrado — registerCustomProvider() já loga o warn
        // de rejeição (label vazia ou colidente com nome reservado); logar "registered" aqui
        // incondicionalmente mascararia essa rejeição.
        if (this.registerCustomProvider(custom)) {
            log.info(`Custom provider registered: ${custom.label} (${custom.baseUrl})`);
        }
    }

    removeCustomProvider(label: string): void {
        if (RESERVED_PROVIDER_NAMES.has(label)) return; // nunca remove um provider nativo por engano
        this.providers.delete(label);
        this.customConfigs.delete(label);
        log.info(`Custom provider removed: ${label}`);
    }

    getOllamaProvider(): OllamaProvider | undefined {
        const p = this.providers.get('ollama');
        return p instanceof OllamaProvider ? p : undefined;
    }

    /** Devolve a instância já registrada de um dos 5 provedores nativos de nuvem (gemini/deepseek/
     *  groq/openrouter/anthropic), ou `undefined` se a API key não estiver configurada — mesmo
     *  Map que o construtor já usa pra registrá-los (linhas 85-95), sem nova fonte de verdade.
     *  Espelha `getOllamaProvider()`. */
    getNativeProvider(name: 'gemini' | 'deepseek' | 'groq' | 'openrouter' | 'anthropic'): ILLMProvider | undefined {
        return this.providers.get(name);
    }

    getCurrentModel(): string {
        const provider = this.getProvider();
        if (provider instanceof OllamaProvider) return provider.getModel();
        // Todo provider guarda o modelo ativo em `model`; devolvê-lo é o que o nome do método
        // promete. Antes o retorno era `provider.name` — o nome da CLASSE — então o dashboard
        // exibia "Modelo padrão: openai" (ou "gemini") para qualquer provider não-Ollama, o que
        // não é modelo nenhum. `name` fica só como último recurso, se o modelo não existir.
        const model = (provider as { model?: string }).model;
        return model || provider.name;
    }
}
