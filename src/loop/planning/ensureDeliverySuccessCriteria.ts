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

export const AUTO_DELIVERY_CRITERION_IDS = {
    send_document: 'auto_delivery_send_document',
    send_audio: 'auto_delivery_send_audio',
    structural_bypass_send_document: 'auto_structural_bypass_send_document',
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
