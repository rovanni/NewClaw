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
const AGENT_LOOP_SOURCE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8'
);
const TOOL_REGISTRY_SOURCE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'core', 'ToolRegistry.ts'), 'utf-8'
);

// Fonte única com AgentLoop.ts (core/ToolRegistry.ts) — copiado aqui pela mesma razão que o
// resto da função é reproduzida (DI pesado demais para instanciar GoalExecutionLoop real).
const DIRECT_DELIVERABLE_TOOLS: readonly string[] = ['weather', 'crypto_analysis'];

/**
 * Reprodução do algoritmo de `buildResult()` (DI pesado demais para instanciar
 * GoalExecutionLoop — mesma abordagem de S10/S47/S48). A fidelidade da cópia é garantida
 * pelas asserções estruturais de S175-5 sobre o source real.
 *
 * 14/08/2026 (achado A da campanha "River — Goal-Driven Delivery"): `lastSuccessOutput` só entra
 * na cadeia quando vem de uma tool "segura para entrega crua" (agentloop — já sintetizado pelo
 * LLM — ou uma tool na allowlist). Sem isso, o dump operacional de `web_navigate`/`web_search`
 * (URL, "Modo de navegacao: html-fallback", "Resultados encontrados: 0") podia vencer o resumo
 * do validador e virar a resposta final.
 */
function computeFinalOutput(
    overrideOutput: string | undefined,
    lastSuccessOutput: string | undefined,
    lastSuccessToolName: string | undefined,
    lastCompletedStepResult: string | undefined,
    success: boolean,
    hasSeparateDelivery: boolean,
): string {
    const hasGenericSummary = overrideOutput === GENERIC_CRITERIA_SUMMARY;
    const summaryIsCoverNote = !success || hasSeparateDelivery;
    const lastSuccessIsSafeToDeliverRaw = lastSuccessOutput !== undefined && (
        lastSuccessToolName === 'agentloop' ||
        (lastSuccessToolName !== undefined && DIRECT_DELIVERABLE_TOOLS.includes(lastSuccessToolName))
    );
    return (summaryIsCoverNote && !hasGenericSummary ? overrideOutput : undefined)
        ?? (lastSuccessIsSafeToDeliverRaw ? (lastSuccessOutput || undefined) : undefined)
        ?? (!hasGenericSummary ? overrideOutput : undefined)
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

    const result = computeFinalOutput(resumoDoValidador, explicacaoReal, 'agentloop', undefined, true, false);

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

    const result = computeFinalOutput(resumo, outputCru, 'send_document', undefined, true, true);
    assert(result === resumo, 'com artefato entregue, o resumo em prosa continua vencendo', result);
}

console.log('\n=== S175-2b — achado A (14/08/2026): dump operacional NÃO vence o resumo do validador ===');
{
    // Incidente real: goal_1786759205879_fmpwq ("Qual o valor do River, criptomoeda?"). Um step
    // 'web_navigate' (StepSemanticValidator promoveu erroneamente a 'success') virou lastSuccess.
    // Sem o gate por identidade de tool, esse dump vencia qualquer resumo do validador — mesma
    // classe de bug que S175 já guarda (resumo vs. conteúdo), só que na direção oposta: aqui o
    // "conteúdo" não era conteúdo nenhum, era diagnóstico interno da ferramenta.
    const resumoDoValidador = 'O valor da criptomoeda River (RIVER) foi obtido com sucesso. '
        + 'O preço atual é de aproximadamente $2,61.';
    const dumpOperacional = 'Busca em navegador texto: River cryptocurrency price\n'
        + 'URL: https://lite.duckduckgo.com/lite/?q=River%20cryptocurrency%20price\n'
        + 'Modo de navegacao: html-fallback\n'
        + 'Resultados encontrados: 0\n\n'
        + 'Leitura da pagina de resultados:\n'
        + 'River cryptocurrency price at DuckDuckGo';

    const result = computeFinalOutput(resumoDoValidador, dumpOperacional, 'web_navigate', undefined, true, false);
    assert(result === resumoDoValidador, 'web_navigate não é tool de entrega direta — resumo do validador vence', result.slice(0, 60));
    assert(!/Modo de navegacao/.test(result), 'o dump operacional não vaza para o usuário');

    // Contraste: crypto_analysis É allowlisted — o output cru dela é a resposta pronta, e deve
    // continuar vencendo o resumo (mesma garantia que Bitcoin/weather já tinham em AgentLoop.ts).
    const outputCryptoAnalysis = '🔍 **Bitcoin (BTC)**\n\nPreço: $62.985\nMarket Cap: $1.26T\n';
    const comCryptoAnalysis = computeFinalOutput(resumoDoValidador, outputCryptoAnalysis, 'crypto_analysis', undefined, true, false);
    assert(comCryptoAnalysis === outputCryptoAnalysis, 'crypto_analysis (allowlisted) continua entregando o output cru', comCryptoAnalysis.slice(0, 40));

    // Contraste: step 'agentloop' (texto já sintetizado pelo LLM) continua vencendo — é o mesmo
    // caso S175-1 (scaffolding), agora explícito quanto ao toolName.
    const outputAgentloop = 'O scaffolding é uma metáfora derivada da construção civil...';
    const comAgentloop = computeFinalOutput(resumoDoValidador, outputAgentloop, 'agentloop', undefined, true, false);
    assert(comAgentloop === outputAgentloop, "step 'agentloop' (já sintetizado) continua vencendo o resumo", comAgentloop.slice(0, 40));

    // web_search sofre do mesmo problema estrutural que web_navigate — mesmo gate se aplica.
    const outputWebSearch = 'Consulta: River cryptocurrency price 2026\nNenhum resultado relevante.';
    const comWebSearch = computeFinalOutput(resumoDoValidador, outputWebSearch, 'web_search', undefined, true, false);
    assert(comWebSearch === resumoDoValidador, 'web_search também não é tool de entrega direta — resumo vence', comWebSearch.slice(0, 60));
}

console.log('\n=== S175-3 — numa falha, a explicação do erro continua tendo prioridade ===');
{
    // Em falha, overrideOutput é buildFailureExplanation/blockReason/erro de envio — nunca pode
    // ser substituído pelo output de um step que por acaso teve sucesso antes do goal falhar.
    const explicacaoDaFalha = 'Não foi possível gerar o PDF: o pandoc não está instalado.';
    const outputDeUmStepAnterior = 'Arquivo relatorio.md criado';

    const semArtefato = computeFinalOutput(explicacaoDaFalha, outputDeUmStepAnterior, 'write', undefined, false, false);
    assert(semArtefato === explicacaoDaFalha, 'falha sem artefato: explicação do erro vence', semArtefato);

    const comArtefato = computeFinalOutput(explicacaoDaFalha, outputDeUmStepAnterior, 'write', undefined, false, true);
    assert(comArtefato === explicacaoDaFalha, 'falha com artefato: explicação do erro vence', comArtefato);
}

console.log('\n=== S175-4 — sem NENHUM conteúdo real, ainda mostra algo (sem regressão) ===');
{
    const resumo = 'Objetivo concluído conforme solicitado.';
    const result = computeFinalOutput(resumo, undefined, undefined, undefined, true, false);
    assert(result === resumo, 'sem conteúdo real disponível, o resumo ainda é usado — não regride pra vazio', result);

    const generico = computeFinalOutput(GENERIC_CRITERIA_SUMMARY, undefined, undefined, undefined, true, false);
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
        /\(summaryIsCoverNote && !hasGenericSummary \? overrideOutput : undefined\)\s*\n\s*\?\? this\.pickBestAvailableContent\(goal, overrideOutput\)/.test(SOURCE),
        'sem entrega separada, o conteúdo real (via pickBestAvailableContent — conteúdo seguro antes do resumo) vem antes do resumo na cadeia de precedência',
    );
    // 15/08/2026: a precedência "conteúdo real > resumo" foi extraída para pickBestAvailableContent()
    // — compartilhada com o ramo de falha de envio diferido (ver S234). Guarda contra duplicação.
    assert(
        (SOURCE.match(/const lastSuccessIsSafeToDeliverRaw = !!lastSuccess && \(/g) ?? []).length === 1,
        'a lógica de "seguro para entrega crua" existe em UM lugar só — não duplicada em buildResult() e no ramo de falha',
    );
    assert(
        !/const finalOutput = \(hasGenericSummary \? undefined : overrideOutput\)/.test(SOURCE),
        'não volta à regra antiga (resumo sempre primeiro, com caso especial só pra string genérica)',
    );
    // Achado A (14/08/2026): o gate por identidade de tool existe e reusa a MESMA allowlist que
    // AgentLoop.ts já usava para o bypass de síntese — fonte única em core/ToolRegistry.ts.
    assert(
        /const lastSuccessIsSafeToDeliverRaw = !!lastSuccess && \(/.test(SOURCE),
        'lastSuccessIsSafeToDeliverRaw existe como gate explícito, não implícito',
    );
    assert(
        /lastSuccess\.toolName === 'agentloop' \|\|\s*\n\s*DIRECT_DELIVERABLE_TOOLS\.includes\(lastSuccess\.toolName\)/.test(SOURCE),
        "o gate permite step 'agentloop' (já sintetizado) ou tool na allowlist — nunca tool arbitrária",
    );
    assert(
        /import \{ ToolRegistry, DIRECT_DELIVERABLE_TOOLS \} from '\.\.\/core\/ToolRegistry';/.test(SOURCE),
        'DIRECT_DELIVERABLE_TOOLS é importado de core/ToolRegistry — mesma fonte que AgentLoop.ts, não duplicado',
    );
    // Fonte única de fato: só uma declaração de DIRECT_DELIVERABLE_TOOLS em todo o repo (guarda
    // contra uma futura cópia local divergindo, mesmo bug que TERMINAL_DELIVERY_TOOLS já corrige
    // via S209).
    assert(
        /export const DIRECT_DELIVERABLE_TOOLS: readonly string\[\] = \['weather', 'crypto_analysis'\];/.test(TOOL_REGISTRY_SOURCE),
        'DIRECT_DELIVERABLE_TOOLS é declarado uma única vez, em core/ToolRegistry.ts',
    );
    assert(
        !/const DIRECT_DELIVERABLE_TOOLS = new Set/.test(AGENT_LOOP_SOURCE),
        'AgentLoop.ts não tem mais cópia local de DIRECT_DELIVERABLE_TOOLS — consome a importada',
    );
    assert(
        /import \{ ToolRegistry, DIRECT_DELIVERABLE_TOOLS \} from '\.\.\/core\/ToolRegistry';/.test(AGENT_LOOP_SOURCE),
        'AgentLoop.ts importa DIRECT_DELIVERABLE_TOOLS da mesma fonte',
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
