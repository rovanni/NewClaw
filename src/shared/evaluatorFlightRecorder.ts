/**
 * Gravador de voo dos avaliadores (ADR-013, 07/10/2026).
 *
 * Um registro por julgamento — ANTES (o que o avaliador recebeu), DURANTE (o que o modelo fez em cada tentativa,
 * inclusive o raciocínio de uma geração abortada) e DEPOIS (o veredito e o que o sistema fez com ele) — num JSONL por
 * avaliador e por dia, ao lado do log de auditoria: `<pasta do LOG_FILE>/avaliadores/<avaliador>-AAAA-MM-DD.jsonl`.
 *
 * Origem: a investigação do juiz de grounding em 07/10 precisou RECONSTRUIR evidência cortada em 2000 caracteres,
 * ligar chamada e julgamento pelo horário, e não teve como saber no que o modelo gastou 240 s — o raciocínio era
 * descartado no abort. O log de auditoria (`[GROUNDING-TRACE]`, `[LLM-CALL]`) continua sendo o RESUMO; este é o detalhe.
 *
 * Regras:
 * - Liga junto com o log de auditoria (`LOG_FILE`): sem ele, nada é gravado.
 * - Conteúdo (prompt, evidência, resposta, raciocínio, saída bruta) só com `TRACE_CONTENT=true` — mesma chave que já
 *   governa o conteúdo do `[GROUNDING-TRACE]`. Sem ela, só fatos: tamanhos, tempos, estados, versão do prompt.
 * - Retenção: arquivos mais velhos que `EVALUATOR_LOG_RETENTION_DAYS` (padrão 14) são apagados na primeira gravação do dia.
 * - Observabilidade nunca afeta o julgamento: toda falha aqui é engolida.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { AttemptTelemetry, CallTelemetry } from '../core/providerTypes';
import { mascararProfundo } from './segredos';   // ADR-019: o registro em disco nunca leva valor do cofre

/** `validacao_<tipo>`: tipos executados pelo motor único (ADR-014). */
export type Avaliador = 'juiz_grounding' | 'validador_qualidade' | 'analise_risco' | `validacao_${string}`;

export interface ContextoAvaliacao {
    traceId?: string;
    conversationId?: string;
    goalId?: string;
    stepId?: string;
    phase?: string;
}

export interface RegistroAvaliacao {
    id: string;
    avaliador: Avaliador;
    contexto?: ContextoAvaliacao;
    antes: {
        modelo?: string;
        versaoPrompt: string;
        promptChars: number;
        orcamentoMs?: number;
        /** Fatos da entrada (tamanhos, contagens) — sempre gravados. */
        fatos?: Record<string, unknown>;
        /** Texto da entrada — só com TRACE_CONTENT=true. */
        conteudo?: Record<string, unknown>;
    };
    telemetria?: CallTelemetry;
    depois: {
        desfecho: string;
        estado?: string;
        duracaoMs: number;
        fatos?: Record<string, unknown>;
        /** Saída bruta e itens julgados — só com TRACE_CONTENT=true. */
        conteudo?: Record<string, unknown>;
    };
}

export interface RegistroEfeito {
    /** Id da avaliação que causou o efeito, quando o consumidor o tem; senão a ligação é por contexto (goal/step/trace). */
    avaliacaoId?: string;
    avaliador: Avaliador;
    contexto?: ContextoAvaliacao;
    efeito: string;
    detalhe?: Record<string, unknown>;
}

/** Teto por campo de texto — só para um registro patológico não virar um arquivo de centenas de MB. */
const MAX_TEXTO_CHARS = 300_000;

/**
 * Campo de observação dos avaliadores (Sprint C, 08/10/2026 — proposta do operador: "o LLM poderia dar um feedback
 * de algum problema que encontrou e não está conseguindo fazer a tomada de decisão", como a avaliação de fim de curso).
 * Texto ÚNICO, usado pelo motor compartilhado por todos os tipos de validação. Cada campo é opcional: o modelo só o inclui
 * quando houver algo a relatar. Se incluir, precisa fornecer uma descrição não vazia; o prompt pede que seja específica e
 * útil, e o leitor do contrato rejeita campo selecionado sem descrição. O conteúdo continua sendo observabilidade e não
 * altera a decisão julgada.
 */
export const INSTRUCAO_FALTOU =
    'Campo OPCIONAL "faltou": inclua-o somente se faltou informação para decidir com segurança. Se incluir, descreva em ' +
    'uma frase específica qual informação faltou, por que ela é necessária e, quando souber, que evidência resolveria a ' +
    'lacuna (ex.: "faltou o conteúdo da caixa de entrada; preciso da saída da leitura da conta para confirmar os e-mails"). ' +
    'Não escreva apenas "faltou informação" ou outra frase genérica. Omita o campo se nada faltou. Este relato não muda o veredito.';

/**
 * Campo de observação `dificuldade` (ADR-014, proposta do operador: "o validador vai ter o campo opcional para o LLM
 * registrar problemas e dificuldades, para utilizar como logs"). Complementa `faltou`: não é informação ausente, é outro
 * problema que atrapalhou a decisão. É opcional; se incluído, precisa descrever o que aconteceu e como isso afetou a
 * avaliação. Só observabilidade: nenhuma decisão lê o conteúdo.
 */
export const INSTRUCAO_DIFICULDADE =
    'Campo OPCIONAL "dificuldade": inclua-o somente se algo dificultou a decisão (por exemplo, pedido ambíguo, evidências ' +
    'contraditórias ou regra que não se aplica bem ao caso). Se incluir, descreva especificamente o que aconteceu, qual ' +
    'parte da avaliação foi afetada e, quando souber, o que permitiria corrigir ou esclarecer o problema. Não escreva apenas ' +
    '"houve dificuldade" ou outra frase genérica. Omita o campo se não houve dificuldade. Este relato não muda o veredito.';

/** Lê uma observação opcional da saída JSON. Estrutural: existência e tipo — o texto não é interpretado. */
function lerObservacao(saida: string | undefined, campo: 'faltou' | 'dificuldade'): string | undefined {
    if (!saida) return undefined;
    const limpo = saida.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) return undefined;
    try {
        const v = (JSON.parse(limpo.slice(inicio, fim + 1)) as Record<string, unknown>)[campo];
        return typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined;
    } catch { return undefined; }
}

export const lerFaltou = (saida: string | undefined): string | undefined => lerObservacao(saida, 'faltou');
export const lerDificuldade = (saida: string | undefined): string | undefined => lerObservacao(saida, 'dificuldade');

export function novaAvaliacaoId(): string {
    return `av_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** Versão do prompt = hash do MODELO de prompt (antes de preencher). Muda sozinha quando o texto do prompt muda. */
export function versaoDoPrompt(modelo: string): string {
    return createHash('sha1').update(modelo).digest('hex').slice(0, 8);
}

export function pastaAvaliadores(): string | null {
    const logFile = process.env.LOG_FILE;
    if (!logFile) return null;
    return path.join(path.dirname(logFile), 'avaliadores');
}

const conteudoLigado = (): boolean => process.env.TRACE_CONTENT === 'true';

function capar(v: unknown): unknown {
    if (typeof v === 'string') return v.length > MAX_TEXTO_CHARS ? `${v.slice(0, MAX_TEXTO_CHARS)}…[cortado no gravador: ${v.length} chars]` : v;
    if (Array.isArray(v)) return v.map(capar);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, capar(x)]));
    return v;
}

function tentativasParaGravar(tele: CallTelemetry | undefined): unknown {
    if (!tele) return undefined;
    return tele.attempts.map((a: AttemptTelemetry) => {
        const { thinkingText, contentText, ...fatos } = a;
        return conteudoLigado() ? { ...fatos, thinkingText, contentText } : fatos;
    });
}

let ultimaLimpeza = '';
function limparAntigos(pasta: string, hoje: string): void {
    if (ultimaLimpeza === hoje) return;
    ultimaLimpeza = hoje;
    const dias = Number(process.env.EVALUATOR_LOG_RETENTION_DAYS) > 0 ? Number(process.env.EVALUATOR_LOG_RETENTION_DAYS) : 14;
    const limite = Date.now() - dias * 86_400_000;
    for (const nome of fs.readdirSync(pasta)) {
        const m = nome.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && new Date(`${m[1]}T00:00:00`).getTime() < limite) fs.unlinkSync(path.join(pasta, nome));
    }
}

function gravar(avaliador: Avaliador, registro: Record<string, unknown>): void {
    try {
        const pasta = pastaAvaliadores();
        if (!pasta) return;
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
        const agora = new Date();
        const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
        limparAntigos(pasta, hoje);
        fs.appendFileSync(path.join(pasta, `${avaliador}-${hoje}.jsonl`), JSON.stringify(capar(mascararProfundo({ v: 1, ts: agora.toISOString(), ...registro }))) + '\n', 'utf8');
    } catch { /* observabilidade nunca pode afetar o julgamento */ }
}

export function gravarAvaliacao(r: RegistroAvaliacao): void {
    const { conteudo: conteudoAntes, ...antes } = r.antes;
    const { conteudo: conteudoDepois, ...depois } = r.depois;
    gravar(r.avaliador, {
        tipo: 'avaliacao', id: r.id, avaliador: r.avaliador, contexto: r.contexto,
        antes: conteudoLigado() ? { ...antes, conteudo: conteudoAntes } : antes,
        durante: { tentativas: tentativasParaGravar(r.telemetria) },
        depois: conteudoLigado() ? { ...depois, conteudo: conteudoDepois } : depois,
    });
}

export function gravarEfeito(r: RegistroEfeito): void {
    gravar(r.avaliador, { tipo: 'efeito', avaliacaoId: r.avaliacaoId, avaliador: r.avaliador, contexto: r.contexto, efeito: r.efeito, detalhe: r.detalhe });
}
