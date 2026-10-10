/**
 * ADR-014 — os tipos de validação do NewClaw (além de `saida_contra_evidencia` e `suficiencia_do_pedido`): qualidade da
 * resposta, resultado do passo, risco do plano, conclusão do objetivo e conteúdo-molde. Cada um é só DADOS — a pergunta, as
 * entradas com o papel de cada uma, o checklist, os campos extras, a política de "sem veredito" e o adaptador para o
 * formato do consumidor; quem executa é o motor único (`ValidationEngine`), sempre do mesmo jeito. O estado sai na escala
 * comum (aprovado / reprovado / nao_avaliavel) e todos usam o mesmo modelo do juiz.
 */
import type { DescritorDeValidacao, VereditoPadrao } from '../contratoDeValidacao';

/** Decisão do consumidor do validador de qualidade (ObserverValidator.validate). */
export interface DecisaoDeQualidade {
    approved: boolean;
    reason: string;
    confidence: number;
    suggestedFix?: string;
    /** incomplete_response | read_only | future_action | tool_error | claimed_without_execution | other | none */
    failureType: string;
}

const FALHAS_CONHECIDAS = new Set(['incomplete_response', 'read_only', 'future_action', 'tool_error', 'claimed_without_execution', 'other', 'none']);

export function adaptarQualidadeDaResposta(v: VereditoPadrao): DecisaoDeQualidade {
    const aprovado = v.estado === 'aprovado';
    const falha = (v.extras?.tipo_de_falha ?? '').trim();
    return {
        approved: aprovado,
        reason: v.motivo ?? '',
        confidence: typeof v.confianca === 'number' ? v.confianca : 0.5,
        suggestedFix: v.extras?.correcao_sugerida,
        failureType: FALHAS_CONHECIDAS.has(falha) ? falha : (aprovado ? 'none' : 'other'),
    };
}

/** M3 — validador de qualidade (ObserverValidator.validate): "a resposta atende o pedido?" */
export const descritorQualidadeDaResposta: DescritorDeValidacao<DecisaoDeQualidade> = {
    tipo: 'qualidade_da_resposta',
    pergunta: 'A ação executada está correta e a resposta final atende plenamente ao pedido do usuário?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: true },
        { nome: 'resposta', rotulo: 'Resposta final ao usuário', papel: 'objeto', obrigatoria: true },
        { nome: 'ferramentas', rotulo: 'Ferramentas executadas neste turno e seus resultados', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'intencao', rotulo: 'Intenção identificada', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'A resposta atende plenamente ao que foi pedido (não para no meio, não responde outra coisa)?',
        'A ação executada é a adequada ao pedido (não só leu quando o pedido exigia agir; não promete fazer depois o que deveria ter feito agora)?',
        'A resposta não ignora nem esconde um erro de ferramenta?',
        // Teste real 09/10/2026: "Salvo! Criei o nó…" com zero ferramentas executadas. Vale para QUALQUER turno, inclusive o que terminou sem ferramenta.
        'A resposta NÃO afirma como JÁ FEITA (ou em andamento agora) uma ação que muda algo fora da conversa — salvar, criar, enviar, apagar, agendar, instalar — sem que conste em "Ferramentas executadas neste turno" uma ferramenta bem-sucedida que a realizou? Oferta ou pergunta ("quer que eu salve?"), explicação e conhecimento geral não são afirmação de ação feita.',
    ],
    agregacao: 'modelo',
    camposExtras: [
        { nome: 'tipo_de_falha', instrucao: 'Se reprovado: incomplete_response | read_only | future_action | tool_error | claimed_without_execution | other (claimed_without_execution = a resposta afirma uma ação feita que nenhuma ferramenta executou). Se aprovado: none.' },
        { nome: 'correcao_sugerida', instrucao: 'Se reprovado: a ação sugerida para corrigir (uma frase). Vazio se aprovado.' },
        { nome: 'mensagem_ao_usuario', instrucao: 'Só quando tipo_de_falha for claimed_without_execution: 2 a 3 frases, no MESMO IDIOMA do pedido do usuário, dizendo com honestidade que a ação NÃO foi executada (nada foi feito) e o que o usuário pode fazer a seguir — pedir de novo, ou dar o dado que faltar. Sem desculpas longas e sem repetir a resposta rejeitada. Vazio nos outros casos.' },
    ],
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'liberar',
    adaptador: adaptarQualidadeDaResposta,
};

/** Decisão do consumidor do validador de passo (StepSemanticValidator): a escala de três estados que ele sempre usou. */
export interface DecisaoDoPasso {
    result: 'relevant' | 'mismatch' | 'unverifiable';
    confidence: number;
    reason?: string;
}

export function adaptarResultadoDoPasso(v: VereditoPadrao): DecisaoDoPasso {
    const confidence = typeof v.confianca === 'number' ? v.confianca : 0.6;
    if (v.estado === 'nao_avaliavel') return { result: 'unverifiable', confidence: v.naoAvaliavelPorque ? 0.5 : confidence, reason: v.naoAvaliavelPorque ?? v.motivo };
    return { result: v.estado === 'reprovado' ? 'mismatch' : 'relevant', confidence, reason: v.motivo };
}

/** M4 — validador de passo (StepSemanticValidator.llmValidate): "o resultado endereça a intenção do passo?" */
export const descritorResultadoDoPasso: DescritorDeValidacao<DecisaoDoPasso> = {
    tipo: 'resultado_do_passo',
    pergunta: 'O resultado da ferramenta, junto com os fatos da execução, ENDEREÇA a intenção do passo?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: false },
        { nome: 'resultado', rotulo: 'Resultado da ferramenta (íntegro)', papel: 'objeto', obrigatoria: true },
        { nome: 'passo', rotulo: 'Intenção do passo e ferramenta executada', papel: 'contexto_da_execucao', obrigatoria: true },
        { nome: 'fatos', rotulo: 'Fatos da execução', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'Liste UM item: "o resultado trata do que o passo pediu (as mesmas entidades, o mesmo arquivo, a mesma ação)". confere="sim" se trata; confere="nao" SÓ quando houver desencontro claro (ex.: o passo pede cotações de BTC/ZEC e o resultado lista ETH/ENA; o passo pede criar arquivo e o resultado é um erro genérico); confere="sem_evidencia" quando o resultado não permite dizer se o passo foi atendido. Informe a confiança do veredito em "confianca".',
    ],
    agregacao: 'itens',
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'liberar',   // o consumidor trata "não verificável" como estado intermediário próprio
    adaptador: adaptarResultadoDoPasso,
};

/** Decisão do consumidor da revisão de risco (RiskAnalyzer): o plano está bom, ou quais riscos o juiz apontou. */
export interface DecisaoDeRisco {
    planoBom: boolean;
    riscos: string[];
}

export function adaptarRiscoDoPlano(v: VereditoPadrao): DecisaoDeRisco {
    const riscos = (v.extras?.riscos ?? '').split('|').map(r => r.trim()).filter(Boolean);
    if (v.estado === 'reprovado') return { planoBom: false, riscos: riscos.length ? riscos : (v.motivo ? [v.motivo] : []) };
    return { planoBom: true, riscos: [] };
}

/** M5 — revisão de risco do plano (RiskAnalyzer.revisarPlanoComLLM): só validação; os riscos voltam como fato. */
export const descritorRiscoDoPlano: DescritorDeValidacao<DecisaoDeRisco> = {
    tipo: 'risco_do_plano',
    pergunta: 'O plano está completo e correto para cumprir o pedido do usuário?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido original do usuário', papel: 'contexto_do_usuario', obrigatoria: true },
        { nome: 'plano', rotulo: 'Plano (passos e ferramentas)', papel: 'objeto', obrigatoria: true },
        { nome: 'objetivo', rotulo: 'Objetivo extraído do pedido', papel: 'contexto_da_execucao', obrigatoria: false },
        { nome: 'ferramentas', rotulo: 'Ferramentas disponíveis', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'Falta algum passo? (ex.: criar arquivo → conferir → enviar; não pular o envio)',
        'Algum passo depende do resultado do anterior sem capturá-lo explicitamente?',
        'A ordem dos passos está correta?',
        'O resultado final será ENTREGUE ao usuário? (se o pedido pede envio de arquivo, deve haver um passo de envio)',
    ],
    agregacao: 'modelo',
    camposExtras: [{ nome: 'riscos', instrucao: 'Os riscos encontrados, separados por " | " (vazio se o plano estiver completo e correto).' }],
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'liberar',   // revisão de risco que não conclui deixa o plano como está
    adaptador: adaptarRiscoDoPlano,
};

/** Decisão do consumidor da validação de conclusão (GoalExecutionLoop.validateGoalCompletion). */
export interface DecisaoDeConclusao {
    achieved: boolean;
    summary?: string;
    reason?: string;
    suggestions?: string[];
}

export function adaptarConclusaoDoObjetivo(v: VereditoPadrao): DecisaoDeConclusao {
    // Outcome Integrity (S5.5a): não conseguir verificar NÃO é sucesso.
    if (v.estado === 'nao_avaliavel') {
        return { achieved: false, reason: 'Validação técnica indisponível (a validação não chegou a um veredito) — objetivo não pôde ser confirmado como concluído.' };
    }
    const sugestoes = (v.extras?.sugestoes ?? '').split('|').map(x => x.trim()).filter(Boolean);
    if (v.estado === 'aprovado') return { achieved: true, summary: v.extras?.resumo ?? v.motivo };
    return { achieved: false, reason: v.motivo, suggestions: sugestoes.length ? sugestoes : undefined };
}

/** M6 — validação de conclusão do objetivo (GoalExecutionLoop.validateGoalCompletion). */
export const descritorConclusaoDoObjetivo: DescritorDeValidacao<DecisaoDeConclusao> = {
    tipo: 'conclusao_do_objetivo',
    pergunta: 'O objetivo (ou o marco atual) foi COMPLETAMENTE concluído, e o resultado/entregável esperado foi produzido?',
    entradas: [
        { nome: 'pedido', rotulo: 'Intenção original do usuário', papel: 'contexto_do_usuario', obrigatoria: true },
        { nome: 'alvo', rotulo: 'Alvo da validação (objetivo ou marco)', papel: 'objeto', obrigatoria: true },
        { nome: 'resultados', rotulo: 'Passos executados e resultados das ferramentas', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'artefatos', rotulo: 'Artefatos produzidos e já entregues (conteúdo real)', papel: 'fonte_de_verdade', obrigatoria: false },
        { nome: 'contratos', rotulo: 'Progresso e contratos declarados pelo plano', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'O que foi pedido foi feito — não só dados coletados ou efeitos colaterais, mas a resposta/entrega que o usuário espera? Se for um marco de desenvolvimento, os arquivos/funcionalidades desse marco foram realmente criados e testados?',
        'Se o pedido exigia um arquivo/artefato, ele existe com conteúdo real? Um arquivo criado por "write" com menos de 200 caracteres, ou com placeholders evidentes ("[Inserir aqui", "TODO", "stub", "conteúdo será adicionado", texto genérico de uma linha sem dados reais), NÃO é entrega: reprove.',
        'Se o plano declarou um contrato de resposta ou havia entrega prevista, ele foi cumprido (ou a mudança foi explicada ao usuário)?',
        'Interpretação de saídas: comandos de edição in-place (sed -i, python3 -c com open().write() etc.) produzem saída VAZIA quando bem-sucedidos — saída vazia sem mensagem de erro é sucesso; uma leitura posterior que mostra o conteúdo modificado confirma a edição. Se o conteúdo real do arquivo está disponível, é ELE a fonte primária de verdade.',
        'Se há artefatos já entregues listados, o resumo deve mencioná-los (nome do arquivo) como o resultado entregue — não descreva só os passos do ciclo atual como se fossem o objetivo. Se o progresso por componente mostra 70% ou mais concluído, trate a entrega parcial como aprovada, com o resumo dizendo o que ficou pendente.',
    ],
    agregacao: 'modelo',
    camposExtras: [
        { nome: 'resumo', instrucao: 'Se aprovado: resumo do que foi feito e entregue neste marco/objetivo. Vazio se reprovado.' },
        { nome: 'sugestoes', instrucao: 'Se reprovado: ações para concluir o que falta, separadas por " | " (e o que falta em "motivo"). Vazio se aprovado.' },
    ],
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'bloquear',   // Outcome Integrity (S5.5a): não confirmar não é sucesso
    adaptador: adaptarConclusaoDoObjetivo,
};

/** Decisão do consumidor do detector de conteúdo-molde: `isStub` = o texto NÃO é conteúdo real. */
export interface DecisaoDeMolde {
    isStub: boolean;
    reason: string;
}

export function adaptarConteudoMolde(v: VereditoPadrao): DecisaoDeMolde {
    // Sem veredito vale a política do tipo (bloquear): o consumidor lê `deveBloquear`; aqui só o estado declarado.
    const isStub = v.estado !== 'aprovado';
    return { isStub, reason: v.motivo ?? (isStub ? 'classificado como stub' : 'classificado como conteúdo real') };
}

/** Detector de conteúdo-molde (shared/contentStubClassifier): conteúdo real × descrição/placeholder. */
export const descritorConteudoMolde: DescritorDeValidacao<DecisaoDeMolde> = {
    tipo: 'conteudo_molde',
    pergunta: 'O texto é CONTEÚDO REAL, pronto para entrega direta ao usuário (mesmo que curto ou simples)?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: false },
        { nome: 'texto', rotulo: 'Texto a avaliar (será entregue como arquivo ou narração, sem revisão humana)', papel: 'objeto', obrigatoria: true },
        { nome: 'ferramenta', rotulo: 'Ferramenta que vai entregar o texto', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'O texto responde ao pedido real — não é uma DESCRIÇÃO do que deveria ser gerado (menciona "passo N", "dados obtidos anteriormente", identificadores entre colchetes como [resultado_do_passo_1], "conteúdo será gerado", ou descreve o processo em vez de responder)?',
    ],
    agregacao: 'modelo',
    raciocinio: 'livre',   // respeita o provedor e o modelo: com think:false o glm-5.3 escrevia ~25 mil chars de análise no CONTEÚDO (produção 10/10)
    semVeredito: 'bloquear',   // fail-closed: falso positivo é aceitável, falso negativo não
    adaptador: adaptarConteudoMolde,
};
