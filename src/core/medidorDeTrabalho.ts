/**
 * Medidor do trabalho do modelo em TOKENS (ADR-024, etapa 1 — SOMBRA). Só observa e registra: nenhuma decisão de corte
 * depende dele nesta etapa.
 *
 * Por quê: os prazos das chamadas são em segundos, calibrados com modelos de nuvem (~370 tokens/s). Um modelo local medido
 * (Bonsai 27B) gera ~38 tokens/s e lê 400–880 tokens/s — os mesmos prazos cortam trabalho legítimo. Em tokens, a mesma
 * tarefa tem o mesmo tamanho em qualquer modelo; a velocidade MEDIDA de cada modelo só converte em tempo.
 *
 * Tudo é por MODELO e MODO DE RACIOCÍNIO (livre / desligado / padrão) — nunca por provedor (a latência por provedor
 * misturava modelos de nuvem e locais do mesmo Ollama). O orçamento-sombra é por modelo + modo + TIPO de chamada
 * (componente:fase — cada juiz, o agente, o planejador…), aprendido do que deu certo: percentil 95 × 1,5, com amostra mínima.
 *
 * Contabilidade: entrada (tokens do prompt), saída (raciocínio + resposta). O servidor informa a saída junta; a divisão
 * entre raciocínio e resposta é ESTIMADA pela proporção de caracteres — e o registro diz que é estimada. Numa chamada
 * cortada o servidor não informa tokens: a saída é estimada pelos pedaços recebidos (~1 token por pedaço no streaming do
 * Ollama) e a entrada pelos caracteres (3,55 caracteres/token, medido em pt-BR em 15/10/2026).
 */
import * as fs from 'fs';
import * as path from 'path';

export type ModoDeRaciocinio = 'livre' | 'desligado' | 'padrao';
export type DesfechoDaChamada = 'concluiu' | 'limite_de_tokens' | 'cortada_pelo_relogio' | 'cancelada' | 'erro';

export interface ObservacaoDeChamada {
    modelo: string;
    modo: ModoDeRaciocinio;
    /** componente:fase (ex.: ValidationEngine:risco_do_plano, AgentLoop:loop). */
    tipo: string;
    entradaTokens: number;
    saidaTokens: number;
    raciocinioTokens: number;
    respostaTokens: number;
    /** Tempo de leitura do prompt / de geração (ms), quando medidos. */
    msLeitura?: number;
    msGeracao?: number;
    msTotal: number;
    msAtePrimeiroToken?: number;
    desfecho: DesfechoDaChamada;
    /** 'servidor' = números do provedor; 'estimado' = contagem própria (chamada cortada, sem números do servidor). */
    fonte: 'servidor' | 'estimado';
    /**
     * De onde vêm os TEMPOS de leitura/geração: 'servidor' (o provedor mediu — Ollama local, llama-server) ou 'cliente' (o
     * relógio do NewClaw: até o 1º token = leitura, o resto = geração; inclui a rede). O Ollama Cloud não devolve
     * prompt_eval_duration/eval_duration — só total_duration (medido em 16/10/2026).
     */
    tempos?: 'servidor' | 'cliente';
}

interface Velocidade { geracao: number[]; leitura: number[] }
interface Dados {
    /** chave modelo|modo → amostras de tokens/s (últimas N). */
    velocidades: Record<string, Velocidade>;
    /** chave modelo|modo|tipo → tokens de saída das chamadas que CONCLUÍRAM (últimas N). */
    saidas: Record<string, number[]>;
    /** chave modelo|modo|tipo → contadores de desfecho. */
    desfechos: Record<string, Partial<Record<DesfechoDaChamada, number>>>;
}

const MAX_AMOSTRAS = 200;
/** Amostra mínima de chamadas concluídas para haver orçamento-sombra (abaixo disso: "sem histórico", declarado). */
export const AMOSTRA_MINIMA = 5;
/** Folga sobre o percentil 95 do que deu certo. */
export const FOLGA = 1.5;
export const CHARS_POR_TOKEN_PTBR = 3.55;

const mediana = (v: number[]): number | undefined => {
    if (!v.length) return undefined;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};
const percentil = (v: number[], p: number): number | undefined => {
    if (!v.length) return undefined;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const empurrar = (v: number[], x: number) => { v.push(x); if (v.length > MAX_AMOSTRAS) v.splice(0, v.length - MAX_AMOSTRAS); };

export class MedidorDeTrabalho {
    private dados: Dados = { velocidades: {}, saidas: {}, desfechos: {} };
    private arquivo?: string;

    persistirEm(arquivo: string): void {
        this.arquivo = arquivo;
        try {
            if (fs.existsSync(arquivo)) {
                const lido = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as Partial<Dados>;
                this.dados = { velocidades: lido.velocidades ?? {}, saidas: lido.saidas ?? {}, desfechos: lido.desfechos ?? {} };
            }
        } catch { /* ilegível: recomeça — medição é conveniência, não requisito */ }
    }

    /** Velocidade típica MEDIDA (mediana) de um modelo num modo; `undefined` sem medição. */
    velocidade(modelo: string, modo: ModoDeRaciocinio): { geracao?: number; leitura?: number; amostras: number } {
        const v = this.dados.velocidades[`${modelo}|${modo}`];
        return { geracao: v ? mediana(v.geracao) : undefined, leitura: v ? mediana(v.leitura) : undefined, amostras: v?.geracao.length ?? 0 };
    }

    /** Orçamento-sombra em tokens de saída para modelo + modo + tipo; `null` sem amostra mínima de chamadas que concluíram. */
    orcamento(modelo: string, modo: ModoDeRaciocinio, tipo: string): { tokens: number; amostras: number } | null {
        const v = this.dados.saidas[`${modelo}|${modo}|${tipo}`] ?? [];
        if (v.length < AMOSTRA_MINIMA) return null;
        return { tokens: Math.ceil((percentil(v, 0.95) ?? 0) * FOLGA), amostras: v.length };
    }

    /**
     * Registra uma chamada e devolve a linha de sombra: o que um limite por TOKENS teria feito × o que o relógio fez. O
     * orçamento é consultado ANTES de incluir esta chamada (é o que estaria valendo no momento dela).
     */
    registrar(o: ObservacaoDeChamada): string {
        const orc = this.orcamento(o.modelo, o.modo, o.tipo);
        const chaveV = `${o.modelo}|${o.modo}`;
        const chaveT = `${o.modelo}|${o.modo}|${o.tipo}`;
        // Velocidades só de números do servidor (estimativa não entra na média de velocidade).
        if (o.fonte === 'servidor') {
            const v = (this.dados.velocidades[chaveV] ??= { geracao: [], leitura: [] });
            if (o.msGeracao && o.msGeracao > 0 && o.saidaTokens > 0) empurrar(v.geracao, o.saidaTokens / (o.msGeracao / 1000));
            if (o.msLeitura && o.msLeitura > 0 && o.entradaTokens > 0) empurrar(v.leitura, o.entradaTokens / (o.msLeitura / 1000));
        }
        if (o.desfecho === 'concluiu') empurrar((this.dados.saidas[chaveT] ??= []), o.saidaTokens);
        const d = (this.dados.desfechos[chaveT] ??= {});
        d[o.desfecho] = (d[o.desfecho] ?? 0) + 1;
        this.salvar();

        const vel = this.velocidade(o.modelo, o.modo);
        const r = (x: number | undefined, casas = 0) => (x === undefined ? '?' : x.toFixed(casas));
        const teriaCortado = orc ? (o.saidaTokens > orc.tokens ? 'sim' : 'nao') : 'sem_historico';
        // Quanto tempo o orçamento em tokens daria a ESTE modelo (leitura + geração na velocidade medida).
        const tempoDoOrcamento = orc && vel.geracao ? Math.round(orc.tokens / vel.geracao + (vel.leitura ? o.entradaTokens / vel.leitura : 0)) : undefined;
        return [
            `modelo=${o.modelo}`, `modo=${o.modo}`, `tipo=${o.tipo}`, `desfecho=${o.desfecho}`, `fonte=${o.fonte}`,
            `tempos=${o.tempos ?? '?'}`, `entrada=${o.entradaTokens}`, `saida=${o.saidaTokens}`, `raciocinio≈${o.raciocinioTokens}`, `resposta≈${o.respostaTokens}`,
            `ms=${o.msTotal}`, `primeiro_token_ms=${r(o.msAtePrimeiroToken)}`,
            `geracao=${r(vel.geracao, 1)}tok/s`, `leitura=${r(vel.leitura)}tok/s`, `amostras_vel=${vel.amostras}`,
            `orcamento_tokens=${orc ? orc.tokens : 'sem_historico'}`, `amostras_orc=${orc?.amostras ?? 0}`,
            `teria_cortado_por_tokens=${teriaCortado}`, `relogio_cortou=${o.desfecho === 'cortada_pelo_relogio' ? 'sim' : 'nao'}`,
            `tempo_que_o_orcamento_daria_s=${r(tempoDoOrcamento)}`,
        ].join(' ');
    }

    /** Fotografia para relatório e testes. */
    resumo(): Dados { return JSON.parse(JSON.stringify(this.dados)) as Dados; }

    private salvar(): void {
        if (!this.arquivo) return;
        try {
            fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
            fs.writeFileSync(this.arquivo, JSON.stringify(this.dados));
        } catch { /* observabilidade nunca derruba a chamada */ }
    }
}

/** O que a observação precisa de uma tentativa (subconjunto de AttemptTelemetry, para o módulo ficar sem dependências). */
export interface TentativaObservada {
    model?: string;
    status?: string;
    durationMs?: number;
    chunks?: number;
    firstChunkMs?: number;
    thinkingChars?: number;
    contentChars?: number;
    doneReason?: string;
    promptTokens?: number;
    evalTokens?: number;
    promptEvalMs?: number;
    evalMs?: number;
}

/** Tempos de leitura e geração: os do servidor quando ele informa; senão, os do relógio do cliente (declarados como tal). */
function temposDaChamada(t: TentativaObservada, msTotal: number): { msLeitura?: number; msGeracao?: number; tempos?: 'servidor' | 'cliente' } {
    if (t.evalMs !== undefined || t.promptEvalMs !== undefined) return { msLeitura: t.promptEvalMs, msGeracao: t.evalMs, tempos: 'servidor' };
    if (t.firstChunkMs !== undefined && msTotal > t.firstChunkMs) return { msLeitura: t.firstChunkMs, msGeracao: msTotal - t.firstChunkMs, tempos: 'cliente' };
    return {};
}

/**
 * Monta a observação de uma chamada a partir do que o provedor informou (números do servidor) ou, numa chamada cortada, do
 * que se contou (pedaços e caracteres — declarado como 'estimado'). Função pura.
 */
export function observacaoDaChamada(e: {
    modelo: string;
    modo: ModoDeRaciocinio;
    tipo: string;
    status: string;
    tentativa?: TentativaObservada;
    usage?: { prompt_tokens: number; completion_tokens: number };
    charsDeEntrada: number;
    msTotal: number;
    canceladaPeloUsuario: boolean;
}): ObservacaoDeChamada {
    const t = e.tentativa ?? {};
    const doServidor = (t.evalTokens ?? e.usage?.completion_tokens) !== undefined && (t.evalTokens ?? e.usage?.completion_tokens)! > 0;
    const saida = doServidor ? (t.evalTokens ?? e.usage?.completion_tokens ?? 0) : (t.chunks ?? 0);
    const entrada = (t.promptTokens ?? e.usage?.prompt_tokens) || Math.round(e.charsDeEntrada / CHARS_POR_TOKEN_PTBR);
    const cR = t.thinkingChars ?? 0, cC = t.contentChars ?? 0;
    const raciocinio = cR + cC > 0 ? Math.round(saida * (cR / (cR + cC))) : 0;
    const desfecho: DesfechoDaChamada =
        e.status === 'success' ? (t.doneReason === 'length' ? 'limite_de_tokens' : 'concluiu')
        : e.canceladaPeloUsuario ? 'cancelada'
        : (e.status === 'timeout' || e.status === 'cancelled') ? 'cortada_pelo_relogio'
        : 'erro';
    return {
        modelo: t.model || e.modelo, modo: e.modo, tipo: e.tipo,
        entradaTokens: entrada, saidaTokens: saida, raciocinioTokens: raciocinio, respostaTokens: saida - raciocinio,
        ...temposDaChamada(t, e.msTotal),
        msTotal: e.msTotal, msAtePrimeiroToken: t.firstChunkMs,
        desfecho, fonte: doServidor ? 'servidor' : 'estimado',
    };
}

/** O medidor do processo (persistido em data/ no boot, como o perfil do juiz). */
export const medidorDoProcesso = new MedidorDeTrabalho();
