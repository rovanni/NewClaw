/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S292 (issue 046, campanha "sistema não utilizável", 23/09/2026)
 *
 * Achado ao vivo: pergunta simples ("Qual a previsão do tempo agora?"). O modelo, no mesmo
 * batch de tool_calls, chamou `weather` (sucesso, dado real: "Nublado ☁️ | 17.1°C") E
 * `send_document` (entrega de um PDF de um pedido anterior, ainda pendente na conversa).
 * `send_document`, sendo uma ferramenta de entrega terminal (`ToolRegistry.
 * isTerminalDelivery`), encerrava o turno com o atalho de `ADR-007`/`endsTurn()` — retornando
 * SÓ o recibo do PDF ("✅ Documento anexado...") como resposta final. A previsão do tempo, já
 * obtida com sucesso pela tool `weather`, nunca chegou a virar texto de resposta — o usuário
 * perguntou uma coisa e recebeu outra completamente diferente.
 *
 * Causa raiz: `runNativeToolCallDispatch()` (`AgentLoop.ts`) rastreia `terminalBatchResult` (o
 * output da ÚLTIMA tool de entrega terminal do batch) e, se não-nulo, retorna-o direto como
 * resposta final — um atalho legítimo (evita mais uma ida ao LLM) QUANDO a tool terminal é a
 * ÚNICA coisa que aconteceu no batch, mas incorreto quando outra tool NÃO-terminal também rodou
 * e produziu um resultado que o usuário está esperando.
 *
 * Fix: antes de aplicar o atalho, verifica se há alguma OUTRA tool não-terminal no MESMO batch
 * (`cycleHistory`, filtrado por `step === stepCount` — já preenchido por toda chamada de tool,
 * nenhum mecanismo novo). Se houver, pula o atalho — o loop continua para uma síntese normal
 * (mais uma ida ao LLM, que compõe a resposta incorporando os dois resultados).
 *
 * S292.1 — CASO POSITIVO: batch com [weather, send_document] (o cenário real) — o atalho NÃO se
 *   aplica (há outra tool não-terminal no mesmo batch).
 * S292.2 — CONTROLE NEGATIVO: batch com [send_document] sozinho — o atalho continua se aplicando,
 *   preservando o caso comum (evita gastar uma ida a mais ao LLM à toa).
 * S292.3 — CONTROLE NEGATIVO: batch com [send_audio, send_document] (dois terminais, nenhuma
 *   tool de informação) — o atalho continua se aplicando; preserva o fix original ("only
 *   index.html sent bug", comentário já existente em runNativeToolCallDispatch) para múltiplas
 *   entregas terminais no mesmo batch.
 * S292.4 — escopo por `step`: uma tool não-terminal num step/batch ANTERIOR não "vaza" pra
 *   decisão do batch atual — só tools do MESMO stepCount contam.
 * S292.5 — auditoria estrutural: o código real em AgentLoop.ts calcula `otherToolCallsThisBatch`
 *   e o usa para condicionar o atalho, no ponto exato onde `terminalBatchResult` é decidido.
 *
 * Execução: npx ts-node src/__tests__/regression/S292_AgentLoop_BatchSynthesisWhenNonTerminalToolAccompaniesDelivery.test.ts
 */

import { ToolRegistry } from '../../core/ToolRegistry';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

type CycleEntry = { step: number; tool: string; input: string; status: string };

/** Reproduz EXATAMENTE a expressão usada em runNativeToolCallDispatch() (AgentLoop.ts) — não
 *  reimplementa lógica de negócio nova, só aplica a mesma checagem de pertinência de conjunto
 *  (ToolRegistry.isTerminalDelivery, já testada isoladamente em S209) sobre um cycleHistory de
 *  fixture, do mesmo jeito que o código real faz sobre o cycleHistory real do turno. */
function otherToolCallsThisBatch(cycleHistory: CycleEntry[], stepCount: number): boolean {
    return cycleHistory.some(h => h.step === stepCount && !ToolRegistry.isTerminalDelivery(h.tool));
}

async function main(): Promise<void> {

console.log('\n=== S292.1 — CASO POSITIVO: [weather, send_document] no mesmo batch — atalho NÃO se aplica ===');
{
    const cycleHistory: CycleEntry[] = [
        { step: 5, tool: 'weather', input: '{}', status: 'success' },
        { step: 5, tool: 'send_document', input: '{}', status: 'success' },
    ];
    const result = otherToolCallsThisBatch(cycleHistory, 5);
    assert(result === true, 'weather (não-terminal) no mesmo batch de send_document faz o atalho ser pulado — reproduz o cenário real do bug', { cycleHistory, result });
}

console.log('\n=== S292.2 — CONTROLE NEGATIVO: [send_document] sozinho — atalho continua se aplicando ===');
{
    const cycleHistory: CycleEntry[] = [
        { step: 5, tool: 'send_document', input: '{}', status: 'success' },
    ];
    const result = otherToolCallsThisBatch(cycleHistory, 5);
    assert(result === false, 'send_document sozinho no batch: nenhuma outra tool não-terminal — atalho original preservado (comportamento pré-existente)', { cycleHistory, result });
}

console.log('\n=== S292.3 — CONTROLE NEGATIVO: [send_audio, send_document] — dois terminais, atalho continua se aplicando ===');
{
    const cycleHistory: CycleEntry[] = [
        { step: 5, tool: 'send_audio', input: '{}', status: 'success' },
        { step: 5, tool: 'send_document', input: '{}', status: 'success' },
    ];
    const result = otherToolCallsThisBatch(cycleHistory, 5);
    assert(result === false, 'duas entregas terminais no mesmo batch, sem nenhuma tool de informação: atalho continua valendo — preserva o fix original ("only index.html sent bug")', { cycleHistory, result });
}

console.log('\n=== S292.4 — escopo por step: tool não-terminal de um batch ANTERIOR não vaza pro batch atual ===');
{
    const cycleHistory: CycleEntry[] = [
        { step: 3, tool: 'weather', input: '{}', status: 'success' },       // batch anterior
        { step: 5, tool: 'send_document', input: '{}', status: 'success' }, // batch atual
    ];
    const result = otherToolCallsThisBatch(cycleHistory, 5);
    assert(result === false, `weather no step=3 não conta pro batch do step=5 — obtido ${result}`, { cycleHistory, result });
}

console.log('\n=== S292.5 — auditoria estrutural: o código real usa esta checagem no ponto certo ===');
{
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8') as string;
    const idx = src.indexOf('const otherToolCallsThisBatch = cycleHistory.some(');
    assert(idx > 0, 'AgentLoop.ts declara otherToolCallsThisBatch via cycleHistory.some(...)', idx);

    const trecho = src.slice(idx, idx + 800);
    assert(
        /h\.step === stepCount && !ToolRegistry\.isTerminalDelivery\(h\.tool\)/.test(trecho),
        'a expressão escopa por step === stepCount e usa ToolRegistry.isTerminalDelivery (mesma fonte única de S209)',
        trecho,
    );
    assert(
        /if \(terminalBatchResult !== null && !otherToolCallsThisBatch\) \{/.test(trecho),
        'o atalho (earlyReturn com terminalBatchResult) só dispara quando NÃO há outra tool não-terminal no batch',
        trecho,
    );
    assert(
        /if \(terminalBatchResult !== null && otherToolCallsThisBatch\) \{/.test(trecho),
        'quando há outra tool não-terminal, o código loga a decisão de síntese em vez de aplicar o atalho (issue 046)',
        trecho,
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S292 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
