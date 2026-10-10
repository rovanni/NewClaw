/**
 * Tipo de validação `saida_contra_evidencia` (ADR-014 M1) — o juiz de grounding como descritor do motor único.
 * "Cada afirmação que a resposta apresenta como dado obtido das ferramentas é sustentada pelas evidências?"
 *
 * As regras são as do juiz atual (ObserverValidator.GROUNDING_PROMPT, ADR-010), portadas para o checklist — com uma
 * diferença que é o motivo da migração: a citação de cada veredito é CONFERIDA pelo código (o trecho tem de existir
 * literalmente nas evidências). Em M1 roda em SOMBRA: não decide nada; registra a comparação com o juiz atual.
 */
import type { DescritorDeValidacao, VereditoPadrao } from '../contratoDeValidacao';

export const TIPO_SAIDA_CONTRA_EVIDENCIA = 'saida_contra_evidencia';

/** Mesma escala de estado do juiz atual, para comparar na sombra. */
export type EstadoDeGrounding = 'VALIDATED' | 'REJECTED' | 'NOT_APPLICABLE' | 'NOT_EVALUABLE' | 'UNVALIDATED';

export function estadoDeGrounding(v: VereditoPadrao): EstadoDeGrounding {
    if (v.estado === 'nao_avaliavel' && v.naoAvaliavelPorque) return 'UNVALIDATED';   // motor não chegou a veredito
    if (v.itens.length === 0) return 'NOT_APPLICABLE';                              // nenhuma afirmação derivada
    if (v.estado === 'reprovado') return 'REJECTED';
    if (v.estado === 'nao_avaliavel') return 'NOT_EVALUABLE';
    return 'VALIDATED';
}

export type VereditoDaAfirmacao = 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_EVALUABLE';

/** Uma afirmação da resposta com o veredito — o formato que os consumidores do juiz de grounding usam. */
export interface AfirmacaoJulgada {
    claim: string;
    /** ids de evidência citados pelo juiz (E1, E2…); vazio = nenhuma identificada */
    evidence: string[];
    verdict: VereditoDaAfirmacao;
}

export interface DecisaoDeGrounding {
    state: EstadoDeGrounding;
    claims: AfirmacaoJulgada[];
}

const VEREDITO_POR_CONFERE: Record<string, VereditoDaAfirmacao> = { sim: 'SUPPORTED', nao: 'NOT_SUPPORTED', sem_evidencia: 'NOT_EVALUABLE' };

export function adaptarGrounding(v: VereditoPadrao): DecisaoDeGrounding {
    const claims: AfirmacaoJulgada[] = v.itens.map(i => ({
        claim: i.item,
        // Só ids no formato das evidências do turno (E1, G2…); o resto do texto do campo é descartado.
        evidence: (i.evidencia ?? '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^[A-Z]\d+$/.test(x)),
        verdict: VEREDITO_POR_CONFERE[i.confere] ?? 'NOT_EVALUABLE',
    }));
    return { state: estadoDeGrounding(v), claims };
}

export const descritorSaidaContraEvidencia: DescritorDeValidacao<DecisaoDeGrounding> = {
    tipo: TIPO_SAIDA_CONTRA_EVIDENCIA,
    pergunta: 'Cada afirmação que a RESPOSTA apresenta como dado obtido das ferramentas é sustentada pelas EVIDÊNCIAS?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: false },
        // S4 (10/10/2026): uma pessoa que audita a resposta leria a conversa; o juiz só via o pedido atual. Mostra o que o USUÁRIO já
        // disse (e o que o assistente respondeu) — contexto, nunca evidência de dado das ferramentas. A janela já vem limitada por mensagens
        // inteiras (as mais antigas saem primeiro, com a omissão DECLARADA — ver ObserverValidator.conversaParaOJuiz).
        { nome: 'conversa', rotulo: 'Conversa recente (antes deste pedido) — NÃO é evidência de dado das ferramentas', papel: 'contexto_do_usuario', obrigatoria: false },
        { nome: 'resposta', rotulo: 'Resposta ao usuário', papel: 'objeto', obrigatoria: true },
        { nome: 'evidencias', rotulo: 'Evidências (saídas das ferramentas deste turno)', papel: 'fonte_de_verdade', obrigatoria: true },
        // S3 (10/10/2026): o juiz via só nome, argumentos e saída; uma pessoa saberia o que a ferramenta faz e o que o resultado dela
        // significa (ex.: o "atualizado" de uma gravação). É contexto para ENTENDER o resultado — nunca fonte da citação.
        { nome: 'ferramentas', rotulo: 'Ferramentas usadas neste turno — o que cada uma faz (explica o resultado; NÃO é evidência de dado)', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'Liste como itens SOMENTE as afirmações que a resposta apresenta como DADO OBTIDO das evidências — valor, resultado, conteúdo lido, contagem, estado ou nome informado por uma ferramenta, mesmo no meio de texto redigido.',
        'NÃO liste: texto que o assistente redigiu (explicação, conteúdo didático, conhecimento geral, opinião, recomendação, cortesia); o que a resposta só repete do que o USUÁRIO disse (no pedido ou na conversa recente); o que o assistente diz que fez ou vai fazer; fato verificável por si só (ex.: o dia da semana de uma data, o resultado de um cálculo).',
        'confere="sim" quando a evidência DETERMINA POSITIVAMENTE a afirmação — está nela, ou sai dela por transformação determinística (arredondamento, unidade declarada, reformatação, tradução, omissão de campos, conta aritmética com número explícito do contexto). Copie em "trecho" o texto LITERAL da evidência que a determina e escreva em "evidencia" os ids (E1, E2…) das evidências que a sustentam.',
        'confere="nao" quando a evidência determina que a afirmação é falsa — contradiz, atribui o valor a outro papel/entidade/momento, ou acrescenta item a uma lista que a evidência enumera e não contém. Copie em "trecho" o texto LITERAL da evidência que a contradiz e escreva em "evidencia" os ids (E1, E2…) das evidências envolvidas.',
        'confere="sem_evidencia" quando a evidência não determina a afirmação (não trata do assunto, é ambígua, conflitante, ou não enumera a dimensão de que a afirmação fala). Ausência de contradição NÃO é suporte.',
        'Se a resposta não tiver nenhuma afirmação apresentada como dado obtido, devolva "itens": [].',
        'O que o ASSISTENTE disse em turnos anteriores da conversa não é evidência: um dado que só aparece aí, sem estar nas evidências deste turno, não é sustentado.',
        'A descrição das ferramentas (quando houver) serve só para entender o que cada resultado significa; ela NÃO sustenta nenhuma afirmação sobre dados.',
    ],
    agregacao: 'itens',
    preVerificacoes: ['citacao_existe_na_fonte'],
    // Medição pedida pelo ADR-014 ("a qualidade dos vereditos sem raciocínio não foi medida — M1 mede, na sombra").
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'bloquear',   // ADR-010 §9: o juiz que não conclui nunca é aprovação (fail-closed)
    adaptador: adaptarGrounding,
};
