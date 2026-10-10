/**
 * Tipo de validação `suficiencia_do_pedido` (ADR-015) — "o pedido traz, por si ou pela memória, todos os dados do
 * usuário que a ação exige?". Roda logo depois da pergunta, antes de qualquer ferramenta.
 *
 * Só dados (ADR-014): a pergunta, as entradas com papel, o checklist, a citação conferida pelo motor e o campo extra
 * com a pergunta ao usuário. Nenhuma lógica de domínio aqui além do adaptador, que traduz o veredito para a decisão
 * do consumidor (seguir ou perguntar).
 */
import type { DescritorDeValidacao, VereditoPadrao } from '../contratoDeValidacao';

/** Decisão para o consumidor (GoalOrchestrator). */
export interface DecisaoDeSuficiencia {
    /**
     * `seguir`: nada falta, ou falta e a memória respondeu (com a origem conferida).
     * `perguntar`: falta um dado e ninguém o tem — ou a origem citada não existe nas fontes.
     * `sem_veredito`: o motor não chegou a um veredito por infraestrutura (prazo, modelo fora) — não bloqueia (ADR-015).
     */
    acao: 'seguir' | 'perguntar' | 'sem_veredito';
    /** Escrita pelo modelo, no idioma do pedido. */
    pergunta?: string;
    /** Dados que faltam (ou cuja origem citada não foi encontrada). */
    faltando: string[];
    /** Dados resolvidos, com o valor e o trecho literal de onde vieram. */
    resolvidos: Array<{ dado: string; valor?: string; trecho?: string }>;
    motivo?: string;
}

export const TIPO_SUFICIENCIA_DO_PEDIDO = 'suficiencia_do_pedido';

export function adaptarSuficiencia(v: VereditoPadrao): DecisaoDeSuficiencia {
    const faltando = v.itens.filter(i => i.confere === 'nao' || i.confere === 'sem_evidencia').map(i => i.item);
    const resolvidos = v.itens.filter(i => i.confere === 'sim').map(i => ({ dado: i.item, valor: i.evidencia, trecho: i.trecho }));
    const pergunta = v.extras?.pergunta_ao_usuario;
    // Sem veredito do modelo por infraestrutura (entrada ausente, teto, prazo, saída inválida): não bloqueia.
    if (v.estado === 'nao_avaliavel' && v.naoAvaliavelPorque) {
        return { acao: 'sem_veredito', faltando, resolvidos, motivo: v.naoAvaliavelPorque };
    }
    // Falta dado (nao) ou a origem citada não existe (sem_evidencia, posto pela pré-verificação): pergunta obrigatória.
    if (faltando.length > 0) return { acao: 'perguntar', pergunta, faltando, resolvidos, motivo: v.motivo };
    return { acao: 'seguir', faltando, resolvidos, motivo: v.motivo };
}

export const descritorSuficienciaDoPedido: DescritorDeValidacao<DecisaoDeSuficiencia> = {
    tipo: TIPO_SUFICIENCIA_DO_PEDIDO,
    pergunta: 'O pedido do usuário traz — por si mesmo, pelas preferências salvas, pela memória ou pela conversa recente — todos os dados específicos do usuário que a ação pedida exige?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'objeto', obrigatoria: true },
        { nome: 'preferencias', rotulo: 'Preferências salvas do usuário', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'memoria', rotulo: 'Memória do usuário próxima do pedido', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'conversa', rotulo: 'Conversa recente (antes deste pedido)', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'ferramentas', rotulo: 'Ferramentas disponíveis e os dados que cada uma exige', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'Liste como itens SOMENTE os dados específicos do usuário que a ação pedida exige e que nenhuma ferramenta descobre sozinha — por exemplo: a cidade de uma previsão do tempo, qual arquivo editar, para quem enviar. NÃO liste o que as ferramentas obtêm (cotação, notícias, a previsão em si, o conteúdo de um arquivo já indicado), nem preferências de formato ou estilo.',
        'Para cada dado: confere="sim" se o valor está no pedido, nas preferências salvas, na memória ou na conversa recente — coloque só o valor em "evidencia" e copie em "trecho" o texto LITERAL de onde ele vem; confere="nao" se ele não está em nenhum desses lugares. Nunca deduza um valor que não está escrito.',
        // Teste real 09/10: "a cidade da minha mãe" foi resolvida com a preferência "cidade padrão" — o trecho existia,
        // mas respondia a OUTRO dado.
        'O valor precisa responder EXATAMENTE ao dado pedido. Uma preferência genérica (ex.: "cidade padrão para a previsão do tempo") só vale quando o pedido não especifica outra coisa; se o pedido se refere a algo específico — a cidade de outra pessoa, um arquivo ou destinatário determinado — a preferência genérica NÃO responde, e o dado só conta como encontrado se esse valor específico estiver escrito.',
        'Se a ação não exige nenhum dado do usuário além do que já está claro, devolva "itens": [] e estado "aprovado".',
    ],
    agregacao: 'itens',
    preVerificacoes: ['citacao_existe_na_fonte'],
    // O dado pode estar no próprio pedido ("previsão do tempo em X").
    fontesDaCitacao: ['objeto', 'fonte_de_verdade'],
    camposExtras: [{
        nome: 'pergunta_ao_usuario',
        instrucao: 'Escreva sempre que houver itens: a pergunta curta e cordial que pediria ao usuário exatamente os dados listados, no MESMO IDIOMA do pedido do usuário. O sistema só a usa se algum dado não estiver comprovado. Vazio quando não há itens.',
    }],
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'liberar',   // ADR-015: sem veredito não bloqueia o pedido
    adaptador: adaptarSuficiencia,
};
