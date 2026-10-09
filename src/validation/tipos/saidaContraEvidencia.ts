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

export const descritorSaidaContraEvidencia: DescritorDeValidacao<EstadoDeGrounding> = {
    tipo: TIPO_SAIDA_CONTRA_EVIDENCIA,
    pergunta: 'Cada afirmação que a RESPOSTA apresenta como dado obtido das ferramentas é sustentada pelas EVIDÊNCIAS?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: false },
        { nome: 'resposta', rotulo: 'Resposta ao usuário', papel: 'objeto', obrigatoria: true },
        { nome: 'evidencias', rotulo: 'Evidências (saídas das ferramentas deste turno)', papel: 'fonte_de_verdade', obrigatoria: true },
    ],
    checklist: [
        'Liste como itens SOMENTE as afirmações que a resposta apresenta como DADO OBTIDO das evidências — valor, resultado, conteúdo lido, contagem, estado ou nome informado por uma ferramenta, mesmo no meio de texto redigido.',
        'NÃO liste: texto que o assistente redigiu (explicação, conhecimento geral, opinião, recomendação, cortesia); o que a resposta só repete do pedido do usuário; o que o assistente diz que fez ou vai fazer; fato verificável por si só (ex.: o dia da semana de uma data, o resultado de um cálculo).',
        'confere="sim" quando a evidência DETERMINA POSITIVAMENTE a afirmação — está nela, ou sai dela por transformação determinística (arredondamento, unidade declarada, reformatação, tradução, omissão de campos, conta aritmética com número explícito do contexto). Copie em "trecho" o texto LITERAL da evidência que a determina.',
        'confere="nao" quando a evidência determina que a afirmação é falsa — contradiz, atribui o valor a outro papel/entidade/momento, ou acrescenta item a uma lista que a evidência enumera e não contém. Copie em "trecho" o texto LITERAL da evidência que a contradiz.',
        'confere="sem_evidencia" quando a evidência não determina a afirmação (não trata do assunto, é ambígua, conflitante, ou não enumera a dimensão de que a afirmação fala). Ausência de contradição NÃO é suporte.',
        'Se a resposta não tiver nenhuma afirmação apresentada como dado obtido, devolva "itens": [].',
    ],
    agregacao: 'itens',
    preVerificacoes: ['citacao_existe_na_fonte'],
    // Medição pedida pelo ADR-014 ("a qualidade dos vereditos sem raciocínio não foi medida — M1 mede, na sombra").
    raciocinio: 'desligado',
    modeloConfig: 'OBSERVER_MODEL',
    adaptador: estadoDeGrounding,
};
