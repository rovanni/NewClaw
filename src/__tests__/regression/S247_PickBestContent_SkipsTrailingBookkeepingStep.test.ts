/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S247
 * GoalExecutionLoop.pickBestAvailableContent(): quando o ÚLTIMO attempt bem-sucedido do goal é
 * um step de bookkeeping (ex.: memory_write persistindo um fato para reuso futuro), a resposta
 * real já produzida por um step ANTERIOR (agentloop, ou tool na allowlist DIRECT_DELIVERABLE_TOOLS)
 * continua vencendo o resumo do validador — não é descartada só por não ser o ÚLTIMO attempt.
 *
 * INCIDENTE REAL (newclaw-audit.log + newclaw.db, 17/08/2026, goal_1786989885813_kik5n, sessão
 * web:conv_1786989272694, "Qual o valor do River agora, criptomoeda?"): o plano tinha 2 steps —
 * step_1 (agentloop), que produziu a resposta completa e correta ("Aqui está o valor atual da
 * River (RIVER) 🪙 ... 💰 Preço atual $2,69 ..."), e step_2 (memory_write), que persistiu esse
 * preço num nó de memória para consulta futura (checklist de venda). Confirmado via consulta
 * direta a goals.attempts no SQLite: os dois attempts têm result='success', mas o de memory_write
 * é CRONOLOGICAMENTE POSTERIOR ao de agentloop. `pickBestAvailableContent()` buscava literalmente
 * o ÚLTIMO attempt bem-sucedido do array (memory_write — fora da allowlist de entrega direta),
 * desistia da entrega direta, e caía no resumo do validador — a mesma classe de "recibo de
 * operação em vez de conteúdo" que S175 já existe para evitar, só que por uma porta diferente: o
 * usuário recebeu "O valor atual da criptomoeda River (RIVER) foi buscado e fornecido ao
 * usuário. O preço atual é de $2,69..." em vez da tabela real já pronta duas etapas antes.
 *
 * FIX (GoalExecutionLoop.ts, pickBestAvailableContent): a busca por `lastSuccess` agora filtra
 * por segurança-para-entrega-crua NO PRÓPRIO find() — pula qualquer step de bookkeeping
 * (memory_write, memory_admin, schedule, ...) posterior ao conteúdo real, em vez de desistir
 * assim que o ÚLTIMO attempt do array não estiver na allowlist.
 *
 * REGRESSÃO SE: um goal com um step de bookkeeping (memory_write/memory_admin/schedule/etc.) após
 * o step que produziu a resposta real voltar a entregar o resumo do validador em vez do conteúdo
 * já produzido.
 *
 * Execução: npx ts-node src/__tests__/regression/S247_PickBestContent_SkipsTrailingBookkeepingStep.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

interface MockAttempt {
    toolName: string;
    result: 'success' | 'partial' | 'failure';
    output: string;
    planGeneration?: number;
}

const DIRECT_DELIVERABLE_TOOLS: readonly string[] = ['weather', 'crypto_analysis'];
const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos.';

/** Réplica exata do pickBestAvailableContent() corrigido — o find() já filtra por segurança. */
function pickBestAvailableContent(
    attempts: MockAttempt[],
    currentGeneration: number,
    fallbackText: string | undefined,
): string | undefined {
    const lastSuccess = [...attempts].reverse()
        .find(a => a.result === 'success' && (a.planGeneration ?? 0) === currentGeneration
            && (a.toolName === 'agentloop' || DIRECT_DELIVERABLE_TOOLS.includes(a.toolName)));
    const lastSuccessIsSafeToDeliverRaw = !!lastSuccess && (
        lastSuccess.toolName === 'agentloop' ||
        DIRECT_DELIVERABLE_TOOLS.includes(lastSuccess.toolName)
    );
    const hasGenericSummary = fallbackText === GENERIC_CRITERIA_SUMMARY;
    return (lastSuccessIsSafeToDeliverRaw ? (lastSuccess?.output || undefined) : undefined)
        ?? (!hasGenericSummary ? fallbackText : undefined);
}

// ── Cenário 1: reproduz o incidente exato (agentloop, depois memory_write) ─────────────

console.log('\n=== S247 — Cenário 1: reproduz goal_1786989885813_kik5n ===');
{
    const respostaReal = 'Aqui está o valor atual da **River (RIVER)** 🪙\n\n'
        + '| Métrica | Valor |\n|---|---|\n| 💰 **Preço atual** | **$2,69** |\n'
        + '| 📊 **Market Cap** | $52,75M |\n| 🔄 **Volume 24h** | $2,20M |';
    const resumoDoValidador = 'O valor atual da criptomoeda River (RIVER) foi buscado e fornecido '
        + 'ao usuário. O preço atual é de $2,69, com Market Cap de $52,75M e Volume 24h de $2,20M.';

    const attempts: MockAttempt[] = [
        { toolName: 'agentloop', result: 'success', output: respostaReal, planGeneration: 0 },
        {
            toolName: 'memory_write', result: 'success',
            output: '✅ Nó "river_preco_atual_1786880101871" atualizado (conteúdo similar já existia — duplicata evitada).',
            planGeneration: 0,
        },
    ];

    const result = pickBestAvailableContent(attempts, 0, resumoDoValidador);
    assert(result === respostaReal, 'a resposta real (agentloop) vence, mesmo não sendo o ÚLTIMO attempt', result?.slice(0, 60));
    assert(result !== resumoDoValidador, 'o resumo do validador ("foi buscado e fornecido ao usuário") NÃO é a resposta final', result?.slice(0, 60));
    assert(!/foi buscado e fornecido ao usuário/.test(result ?? ''), 'a resposta não é uma meta-frase sobre a própria resposta');
}

// ── Cenário 2: múltiplos steps de bookkeeping em sequência após o conteúdo real ────────

console.log('\n=== S247 — Cenário 2: vários steps de bookkeeping em sequência ===');
{
    const respostaReal = 'A cotação do dólar hoje é R$ 5,09.';
    const attempts: MockAttempt[] = [
        { toolName: 'agentloop', result: 'success', output: respostaReal, planGeneration: 0 },
        { toolName: 'memory_write', result: 'success', output: 'Nó atualizado.', planGeneration: 0 },
        { toolName: 'memory_admin', result: 'success', output: 'Índice reconstruído.', planGeneration: 0 },
        { toolName: 'schedule', result: 'success', output: 'Lembrete agendado para amanhã.', planGeneration: 0 },
    ];
    const result = pickBestAvailableContent(attempts, 0, 'A cotação do dólar foi consultada e informada.');
    assert(result === respostaReal, 'a resposta real vence mesmo com 3 steps de bookkeeping depois dela', result?.slice(0, 60));
}

// ── Cenário 3: sem NENHUM step seguro — comportamento antigo preservado (resumo vence) ──

console.log('\n=== S247 — Cenário 3: nenhum attempt seguro para entrega — resumo continua vencendo ===');
{
    const resumo = 'Preço consultado e checklist atualizado com sucesso.';
    const attempts: MockAttempt[] = [
        { toolName: 'web_search', result: 'success', output: 'Consulta: river price\nResultados: 3', planGeneration: 0 },
        { toolName: 'memory_write', result: 'success', output: 'Nó atualizado.', planGeneration: 0 },
    ];
    const result = pickBestAvailableContent(attempts, 0, resumo);
    assert(result === resumo, 'sem nenhum step seguro para entrega direta, o resumo do validador ainda vence (sem regressão)', result);
}

// ── Cenário 4: memory_write ANTES do conteúdo real (ordem normal) — sem regressão ──────

console.log('\n=== S247 — Cenário 4: bookkeeping ANTES do conteúdo real (caso já coberto) ===');
{
    const respostaReal = 'Aqui está a previsão do tempo...';
    const attempts: MockAttempt[] = [
        { toolName: 'memory_write', result: 'success', output: 'Preferência registrada.', planGeneration: 0 },
        { toolName: 'agentloop', result: 'success', output: respostaReal, planGeneration: 0 },
    ];
    const result = pickBestAvailableContent(attempts, 0, 'A previsão foi consultada e informada.');
    assert(result === respostaReal, 'quando o conteúdo real já é o último attempt, continua vencendo (caso normal, sem regressão)', result?.slice(0, 40));
}

// ── Cenário 5: fonte real — assertion estrutural sobre GoalExecutionLoop.ts ─────────────

console.log('\n=== S247 — o fix está presente estruturalmente no source ===');
{
    const loopSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8'
    );
    assert(
        /const lastSuccess = \[\.\.\.goal\.attempts\]\.reverse\(\)\s*\n\s*\.find\(a => a\.result === 'success' && \(a\.planGeneration \?\? 0\) === currentGeneration\s*\n\s*&& \(a\.toolName === 'agentloop' \|\| DIRECT_DELIVERABLE_TOOLS\.includes\(a\.toolName\)\)\);/.test(loopSource),
        'o find() de lastSuccess já filtra por segurança-para-entrega-crua, não só por result==="success"',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S247 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Reprodução do incidente real (goal_1786989885813_kik5n): simulado`);
console.log(`  Múltiplos steps de bookkeeping em sequência: testado`);
console.log(`  Sem nenhum attempt seguro — comportamento antigo preservado: testado`);
console.log(`  Bookkeeping ANTES do conteúdo real — sem regressão: testado`);
console.log(`  Fix presente estruturalmente no source: testado`);
if (failed > 0) process.exit(1);
