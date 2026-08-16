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

export const AUTO_DELIVERY_CRITERION_IDS = {
    send_document: 'auto_delivery_send_document',
    send_audio: 'auto_delivery_send_audio',
    structural_bypass_send_document: 'auto_structural_bypass_send_document',
    response_produced: 'auto_response_produced',
} as const;

const DELIVERY_TOOLS = ['send_document', 'send_audio'] as const;

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
 * `vision` ("analyzing images... OCR" sempre produz uma descrição). EXCLUÍDAS: `system_operation`/
 * `destructive` (ação pura, sem pergunta embutida — exatamente o caso que S30-6/7/8 já protegem
 * na função-irmã, e a mesma exceção que a descrição original de `response_produced` documenta em
 * GoalPlanner.ts: "não use para pedidos de AÇÃO pura sem pergunta embutida"), `audio` (já tem seu
 * próprio critério `tool_succeeded(send_audio)` cobrindo a entrega), `greeting`/`confirmation`/
 * `rejection` (raramente chegam ao ciclo de Goal — resolvidos inline por `isGoal=false`).
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
): SuccessCriterion[] {
    if (!category || !RESPONSE_CONTRACT_CATEGORIES.has(category)) return successCriteria;
    if (successCriteria.some(c => c.check === 'response_produced')) return successCriteria; // LLM já declarou

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
