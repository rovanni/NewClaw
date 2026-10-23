/**
 * ProviderFactory — Troca dinâmica de LLMs
 * Suporta: Gemini, DeepSeek, Groq, OpenAI, OpenRouter, Anthropic, Ollama
 */

import { combinarSinais, sinalDoTurno } from '../shared/turnCancellation';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { circuitRegistry } from './CircuitBreaker';
import { getLocalRuntimeLifecycle } from './localRuntimeState';
import { LLMMessage, LLMResponse, ToolDefinition, LLMResult, AttemptInfo, FallbackReason, ToolCall, ILLMProvider, ChatOptions, CustomProviderConfig, ChatFallbackOptions, LlmCallDiag, REASONING_INTENSIVE_TIMEOUT_FLOOR_MS, AttemptTelemetry, CallTelemetry, ehModeloDaNuvemDoOllama, mensagemSemModeloEscolhido, caracteresQueCabem, DECISION_PROMPT_MAX_CHARS } from './providerTypes';
import { GeminiProvider } from './GeminiProvider';
import { DeepSeekProvider } from './DeepSeekProvider';
import { GroqProvider } from './GroqProvider';
import { getBudgetAuxiliar, PerfilAuxiliar, OrcamentoAuxiliar } from '../shared/auxTimeout';
import { OpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
import { OllamaProvider, NO_MODEL_CONFIGURED_MESSAGE } from './OllamaProvider';
import { mascararProfundo, mascararSegredos } from '../shared/segredos';
import { medidorDoProcesso, observacaoDaChamada, CHARS_POR_TOKEN_PTBR, pontoDePartidaEmTokens } from './medidorDeTrabalho';

/** Folga sobre o tempo que o orçamento em tokens dá na velocidade medida (ADR-024): a velocidade varia entre chamadas. */
const FOLGA_DE_TEMPO = 1.25;
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

/** Modelo escolhido pelo usuário para cada provedor nativo — vem de <PROVEDOR>_MODEL (painel ou configuração inicial). */
export interface ModelosNativos { gemini?: string; deepseek?: string; groq?: string; openrouter?: string; anthropic?: string }

/** As variáveis de ambiente onde a escolha mora — uma por provedor nativo, no mesmo padrão do OLLAMA_MODEL. */
export const VARIAVEL_DO_MODELO_NATIVO: Record<keyof ModelosNativos, string> = {
    gemini: 'GEMINI_MODEL', deepseek: 'DEEPSEEK_MODEL', groq: 'GROQ_MODEL', openrouter: 'OPENROUTER_MODEL', anthropic: 'ANTHROPIC_MODEL',
};

export function modelosNativosDoAmbiente(env: NodeJS.ProcessEnv = process.env): ModelosNativos {
    const r: ModelosNativos = {};
    for (const [p, v] of Object.entries(VARIAVEL_DO_MODELO_NATIVO)) { const m = (env[v] ?? '').trim(); if (m) r[p as keyof ModelosNativos] = m; }
    return r;
}

// Re-export everything so all existing imports continue to work unchanged
export type { LLMMessage, LLMResponse, ToolCall, ToolDefinition, FallbackReason, AttemptInfo, LLMResult, MetricsSummary, ILLMProvider, ChatOptions, StreamChunk } from './providerTypes';
export { TaskPriority } from './providerQueue';
export { GeminiProvider } from './GeminiProvider';
export { DeepSeekProvider } from './DeepSeekProvider';
export { GroqProvider } from './GroqProvider';
export { OpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
export { OllamaProvider } from './OllamaProvider';
export { AnthropicProvider } from './AnthropicProvider';

const log = createLogger('Providerfactory');

/**
 * Linha de diagnóstico de UMA chamada completa a `chatWithFallback` (Campanha B2). Pura: recebe o
 * resultado já produzido e devolve texto — não decide nada, não guarda estado.
 *
 * `in_est` é sempre calculado (caracteres/4, mesma aproximação de `computeDynamicTimeout`);
 * `in`/`out` só existem quando o provider reportou uso (chamada concluída). `reasoning_chars` vem
 * da mensagem do PRÓPRIO aborto por orçamento de raciocínio ("... after N chars"), a única
 * medida do raciocínio descartado — o texto dele nunca chega ao resultado.
 */
export function buildLlmCallSummary(
    diag: LlmCallDiag | undefined,
    messages: LLMMessage[],
    result: LLMResult,
    wallMs: number,
): string {
    const attempts = result.attempts ?? [];
    let reasoningChars = 0;
    let aborted = false;
    for (const a of attempts) {
        const m = /Reasoning budget exceeded after (\d+) chars/.exec(a.errorMessage ?? '');
        if (m) { aborted = true; reasoningChars = Math.max(reasoningChars, Number(m[1])); }
    }
    const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    // `model`: o modelo REAL da chamada — o da primeira tentativa. A última pode ser o pseudo-modelo
    // 'non-streaming-fallback' (nome interno de attemptLog), que escondia o modelo verdadeiro
    // (visto na primeira execução real de B2). O caminho não-streaming vira o campo `via`.
    const NAO_STREAMING = 'non-streaming-fallback';
    const real = attempts.find(a => a.model !== NAO_STREAMING) ?? attempts[0];
    const viaNaoStreaming = attempts.some(a => a.model === NAO_STREAMING);
    const parts: Array<[string, string | number | boolean | undefined]> = [
        ['component', diag?.component ?? 'unlabeled'],
        ['role', diag?.role],
        ['phase', diag?.phase],
        ['goal', diag?.goalId],
        ['cycle', diag?.cycle],
        ['step', diag?.step],
        ['model', real?.model],
        ['via', viaNaoStreaming ? 'non-streaming' : undefined],
        ['status', result.status],
        ['fallback', result.fallbackReason],
        ['attempts', attempts.length],
        ['aborted', aborted],
        ['reasoning_chars', aborted ? reasoningChars : undefined],
        ['in_est', Math.round(chars / 4)],
        ['in', result.usage?.prompt_tokens],
        ['out', result.usage?.completion_tokens],
        ['ms', wallMs],
    ];
    return parts.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
}

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
        /** Modelo escolhido pelo usuário para cada provedor nativo (<PROVEDOR>_MODEL). Vazio = não escolhido — nunca um padrão. */
        modelosNativos: ModelosNativos;
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
        modelosNativos?: ModelosNativos;
    }) {
        // Diretiva da mantenedora (14/10/2026): só o provedor e os modelos que o usuário escolheu — nenhum padrão no código.
        // Sem DEFAULT_PROVIDER, nada é escolhido por ele (antes: 'gemini').
        this.defaultProvider = config.defaultProvider || '';
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
            modelosNativos: { ...(config.modelosNativos ?? {}) },
        };

        // Cada nativo nasce com o modelo ESCOLHIDO (vazio quando não houve escolha — a chamada então avisa, ver
        // `modeloEscolhidoDe`). Antes os construtores traziam 'gemini-2.0-flash', 'gpt-4o'… embutidos.
        const m = this.creds.modelosNativos;
        if (config.geminiKey)      this.providers.set('gemini',      new GeminiProvider(config.geminiKey, m.gemini ?? ''));
        if (config.deepseekKey)    this.providers.set('deepseek',    new DeepSeekProvider(config.deepseekKey, m.deepseek ?? ''));
        if (config.groqKey)        this.providers.set('groq',        new GroqProvider(config.groqKey, m.groq ?? ''));
        if (config.openrouterKey)  this.providers.set('openrouter',  new OpenRouterProvider(config.openrouterKey, m.openrouter ?? ''));
        if (config.anthropicKey)   this.providers.set('anthropic',   new AnthropicProvider(config.anthropicKey, m.anthropic ?? ''));

        this.providers.set('ollama', new OllamaProvider(
            config.ollamaUrl || 'http://localhost:11434',
            config.ollamaModel || '',   // issue 068: sem modelo embutido
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
        this.providers.set(custom.label, new OpenAIProvider(custom.apiKey || '', custom.model || '', custom.baseUrl, custom.label, { thinking: custom.thinking }));
        this.customConfigs.set(custom.label, { ...custom });
        return true;
    }

    getProvider(name?: string): ILLMProvider {
        const providerName = name || this.defaultProvider;
        const provider = this.providers.get(providerName);
        // Sem "o primeiro que houver": só o provedor escolhido responde (diretiva de 14/10/2026).
        if (!provider) throw new Error(ProviderFactory.mensagemSemProvedor(providerName));
        return provider;
    }

    /** Texto ao usuário quando o provedor pedido não está configurado — nunca outro no lugar dele. */
    static mensagemSemProvedor(nome: string): string {
        return nome
            ? `O provedor "${nome}" não está configurado (falta a chave ou o cadastro). Configure-o no painel em Modelos.`
            : 'Nenhum provedor de IA foi escolhido. Escolha o provedor e o modelo no painel em Modelos.';
    }

    /** Texto ao usuário quando o provedor existe mas nenhum modelo foi escolhido para ele. */
    static mensagemSemModelo(nome: string): string {
        const variavel = nome === 'ollama' ? 'OLLAMA_MODEL' : VARIAVEL_DO_MODELO_NATIVO[nome as keyof ModelosNativos];
        return mensagemSemModeloEscolhido(nome, variavel);
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
        // Nativos: o modelo pedido, senão o ESCOLHIDO para o provedor (<PROVEDOR>_MODEL) — nunca um padrão embutido. Sem chave,
        // erro com o nome do provedor: antes caía no Ollama em silêncio (outro provedor, que o usuário não escolheu para isto).
        const mn = this.creds.modelosNativos;
        const nativo = (chave: string | undefined, criar: (k: string) => ILLMProvider): ILLMProvider => {
            if (!chave) throw new Error(ProviderFactory.mensagemSemProvedor(target));
            return criar(chave);
        };
        switch (target) {
            case 'openrouter': return nativo(this.creds.openrouterKey, k => new OpenRouterProvider(k, model || mn.openrouter || ''));
            case 'gemini':     return nativo(this.creds.geminiKey, k => new GeminiProvider(k, model || mn.gemini || ''));
            case 'groq':       return nativo(this.creds.groqKey, k => new GroqProvider(k, model || mn.groq || ''));
            case 'deepseek':   return nativo(this.creds.deepseekKey, k => new DeepSeekProvider(k, model || mn.deepseek || ''));
            case 'anthropic':  return nativo(this.creds.anthropicKey, k => new AnthropicProvider(k, model || mn.anthropic || ''));
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
            // `model` (a escolha por categoria do Model Router) vence a config fixa do provider, mesma precedência dos nativos.
            // Sem nenhuma das duas, o modelo fica vazio (a chamada avisa) — o antigo 'default' era um modelo escolhido pelo código.
            return new OpenAIProvider(custom.apiKey || '', model || custom.model || '', custom.baseUrl, custom.label, { thinking: custom.thinking });
        }

        // Ollama: só quando é ELE o provedor pedido. Qualquer outro nome desconhecido é erro, não Ollama no lugar.
        if (target !== 'ollama') throw new Error(ProviderFactory.mensagemSemProvedor(target));
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
    /**
     * Teto de ENTRADA (caracteres) de uma decisão do LLM com este modelo, derivado da janela REAL dele (OllamaProvider.janelaEfetiva:
     * medida no /api/tags). Antes era um número fixo (DECISION_PROMPT_MAX_CHARS, 60 mil) calculado para um modelo local de 32.768
     * tokens — o juiz de nuvem (janela de 1 milhão) ficava "não avaliável" com 93–119 mil chars (Windows, 15/10/2026). Sem a janela
     * medida (outro provedor, servidor fora): o número conservador de sempre, declarado como padrão.
     */
    async tetoDeEntrada(modelo?: string): Promise<{ chars: number; origem: string }> {
        const janela = await this.janelaMedida(modelo);
        if (janela) return { chars: caracteresQueCabem(janela.tokens), origem: janela.origem };
        return { chars: DECISION_PROMPT_MAX_CHARS, origem: 'padrão (janela do modelo não medida)' };
    }

    /**
     * A janela de contexto que `modelo` REALMENTE recebe pelo provedor que vai atendê-lo (hoje medida só no Ollama, pelo /api/tags).
     * undefined = não medida — cada consumidor decide o próprio padrão (juiz: DECISION_PROMPT_MAX_CHARS; agente: o num_ctx).
     */
    async janelaMedida(modelo?: string, provedor?: string): Promise<{ tokens: number; origem: string } | undefined> {
        if ((provedor || this.defaultProvider) !== 'ollama') return undefined;
        const ollama = this.getOllamaProvider();
        return ollama ? ollama.janelaEfetiva(modelo || ollama.getModel()) : undefined;
    }

    /**
     * ADR-024 (etapa 3): o que um trabalho deste TIPO costuma custar a ESTE modelo NESTE modo de raciocínio — em tokens
     * (p95 × folga do que concluiu, aprendido pelo uso) — e quanto tempo isso dá na velocidade MEDIDA dele (leitura do
     * prompt + geração). `null` sem histórico suficiente ou sem velocidade medida: quem chama segue com o prazo de sempre.
     * ADR-027: sem teto do objetivo — este prazo só corta provedor sem streaming (sem sinal de progresso).
     */
    orcamentoPeloTrabalho(modelo: string | undefined, modo: 'livre' | 'desligado' | undefined, tipo: string, charsDeEntrada: number,
        opcoes?: { pontoDePartida?: boolean }):
        { modelo: string; tokens: number; prazoMs: number; amostras: number; geracao: number; leitura?: number; origem: 'historico' | 'ponto_de_partida' } | null {
        const nome = modelo || this.modeloPadraoDe(this.defaultProvider);
        if (!nome) return null;
        const m = modo ?? 'padrao';
        const vel = medidorDoProcesso.velocidade(nome, m);
        if (!vel.geracao) return null;
        // Sem histórico próprio neste tipo, quem pede usa o ponto de partida declarado (ADR-024, decisão 2) — os juízes não
        // pedem (o orçamento deles também vira limite de tokens no provedor, e um número de outro modelo poderia cortar).
        const historico = medidorDoProcesso.orcamento(nome, m, tipo);
        const partida = !historico && opcoes?.pontoDePartida ? pontoDePartidaEmTokens(tipo) : undefined;
        const orc = historico ?? (partida ? { tokens: partida, amostras: 0 } : null);
        if (!orc) return null;
        const entradaTokens = charsDeEntrada / CHARS_POR_TOKEN_PTBR;
        const bruto = (orc.tokens / vel.geracao + (vel.leitura ? entradaTokens / vel.leitura : 0)) * 1000 * FOLGA_DE_TEMPO + 5000;
        // ADR-027: sem teto do objetivo (o objetivo não tem mais relógio). Este prazo só vale para provedor sem streaming.
        return {
            modelo: nome, tokens: orc.tokens, prazoMs: Math.round(bruto), amostras: orc.amostras, geracao: vel.geracao, leitura: vel.leitura,
            origem: historico ? 'historico' : 'ponto_de_partida',
        };
    }

    /**
     * Mede a velocidade dos modelos que ainda não têm medição (ADR-024: medir em vez de supor), com UMA chamada mínima para
     * cada — pelo caminho normal, então a medição é registrada como qualquer outra. Sem isso, a primeira chamada de um modelo
     * nunca medido usa o prazo calibrado na nuvem: validação real (21/10/2026), num modelo local novo o classificador de
     * objetivos estourava 15 s no primeiro turno (era a primeira chamada) e o pedido não virava objetivo. A medição fica
     * guardada (`data/medicao-de-tokens.json`): cada modelo é medido uma vez, não a cada partida. Nunca lança.
     */
    async medirVelocidadeDosModelos(modelos: string[]): Promise<void> {
        for (const modelo of [...new Set(modelos.filter(Boolean))]) {
            if (medidorDoProcesso.velocidade(modelo, 'padrao').geracao) continue;
            try {
                const r = await this.chatWithFallback([{ role: 'user', content: 'Responda apenas: ok' }], undefined, undefined, 300_000,
                    // 128 tokens: com 32, um modelo que raciocina antes de responder gastava tudo pensando e a chamada terminava
                    // sem conteúdo (validação real, 21/10/2026, modelo local) — a velocidade saía, mas de uma amostra pequena.
                    undefined, modelo, { diag: { component: 'MedicaoDeVelocidade', role: 'sonda' }, limiteDeSaidaTokens: 128 });
                const v = medidorDoProcesso.velocidade(modelo, 'padrao');
                log.info(`[MEDICAO] modelo=${modelo} sem velocidade medida — sonda ${r.status}; ${v.geracao ? `geração ${v.geracao.toFixed(1)} tok/s${v.leitura ? `, leitura ${v.leitura.toFixed(0)} tok/s` : ''}` : 'o provedor não informou os tempos (segue sem medição)'}`);
            } catch (e) {
                log.warn(`[MEDICAO] modelo=${modelo} — a sonda falhou: ${String(e).slice(0, 160)}`);
            }
        }
    }

    getBudgetAuxiliar(perfil: PerfilAuxiliar, tamanhoDoTrabalhoChars?: number): OrcamentoAuxiliar {
        return getBudgetAuxiliar(perfil, this.defaultProvider, {
            getLatenciaTipicaMs: (provedor: string) =>
                this.circuitBreakers.getOrCreate({ name: provedor }).getLatenciaTipicaMs(),
        }, tamanhoDoTrabalhoChars);
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
    /**
     * Ponto de entrada. Contrato INALTERADO: mesmos parâmetros, mesmo resultado (o objeto devolvido
     * é o do corpo, sem cópia nem alteração). A única diferença é a linha `[LLM-CALL]` de
     * diagnóstico ao final (Campanha B2) — que nunca pode afetar a chamada.
     */
    async chatWithFallback(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number, externalSignal?: AbortSignal, modelOverride?: string, opts?: ChatFallbackOptions): Promise<LLMResult> {
        const t0 = Date.now();
        // Cancelamento do TURNO (botão "Parar"): vale para a chamada em voo de QUALQUER componente, sem passar o sinal à mão.
        externalSignal = combinarSinais(externalSignal, sinalDoTurno());
        // ADR-019: nenhum valor do cofre ou de chave de API sai para um modelo — vale para todo componente que chama um
        // LLM, inclusive texto que chegou à memória antes de o cofre existir. Cópia: o array de quem chamou não muda.
        messages = mascararProfundo(messages);
        // ADR-024 (etapa 1, SOMBRA): toda chamada é observada em tokens — se quem chamou não pediu telemetria, uma interna só
        // para medir. Nada abaixo decide com ela.
        const telemetriaInterna: CallTelemetry | undefined = opts?.telemetry ? undefined : { attempts: [] };
        const optsObservadas = telemetriaInterna ? { ...opts, telemetry: telemetriaInterna } : opts;
        const result = await this.chatWithFallbackImpl(messages, tools, preferredProvider, timeoutMs, externalSignal, modelOverride, optsObservadas);
        try {
            log.info(`[LLM-CALL] ${buildLlmCallSummary(opts?.diag, messages, result, Date.now() - t0)}`);
        } catch { /* diagnóstico nunca derruba a chamada */ }
        try {
            const tentativas = (optsObservadas?.telemetry?.attempts ?? []).filter(a => a.model !== 'non-streaming-fallback');
            const ultima = tentativas[tentativas.length - 1];
            if (ultima || result.usage) {
                const obs = observacaoDaChamada({
                    modelo: ultima?.model ?? modelOverride ?? '(padrão do provedor)',
                    modo: opts?.raciocinio ?? 'padrao',
                    tipo: `${opts?.diag?.component ?? 'sem_rotulo'}:${opts?.diag?.phase ?? opts?.diag?.role ?? '-'}`,
                    status: result.status, tentativa: ultima, usage: result.usage,
                    charsDeEntrada: messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
                    msTotal: Date.now() - t0,
                    canceladaPeloUsuario: !!sinalDoTurno()?.aborted,
                });
                log.info(`[TOKENS-SOMBRA] ${medidorDoProcesso.registrar(obs)}`);
            }
        } catch { /* medição nunca derruba a chamada */ }
        return result;
    }

    private async chatWithFallbackImpl(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number, externalSignal?: AbortSignal, modelOverride?: string, opts?: ChatFallbackOptions): Promise<LLMResult> {
        if (externalSignal?.aborted) {
            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: [] };
        }

        // ADR-018 (14/10/2026): a cadeia tem só o provedor declarado — nunca há reserva em outro provedor ou modelo. Com
        // isso saíram também a política de substituição (estrita/anunciada/livre, RFC-005) e o anúncio da troca: não há
        // troca para permitir, recusar nem anunciar. (Antes, a issue 071 ainda filtrava aqui a reserva que sairia da
        // máquina, com a opção PERMITIR_NUVEM_COMO_RESERVA.)
        const providerOrder = this.getFallbackOrder(preferredProvider);
        const declarado = preferredProvider || this.defaultProvider;

        const attemptLog: AttemptInfo[] = [];
        // Issue 064b: alguma tentativa terminou porque o PRAZO de quem chamou acabou — então não há refação sem
        // streaming com o mesmo modelo e o mesmo prazo (ela também não caberia).
        let prazoEsgotado = false;
        const MAX_RETRIES = 1;
        const RETRY_BACKOFF_MS = 10000 + Math.floor(Math.random() * 3000);
        const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const startTime = Date.now();
        // Campanha 09/10/2026: `timeoutMs` é o prazo de QUEM CHAMOU, para a chamada inteira — não por tentativa. Antes,
        // cada tentativa (nova tentativa, reserva, refação sem streaming) recebia o prazo cheio de novo: o juiz com
        // orçamento de 46 s esperou 2 × 240 s (08/10, servidor local) e 3 tentativas somaram 763 s (07/10). Agora a
        // reserva continua valendo quando a primeira falha CEDO (conexão recusada), e não começa depois que o prazo
        // acabou. O piso de raciocínio (issue 047) entra aqui, uma vez, no prazo total.
        const prazoTotalMs = (opts?.reasoningIntensive && timeoutMs)
            ? Math.max(timeoutMs, REASONING_INTENSIVE_TIMEOUT_FLOOR_MS)
            : timeoutMs;
        const prazoFinal = prazoTotalMs ? startTime + prazoTotalMs : undefined;
        const restanteDoPrazo = (): number | undefined => prazoFinal === undefined ? undefined : prazoFinal - Date.now();

        let activeAbortController: AbortController | null = null;

        log.info(`[${requestId}] chatWithFallback START providers=[${providerOrder.join(',')}] timeout=${timeoutMs || 'none'}ms`);

        // Nenhum provedor escolhido/configurado para esta chamada: diz qual, em vez de "todos indisponíveis".
        if (providerOrder.length === 0) {
            const semProvedor = ProviderFactory.mensagemSemProvedor(declarado);
            return { status: 'error' as const, content: semProvedor, fallbackReason: 'unavailable' as FallbackReason, fallbackMessage: semProvedor, attempts: attemptLog };
        }

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
            // Sem `fallbackMessage`, o AgentLoop (`response.fallbackMessage || 'Erro ao processar...'`)
            // descartava este texto e o usuário recebia só o genérico — visto em 23/09/2026, com o
            // Ollama parado após o reboot: turno respondido com "Erro ao processar sua mensagem.",
            // log com `Provider error at step 1: undefined`.
            const indisponivel = 'Todos os providers estão temporariamente indisponíveis. Tente novamente em alguns segundos.';
            return {
                status: 'error' as const,
                content: indisponivel,
                fallbackReason: 'unavailable' as FallbackReason,
                fallbackMessage: indisponivel,
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

        cadeia: for (const providerName of activeProviders) {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                const attemptId = `${requestId}-${providerName}-${attempt}`;
                const attemptStart = Date.now();
                // ADR-027: provedor que vigia o silêncio (streaming) não tem relógio de duração — nem nesta tentativa, nem para
                // decidir se a próxima cabe. Ele só para por travamento (sem pedaços), pelo "Parar" ou pelo próprio fim.
                const vigiaSilencio = this.providers.get(providerName)?.vigiaSilencio === true;

                // Prazo de quem chamou já acabou: nenhuma tentativa nova começa (nem neste provider, nem na reserva).
                const restanteAntes = vigiaSilencio ? undefined : restanteDoPrazo();
                if (restanteAntes !== undefined && restanteAntes <= 0) {
                    prazoEsgotado = true;
                    log.info(`[${requestId}] Prazo de quem chamou esgotado (${prazoTotalMs}ms) — '${providerName}' não tentado`);
                    break cadeia;
                }

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
                let prazoDaTentativaEsgotado = false;

                // Link external signal so a cancel() from AgentLoop propagates into the provider HTTP call
                let onExternalAbort: (() => void) | null = null;
                if (externalSignal) {
                    onExternalAbort = () => currentAbort.abort();
                    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                }

                // Modelo da instância DESTA requisição, para o registro de tentativas — o `catch` abaixo não
                // enxerga as constantes do `try`.
                let attemptModel: string | undefined;
                let tentativaTele: AttemptTelemetry | undefined;
                try {
                    const sharedProvider = this.providers.get(providerName);
                    if (!sharedProvider) break;
                    // Use a dedicated per-request instance for the primary provider so concurrent
                    // requests on different channels don't race to mutate the same shared object.
                    const provider = (modelOverride && providerName === modelOverrideOwner)
                        ? this.getProviderWithModel(modelOverride, providerName)
                        : sharedProvider;
                    const modeloEscolhido = (provider instanceof OllamaProvider) ? provider.getModel() : (provider as { model?: string }).model;
                    // Sem modelo escolhido para este provedor (nem na chamada, nem na configuração): avisa — nunca um modelo do código.
                    if (!modeloEscolhido) {
                        activeAbortController = null;
                        if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);
                        const semModelo = ProviderFactory.mensagemSemModelo(providerName);
                        log.warn(`[${attemptId}] ${semModelo}`);
                        return { status: 'error', content: semModelo, fallbackReason: 'unavailable', fallbackMessage: semModelo, attempts: attemptLog };
                    }
                    const modelUsed = modeloEscolhido;
                    attemptModel = modelUsed;

                    if (attempt > 0) {
                        const restanteNaEspera = vigiaSilencio ? undefined : restanteDoPrazo();
                        if (restanteNaEspera !== undefined && restanteNaEspera <= RETRY_BACKOFF_MS) {
                            log.info(`[${attemptId}] Retry não cabe no prazo de quem chamou (restam ${restanteNaEspera}ms, espera ${RETRY_BACKOFF_MS}ms)`);
                            activeAbortController = null;
                            if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);
                            break;
                        }
                        log.info(`[${attemptId}] Retry ${attempt}/${MAX_RETRIES} after ${RETRY_BACKOFF_MS}ms backoff`);
                        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
                        if (externalSignal?.aborted) {
                            activeAbortController = null;
                            if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
                            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                        }
                    }

                    log.info(`[${attemptId}] START provider=${providerName}/${modelUsed} timeout=${timeoutMs || 'none'}ms`);

                    const mensagensDoProvider = messages;

                    // Gravador de voo (ADR-013): uma entrada por tentativa; o provider preenche o que observou no streaming.
                    if (opts?.telemetry) {
                        tentativaTele = { provider: providerName, model: modelUsed, startedAt: new Date().toISOString(), raciocinio: opts?.raciocinio };
                        opts.telemetry.attempts.push(tentativaTele);
                    }
                    // O que sobra do prazo de quem chamou (na primeira tentativa, o próprio `timeoutMs`). Provedor que vigia o
                    // silêncio não recebe prazo (ADR-027).
                    const restanteDaTentativa = vigiaSilencio ? undefined : restanteDoPrazo();
                    const timeoutDaTentativa = vigiaSilencio ? undefined
                        : (timeoutMs && restanteDaTentativa !== undefined) ? Math.min(timeoutMs, Math.max(1, restanteDaTentativa)) : timeoutMs;
                    const chatOptions: ChatOptions = { signal: currentAbort.signal, timeoutMs: timeoutDaTentativa, reasoningIntensive: opts?.reasoningIntensive, telemetry: tentativaTele, raciocinio: opts?.raciocinio, saidaJson: opts?.saidaJson, limiteDeSaidaTokens: opts?.limiteDeSaidaTokens };
                    const chatPromise = provider.chat(mensagensDoProvider, tools, chatOptions);
                    let result: LLMResponse;

                    // Issue 047 (23/09/2026): este timer é uma camada de abort INDEPENDENTE do teto
                    // interno do provider (OllamaProvider.streamChat's MAX_TIMEOUT) — sem elevar
                    // também aqui, ele dispara com o `timeoutMs` original (aqui frequentemente ~30-60s,
                    // vindo de getBudgetAuxiliar('validacao') preso no piso) ANTES do teto interno já
                    // corretamente elevado pela issue 038 (240s) ter qualquer chance de agir.
                    // Reproduzido ao vivo: `[STREAM] maxTimeout=240000ms` seguido de
                    // `[STREAM] ABORTED ... duration=65619ms` — abortado por fora, não por dentro.
                    // ADR-027: para o provedor que vigia o silêncio, não há timer aqui — ele cortaria o modelo gerando.
                    const effectiveTimeoutMs = vigiaSilencio ? undefined
                        : restanteDaTentativa !== undefined ? Math.max(1, restanteDaTentativa) : prazoTotalMs;

                    if (effectiveTimeoutMs) {
                        const attemptTimeout = setTimeout(() => { prazoDaTentativaEsgotado = true; currentAbort.abort(); }, effectiveTimeoutMs);
                        // Safety timeout is 15s longer than the abort: gives _consumeStream time to
                        // recover thinking-as-content after the abort fires (both are async operations
                        // and the Promise.race reject would otherwise beat the recovery resolution).
                        const safetyTimeoutMs = effectiveTimeoutMs + 15000;
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
                        // ADR-027: sem relógio, o "Parar" ainda precisa valer NA HORA — inclusive com a chamada esperando vaga na
                        // fila do provedor (taskQueue), onde abortar o sinal não tira a tarefa da fila nem resolve a promessa. A
                        // tarefa que sair da fila depois encontra o sinal abortado e encerra sozinha (streamChat checa antes do fetch).
                        result = await new Promise<LLMResponse>((resolve, reject) => {
                            const aoParar = () => reject(new Error('Cancelled by external signal'));
                            if (externalSignal?.aborted) { aoParar(); return; }
                            externalSignal?.addEventListener('abort', aoParar, { once: true });
                            chatPromise.then(resolve, reject).finally(() => externalSignal?.removeEventListener('abort', aoParar));
                        });
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
                        if (tentativaTele) Object.assign(tentativaTele, { status: 'error', errorMessage: 'Aborted — no content', durationMs: Date.now() - attemptStart });
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
                        if (tentativaTele) Object.assign(tentativaTele, { status: 'success', durationMs: duration });
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
                            // Issue 060: o abort desta tentativa (teto de tempo) com conteúdo parcial também é interrupção.
                            interrupted: result.interrupted === true || currentAbort.signal.aborted ? true : result.interrupted,
                            attempts: attemptLog,
                        };
                    }

                    attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'empty' });
                    if (tentativaTele) Object.assign(tentativaTele, { status: 'empty', durationMs: duration });
                    log.warn(`[${attemptId}] Empty response, moving to next`);
                    break;
                } catch (error) {
                    const duration = Date.now() - attemptStart;
                    activeAbortController = null;
                    if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);

                    // External cancel trumps all other error classification
                    if (externalSignal?.aborted) {
                        log.info(`[${attemptId}] Cancelled by external signal`);
                        // O modelo REAL da tentativa, como nas falhas abaixo. Gravar o nome do provedor aqui fazia o [LLM-CALL] de uma
                        // chamada cancelada pelo prazo mostrar `model=ollama` — parecia um modelo local de reserva (não era: era o
                        // modelo escolhido, servido pelo provedor Ollama), e levou a um diagnóstico errado (logs de 12/10/2026).
                        const provCancelado = this.providers.get(providerName);
                        const modeloCancelado = attemptModel ?? ((provCancelado instanceof OllamaProvider) ? provCancelado.getModel() : (provCancelado as { model?: string })?.model || providerName);
                        attemptLog.push({ provider: providerName, model: modeloCancelado, duration, status: 'cancelled', errorMessage: 'Cancelled' });
                        if (tentativaTele) Object.assign(tentativaTele, { status: 'cancelled', durationMs: duration });
                        return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                    }

                    // O modelo registrado numa tentativa FALHADA é o da instância da requisição (`attemptModel`), não o
                    // da instância compartilhada: recalculá-lo daqui gravava o modelo PADRÃO em toda tentativa falhada e
                    // o `[LLM-CALL]` mostrava `model=glm-5.3` para uma chamada feita com o modelo leve (issue 048).
                    const prov = this.providers.get(providerName);
                    const modelUsed = attemptModel ?? ((prov instanceof OllamaProvider) ? prov.getModel() : (prov as { model?: string })?.model || providerName);
                    const isTimeout = errorMessage(error)?.includes('Timeout');
                    // 'Empty response from stream' (OllamaProvider) é lançado deliberadamente
                    // "para que ProviderFactory possa retentar" (ver comentário na origem) — mas
                    // essa string nunca esteve nesta lista, então isRetryable sempre dava false e
                    // o pedido era descartado após 1 tentativa (attempts=1) em vez de retentar.
                    // Reproduzido ao vivo (auditoria 09/07): dezenas de "EMPTY after 1 chunks" em
                    // <3s cada — glitch transitório do provider, não erro permanente — cascateando
                    // em replans desnecessários (prompt cresce a cada replan) até esgotar o goal.
                    // Issue 064b: prazo de quem chamou esgotado (o provider marca `deadlineExceeded`; o timer de tentativa
                    // daqui marca `prazoDaTentativaEsgotado`) NÃO é falha transitória — retentar com o mesmo prazo só
                    // repete a espera. Produção, 07/10: RiskAnalyzer pediu 60 s e gastou 192 s (2 tentativas por streaming
                    // + refação sem streaming, todas no prazo). Conexão/atividade travada, rede e resposta vazia seguem
                    // retentáveis como antes.
                    const prazoDestaTentativa = prazoDaTentativaEsgotado || (error as { deadlineExceeded?: boolean })?.deadlineExceeded === true;
                    if (prazoDestaTentativa) prazoEsgotado = true;
                    const isRetryable = !prazoDestaTentativa && (isTimeout ||
                        errorMessage(error)?.includes('abort') ||
                        errorMessage(error)?.includes('ECONNRESET') ||
                        errorMessage(error)?.includes('fetch failed') ||
                        errorMessage(error)?.includes('network') ||
                        errorMessage(error)?.includes('Empty response from stream'));

                    log.warn(`[${attemptId}] FAILED ${errorMessage(error)} duration=${duration}ms retryable=${isRetryable && attempt < MAX_RETRIES}${prazoDestaTentativa ? ' reason=caller_deadline' : ''}`);
                    attemptLog.push({
                        provider: providerName,
                        model: modelUsed,
                        duration,
                        status: isTimeout ? 'timeout' : 'error',
                        errorMessage: errorMessage(error)
                    });

                    if (tentativaTele) Object.assign(tentativaTele, { status: (isTimeout || prazoDestaTentativa) ? 'timeout' : 'error', errorMessage: errorMessage(error), durationMs: duration });
                    this.registrarFalhaSeForAvaria(providerName, errorMessage(error));

                    if (isRetryable && attempt < MAX_RETRIES) continue;
                    break;
                }
            }
        }

        // All streaming attempts exhausted — try non-streaming, SÓ quando o declarado já é o Ollama: é o mesmo recurso
        // e o mesmo modelo por outro transporte. Com outro provedor declarado, a refação no Ollama seria um provedor e um
        // modelo que o usuário não escolheu — não é tentada (ADR-018; antes, este bloco era o segundo caminho de
        // substituição, com a política da RFC-005 aplicada a ele também).
        const podeTentarNaoStreaming = declarado === 'ollama';
        if (prazoEsgotado) {
            log.info(`[${requestId}] Prazo de quem chamou esgotado — sem refação sem streaming (mesmo modelo, mesmo prazo)`);
        }
        if (!prazoEsgotado && podeTentarNaoStreaming && attemptLog.every(a => a.status === 'timeout' || a.status === 'error')) {
            const sharedOllama = this.providers.get('ollama');
            // O fallback sem streaming respeita o MODELO que o chamador pediu, como o streaming já respeita
            // (linha do `getProviderWithModel` acima). Antes ele usava a instância compartilhada, com o modelo
            // PADRÃO, e trocava em silêncio o modelo configurado para o juiz/planejador/revisor: com
            // OBSERVER_MODEL=glm-5.3-flash, o streaming estourava o orçamento de raciocínio e a refação rodava
            // no glm-5.3 pesado, que dava timeout (replay do incidente, 26/09/2026, issue 048). Só vale quando o
            // modelo pedido pertence ao Ollama (`modelOverrideOwner`): um nome de modelo de outro provedor não
            // faz sentido para ele e continua indo com o padrão.
            const requestedForOllama = (modelOverride && modelOverrideOwner === 'ollama')
                ? this.getProviderWithModel(modelOverride, 'ollama')
                : undefined;
            const ollamaProvider = requestedForOllama instanceof OllamaProvider ? requestedForOllama : sharedOllama;
            if (ollamaProvider instanceof OllamaProvider) {
                log.info(`[${requestId}] All streaming attempts failed — trying non-streaming fallback (model=${ollamaProvider.getModel()})`);
                const mensagensNaoStreaming = messages;
                try {
                    // Issue 047: mesmo raciocínio do timer de tentativa acima — fallbackNonStreaming()
                    // nem recebe reasoningIntensive (não precisa: é uma chamada única, sem teto de
                    // "thinking" interno próprio), mas o timeoutMs passado por fora precisa do mesmo
                    // piso, ou uma chamada pesada que só chegou até aqui por já ter estourado o
                    // streaming abortaria de novo, cedo demais, na última tentativa.
                    // Campanha 09/10: e só o que sobra do prazo total de quem chamou. ADR-027: o streaming do Ollama não tinha
                    // relógio (pode ter trabalhado além do prazo antes de ficar em silêncio) — a refação sem streaming, que não
                    // tem sinal de progresso, recebe o prazo pelo trabalho inteiro de quem chamou.
                    const restanteNaoStreaming = this.providers.get('ollama')?.vigiaSilencio === true ? undefined : restanteDoPrazo();
                    const effectiveNonStreamingTimeoutMs = restanteNaoStreaming !== undefined ? Math.max(1, restanteNaoStreaming) : prazoTotalMs;
                    const teleNaoStreaming: AttemptTelemetry | undefined = opts?.telemetry
                        ? { provider: 'ollama', model: `${ollamaProvider.getModel()} (sem streaming)`, startedAt: new Date().toISOString() } : undefined;
                    if (teleNaoStreaming) opts!.telemetry!.attempts.push(teleNaoStreaming);
                    const t0NaoStreaming = Date.now();
                    const result = await ollamaProvider.fallbackNonStreaming(mensagensNaoStreaming, tools, effectiveNonStreamingTimeoutMs, undefined, opts?.raciocinio, opts?.saidaJson, opts?.limiteDeSaidaTokens)
                        .catch((e) => { if (teleNaoStreaming) Object.assign(teleNaoStreaming, { status: 'error', errorMessage: errorMessage(e), durationMs: Date.now() - t0NaoStreaming }); throw e; });
                    if (teleNaoStreaming) Object.assign(teleNaoStreaming, { status: result.content?.trim() ? 'success' : 'empty', durationMs: Date.now() - t0NaoStreaming, contentChars: (result.content || '').length, contentText: result.content || '' });
                    if (result.content && result.content.trim()) {
                        attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'success' });
                        return {
                            status: 'success',
                            content: result.content,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            interrupted: result.interrupted,
                            fallbackReason: 'streaming_failed',
                            attempts: attemptLog,
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

        // `fallbackMessage` fixa em português mantém o débito de i18n do Core já declarado em `ARCHITECTURE.md`
        // ("Gaps conhecidos"). Sem reserva (ADR-018), a indisponibilidade do escolhido É o resultado.

        return {
            status: isTimeoutError ? 'timeout' : 'error',
            content: '',
            toolCalls: undefined,
            fallbackReason: isTimeoutError ? 'timeout' : 'error' as FallbackReason,
            // "Demorou mais que o esperado" só é verdade para timeout. Uma falha que não é timeout
            // (ex.: `fetch failed` em 4 ms, provider fora do ar) recebia o mesmo texto e mandava o
            // usuário esperar por algo que nunca ia responder. Sem inferir a causa (DNS, recusa,
            // TLS): o fato observado é que o provider não respondeu.
            // Issue 068: sem modelo escolhido, a mensagem diz isso — não "verifique se o serviço está em execução".
            // A mensagem diz O QUE o provedor respondeu (AGENTS.md, regra 11), sem prescrever. Antes era sempre "verifique se o
            // serviço está em execução": produção, 18/10/2026, o Ollama respondeu HTTP 429 (limite de uso) — o serviço estava no
            // ar e a orientação mandava procurar o defeito no lugar errado.
            fallbackMessage: lastError === NO_MODEL_CONFIGURED_MESSAGE ? NO_MODEL_CONFIGURED_MESSAGE : isTimeoutError
                ? 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.'
                : `Não foi possível obter resposta do provedor "${attemptLog[attemptLog.length - 1]?.provider ?? 'desconhecido'}". `
                    + (lastError ? `Resposta da última tentativa: ${mascararSegredos(lastError.replace(/\s+/g, ' ')).slice(0, 300)}` : 'A última tentativa não trouxe mensagem de erro.'),
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
     * Issue 071: esta tentativa (provider + modelo que ele usaria) fica na máquina do usuário? O endereço não basta —
     * o Ollama local com um modelo `:cloud` processa na nuvem.
     */
    private tentativaFicaNaMaquina(providerName: string, modelo?: string): boolean {
        if (!this.rodaNaMaquinaDoUsuario(providerName)) return false;
        return !(providerName === 'ollama' && ehModeloDaNuvemDoOllama(modelo));
    }

    /**
     * Issue 071: usar este modelo respeita a escolha do usuário de onde rodar? Falso quando o provedor padrão fica na
     * máquina do usuário e o modelo é de nuvem. Para sugestões por fora da cadeia normal — ex.: a lista de candidatos a
     * juiz: quem roda só local não recebe sugestão de nuvem. A escolha explícita do usuário (MODEL_*) não passa por aqui.
     */
    modeloPermitidoPelaSoberania(modelo: string): boolean {
        if (!this.providers.has(this.defaultProvider) || !this.tentativaFicaNaMaquina(this.defaultProvider, this.modeloPadraoDe(this.defaultProvider))) return true;
        return !ehModeloDaNuvemDoOllama(modelo);
    }

    /** Modelo que o provider usa quando a chamada não pede um. */
    private modeloPadraoDe(providerName: string): string | undefined {
        const p = this.providers.get(providerName);
        if (p instanceof OllamaProvider) return p.getModel();
        return (p as { model?: string } | undefined)?.model;
    }

    /**
     * Este provider roda na máquina do usuário? Pergunta de LOCALIDADE, diferente da de `loopbackPortOf` ("é um runtime
     * local gerenciado pelo NewClaw?", restrita a `customConfigs` — S205-4): aqui o Ollama nativo entra, pelo endereço.
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

    // (endpointKey/dedupeByEndpoint removidos em 14/10/2026: colapsavam rótulos duplicados na CADEIA DE RESERVA, que deixou de
    //  existir — só o provedor declarado atende. O aviso de endereço duplicado continua no painel, checkDuplicateEndpoints.)

    /**
     * Quem atende a chamada: SÓ o provedor declarado (o do papel/perfil, ou o principal). Diretiva da mantenedora (14/10/2026):
     * nenhum modelo nem provedor que o usuário não escolheu responde por ele — nem como reserva. Antes, todos os provedores com
     * chave entravam atrás numa ordem fixa ('ollama', 'openrouter', 'anthropic', 'gemini', 'deepseek', 'groq'), cada um com o
     * modelo embutido no próprio construtor. Provedor declarado e não configurado → lista vazia (a chamada avisa).
     */
    private getFallbackOrder(preferred?: string): string[] {
        const declarado = preferred || this.defaultProvider;
        if (declarado && this.providers.has(declarado)) return [declarado];
        log.warn(`[ESCOLHA] provedor "${declarado || '(nenhum escolhido)'}" não está configurado — nenhum outro é usado no lugar dele`);
        return [];
    }

    /**
     * Atualiza uma API key em runtime (chamado pelo dashboard após o usuário salvar).
     * Substitui a credential em creds e recria a instância do provider no mapa.
     */
    updateCredential(key: 'geminiKey' | 'deepseekKey' | 'groqKey' | 'openrouterKey' | 'anthropicKey', value: string): void {
        this.creds[key] = value;
        const m = this.creds.modelosNativos;
        switch (key) {
            case 'geminiKey':     this.providers.set('gemini',     new GeminiProvider(value, m.gemini ?? ''));          break;
            case 'deepseekKey':   this.providers.set('deepseek',   new DeepSeekProvider(value, m.deepseek ?? ''));      break;
            case 'groqKey':       this.providers.set('groq',       new GroqProvider(value, m.groq ?? ''));              break;
            case 'openrouterKey': this.providers.set('openrouter', new OpenRouterProvider(value, m.openrouter ?? ''));  break;
            case 'anthropicKey':  this.providers.set('anthropic',  new AnthropicProvider(value, m.anthropic ?? ''));    break;
        }
        log.info(`Credential updated and provider recreated: ${key.replace('Key', '')}`);
    }

    /** O usuário escolheu (no painel) o modelo de um provedor nativo: vale na hora, para a instância compartilhada também. */
    setModeloNativo(provedor: keyof ModelosNativos, modelo: string): void {
        this.creds.modelosNativos[provedor] = modelo;
        const chave = this.creds[`${provedor}Key` as 'geminiKey'];
        if (chave) this.updateCredential(`${provedor}Key` as 'geminiKey', chave);
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
