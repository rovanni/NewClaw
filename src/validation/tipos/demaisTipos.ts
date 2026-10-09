/**
 * ADR-014 M3–M6 — os demais validadores atuais como descritores do motor único, em SOMBRA até a troca.
 * Cada descritor porta as regras do prompt do validador atual (citado em cada um). O estado sai na escala comum
 * (aprovado / reprovado / nao_avaliavel) para a comparação de rodarEmSombra.
 *
 * Todos com raciocínio desligado — é a medição que o ADR-014 pede ("a qualidade dos vereditos sem raciocínio não
 * foi medida"); a decisão de usá-lo nos validadores reais continua com o operador.
 */
import type { DescritorDeValidacao } from '../contratoDeValidacao';

/** M3 — validador de qualidade (ObserverValidator.validate, OBSERVER_PROMPT): "a resposta atende o pedido?" */
export const descritorQualidadeDaResposta: DescritorDeValidacao = {
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
    ],
    agregacao: 'modelo',
    camposExtras: [{ nome: 'tipo_de_falha', instrucao: 'Se reprovado: incomplete_response | read_only | future_action | tool_error | other. Se aprovado: none.' }],
    raciocinio: 'desligado',
    modeloConfig: 'OBSERVER_MODEL',
};

/** M4 — validador de passo (StepSemanticValidator.llmValidate): "o resultado endereça a intenção do passo?" */
export const descritorResultadoDoPasso: DescritorDeValidacao = {
    tipo: 'resultado_do_passo',
    pergunta: 'O resultado da ferramenta, junto com os fatos da execução, ENDEREÇA a intenção do passo?',
    entradas: [
        { nome: 'pedido', rotulo: 'Pedido do usuário', papel: 'contexto_do_usuario', obrigatoria: false },
        { nome: 'resultado', rotulo: 'Resultado da ferramenta (íntegro)', papel: 'objeto', obrigatoria: true },
        { nome: 'passo', rotulo: 'Intenção do passo e ferramenta executada', papel: 'contexto_da_execucao', obrigatoria: true },
        { nome: 'fatos', rotulo: 'Fatos da execução', papel: 'contexto_da_execucao', obrigatoria: false },
    ],
    checklist: [
        'O resultado trata do que o passo pediu (as mesmas entidades, o mesmo arquivo, a mesma ação)? Ex. de não: o passo pede cotações de BTC/ZEC e o resultado lista ETH/ENA; o passo pede criar arquivo e o resultado é um erro genérico.',
        'Se o resultado não permite dizer se o passo foi atendido, responda reprovado só quando houver desencontro claro; caso contrário marque o item como sem_evidencia.',
    ],
    agregacao: 'modelo',
    raciocinio: 'desligado',
    modeloConfig: 'SEMANTIC_VALIDATOR_MODEL',
};

/** M5 — revisão de risco do plano (RiskAnalyzer.revisarPlanoComLLM): só validação; os riscos voltam como fato. */
export const descritorRiscoDoPlano: DescritorDeValidacao = {
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
    raciocinio: 'desligado',
    modeloConfig: 'RISK_MODEL',
};

/** M6 — validação de conclusão do objetivo (GoalExecutionLoop.validateGoalCompletion). */
export const descritorConclusaoDoObjetivo: DescritorDeValidacao = {
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
        'O que foi pedido foi feito — não só dados coletados ou efeitos colaterais, mas a resposta/entrega que o usuário espera?',
        'Se o pedido exigia um arquivo/artefato, ele existe com conteúdo real (não placeholder nem texto genérico de uma linha)?',
        'Se o plano declarou um contrato de resposta ou havia entrega prevista, ele foi cumprido (ou a mudança foi explicada ao usuário)?',
    ],
    agregacao: 'modelo',
    raciocinio: 'desligado',
    modeloConfig: 'OBSERVER_MODEL',
};

/** Detector de conteúdo-molde (shared/contentStubClassifier): conteúdo real × descrição/placeholder. */
export const descritorConteudoMolde: DescritorDeValidacao = {
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
    raciocinio: 'desligado',
    modeloConfig: 'CLASSIFIER_MODEL',
};
