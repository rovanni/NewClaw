/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S175
 * A resposta entregue ao usuário é o ENTREGÁVEL, nunca um resumo sobre ele — e o entregável
 * não é truncado antes de chegar lá.
 *
 * CONTEXTO (incidente real, 02/08/2026, rastreado em logs/newclaw-audit.log):
 *
 *     15:12  usuário: "Explique melhor scaffolding (andaime pedagógico)?"
 *            → [GOAL-ROUTING] route=goal_orchestrator
 *            → [VALIDATION] achieved=true artifact_count=0
 *              reason="A explicação sobre scaffolding foi fornecida com sucesso..."
 *            → [USER-MESSAGE] source=goal_success output_len=266
 *     15:38  usuário repete A MESMA pergunta          → output_len=308
 *     15:43  usuário: "Conseguiu?"
 *            → [GOAL-ROUTING] route=agentloop        → response_len=2448  ← a explicação real
 *
 * O usuário recebeu duas vezes uma DESCRIÇÃO da resposta ("a explicação foi fornecida com
 * sucesso") em vez da resposta, e só obteve a explicação 32 minutos depois, quando a mensagem
 * seguinte escapou pela rota AgentLoop, fora do goal.
 *
 * DUAS CAUSAS ENCADEADAS:
 *
 *  D1 — o conteúdo era destruído antes de poder ser entregue. Todo output de step era gravado
 *       com `.slice(0, 300)`, inclusive o do step 'agentloop', cujo output É a resposta em prosa.
 *       Prova no log: `[VALIDATION-INPUT] attempts_chars=313` = "- agentloop: " (13) + 300.
 *
 *  D2 — o resumo do validador tinha prioridade sobre o conteúdo em `buildResult()`. O prompt do
 *       validador pede literalmente "resumo do que foi feito e entregue" — uma descrição, não o
 *       entregável.
 *
 * TERCEIRA OCORRÊNCIA DA MESMA CLASSE. As duas anteriores (05/07/2026) foram corrigidas
 * pontualmente, cada uma tratando a STRING que vazou naquele dia:
 *   • "Entrega confirmada via send_audio"        → filtro de AUTO_DELIVERY_IDS
 *   • GENERIC_CRITERIA_SUMMARY                    → caso especial em buildResult (S48)
 * A regra estrutural — um resumo vence o conteúdo — seguia intacta, e vazou de novo com uma
 * string nova. Este teste guarda a REGRA, não mais uma string.
 *
 * REGRESSÃO SE: um goal sem entrega separada (sem arquivo/áudio enviado) voltar a responder com
 * o resumo do validador em vez do conteúdo produzido; ou se o output do step 'agentloop' voltar
 * a ser truncado no limite de evidência.
 *
 * Execução: npx ts-node src/__tests__/regression/S175_GoalDeliverable_NotReplacedBySummary.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos.';
const ATTEMPT_OUTPUT_EVIDENCE_LIMIT = 300;
const ATTEMPT_OUTPUT_DELIVERABLE_LIMIT = 8000;

const SOURCE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8'
);

/**
 * Reprodução do algoritmo de `buildResult()` (DI pesado demais para instanciar
 * GoalExecutionLoop — mesma abordagem de S10/S47/S48). A fidelidade da cópia é garantida
 * pelas asserções estruturais de S175-5 sobre o source real.
 */
function computeFinalOutput(
    overrideOutput: string | undefined,
    lastSuccessOutput: string | undefined,
    lastCompletedStepResult: string | undefined,
    success: boolean,
    hasSeparateDelivery: boolean,
): string {
    const hasGenericSummary = overrideOutput === GENERIC_CRITERIA_SUMMARY;
    const summaryIsCoverNote = !success || hasSeparateDelivery;
    return (summaryIsCoverNote && !hasGenericSummary ? overrideOutput : undefined)
        ?? (lastSuccessOutput || undefined)
        ?? lastCompletedStepResult
        ?? (success ? overrideOutput ?? 'Tarefa concluída com sucesso.' : 'Falha ao concluir o objetivo.');
}

/** Reprodução de `attemptOutputLimit()`. */
function attemptOutputLimit(toolName: string | undefined): number {
    return (toolName ?? 'agentloop') === 'agentloop'
        ? ATTEMPT_OUTPUT_DELIVERABLE_LIMIT
        : ATTEMPT_OUTPUT_EVIDENCE_LIMIT;
}

console.log('\n=== S175-1 — reproduz o incidente exato: pergunta sem artefato ===');
{
    // Os valores reais do goal_1785694336666_u96ic.
    const resumoDoValidador = 'A explicação sobre scaffolding (andaime pedagógico) foi fornecida '
        + 'com sucesso, contextualizada para a docência na UENP.';
    const explicacaoReal = '🏗️ Scaffolding (Andaime Pedagógico)\n\nO scaffolding é uma metáfora '
        + 'derivada da construção civil: assim como um andaime sustenta e dá acesso a níveis mais '
        + 'altos de um prédio em construção...';

    const result = computeFinalOutput(resumoDoValidador, explicacaoReal, undefined, true, false);

    assert(result === explicacaoReal, 'sem entrega separada, o usuário recebe a EXPLICAÇÃO', result.slice(0, 60));
    assert(result !== resumoDoValidador, 'o resumo do validador NÃO é a resposta final', result.slice(0, 60));
    assert(
        !/foi fornecida com sucesso/.test(result),
        'a resposta não é uma meta-frase sobre a própria resposta',
    );
}

console.log('\n=== S175-2 — com entrega separada, o resumo continua sendo a nota certa ===');
{
    // Evidência 07/07/2026 (goal_1783430280404_xk7ht): quando o .pptx já foi enviado, o output
    // cru da tool ("Documento anexado") é pior que um resumo em prosa. Sem regressão aqui.
    const resumo = 'Apresentação sobre IPv6 criada e entregue em aula_ipv6.pptx (12 slides).';
    const outputCru = 'Documento anexado';

    const result = computeFinalOutput(resumo, outputCru, undefined, true, true);
    assert(result === resumo, 'com artefato entregue, o resumo em prosa continua vencendo', result);
}

console.log('\n=== S175-3 — numa falha, a explicação do erro continua tendo prioridade ===');
{
    // Em falha, overrideOutput é buildFailureExplanation/blockReason/erro de envio — nunca pode
    // ser substituído pelo output de um step que por acaso teve sucesso antes do goal falhar.
    const explicacaoDaFalha = 'Não foi possível gerar o PDF: o pandoc não está instalado.';
    const outputDeUmStepAnterior = 'Arquivo relatorio.md criado';

    const semArtefato = computeFinalOutput(explicacaoDaFalha, outputDeUmStepAnterior, undefined, false, false);
    assert(semArtefato === explicacaoDaFalha, 'falha sem artefato: explicação do erro vence', semArtefato);

    const comArtefato = computeFinalOutput(explicacaoDaFalha, outputDeUmStepAnterior, undefined, false, true);
    assert(comArtefato === explicacaoDaFalha, 'falha com artefato: explicação do erro vence', comArtefato);
}

console.log('\n=== S175-4 — sem NENHUM conteúdo real, ainda mostra algo (sem regressão) ===');
{
    const resumo = 'Objetivo concluído conforme solicitado.';
    const result = computeFinalOutput(resumo, undefined, undefined, true, false);
    assert(result === resumo, 'sem conteúdo real disponível, o resumo ainda é usado — não regride pra vazio', result);

    const generico = computeFinalOutput(GENERIC_CRITERIA_SUMMARY, undefined, undefined, true, false);
    assert(generico === GENERIC_CRITERIA_SUMMARY, 'fallback genérico preservado quando não há mais nada', generico);
}

console.log('\n=== S175-5 — D2 presente estruturalmente em buildResult() ===');
{
    assert(
        /const hasSeparateDelivery = \(goal\.sentArtifacts \?\? \[\]\)\.length > 0;/.test(SOURCE),
        'a existência de entrega separada é derivada de goal.sentArtifacts — sinal que o goal já mantém',
    );
    assert(
        /const summaryIsCoverNote = !success \|\| hasSeparateDelivery;/.test(SOURCE),
        'o resumo só tem prioridade quando é nota de acompanhamento (falha, ou entrega separada)',
    );
    assert(
        /\(summaryIsCoverNote && !hasGenericSummary \? overrideOutput : undefined\)\s*\n\s*\?\? \(lastSuccess\?\.output \|\| undefined\)/.test(SOURCE),
        'sem entrega separada, o conteúdo real vem antes do resumo na cadeia de precedência',
    );
    assert(
        !/const finalOutput = \(hasGenericSummary \? undefined : overrideOutput\)/.test(SOURCE),
        'não volta à regra antiga (resumo sempre primeiro, com caso especial só pra string genérica)',
    );
}

console.log('\n=== S175-6 — D1: o entregável não é truncado no limite de evidência ===');
{
    assert(
        attemptOutputLimit('agentloop') === ATTEMPT_OUTPUT_DELIVERABLE_LIMIT,
        `step 'agentloop' guarda o output como entregável (${ATTEMPT_OUTPUT_DELIVERABLE_LIMIT})`,
    );
    assert(
        attemptOutputLimit(undefined) === ATTEMPT_OUTPUT_DELIVERABLE_LIMIT,
        'step sem toolName é agentloop — mesmo limite de entregável',
    );
    for (const tool of ['exec_command', 'read', 'write', 'send_document', 'weather']) {
        assert(
            attemptOutputLimit(tool) === ATTEMPT_OUTPUT_EVIDENCE_LIMIT,
            `tool '${tool}' continua guardando só evidência (${ATTEMPT_OUTPUT_EVIDENCE_LIMIT})`,
        );
    }

    // A resposta real do incidente (2448 chars) sobrevive; o corte antigo a destruía.
    const respostaReal = 'x'.repeat(2448);
    assert(
        respostaReal.slice(0, attemptOutputLimit('agentloop')).length === 2448,
        'a resposta de 2448 chars do incidente sobrevive íntegra',
    );
    assert(
        respostaReal.slice(0, ATTEMPT_OUTPUT_EVIDENCE_LIMIT).length === 300,
        'sob o limite antigo ela era cortada em 300 — o corte que causou o incidente',
    );
}

console.log('\n=== S175-7 — D1 presente estruturalmente, nos DOIS pontos que gravam attempt ===');
{
    assert(
        /const ATTEMPT_OUTPUT_EVIDENCE_LIMIT = 300;/.test(SOURCE)
        && /const ATTEMPT_OUTPUT_DELIVERABLE_LIMIT = 8000;/.test(SOURCE),
        'os dois limites existem como constantes nomeadas, não como números mágicos',
    );
    assert(
        /function attemptOutputLimit\(toolName: string \| undefined\): number/.test(SOURCE),
        'a regra vive numa função única — não duplicada nos call sites',
    );

    const usosDoHelper = (SOURCE.match(/slice\(0, attemptOutputLimit\(step\.toolName\)\)/g) ?? []).length;
    assert(
        usosDoHelper === 2,
        `os 2 pontos que gravam GoalAttempt.output usam o helper (encontrados: ${usosDoHelper})`,
    );

    // Guarda contra a regressão silenciosa: um novo call site copiando o literal 300.
    assert(
        !/output: (toolResult\.output\?|output)\.slice\(0, 300\)/.test(SOURCE),
        'nenhum ponto grava GoalAttempt.output com o literal 300',
    );
}

console.log('\n=== S175-8 — o prompt do validador continua recebendo só um excerto ===');
{
    // O entregável íntegro fica no registro do goal, mas NÃO infla o prompt de validação: o
    // validador precisa de evidência para julgar, não da resposta inteira. Sem isso, o custo da
    // validação passaria a crescer com o tamanho da resposta.
    const usosNoPrompt = (SOURCE.match(
        /a\.output\?\.slice\(0, ATTEMPT_OUTPUT_EVIDENCE_LIMIT\) \|\| '\(sem output\)'/g
    ) ?? []).length;
    assert(
        usosNoPrompt === 2,
        `os 2 prompts de LLM que listam attempts truncam no limite de evidência (encontrados: ${usosNoPrompt})`,
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S175 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  D2 — resumo não substitui o entregável (sem entrega separada): testado`);
console.log(`  D2 — resumo preservado como nota (com entrega separada): testado`);
console.log(`  D2 — explicação de falha preservada: testado`);
console.log(`  D1 — entregável do agentloop guardado íntegro: testado`);
console.log(`  D1 — evidência de tool segue limitada a 300: testado`);
console.log(`  Custo do prompt de validação inalterado: testado`);
if (failed > 0) process.exit(1);
