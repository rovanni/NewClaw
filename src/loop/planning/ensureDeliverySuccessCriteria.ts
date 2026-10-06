/**
 * ensureDeliverySuccessCriteria — garante deterministicamente que Goals cujo plano FINAL
 * (já sanitizado, pós Q2/RiskAnalyzer) contém `send_document`/`send_audio` tenham um critério
 * `tool_succeeded` correspondente em `successCriteria` — sem depender do LLM lembrar de incluir
 * isso no JSON do plano, e sem depender de como o resumo final é fraseado (voz ativa/passiva).
 *
 * BUG REAL que motivou esta função (conversa 04/07/2026, log_conversa_newclaw.txt): um Goal de
 * áudio foi marcado achieved=true porque a checagem de evidência dependia de regex sobre o
 * texto final do LLM ("foi enviado" vs "enviou") — nenhuma tool de entrega real precisava ter
 * tido sucesso genuíno. `successCriteria` já bypassa completamente essa fragilidade (ver
 * GoalExecutionLoop.validateGoalCompletion — quando os critérios são satisfeitos, o LLM nem é
 * consultado), mas só funciona se estiver populado — e o prompt só reforçava isso para
 * send_document, nunca para send_audio, e não havia nenhum reforço em código quando o LLM
 * esquecia.
 *
 * Puro e determinístico por design: só examina os PARÂMETROS recebidos (steps finais e
 * successCriteria candidatos) — nunca userIntent, nunca histórico de attempts/toolsTried,
 * nunca planos anteriores. Isso é o que torna seguro chamar esta função tanto no plano inicial
 * quanto em TODO replan: o resultado reflete sempre e só o plano que está prestes a executar
 * agora, nunca uma obrigação "presa" de uma estratégia já abandonada.
 *
 * IDs reservados (`auto_delivery_send_document`/`auto_delivery_send_audio`) marcam os critérios
 * criados por esta função — permite recalculá-los do zero a cada chamada (removendo a versão
 * anterior antes de decidir se injeta de novo) sem precisar de um campo `source` novo no tipo
 * SuccessCriterion nem de heurística para "adivinhar" quais critérios são auto-gerados.
 */

import { PlanStep, SuccessCriterion } from '../GoalTypes';
import type { IntentCategory } from '../../shared/domainTypes';
import { DIRECT_DELIVERABLE_TOOLS } from '../../core/ToolRegistry';

export const AUTO_DELIVERY_CRITERION_IDS = {
    send_document: 'auto_delivery_send_document',
    send_audio: 'auto_delivery_send_audio',
    structural_bypass_send_document: 'auto_structural_bypass_send_document',
    response_produced: 'auto_response_produced',
    delivery_not_abandoned: 'auto_delivery_not_abandoned',
} as const;

const DELIVERY_TOOLS = ['send_document', 'send_audio'] as const;
const AUDIO_DELIVERED_SENTINEL = '__send_audio_delivered__';

export function ensureDeliverySuccessCriteria(
    steps: PlanStep[],
    successCriteria: SuccessCriterion[],
): SuccessCriterion[] {
    const stepTools = new Set(steps.map(s => s.toolName).filter((t): t is string => Boolean(t)));

    // Remove a versão anterior dos critérios auto-injetados — sempre recalculados a partir dos
    // steps finais ATUAIS, nunca acumulados/duplicados entre chamadas (plano inicial, cada replan).
    const kept = successCriteria.filter(c =>
        c.id !== AUTO_DELIVERY_CRITERION_IDS.send_document &&
        c.id !== AUTO_DELIVERY_CRITERION_IDS.send_audio &&
        c.id !== AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document
    );

    const result = [...kept];
    for (const tool of DELIVERY_TOOLS) {
        if (!stepTools.has(tool)) continue; // step de entrega não está no plano final: nada a garantir

        const alreadyCovered = kept.some(c => c.check === 'tool_succeeded' && c.tool === tool);
        if (alreadyCovered) continue; // LLM já forneceu critério equivalente: preserva, não duplica

        result.push({
            id: AUTO_DELIVERY_CRITERION_IDS[tool],
            description: `Entrega confirmada via ${tool}`,
            check: 'tool_succeeded',
            tool,
            status: 'pending',
        });
    }

    // ARCH-018: mesmo padrão acima, para o critério de bypass estrutural (arquivo já pronto no
    // disco para um send_document ainda pendente) — só faz sentido quando send_document está no
    // plano final; a avaliação em si (evaluateCriteria(), case 'pending_send_verified_on_disk')
    // decide dinamicamente, a cada chamada, se os pendentes ATUAIS já existem no disco.
    if (stepTools.has('send_document')) {
        result.push({
            id: AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document,
            description: 'Arquivo(s) pendente(s) de envio já existem no disco',
            check: 'pending_send_verified_on_disk',
            status: 'pending',
        });
    }
    return result;
}

/**
 * ensureResponseContractCriterion — garante deterministicamente que Goals cuja categoria de
 * intenção (já classificada por UnifiedIntentRouter, sem chamada de LLM nova) é tipicamente uma
 * PERGUNTA tenham o critério `response_produced` — sem depender do LLM lembrar de declará-lo no
 * JSON do plano inicial (mesmo padrão desta função-irmã, aplicado ao caso complementar: lá é
 * "tool de entrega presente → injeta `tool_succeeded`"; aqui é "categoria pergunta → injeta
 * `response_produced`").
 *
 * Deliberadamente SEPARADA de `ensureDeliverySuccessCriteria()`, não uma extensão dela: aquela
 * função é pura por design (regra explícita, ver S30-8 — "o intent nunca é lido pela função" —
 * só examina o plano final). Ler a categoria de intenção aqui é uma responsabilidade diferente
 * (ver docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md — cada função responde a UMA
 * pergunta), então vive em uma função própria, não dentro da pura.
 *
 * Chamada só uma vez, no plano inicial (GoalExecutionLoop.executeGoal) — nunca a cada replan: o
 * mecanismo de merge já existente (`preservedCriteria` em GoalExecutionLoop.planWithSpiral)
 * preserva qualquer critério que não seja `auto_delivery_send_document`/`auto_delivery_send_audio`
 * entre gerações, então um `response_produced` adicionado na geração 0 sobrevive a replans sem
 * precisar ser recalculado — ao contrário dos critérios de entrega (que dependem dos STEPS finais
 * de CADA geração, por isso `ensureDeliverySuccessCriteria` roda em toda chamada de replan).
 *
 * Achado real, goal de verificação (16/08/2026): "como está minha posição atual do river?"
 * (category=data_analysis) replanejou 2x (semantic_mismatch em web_search, tool_error em
 * memory_write); o plano FINAL sobrevivente (`crypto_analysis`, `web_navigate`) não continha
 * nenhuma tool de síntese nem de entrega, `response_produced` nunca foi declarado pelo LLM em
 * NENHUMA geração (`successCriteria` ficou `[]` do início ao fim, confirmado no banco), o
 * validador LLM nunca foi instruído a exigir uma resposta real, e `achieved=true` foi aprovado
 * com o RESUMO da validação vazando como se fosse a resposta ao usuário.
 *
 * Categorias incluídas — extraídas das definições que o próprio prompt de classificação já usa
 * (`UnifiedIntentRouter.buildClassificationMessages`, `baseCategories`), não inventadas aqui:
 * `information` ("factual questions"), `data_analysis` ("analyzing data... crypto/market
 * prices"), `memory_operation` ("retrieving from memory" é claramente uma pergunta; "saving"
 * também se beneficia de uma confirmação real em vez de um resumo de processo — custo de incluir
 * é uma validação LLM a mais, nunca uma resposta errada), `conversation` ("general chat"),
 * `vision` ("analyzing images... OCR" sempre produz uma descrição), e `creation` (adicionada no commit
 * consolidado `849b881`, 16/08/2026, sem documentação aqui até a issue 048): um pedido de CRIAÇÃO sem
 * ferramenta de entrega ("escreva um poema") tem o texto como entregável, então precisa de uma resposta.
 * EXCLUÍDAS: `system_operation`/
 * `destructive` (ação pura, sem pergunta embutida — exatamente o caso que S30-6/7/8 já protegem
 * na função-irmã, e a mesma exceção que a descrição original de `response_produced` documenta em
 * GoalPlanner.ts: "não use para pedidos de AÇÃO pura sem pergunta embutida"), `audio` (já tem seu
 * próprio critério `tool_succeeded(send_audio)` cobrindo a entrega), `greeting`/`confirmation`/
 * `rejection` (raramente chegam ao ciclo de Goal — resolvidos inline por `isGoal=false`).
 *
 * EXCEÇÃO ESTRUTURAL (issue 048, Sprint 2): quando o plano JÁ contém uma ferramenta de entrega
 * (`send_document`/`send_audio`, as mesmas `DELIVERY_TOOLS` do módulo), o entregável é o artefato — não
 * se acrescenta `response_produced`. Reprodução real (26/09/2026): "crie o programa e me envie o .py",
 * categoria `creation`, `.py` entregue em 4,4 min; o critério injetado manteve o goal trabalhando por
 * mais 25 min em redação/validação de um texto que ninguém pediu. A checagem é presença de ferramenta
 * no plano, nunca interpretação do pedido. Se um replan posterior abandonar a entrega, quem cobre é
 * `delivery_not_silently_abandoned` (S244) — desenhado exatamente para categorias sem
 * `response_produced`. `steps` é opcional: omitido, o comportamento é o de antes.
 *
 * `category` opcional (undefined quando o router falhou e o caminho fail-open do GoalOrchestrator
 * foi usado, ou quando o chamador — ex: avanço de marco de construção — não tem uma classificação
 * fresca): omite a injeção nesse caso, mesma postura conservadora de "não decidir sem evidência"
 * (NUNCA_ADIVINHAR.md) — não inventa uma categoria, só deixa de reforçar.
 */
const RESPONSE_CONTRACT_CATEGORIES = new Set<IntentCategory>([
    'information', 'data_analysis', 'memory_operation', 'conversation', 'vision', 'creation',
]);

export function ensureResponseContractCriterion(
    category: IntentCategory | undefined,
    successCriteria: SuccessCriterion[],
    steps: PlanStep[] = [],
): SuccessCriterion[] {
    if (!category || !RESPONSE_CONTRACT_CATEGORIES.has(category)) return successCriteria;
    if (successCriteria.some(c => c.check === 'response_produced')) return successCriteria; // LLM já declarou
    // O plano já entrega um artefato: ele É a resposta (ver "EXCEÇÃO ESTRUTURAL" acima).
    if (steps.some(s => s.toolName !== undefined && (DELIVERY_TOOLS as readonly string[]).includes(s.toolName))) return successCriteria;

    return [
        ...successCriteria,
        {
            id: AUTO_DELIVERY_CRITERION_IDS.response_produced,
            description: 'Existe uma resposta em texto que endereça a pergunta do usuário',
            check: 'response_produced',
            status: 'pending',
        },
    ];
}

/**
 * findResponseContractGap (issue 059) — o plano consegue cumprir o contrato de resposta que o
 * próprio goal declarou? Devolve o FATO (texto para o Planner) quando não consegue; `null` quando
 * consegue ou quando não há contrato.
 *
 * `response_produced` é cobrado pelo validador na conclusão, mas nada garantia que o plano tivesse
 * uma etapa CAPAZ de produzir a resposta. Achado real (06/10/2026, goal_1791297415248_nuj7p, "quantos
 * itens tem a lista do anexo? responda só o número"): planos só de ferramentas (read + exec_command;
 * depois read + memory_write) — o "3" correto foi calculado num exec_command, cuja saída não chega ao
 * usuário; o validador recusou em todo ciclo, corretamente, e a etapa de resposta só apareceu na
 * geração 4, com os ciclos já esgotados. 12 ciclos, ~4,5 min, goal failed.
 *
 * Checagem de EXISTÊNCIA, não de qualidade (determinismo valida, LLM interpreta): só o tipo de cada
 * etapa. Capazes de responder são as mesmas que `pickBestAvailableContent` (GoalExecutionLoop) aceita
 * entregar como resposta — etapa do agente (sem toolName, ou 'agentloop') e `DIRECT_DELIVERABLE_TOOLS`
 * —, mais as ferramentas de entrega de artefato, pela mesma razão da EXCEÇÃO ESTRUTURAL de
 * `ensureResponseContractCriterion` (o artefato É a resposta). Não decide o plano: o chamador rejeita
 * e o fato vai ao Planner, que escolhe como responder.
 */
export function findResponseContractGap(steps: PlanStep[], successCriteria: SuccessCriterion[]): string | null {
    if (!successCriteria.some(c => c.check === 'response_produced')) return null;
    const canAnswer = steps.some(s =>
        s.toolName === undefined || s.toolName === 'agentloop' ||
        DIRECT_DELIVERABLE_TOOLS.includes(s.toolName) ||
        (DELIVERY_TOOLS as readonly string[]).includes(s.toolName));
    if (canAnswer) return null;
    const tools = Array.from(new Set(steps.map(s => s.toolName))).join(', ') || '(nenhuma etapa)';
    return `Plano rejeitado antes da execução: o objetivo exige uma resposta em texto ao usuário, mas nenhuma etapa do plano produz essa resposta — ` +
        `todas são ferramentas (${tools}) cuja saída não chega ao usuário. Inclua uma etapa SEM toolName (executada pelo agente) que use os dados ` +
        `coletados para responder ao usuário. memory_write/memory_search não respondem ao usuário.`;
}

/**
 * trackPromisedDeliveryTools — acumula, de forma monotônica, quais tools de entrega
 * (`send_document`/`send_audio`) já estiveram em ALGUMA geração do plano deste Goal.
 *
 * Puro por design, mesmo padrão de `ensureDeliverySuccessCriteria`: só examina os STEPS
 * recebidos (geração que está prestes a valer) e o que já estava acumulado — nunca lê
 * `goal.attempts`/`userIntent`. Chamado tanto no plano inicial quanto em todo replan; a união
 * é o que permite `detectAbandonedDeliveryTools` responder "isso já foi prometido antes?" numa
 * geração posterior que não contém mais a tool.
 */
export function trackPromisedDeliveryTools(
    steps: PlanStep[],
    previouslyPromised: readonly string[],
): string[] {
    const currentDeliveryTools = steps
        .map(s => s.toolName)
        .filter((t): t is string => t !== undefined && (DELIVERY_TOOLS as readonly string[]).includes(t));
    return Array.from(new Set([...previouslyPromised, ...currentDeliveryTools]));
}

/**
 * detectAbandonedDeliveryTools — de tudo que já foi prometido (`promisedTools`, acumulado por
 * `trackPromisedDeliveryTools`), quais tools NÃO estão no plano final desta geração E ainda não
 * foram entregues de fato (`sentArtifacts`)? Uma tool que sumiu do plano mas já foi entregue em
 * ciclo anterior não é abandono — é entrega concluída, o step só não precisa mais rodar de novo.
 *
 * Puro e estrutural: presença/ausência de um toolName numa lista, presença/ausência de um path
 * numa lista — nenhuma interpretação de texto. Não decide se o abandono é legítimo (ex.: pandoc
 * ausente, usuário já avisado) ou uma falha silenciosa — só produz o fato para
 * `ensureDeliveryNotAbandonedCriterion`/`validateGoalCompletion` (o LLM) ponderar.
 */
export function detectAbandonedDeliveryTools(
    promisedTools: readonly string[],
    finalSteps: PlanStep[],
    sentArtifacts: readonly string[],
): string[] {
    const currentTools = new Set(finalSteps.map(s => s.toolName).filter((t): t is string => Boolean(t)));
    const audioAlreadyDelivered = sentArtifacts.includes(AUDIO_DELIVERED_SENTINEL);
    const documentAlreadyDelivered = sentArtifacts.some(p => p !== AUDIO_DELIVERED_SENTINEL);
    return promisedTools.filter(tool => {
        if (currentTools.has(tool)) return false;
        if (tool === 'send_audio') return !audioAlreadyDelivered;
        if (tool === 'send_document') return !documentAlreadyDelivered;
        return true;
    });
}

/**
 * ensureDeliveryNotAbandonedCriterion — injeta o GATE `delivery_not_silently_abandoned` quando
 * `detectAbandonedDeliveryTools` encontrou pelo menos uma tool abandonada. Mesmo padrão de
 * `ensureResponseContractCriterion`: recalculado do zero a cada chamada (remove a versão
 * anterior antes de decidir se injeta de novo), nunca acumula entre gerações.
 */
export function ensureDeliveryNotAbandonedCriterion(
    abandonedTools: readonly string[],
    successCriteria: SuccessCriterion[],
): SuccessCriterion[] {
    const kept = successCriteria.filter(c => c.id !== AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned);
    if (abandonedTools.length === 0) return kept;

    return [
        ...kept,
        {
            id: AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned,
            description: `Entrega de ${abandonedTools.join('/')} prometida em geração anterior do plano não está mais na estratégia atual`,
            check: 'delivery_not_silently_abandoned',
            status: 'pending',
        },
    ];
}
