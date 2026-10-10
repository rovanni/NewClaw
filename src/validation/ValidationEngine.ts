/**
 * Motor único de validação (ADR-014, Sprint M0.2).
 *
 * Executa qualquer tipo registrado em `RegistroDeValidacoes`, sempre do mesmo jeito:
 *   1. confere as entradas obrigatórias — faltou alguma: não avaliável, SEM chamar o modelo;
 *   2. monta o prompt por seções, na mesma ordem para todo tipo (pergunta → pedido → objeto → fontes → contexto da
 *      execução → checklist → observações → formato), com corte só onde o descritor declara, e declarado no prompt;
 *   3. respeita o teto DECISION_PROMPT_MAX_CHARS — não cabe: não avaliável (nunca um veredito sobre um pedaço);
 *   4. chama o modelo do juiz (UMA chave para todos os tipos, `OBSERVER_MODEL`; vazia = modelo padrão do provedor), com
 *      o modo de raciocínio do tipo;
 *   5. lê a saída num formato só e roda as pré-verificações determinísticas declaradas;
 *   6. registra tudo no gravador de voo (`validacao_<tipo>`);
 *   7. devolve o veredito padrão e, se o descritor tiver adaptador, o formato do consumidor.
 *
 * O motor não conhece domínio nenhum: nunca há `if (tipo === ...)` aqui. Pergunta, entradas e checklist são do descritor.
 * Princípios: "Informação Completa para Decidir" (garantido pela estrutura) e "determinismo valida / LLM interpreta".
 */
import type { ProviderFactory } from '../core/ProviderFactory';
import { DECISION_PROMPT_MAX_CHARS, type CallTelemetry } from '../core/providerTypes';
import { createLogger } from '../shared/AppLogger';
import { gravarAvaliacao, novaAvaliacaoId, versaoDoPrompt, INSTRUCAO_FALTOU, INSTRUCAO_DIFICULDADE, type ContextoAvaliacao } from '../shared/evaluatorFlightRecorder';
import {
    RegistroDeValidacoes, lerSaidaDoModelo, agregarPorItens, citacaoExiste,
    type DescritorDeValidacao, type VereditoPadrao, type PapelDaEntrada,
} from './contratoDeValidacao';

const log = createLogger('ValidationEngine');

/** Chave de configuração do modelo do juiz — a mesma para todos os tipos (um juiz só; ver `DescritorDeValidacao.semVeredito`). */
export const CHAVE_DO_MODELO_DO_JUIZ = 'OBSERVER_MODEL';

const ORDEM_DAS_SECOES: PapelDaEntrada[] = ['contexto_do_usuario', 'objeto', 'fonte_de_verdade', 'contexto_da_execucao'];
const TITULO_DA_SECAO: Record<PapelDaEntrada, string> = {
    contexto_do_usuario: 'CONTEXTO DO USUÁRIO (não é evidência — serve para saber o que veio do usuário)',
    objeto: 'O QUE ESTÁ SENDO JULGADO',
    fonte_de_verdade: 'FONTES DE VERDADE (contra o que se julga)',
    contexto_da_execucao: 'CONTEXTO DA EXECUÇÃO',
};

export interface ResultadoDaValidacao<T> {
    veredito: VereditoPadrao;
    /** O motor não chegou a um veredito (modelo fora, prazo, saída inválida, acima do teto). */
    semVeredito: boolean;
    /**
     * Como a validação terminou, em código estável: `veredito` | `entrada_ausente` | `acima_do_teto` | `erro` | `saida_invalida` |
     * `llm_<status>` (o modelo não concluiu: timeout, error…). O consumidor que precisa distinguir a falha lê isto — nunca o texto.
     */
    desfecho: string;
    /** A saída crua do modelo (quando houve resposta) — para observabilidade (`TRACE_CONTENT`), nunca para decisão. */
    saidaBruta?: string;
    /** `semVeredito` + a política declarada pelo tipo é bloquear. O consumidor só lê isto — não reescreve a política. */
    deveBloquear: boolean;
    /** Saída do adaptador do descritor; sem adaptador, o próprio veredito. */
    adaptado: T;
}

export interface OpcoesDaChamada extends ContextoAvaliacao {
    signal?: AbortSignal;
}

/** Corte declarado — o modelo precisa distinguir "o dado acaba aqui" de "o sistema cortou aqui". */
function trechoDeclarado(texto: string, limite: number): string {
    if (texto.length <= limite) return texto;
    return `${texto.slice(0, limite)}\n[… trecho: primeiros ${limite} de ${texto.length} caracteres — o corte é do sistema, não do dado]`;
}

export class ValidationEngine {
    constructor(
        private readonly providerFactory: ProviderFactory,
        readonly registro: RegistroDeValidacoes = new RegistroDeValidacoes(),
        /** Resolve a chave de configuração do modelo do tipo (padrão: variável de ambiente). */
        private readonly resolverModelo: (chave: string) => string | undefined = (chave) => process.env[chave],
    ) {}

    /** Modelo do juiz escolhido em tempo de execução (painel: `updateConfig`); vence a variável de ambiente. */
    private modeloDoJuiz?: string;

    /** O ÚNICO ponto que muda o modelo de TODOS os tipos de validação (vazio/undefined = volta à configuração). */
    definirModeloDoJuiz(modelo: string | undefined): void {
        this.modeloDoJuiz = modelo?.trim() || undefined;
    }

    /** Monta o prompt do tipo — exportado para teste e para o gravador (versão do modelo de prompt). */
    montarPrompt(d: DescritorDeValidacao<unknown>, entradas: Record<string, string | undefined>): string {
        const secoes: string[] = [`Você é um validador. PERGUNTA: ${d.pergunta}`];
        for (const papel of ORDEM_DAS_SECOES) {
            // O pedido do usuário ausente é DECLARADO ao modelo ("(não informado)"), nunca omitido em silêncio: sem a marca, o
            // juiz não sabe se o pedido não existe ou se esqueceram de mostrá-lo (princípio Informação Completa para Decidir).
            const daSecao = d.entradas.filter(e => e.papel === papel && (papel === 'contexto_do_usuario' || (entradas[e.nome] !== undefined && entradas[e.nome] !== '')));
            if (!daSecao.length) continue;
            const corpo = daSecao.map(e => {
                const valor = entradas[e.nome] ? String(entradas[e.nome]) : '(não informado)';
                const texto = e.corteMaxChars !== undefined ? trechoDeclarado(valor, e.corteMaxChars) : valor;
                return `[${e.rotulo}]\n"""\n${texto}\n"""`;
            }).join('\n\n');
            secoes.push(`${TITULO_DA_SECAO[papel]}:\n${corpo}`);
        }
        secoes.push(`CHECKLIST — responda cada item:\n${d.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
        if (d.preVerificacoes?.includes('citacao_existe_na_fonte')) {
            // ADR-015: de onde a citação pode vir é declarado pelo tipo (padrão: só as fontes de verdade).
            const deOnde = (d.fontesDaCitacao ?? ['fonte_de_verdade']).map(p => TITULO_DA_SECAO[p].split(' (')[0]).join(' ou ');
            secoes.push(`Para cada item marcado "sim" ou "nao", copie em "trecho" o TRECHO LITERAL que o decide, de: ${deOnde} — exatamente como está escrito lá. O sistema confere se o trecho existe.`);
        }
        secoes.push(`${INSTRUCAO_FALTOU}\n${INSTRUCAO_DIFICULDADE}`);
        // ADR-015: campos extras declarados pelo tipo — pedidos com a instrução do descritor, no mesmo JSON.
        const extras = d.camposExtras ?? [];
        if (extras.length) secoes.push(`CAMPOS ADICIONAIS DA RESPOSTA:\n${extras.map(c => `- "${c.nome}": ${c.instrucao}`).join('\n')}`);
        const camposExtrasJson = extras.map(c => `,"${c.nome}":"..."`).join('');
        secoes.push(`Responda APENAS com JSON:\n{"estado":"aprovado|reprovado","itens":[{"item":"...","confere":"sim|nao|sem_evidencia","evidencia":"(opcional)","trecho":"(opcional)"}],"confianca":0.0,"motivo":"curto","faltou":"(opcional)","dificuldade":"(opcional)"${camposExtrasJson}}`);
        return secoes.join('\n\n');
    }

    async validar<T = VereditoPadrao>(tipo: string, entradas: Record<string, string | undefined>, opcoes: OpcoesDaChamada = {}): Promise<ResultadoDaValidacao<T>> {
        const d = this.registro.obter(tipo) as DescritorDeValidacao<T> | undefined;
        if (!d) throw new Error(`Tipo de validação não registrado: "${tipo}"`);
        const t0 = Date.now();
        const avaliacaoId = novaAvaliacaoId();
        const telemetria: CallTelemetry = { attempts: [] };
        const modelo = this.modeloDoJuiz ?? this.resolverModelo(CHAVE_DO_MODELO_DO_JUIZ) ?? '';
        let prompt = '';
        let saidaBruta: string | undefined;

        const concluir = (veredito: VereditoPadrao, desfecho: string): ResultadoDaValidacao<T> => {
            const v = { ...veredito, avaliacaoId };
            gravarAvaliacao({
                id: avaliacaoId, avaliador: `validacao_${d.tipo}`,
                contexto: { traceId: opcoes.traceId, conversationId: opcoes.conversationId, goalId: opcoes.goalId, stepId: opcoes.stepId, phase: opcoes.phase },
                antes: {
                    modelo: modelo || '(padrão do provedor)', versaoPrompt: versaoDoPrompt(this.montarPrompt(d, {})), promptChars: prompt.length,
                    fatos: {
                        raciocinio: d.raciocinio,
                        entradas: Object.fromEntries(d.entradas.map(e => [e.nome, entradas[e.nome] === undefined ? 'ausente' : `${String(entradas[e.nome]).length} chars`])),
                    },
                    conteudo: { prompt, entradas },
                },
                telemetria,
                depois: {
                    desfecho, estado: v.estado, duracaoMs: Date.now() - t0,
                    fatos: { itens: v.itens.length, confianca: v.confianca, faltouInformado: !!v.faltou, dificuldadeInformada: !!v.dificuldade, naoAvaliavelPorque: v.naoAvaliavelPorque },
                    conteudo: { saidaBruta, itens: v.itens, motivo: v.motivo, faltou: v.faltou, dificuldade: v.dificuldade, extras: v.extras },
                },
            });
            const semVeredito = v.estado === 'nao_avaliavel' && !!v.naoAvaliavelPorque;
            return { veredito: v, semVeredito, desfecho, saidaBruta, deveBloquear: semVeredito && d.semVeredito === 'bloquear', adaptado: (d.adaptador ? d.adaptador(v) : v) as T };
        };
        const naoAvaliavel = (porque: string, desfecho: string) =>
            concluir({ estado: 'nao_avaliavel', itens: [], naoAvaliavelPorque: porque }, desfecho);

        // 1. Entradas obrigatórias.
        const ausentes = d.entradas.filter(e => e.obrigatoria && !entradas[e.nome]?.trim()).map(e => e.nome);
        if (ausentes.length) {
            log.info(`[VALIDACAO] tipo=${d.tipo} entradas obrigatórias ausentes: ${ausentes.join(', ')} — não avaliável, sem chamar o modelo`);
            return naoAvaliavel(`entradas obrigatórias ausentes: ${ausentes.join(', ')}`, 'entrada_ausente');
        }

        // 2–3. Prompt por seções e teto.
        prompt = this.montarPrompt(d, entradas);
        if (prompt.length > DECISION_PROMPT_MAX_CHARS) {
            log.info(`[VALIDACAO] tipo=${d.tipo} prompt de ${prompt.length} chars excede ${DECISION_PROMPT_MAX_CHARS} — não avaliável`);
            return naoAvaliavel(`prompt de ${prompt.length} chars excede o teto de ${DECISION_PROMPT_MAX_CHARS}`, 'acima_do_teto');
        }

        // 4. Modelo do tipo, com o modo de raciocínio do tipo.
        const orcamento = this.providerFactory.getBudgetAuxiliar('validacao');
        let resultado;
        try {
            resultado = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }], undefined, undefined, orcamento.timeoutMs, opcoes.signal, modelo || undefined,
                { reasoningIntensive: d.raciocinio === 'livre', raciocinio: d.raciocinio, diag: { component: 'ValidationEngine', role: 'validator', phase: d.tipo, goalId: opcoes.goalId }, telemetry: telemetria },
            );
        } catch (err) {
            return naoAvaliavel(`erro na chamada: ${String(err).slice(0, 120)}`, 'erro');
        }
        if (resultado.status !== 'success') return naoAvaliavel(`modelo não concluiu (${resultado.status})`, `llm_${resultado.status}`);
        saidaBruta = resultado.content;

        // 5. Leitura estrutural e pré-verificações.
        const lido = lerSaidaDoModelo(saidaBruta || '', (d.camposExtras ?? []).map(c => c.nome));
        if (!lido) return naoAvaliavel('saída do modelo sem a estrutura do contrato', 'saida_invalida');
        if (d.preVerificacoes?.includes('citacao_existe_na_fonte')) {
            const papeisDaCitacao = d.fontesDaCitacao ?? ['fonte_de_verdade'];
            const fontes = d.entradas.filter(e => papeisDaCitacao.includes(e.papel)).map(e => entradas[e.nome] ?? '');
            for (const it of lido.itens) {
                if (it.confere === 'sim' || it.confere === 'nao') {
                    it.citacaoConfere = citacaoExiste(it.trecho ?? '', fontes);
                    if (!it.citacaoConfere) it.confere = 'sem_evidencia';   // citação que não está na fonte não decide nada
                }
            }
        }
        const estado = d.agregacao === 'itens' ? agregarPorItens(lido.itens) : (lido.estadoDoModelo ?? 'nao_avaliavel');
        const { estadoDoModelo: _ignorado, ...resto } = lido;
        return concluir({ ...resto, estado, naoAvaliavelPorque: estado === 'nao_avaliavel' && d.agregacao === 'modelo' && !lido.estadoDoModelo ? 'o modelo não declarou o estado' : undefined }, 'veredito');
    }
}
