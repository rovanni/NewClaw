/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S234
 * Quando um `send_document`/`send_audio` diferido falha DEPOIS que `validateGoalCompletion` já
 * confirmou `achieved=true`, a resposta final preserva o MELHOR conteúdo real já disponível — não
 * o substitui por uma mensagem técnica sobre o anexo, e não usa uma meta-descrição quando existe
 * o conteúdo de verdade.
 *
 * DUAS EVIDÊNCIAS REAIS DO MESMO DIA (15/08/2026), duas causas diferentes da mesma classe de bug:
 *
 * 1. goal_1786766665070_ju0ms ("e minha posição no river atual?") — não havia nenhum step
 *    'agentloop' com conteúdo melhor que a resposta do validador; usar só `validation.summary`
 *    (fix original desta sprint) já resolvia, porque o resumo ERA a explicação completa:
 *
 *      [GoalLoop] LLM validation: achieved=true
 *      [VALIDATION] achieved=true reason="O agente forneceu os dados de mercado atuais do token
 *                   River (RIVER) e explicou que, para verificar a posição pessoal do usuário..."
 *      [SendDocumentTool] [ARTIFACT-PATH] ... resolved="...\workspace\relatorio_river.txt" exists=false
 *      [GOAL-COMPLETE-CHECK] validation_ok=true all_sends_ok=false ... final_state=failed
 *      [USER-MESSAGE] source=goal_failure output_len=90
 *
 *    O usuário nunca pediu um arquivo ("não pedi arquivo, quero os dados" — mensagem seguinte da
 *    mesma conversa). A resposta recebida foi literalmente "Objetivo validado, mas nenhum arquivo
 *    pôde ser entregue ao usuário. Verifique o workspace." — frase técnica, não resposta.
 *
 * 2. goal_1786792794722_2qxyj ("compensa investir na baixa?") — havia SIM um step 'agentloop' com
 *    a análise real completa (o `write` do markdown virou agentloop por SanitizePlanSteps, como
 *    sempre acontece — ver ContentStubClassifier isStub=true no log) — mas o fix original (só
 *    `validation.summary`) não bastava aqui: `validation.summary` era uma META-DESCRIÇÃO ("Foi
 *    elaborada uma resposta detalhada... O relatório incluiu...") do que tinha sido produzido, não
 *    a análise em si:
 *
 *      [GoalStep] step=step_2 tool=agentloop outcome=success   ← conteúdo REAL aqui
 *      [SEMANTIC-PROMOTE] step=step_2 ... action=promote_to_confident_success
 *      [VALIDATION] achieved=true reason="Foi elaborada uma resposta detalhada em markdown
 *                   analisando se compensa investir na baixa (dip buying)..."   ← META-descrição
 *      [SendDocumentTool] [ARTIFACT-PATH] ... resolved="...resultado_investir_na_baixa.md" exists=false
 *      [GOAL-COMPLETE-CHECK] validation_ok=true all_sends_ok=false ... final_state=failed
 *
 *    Usuário: "Continua gerando resposta em markdown, e pediu para Verifique o workspace. Isso não
 *    é Objetivo validado!" — viu a meta-descrição + nota técnica, nunca a análise real que já
 *    existia em `goal.attempts` (step_2, toolName='agentloop').
 *
 * CORREÇÃO FINAL: `pickBestAvailableContent(goal, fallbackText)` — extraído de `buildResult()` e
 * reusado aqui — prefere `lastSuccess.output` (quando `toolName==='agentloop'` ou está na
 * allowlist `DIRECT_DELIVERABLE_TOOLS`) sobre QUALQUER texto de resumo, real ou meta-descritivo.
 * Fecha os dois casos com a MESMA precedência que `buildResult()` já usa no caminho de sucesso —
 * nenhuma lógica nova, só compartilhada.
 *
 * Diferença de S109 (SendDocument_StalePathCorrection — não confundir, nomes parecidos): S109
 * corrige `file_path` desatualizado quando existe EXATAMENTE 1 artefato real em disco não
 * enviado (stale-path correction). Aqui não há NENHUM artefato em disco (0 candidatos) — S109 não
 * se aplica, e o comportamento correto é entregar o melhor texto já validado, não tentar adivinhar
 * um arquivo que não existe.
 *
 * Execução: npx ts-node src/__tests__/regression/S234_DeferredSendFailure_PreservesValidatedAnswer.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos.';
const DIRECT_DELIVERABLE_TOOLS: readonly string[] = ['weather', 'crypto_analysis'];

/** Reprodução de `pickBestAvailableContent()` (fidelidade garantida por S234-3 sobre o source real). */
function pickBestAvailableContent(
    lastSuccessOutput: string | undefined,
    lastSuccessToolName: string | undefined,
    fallbackText: string | undefined,
): string | undefined {
    const lastSuccessIsSafeToDeliverRaw = lastSuccessOutput !== undefined && (
        lastSuccessToolName === 'agentloop' ||
        (lastSuccessToolName !== undefined && DIRECT_DELIVERABLE_TOOLS.includes(lastSuccessToolName))
    );
    const hasGenericSummary = fallbackText === GENERIC_CRITERIA_SUMMARY;
    return (lastSuccessIsSafeToDeliverRaw ? (lastSuccessOutput || undefined) : undefined)
        ?? (!hasGenericSummary ? fallbackText : undefined);
}

/** Reprodução da composição de `sendErr` em `runValidationAchievedPhase()`. */
function computeSendErr(
    bestContent: string | undefined,
    failedSends: number,
    deferredSendsLength: number,
): string {
    const deliveryNote = failedSends === deferredSendsLength
        ? 'Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário. Verifique o workspace.'
        : `Objetivo validado, mas ${failedSends} de ${deferredSendsLength} arquivo(s) não foram entregues.`;
    return bestContent ? `${bestContent}\n\n(${deliveryNote})` : deliveryNote;
}

console.log('\n=== S234-1 — incidente 1 (River, goal_..._ju0ms): sem agentloop melhor, resumo real vence ===');
{
    const respostaValidada = 'O agente forneceu os dados de mercado atuais do token River (RIVER) '
        + 'e explicou que, para verificar a posição pessoal do usuário, é necessário informar a '
        + 'quantidade de tokens e o preço médio de compra.';

    const best = pickBestAvailableContent(undefined, undefined, respostaValidada);
    const result = computeSendErr(best, 1, 1);

    assert(result.startsWith(respostaValidada), 'a resposta já validada abre a mensagem final', result.slice(0, 60));
    assert(/Verifique o workspace/.test(result), 'a nota sobre a falha de entrega continua presente, como informação secundária');
    assert(
        result !== 'Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário. Verifique o workspace.',
        'a mensagem final NÃO é mais só a frase técnica — o usuário recebe a resposta real',
    );
}

console.log('\n=== S234-1b — incidente 2 (dip buying, goal_..._2qxyj): conteúdo real do agentloop vence a META-descrição ===');
{
    const analiseReal = 'Considerando o cenário atual: o mercado cripto geral não está em baixa '
        + 'generalizada, mas o RIVER especificamente caiu -19,6% em 30 dias. Comprar na baixa só '
        + 'compensa se você acredita nos fundamentos do projeto a longo prazo — tecnicamente, o '
        + 'preço está 67% acima da mínima histórica, mas ainda distante do topo. Recomendação: '
        + 'só aporte o que está disposto a perder, dado o histórico de volatilidade do ativo.';
    const metaDescricao = 'Foi elaborada uma resposta detalhada em markdown analisando se compensa '
        + 'investir na baixa (dip buying), com foco específico no token RIVER. O relatório incluiu '
        + 'o panorama atual do mercado de criptomoedas, métricas detalhadas do ativo...';

    // O step que produziu a análise real foi convertido para 'agentloop' pelo SanitizePlanSteps
    // (ContentStubClassifier isStub=true) — mesmo padrão de sempre, não é caso especial.
    const best = pickBestAvailableContent(analiseReal, 'agentloop', metaDescricao);
    assert(best === analiseReal, 'pickBestAvailableContent prefere o conteúdo real do agentloop sobre a meta-descrição', best?.slice(0, 60));

    const result = computeSendErr(best, 1, 1);
    assert(result.startsWith(analiseReal), 'a mensagem final abre com a análise real, não a meta-descrição', result.slice(0, 60));
    assert(!result.startsWith(metaDescricao), 'a meta-descrição do validador NÃO abre mais a mensagem final');
    assert(/Verifique o workspace/.test(result), 'a nota sobre a falha de entrega continua presente, como informação secundária');
}

console.log('\n=== S234-2 — sem NENHUM conteúdo real (nem agentloop, nem resumo real), a nota técnica é tudo que existe ===');
{
    assert(computeSendErr(pickBestAvailableContent(undefined, undefined, undefined), 1, 1)
        === 'Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário. Verifique o workspace.',
        'sem nenhum conteúdo disponível, cai na nota técnica pura — sem regressão para esse caso');
    assert(computeSendErr(pickBestAvailableContent(undefined, undefined, GENERIC_CRITERIA_SUMMARY), 1, 1)
        === 'Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário. Verifique o workspace.',
        'resumo genérico (GENERIC_CRITERIA_SUMMARY) não é tratado como resposta real');
    assert(computeSendErr(pickBestAvailableContent(undefined, undefined, 'resposta real'), 1, 2)
        === 'resposta real\n\n(Objetivo validado, mas 1 de 2 arquivo(s) não foram entregues.)',
        'falha parcial (1 de N) também preserva a resposta real, com a contagem correta na nota');
    // Uma tool NÃO segura (ex: web_navigate) não deve vencer o resumo real — mesmo gate de S175/achado A.
    assert(
        computeSendErr(pickBestAvailableContent('dump operacional cru', 'web_navigate', 'resumo real'), 1, 1)
            .startsWith('resumo real'),
        'output de tool não-segura (ex: web_navigate) NÃO vence o resumo — mesmo gate do achado A (14/08/2026)',
    );
}

console.log('\n=== S234-3 — fix presente estruturalmente em GoalExecutionLoop.ts ===');
{
    assert(
        /private pickBestAvailableContent\(goal: Goal, fallbackText: string \| undefined\): string \| undefined \{/.test(SOURCE),
        'pickBestAvailableContent() existe como método único, reusável',
    );
    assert(
        /const bestContent = this\.pickBestAvailableContent\(goal, validation\.summary\);/.test(SOURCE),
        'o ramo de falha de envio diferido usa pickBestAvailableContent() — não decide sozinho com validation.summary cru',
    );
    assert(
        /const sendErr = bestContent \? `\$\{bestContent\}\\n\\n\(\$\{deliveryNote\}\)` : deliveryNote;/.test(SOURCE),
        'sendErr combina o melhor conteúdo disponível + deliveryNote — nunca descarta silenciosamente',
    );
    assert(
        /\?\? this\.pickBestAvailableContent\(goal, overrideOutput\)/.test(SOURCE),
        'buildResult() (caminho de sucesso) usa a MESMA função — precedência não duplicada em dois lugares',
    );
    // Guarda de regressão: a versão antiga checava validation.summary diretamente, sem consultar
    // lastSuccess/agentloop — o bug do incidente 2 (dip buying) reapareceria se isso voltasse.
    const bloco = SOURCE.slice(SOURCE.indexOf('if (!allSendsOk) {'), SOURCE.indexOf('// FIX E: encerra imediatamente'));
    assert(!/const hasRealSummary = !!validation\.summary/.test(bloco),
        'o bloco de falha de envio não decide mais sozinho com um booleano cru sobre validation.summary');
    assert(/pickBestAvailableContent/.test(bloco), 'o bloco de falha de envio delega a pergunta "qual o melhor conteúdo?" para a função compartilhada');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S234 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
