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
import { DECISION_PROMPT_MAX_CHARS, silencioDoModeloMs, type CallTelemetry } from '../core/providerTypes';
import { createLogger } from '../shared/AppLogger';
import { combinarSinais, sinalDoTurno } from '../shared/turnCancellation';
import { tetoDoPerfilAuxiliar } from '../shared/auxTimeout';

// ADR-027: no prazo da vez, o modelo conta como "ainda gerando" se chegou um pedaço dentro da MESMA janela de silêncio que
// define travamento na chamada (silencioDoModeloMs, padrão 90 s). Antes era uma janela própria de 10 s: uma pausa de 15–30 s
// depois da fatia (fila do provedor, passagem do raciocínio para a resposta) cortava o juiz como se estivesse travado.
import { PerfilDoJuiz } from './perfilDoJuiz';
import { descreverAgora } from '../shared/dataEHora';
import { descreverAmbienteDeExecucao } from '../shared/ambienteDeExecucao';
import { gravarAvaliacao, novaAvaliacaoId, versaoDoPrompt, INSTRUCAO_FALTOU, INSTRUCAO_DIFICULDADE, type ContextoAvaliacao } from '../shared/evaluatorFlightRecorder';
import {
    RegistroDeValidacoes, lerSaidaDoModelo, agregarPorItens, citacaoExiste,
    type DescritorDeValidacao, type VereditoPadrao, type PapelDaEntrada,
} from './contratoDeValidacao';

const log = createLogger('ValidationEngine');

/** Fração do tempo restante que o PRIMEIRO modo pode usar antes de o motor tentar o outro (o último modo usa o que sobrar). */
const FATIA_DO_PRIMEIRO_MODO = 0.55;

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
    /** Orçamento de tempo que o motor deu ao juiz nesta validação (esticado pelo tamanho do trabalho); ausente se nem chegou a chamar. */
    orcamentoMs?: number;
    /** Saída do adaptador do descritor; sem adaptador, o próprio veredito. */
    adaptado: T;
}

export interface OpcoesDaChamada extends ContextoAvaliacao {
    signal?: AbortSignal;
    /** Modelo desta chamada, no lugar do modelo do juiz configurado (usado pela medição de velocidade na tela). */
    modelo?: string;
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
        /** O que o motor aprendeu de como cada modelo se comporta como juiz (ADR-016). */
        private readonly perfil: PerfilDoJuiz = new PerfilDoJuiz(),
        /** O relógio do motor (injetável nos testes): a data de hoje entra no prompt de TODOS os tipos. */
        private readonly relogio: () => Date = () => new Date(),
        /** Onde os comandos rodam de verdade (injetável nos testes): entra no prompt de TODOS os tipos, junto da data. */
        private readonly ambiente: () => string = () => descreverAmbienteDeExecucao(),
    ) {}

    /** Modelo do juiz escolhido em tempo de execução (painel: `updateConfig`); vence a variável de ambiente. */
    private modeloDoJuiz?: string;

    /** O ÚNICO ponto que muda o modelo de TODOS os tipos de validação (vazio/undefined = volta à configuração). */
    definirModeloDoJuiz(modelo: string | undefined): void {
        this.modeloDoJuiz = modelo?.trim() || undefined;
    }

    /** Monta o prompt do tipo — exportado para teste e para o gravador (versão do modelo de prompt). */
    montarPrompt(d: DescritorDeValidacao<unknown>, entradas: Record<string, string | undefined>, agora?: Date): string {
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
        // Uma pessoa sabe que dia é hoje; o juiz não sabia (relatado por ele no campo "faltou"). Só entra no prompt de verdade —
        // a versão do prompt (gravador de voo) é calculada sem a data, para não mudar todo dia.
        // O ambiente também (Telegram, 15/10/2026): sem ele, o juiz aprovava sintaxe de PowerShell que o exec_command roda no cmd.exe.
        if (agora) secoes.push(`CONTEXTO DO SISTEMA (não é evidência):\nData e hora atuais: ${descreverAgora(agora)}. Use só para julgar datas relativas ("hoje", "há 3 dias") e a plausibilidade de datas.\n${this.ambiente()} Use para julgar se comandos, caminhos e instruções servem a esta máquina.`);
        secoes.push(`CHECKLIST — responda cada item:\n${d.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
        if (d.preVerificacoes?.includes('citacao_existe_na_fonte')) {
            // ADR-015: de onde a citação pode vir é declarado pelo tipo (padrão: só as fontes de verdade).
            const deOnde = (d.fontesDaCitacao ?? ['fonte_de_verdade']).map(p => TITULO_DA_SECAO[p].split(' (')[0]).join(' ou ');
            secoes.push(`Para cada item marcado "sim" ou "nao", copie em "trecho" um trecho CURTO (até uns 80 caracteres) que o decide, de: ${deOnde}, como está escrito lá. O sistema confere se o trecho existe; diferenças de espaço, aspas, traço e formatação são toleradas — não perca tempo conferindo letra por letra.`);
        }
        secoes.push(`${INSTRUCAO_FALTOU}\n${INSTRUCAO_DIFICULDADE}`);
        // ADR-015: campos extras declarados pelo tipo — pedidos com a instrução do descritor, no mesmo JSON.
        const extras = d.camposExtras ?? [];
        if (extras.length) secoes.push(`CAMPOS ADICIONAIS DA RESPOSTA:\n${extras.map(c => `- "${c.nome}": ${c.instrucao}`).join('\n')}`);
        const camposExtrasJson = extras.map(c => `,"${c.nome}":"..."`).join('');
        secoes.push(`Responda APENAS com JSON — a sua resposta INTEIRA é o objeto abaixo: comece em { e termine em }, sem análise, raciocínio ou comentário antes ou depois. Nos campos "faltou" e "dificuldade", omita a propriedade se não houver algo a relatar; se incluir uma propriedade, escreva uma descrição específica e útil, nunca deixe vazia nem use texto genérico:\n{"estado":"aprovado|reprovado","itens":[{"item":"...","confere":"sim|nao|sem_evidencia","evidencia":"(opcional)","trecho":"(opcional)"}],"confianca":0.0,"motivo":"curto","faltou":"(omita ou descreva a lacuna)","dificuldade":"(omita ou descreva o problema)"${camposExtrasJson}}`);
        return secoes.join('\n\n');
    }

    async validar<T = VereditoPadrao>(tipo: string, entradas: Record<string, string | undefined>, opcoes: OpcoesDaChamada = {}): Promise<ResultadoDaValidacao<T>> {
        const d = this.registro.obter(tipo) as DescritorDeValidacao<T> | undefined;
        if (!d) throw new Error(`Tipo de validação não registrado: "${tipo}"`);
        const t0 = Date.now();
        const avaliacaoId = novaAvaliacaoId();
        const telemetria: CallTelemetry = { attempts: [] };
        const modelo = opcoes.modelo ?? this.modeloDoJuiz ?? this.resolverModelo(CHAVE_DO_MODELO_DO_JUIZ) ?? '';
        let prompt = '';
        let saidaBruta: string | undefined;
        const modosTentados: string[] = [];
        let orcamentoMs: number | undefined;
        let orcamentoEscalado = false;

        const concluir = (veredito: VereditoPadrao, desfecho: string): ResultadoDaValidacao<T> => {
            const v = { ...veredito, avaliacaoId };
            gravarAvaliacao({
                id: avaliacaoId, avaliador: `validacao_${d.tipo}`,
                contexto: { traceId: opcoes.traceId, conversationId: opcoes.conversationId, goalId: opcoes.goalId, stepId: opcoes.stepId, phase: opcoes.phase },
                antes: {
                    modelo: modelo || '(padrão do provedor)', versaoPrompt: versaoDoPrompt(this.montarPrompt(d, {})), promptChars: prompt.length,
                    fatos: {
                        raciocinio: d.raciocinio,
                        modosTentados,
                        orcamentoMs,
                        orcamentoEscaladoPeloTrabalho: orcamentoEscalado,
                        entradas: Object.fromEntries(d.entradas.map(e => [e.nome, entradas[e.nome] === undefined ? 'ausente' : `${String(entradas[e.nome]).length} chars`])),
                    },
                    conteudo: { prompt, entradas },
                },
                telemetria,
                depois: {
                    desfecho, estado: v.estado, duracaoMs: Date.now() - t0,
                    fatos: { itens: v.itens.length, confianca: v.confianca, faltouInformado: !!v.faltou, dificuldadeInformada: !!v.dificuldade, naoAvaliavelPorque: v.naoAvaliavelPorque, faltou: v.faltou, dificuldade: v.dificuldade },
                    conteudo: { saidaBruta, itens: v.itens, motivo: v.motivo, faltou: v.faltou, dificuldade: v.dificuldade, extras: v.extras },
                },
            });
            const semVeredito = v.estado === 'nao_avaliavel' && !!v.naoAvaliavelPorque;
            return { veredito: v, semVeredito, desfecho, saidaBruta, deveBloquear: semVeredito && d.semVeredito === 'bloquear', orcamentoMs, adaptado: (d.adaptador ? d.adaptador(v) : v) as T };
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
        prompt = this.montarPrompt(d, entradas, this.relogio());
        // O teto vem da janela REAL do modelo do juiz (medida pelo provedor); sem medição, o número conservador de sempre.
        // Antes era sempre 60 mil — um juiz de nuvem com janela de 1 milhão de tokens ficava "não avaliável" com 93–119 mil
        // caracteres e a resposta passava sem conferência (Windows, 15/10/2026).
        const teto = typeof this.providerFactory.tetoDeEntrada === 'function'
            ? await this.providerFactory.tetoDeEntrada(modelo || undefined).catch(() => ({ chars: DECISION_PROMPT_MAX_CHARS, origem: 'padrão (falha ao medir)' }))
            : { chars: DECISION_PROMPT_MAX_CHARS, origem: 'padrão' };
        if (prompt.length > teto.chars) {
            log.info(`[VALIDACAO] tipo=${d.tipo} prompt de ${prompt.length} chars excede ${teto.chars} (${teto.origem}) — não avaliável`);
            return naoAvaliavel(`prompt de ${prompt.length} chars excede o teto de ${teto.chars} (${teto.origem})`, 'acima_do_teto');
        }

        // 4. O modelo do juiz — chamado do jeito que FUNCIONA para ele (ADR-016): capacidade declarada pelo provedor + perfil
        //    aprendido pelo uso. Cada modo (raciocínio do provedor / desligado) tem um PRAZO REAL, dentro do orçamento do juiz: o
        //    juiz nunca passa do orçamento declarado. Modelo que vem falhando como juiz DESTE TIPO em todos os modos: o motor nem chama.
        //    O orçamento acompanha o TAMANHO do trabalho: prompt grande = mais a conferir = mais tempo (ver auxTimeout).
        const orcamento = this.providerFactory.getBudgetAuxiliar('validacao', prompt.length);
        orcamentoMs = orcamento.timeoutMs;
        orcamentoEscalado = orcamento.escaladoPeloTrabalho === true;
        const chaveDoModelo = modelo || '(padrão do provedor)';
        const disjuntor = this.perfil.estadoDoDisjuntor(chaveDoModelo, d.tipo);
        if (disjuntor.aberto) {
            const seg = Math.ceil(disjuntor.reabreEmMs / 1000);
            log.warn(`[VALIDACAO] tipo=${d.tipo} modelo=${chaveDoModelo} vem falhando como juiz deste tipo em todos os modos — não chamado por mais ${seg} s (disjuntor do tipo)`);
            return naoAvaliavel(`o modelo vem falhando como juiz deste tipo (${d.tipo}) em todos os modos (nova sondagem em ${seg} s)`, 'juiz_indisponivel');
        }
        let modos = await this.perfil.modosParaTentar(chaveDoModelo, d.raciocinio);
        // ADR-024 (etapa 3): o que ESTE trabalho custa a ESTE modelo em cada modo — tokens aprendidos pelo uso e a velocidade
        // MEDIDA dele. Só ESTENDE o prazo (nunca corta antes do que cortava): um modelo lento (local, ~38 tokens/s) ganha o
        // tempo que o trabalho dele precisa; um rápido segue como antes. Sem histórico (< amostra mínima): prazo de sempre.
        const pelaMedicao = new Map<string, { modelo: string; tokens: number; prazoMs: number; amostras: number; geracao: number }>();
        if (typeof this.providerFactory.orcamentoPeloTrabalho === 'function') {
            for (const m of modos) {
                const o = this.providerFactory.orcamentoPeloTrabalho(modelo || undefined, m, `ValidationEngine:${d.tipo}`, prompt.length);
                if (o) pelaMedicao.set(m, o);
            }
        }
        // ADR-024 (etapa 4): entre modos que JÁ provaram dar veredito para este modelo, o mais BARATO em tokens neste tipo de
        // trabalho. Medido em 16/10: sem raciocínio, um modelo local deu veredito com ~10× menos tokens. Mas trocar o modo pode
        // mudar a QUALIDADE (5 casos comparados é pouco) — por isso, por padrão, só registra (sombra); troca de verdade só com
        // JUIZ_MODO_PELO_CUSTO=1.
        if (modos.length > 1 && modos.every(m => pelaMedicao.has(m) && this.perfil.confiavel(chaveDoModelo, m))) {
            const pelosTokens = [...modos].sort((a, b) => pelaMedicao.get(a)!.tokens - pelaMedicao.get(b)!.tokens);
            if (pelosTokens[0] !== modos[0]) {
                const ativo = process.env.JUIZ_MODO_PELO_CUSTO === '1';
                log.info(`[JUIZ-MODO-${ativo ? 'CUSTO' : 'SOMBRA'}] tipo=${d.tipo} modelo=${chaveDoModelo} hoje=${modos[0]} pelo_custo=${pelosTokens[0]} (${pelosTokens.map(m => `${m}=${pelaMedicao.get(m)!.tokens} tokens`).join(', ')})${ativo ? ' — usando o mais barato' : ' — só registrado (JUIZ_MODO_PELO_CUSTO desligado)'}`);
                if (ativo) modos = pelosTokens;
            }
        }
        // ADR-027: sem teto do objetivo — o objetivo não tem mais relógio.
        const somaMedida = [...pelaMedicao.values()].reduce((n, o) => n + o.prazoMs, 0);
        const prazoTotal = Math.max(orcamento.timeoutMs, somaMedida);
        if (prazoTotal > orcamento.timeoutMs) {
            orcamentoMs = prazoTotal;
            log.info(`[VALIDACAO] tipo=${d.tipo} prazo pelo trabalho medido: ${[...pelaMedicao].map(([m, o]) => `${m}=${o.tokens} tokens a ${o.geracao.toFixed(1)} tok/s (n=${o.amostras}) → ${Math.round(o.prazoMs / 1000)} s`).join('; ')} — prazo ${Math.round(orcamento.timeoutMs / 1000)} s → ${Math.round(prazoTotal / 1000)} s`);
        }
        const limite = t0 + prazoTotal;
        let lido: ReturnType<typeof lerSaidaDoModelo> = null;
        // ADR-027: o laço não desiste mais por tempo — este valor só vale se não houver modo nenhum para tentar.
        let falha: { porque: string; desfecho: string } = { porque: 'nenhum modo de chamada para tentar', desfecho: 'juiz_indisponivel' };
        for (let i = 0; i < modos.length; i++) {
            // ADR-027: o modo seguinte é tentado sempre que o anterior não deu veredito — o anterior pode ter trabalhado além
            // do orçamento (gerando, não é cortado). A fatia dele parte do orçamento, não do que "sobrou" no relógio.
            const restante = Math.max(limite - Date.now(), orcamento.timeoutMs);
            const ultimo = i === modos.length - 1;
            const confiavel = i === 0 && this.perfil.confiavel(chaveDoModelo, modos[0]);
            const medidoDoModo = pelaMedicao.get(modos[i]);
            let fatia = ultimo
                ? restante
                : (confiavel
                    ? (orcamento.timeoutMs >= 15000 ? Math.max(1, Math.round(restante * 0.75)) : restante)
                    : Math.max(1, Math.round(restante * FATIA_DO_PRIMEIRO_MODO)));
            // O modo com custo medido recebe pelo menos o que o trabalho dele precisa (dentro do que resta).
            if (medidoDoModo && !ultimo) fatia = Math.max(fatia, Math.min(restante, medidoDoModo.prazoMs));
            const ctrl = new AbortController();
            const t1 = Date.now();
            // ADR-024/027: o prazo da vez (fatia) NÃO corta um modelo que AINDA ESTÁ GERANDO — reteste do GenOffice (16/10/2026):
            // juiz cortado aos 59 s com 2,3 mil tokens porque a nuvem estava lenta (~40 tok/s, contra 238 medidos). No prazo, olha
            // a telemetria AO VIVO: chegou pedaço dentro da janela de silêncio (silencioDoModeloMs) → confere de novo a cada 2 s, sem teto de duração
            // (ADR-027: o orçamento em tokens e o teto do objetivo deixaram de cortar; o limite de tokens continua indo ao
            // provedor, que para sozinho). Em silêncio na fatia, é travamento: corta. Sem telemetria ao vivo (provedor sem
            // streaming), não há sinal de progresso: corta no prazo como antes, e o teto abaixo é o do provedor sem streaming.
            const tetoDaChamada = Math.max(fatia, tetoDoPerfilAuxiliar('validacao'));
            const tentativasAntes = telemetria.attempts.length;
            let continuouGerando = false;
            let timer: NodeJS.Timeout;
            const decidirNoPrazo = (): void => {
                const t = telemetria.attempts.length > tentativasAntes ? telemetria.attempts[telemetria.attempts.length - 1] : undefined;
                const gerando = !!t?.ultimoPedacoEm && Date.now() - t.ultimoPedacoEm < silencioDoModeloMs();
                if (gerando) {
                    if (!continuouGerando) {
                        continuouGerando = true;
                        log.info(`[VALIDACAO] tipo=${d.tipo} modelo=${chaveDoModelo} modo=${modos[i]} prazo da vez (${Math.round(fatia / 1000)} s) chegou com o modelo AINDA GERANDO (${t?.pedacosAteAgora ?? 0} pedaços${medidoDoModo ? `; orçamento ${medidoDoModo.tokens}` : ''}) — não corta; só o silêncio corta`);
                    }
                    timer = setTimeout(decidirNoPrazo, 2000);
                    return;
                }
                ctrl.abort();
            };
            timer = setTimeout(decidirNoPrazo, fatia);
            modosTentados.push(modos[i]);
            let resultado;
            try {
                resultado = await this.providerFactory.chatWithFallback(
                    [{ role: 'user', content: prompt }], undefined, undefined, tetoDaChamada, combinarSinais(opcoes.signal, ctrl.signal), modelo || undefined,
                    { reasoningIntensive: modos[i] === 'livre', raciocinio: modos[i], saidaJson: true, limiteDeSaidaTokens: medidoDoModo?.tokens, prazoDaVezMs: fatia, diag: { component: 'ValidationEngine', role: 'validator', phase: d.tipo, goalId: opcoes.goalId }, telemetry: telemetria },
                );
            } catch (err) {
                // Falha de infraestrutura (rede, provedor): não diz nada sobre o modo — não pune o perfil nem tenta o outro.
                return naoAvaliavel(`erro na chamada: ${String(err).slice(0, 120)}`, 'erro');
            } finally {
                clearTimeout(timer!);
            }
            const ms = Date.now() - t1;
            if (opcoes.signal?.aborted || sinalDoTurno()?.aborted) return naoAvaliavel('cancelado pelo usuário', 'llm_cancelled');
            if (resultado.status === 'success') {
                saidaBruta = resultado.content;
                const diagnosticoLeitura: { motivo?: string } = {};
                lido = lerSaidaDoModelo(saidaBruta || '', (d.camposExtras ?? []).map(c => c.nome), diagnosticoLeitura);
                this.perfil.registrar(chaveDoModelo, modos[i], !!lido, ms, d.tipo);
                log.info(`[VALIDACAO] tipo=${d.tipo} modelo=${chaveDoModelo} modo=${modos[i]} ${lido ? 'veredito' : 'saída sem estrutura'} em ${ms} ms${lido || ultimo ? '' : ' — tentando o outro modo'}`);
                if (lido) break;
                falha = { porque: diagnosticoLeitura.motivo ?? 'saída do modelo sem a estrutura do contrato', desfecho: 'saida_invalida' };
                continue;
            }
            if (resultado.status === 'timeout' || resultado.status === 'cancelled') {
                // O modelo não concluiu NA FATIA deste modo (nem sinal do usuário): este modo é lento demais para este modelo.
                this.perfil.registrar(chaveDoModelo, modos[i], false, ms, d.tipo);
                // O que o modelo escreveu até ser cortado é a pista de por que não concluiu (com o raciocínio desligado, há modelos que
                // escrevem a análise inteira no conteúdo antes do JSON) — o fim dele vai para o log, nunca para o veredito.
                const escritoAteOCorte = (resultado.content ?? '').trim();
                log.info(`[VALIDACAO] tipo=${d.tipo} modelo=${chaveDoModelo} modo=${modos[i]} sem veredito em ${ms} ms (fatia ${fatia} ms)${ultimo ? '' : ' — tentando o outro modo'}` +
                    (escritoAteOCorte ? ` — escreveu ${escritoAteOCorte.length} chars até o corte; fim: "${escritoAteOCorte.slice(-400).replace(/\s+/g, ' ')}"` : ''));
                falha = { porque: `modelo não concluiu (${resultado.status === 'cancelled' ? 'timeout' : resultado.status})`, desfecho: 'llm_timeout' };
                continue;
            }
            // 'error', 'empty'…: o provedor falhou — não é comportamento do modelo; não pune o perfil nem tenta outro modo.
            return naoAvaliavel(`modelo não concluiu (${resultado.status})`, `llm_${resultado.status}`);
        }

        // 5. Leitura estrutural e pré-verificações.
        if (!lido) return naoAvaliavel(falha.porque, falha.desfecho);
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
