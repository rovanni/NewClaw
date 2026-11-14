/**
 * ADR-027 para todos os provedores: a chamada com streaming só para por TRAVAMENTO, nunca por duração.
 *
 * Dois relógios, o mesmo desenho do mercado (pesquisado em 14/11/2026: Vercel AI SDK `timeout.firstChunkMs`/`chunkMs`,
 * LangChain `stream_chunk_timeout`, BAML `idle_timeout_ms`, Qwen Code "stream inactivity timeout"):
 *   - PRIMEIRO PEDAÇO: nenhum pedaço com conteúdo desde o início (o servidor ainda lê o prompt);
 *   - SILÊNCIO: nenhum pedaço com conteúdo desde o último (`silencioDoModeloMs`, padrão 90 s).
 * Só pedaço com CONTEÚDO do modelo (texto, raciocínio, chamada de ferramenta, fim) reinicia os relógios. Comentário SSE de
 * keepalive (OpenRouter `: OPENROUTER PROCESSING`), `ping` da Anthropic, metadados e delta vazio não reiniciam — senão um
 * servidor travado que só mantém a conexão viva nunca seria detectado.
 *
 * Antes daqui, os relógios viviam só em `OllamaProvider.streamChat`. Este módulo é a fonte única: o Ollama usa o vigia
 * (`VigiaDeSilencio`) e a telemetria ao vivo; os provedores com SSE (OpenAI-compatível, Anthropic, Gemini) usam também o
 * leitor (`consumirStreamSSE`).
 */
import { Agent } from 'undici';
import { silencioDoModeloMs, TELEMETRY_SAMPLE_MS, type AttemptTelemetry, type LLMMessage, type RawApiChunk } from './providerTypes';
import { medidorDoProcesso, CHARS_POR_TOKEN_PTBR, FOLGA, type ModoDeRaciocinio } from './medidorDeTrabalho';

interface LogDoVigia {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

/**
 * Transporte sem prazo próprio. O `fetch` do Node desiste sozinho se os cabeçalhos não chegam em 300 s (`headersTimeout` do
 * undici) ou se o corpo fica 300 s sem bytes (`bodyTimeout`). Medido no Node 24.20 e no 22.23 (issue 066): servidor que
 * responde aos 310 s → `UND_ERR_HEADERS_TIMEOUT` aos 303,9 s. Na chamada vigiada, quem detecta travamento é o vigia; um prazo
 * do transporte cortaria a leitura de um prompt longo ou uma janela de silêncio configurada acima de 300 s.
 */
export const TRANSPORTE_SEM_PRAZO_PROPRIO = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const MODOS: ModoDeRaciocinio[] = ['padrao', 'livre', 'desligado'];

/**
 * Prazo do PRIMEIRO pedaço: o tempo que o servidor pode passar lendo o prompt sem mandar nada.
 *
 * Base (a regra que o `OllamaProvider` já usava): ~1 s por 30 tokens de entrada, entre 150 e 300 s (piso 150 s:
 * gemma4:31b-cloud levou até 84 s com ~3 mil tokens sob carga). Quando o medidor tem a velocidade de LEITURA medida pelo
 * servidor para este modelo (ADR-024), vale o maior entre a base e `tokens ÷ leitura × FOLGA` — sem teto, porque é medido.
 * Motivo: o modelo local lê a ~21 tokens/s (medido em 21/10/2026, S440); com um prompt de 10 mil tokens ele passaria de 300 s
 * em silêncio estando saudável. Usa a leitura mais lenta medida entre os modos (a leitura não depende do modo de raciocínio,
 * e a mais lenta não corta quem trabalha).
 */
export function prazoDoPrimeiroPedaco(messages: LLMMessage[], modelo: string): { ms: number; tokensDeEntrada: number; origem: string } {
    const chars = messages.reduce((soma, m) => soma + (m.content?.length || 0), 0);
    // Uma conversão só de caracteres em tokens (a do medidor, medida em pt-BR) para a base e para o prazo medido.
    const tokensDeEntrada = Math.ceil(chars / CHARS_POR_TOKEN_PTBR);
    const base = Math.max(150_000, Math.min(300_000, Math.ceil(tokensDeEntrada / 30) * 1000));
    const leituras = MODOS.map(modo => medidorDoProcesso.velocidade(modelo, modo).leitura).filter((v): v is number => typeof v === 'number' && v > 0);
    if (leituras.length === 0) return { ms: base, tokensDeEntrada, origem: 'base pelo tamanho do prompt' };
    const leitura = Math.min(...leituras);
    const medido = Math.ceil(tokensDeEntrada / leitura * FOLGA * 1000);
    return medido > base
        ? { ms: medido, tokensDeEntrada, origem: `leitura medida do modelo (${Math.round(leitura)} tok/s)` }
        : { ms: base, tokensDeEntrada, origem: 'base pelo tamanho do prompt (a leitura medida cabe nela)' };
}

/**
 * O pedaço traz conteúdo do MODELO? É a regra única que reinicia os relógios.
 *
 * Correção de 14/11/2026: antes, `candidates[0]` (Gemini) contava como atividade mesmo vazio, e todo
 * `content_block_start`/`content_block_stop` (Anthropic) também — um servidor travado que mandasse só a moldura nunca seria
 * detectado. Texto só de espaços não conta (mesma regra que o Ollama já usava).
 */
export function isChunkActive(chunk: RawApiChunk): boolean {
    if (chunk.done) return true;
    if (chunk.message) {
        if (chunk.message.content?.trim()) return true;
        if (chunk.message.thinking?.trim()) return true;
        if (chunk.message.reasoning?.trim()) return true;
        if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) return true;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta) {
        const raciocinio = (delta as { reasoning?: unknown }).reasoning;
        if (delta.content?.trim() || delta.reasoning_content?.trim() || delta.thinking?.trim()) return true;
        if (typeof raciocinio === 'string' && raciocinio.trim()) return true;
        if (delta.tool_calls?.some(tc => tc.id || tc.function?.name || tc.function?.arguments)) return true;
    }
    if (chunk.choices?.[0]?.finish_reason) return true;   // fim da geração (OpenAI-compatível)
    if (chunk.type === 'content_block_delta' && chunk.delta) {
        const d = chunk.delta as { text?: string; thinking?: string; partial_json?: string };
        return !!(d.text?.trim() || d.thinking?.trim() || d.partial_json);
    }
    if (chunk.type === 'content_block_start') {
        // Início de chamada de ferramenta traz o nome (conteúdo do modelo); início de bloco de texto vazio é só moldura.
        const bloco = (chunk as { content_block?: { type?: string; name?: string } }).content_block;
        return bloco?.type === 'tool_use' && !!bloco.name;
    }
    if (chunk.type === 'message_delta' && (chunk.delta as { stop_reason?: string } | undefined)?.stop_reason) return true;
    if (chunk.type === 'message_stop') return true;
    const candidato = chunk.candidates?.[0];
    if (candidato) {
        const partes = (candidato.content?.parts ?? []) as Array<{ text?: string; thought?: unknown; functionCall?: unknown }>;
        if (partes.some(p => (typeof p.text === 'string' && p.text.trim()) || p.functionCall)) return true;
        if ((candidato as { finishReason?: string }).finishReason) return true;   // fim da geração (Gemini)
    }
    return false;
}

export type MotivoDoCorte = 'sem_primeiro_pedaco' | 'silencio';

/**
 * Os dois relógios de uma chamada. `iniciar()` antes do `fetch` (a espera pelos cabeçalhos também é leitura do prompt);
 * `pedaco()` a cada pedaço com conteúdo; `encerrar()` no `finally`. Ao disparar, aborta o `controller` da chamada.
 */
export class VigiaDeSilencio {
    readonly silencioMs: number;
    private primeiro = false;
    private relogioDoPrimeiro: NodeJS.Timeout | null = null;
    private relogioDoSilencio: NodeJS.Timeout | null = null;
    private _motivo: MotivoDoCorte | undefined;

    constructor(private readonly o: { controller: AbortController; primeiroPedacoMs: number; id: string; log: LogDoVigia; silencioMs?: number }) {
        this.silencioMs = o.silencioMs ?? silencioDoModeloMs();
    }

    /** Por que o vigia cortou; `undefined` = não cortou (fim normal, erro ou "Parar"). */
    get motivo(): MotivoDoCorte | undefined { return this._motivo; }
    get recebeuPrimeiroPedaco(): boolean { return this.primeiro; }

    iniciar(): void {
        this.relogioDoPrimeiro = setTimeout(() => {
            if (this.primeiro) return;
            this._motivo = 'sem_primeiro_pedaco';
            this.o.log.error(`[${this.o.id}] [STREAM] CONNECTION TIMEOUT: No first chunk in ${this.o.primeiroPedacoMs}ms`);
            this.o.controller.abort();
        }, this.o.primeiroPedacoMs);
    }

    /** Chegou pedaço com conteúdo: o primeiro desliga o relógio do primeiro pedaço; todos reiniciam o do silêncio. */
    pedaco(): boolean {
        const eraOPrimeiro = !this.primeiro;
        if (eraOPrimeiro) {
            this.primeiro = true;
            if (this.relogioDoPrimeiro) { clearTimeout(this.relogioDoPrimeiro); this.relogioDoPrimeiro = null; }
        }
        if (this.relogioDoSilencio) clearTimeout(this.relogioDoSilencio);
        this.relogioDoSilencio = setTimeout(() => {
            this._motivo = 'silencio';
            this.o.log.warn(`[${this.o.id}] [STREAM] ACTIVITY TIMEOUT: No activity for ${this.silencioMs}ms`);
            this.o.controller.abort();
        }, this.silencioMs);
        return eraOPrimeiro;
    }

    encerrar(): void {
        if (this.relogioDoPrimeiro) { clearTimeout(this.relogioDoPrimeiro); this.relogioDoPrimeiro = null; }
        if (this.relogioDoSilencio) { clearTimeout(this.relogioDoSilencio); this.relogioDoSilencio = null; }
    }
}

/**
 * Gravador de voo ao vivo (ADR-013/024): a cada pedaço, quantos chegaram e quando chegou o último — é com isso que o juiz
 * (`ValidationEngine.decidirNoPrazo`) sabe que o modelo AINDA ESTÁ GERANDO e não o corta. Antes só o Ollama preenchia;
 * provedor sem estes campos era tido como em silêncio.
 */
export class TelemetriaAoVivo {
    private readonly inicio = Date.now();
    private proximaAmostra = TELEMETRY_SAMPLE_MS;
    pedacos = 0;

    constructor(private readonly tele?: AttemptTelemetry) {
        if (tele) tele.timeline = [];
    }

    pedaco(tipo: string, thinkingChars: number, contentChars: number): void {
        this.pedacos++;
        const tele = this.tele;
        if (!tele) return;
        tele.pedacosAteAgora = this.pedacos;
        tele.ultimoPedacoEm = Date.now();
        const ms = Date.now() - this.inicio;
        if (tele.firstChunkMs === undefined) { tele.firstChunkMs = ms; tele.firstChunkType = tipo; }
        if (tipo === 'content' && tele.firstContentMs === undefined) tele.firstContentMs = ms;
        while (ms >= this.proximaAmostra) {
            tele.timeline!.push({ ms: this.proximaAmostra, thinkingChars, contentChars });
            this.proximaAmostra += TELEMETRY_SAMPLE_MS;
        }
    }
}

/** Um evento SSE já lido: `evento` é o campo `event:` (Anthropic); `dados` é o JSON do campo `data:`. */
export interface EventoSSE {
    evento?: string;
    dados: RawApiChunk & Record<string, unknown>;
}

/**
 * Lê `text/event-stream` (especificação WHATWG): linhas `data:` acumulam (várias viram uma, unidas por `\n`), linha vazia
 * despacha, linha que começa com `:` é comentário (keepalive) e é ignorada, `data: [DONE]` (OpenAI) encerra. Linhas partidas
 * entre leituras são remontadas. Dado que não é JSON vai para o log e é ignorado.
 */
export async function* lerEventosSSE(corpo: ReadableStream<Uint8Array>, aoInvalido?: (bruto: string) => void): AsyncGenerator<EventoSSE> {
    const leitor = corpo.getReader();
    const decodificador = new TextDecoder();
    let pendente = '';
    let evento: string | undefined;
    let dados: string[] = [];
    let lidoAteOFim = false;
    function* despachar(): Generator<EventoSSE | 'fim'> {
        if (dados.length === 0) { evento = undefined; return; }
        const bruto = dados.join('\n');
        const nome = evento;
        dados = []; evento = undefined;
        if (bruto.trim() === '[DONE]') { yield 'fim'; return; }
        try { yield { evento: nome, dados: JSON.parse(bruto) }; } catch { aoInvalido?.(bruto); }
    }
    try {
        while (true) {
            const { done, value } = await leitor.read();
            if (done) lidoAteOFim = true;
            if (!done) pendente += decodificador.decode(value, { stream: true });
            else pendente += decodificador.decode();
            // Um `\r` no fim pode ser metade de um `\r\n` partido entre leituras: espera a próxima para não contar uma linha vazia a mais.
            const segurado = !done && pendente.endsWith('\r') ? '\r' : '';
            const linhas = (segurado ? pendente.slice(0, -1) : pendente).split(/\r\n|\r|\n/);
            pendente = done ? '' : (linhas.pop() ?? '') + segurado;
            for (const linha of linhas) {
                if (linha === '') {
                    for (const e of despachar()) { if (e === 'fim') return; yield e; }
                    continue;
                }
                if (linha.startsWith(':')) continue;   // comentário/keepalive: não é pedaço
                const i = linha.indexOf(':');
                const campo = i === -1 ? linha : linha.slice(0, i);
                let valor = i === -1 ? '' : linha.slice(i + 1);
                if (valor.startsWith(' ')) valor = valor.slice(1);
                if (campo === 'data') dados.push(valor);
                else if (campo === 'event') evento = valor;
            }
            if (done) {
                for (const e of despachar()) { if (e === 'fim') return; yield e; }   // último evento sem linha vazia final
                return;
            }
        }
    } finally {
        // Saída antes do fim do corpo ([DONE], erro no meio do stream, corte): cancela a leitura para a conexão não ficar presa
        // com bytes que ninguém lê (servidor que segue mandando keepalive depois de um erro).
        if (!lidoAteOFim) await leitor.cancel().catch(() => { /* já encerrado */ });
        leitor.releaseLock();
    }
}

/**
 * Uma chamada SSE vigiada, do `fetch` ao último evento. O provedor diz como abrir (`abrir`, que lança em erro HTTP) e o que
 * fazer com cada evento (`aoEvento`, que pode lançar num erro no meio do stream); os relógios e a regra de atividade ficam
 * aqui. Servidor que responde sem `text/event-stream` (ignorou o pedido de streaming) vai para `semStreaming`; sem ele, é erro
 * com o tipo recebido.
 *
 * Lança o erro do corte (o `AbortError` do `fetch`, como no Ollama — o `ProviderFactory` o trata como retentável). Quem chama
 * decide se o conteúdo já recebido vira resposta interrompida (issue 060).
 */
export async function consumirStreamSSE(o: {
    id: string;
    log: LogDoVigia;
    modelo: string;
    messages: LLMMessage[];
    signal?: AbortSignal;
    abrir: (signal: AbortSignal) => Promise<Response>;
    aoEvento: (e: EventoSSE) => void;
    semStreaming?: (resposta: Response) => Promise<void>;
}): Promise<{ vigia: VigiaDeSilencio }> {
    if (o.signal?.aborted) throw new Error('Aborted by external signal before fetch');
    const controller = new AbortController();
    const aoParar = () => controller.abort();
    o.signal?.addEventListener('abort', aoParar, { once: true });
    const primeiro = prazoDoPrimeiroPedaco(o.messages, o.modelo);
    const vigia = new VigiaDeSilencio({ controller, primeiroPedacoMs: primeiro.ms, id: o.id, log: o.log });
    const inicio = Date.now();
    o.log.info(`[${o.id}] [STREAM] START model=${o.modelo} inputTokens≈${primeiro.tokensDeEntrada} connectionTimeout=${primeiro.ms}ms (${primeiro.origem}) activityTimeout=${vigia.silencioMs}ms (sem teto de duração — ADR-027)`);
    vigia.iniciar();
    let eventos = 0;
    try {
        const resposta = await o.abrir(controller.signal);
        const tipo = resposta.headers.get('content-type') ?? '';
        if (!tipo.includes('text/event-stream')) {
            if (!o.semStreaming) throw new Error(`resposta sem streaming (content-type: ${tipo || 'ausente'})`);
            o.log.info(`[${o.id}] [STREAM] servidor respondeu sem streaming (content-type: ${tipo || 'ausente'}) — lida inteira`);
            await o.semStreaming(resposta);
            return { vigia };
        }
        if (!resposta.body) throw new Error('resposta sem corpo');
        for await (const e of lerEventosSSE(resposta.body, bruto => o.log.warn(`[${o.id}] [STREAM] evento que não é JSON (${bruto.length} chars): ${bruto.slice(0, 80)}`))) {
            eventos++;
            if (isChunkActive(e.dados) && vigia.pedaco()) o.log.info(`[${o.id}] [STREAM] First chunk received after ${Date.now() - inicio}ms`);
            o.aoEvento(e);
        }
        o.log.info(`[${o.id}] [STREAM] END eventos=${eventos} elapsed=${Date.now() - inicio}ms`);
        return { vigia };
    } catch (err) {
        const motivo = vigia.motivo ? ` (vigia: ${vigia.motivo === 'silencio' ? `${vigia.silencioMs} ms sem pedaço` : 'nenhum primeiro pedaço'})` : '';
        o.log.warn(`[${o.id}] [STREAM] ABORTED/ERROR after ${eventos} eventos, ${Date.now() - inicio}ms${motivo}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    } finally {
        vigia.encerrar();
        o.signal?.removeEventListener('abort', aoParar);
    }
}
